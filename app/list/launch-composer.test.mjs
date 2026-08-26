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
    it("defaults to a worktree and emits the exact LaunchRequest without piConfigRoot", () => {
        const draft = createLaunchDraft(defaults);
        const result = prepareLaunchRequest({ ...draft, prompt: "Implement it" }, worktree);
        expect(result).toEqual({
            kind: "ready",
            request: {
                prompt: "Implement it",
                cwd: "/repo",
                sourceSessionId: "source-session",
                isolation: { mode: "worktree" },
                model: defaults.model,
                thinkingLevel: "high",
                name: "dashboard task",
            },
        });
        expect(result.kind === "ready" && Object.hasOwn(result.request, "piConfigRoot")).toBe(false);
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
                thinkingLevel: "high",
                name: "dashboard task",
            },
        });
    });
    it.each([
        ["model provider", { model: { provider: "", id: "claude" } }],
        ["model id", { model: { provider: "anthropic", id: "" } }],
    ])("rejects an incomplete %s field", (_name, override) => {
        const draft = { ...createLaunchDraft(defaults), ...override, prompt: "Implement it" };
        expect(() => prepareLaunchRequest(draft, worktree)).toThrow();
    });
    it("omits model, thinking level, and display name until selected", () => {
        const draft = { ...createLaunchDraft({ cwd: "/repo" }), prompt: "Implement it" };
        expect(prepareLaunchRequest(draft, worktree)).toEqual({
            kind: "ready",
            request: { prompt: "Implement it", cwd: "/repo", sourceSessionId: "source-session", isolation: { mode: "worktree" } },
        });
    });
    it("represents DELIVERY_UNKNOWN with retry-at-risk and abandon actions without automatic retry", () => {
        const state = reduceLaunchComposer({ focus: "composer", draft: { ...createLaunchDraft(defaults), prompt: "Implement it" } }, { type: "deliveryUnknown", clientId: "stable-client", requestId: "launch-1" });
        expect(state).toMatchObject({
            focus: "list",
            deliveryUnknown: {
                clientId: "stable-client",
                requestId: "launch-1",
                actions: ["retry_at_risk", "abandon"],
            },
        });
        expect(state.launch).toBeUndefined();
    });
});
