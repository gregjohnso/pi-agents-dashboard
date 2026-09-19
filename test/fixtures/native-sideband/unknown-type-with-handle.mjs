// A known version, an unknown type, and a real server attached. The handle is still the parent`s to end.
import { bindPrivately, send } from "./binder-fixture.mjs";
import { FIXTURE_PROTOCOL } from "./binder-fixture.mjs";
const { server } = await bindPrivately(process.argv[2]);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-something-else", socketPath: process.argv[2] }, server);
process.exit(0);
