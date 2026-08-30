import { describe, expect, it } from "vitest";
import { createLaunchDraft, prepareLaunchRequest, reduceLaunchComposer, } from "./launch-composer.mjs";
const defaults = {
    cwd: "/repo",
    sourceSessionId: "source-session",
    model: { provider: "anthropic", id: "claude" },
    thinkingLevel: "high",
    name: "dashboard task",
};
const worktree = {
    canonicalCwd: "/repo",
    isolationMode: "worktree",
    ownerSessionIds: [],
};
const shared = {
    canonicalCwd: "/canonical/repo",
    isolationMode: "shared_directory",
    ownerSessionIds: ["other"],
};
describe("launch composer", () => {
    it.each([
        ["every default selected", defaults, {
            prompt: "Implement it",
            cwd: "/repo",
            sourceSessionId: "source-session",
            isolation: { mode: "worktree" },
            model: defaults.model,
            name: "dashboard task",
        }],
    ])("defaults to a worktree and emits the exact LaunchRequest with %s", (_label, draftDefaults, request) => {
        const result = prepareLaunchRequest({ ...createLaunchDraft(draftDefaults), prompt: "Implement it" }, worktree);
        expect(result).toEqual({ kind: "ready", request });
        expect(Object.hasOwn(result.request, "piConfigRoot")).toBe(false);
    });
    it("selects no thinking level, even from a draft a previous release persisted", () => {
        expect(Object.hasOwn(createLaunchDraft(defaults), "thinkingLevel")).toBe(false);
        const stale = { ...createLaunchDraft(defaults), thinkingLevel: "high", prompt: "Implement it" };
        const result = prepareLaunchRequest(stale, worktree);
        expect(Object.hasOwn(result.request, "thinkingLevel")).toBe(false);
    });
    it("does not launch blank input and preserves a draft when Ctrl+C returns list focus", () => {
        let state = reduceLaunchComposer({ focus: "composer", draft: createLaunchDraft(defaults) }, { type: "changed", prompt: "  " });
        expect(reduceLaunchComposer(state, { type: "submit", preflight: worktree })).toMatchObject({ launch: undefined });
        state = reduceLaunchComposer(state, { type: "changed", prompt: "keep this" });
        const cancelled = reduceLaunchComposer(state, { type: "cancel" });
        expect(cancelled).toMatchObject({ focus: "list", draft: { prompt: "keep this" } });
    });
    it("requires the exact canonical cwd for shared-directory confirmation", () => {
        const draft = { ...createLaunchDraft(defaults), prompt: "Implement it", isolationMode: "shared_directory" };
        expect(prepareLaunchRequest(draft, shared)).toMatchObject({ kind: "confirmation_required", canonicalCwd: "/canonical/repo" });
        expect(prepareLaunchRequest(draft, shared, "/repo")).toMatchObject({ kind: "confirmation_mismatch" });
        expect(prepareLaunchRequest(draft, shared, "/canonical/repo")).toEqual({
            kind: "ready",
            request: {
                prompt: "Implement it",
                cwd: "/canonical/repo",
                sourceSessionId: "source-session",
                isolation: { mode: "shared_directory", confirmedCwd: "/canonical/repo", ownerSessionIds: ["other"] },
                model: defaults.model,
                name: "dashboard task",
            },
        });
    });
});
