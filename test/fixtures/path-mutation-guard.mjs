import { resolve, sep } from "node:path";

/**
 * Refuse and record every mutating `node:fs/promises` call beneath a guarded path.
 *
 * `rm` forgets a dashboard row and never unlinks Pi's canonical session file or removes a managed
 * worktree, so a test asserts the mutation never happens rather than checking for damage afterwards.
 * Reads stay allowed, because the delete path still inspects record and process identity.
 */

/** Every `node:fs/promises` export that can change a path. `open` is guarded only for write flags. */
const MUTATING = [
  "appendFile", "chmod", "chown", "copyFile", "cp", "lchmod", "lchown", "link", "lutimes",
  "mkdir", "mkdtemp", "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile",
];
/** Methods whose second argument is a destination path. */
const DESTINATION_METHODS = ["rename", "copyFile", "cp", "link", "symlink"];
/** O_WRONLY, O_RDWR, O_CREAT, O_TRUNC and O_APPEND; O_RDONLY is zero. */
const WRITE_OPEN_FLAGS = 0o3 | 0o100 | 0o1000 | 0o2000;

/** @type {Set<string>} */
const guarded = new Set();
/** @type {Array<{ method: string, path: string }>} */
const violations = [];

/** @param {unknown} candidate */
function pathOf(candidate) {
  if (typeof candidate === "string") return resolve(candidate);
  if (candidate instanceof URL && candidate.protocol === "file:") return resolve(candidate.pathname);
  return undefined;
}

/** @param {unknown} candidate */
function guardedPath(candidate) {
  const path = pathOf(candidate);
  if (path === undefined) return undefined;
  for (const root of guarded) {
    if (path === root || path.startsWith(`${root}${sep}`)) return path;
  }
  return undefined;
}

/** @param {unknown} flags */
function opensForWriting(flags) {
  if (typeof flags === "number") return (flags & WRITE_OPEN_FLAGS) !== 0;
  return typeof flags === "string" && /[wa+]/u.test(flags);
}

/** Record and refuse one attempted mutation. @param {string} method @param {string} path */
function refuse(method, path) {
  violations.push({ method, path });
  throw Object.assign(new Error(`Forbidden ${method} beneath a guarded path: ${path}`), { code: "PATH_MUTATION_FORBIDDEN" });
}

/**
 * Wrap one `node:fs/promises` module so its mutating calls honour the guarded paths.
 *
 * @param {Record<string, any>} actual
 * @returns {Record<string, any>}
 */
export function guardFsPromises(actual) {
  /** @type {Record<string, any>} */
  const wrapped = { ...actual };
  for (const method of MUTATING) {
    const original = actual[method];
    if (typeof original !== "function") continue;
    wrapped[method] = (/** @type {any[]} */ ...args) => {
      const path = guardedPath(args[0]);
      if (path !== undefined) refuse(method, path);
      const destination = DESTINATION_METHODS.includes(method) ? guardedPath(args[1]) : undefined;
      if (destination !== undefined) refuse(method, destination);
      return original(...args);
    };
  }
  const open = actual.open;
  if (typeof open === "function") {
    wrapped.open = (/** @type {any[]} */ ...args) => {
      const path = guardedPath(args[0]);
      if (path !== undefined && opensForWriting(args[1])) refuse("open", path);
      return open(...args);
    };
  }
  wrapped.default = wrapped;
  return wrapped;
}

/** Forbid mutation at or beneath each path until the next release. @param {string[]} paths */
export function forbidMutationBeneath(...paths) {
  for (const path of paths) guarded.add(resolve(path));
}

/** Attempted mutations beneath a guarded path, newest last. */
export function mutationAttempts() {
  return violations.map((violation) => `${violation.method} ${violation.path}`);
}

export function releaseMutationGuards() {
  guarded.clear();
  violations.length = 0;
}
