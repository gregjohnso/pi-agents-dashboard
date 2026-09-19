// A helper that binds nothing and answers with a protocol version this parent does not speak.
import { send } from "./binder-fixture.mjs";
await send({ protocol: 1, type: "sideband-bound", socketPath: process.argv[2], proof: { device: "1", inode: "2", mode: 384, uid: 0 } }, undefined);
process.exit(0);
