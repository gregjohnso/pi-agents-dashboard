// A refusal message that nonetheless carries a bound server: the refusal must not leak the listener.
import { FIXTURE_PROTOCOL, SOCKET_PATH, bindPrivately, send } from "./binder-fixture.mjs";
const { server } = await bindPrivately(SOCKET_PATH);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-binder-refused", reason: "fixture refuses on purpose" }, server);
process.exit(0);
