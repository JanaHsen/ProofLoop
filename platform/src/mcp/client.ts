/**
 * PlaywrightMcpClient — the harness's MCP client and the actuator boundary (D13,
 * D16, D17). It launches @playwright/mcp@0.0.76 as a managed `stdio` subprocess,
 * runs MCP initialization + capability discovery, and exposes a *narrow*, deliberate
 * surface (navigate / snapshot / click / type / resize / close). The LLM never
 * touches this object; the deterministic loop (Task 5) does.
 *
 * The five things this file gets deliberately right (not by default):
 *
 *  1. ISOLATION PER FLOW (D17). Launched with `--isolated`: the browser profile is
 *     kept in memory and never written to disk. One subprocess == one flow == one
 *     fresh in-memory context. State persists across navigations *within* the flow
 *     (single live session) and cannot leak to the next flow (a new subprocess gets
 *     a new in-memory profile, and no userDataDir / storageState is ever set). This
 *     is a chosen config, asserted by buildServerArgs's tests — not the default.
 *  2. CAPABILITY DISCOVERY is real: the tool surface is enumerated and asserted
 *     (required tools present; zero coordinate/vision tools present).
 *  3. HEADED (Phase 2 throughout). `--headless` is never passed; @playwright/mcp is
 *     headed by default and we keep it that way so Task 6/7 can be watched.
 *  4. VISION/COORDINATE OFF, two layers: (layer 1) we never pass `--caps vision`,
 *     and discovery refuses to proceed if any coordinate tool appears; (layer 2)
 *     callToolRaw refuses to dispatch any name outside DISPATCH_ALLOWLIST, and
 *     element actions refuse a `target` that is not a snapshot ref token.
 *  5. CLEANUP ON EVERY EXIT PATH: success, error, timeout, cancellation, and
 *     uncaught exception / Ctrl-C all route through close() via try/finally and
 *     process signal handlers. Orphaned Chromium is the failure mode we design out.
 *
 * SUT boundary: this client is given a URL to navigate to and nothing else about the
 * SUT. It never reads app/ source, never receives a filesystem path into app/, and
 * the spawned server inherits only a safe env (PROOFLOOP_ and ANTHROPIC_ vars stripped).
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
// Types only (erased at runtime). The SDK is `"type": "module"`; importing its
// VALUES statically makes Node classify this file as ESM under the ts-node CJS
// runner. We load the runtime constructors lazily via dynamic import() in launch()
// (which resolves to the SDK's CJS build), so this file stays plain CommonJS and
// importing it for unit tests never loads the SDK at all.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { Viewport } from "../flow-plan";
import {
  DISPATCH_ALLOWLIST,
  REQUIRED_TOOLS,
  TOOL,
  isCoordinateTool,
} from "./tools";
import {
  ParsedSnapshot,
  extractSnapshotFileLink,
  extractYamlBlock,
  isRefToken,
  parseSnapshot,
} from "./snapshot";

const moduleRequire = createRequire(__filename);
/** Absolute path to the pinned @playwright/mcp CLI (exports only expose "."). */
const MCP_CLI_PATH = path.join(
  path.dirname(moduleRequire.resolve("@playwright/mcp/package.json")),
  "cli.js",
);

/** Viewport label → window size. Mobile width stays ≤480px (Phase 5 uses this). */
const VIEWPORT_SIZE: Record<Viewport, string> = {
  desktop: "1280x720",
  mobile: "390x844",
};

const LAUNCH_TIMEOUT_MS = 60_000;
const NAVIGATE_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 30_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;

export class McpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpClientError";
  }
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface McpClientOptions {
  /** From FlowPlan.viewport — never hardcoded. */
  viewport: Viewport;
  /**
   * Directory the server may write artifacts to (and the subprocess cwd). Generated
   * content; lives under platform/runs/<runId>/ in a real run. A temp dir is fine
   * for bring-up. Must exist.
   */
  outputDir: string;
}

/**
 * Build the exact argv passed to the @playwright/mcp CLI for a flow. Pure and
 * exported so the isolation/headed/vision config can be asserted without launching a
 * browser. The deliberate choices live here:
 *   --isolated         in-memory profile, never persisted (D17)
 *   --browser chromium pinned engine
 *   --viewport-size    from FlowPlan.viewport (never hardcoded desktop)
 *   (no --headless)    headed, Phase 2 throughout
 *   (no --caps)        vision/coordinate tools never enabled (layer 1)
 *   --snapshot-mode full + --output-mode stdout  snapshots returned inline
 * Never sets --user-data-dir or --storage-state: nothing for a later flow to inherit.
 */
