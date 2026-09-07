/**
 * The name a session gets from its first prompt, until Pi names it.
 *
 * This lives apart from `launch-resolver.mjs` because the list needs it to label a launching row,
 * and that module imports Pi's `SessionManager`: importing Pi's package costs seconds the list would
 * pay before drawing anything.
 *
 * @param {string} prompt
 */
export function sessionNameFromPrompt(prompt) {
  const firstLine = prompt.split(/\r?\n/u).map((line) => line.replace(/\s+/gu, " ").trim()).find((line) => line.length > 0);
  if (firstLine === undefined) return undefined;
  if (firstLine.length <= 48) return firstLine;
  const clipped = firstLine.slice(0, 48);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace >= 24 ? clipped.slice(0, lastSpace) : clipped).trim();
}
