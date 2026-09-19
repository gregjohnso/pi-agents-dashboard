// A helper that hands over one listener and then tries to hand over a second.
//
// Node queues a handle send behind its own acknowledgement, so the second can only be written after the parent
// has already adopted the first - and the parent closes the channel on adoption, so it is refused there. This
// reports which happened through its exit code, which the parent checks: 9 means the channel was already shut,
// 10 means a second handoff was accepted onto the wire.
import net from "node:net";

import { FIXTURE_PROTOCOL, SOCKET_PATH, bindPrivately, proofFor, send } from "./binder-fixture.mjs";

const { server, proof } = await bindPrivately(SOCKET_PATH);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: SOCKET_PATH, proof }, server);

const second = net.createServer();
await new Promise((resolve) => second.listen(`${SOCKET_PATH}-second`, () => resolve(undefined)));
const again = await send(
  { protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: SOCKET_PATH, proof: proofFor(`${SOCKET_PATH}-second`) },
  second,
);
process.exit(again === null ? 10 : 9);