export function buildServerArgs(opts: McpClientOptions): string[] {
  return [
    MCP_CLI_PATH,
    "--isolated",
    "--browser",
    "chromium",
    "--viewport-size",
    VIEWPORT_SIZE[opts.viewport],
    "--snapshot-mode",
    "full",
    "--output-mode",
    "stdout",
    "--output-dir",
    opts.outputDir,
  ];
}

/** Strip any ground-truth/secret vars so the subprocess inherits only safe env. */
function stripSensitiveEnv(
  base: Record<string, string>,
): Record<string, string> {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(PROOFLOOP_|ANTHROPIC_)/.test(key)) delete env[key];
  }
  return env;
}

// --- process-wide cleanup: tear every live client down on abnormal exit ----------
const liveClients = new Set<PlaywrightMcpClient>();
let signalHandlersInstalled = false;

function installSignalHandlersOnce(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const teardownAll = async (): Promise<void> => {
    await Promise.allSettled([...liveClients].map((c) => c.close()));
  };
  process.once("SIGINT", () => {
    void teardownAll().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void teardownAll().finally(() => process.exit(143));
  });
  process.once("uncaughtException", (err) => {
    void teardownAll().finally(() => {
      console.error(err);
      process.exit(1);
    });
  });
  process.once("unhandledRejection", (reason) => {
    void teardownAll().finally(() => {
      console.error(reason);
      process.exit(1);
    });
  });
}

export class PlaywrightMcpClient {
  private readonly opts: McpClientOptions;
  private client?: Client;
  private transport?: StdioClientTransport;
  private toolNames: string[] = [];
  private stderrTail: string[] = [];
  private closed = false;

  constructor(opts: McpClientOptions) {
    this.opts = opts;
  }

  /** The discovered tool surface (after launch). */
  get discoveredTools(): readonly string[] {
    return this.toolNames;
  }

