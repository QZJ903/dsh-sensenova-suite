/**
 * Peer-free checks for the 429 self-healing work:
 *
 * - `llm-retry.js`: `QUOTA_CODES` / `retryableCodes` (which failure classes
 *   this shared-pool provider retries). The full policy config (maxRetries,
 *   backoff) is assembled inline at `adapter.ts` `providerRetryPolicy` — the
 *   former `buildRetryPolicyConfig` had no production reader and had drifted
 *   from that call site, so it was removed (2026-10-31).
 * - `llm-models.js`: `exhaustedModelIds` (pool -> blocked model set) and
 *   `rosterWithAvailability` (the panel's self-identifying roster; the
 *   picker-offer exclusion the removed `buildDescriptors` pinned lives in the
 *   adapter's `catalogFilter` seam and the snapshot's `offered` counts).
 *
 * Nothing here imports a Host peer, so the policy decisions stay covered on a
 * clean checkout. The peer-resolved integration (resolveRetryPolicy against
 * the real config) is covered by `test/e2e.mjs` on a real runtime.
 */
import {
  retryableCodes,
  QUOTA_CODES,
  ANTHROPIC_TRUNCATED_CODE
} from "../src/host/llm-retry.ts";
import {
  exhaustedModelIds,
  drainedPoolsWithoutModels,
  rosterWithAvailability,
  supportedThinkingLevels
} from "../src/host/llm-models.ts";
import { results, check, fail } from "./harness.mjs";

const BASE_URL = "https://token.sensenova.cn/v1";

// --- 1. QUOTA_CODES spellings match the peer protocol ----------------------
{
  try {
    check("QUOTA_CODES.quota === 'QUOTA'", QUOTA_CODES.quota === "QUOTA");
    check("QUOTA_CODES.accountQuota === 'ACCOUNT_QUOTA'", QUOTA_CODES.accountQuota === "ACCOUNT_QUOTA");
    check("retryableCodes() returns the canonical set (no quota)",
      JSON.stringify(retryableCodes()) ===
      JSON.stringify([
        QUOTA_CODES.emptyResponse,
        QUOTA_CODES.rateLimit,
        QUOTA_CODES.server,
        QUOTA_CODES.timeout,
        QUOTA_CODES.transport,
        ANTHROPIC_TRUNCATED_CODE
      ]));
  } catch (error) {
    fail("QUOTA_CODES spellings", error);
  }
}

