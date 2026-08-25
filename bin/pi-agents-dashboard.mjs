#!/usr/bin/env node

import { initializeRuntimePermissions } from "../runtime/permissions.mjs";

initializeRuntimePermissions();

const cliEntryPoint = new URL("../cli/main.mjs", import.meta.url);
await import(cliEntryPoint.href);
