const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Clamp a string offset to the start of its containing grapheme. */
export function normalizePromptCursor(text, cursor) {
    const target = Math.max(0, Math.min(Number.isSafeInteger(cursor) ? cursor : text.length, text.length));
    let boundary = 0;
    for (const part of GRAPHEME_SEGMENTER.segment(text)) {
        if (part.index > target)
            break;
        const end = part.index + part.segment.length;
        if (target < end)
            return part.index;
        boundary = end;
    }
    return boundary;
}

/** Move a prompt cursor one displayed character in the direction indicated by `delta`. */
export function movePromptCursor(text, cursor, delta) {
    const current = normalizePromptCursor(text, cursor);
    if (delta < 0) {
        let previous = 0;
        for (const part of GRAPHEME_SEGMENTER.segment(text)) {
            const end = part.index + part.segment.length;
            if (end >= current)
                return part.index;
            previous = end;
        }
        return previous;
    }
    if (delta > 0) {
        for (const part of GRAPHEME_SEGMENTER.segment(text)) {
            const end = part.index + part.segment.length;
            if (end > current)
                return end;
        }
    }
    return current;
}

/** Delete the displayed character immediately before a prompt cursor. */
export function deleteBeforePromptCursor(text, cursor) {
    const current = normalizePromptCursor(text, cursor);
    const previous = movePromptCursor(text, current, -1);
    if (previous === current)
        return { text, cursor: current };
    return { text: `${text.slice(0, previous)}${text.slice(current)}`, cursor: previous };
}

/** Decorate the displayed character under a prompt cursor, or one trailing space at the end. */
export function markPromptCursor(text, cursor, mark) {
    const current = normalizePromptCursor(text, cursor);
    const next = movePromptCursor(text, current, 1);
    const underCursor = current === text.length ? " " : text.slice(current, next);
    return `${text.slice(0, current)}${mark(underCursor)}${text.slice(next)}`;
}
