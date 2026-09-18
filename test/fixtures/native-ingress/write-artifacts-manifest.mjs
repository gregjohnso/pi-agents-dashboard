#!/usr/bin/env node
/**
 * Write the artifacts manifest the native-ingress cases drive, from one build's own outputs.
 *
 * The manifest names a built cohort by absolute path, so it is generated per build and never committed: a
 * committed copy would point a later run at a stale install. Everything in it is derived from that build's
 * `build-manifest.json` and the consumer directory the tarballs were installed into, so a manifest can only
 * describe a cohort that actually exists on this machine.
 *
 *   node test/fixtures/native-ingress/write-artifacts-manifest.mjs \
 *     --artifacts <build artifacts directory> --consumer <consumer root> --output <manifest path>
 *
 * The installed package roots are resolved and checked here rather than in a test, so a manifest that names
 * a missing install fails at the moment it is written.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const REQUIRED = ["artifacts", "consumer", "output"];

function parseArguments(argv) {
	const parsed = {};
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`);
		const name = token.slice(2);
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
		parsed[name] = value;
		index += 1;
	}
	for (const name of REQUIRED) {
		if (!parsed[name]) throw new Error(`--${name} is required`);
	}
	return parsed;
}

/** The installed package root inside a consumer, hoisted or nested under coding-agent. */
function installedPackageRoot(consumer, packageName) {
	const candidates = [
		path.join(consumer, "node_modules", packageName),
		path.join(consumer, "node_modules/@earendil-works/pi-coding-agent/node_modules", packageName),
	];
	const found = candidates.find((candidate) => existsSync(path.join(candidate, "package.json")));
	if (!found) throw new Error(`${packageName} is not installed under ${consumer}`);
	return found;
}

export function artifactsManifest({ artifacts, consumer }) {
	const build = JSON.parse(readFileSync(path.join(artifacts, "build-manifest.json"), "utf8"));
	const tuiPackageRoot = installedPackageRoot(consumer, "@earendil-works/pi-tui");
	const codingAgentRoot = installedPackageRoot(consumer, "@earendil-works/pi-coding-agent");
	const bundledCliPath = path.join(codingAgentRoot, build.bundledCli.bin);
	if (!existsSync(bundledCliPath)) throw new Error(`the installed cohort has no bundled CLI at ${bundledCliPath}`);
	const tuiVersion = JSON.parse(readFileSync(path.join(tuiPackageRoot, "package.json"), "utf8")).version;
	return {
		mode: build.baseline ? "baseline" : "patched",
		reason: build.artifactLabel,
		series: build.series?.names ?? [],
		appliedPatches: build.applied ?? [],
		patchedTreeHash: build.preparedState?.patchedTreeHash ?? null,
		upstreamCommit: build.resolved?.commit ?? null,
		artifactDigests: Object.fromEntries(
			build.artifactFiles.map((entry) => [path.basename(entry.file), entry.sha256]),
		),
		bundledCliSha256: build.bundledCli.sha256,
		bundledCliPath,
		consumerRoot: path.resolve(consumer),
		artifactsRoot: path.resolve(artifacts),
		tuiPackageRoot,
		tuiVersion,
		buildSlurmJobId: build.slurmJobId ?? null,
		recordedAt: new Date().toISOString(),
	};
}

function main(argv) {
	const parsed = parseArguments(argv);
	const manifest = artifactsManifest({
		artifacts: path.resolve(parsed.artifacts),
		consumer: path.resolve(parsed.consumer),
	});
	const output = path.resolve(parsed.output);
	mkdirSync(path.dirname(output), { recursive: true });
	writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
	process.stdout.write(`wrote ${output} for the ${manifest.mode} cohort at ${manifest.consumerRoot}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`write-artifacts-manifest failed: ${error?.message ?? error}\n`);
		process.exit(1);
	}
}
