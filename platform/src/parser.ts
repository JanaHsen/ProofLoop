import * as fs from "node:fs";
import * as path from "node:path";
import { load as yamlLoad } from "js-yaml";

import {
  FlowPlan,
  FlowStep,
  FlowCriterion,
  Viewport,
  FLOW_PLAN_SCHEMA_VERSION,
} from "./flow-plan";

/**
 * Deterministic, STRUCTURAL parser for *.flow.md files (D8). It carves the file
 * into front-matter, an ordered list of step strings, and a list of criterion
 * strings, preserving author English VERBATIM. It never interprets meaning — the
 * one structural exception is stripping the optional `(after step N)` suffix.
 *
 * Front-matter is parsed with js-yaml (safe default schema, no custom types). The
 * Steps / Acceptance Criteria body is hand-extracted (no markdown library, per the
 * Phase 1 hard fence). All validation is fail-loud with a specific message.
 *
 * No UUIDs, no timestamps, no randomness anywhere — ids are positional.
 */

export class FlowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowParseError";
  }
}

const FLOW_SUFFIX = ".flow.md";
const ALLOWED_FRONT_MATTER_KEYS = new Set([
  "name",
  "entry",
  "viewport",
  "tags",
  "description",
]);
const STEPS_TITLE = "Steps";
const CRITERIA_TITLE = "Acceptance Criteria";

/** Derive the flow id (and id namespace) from the filename: `checkout.flow.md` => `checkout`. */
export function flowIdFromFilename(filePath: string): string {
  const base = path.basename(filePath);
  if (!base.endsWith(FLOW_SUFFIX) || base.length === FLOW_SUFFIX.length) {
    throw new FlowParseError(`flow file must be named *.flow.md (got "${base}")`);
  }
  return base.slice(0, -FLOW_SUFFIX.length);
}

/** Read and parse a flow file from disk. */
export function parseFlowFile(filePath: string): FlowPlan {
  const flowId = flowIdFromFilename(filePath);
  const source = fs.readFileSync(filePath, "utf8");
  return parseFlow(source, flowId);
}

/** Parse flow source text under a given flow id. Pure (no filesystem, no clock, no randomness). */
export function parseFlow(source: string, flowId: string): FlowPlan {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const lines = text.split(/\r?\n/);

  const { frontMatter, bodyLines } = splitFrontMatter(lines);
  const fm = parseFrontMatter(frontMatter);
  const { steps, criteria } = parseBody(bodyLines, flowId);

  const plan: FlowPlan = {
    schemaVersion: FLOW_PLAN_SCHEMA_VERSION,
    id: flowId,
    name: fm.name,
    ...(fm.description !== undefined ? { description: fm.description } : {}),
    entry: fm.entry,
    viewport: fm.viewport,
    tags: fm.tags,
    steps,
    criteria,
  };
  return plan;
}

interface FrontMatter {
  name: string;
  description?: string;
  entry: string;
  viewport: Viewport;
  tags: string[];
}

function splitFrontMatter(lines: string[]): {
  frontMatter: string[];
  bodyLines: string[];
} {
  if (lines.length === 0 || lines[0].trim() !== "---") {
    throw new FlowParseError("front-matter must open with '---' on the first line");
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    throw new FlowParseError("front-matter is not closed with a '---' line");
  }
  return { frontMatter: lines.slice(1, close), bodyLines: lines.slice(close + 1) };
}

function parseFrontMatter(fmLines: string[]): FrontMatter {
  let loaded: unknown;
  try {
    loaded = yamlLoad(fmLines.join("\n"));
  } catch (e) {
    throw new FlowParseError(
      `front-matter is not valid YAML: ${(e as Error).message}`,
    );
  }
  if (loaded === null || loaded === undefined) {
    throw new FlowParseError("front-matter is empty; 'name' is required");
  }
  if (typeof loaded !== "object" || Array.isArray(loaded)) {
    throw new FlowParseError("front-matter must be a YAML mapping");
  }
  const obj = loaded as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_FRONT_MATTER_KEYS.has(key)) {
      throw new FlowParseError(`unknown front-matter key: "${key}"`);
    }
  }

  const name = obj.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new FlowParseError(
      "front-matter 'name' is required and must be a non-empty string",
    );
  }

  let entry = "/";
  if (obj.entry !== undefined) {
    if (typeof obj.entry !== "string") {
      throw new FlowParseError("front-matter 'entry' must be a string");
    }
    if (/:\/\//.test(obj.entry)) {
      throw new FlowParseError(
        `front-matter 'entry' must be a relative path, not an absolute URL (got "${obj.entry}")`,
      );
    }
    if (!obj.entry.startsWith("/")) {
      throw new FlowParseError(
        `front-matter 'entry' must start with "/" (got "${obj.entry}")`,
      );
    }
    entry = obj.entry;
  }

  let viewport: Viewport = "desktop";
  if (obj.viewport !== undefined) {
    if (obj.viewport !== "desktop" && obj.viewport !== "mobile") {
      throw new FlowParseError(
        `front-matter 'viewport' must be 'desktop' or 'mobile' (got ${JSON.stringify(obj.viewport)})`,
      );
    }
    viewport = obj.viewport;
  }

  let tags: string[] = [];
  if (obj.tags !== undefined) {
    if (
      !Array.isArray(obj.tags) ||
      !obj.tags.every((t) => typeof t === "string")
    ) {
      throw new FlowParseError("front-matter 'tags' must be a list of strings");
    }
    tags = obj.tags as string[];
  }

  let description: string | undefined;
  if (obj.description !== undefined) {
    if (typeof obj.description !== "string") {
      throw new FlowParseError("front-matter 'description' must be a string");
    }
    description = obj.description;
  }

  return { name, description, entry, viewport, tags };
}

