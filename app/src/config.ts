import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function readPort(): number {
  const raw = process.env.APP_PORT;
  const n = raw ? Number(raw) : 3000;
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`APP_PORT must be a valid port number, got: ${raw}`);
  }
  return n;
}

function readSessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length === 0) {
    throw new Error("SESSION_SECRET is required (set it in .env)");
  }
  return s;
}

function readBugFlags(): ReadonlySet<string> {
  const raw = process.env.PROOFLOOP_BUGS ?? "";
  const flags = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(flags);
}

export const config = {
  port: readPort(),
  sessionSecret: readSessionSecret(),
  bugs: readBugFlags(),
} as const;

export function bugOn(flag: string): boolean {
  return config.bugs.has(flag);
}
