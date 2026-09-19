// A bound message whose handle is a client socket rather than the listening server.
import { bindPrivately, send, FIXTURE_PROTOCOL } from "./binder-fixture.mjs";
import net from "node:net";
const { proof } = await bindPrivately(process.argv[2]);
const client = net.createConnection(process.argv[2]);
client.on("error", () => {});
await new Promise((resolve) => client.once("connect", resolve));
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: process.argv[2], proof }, client);
process.exit(0);
