// A known version, an unknown type, and a real server attached. The handle is still the parent`s to end.
import { SOCKET_PATH, bindPrivately, send } from "./binder-fixture.mjs";
import { FIXTURE_PROTOCOL } from "./binder-fixture.mjs";
const { server } = await bindPrivately(SOCKET_PATH);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-something-else", socketPath: SOCKET_PATH }, server);
process.exit(0);
