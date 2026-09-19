// The same mismatch, but carrying a real listening server. The parent must dispose the handle it refuses.
import { bindPrivately, send } from "./binder-fixture.mjs";
const { server } = await bindPrivately(process.argv[2]);
await send({ protocol: 1, type: "sideband-bound", socketPath: process.argv[2], proof: { device: "1", inode: "2", mode: 384, uid: 0 } }, server);
process.exit(0);