  /**
   * Launch the managed subprocess, run MCP init, and assert the capability surface.
   * Throws (and tears itself down) on any failure so no half-open browser survives.
   */
  async launch(): Promise<void> {
    if (this.client) throw new McpClientError("already launched");
    if (!fs.existsSync(this.opts.outputDir)) {
      fs.mkdirSync(this.opts.outputDir, { recursive: true });
    }
    installSignalHandlersOnce();
    liveClients.add(this);
    try {
      const { Client } = await import(
        "@modelcontextprotocol/sdk/client/index.js"
      );
      const { StdioClientTransport, getDefaultEnvironment } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );
      this.transport = new StdioClientTransport({
        command: process.execPath,
        args: buildServerArgs(this.opts),
        env: stripSensitiveEnv(getDefaultEnvironment()),
        cwd: this.opts.outputDir,
        stderr: "pipe",
      });
      this.transport.stderr?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
        this.stderrTail.push(...lines);
        if (this.stderrTail.length > 50) {
          this.stderrTail.splice(0, this.stderrTail.length - 50);
        }
      });
      this.client = new Client(
        { name: "proofloop", version: "0.0.0" },
        { capabilities: {} },
      );
      await this.client.connect(this.transport, { timeout: LAUNCH_TIMEOUT_MS });
      await this.discover();
    } catch (e) {
      const detail = this.stderrTail.length
        ? `\n--- server stderr ---\n${this.stderrTail.join("\n")}`
        : "";
      await this.close();
      throw new McpClientError(
        `MCP launch failed: ${(e as Error).message}${detail}`,
      );
    }
  }

  /** Enumerate tools and assert the surface: required present, no coordinate tools. */
  private async discover(): Promise<void> {
    const { tools } = await this.client!.listTools(undefined, {
      timeout: LAUNCH_TIMEOUT_MS,
    });
    this.toolNames = tools.map((t) => t.name).sort();
    const missing = REQUIRED_TOOLS.filter((t) => !this.toolNames.includes(t));
    if (missing.length) {
      throw new McpClientError(
        `MCP server is missing required tools: ${missing.join(", ")}`,
      );
    }
    const coordinate = this.toolNames.filter(isCoordinateTool);
    if (coordinate.length) {
      throw new McpClientError(
        `coordinate/vision tools must not be present (vision capability is off): ${coordinate.join(", ")}`,
      );
    }
  }

  // --- harness operations (no element ref) ---------------------------------------

  /** Navigate to a URL. Harness op (D14): used only for the entry page. */
  async navigate(url: string): Promise<void> {
    const res = await this.callToolRaw(TOOL.navigate, { url }, NAVIGATE_TIMEOUT_MS);
    if (res.isError) {
      throw new McpClientError(`browser_navigate failed: ${res.text}`);
    }
  }

  /** Capture and parse a fresh accessibility snapshot. */
  async snapshot(): Promise<ParsedSnapshot> {
    const res = await this.callToolRaw(TOOL.snapshot, {}, ACTION_TIMEOUT_MS);
    if (res.isError) {
      throw new McpClientError(`browser_snapshot failed: ${res.text}`);
    }
    let yaml = extractYamlBlock(res.text);
    if (yaml === null) {
      const link = extractSnapshotFileLink(res.text);
      if (link) {
        yaml = fs.readFileSync(path.resolve(this.opts.outputDir, link), "utf8");
      }
    }
    if (yaml === null) {
      throw new McpClientError(
        "snapshot result contained neither an inline YAML block nor a file link",
      );
    }
    return parseSnapshot(yaml, res.text);
  }

  /** Resize the viewport (harness op). Viewport is also set at launch. */
  async resize(width: number, height: number): Promise<void> {
    const res = await this.callToolRaw(
      TOOL.resize,
      { width, height },
      ACTION_TIMEOUT_MS,
    );
    if (res.isError) throw new McpClientError(`browser_resize failed: ${res.text}`);
  }

  // --- element-targeted actions (D15: click | type) ------------------------------
  //
  // These assume the loop has already validated `ref` against the CURRENT snapshot
  // (refValidatedAgainstSnapshot is computed by the loop, never here). As a second
  // layer, they refuse a target that is not even shaped like a ref token, so a CSS
  // selector can never reach MCP through this path (the `target` param would accept
  // one — that is the D14 hole this guards).

  async clickRef(ref: string, element: string): Promise<ToolResult> {
    this.assertRefToken(ref);
    return this.callToolRaw(
      TOOL.click,
      { element, target: ref },
      ACTION_TIMEOUT_MS,
    );
  }

  async typeRef(
    ref: string,
    element: string,
    text: string,
    submit = false,
  ): Promise<ToolResult> {
    this.assertRefToken(ref);
    return this.callToolRaw(
      TOOL.type,
      { element, target: ref, text, ...(submit ? { submit: true } : {}) },
      ACTION_TIMEOUT_MS,
    );
  }

  private assertRefToken(ref: string): void {
    if (!isRefToken(ref)) {
      throw new McpClientError(
        `refusing element action: target "${ref}" is not a snapshot ref token`,
      );
    }
  }

  /** Layer-2 dispatch gate: only allowlisted tool names ever reach the server. */
  private async callToolRaw(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ToolResult> {
    if (!DISPATCH_ALLOWLIST.has(name)) {
      throw new McpClientError(
        `refusing to dispatch non-allowlisted tool "${name}"`,
      );
    }
    if (!this.client) throw new McpClientError("client is not launched");
    const res = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: timeoutMs,
    });
    const text = Array.isArray(res.content)
      ? res.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
      : "";
    return { text, isError: res.isError === true };
  }

  /**
   * Tear down — idempotent, safe from finally blocks and signal handlers. Closes the
   * browser gracefully first (so Chromium exits before the node child is killed),
   * then the transport (which kills the child), then force-kills the pid as a
   * backstop. The orphaned-Chromium failure mode is designed out here.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    liveClients.delete(this);
    const pid = this.transport?.pid ?? null;
    try {
      if (this.client) {
        await this.callToolRaw(TOOL.close, {}, GRACEFUL_CLOSE_TIMEOUT_MS);
      }
    } catch {
      /* best effort */
    }
    try {
      await this.client?.close();
    } catch {
      /* best effort */
    }
    if (pid !== null) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    this.client = undefined;
    this.transport = undefined;
  }
}
