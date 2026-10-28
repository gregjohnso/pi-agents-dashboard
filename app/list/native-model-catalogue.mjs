/**
 * Pi's own model catalogue, read the way Pi publishes it.
 *
 * `pi --list-models` is Pi's documented listing (see the bundled `docs/extensions.md` and
 * `docs/custom-provider.md`, which both describe making providers available to it). Using it means **Pi**
 * resolves the operator's providers, credentials and configuration; this file never reads any of that and
 * never contacts a provider. The dashboard's existing picker is fed from the result unchanged.
 *
 * Only the three fields the picker's own `CatalogModel` contract names are kept - `provider`, `id`,
 * `thinking` - so nothing Pi printed for a human, and nothing private, can reach a row.
 */

/** The header Pi prints above the table, used to find the columns rather than assuming their offsets. */
const HEADER = /^\s*provider\s+model\s/u;
/** Pi's honest answer when it has no providers configured. Not an error, and not something to invent past. */
const NONE = /^\s*No models available/u;

/**
 * Turn the printed table into the picker's `CatalogModel[]`.
 *
 * An empty answer is empty: a catalogue with nothing in it is a real state the operator needs to see, and
 * substituting a placeholder model would be a fabrication.
 *
 * @param {string} printed
 * @returns {{ provider: string, id: string, thinking: boolean }[]}
 */
export function parseModelCatalogue(printed) {
  const lines = String(printed ?? "").split("\n");
  // The only empty catalogue this accepts is the one Pi explicitly prints. Anything else that lacks a table is
  // output nobody here understands, and returning `[]` for it hid a broken or failed listing behind a state
  // that reads as "no models configured".
  if (lines.some((line) => NONE.test(line))) return [];
  const headerIndex = lines.findIndex((line) => HEADER.test(line));
  if (headerIndex === -1) {
    // Bounded and sanitized on purpose: the listing's own bytes may carry a path, a key or an account name, so
    // the refusal reports shape only - never the text.
    throw Object.assign(
      new Error(`could not read Pi's model catalogue: its output had no model table (${lines.length} line(s), ${String(printed ?? "").length} byte(s)). The output itself is not repeated here because it may carry private values.`),
      { code: "MODEL_CATALOG_UNREADABLE" },
    );
  }
  const columns = lines[headerIndex].trim().split(/\s+/u);
  const thinkingColumn = columns.indexOf("thinking");
  /** @type {{ provider: string, id: string, thinking: boolean }[]} */
  const models = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = line.trim().split(/\s+/u);
    if (cells.length < 2) continue;
    const [provider, id] = cells;
    if (provider === "" || id === "") continue;
    // A row Pi wrapped or decorated is skipped rather than guessed at.
    if (thinkingColumn !== -1 && cells.length <= thinkingColumn) continue;
    models.push({ provider, id, thinking: thinkingColumn === -1 ? false : cells[thinkingColumn] === "yes" });
  }
  return models;
}
