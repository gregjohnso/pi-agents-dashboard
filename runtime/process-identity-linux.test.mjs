import { expect, it, vi } from "vitest";

import {
  ProcessIdentityError,
  inspectProcessIdentity,
  parseProcStat,
} from "./process-identity-linux.mjs";

function procStat({ pid = 321, comm = "worker (rpc)", pgid = 654, startTimeTicks = "987654321" } = {}) {
  const fields = [
    "S", "1", String(pgid), String(pgid), "0", "-1", "4194560", "10", "0", "0", "0",
    "3", "2", "0", "0", "20", "0", "1", "0", startTimeTicks, "4096", "10",
  ];
  return `${pid} (${comm}) ${fields.join(" ")}\n`;
}

it("fails closed when proc returns a different PID or malformed numeric identity", async () => {
  await expect(
    inspectProcessIdentity(77, { readFile: async () => procStat({ pid: 78 }) }),
  ).rejects.toBeInstanceOf(ProcessIdentityError);
  expect(() => parseProcStat(procStat({ pgid: 0 }))).toThrowError(ProcessIdentityError);
  expect(() => parseProcStat(procStat({ startTimeTicks: "not-a-number" }))).toThrowError(
    ProcessIdentityError,
  );
  expect(() => parseProcStat("77 (truncated) S 1 2\n")).toThrowError(ProcessIdentityError);
});

it("rejects ambiguous PID inputs without reading proc", async () => {
  const procFs = { readFile: vi.fn() };
  await expect(inspectProcessIdentity(0, procFs)).rejects.toThrow(TypeError);
  await expect(inspectProcessIdentity(1.5, procFs)).rejects.toThrow(TypeError);
  expect(procFs.readFile).not.toHaveBeenCalled();
});
