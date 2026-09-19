import { readFile } from "node:fs/promises";

/** A Linux proc record that cannot be used as an exact process identity. */
export class ProcessIdentityError extends Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options) {
    super(message, options);
    this.name = "ProcessIdentityError";
    this.code = "AMBIGUOUS_IDENTITY";
  }
}

/**
 * Parse Linux /proc/<pid>/stat without assuming the parenthesized command has no spaces or parens.
 *
 * @param {string} stat
 */
export function parseProcStat(stat) {
  if (typeof stat !== "string") {
    throw new ProcessIdentityError("Linux proc stat must be text");
  }
  const openParen = stat.indexOf(" (");
  const closeParen = stat.lastIndexOf(") ");
  if (openParen <= 0 || closeParen <= openParen + 1) {
    throw new ProcessIdentityError("Linux proc stat has an ambiguous command field");
  }

  const pidText = stat.slice(0, openParen);
  const fields = stat.slice(closeParen + 2).trim().split(/\s+/u);
  if (fields.length < 20) {
    throw new ProcessIdentityError("Linux proc stat is missing identity fields");
  }

  const pid = Number(pidText);
  const pgid = Number(fields[2]);
  const startTimeTicks = fields[19];
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new ProcessIdentityError("Linux proc stat contains an invalid PID");
  }
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    throw new ProcessIdentityError("Linux proc stat contains an invalid process-group ID");
  }
  if (!/^\d+$/u.test(startTimeTicks) || BigInt(startTimeTicks) <= 0n) {
    throw new ProcessIdentityError("Linux proc stat contains invalid process start ticks");
  }

  return { pid, pgid, startTimeTicks };
}

/**
 * The exact PID/start-time/process-group identity carried by one already-read proc stat record.
 *
 * Separate from reading `/proc`, because a caller that holds a snapshot taken at a moment it can
 * defend — before anything could have reaped the process and freed its PID for reuse — must be able
 * to name the identity in that snapshot without reading the PID again.
 *
 * @param {string} stat
 */
export function identityFromProcStat(stat) {
  const linuxIdentity = parseProcStat(stat);
  return {
    pid: linuxIdentity.pid,
    processGroupId: linuxIdentity.pgid,
    startIdentity: linuxIdentity.startTimeTicks,
  };
}

/**
 * Inspect the exact PID/start-time/process-group identity Linux exposes in procfs.
 *
 * @param {number} pid
 * @param {{ readFile(path: string, encoding: string): Promise<string> }} [procFs]
 */
export async function inspectProcessIdentity(
  pid,
  procFs = /** @type {any} */ ({ readFile }),
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("PID must be a positive safe integer");
  }
  const identity = identityFromProcStat(await procFs.readFile(`/proc/${pid}/stat`, "utf8"));
  if (identity.pid !== pid) {
    throw new ProcessIdentityError("Linux proc stat PID does not match the requested PID");
  }
  return identity;
}
