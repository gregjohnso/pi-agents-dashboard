import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync, writeFileSync } from "node:fs";
import { DashboardGestureEditor } from "./key-gesture.mjs";
import { createFakeStreamSimple, fakeModelConfigs, FAKE_PROVIDER_ID } from "../../examples/native-session-demo/fake-provider.mjs";

// Disposable fixture only: all output paths are supplied by the test's private environment.
export default function (pi: ExtensionAPI) {
    const note = (data: unknown) => appendFileSync(process.env.PI_ESC_FIXTURE_EVENTS!, `${JSON.stringify(data)}\n`);
    pi.registerProvider(FAKE_PROVIDER_ID, {
        name: "Esc test fake (no network)", baseUrl: "http://127.0.0.1:0/unused", apiKey: "no-credential",
        api: "openai-completions", models: fakeModelConfigs(),
        streamSimple: createFakeStreamSimple({ createStream: () => createAssistantMessageEventStream() }),
    });
    pi.on("session_start", (_event, ctx) => {
        let editor: DashboardGestureEditor;
        ctx.ui.setEditorComponent((tui, theme, keys) => {
            editor = new DashboardGestureEditor(new CustomEditor(tui, theme, keys), () => note({ type: "return" }));
            return editor;
        });
        ctx.ui.setWidget("esc-fixture", (tui) => {
            tui.addInputListener((data) => {
                setImmediate(() => note({ type: "input", data, text: editor.getText(), pid: process.pid }));
                return undefined;
            });
            return { render: () => ["ESC-FIXTURE-READY"], invalidate: () => {} };
        });
        writeFileSync(process.env.PI_ESC_FIXTURE_READY!, JSON.stringify({ pid: process.pid, sessionFile: ctx.sessionManager.getSessionFile(), home: process.env.HOME, tmpDir: process.env.TMPDIR, fsCache: process.env.JITI_FS_CACHE }));
    });
}
