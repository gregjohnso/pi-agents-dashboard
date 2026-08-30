/** Directory completion for the `/cwd` line, delegated to pi-tui's own file-completion provider. */
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

/** @typedef {{value:string,label:string,description?:string}} AutocompleteItem */

const CWD_LINE = "/cwd ";
/** Suggestions kept from one listing. The panel draws a windowful; the rest exist only to be scrolled. */
export const MAX_COMPLETION_ITEMS = 50;

/** The provider carries no state beyond the directory a relative path resolves against. @param {string} basePath */
function fileProvider(basePath) {
    return new CombinedAutocompleteProvider([], basePath);
}

/** The path a `/cwd` line is typing, or undefined when the line is not one. @param {string} prompt */
export function cwdArgument(prompt) {
    const line = prompt.trimStart();
    return line.startsWith(CWD_LINE) ? line.slice(CWD_LINE.length) : undefined;
}

/**
 * The directories a partly typed `/cwd` path admits. The path is completed as a line of its own
 * because the provider reads a line starting with `/` as a slash command and never reaches its file
 * listing. Files are dropped: `/cwd` refuses one, so offering it offers a choice that always fails.
 * @param {string} argument @param {string} basePath @param {AbortSignal} signal
 * @returns {Promise<{items:AutocompleteItem[],prefix:string}|undefined>}
 */
export async function suggestDirectories(argument, basePath, signal) {
    const suggestions = await fileProvider(basePath).getSuggestions([argument], 0, argument.length, { signal, force: true });
    if (suggestions === null)
        return undefined;
    // pi-tui marks a directory, including a symbolic link that resolves to one, with a trailing separator.
    const items = suggestions.items.filter((item) => item.label.endsWith("/")).slice(0, MAX_COMPLETION_ITEMS);
    return items.length === 0 ? undefined : { items, prefix: suggestions.prefix };
}

/**
 * The line Tab writes: the typed path replaced by the chosen directory, keeping both the `~` the
 * operator typed and the trailing separator that makes the next Tab list that directory's children.
 * @param {string} prompt @param {AutocompleteItem} item @param {string} prefix @param {string} basePath
 */
export function applyCwdCompletion(prompt, item, prefix, basePath) {
    return fileProvider(basePath).applyCompletion([prompt], 0, prompt.length, item, prefix).lines[0];
}
