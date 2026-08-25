import { expect, it } from "vitest";

import { checkHostCapabilities, type HostCapabilityProbe } from "./compatibility.js";

it("reports unsupported rather than degrading on stock Pi 0.84.3", async () => {
  const report = await checkHostCapabilities();

  expect(report).toMatchObject({
    piVersion: "0.84.3",
    globalPackage: true,
    rpcWorker: true,
    daemonOwnedStartup: false,
    nativeAttach: false,
    composableLeftGesture: true,
    fullscreenCustomUi: true,
  });
  expect(report.blockers).toEqual([
    "Pi 0.84.3 has no documented public extension startup hook for selecting a daemon-owned backend before the model loop starts.",
    "Pi 0.84.3 has no documented public native attachment adapter that binds InteractiveMode to a daemon-owned remote session.",
  ]);
});

it("keeps the release blocked unless daemon startup and native attachment are both supported", async () => {
  const probe: HostCapabilityProbe = async () => ({
    piVersion: "future",
    globalPackage: true,
    rpcWorker: true,
    daemonOwnedStartup: true,
    nativeAttach: false,
    composableLeftGesture: true,
    fullscreenCustomUi: true,
  });

  const report = await checkHostCapabilities(probe);

  expect(report.daemonOwnedStartup).toBe(true);
  expect(report.nativeAttach).toBe(false);
  expect(report.blockers).toEqual([
    "Pi future has no documented public native attachment adapter that binds InteractiveMode to a daemon-owned remote session.",
  ]);
});

it("accepts an injected approved host probe only when every required capability is present", async () => {
  const probe: HostCapabilityProbe = async () => ({
    piVersion: "supported",
    globalPackage: true,
    rpcWorker: true,
    daemonOwnedStartup: true,
    nativeAttach: true,
    composableLeftGesture: true,
    fullscreenCustomUi: true,
  });

  await expect(checkHostCapabilities(probe)).resolves.toEqual({
    piVersion: "supported",
    globalPackage: true,
    rpcWorker: true,
    daemonOwnedStartup: true,
    nativeAttach: true,
    composableLeftGesture: true,
    fullscreenCustomUi: true,
    blockers: [],
  });
});
