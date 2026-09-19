// Hands over a real listener and then refuses to exit. Bounded cleanup has to end it.
import { FIXTURE_PROTOCOL, SOCKET_PATH, bindPrivately, send } from "./binder-fixture.mjs";
const { server, proof } = await bindPrivately(SOCKET_PATH);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: SOCKET_PATH, proof }, server);
setInterval(() => {}, 1_000);
