#!/usr/bin/env -S deno run --allow-all
// ─────────────────────────────────────────────────────────────
// testla-cli · main.ts
// Entry point
// ─────────────────────────────────────────────────────────────

import { buildCLI } from './src/cli/index.ts';

await buildCLI().parse(Deno.args);