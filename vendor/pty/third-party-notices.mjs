#!/usr/bin/env node
// Build the third-party notices for the one native PTY artifact this package ships.
//
//   node vendor/pty/third-party-notices.mjs --cargo-tree <file> [--cargo-home <dir>] [--check]
//
// The artifact is a Rust `cdylib`: every crate that is not a proc macro is compiled into the bytes this
// repository ships, and so is the Rust standard library. Those are redistributions, and a redistribution
// needs the upstream licence text and copyright notice, not an SPDX string.
//
// Inputs are exactly four, all of them named here rather than searched for: the `cargo tree` the build
// recorded for this target, the committed `Cargo.lock`, the crate sources cargo extracted into its own
// registry cache while compiling, and `upstream-notices/` — the texts that had to be retrieved by hand from a
// crate's own VCS commit because the published crate contains none. Nothing is fetched here and no directory
// is walked recursively.
//
// `--check` regenerates in memory and fails if the committed files differ, which is what the test uses.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { ProvenanceError, parseArguments } from "../pi/provenance.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
/** Names a crate publishes its licence, notice or authorship text under. Nothing else is a licence file. */
const NOTICE_NAME = /^(?:licen[cs]e|copying|notice|authors)/iu;
/** The root of the printed tree: the patched upstream crate itself, which is not one of its own dependencies. */
const ROOT_CRATE = "replit_ruspty";
/** The upstream this artifact is built from, and what could and could not be established about its licence. */
const UPSTREAM = {
  package: "@replit/ruspty",
  version: "3.7.1",
  declaredLicense: "MIT",
  declaredIn: "package.json",
  noticeText: null,
  checkedSources: [
    "the pinned npm tarball itself (sha256 27618ba03da31e0e048e87266c2800a63c459c4795f6b31af833265192c3cc96): no LICENSE, COPYING, NOTICE or AUTHORS file at any depth",
    "Cargo.toml of the same tarball: no `license` or `license-file` key",
    "https://raw.githubusercontent.com/replit/ruspty/main/LICENSE: HTTP 404",
    "https://raw.githubusercontent.com/replit/ruspty/main/LICENSE.md: HTTP 404",
    "https://raw.githubusercontent.com/replit/ruspty/v3.7.1/LICENSE: HTTP 404",
    "https://api.github.com/repos/replit/ruspty/license: HTTP 404, \"Not Found\"",
  ],
};
/** What the toolchain contributes to the shipped bytes, and what it only links against at run time. */
const TOOLCHAIN = [
  {
    subject: "Rust standard library (rustc 1.94.0)",
    contribution: "compiled into the artifact: a Rust cdylib links its own std statically",
    declaredLicense: "Apache-2.0 OR MIT, with LLVM-exception for the parts derived from LLVM",
    noticeFiles: ["Apache-2.0.txt", "MIT.txt", "LLVM-exception.txt"],
  },
  {
    subject: "glibc, libgcc_s, libdl, libpthread, libutil and the dynamic loader",
    contribution: "dynamically linked at run time, not copied into the artifact, so not redistributed here",
    declaredLicense: "LGPL-2.1-or-later (glibc); GPL-3.0-or-later WITH GCC-exception-3.1 (libgcc_s)",
    noticeFiles: [],
  },
];

/** @param {string} text */
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Every crate in the recorded `cargo tree`, and whether its code reaches the shipped artifact.
 *
 * `cargo tree` prints every edge: a `(*)` line is an edge to a node whose subtree was already shown, not a
 * missing edge. So the printed lines are the whole graph, and a crate is compiled into the artifact exactly
 * when the root reaches it without going through a proc macro, whose code runs in the compiler instead.
 *
 * @param {string} tree
 */