// --- 2. exhaustedModelIds: pool -> blocked model set -----------------------
{
  try {
    const pools = {
      pools: [
        // Pool A: 5h window exhausted -> its models are blocked.
        {
          id: "a", modelIds: ["m1", "m2"],
          window5h: { limit: 100, remaining: 0, resetAt: 1 },
          window7d: { limit: 500, remaining: 400, resetAt: 2 }
        },
        // Pool B: limit unknown (0) with remaining 0 -> NOT exhausted (shape drift guard).
        {
          id: "b", modelIds: ["m3"],
          window5h: { limit: 0, remaining: 0, resetAt: null },
          window7d: { limit: 0, remaining: 0, resetAt: null }
        },
        // Pool C: still has credit -> NOT exhausted.
        {
          id: "c", modelIds: ["m4"],
          window5h: { limit: 50, remaining: 10, resetAt: 3 },
          window7d: { limit: 200, remaining: 100, resetAt: 4 }
        },
        // Pool D: 7d window exhausted (5h still has credit) -> blocked.
        {
          id: "d", modelIds: ["m5"],
          window5h: { limit: 50, remaining: 30, resetAt: 5 },
          window7d: { limit: 200, remaining: 0, resetAt: 6 }
        }
      ]
    };
    const blocked = exhaustedModelIds(pools);
    check("exhaustedModelIds catches both the 5h-exhausted and 7d-exhausted pools",
      JSON.stringify(blocked) === JSON.stringify(["m1", "m2", "m5"]), JSON.stringify(blocked));

    check("a pools object without a pools array yields nothing",
      exhaustedModelIds({}).length === 0);
    check("an undefined pools value yields nothing",
      exhaustedModelIds(undefined).length === 0);
    check("a pool missing both windows is not counted as exhausted",
      exhaustedModelIds({ pools: [{ id: "x", modelIds: ["m9"] }] }).length === 0);

    // Pool membership is NOT exclusive: the platform also names a model in the
    // general pool while it has its own dedicated pool. One drained pool must
    // not remove a model another pool still funds — the union rule did exactly
    // that live on 2026-10-17 and emptied the whole picker offer.
    const shared = {
      pools: [
        {
          id: "gen", modelIds: ["m1", "m2", "shared"],
          window5h: { limit: 100, remaining: 0, resetAt: 1 },
          window7d: { limit: 500, remaining: 400, resetAt: 2 }
        },
        {
          id: "ded", modelIds: ["shared", "only-ded"],
          window5h: { limit: 100, remaining: 100, resetAt: 3 },
          window7d: { limit: 500, remaining: 500, resetAt: 4 }
        }
      ]
    };
    const partly = exhaustedModelIds(shared);
    check("a model kept alive by another pool survives one pool being drained",
      JSON.stringify(partly) === JSON.stringify(["m1", "m2"]), JSON.stringify(partly));

    const allDrained = {
      pools: [
        {
          id: "gen2", modelIds: ["shared"],
          window5h: { limit: 100, remaining: 0, resetAt: 1 },
          window7d: { limit: 500, remaining: 400, resetAt: 2 }
        },
        {
          id: "ded2", modelIds: ["shared"],
          window5h: { limit: 100, remaining: 50, resetAt: 3 },
          window7d: { limit: 500, remaining: 0, resetAt: 4 }
        }
      ]
    };
    check("a model is blocked once EVERY pool covering it is drained",
      JSON.stringify(exhaustedModelIds(allDrained)) === JSON.stringify(["shared"]),
      JSON.stringify(exhaustedModelIds(allDrained)));

    // "Drained + unknown" is the edge the ALL-POOLS rule deliberately keeps out
    // of the blocked set. Be precise about WHY, because the arithmetic is easy to
    // misread: the undeclared pool contributes NO credit, yet it still counts in
    // the denominator (`pools`), so `exhausted < pools` and the model stays
    // selectable. An undeclared limit is therefore read as "not evidence of
    // exhaustion" rather than "no coverage at all" — the conservative direction,
    // matching the shape-drift guard above. Old union rule blocked it; keeping
    // the unknown pool OUT of the denominator instead would block it too.
    const drainedPlusUnknown = {
      pools: [
        {
          id: "gen3", modelIds: ["edge"],
          window5h: { limit: 100, remaining: 0, resetAt: 1 },
          window7d: { limit: 500, remaining: 400, resetAt: 2 }
        },
        {
          id: "nul3", modelIds: ["edge"],
          window5h: { limit: 0, remaining: 0, resetAt: null },
          window7d: { limit: 0, remaining: 0, resetAt: null }
        }
      ]
    };
    check("an undeclared-limit pool still counts as coverage, so one drained pool alone does not block",
      JSON.stringify(exhaustedModelIds(drainedPlusUnknown)) === JSON.stringify([]),
      JSON.stringify(exhaustedModelIds(drainedPlusUnknown)));

    // Malformed members inside `model_ids` must not become model ids, and a pool
    // naming one id twice must not count as two pools (per-pool `Set`): the
    // verdict below is `["dup"]` either way, but a regression that dropped the
    // type filter would emit `""` / `42` into the blocked set and empty real
    // entries from the picker by mistake.
    const noisy = {
      pools: [
        {
          id: "noisy", modelIds: ["dup", "dup", "", 42, null, undefined],
          window5h: { limit: 100, remaining: 0, resetAt: 1 },
          window7d: { limit: 500, remaining: 400, resetAt: 2 }
        }
      ]
    };
    check("a pool's duplicate / non-string model ids collapse to the one real id",
      JSON.stringify(exhaustedModelIds(noisy)) === JSON.stringify(["dup"]),
      JSON.stringify(exhaustedModelIds(noisy)));

    // The one drift where quota protection fails INVISIBLY: the pool says "no
    // credit left" but names no usable models, so it blocks nothing and the
    // panel's banner says nothing. `exhaustedModelIds` covering nothing is the
    // correct rule; the query below exists so the caller can REPORT it instead
    // of a renamed `model_ids` quietly disabling protection for good.
    const ghost = { pools: [{ id: "ghost", window5h: { limit: 100, remaining: 0, resetAt: 1 } }] };
    check("a drained pool with no model ids is reported as unreadable",
      JSON.stringify(drainedPoolsWithoutModels(ghost)) === JSON.stringify(["ghost"])
        && exhaustedModelIds(ghost).length === 0,
      JSON.stringify(drainedPoolsWithoutModels(ghost)));
    check("a live pool with no model ids is not reported (nothing is unreadable about it)",
      drainedPoolsWithoutModels({ pools: [{ id: "ok", window5h: { limit: 100, remaining: 5, resetAt: 1 } }] }).length === 0);
    check("unusable ids count as no ids, and a nameless pool is labelled by name",
      JSON.stringify(drainedPoolsWithoutModels({
        pools: [{ name: "Flash-Lite", modelIds: [42, "", null], window7d: { limit: 500, remaining: 0, resetAt: 2 } }]
      })) === JSON.stringify(["Flash-Lite"]),
      JSON.stringify(drainedPoolsWithoutModels({
        pools: [{ name: "Flash-Lite", modelIds: [42, "", null], window7d: { limit: 500, remaining: 0, resetAt: 2 } }]
      })));
  } catch (error) {
    fail("exhaustedModelIds", error);
  }
}

