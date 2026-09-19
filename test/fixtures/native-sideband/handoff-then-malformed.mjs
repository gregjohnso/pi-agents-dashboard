// A helper that hands over one valid listener and then sends malformed late traffic, then exits cleanly.
//
// The counterpart to `duplicate-handoff.mjs`: it discriminates how late traffic is handled when it carries no
// handle at all. The exit is 0, so a refusal here can only come from the parent having observed the late
// message itself, and the first listener still has to be disposed.
import { FIXTURE_PROTOCOL, SOCKET_PATH, bindPrivately, send } from "./binder-fixture.mjs";

const { server, proof } = await bindPrivately(SOCKET_PATH);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound", socketPath: SOCKET_PATH, proof }, server);
await send({ protocol: FIXTURE_PROTOCOL, type: "sideband-bound-again", note: "x".repeat(4_096) }, undefined);
process.exit(0);
