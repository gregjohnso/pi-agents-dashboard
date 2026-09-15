import { appendFileSync } from "node:fs";

/**
 * A module hook that writes every URL the loader resolves to `PI_AGENTS_MODULE_LOG`.
 *
 * It is how a test reads the module graph a real import produces, rather than the graph its source
 * appears to describe: Pi's leaves are reached through `import.meta.resolve`, so no static parse of
 * this package can tell which of Pi's files an import actually pulls in.
 */
const log = process.env.PI_AGENTS_MODULE_LOG;

export async function load(url, context, nextLoad) {
  // Recorded on load rather than on resolve: `import.meta.resolve` asks the loader for a URL without
  // evaluating anything, and this file exists to say which of Pi's modules are actually evaluated.
  if (log !== undefined) appendFileSync(log, `${url}\n`);
  return nextLoad(url, context);
}
