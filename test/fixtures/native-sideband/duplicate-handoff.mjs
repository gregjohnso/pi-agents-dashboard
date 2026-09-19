// Two valid handoffs in the same window. Both are written before either is acknowledged, so the second is
// already in the parent's channel when it adopts the first - which is the only window a duplicate can occupy,
// since the parent closes the channel the moment it adopts. The parent must refuse rather than hold two.
import net from "node:net";

import { FIXTURE_PROTOCOL, SOCKET_PATH, bindPrivately, proofFor, send } from "./binder-fixture.mjs";

const { server, proof } = await bindPrivately(SOCKET_PATH);
const second = net.createServer();
await new Promise((resolve) => second.listen(`${SOCKET_PATH}-second`, () => resolve(undefined)));
const secondProof = proofFor(`${SOCKET_PATH}-second`);

const both = [
  send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: SOCKET_PATH, proof }, server),
  send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: SOCKET_PATH, proof: secondProof }, second),
];
await Promise.all(both);
process.exit(0);
