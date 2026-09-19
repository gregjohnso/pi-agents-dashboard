// A refusal message that nonetheless carries a bound server: the refusal must not leak the listener.
import { bindPrivately, send, FIXTURE_PROTOCOL } from "./binder-fixture.mjs";
const { server } = await bindPrivately(process.argv[2]);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-binder-refused", reason: "fixture refuses on purpose" }, server);
process.exit(0);
