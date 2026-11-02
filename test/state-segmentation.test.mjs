/**
 * PITFALLS §23 gate: which state is partitioned by Host profile, and which is
 * deliberately shared.
 *
 * The rule (docs/PITFALLS.md §23): the three *switch-shaped* states — catalog,
 * provider switch, draw switch — and the Raccoon opt-in switch are per-profile
 * (`$DSH_HOME/state/<profile>/<name>/`), derived from `profileContext.name`; a
 * `null` profile degrades to today's single shared directory. Two states are
 * intentionally NOT partitioned: the throttle (cross-profile so the same key
 * cannot brute-force two profiles) and the credentials grant (it lives in the
 * DSH credentials service, which is the wrong place to partition — and the
 * wrong abstraction to read from a profile directory).
 *
 * This gate freezes that shape so a later refactor cannot "helpfully unify"
 * them (the §23 note literally warns against it). It reads the four store
 * files, `index.ts`, `state-store.ts` and `doctor.ts` as text — no peer, no
 * build, no network — so it runs on a clean checkout.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { results, check } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(here, "..", "src", "host", name), "utf8");

const stateStore = src("state-store.ts");
const catalogStore = src("catalog-store.ts");
const providerStore = src("provider-store.ts");
const switchStore = src("switch-store.ts");
const throttleStore = src("throttle-store.ts");
const indexTs = src("index.ts");
const doctorTs = src("doctor.ts");


// --- 1. the primitive: profileStateDir falls back to the SHARED dir on null --
// `null` profile must mean "today's single shared directory", never a broken
// path. This is the zero-drift invariant the whole partition rests on (the
// comment in index.ts: "null … degrades to today's single shared directory —
// behaviour unchanged").
{
  const fallback = /profile\s*\?\s*join\(\s*dshHome\(\)\s*,\s*"state"\s*,\s*profile\s*,\s*name\s*\)\s*:\s*stateDir\(name\)/.test(
    stateStore,
  );
  check("profileStateDir(name, null) falls back to the shared stateDir", fallback,
    fallback ? "" : "profileStateDir body does not degrade to stateDir(name) on null");

  // The segment validator matches the Host's OWN profile-name validation
  // (dsh-app-boot resolveProfileDir: "", "/", "\\", ".", "..", "node_modules")
  // plus the 64-char cap — banning more than that used to silently drop
  // Host-legal non-ASCII (CJK) profiles back into the shared directory
  // (2026-10-31 audit, U7-S1). Control characters stay banned beyond the Host:
  // no legitimate name carries them. Either way, every traversal shape a
  // single path segment can carry must stay banned — that is the invariant.
  check("isProfileSegment bans every traversal shape a segment can carry",
    stateStore.includes('name.includes("/")') &&
      stateStore.includes('name.includes("\\\\")') &&
      stateStore.includes('"node_modules"') &&
      stateStore.includes("PROFILE_SEGMENT_CONTROL_RE") &&
      stateStore.includes("PROFILE_SEGMENT_MAX = 64"),
    "state-store.ts lost part of the profile-segment blacklist");

  // Primary read path is the optional-service lookup (which itself calls
  // ctx.get("profileContext") — see readOptionalService). Reading the
  // DSH_PROFILE env var would treat an *output* as an *input* and break the
  // shared default; it must only appear in prose, never as an env read.
  check("profileSegment reads the profileContext service",
    stateStore.includes('readOptionalService(ctx, "profileContext")'),
    "profileSegment does not read the profileContext service");
  check("profileSegment never reads the DSH_PROFILE env var",
    !/process\.env\.DSH_PROFILE/.test(stateStore) && !/Deno\.env/.test(stateStore),
    "state-store.ts reads DSH_PROFILE from the environment — env must not be an input");
}

// --- 2. the switch-shaped states ARE partitioned ---------------------------
for (const [file, text] of [
  ["catalog-store.ts", catalogStore],
  ["provider-store.ts", providerStore],
]) {
  check(`${file} writes under the profile partition`,
    /profileStateDir\(\s*name\s*,\s*profile\s*\)/.test(text),
    `${file} does not call profileStateDir(name, profile)`);
}
// Switch-shaped stores ride `createSwitchStore`, whose `stateDir` IS
// `profileStateDir(name, profile)` (switch-store.ts). Guard the scaffold.
check("switch-store.ts partitions under the profile (the shared scaffold)",
  /profileStateDir\(\s*name\s*,\s*profile\s*\)/.test(switchStore),
  "switch-store.ts does not call profileStateDir(name, profile)");

// --- 3. the throttle is deliberately shared (no profile argument) -----------
{
  check("throttle-store.ts does NOT import profileStateDir",
    !/profileStateDir/.test(throttleStore),
    "throttle-store.ts references profileStateDir — it must stay shared");
  // Its directory call takes exactly one argument (the name), no profile.
  check("throttle-store.ts writes under the shared state dir only",
    /return\s+\w*(?:StateDir|Dir)\(\s*name\s*\)/.test(throttleStore),
    "throttle-store.ts directory call is not `…Dir(name)`");
  // The §23 marker survives: the file documents the deliberate non-partition.
  check("throttle-store.ts documents its deliberate non-partition (PITFALLS §23)",
    /PITFALLS\s*§?23/i.test(throttleStore),
    "throttle-store.ts lost its PITFALLS §23 note");
}

// --- 4. index.ts wires profile into exactly the two, not the throttle ------
{
  check("index.ts computes the profile once",
    /profileSegment\(\s*ctx\s*\)/.test(indexTs),
    "index.ts never calls profileSegment(ctx)");
  for (const factory of [
    "createFileCatalogStore",
    "createFileProviderStore",
  ]) {
    // Construction keeps `profile` as the object's first key, and may carry a
    // sibling (ADR-006 added `logger` so a version-refusal is visible in the
    // log). The invariant under test is that profile REACHES the factory at
    // all; the regex still goes red the moment it is dropped, renamed, or
    // threaded through some other mechanism.
    check(`${factory} is constructed with { profile }`,
      new RegExp(`${factory}\\((\\s*|[\\s\\S]*?)\\{\\s*profile\\s*(?:,|\\})`).test(indexTs),
      `${factory} is not called with { profile }`);
  }
  // The throttle factory's call carries NO profile — the throttle is SHARED on
  // purpose, and a profile would partition it (see the module note in
  // throttle-store.ts). A sibling argument is allowed and expected: ADR-006
  // added `logger` to the other stores so a version-refusal is visible in the
  // log, and the throttle now takes it too — a refused throttle write used to
  // be computed and thrown away, which is the one failure the other five
  // stores never had. The invariant under test is the PARTITION, not the
  // argument count: this goes red the moment a profile is threaded in.
  check("createFileThrottleStore() takes no profile argument",
    !/createFileThrottleStore\([^)]*profile/.test(indexTs),
    "createFileThrottleStore is called with a profile — it must stay shared");
}

// --- 5. (removed 2026-11-03) the credential-store partitioning pin — the
// primary-key store (and with it this pin's subject) was dismantled; the
// console token store keeps its own coverage above.

// --- 6. doctor reads only (no state writes it could leak) -------------------
check("doctor.ts only reads state, never writes it",
  !/(writeStateFile|ensureStateDir|temporaryOf)/.test(doctorTs),
  "doctor.ts writes state files — it must be read-only diagnostic surfacing");

// --- report ----------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log(`[state-segmentation] ${results.length - failed.length}/${results.length} checks passed`);
for (const r of results) {
  if (!r.pass) console.log(`  FAIL ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
if (failed.length > 0) {
  console.log(JSON.stringify({ name: "state-segmentation", pass: false, failed: failed.length }));
  process.exit(1);
}
console.log(JSON.stringify({ name: "state-segmentation", pass: true, checked: results.length }));
