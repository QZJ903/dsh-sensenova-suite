#!/usr/bin/env node
/**
 * The CLI entry for `dsh-sensenova-suite`'s doctor
 * (docs/PITFALLS.md §22: "is the provider on or off on this machine?" had
 * exactly one answer, in a JSON file no config and no route would report).
 *
 * Run: `node tools/doctor.mjs` (human lines) or `node tools/doctor.mjs --json`
 * (machine-readable). It reads only the plugin's own state files under
 * `$DSH_HOME` (or `~/.dsh`), never a platform endpoint, and never writes.
 */
import { main } from "../src/host/doctor.ts";

await main();
