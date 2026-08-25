import { expect, it, vi } from "vitest";

import { createAppController } from "./app-controller.mjs";

it("owns the injected viewer boundary and returns to the same list", async () => {
  let openSelected;
  const list = { open: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const createList = vi.fn(({ openViewer }) => { openSelected = openViewer; return list; });
  const viewer = { close: vi.fn(async () => {}) };
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
  expect(viewer.close).toHaveBeenCalledOnce();
});
