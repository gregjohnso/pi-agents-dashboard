// A bound message with no handle at all.
import { bindPrivately, send, FIXTURE_PROTOCOL } from "./binder-fixture.mjs";
const { proof } = await bindPrivately(process.argv[2]);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: process.argv[2], proof }, undefined);
process.exit(0);
