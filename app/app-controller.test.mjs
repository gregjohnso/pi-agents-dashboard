import { expect, it, vi } from "vitest";

import { createAppController } from "./app-controller.mjs";

it("owns the injected viewer boundary and returns to the same list", async () => {
  let openSelected;
  const list = { open: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const createList = vi.fn(({ openViewer }) => { openSelected = openViewer; return list; });
  const viewer = { open: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const openViewer = vi.fn(async (sessionId) => {
    expect(sessionId).toBe("session-1");
    return viewer;
  });
  const app = createAppController({ createList, openViewer });
  await app.open();
  await openSelected("session-1");
  await app.close();
  expect(createList).toHaveBeenCalledOnce();
  expect(list.open).toHaveBeenCalledTimes(2);
  expect(list.close).toHaveBeenCalledTimes(2);
  expect(viewer.open).toHaveBeenCalledOnce();
  expect(viewer.close).toHaveBeenCalledOnce();
});

it("preserves the list's selected session and scroll across Enter/Right replacement", async () => {
  let activate;
  const state = { selectedSessionId: "session-2", viewportOffset: 17 };
  const list = {
    open: vi.fn(async () => { expect(state).toEqual({ selectedSessionId: "session-2", viewportOffset: 17 }); }),
    close: vi.fn(async () => {}),
  };
  const viewer = { open: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const app = createAppController({
    createList({ openViewer }) { activate = openViewer; return list; },
    async openViewer(sessionId, { onReturn }) { expect(sessionId).toBe("session-2"); queueMicrotask(onReturn); return viewer; },
  });
  await app.open();
  await activate("session-2");
  expect(list.open).toHaveBeenCalledTimes(2);
  expect(state).toEqual({ selectedSessionId: "session-2", viewportOffset: 17 });
});
