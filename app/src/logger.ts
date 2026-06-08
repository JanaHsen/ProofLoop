type Level = "info" | "warn" | "error";

function line(level: Level, msg: string, extra?: Record<string, unknown>): string {
  const payload = { ts: new Date().toISOString(), level, msg, ...extra };
  return JSON.stringify(payload);
}

export const log = {
  info(msg: string, extra?: Record<string, unknown>): void {
    process.stdout.write(line("info", msg, extra) + "\n");
  },
  warn(msg: string, extra?: Record<string, unknown>): void {
    process.stdout.write(line("warn", msg, extra) + "\n");
  },
  error(msg: string, extra?: Record<string, unknown>): void {
    process.stderr.write(line("error", msg, extra) + "\n");
  },
};
