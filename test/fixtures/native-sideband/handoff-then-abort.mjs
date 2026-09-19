// Hands over a real listener and then dies abruptly without a clean exit code.
import { FIXTURE_PROTOCOL, SOCKET_PATH, bindPrivately, send } from "./binder-fixture.mjs";
const { server, proof } = await bindPrivately(SOCKET_PATH);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: SOCKET_PATH, proof }, server);
process.kill(process.pid, "SIGKILL");
