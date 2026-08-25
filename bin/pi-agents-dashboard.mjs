#!/usr/bin/env node

const cliEntryPoint = new URL("../cli/main.mjs", import.meta.url);
await import(cliEntryPoint.href);