function crateGraph(tree) {
  /** @type {Map<string, { name: string, version: string, procMacro: boolean, dependencies: Set<string> }>} */
  const nodes = new Map();
  /** @type {string[]} */
  const ancestry = [];
  for (const line of tree.split("\n")) {
    const match = /^(?<prefix>[\s│├└─]*?)(?<name>[A-Za-z0-9_-]+) v(?<version>[0-9][^\s]*)(?<rest>.*)$/u.exec(line);
    if (!match?.groups) continue;
    const depth = Math.round(match.groups.prefix.length / 4);
    const key = `${match.groups.name} ${match.groups.version}`;
    const node = nodes.get(key) ?? { name: match.groups.name, version: match.groups.version, procMacro: false, dependencies: new Set() };
    if (match.groups.rest.includes("(proc-macro)")) node.procMacro = true;
    nodes.set(key, node);
    ancestry[depth] = key;
    if (depth > 0) nodes.get(ancestry[depth - 1])?.dependencies.add(key);
  }

  const root = [...nodes.keys()].find((key) => key.startsWith(`${ROOT_CRATE} `));
  if (root === undefined) throw new ProvenanceError(`the cargo tree does not start at ${ROOT_CRATE}`);
  /** @type {Set<string>} */
  const compiledIn = new Set();
  const reach = (/** @type {string} */ key) => {
    const node = nodes.get(key);
    if (node === undefined || node.procMacro || compiledIn.has(key)) return;
    compiledIn.add(key);
    for (const dependency of node.dependencies) reach(dependency);
  };
  for (const dependency of nodes.get(root)?.dependencies ?? []) reach(dependency);

  return [...nodes.entries()]
    .filter(([key]) => key !== root)
    .map(([key, node]) => ({ name: node.name, version: node.version, role: compiledIn.has(key) ? "compiled into the artifact" : "ran in the compiler only" }))
    .sort((left, right) => `${left.name} ${left.version}`.localeCompare(`${right.name} ${right.version}`));
}

/** The licence texts and declared licence one extracted crate publishes.
 * @param {string} registrySource @param {{ name: string, version: string }} crate
 * @param {Map<string, { file: string, sha256: string, source: any }>} retrieved */
function crateNotices(registrySource, crate, retrieved) {
  const directory = path.join(registrySource, `${crate.name}-${crate.version}`);
  if (!existsSync(directory)) throw new ProvenanceError(`${crate.name} ${crate.version} is not in ${registrySource}; rerun the build that populates it`);
  const manifest = readFileSync(path.join(directory, "Cargo.toml"), "utf8");
  const declared = /^license\s*=\s*"(?<value>[^"]+)"/mu.exec(manifest)?.groups?.value ?? null;
  const licenseFile = /^license-file\s*=\s*"(?<value>[^"]+)"/mu.exec(manifest)?.groups?.value ?? null;
  const names = readdirSync(directory).filter((name) => NOTICE_NAME.test(name)).sort();
  if (licenseFile !== null && !names.includes(licenseFile)) names.push(licenseFile);
  const texts = names.map((name) => {
    const text = readFileSync(path.join(directory, name), "utf8");
    return { name, sha256: sha256(text), text, from: "the published crate" };
  });
  if (texts.length > 0) return { declaredLicense: declared, texts };

  // Nothing in the published crate. The text that governs it may still exist in the commit the crate was
  // published from, and `upstream-notices/retrieved.json` is where such a text is held, by digest.
  const record = retrieved.get(`${crate.name} ${crate.version}`);
  if (record === undefined) return { declaredLicense: declared, texts: [] };
  const text = readFileSync(path.join(HERE, "upstream-notices", record.file), "utf8");
  const digest = sha256(text);
  if (digest !== record.sha256) throw new ProvenanceError(`${record.file} is ${digest}, upstream-notices/retrieved.json says ${record.sha256}`);
  return {
    declaredLicense: declared,
    texts: [{ name: `upstream-notices/${record.file}`, sha256: digest, text, from: `${record.source.repository} at ${record.source.commit}, retrieved ${record.source.retrieved}` }],
  };
}

