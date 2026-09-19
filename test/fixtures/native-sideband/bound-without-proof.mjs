// A v2 bound message missing its ownership proof. Without the proof there is nothing to compare a path to.
import { FIXTURE_PROTOCOL, SOCKET_PATH, bindPrivately, send } from "./binder-fixture.mjs";
const { server } = await bindPrivately(SOCKET_PATH);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: SOCKET_PATH }, server);
process.exit(0);
