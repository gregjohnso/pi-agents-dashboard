import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyCwdCompletion, cwdArgument, suggestDirectories } from "./path-completion.mjs";

/** @type {string} */
let root;
const labels = (suggestions) => suggestions?.items.map((item) => item.label);

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-agents-completion-"));
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, "alpha", "nested"));
    await mkdir(join(root, "alpine"));
    await writeFile(join(root, "alpha.txt"), "", { mode: 0o600 });
    await symlink(join(root, "alpha"), join(root, "linked"));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("cwd directory completion", () => {
    it("completes only a /cwd line, and only the path part of it", () => {
        expect(cwdArgument("/cwd ~/pro")).toBe("~/pro");
        expect(cwdArgument("/cwd ")).toBe("");
        expect(cwdArgument(" /cwd al")).toBe("al");
        for (const line of ["", "/cwd", "/cwdx a", "/model claude", "ship it"])
            expect(cwdArgument(line)).toBeUndefined();
    });
    it("offers directories and never files, so no offered choice can be refused by /cwd", async () => {
        const signal = new AbortController().signal;
        expect(labels(await suggestDirectories("", root, signal))).toEqual(["alpha/", "alpine/", "linked/"]);
        expect(labels(await suggestDirectories("alp", root, signal))).toEqual(["alpha/", "alpine/"]);
        // A relative path resolves against the draft's own directory, the way a shell would.
        expect(labels(await suggestDirectories("alpha/", root, signal))).toEqual(["nested/"]);
        expect(labels(await suggestDirectories(`${root}/alp`, "/nowhere", signal))).toEqual(["alpha/", "alpine/"]);
    });
    it("says nothing rather than throwing when the typed path cannot be listed", async () => {
        const signal = new AbortController().signal;
        for (const argument of ["missing/", "alpha.tx", `${root}/missing/`])
            expect(await suggestDirectories(argument, root, signal)).toBeUndefined();
    });
    it("expands a leading tilde for the listing and keeps it in the completed line", async () => {
        const signal = new AbortController().signal;
        const realHome = process.env.HOME;
        process.env.HOME = root;
        try {
            const suggestions = await suggestDirectories("~/alp", "/nowhere", signal);
            expect(labels(suggestions)).toEqual(["alpha/", "alpine/"]);
            // The tilde survives completion; /cwd expands it when the operator submits the line.
            expect(applyCwdCompletion("/cwd ~/alp", suggestions.items[0], suggestions.prefix, "/nowhere")).toBe("/cwd ~/alpha/");
        }
        finally {
            process.env.HOME = realHome;
        }
    });
    it("rewrites the /cwd line with the chosen directory and a trailing separator to descend through", async () => {
        const signal = new AbortController().signal;
        const suggestions = await suggestDirectories("alp", root, signal);
        // Completing the argument alone must not be mistaken for completing the command name.
        expect(applyCwdCompletion("/cwd alp", suggestions.items[0], suggestions.prefix, root)).toBe("/cwd alpha/");
        const absolute = await suggestDirectories(`${root}/alp`, root, signal);
        expect(applyCwdCompletion(`/cwd ${root}/alp`, absolute.items[0], absolute.prefix, root)).toBe(`/cwd ${root}/alpha/`);
    });
    // Canary: pi-tui 0.84.3 exports the completion provider from its package root. When this fails,
    // the installed pi-tui moved or renamed it and this module must follow rather than grow its own.
    it("still finds pi-tui's file-completion provider on the package root", () => {
        expect(typeof CombinedAutocompleteProvider).toBe("function");
        const provider = new CombinedAutocompleteProvider([], root);
        expect(typeof provider.getSuggestions).toBe("function");
        expect(typeof provider.applyCompletion).toBe("function");
    });
});
