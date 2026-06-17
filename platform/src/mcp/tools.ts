/**
 * The exact tool surface of @playwright/mcp@0.0.76 that the ProofLoop harness is
 * allowed to touch, plus the two-layer lockout that keeps vision/coordinate and
 * arbitrary-tool access out of the loop (D14, D16).
 *
 * Empirically discovered against 0.0.76 (capability-discovery probe):
 *  - The element-action tools take the ref in a parameter named **`target`** (not
 *    `ref`), and `target` ALSO accepts a raw CSS/Playwright selector. That is the
 *    exact hole D14 forbids: the harness MUST validate that `target` is a ref token
 *    present in the latest snapshot before dispatch — see snapshot.ts / the loop.
 *  - Without the `vision` capability (we never pass `--caps vision`) NO
 *    coordinate-interaction tools are exposed. `browser_take_screenshot` IS exposed
 *    but is a non-coordinate debug capture, so it is deliberately not treated as a
 *    coordinate tool. It is simply not on the dispatch allowlist.
 */

/** The only @playwright/mcp tools the harness ever names. */
export const TOOL = {
  /** Capture a fresh accessibility snapshot (harness op; no element ref). */
  snapshot: "browser_snapshot",
  /** Navigate to a URL — harness op, used only for the entry page (no element ref). */
  navigate: "browser_navigate",
  /** Element-targeted action: click. Takes { element, target }. */
  click: "browser_click",
  /** Element-targeted action: type. Takes { element, target, text, submit? }. */
  type: "browser_type",
  /** Harness op: set viewport size (honors FlowPlan.viewport). */
  resize: "browser_resize",
  /** Harness op: close the browser. */
  close: "browser_close",
} as const;

export type ToolName = (typeof TOOL)[keyof typeof TOOL];

/**
 * LAYER 2. The complete set of tool names the harness will ever dispatch to MCP.
 * Any other tool the server happens to expose (browser_evaluate,
 * browser_run_code_unsafe, browser_fill_form, browser_take_screenshot, …) is never
 * reachable: the LLM returns a narrow decision (D15), never a tool name, and this
 * client refuses to dispatch a name outside this set.
 */
export const DISPATCH_ALLOWLIST: ReadonlySet<string> = new Set<string>(
  Object.values(TOOL),
);

/** Tools whose presence we assert at discovery — the loop cannot run without them. */
export const REQUIRED_TOOLS: readonly ToolName[] = Object.values(TOOL);

/**
 * D15 — for Phase 2 the LLM may choose exactly these element-targeted actions, each
 * mapping to one allowed MCP tool. Arbitrary selector strings are NOT an action.
 */
export const ELEMENT_ACTION_TOOL = {
  click: TOOL.click,
  type: TOOL.type,
} as const;

export type AllowedElementAction = keyof typeof ELEMENT_ACTION_TOOL; // "click" | "type"

export function isAllowedElementAction(x: unknown): x is AllowedElementAction {
  return x === "click" || x === "type";
}

/**
 * LAYER 1. Patterns identifying coordinate / vision interaction tools (the ones the
 * `vision` capability would add: browser_mouse_*_xy, browser_screen_click, …). We
 * never enable that capability, and discovery asserts none of these are present, so
 * a future default flip or misconfig fails the launch loudly instead of silently
 * letting coordinate actions in. `browser_take_screenshot` does not match.
 */
const COORDINATE_TOOL_PATTERNS: readonly RegExp[] = [
  /_xy$/i,
  /(^|_)mouse(_|$)/i,
  /screen_(capture|click|move|drag|type|hover|tap)/i,
];

export function isCoordinateTool(name: string): boolean {
  return COORDINATE_TOOL_PATTERNS.some((re) => re.test(name));
}
