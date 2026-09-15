import { ScrollView, VStack } from "@earendil-works/pi-tui";

/** Adapt a width-to-lines function to Pi's component interface. */
export class LinesComponent {
  /** @param {(width: number) => string[]} render */
  constructor(render) { this.renderLines = render; }
  /** @param {number} width */
  render(width) { return this.renderLines(width); }
  invalidate() {}
}

/**
 * Pi's own fullscreen composition, with this viewer's sections in it.
 *
 * One primary `ScrollView` owns the transcript, so Pi owns the viewport, the follow state, the keys
 * and wheel that move them, selection, hyperlinks and search. Header and dock sit outside it and
 * never scroll. The dock's sizes mirror Pi's interactive mode: every section may shrink, and the
 * editor keeps three rows, so decoration goes before the prompt does.
 *
 * @param {{ header: any, document: any, notices: any, status: any, editor: any, footer: any }} sections
 */
export function createViewerLayout({ header, document, notices, status, editor, footer }) {
  const viewport = new ScrollView(document, { follow: "end", primary: true, overscroll: "chain" });
  const dock = new VStack([
    { component: notices, shrink: 1, minSize: 0 },
    { component: status, shrink: 1, minSize: 0 },
    { component: editor, shrink: 1, minSize: 3 },
    { component: footer, shrink: 1, minSize: 1 },
  ]);
  const root = new VStack([
    // The header names the session every keystroke goes to, so it is the one row that never shrinks.
    { component: header, basis: "auto", grow: 0, shrink: 0 },
    { component: viewport, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  return { root, viewport };
}
