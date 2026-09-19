// A bound message whose handle is a client socket rather than the listening server.
import { FIXTURE_PROTOCOL, SOCKET_PATH, bindPrivately, send } from "./binder-fixture.mjs";
import net from "node:net";
const { proof } = await bindPrivately(SOCKET_PATH);
const client = net.createConnection(SOCKET_PATH);
client.on("error", () => {});
await new Promise((resolve) => client.once("connect", resolve));
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: SOCKET_PATH, proof }, client);
process.exit(0);
