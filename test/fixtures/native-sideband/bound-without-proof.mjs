// A v2 bound message missing its ownership proof. Without the proof there is nothing to compare a path to.
import { bindPrivately, send, FIXTURE_PROTOCOL } from "./binder-fixture.mjs";
const { server } = await bindPrivately(process.argv[2]);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: process.argv[2] }, server);
process.exit(0);
