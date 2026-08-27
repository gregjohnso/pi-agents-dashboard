/** Terminal input decoding for the dashboard: bracketed paste and typed text. */
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/**
 * Return the text a keystroke or paste contributes to a single-line field, or undefined when the
 * bytes are a control sequence the caller must handle as a key.
 *
 * Terminals deliver a paste as one burst, wrapped in bracketed-paste markers when the mode is on.
 * Newlines and tabs become spaces because every dashboard field is one line.
 * @param {string} data
 */
export function pastedText(data) {
    if (data === "")
        return undefined;
    const bracketed = data.startsWith(PASTE_START);
    const body = bracketed
        ? data.slice(PASTE_START.length, data.endsWith(PASTE_END) ? -PASTE_END.length : undefined)
        : data;
    // An escape sequence that is not a paste is a key: arrows, function keys, Escape itself.
    if (!bracketed && body.charCodeAt(0) === 27)
        return undefined;
    const text = [...body]
        .map((character) => (character === "\n" || character === "\r" || character === "\t" ? " " : character))
        .filter((character) => character === " " || character.charCodeAt(0) >= 32)
        .join("");
    return text === "" ? undefined : text;
}
