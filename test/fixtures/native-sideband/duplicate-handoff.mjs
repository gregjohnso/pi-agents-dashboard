// Two valid handoffs. The second arrives before this process exits, so the parent must still refuse.
import { FIXTURE_PROTOCOL, SOCKET_PATH, bindPrivately, proofFor, send } from "./binder-fixture.mjs";
import net from "node:net";
const socketPath = SOCKET_PATH;
const { server, proof } = await bindPrivately(socketPath);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath, proof }, server);
const second = net.createServer();
await new Promise((resolve) => second.listen(`${socketPath}-second`, () => resolve(undefined)));
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath, proof: proofFor(`${socketPath}-second`) }, second);
process.exit(0);