/** @param {{ cargoTree: string, cargoHome: string }} sources */
export function inventory({ cargoTree, cargoHome }) {
  const tree = readFileSync(cargoTree, "utf8");
  const registryRoot = path.join(cargoHome, "registry", "src");
  const indexes = readdirSync(registryRoot);
  if (indexes.length !== 1) throw new ProvenanceError(`${registryRoot} holds ${indexes.length} registry indexes, expected exactly one`);
  const registrySource = path.join(registryRoot, indexes[0]);

  const retrievedRecord = JSON.parse(readFileSync(path.join(HERE, "upstream-notices", "retrieved.json"), "utf8"));
  const retrieved = new Map(retrievedRecord.notices.map((/** @type {any} */ entry) => [`${entry.crate} ${entry.version}`, entry]));
  const crates = crateGraph(tree).map((crate) => ({ ...crate, ...crateNotices(registrySource, crate, retrieved) }));
  const toolchainLicenses = path.join(HERE, ".pixi", "envs", "default", "share", "doc", "rust", "licenses");
  const toolchain = TOOLCHAIN.map((entry) => ({
    ...entry,
    texts: entry.noticeFiles.map((name) => {
      const text = readFileSync(path.join(toolchainLicenses, name), "utf8");
      return { name: `rust/licenses/${name}`, sha256: sha256(text), text, from: "the pinned Rust toolchain" };
    }),
  }));

  return {
    schemaVersion: 1,
    description:
      "Third-party inventory for vendor/pty/pi-agents-owner-pty-linux-x64-gnu.node. Generated by vendor/pty/third-party-notices.mjs from the cargo tree the build recorded, the committed Cargo.lock and the crate sources cargo extracted while compiling. Not a legal clearance: it records what each upstream published and what it did not.",
    generatedFrom: {
      cargoTreeCommand: "cargo tree --locked --edges normal --target x86_64-unknown-linux-gnu",
      cargoTreeSha256: sha256(tree),
      cargoLockSha256: sha256(readFileSync(path.join(HERE, "Cargo.lock"), "utf8")),
      registrySource: path.relative(cargoHome, registrySource),
    },
    upstream: UPSTREAM,
    crates: crates.map(({ name, version, role, declaredLicense, texts }) => ({
      name,
      version,
      role,
      declaredLicense,
      noticeTexts: texts.map(({ name: file, sha256: digest, from }) => ({ name: file, sha256: digest, from })),
    })),
    toolchain: toolchain.map(({ subject, contribution, declaredLicense, texts }) => ({
      subject,
      contribution,
      declaredLicense,
      noticeTexts: texts.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
    })),
    gaps: [
      {
        subject: `${UPSTREAM.package}@${UPSTREAM.version}`,
        missing: "licence text and copyright notice for the MIT licence it declares",
        checkedSources: UPSTREAM.checkedSources,
        impact:
          "RELEASE BLOCKER for publishing this package or the artifact. MIT requires the copyright notice and permission text to accompany the distribution, and no authoritative text exists to reproduce; inventing a holder or a year would be a fabricated notice. A private, unpublished demo that only runs the artifact locally does not redistribute it and is not blocked by this.",
      },
      ...crates
        .filter((crate) => crate.texts.length === 0)
        .map((crate) => ({
          subject: `${crate.name} ${crate.version}`,
          missing: `licence text for the ${crate.declaredLicense ?? "undeclared"} licence it declares`,
          checkedSources: [
            `the published crate in ${path.relative(cargoHome, registrySource)}/${crate.name}-${crate.version}: no licence, notice or authors file`,
            "upstream-notices/retrieved.json: no text retrieved from the commit this crate was published from",
          ],
          impact: `RELEASE BLOCKER for publishing this package or the artifact, because this crate was ${crate.role}.`,
        })),
    ],
    crateTexts: crates.flatMap(({ name, version, texts }) => texts.map((text) => ({ owner: `${name} ${version}`, ...text }))),
    toolchainTexts: toolchain.flatMap(({ subject, texts }) => texts.map((text) => ({ owner: subject, ...text }))),
  };
}

