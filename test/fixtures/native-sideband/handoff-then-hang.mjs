// Hands over a real listener and then refuses to exit. Bounded cleanup has to end it.
import { bindPrivately, send, FIXTURE_PROTOCOL } from "./binder-fixture.mjs";
const { server, proof } = await bindPrivately(process.argv[2]);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: process.argv[2], proof }, server);
setInterval(() => {}, 1_000);
