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
 * The widget displays a warning only when the fake provider is active.
 */

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFile, rename } from "node:fs/promises";

// @ts-expect-error -- the bridge is plain JavaScript with JSDoc types; `extension/**` is outside this
// project's checked program, which the intake records as a disclosed limitation rather than widening here.
import { registerOwnerExtension } from "../../extension/pi-agents-owner.mjs";
import sessionColorExtension from "../../extension/session-color.ts";
// @ts-expect-error -- the dashboard's existing Left-gesture helper, plain JavaScript with JSDoc types.
import { DashboardGestureEditor } from "../../app/list/key-gesture.mjs";
import { FAKE_MODEL_ID, FAKE_PROVIDER_ID, createFakeStreamSimple, fakeModelConfigs } from "./fake-provider.mjs";
// @ts-expect-error -- plain JavaScript with JSDoc types, outside this project's checked program.
import { RETURN_SHORTCUT, noteInputProvenance, requestReturn } from "./return-channel.mjs";
import { provideTui } from "./tui-handover.mjs";

const WIDGET_ID = "native-session-demo";
/**
 * Fake mode pins a labelled fake provider on the command line; real mode names no provider at all and lets Pi
 * resolve the operator's own. This extension must therefore only register the fake when fake mode asked for
 * it, or it would override a real selection and mislabel what answered.
 */
const FAKE_PROVIDER_REQUESTED = process.env.PI_DEMO_FAKE_PROVIDER === "1";

/**
 * Submit the task this session was launched to run, exactly once.
 *
 * The prompt arrives as a FILE rather than an argument so its bytes are untouched: a task may begin with a
 * dash, span lines, or end in whitespace, and none of that survives argv reliably. `sendUserMessage` is
 * public extension API and always triggers a turn, so this is Pi's own submission path - nothing is typed
 * into the editor, no key is synthesised, and the operator's draft is never involved.
 *
 * The file is CLAIMED BY RENAME BEFORE SENDING. `session_start` can fire again for a replaced generation, and
 * a rename is the only step here that cannot happen twice, so it is what makes duplicate submission
 * impossible. The deliberate cost is the other direction: a crash between the rename and the send loses the
 * task rather than risking it running twice.
 *
 * `expandPromptTemplates` is left at its default, so the text is submitted as written rather than expanded as
 * a slash command or skill.
 */
async function submitInitialPrompt(pi: ExtensionAPI): Promise<void> {
  const promptFile = process.env.PI_DEMO_INITIAL_PROMPT_FILE;
  if (promptFile === undefined || promptFile === "") return;
  const claimed = `${promptFile}.sent`;
  let text: string;
  try {
    text = await readFile(promptFile, "utf8");
    await rename(promptFile, claimed);
  } catch {
    // Absent or already claimed: another generation of this session sent it, so this one must not.
    return;
  }
  if (text === "") return;
  pi.sendUserMessage(text);
}
const LABEL = `native-session-demo · provider ${FAKE_PROVIDER_ID}/${FAKE_MODEL_ID} is a FAKE: deterministic replies, no model is called`;

export default function (pi: ExtensionAPI) {
  // The management bridge first, so a session_start replacement disposes the previous generation before this
  // file's own widget handler re-captures the TUI for the new one.
  registerOwnerExtension(pi);

  if (FAKE_PROVIDER_REQUESTED) {
    pi.registerProvider(FAKE_PROVIDER_ID, {
      name: "Native session demo (fake)",
      baseUrl: "http://127.0.0.1:0/unused-by-the-fake-stream",
      apiKey: "native-session-demo-no-credential",
      api: "openai-completions",
      models: fakeModelConfigs(),
      streamSimple: createFakeStreamSimple({ createStream: () => createAssistantMessageEventStream() }),
    });
  }

  /**
   * Return to the list, through Pi's own shortcut registry.
   *
   * `registerShortcut` is public extension API, and the bundled editor consults extension shortcuts before any
   * built-in keybinding and before inserting text, so this decodes nothing and competes with no key. It also
   * never touches the draft: the operator's unsent text stays in Pi, which is the whole point of returning
   * rather than quitting. The manager decides what to detach; this only reports which terminal asked.
   */
  pi.registerShortcut(RETURN_SHORTCUT, {
    description: "Return to the session list, leaving this session running",
    handler: (ctx) => {
      const outcome = requestReturn();
      if (outcome.requested) return;
      // A gesture that cannot be attributed is refused out loud rather than widened into something broader.
      ctx.ui.notify(`${RETURN_SHORTCUT} did not return to the list: ${outcome.reason}`);
    },
  });

  /**
   * Left returns to the list, through the dashboard's own gesture helper and Pi's own editor.
   *
   * `ctx.ui.setEditorComponent` is public, documented extension API whose factory is handed Pi's real
   * `tui`, `theme` and `keybindings`. The editor it returns is `DashboardGestureEditor` wrapping a real
   * `CustomEditor`, which is why every other key still behaves exactly as Pi's editor behaves: cursor
   * movement, autocomplete, history, paste, undo and app keybindings are the base editor's, reached by
   * the wrapper's pass-through. Nothing reads a private field and no key is decoded here.
   *
   * The helper already encodes the approved boundary, and it is reused rather than restated: Left is
   * claimed only on a press, unmodified, while the MAIN editor has focus and the cursor sits at the
   * start. A dialog or overlay holding focus makes `focused` false, so Left stays Pi's. With text or
   * history in play the first Left passes through to move the cursor and only a second Left within the
   * helper's window returns, so Left never stops being an editing key.
   */
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new DashboardGestureEditor(new CustomEditor(tui, theme, keybindings), () => {
        const outcome = requestReturn();
        if (!outcome.requested) ctx.ui.notify(`Left did not return to the list: ${outcome.reason}`);
      }),
    );
    ctx.ui.setWidget(WIDGET_ID, (tui: unknown) => {
      provideTui(tui);
      // Where the gesture's origin comes from. This listener runs once per parsed sequence, immediately
      // before the focused component sees it, and patch 0007 hands it that sequence's own
      // `NativeInputProvenance`. It observes and consumes nothing: no `consume`, no rewritten `data`, so
      // every key still reaches Pi exactly as it would without it.
      const listening = tui as { addInputListener?: (listener: (data: string, provenance?: unknown) => undefined) => () => void };
      listening.addInputListener?.((_data, provenance) => {
        noteInputProvenance(provenance);
        return undefined;
      });
      return {
        // A component that overruns the viewport crashes Pi's renderer, so the label is truncated with Pi's
        // own width helper rather than assumed to fit.
        render: (width: number) => FAKE_PROVIDER_REQUESTED ? [truncateToWidth(LABEL, width)] : [],
        invalidate: () => {},
      };
    });
    // After the widget is mounted, so the session is ready to show the turn this starts.
    void submitInitialPrompt(pi);
  });

  // /color and the coloured border. Registered after the return editor above, because session-color wraps
  // whatever editor is installed when its own session_start runs; registered first, the return editor
  // replaced the wrapper and the border never took the colour.
  sessionColorExtension(pi, { bundled: true });
}