/** @param {ReturnType<typeof inventory>} record */
function notices(record) {
  const byDigest = new Map();
  for (const text of [...record.crateTexts, ...record.toolchainTexts]) {
    const entry = byDigest.get(text.sha256) ?? { sha256: text.sha256, text: text.text, owners: [], names: new Set(), from: new Set() };
    entry.owners.push(text.owner);
    entry.names.add(text.name);
    entry.from.add(text.from);
    byDigest.set(text.sha256, entry);
  }
  const appendix = [...byDigest.values()];
  const reference = (/** @type {{ sha256: string }[]} */ texts) =>
    texts.length === 0 ? "**none published**" : texts.map(({ sha256: digest }) => `[text ${appendix.findIndex((entry) => entry.sha256 === digest) + 1}](#text-${appendix.findIndex((entry) => entry.sha256 === digest) + 1})`).join(", ");

  const lines = [
    "# Third-party notices: the native pseudo-terminal artifact",
    "",
    "`vendor/pty/pi-agents-owner-pty-linux-x64-gnu.node` is a Rust `cdylib`. Every crate below that is marked",
    "*compiled into the artifact* is part of the bytes this repository ships, and so is the Rust standard",
    "library. This file is the inventory of those upstreams and the licence texts they publish.",
    "",
    "**Generated, not written.** `node vendor/pty/third-party-notices.mjs --cargo-tree <file>` regenerates this",
    "file and `third-party-inventory.json` from three named inputs: the `cargo tree` the build recorded",
    `(\`${record.generatedFrom.cargoTreeCommand}\`, sha256 \`${record.generatedFrom.cargoTreeSha256}\`), the committed`,
    `\`Cargo.lock\` (sha256 \`${record.generatedFrom.cargoLockSha256}\`), and the crate sources cargo extracted into`,
    `\`${record.generatedFrom.registrySource}\` while compiling. It records what each upstream published. It is not a legal`,
    "clearance, and an SPDX string is not one either.",
    "",
    "## Release blocker",
    "",
  ];
  for (const gap of record.gaps) {
    lines.push(`**${gap.subject}: ${gap.missing} could not be obtained.**`, "", `${gap.impact}`, "", "Sources checked:", "");
    for (const source of gap.checkedSources) lines.push(`- ${source}`);
    lines.push("");
  }
  lines.push(
    `The artifact is built from ${record.upstream.package}@${record.upstream.version}, which declares`,
    `\`${record.upstream.declaredLicense}\` in its \`${record.upstream.declaredIn}\` and publishes no licence file.`,
    "`upstream-lock.json` records the same pin and the same absence.",
    "",
    "## Crates",
    "",
    "| Crate | Version | Reaches the artifact | Declared | Notice text |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const crate of record.crates) {
    lines.push(`| ${crate.name} | ${crate.version} | ${crate.role} | ${crate.declaredLicense ?? "none declared"} | ${reference(crate.noticeTexts)} |`);
  }
  lines.push("", "## Toolchain and runtime", "", "| Subject | Contribution | Declared | Notice text |", "| --- | --- | --- | --- |");
  for (const entry of record.toolchain) {
    lines.push(`| ${entry.subject} | ${entry.contribution} | ${entry.declaredLicense} | ${reference(entry.noticeTexts)} |`);
  }
  lines.push("", "## Verbatim texts", "");
  appendix.forEach((entry, index) => {
    lines.push(
      `### Text ${index + 1}`,
      "",
      `Published as \`${[...entry.names].sort().join("`, `")}\` by: ${entry.owners.sort().join(", ")}.`,
      "",
      `Taken from ${[...entry.from].sort().join(" and ")}. sha256 \`${entry.sha256}\``,
      "",
      "```",
      entry.text.replace(/```/gu, "'''").trimEnd(),
      "```",
      "",
    );
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

/** @param {{ cargoTree: string, cargoHome?: string }} options */
export function generate({ cargoTree, cargoHome = process.env.CARGO_HOME ?? path.join(process.env.HOME ?? "", ".cargo") }) {
  const record = inventory({ cargoTree, cargoHome });
  const { crateTexts, toolchainTexts, ...published } = record;
  return {
    "third-party-inventory.json": `${JSON.stringify(published, null, 2)}\n`,
    "THIRD-PARTY-NOTICES.md": notices(record),
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const options = parseArguments(process.argv.slice(2), { flags: ["cargo-tree", "cargo-home"], booleans: ["check"] });
  const generated = generate({ cargoTree: options["cargo-tree"], cargoHome: options["cargo-home"] });
  for (const [name, content] of Object.entries(generated)) {
    const file = path.join(HERE, name);
    if (options.check) {
      if (readFileSync(file, "utf8") !== content) throw new ProvenanceError(`${name} is not what these inputs generate`);
    } else {
      writeFileSync(file, content);
    }
  }
  process.stdout.write(`${options.check ? "checked" : "wrote"} ${Object.keys(generated).join(", ")}\n`);
}
