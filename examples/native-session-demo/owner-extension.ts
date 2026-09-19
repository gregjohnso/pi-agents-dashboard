/**
 * The demo's owner-local Pi extension. Three jobs, all through public extension API.
 *
 * 1. It registers the fake provider, so a complete turn can be shown without a credential or a model call.
 *    The stream is built with Pi's own `createAssistantMessageEventStream`, resolved through the bundle's
 *    extension import map, so Pi consumes the same object type its built-in providers produce.
 *
 * 2. It publishes the public `TUI` that `ctx.ui.setWidget`'s factory is handed, which is how the pre-TUI
 *    ingress caller in this same process reaches `tui.terminal.dispatchNativeInput`. That factory argument is
 *    documented public extension surface: no private field is read, no key is decoded here, and no Pi object
 *    is wrapped or replaced.
 *
 * 3. It registers the reviewed owner management bridge, which gives the manager that launched this Pi a
 *    structured, authenticated channel for lifecycle and model facts and for stop/abort requests. It is the
 *    bridge's own public entry point, called with no options: with no sideband in the environment it connects
 *    to nothing and reports nothing, so an unmanaged Pi is unaffected. It opens beside startup and never in
 *    front of it, so nothing load-bearing here waits on it.
 *
 * The widget itself is one line, and it says what this session is: a demonstration with a fake provider.
 */

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

// @ts-expect-error -- the bridge is plain JavaScript with JSDoc types; `extension/**` is outside this
// project's checked program, which the intake records as a disclosed limitation rather than widening here.
import { registerOwnerExtension } from "../../extension/pi-agents-owner.mjs";
import { FAKE_MODEL_ID, FAKE_PROVIDER_ID, createFakeStreamSimple, fakeModelConfig } from "./fake-provider.mjs";
import { provideTui } from "./tui-handover.mjs";

const WIDGET_ID = "native-session-demo";
const LABEL = `native-session-demo · provider ${FAKE_PROVIDER_ID}/${FAKE_MODEL_ID} is a FAKE: deterministic replies, no model is called`;

export default function (pi: ExtensionAPI) {
  // The management bridge first, so a session_start replacement disposes the previous generation before this
  // file's own widget handler re-captures the TUI for the new one.
  registerOwnerExtension(pi);

  pi.registerProvider(FAKE_PROVIDER_ID, {
    name: "Native session demo (fake)",
    baseUrl: "http://127.0.0.1:0/unused-by-the-fake-stream",
    apiKey: "native-session-demo-no-credential",
    api: "openai-completions",
    models: [fakeModelConfig()],
    streamSimple: createFakeStreamSimple({ createStream: () => createAssistantMessageEventStream() }),
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget(WIDGET_ID, (tui: unknown) => {
      provideTui(tui);
      return {
        // A component that overruns the viewport crashes Pi's renderer, so the label is truncated with Pi's
        // own width helper rather than assumed to fit.
        render: (width: number) => [truncateToWidth(LABEL, width)],
        invalidate: () => {},
      };
    });
  });
}
