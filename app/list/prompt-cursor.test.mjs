import { describe, expect, it } from "vitest";

import { deleteBeforePromptCursor, markPromptCursor, movePromptCursor, normalizePromptCursor, } from "./prompt-cursor.mjs";

const EMOJI = "👩🏽‍💻";

describe("prompt cursor", () => {
    it("moves and deletes by grapheme boundaries", () => {
        const text = `A${EMOJI}B`;
        const beforeB = movePromptCursor(text, text.length, -1);
        const beforeEmoji = movePromptCursor(text, beforeB, -1);

        expect(beforeB).toBe(1 + EMOJI.length);
        expect(beforeEmoji).toBe(1);
        expect(normalizePromptCursor(text, 3)).toBe(1);
        expect(deleteBeforePromptCursor(text, beforeB)).toEqual({ text: "AB", cursor: 1 });
    });

    it("stays at prompt boundaries without deleting text", () => {
        expect(movePromptCursor("abc", 0, -1)).toBe(0);
        expect(movePromptCursor("abc", 3, 1)).toBe(3);
        expect(deleteBeforePromptCursor("abc", 0)).toEqual({ text: "abc", cursor: 0 });
    });

    it("marks one grapheme or a trailing cursor cell", () => {
        expect(markPromptCursor(`A${EMOJI}B`, 1, (value) => `[${value}]`)).toBe(`A[${EMOJI}]B`);
        expect(markPromptCursor("abc", 3, (value) => `[${value}]`)).toBe("abc[ ]");
    });
});
