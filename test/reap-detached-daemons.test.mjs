import { describe, expect, it } from "vitest";

import { detachedDaemonsToReap } from "./reap-detached-daemons.mjs";

describe("reaping detached test daemons", () => {
  const listing = [
    "  111  30 node /repo/runtime/daemon.mjs --root /tmp/pi-dashboard-pty-abc/state",
    "  222 900 node /repo/runtime/daemon.mjs --root /tmp/migration-real-daemon-xyz/pi-dashboard",
    "  333  10 node /repo/runtime/daemon.mjs --root /home/dev/.local/state/pi-dashboard",
    "  444  10 node /repo/runtime/worker.mjs --root /tmp/pi-dashboard-pty-abc/state",
  ].join("\n");

  it("reaps only temporary-root daemons this run could have started", () => {
    expect(detachedDaemonsToReap(listing, 120)).toEqual([{ pid: 111, root: "/tmp/pi-dashboard-pty-abc/state" }]);
  });

  it("leaves a developer's real daemon and non-daemon processes alone at any age", () => {
    const reaped = detachedDaemonsToReap(listing, 10_000).map(({ pid }) => pid);
    expect(reaped).toEqual([111, 222]);
    expect(reaped).not.toContain(333);
    expect(reaped).not.toContain(444);
  });
});