// --- 4. rosterWithAvailability: the panel's self-identifying roster -------
{
  try {
    const entries = [
      { id: "m1", max_output_length: 65536 },
      { id: "m2" },
      { id: "gen", output_modalities: ["image"] }
    ];
    // m1's pool still has credit; m2's pool has hit zero (5h window).
    const pools = {
      pools: [
        {
          id: "a", modelIds: ["m1"],
          window5h: { limit: 100, remaining: 40, resetAt: 1 },
          window7d: { limit: 500, remaining: 400, resetAt: 2 }
        },
        {
          id: "b", modelIds: ["m2"],
          window5h: { limit: 100, remaining: 0, resetAt: 3 },
          window7d: { limit: 500, remaining: 400, resetAt: 4 }
        }
      ]
    };
    const roster = rosterWithAvailability(entries, pools);
    const byId = Object.fromEntries(roster.map((r) => [r.id, r]));
    check("rosterWithAvailability drops image-generation models (chat offer only)",
      !("gen" in byId) && roster.length === 2,
      JSON.stringify(roster.map((r) => r.id)));
    check("m1 is available (its pool still has credit)",
      byId.m1.available === true && byId.m1.quotaExhausted === false);
    check("m2 is marked quotaExhausted (its pool hit zero)",
      byId.m2.available === false && byId.m2.quotaExhausted === true);
    // The parameter figures the WorkBuddy-shape row quotes: the declared
    // ceiling rides verbatim, an entry without one carries 0 (UNKNOWN, never
    // a guess) so the panel draws no segment for it.
    check("the row projects the platform-declared output ceiling",
      byId.m1.maxOutputLength === 65536, String(byId.m1.maxOutputLength));
    check("an undeclared ceiling projects as 0, not a guessed number",
      byId.m2.maxOutputLength === 0, String(byId.m2.maxOutputLength));
    // The row no longer carries `thinkingLevels` (U11 死字段删除，2026-11-04)；
    // the ladder the DSH selector offers is pinned DIRECTLY below through
    // `supportedThinkingLevels` — 2026-10-26: 只含 off/low/medium/high/max
    // （xhigh/minimal 彻底移除）。
    check("every model offers the same full ladder (2026-10-26)",
      supportedThinkingLevels({ id: "glm-5.2" }).join(",") === "off,low,medium,high,max" &&
      supportedThinkingLevels({ id: "deepseek-v4-flash" }).join(",") === "off,low,medium,high,max" &&
      supportedThinkingLevels({ id: "anything-else" }).join(",") === "off,low,medium,high,max",
      [
        "glm-5.2=" + supportedThinkingLevels({ id: "glm-5.2" }).join(","),
        "v4-flash=" + supportedThinkingLevels({ id: "deepseek-v4-flash" }).join(","),
        "other=" + supportedThinkingLevels({ id: "anything-else" }).join(",")
      ].join(" | "));

    // No exhausted pools -> everything available.
    const clear = rosterWithAvailability(entries, { pools: [] });
    check("with no exhausted pools every row reads available",
      clear.every((r) => r.available === true && r.quotaExhausted === false));

    // A non-array / missing pools value must not throw and must read available.
    const safe = rosterWithAvailability(entries, {});
    check("a missing pools array yields available rows without throwing",
      safe.length === 2 && safe.every((r) => r.available === true));

    // Parity: the roster enumerates EVERY chat model (including quota-exhausted,
    // so the panel can show them greyed) with the exhausted one flagged — the
    // PICKER-side exclusion of those ids lives in the adapter's `catalogFilter`
    // seam (available:false here is the same judgment, one source:
    // exhaustedModelIds).
    const rosterIds = roster.map((r) => r.id);
    check("roster enumerates every chat model (incl. quota-exhausted; image models stay out)",
      JSON.stringify(rosterIds) === JSON.stringify(["m1", "m2"]), JSON.stringify(rosterIds));
    const greyed = rosterWithAvailability(entries, {
      pools: [{ id: "p", modelIds: ["m2"], window5h: { limit: 10, remaining: 0, resetAt: 1 }, window7d: { limit: 10, remaining: 10, resetAt: 2 } }]
    }).find((r) => r.id === "m2");
    check("the quota-exhausted row reads available:false (the picker drops it off this same set)",
      greyed?.available === false && greyed?.quotaExhausted === true,
      JSON.stringify(greyed));
  } catch (error) {
    fail("rosterWithAvailability", error);
  }
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
