/**
 * One test-only extension that does exactly two things, in the order that makes the qualification real.
 *
 * 1. **At load time** it registers the fake provider, so the CLI starts a complete session without a
 *    credential, a tool or a model call. Load time matters: a provider registered from `session_start` would
 *    never register in this process, because of what this extension does next.
 * 2. **In `session_start`** it blocks forever. That is the condition the published input target exists for: an
 *    arbitrary extension can hold the startup handler open, so a management extension queued behind it never
 *    registers and an extension-mediated ingress route does not exist in this process at all.
 *
 * It submits nothing, reaches no model and registers no widget. `HOST_BLOCKING_EXTENSION_LOG` is its only
 * output.
 */

import { appendFileSync } from "node:fs";

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createFakeStreamSimple, fakeModelConfig } from "../../../examples/native-session-demo/fake-provider.mjs";

const logPath = process.env.HOST_BLOCKING_EXTENSION_LOG;

function record(event: Record<string, unknown>): void {
	appendFileSync(logPath as string, `${JSON.stringify({ ...event, pid: process.pid, at: Date.now() })}\n`);
}

export default function hostRealPiFixture(pi: ExtensionAPI): void {
	if (!logPath) throw new Error("HOST_BLOCKING_EXTENSION_LOG is required");
	pi.registerProvider("host-real-pi-fake", {
		name: "Host real-Pi qualification (fake)",
		baseUrl: "http://127.0.0.1:0/unused-by-the-fake-stream",
		apiKey: "host-real-pi-no-credential",
		api: "openai-completions",
		models: [{ ...fakeModelConfig(), id: "deterministic-echo" }],
		streamSimple: createFakeStreamSimple({ createStream: () => createAssistantMessageEventStream() }),
	});
	record({ event: "providerRegisteredAtLoad" });

	pi.on("session_start", async () => {
		record({ event: "sessionStartBlocking" });
		// Never settles. Every later extension callback in this process is therefore unreachable, which is the
		// whole reason a published input target has to exist outside the extension path.
		await new Promise<void>(() => {});
		record({ event: "sessionStartReleased" });
	});
}
