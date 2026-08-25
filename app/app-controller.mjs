/** Own list/viewer replacement while keeping selection and scroll in one list instance. */
export function createAppController({ createList, openViewer }) {
  if (typeof createList !== "function" || typeof openViewer !== "function") throw new TypeError("createList and openViewer are required");
  let viewer;
  let closed = false;
  const list = createList({
    async openViewer(sessionId) {
      if (viewer !== undefined || closed) return;
      await list.close();
      let opened;
      const onReturn = () => { void opened?.close(); };
      opened = await openViewer(sessionId, { onReturn });
      viewer = opened;
      try {
        await viewer.open?.();
        await viewer.closed;
      } finally {
        await viewer.close();
        if (viewer === opened) viewer = undefined;
      }
      if (!closed) await list.open();
    },
  });
  return {
    async open() { closed = false; await list.open(); },
    async close() {
      closed = true;
      const active = viewer;
      viewer = undefined;
      if (active !== undefined) await active.close();
      await list.close();
    },
  };
}