function parseBody(
  bodyLines: string[],
  flowId: string,
): { steps: FlowStep[]; criteria: FlowCriterion[] } {
  const sections = new Map<string, string[]>();
  let current: string | null = null;

  for (const line of bodyLines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[1];
      if (title !== STEPS_TITLE && title !== CRITERIA_TITLE) {
        throw new FlowParseError(
          `unexpected section heading "## ${title}" (only "## Steps" and "## Acceptance Criteria" are allowed)`,
        );
      }
      if (sections.has(title)) {
        throw new FlowParseError(`duplicate section heading "## ${title}"`);
      }
      sections.set(title, []);
      current = title;
      continue;
    }
    if (current === null) {
      if (line.trim().length > 0) {
        throw new FlowParseError(
          `unexpected content before the first section heading: "${line.trim()}"`,
        );
      }
      continue;
    }
    sections.get(current)!.push(line);
  }

  const stepLines = sections.get(STEPS_TITLE);
  if (stepLines === undefined) {
    throw new FlowParseError('missing "## Steps" section');
  }
  const steps: FlowStep[] = [];
  for (const line of stepLines) {
    if (line.trim().length === 0) continue;
    const m = /^\s*\d+\.\s+(.*\S)\s*$/.exec(line);
    if (!m) {
      throw new FlowParseError(
        `"## Steps" may only contain numbered list items; offending line: "${line.trim()}"`,
      );
    }
    const ordinal = steps.length + 1;
    steps.push({ id: `${flowId}:S${ordinal}`, ordinal, text: m[1] });
  }
  if (steps.length === 0) {
    throw new FlowParseError('"## Steps" must contain at least one step');
  }

  const critLines = sections.get(CRITERIA_TITLE);
  if (critLines === undefined) {
    throw new FlowParseError(
      'missing "## Acceptance Criteria" section (at least one criterion is required)',
    );
  }
  const criteria: FlowCriterion[] = [];
  const afterRe = /\s*\(after step (\d+)\)\s*$/;
  for (const line of critLines) {
    if (line.trim().length === 0) continue;
    const m = /^\s*-\s+(.*\S)\s*$/.exec(line);
    if (!m) {
      throw new FlowParseError(
        `"## Acceptance Criteria" may only contain "- " list items; offending line: "${line.trim()}"`,
      );
    }
    let criterionText = m[1];
    let after: string | undefined;
    const am = afterRe.exec(criterionText);
    if (am) {
      const n = Number(am[1]);
      if (n < 1 || n > steps.length) {
        throw new FlowParseError(
          `criterion "(after step ${n})" references a non-existent step (there ${steps.length === 1 ? "is" : "are"} ${steps.length} step${steps.length === 1 ? "" : "s"})`,
        );
      }
      after = `${flowId}:S${n}`;
      criterionText = criterionText.slice(0, am.index).replace(/\s+$/, "");
    }
    const ordinal = criteria.length + 1;
    criteria.push(
      after === undefined
        ? { id: `${flowId}:C${ordinal}`, ordinal, text: criterionText }
        : { id: `${flowId}:C${ordinal}`, ordinal, text: criterionText, after },
    );
  }
  if (criteria.length === 0) {
    throw new FlowParseError(
      '"## Acceptance Criteria" must contain at least one criterion',
    );
  }

  return { steps, criteria };
}

/**
 * Serialize a FlowPlan to canonical JSON: fixed key order, 2-space indent, trailing
 * newline. Deterministic — the basis for golden tests. Optional keys (description,
 * after) are emitted only when present.
 */
export function serializeFlowPlan(plan: FlowPlan): string {
  const ordered: Record<string, unknown> = {
    schemaVersion: plan.schemaVersion,
    id: plan.id,
    name: plan.name,
  };
  if (plan.description !== undefined) ordered.description = plan.description;
  ordered.entry = plan.entry;
  ordered.viewport = plan.viewport;
  ordered.tags = plan.tags;
  ordered.steps = plan.steps.map((s) => ({
    id: s.id,
    ordinal: s.ordinal,
    text: s.text,
  }));
  ordered.criteria = plan.criteria.map((c) => {
    const o: Record<string, unknown> = { id: c.id, ordinal: c.ordinal, text: c.text };
    if (c.after !== undefined) o.after = c.after;
    return o;
  });
  return JSON.stringify(ordered, null, 2) + "\n";
}
