// The same mismatch, but carrying a real listening server. The parent must dispose the handle it refuses.
import { SOCKET_PATH, bindPrivately, send } from "./binder-fixture.mjs";
const { server } = await bindPrivately(SOCKET_PATH);
await send({ protocol: 1, type: "sideband-bound", socketPath: SOCKET_PATH, proof: { device: "1", inode: "2", mode: 384, uid: 0 } }, server);
process.exit(0);
