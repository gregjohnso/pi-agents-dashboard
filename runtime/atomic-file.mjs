import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Durably publish one JSON value with same-directory write, sync, rename, and directory sync.
 *
 * @param {string} path
 * @param {unknown} value
 * @param {{ open(path: string, flags: string, mode?: number): Promise<any>, rename(from: string, to: string): Promise<void>, rm(path: string, options: { force: boolean }): Promise<void> }} [fsOps]
 */
export async function atomicWriteJson(path, value, fsOps = fs) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    throw new TypeError("Value must be JSON serializable", { cause });
  }
  if (json === undefined) {
    throw new TypeError("Value must be JSON serializable");
  }

  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let fileHandle;
  let renamed = false;

  try {
    fileHandle = await fsOps.open(temporaryPath, "wx", 0o600);
    await fileHandle.chmod(0o600);
    const metadata = await fileHandle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("Atomic JSON temporary file must be a regular mode-0600 file");
    }
    await fileHandle.writeFile(`${json}\n`, "utf8");
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = undefined;

    await fsOps.rename(temporaryPath, path);
    renamed = true;

    const directoryHandle = await fsOps.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (fileHandle !== undefined) {
      await fileHandle.close();
    }
    if (!renamed) {
      await fsOps.rm(temporaryPath, { force: true });
    }
  }
}
