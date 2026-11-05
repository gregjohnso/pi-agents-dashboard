import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COLORS = {
	red: 203,
	blue: 75,
	green: 78,
	yellow: 179,
	purple: 141,
	orange: 173,
	pink: 212,
	cyan: 80,
} as const;

const COLOR_NAMES = ["default", ...Object.keys(COLORS)] as const;

type ColorName = "default" | keyof typeof COLORS;
type BorderColor = (text: string) => string;

function isColorName(value: string): value is ColorName {
	return COLOR_NAMES.some((name) => name === value);
}

/** The custom session entry a colour is saved in, so it survives a restart, reload or resume. */
const SAVED_COLOR = "session-color";

/** The latest colour saved on the session's current branch. */
function savedColor(ctx: { sessionManager?: { getBranch?: () => unknown[] } }): ColorName {
	const entries = (ctx.sessionManager?.getBranch?.() ?? []) as { type?: string; customType?: string; data?: { color?: unknown } }[];
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== SAVED_COLOR) continue;
		const color = entry.data?.color;
		return typeof color === "string" && isColorName(color) ? color : "default";
	}
	return "default";
}

function makeBorderColor(name: ColorName): BorderColor | undefined {
	if (name === "default") return undefined;
	return (text) => `\x1b[38;5;${COLORS[name]}m${text}\x1b[39m`;
}

/**
 * Bundled with pi-agents, which loads it in every dashboard session. The same file can also be installed as the
 * operator's global extension for plain Pi; that copy steps aside in a session whose pi-agents bundles it, so
 * /color and the border are registered once.
 */
export default function sessionColorExtension(pi: ExtensionAPI, options: { bundled?: boolean } = {}) {
	if (options.bundled !== true && process.env.PI_AGENTS_BUNDLES_SESSION_COLOR === "1") return;
	let currentColor: ColorName = "default";
	let borderColor: BorderColor | undefined;
	let requestRender: (() => void) | undefined;
	// Announced on Pi's event bus so pi-agents can show the colour on the session's row and set it from the list.
	const announce = () => pi.events.emit("session-color:changed", { color: currentColor });
	const apply = (name: ColorName) => {
		currentColor = name;
		borderColor = makeBorderColor(name);
		pi.appendEntry(SAVED_COLOR, { color: name });
		requestRender?.();
		announce();
	};
	pi.events.on("session-color:set", (data) => {
		const name = (data as { color?: unknown })?.color;
		if (typeof name === "string" && isColorName(name)) apply(name);
	});

	pi.on("session_start", (_event, ctx) => {
		currentColor = savedColor(ctx);
		borderColor = makeBorderColor(currentColor);
		requestRender = undefined;
		announce();

		if (ctx.mode !== "tui") return;
		const previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			requestRender = () => tui.requestRender();
			const editor = previousFactory
				? previousFactory(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings);
			const render = editor.render.bind(editor);
			editor.render = (width) => {
				const originalBorderColor = editor.borderColor;
				if (!borderColor || !originalBorderColor) return render(width);
				editor.borderColor = borderColor;
				try {
					return render(width);
				} finally {
					editor.borderColor = originalBorderColor;
				}
			};
			return editor;
		});
	});

	pi.registerCommand("color", {
		description: "Set the session input border color",
		getArgumentCompletions: (prefix) => {
			const matches = COLOR_NAMES.filter((name) => name.startsWith(prefix.toLowerCase()));
			return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			let selection = args.trim().toLowerCase();
			if (!selection) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Session color: ${currentColor}`, "info");
					return;
				}
				selection = (await ctx.ui.select("Session color", [...COLOR_NAMES])) ?? "";
			}
			if (!selection) return;
			if (!isColorName(selection)) {
				ctx.ui.notify(`Unknown color: ${selection}. Use ${COLOR_NAMES.join(", ")}.`, "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Session colors are available only in interactive mode.", "warning");
				return;
			}

			apply(selection);
			ctx.ui.notify(selection === "default" ? "Session color reset" : `Session color: ${selection}`, "info");
		},
	});
}
