// CLI entry for the deterministic *.flow.md parser.
//
// Usage: `npm run parse -- <path/to/file.flow.md>`
// Prints the FlowPlan as canonical JSON (stable key order, 2-space indent) to
// stdout. Parse errors print to stderr and exit non-zero.

import { parseFlowFile, serializeFlowPlan, FlowParseError } from "./parser";

function main(argv: string[]): number {
  const args = argv.slice(2);
  if (args.length !== 1) {
    process.stderr.write("usage: npm run parse -- <path/to/file.flow.md>\n");
    return 2;
  }
  try {
    const plan = parseFlowFile(args[0]);
    process.stdout.write(serializeFlowPlan(plan));
    return 0;
  } catch (e) {
    if (e instanceof FlowParseError) {
      process.stderr.write(`parse error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

process.exit(main(process.argv));
