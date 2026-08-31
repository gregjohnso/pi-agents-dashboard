import { expect } from "vitest";

/**
 * State on one line why a daemon command returned what it did, then anything else it captured.
 *
 * `toMatchObject` compares only the properties it is handed, so an unexpected daemon command result
 * reads as "expected { code: 1, error: { …(2) } } to match object { code: +0, …(1) }" followed by
 * "(3 matching properties omitted from actual)": the `error` that names the cause never appears.
 * A daemon start failure carries the daemon child's own captured stderr in later lines of
 * `error.message`, which is why only the first line is folded into the summary.
 *
 * @param {string} command the daemon verb that produced this result
 * @param {any} result a `runDaemonCommand` result
 * @returns {string} one summary line, followed by whatever the daemon child itself wrote
 */
export function describeDaemonCommandResult(command, result) {
  const error = result?.error;
  if (error === undefined) return `daemon ${command} returned code ${result?.code} and reported no error`;
  const [reason, ...captured] = String(error.message ?? "").split("\n");
  return [`daemon ${command} returned code ${result?.code} (${error.code ?? "no error code"}): ${reason}`, ...captured].join("\n");
}

/**
 * Assert one daemon command result, naming the command's own reason when it does not match.
 *
 * @param {string} command the daemon verb that produced this result
 * @param {any} result a `runDaemonCommand` result
 * @param {any} expected the subset every caller of this command requires
 * @returns {any} the result, so a caller can keep reading it
 */
export function expectDaemonCommand(command, result, expected) {
  expect(result, describeDaemonCommandResult(command, result)).toMatchObject(expected);
  return result;
}
