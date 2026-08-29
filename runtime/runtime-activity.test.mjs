import { expect, it, vi } from "vitest";

import { inspectRuntimeActivity } from "./runtime-activity.mjs";

const worker = { pid: 42, startIdentity: "420", processGroupId: 42 };
const workers = vi.fn(async () => JSON.stringify({ schemaVersion: 1, workers: [{ sessionId: "session", runId: "run", leaseId: "lease", generation: 1, identity: worker, piChildIdentity: worker }] }));

it("reports only verified active supervisor identities", async () => {
  await expect(inspectRuntimeActivity({
    stateRoot: "/state/pi-dashboard", runtimeRoot: "/state/pi-dashboard",
    exists: async () => true, inspectEndpoint: async () => ({ status: "ABSENT" }), inspect: async () => worker, readFile: workers,
  })).resolves.toEqual({ activeDaemon: false, activeSupervisors: [worker], unverifiable: false });
});

it.each(["HEALTHY", "UNHEALTHY"])("treats a %s publication as a live daemon", async (status) => {
  const publication = { pid: 7, startIdentity: "70", processGroupId: 7 };
  await expect(inspectRuntimeActivity({
    stateRoot: "/state/pi-dashboard", exists: async () => true,
    inspectEndpoint: async () => ({ status, publication }), inspect: async () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    readFile: async () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
  })).resolves.toEqual({ activeDaemon: publication, activeSupervisors: [], unverifiable: false });
});

it("reports an unreadable daemon holder as unverifiable rather than idle", async () => {
  await expect(inspectRuntimeActivity({
    stateRoot: "/state/pi-dashboard", exists: async () => true,
    inspectEndpoint: async () => ({ status: "CONFLICT" }), inspect: async () => worker,
    readFile: async () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
  })).resolves.toEqual({ activeDaemon: false, activeSupervisors: [], unverifiable: true });
});
