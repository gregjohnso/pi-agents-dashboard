// Two valid handoffs. The second arrives before this process exits, so the parent must still refuse.
import { bindPrivately, send, proofFor, FIXTURE_PROTOCOL } from "./binder-fixture.mjs";
import net from "node:net";
const socketPath = process.argv[2];
const { server, proof } = await bindPrivately(socketPath);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath, proof }, server);
const second = net.createServer();
await new Promise((resolve) => second.listen(`${socketPath}-second`, () => resolve(undefined)));
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath, proof: proofFor(`${socketPath}-second`) }, second);
process.exit(0);
