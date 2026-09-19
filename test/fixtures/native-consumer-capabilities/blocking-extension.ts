/**
 * A test-only extension whose `session_start` handler never resolves.
 *
 * This is the blocked-startup case the published input target exists for, made real rather than described: a
 * management extension queued behind this one never runs, so an extension-mediated ingress route does not
 * exist in this process. The handler records that it blocked and then awaits a promise nothing settles.
 *
 * It registers nothing, submits nothing and reaches no model. `PI_BLOCKING_EXTENSION_LOG` is its only input.
 */

import { appendFileSync } from "node:fs";

const logPath = process.env.PI_BLOCKING_EXTENSION_LOG;

function record(event: Record<string, unknown>): void {
	appendFileSync(logPath as string, `${JSON.stringify({ ...event, pid: process.pid })}\n`);
}

export default function blocking(pi: { on(event: string, handler: () => Promise<void>): void }): void {
	if (!logPath) throw new Error("PI_BLOCKING_EXTENSION_LOG is required");
	pi.on("session_start", async () => {
		record({ event: "sessionStartBlocking", at: Date.now() });
		// Never settles. Any later extension callback in this process is therefore unreachable.
		await new Promise<void>(() => {});
		record({ event: "sessionStartReleased" });
	});
}
