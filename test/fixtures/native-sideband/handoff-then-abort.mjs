// Hands over a real listener and then dies abruptly without a clean exit code.
import { bindPrivately, send, FIXTURE_PROTOCOL } from "./binder-fixture.mjs";
const { server, proof } = await bindPrivately(process.argv[2]);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: process.argv[2], proof }, server);
process.kill(process.pid, "SIGKILL");
