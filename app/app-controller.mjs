/** Own list/viewer transitions while keeping the list instance stable. */
export function createAppController({ createList, openViewer }) {
  if (typeof createList !== "function" || typeof openViewer !== "function") throw new TypeError("createList and openViewer are required");
  let viewer;
  const list = createList({
    async openViewer(sessionId) {
      await list.close();
      viewer = await openViewer(sessionId);
      await viewer.closed;
      await viewer.close();
      viewer = undefined;
      await list.open();
    },
  });
  return {
    async open() { await list.open(); },
    async close() {
      if (viewer !== undefined) { await viewer.close(); viewer = undefined; }
      await list.close();
    },
  };
}
