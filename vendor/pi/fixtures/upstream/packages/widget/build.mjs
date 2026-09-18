// Stands in for a real workspace build: reads src, writes dist, exits nonzero on nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync(new URL("dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("dist/index.mjs", import.meta.url), readFileSync(new URL("src/index.mjs", import.meta.url)));
