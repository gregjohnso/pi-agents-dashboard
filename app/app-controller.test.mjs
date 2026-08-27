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

it("reopens the one list instance when the viewer returns through onReturn", async () => {
  let activate;
  let onReturn;
  let reportClosed;
  const list = { open: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const createList = vi.fn(({ openViewer }) => { activate = openViewer; return list; });
  // open() fires onReturn once the controller has bound the viewer; a viewer that never
  // returns would leave `closed` pending and time this test out.
  const viewer = {
    open: vi.fn(async () => { onReturn(); }),
    close: vi.fn(async () => { reportClosed(); }),
    closed: new Promise((resolve) => { reportClosed = resolve; }),
  };
  const app = createAppController({
    createList,
    async openViewer(sessionId, handlers) { expect(sessionId).toBe("session-2"); onReturn = handlers.onReturn; return viewer; },
  });
  await app.open();
  await activate("session-2");
  expect(createList).toHaveBeenCalledOnce();
  expect(list.open).toHaveBeenCalledTimes(2);
  expect(viewer.close).toHaveBeenCalled();
});
