/**
 * Catalog entry -> pi-ai model descriptor mapping — the pure half of the
 * directly-registered SenseNova LLM provider ("one-stop service", step three).
 *
 * This module deliberately imports NO runtime peer (`@earendil-works/pi-ai`,
 * `@deepseek-ai/dsh-llm-pi-ai`): it builds plain objects only, so the mapping
 * decisions stay testable on a clean checkout. `llm-adapter.ts` is the
 * peer-dependent half that hands these descriptors to `createProvider`.
 *
 * Three decisions carried here are load-bearing, not cosmetic:
 *
 * 1. `compat.supportsDeveloperRole: false`. pi-ai picks the system-prompt role
 *    as `reasoning && supportsDeveloperRole ? "developer" : "system"`, and when
 *    the flag is unset it AUTO-DETECTS, returning true for anything that does
 *    not look like a known non-standard provider. SenseNova's direct endpoint
 *    does not speak the developer role, so an unset flag makes every request
 *    403 forever. Setting it false is the fix the qoder route proved necessary.
 * 2. `maxTokens` declares the platform's OWN catalogue ceiling when the
 *    catalogue states one. The harness fills an UNDECLARED maxTokens with
 *    `defaultMaxTokens ?? 32768` (`dsh-llm-pi-ai` resolveRouteModels), so
 *    "declaring nothing" does NOT mean "no ceiling" — it silently caps output
 *    at 32768, HALF the ceiling flash-lite's catalogue states (65536; probed
 *    2026-10-02: flash-lite accepts `max_tokens: 65536` and refuses 131072
 *    with "MaxTokens invalid, should be in [1, 65536]", while v4-flash and
 *    glm-5.2 accept 131072 — the ceiling is per-model). Declaring the
 *    catalogue figure raises the cap to what the platform allows; a model
 *    whose catalogue states no ceiling keeps the field UNDECLARED (the
 *    harness 32768 fallback), never a guessed number. Only the field NAME
 *    (`max_tokens`) is pinned unconditionally.
 * 3. `reasoning: true` + a `thinkingLevelMap`. Every SenseNova chat model
 *    advertises `supported_features: ["reasoning"]` and thinks by default
 *    (verified 2026-09-29: default reasoning_effort high, thinking text
 *    returned as `reasoning` on flash-lite and `reasoning_content` on
 *    deepseek/glm/kimi — pi-ai reads both spellings). `reasoning: true` is
 *    what makes DSH offer the 思考强度 selector and what makes pi-ai surface
 *    the thinking. The map pins picker levels to platform-valid wire values:
 *    `off: "none"` (the platform's off spelling — "off" itself 400s),
 *    `minimal: null` (unverified on this gateway), and `max` only on glm-5.2
 *    (probed 200; rejected 400 on flash-lite / deepseek-v4-flash).
 *
 * @module dsh-sensenova-suite/llm-models
 */

import { str, num } from "./util.ts";
import { identifyVisionModel } from "./parsers.ts";
import { isChatModel, isImageGenModel } from "./modality.ts";
import type { AdapterConfig } from "./types.ts";

/** One normalized catalog entry (kept whole by `console-client.ts`). */
export interface CatalogEntry {
  id?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

/**
 * The model ids whose EVERY quota pool is exhausted.
 *
 * The panel's `pool-usage` response groups models into pools, each with a
 * 5h and a 7d window carrying `limit`/`remaining`. A pool is "exhausted" when
 * its limit is known (> 0) and its remaining credit has hit zero in EITHER
 * window — at that point a model funded by that pool AND NOTHING ELSE would
 * answer a chat request with `429 quota_exceeded`, so the picker should not
 * offer it (and the panel should show it greyed). A pool whose limit is
 * 0/unknown is NOT counted as exhausted: `credits()` returns 0 for an absent
 * limit, and we must not mark half the catalogue unavailable on a shape drift.
 *
 * Pool membership is NOT exclusive: the platform also lists a model in the
 * general pool while it has its own dedicated pool, so one drained pool must
 * not remove a model that another pool still funds. Blocking is therefore an
 * ALL-POOLS judgement, not a union — a model leaves the picker only when no
 * pool covering it is left with credit. (Live 2026-10-17: the general pool's
 * 5h window hit 0 while the Flash-Lite dedicated pool still held 530k, and the
 * old union rule emptied the ENTIRE picker offer, including that model.)
 * @param {object} pools - the `parsePools` result (`{ pools: [...] }`).
 * @returns {string[]} the blocked model ids, de-duplicated, in first-seen order.
 */
export function exhaustedModelIds(pools: { pools?: unknown }): string[] {
  const list = Array.isArray(pools?.pools) ? pools.pools : [];
  // Per model: how many pools name it, and how many of those are drained.
  const coverage = new Map<string, { pools: number; exhausted: number }>();
  for (const pool of list) {
    const limit5 = num(pool?.window5h?.limit, 0);
    const rem5 = num(pool?.window5h?.remaining, 0);
    const limit7 = num(pool?.window7d?.limit, 0);
    const rem7 = num(pool?.window7d?.remaining, 0);
    const exhausted = (limit5 > 0 && rem5 <= 0) || (limit7 > 0 && rem7 <= 0);
    // One pool counting the same id twice must not inflate `pools`, or the
    // "every covering pool" test below could never be satisfied for it.
    const ids = new Set<string>();
    for (const id of Array.isArray(pool?.modelIds) ? pool.modelIds : []) {
      if (typeof id === "string" && id !== "") ids.add(id);
    }
    for (const id of ids) {
      const row = coverage.get(id) ?? { pools: 0, exhausted: 0 };
      row.pools += 1;
      if (exhausted) row.exhausted += 1;
      coverage.set(id, row);
    }
  }
  const out: string[] = [];
  for (const [id, row] of coverage) {
    if (row.pools > 0 && row.exhausted === row.pools) out.push(id);
  }
  return out;
}

/**
 * Drained pools that declare no usable `model_ids`.
 *
 * This is the one state where the all-pools judgement has nothing to work
 * with: the pool says "out of credit" but names no models, so `exhaustedModelIds`
 * blocks nothing — and the panel's banner stays silent for the same reason. The
 * drift is therefore invisible from BOTH ends, and a platform rename of
 * `model_ids` would quietly disable quota protection altogether while every
 * visible reading still looked right.
 *
 * A pure query rather than a log: the aggregator must reach the logger through
 * a parameter (its purity is asserted by the suite), so the caller decides what
 * to do with these labels. `exhaustedModelIds` deliberately treats the same
 * shape as "covers nothing" — that behaviour is correct; only its SILENCE was
 * the gap.
 *
 * @param {object} pools - the `parsePools` result (`{ pools: [...] }`).
 * @returns {string[]} labels (id, else name, else `#index`) of such pools.
 */
export function drainedPoolsWithoutModels(pools: { pools?: unknown }): string[] {
  const list = Array.isArray(pools?.pools) ? pools.pools : [];
  const out: string[] = [];
  list.forEach((pool: any, index: number) => {
    const limit5 = num(pool?.window5h?.limit, 0);
    const rem5 = num(pool?.window5h?.remaining, 0);
    const limit7 = num(pool?.window7d?.limit, 0);
    const rem7 = num(pool?.window7d?.remaining, 0);
    if (!((limit5 > 0 && rem5 <= 0) || (limit7 > 0 && rem7 <= 0))) return;
    const ids = Array.isArray(pool?.modelIds) ? pool.modelIds : [];
    const usable = ids.filter((id: unknown) => typeof id === "string" && id !== "");
    if (usable.length > 0) return;
    const id = typeof pool?.id === "string" && pool.id !== "" ? pool.id : "";
    const name = typeof pool?.name === "string" && pool.name !== "" ? pool.name : "";
    out.push(id !== "" ? id : name !== "" ? name : `#${index}`);
  });
  return out;
}

/**
 * The provider id this plugin registers under.
 *
 * It must NOT be the bare `"sensenova"`: a hand-written `llm-pi-ai` row using
 * that id can already exist in an operator's profile (apiKeyEnv
 * `SENSENOVA_API_KEY`, base `https://token.sensenova.cn/v1/`), and
 * `registerAdapter` with a colliding id is refused as a duplicate. This own
 * slug-shaped id cannot collide with that row or with another plugin.
 */
export const LLM_PROVIDER_ID = "sensenova-token-plan";

/** What the DSH model picker shows as the provider's name. */
export const LLM_DISPLAY_NAME = "SenseNova Token Plan";

/**
 * The thinking effort the profile pins as DSH's "Default" on this provider.
 *
 * One constant for two claims: `llm-adapter.ts` pins it into the profile, and
 * the snapshot echoes it to the panel roster, so the number the user reads is
 * the number the adapter dispatches. Editing one without the other is now
 * impossible by construction.
 */
export const DEFAULT_REASONING_EFFORT = "high";

/**
 * Per-token prices are unknowable for a quota plan; report zero everywhere.
 *
 * ⚠️ The zeros are a SENTINEL, not "free". SenseNova Token Plan is a credit
 * pool billed by pool usage, so a per-token USD price simply does not exist on
 * this route — but the model still burns credits. A panel row showing
 * "$0.00" is describing "no per-token price known", never "this model costs
 * nothing". Keep this comment next to the set so a future reader does not
 * "fix" it to real prices or, worse, to `null` (which pi-ai may render as an
 * unknown-cost row and break the picker's cost arithmetic).
 */
export const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * Advertised context window when the catalog declares no usable one.
 *
 * pi-ai's options builder does arithmetic on `model.contextWindow`, so an
 * undefined value behaves like zero rather than "unknown" and breaks max-token
 * calculation; the qoder route therefore always supplies a positive number.
 * 128k is the conservative SenseNova-family default; a catalog field that
 * states a real window always wins.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Read a positive context window off the catalog entry's known spellings.
 *
 * `context_length` is the field the platform actually emits (verified against
 * the live catalog, 2026-09); the other spellings are kept as fallbacks in
 * case the platform ever reverts to a different name. SenseNova's `/v1/models`
 * entries are kept whole by `console-client.ts`, so a field the platform adds
 * later needs no parser change here — only its name has to be added to this
 * list.
 * @param {object} entry - one normalized catalog entry.
 * @returns {number} the declared window, or the fallback.
 */
export function contextWindowOf(entry: CatalogEntry): number {
  for (const key of ["context_length", "context_window", "contextWindow", "max_context_tokens"]) {
    const value = Math.floor(num(entry?.[key], 0));
    if (value > 0) return value;
  }
  return FALLBACK_CONTEXT_WINDOW;
}

/**
 * Read the platform's declared per-request output ceiling, 0 when unknown.
 *
 * The 0 return is an OUTCOME, not a blank: the descriptor then keeps
 * `maxTokens` UNDECLARED and the harness's `defaultMaxTokens ?? 32768` applies
 * — HALF of what flash-lite's catalogue states, so "declaring nothing" is not
 * "no ceiling" (module header, decision 2). A non-zero return IS a request
 * parameter: `toPiDescriptor` declares it as `maxTokens`, which is what raises
 * the cap to what the platform allows.
 *
 * The same figure is the picker's display value (`rosterWithAvailability`
 * carries it as `maxOutputLength` → `llm.metaOutput`), so the number the user
 * reads is the number the request carries — one source, not two.
 * Same spelling-first policy as {@link contextWindowOf}.
 * @param {object} entry - one normalized catalog entry.
 * @returns {number} the declared ceiling, or 0 when the entry states none.
 */
export function maxOutputLengthOf(entry: CatalogEntry): number {
  for (const key of ["max_output_length", "maxOutputLength", "max_output_tokens"]) {
    const value = Math.floor(num(entry?.[key], 0));
    if (value > 0) return value;
  }
  return 0;
}

/**
 * The output ceiling a descriptor will ACTUALLY carry for one entry.
 *
 * Precedence, and this is the only place the order is stated:
 * **operator override > the platform's catalogue figure > undeclared**.
 * The override exists because the catalogue can UNDERSTATE a model: the module
 * header's probe found `deepseek-v4-flash` accepting 131072 while the
 * catalogue states 65536. The catalogue is FETCHED, not authored, so an
 * operator needs a knob that survives the next refresh — and the refresh
 * overwrites nothing else, which is why this is a separate map rather than a
 * rewrite of the stored entries (`catalog-store.ts` keeps what the platform
 * said; disagreeing with it is a setting, not a data edit).
 *
 * A 0 return still means UNDECLARED, so the harness's `defaultMaxTokens ??
 * 32768` applies. An override deliberately cannot *lower* a catalogue figure
 * into "no ceiling": the map only ever states a positive integer, and guessing
 * a number where the platform stated none is what decision 2 forbids.
 *
 * The panel roster quotes THIS function, not {@link maxOutputLengthOf}, so the
 * "最大输出" the user reads is the number the request carries. Two callers, one
 * order — the alternative (roster quoting the catalogue while the descriptor
 * quotes the override) is how the panel starts lying.
 * @param {object} entry - one normalized catalog entry.
 * @param {object} [overrides] - `{ "<model id>": <ceiling> }`; unsanitized input
 *   is tolerated (each value is re-validated here) but `host-config.ts` already
 *   sanitized it at the config seam.
 * @returns {number} the effective ceiling, or 0 when nothing declares one.
 */
export function maxTokensFor(entry: CatalogEntry, overrides?: Record<string, number> | null): number {
  const id = str(entry?.id, "");
  if (id !== "" && overrides !== null && overrides !== undefined && typeof overrides === "object") {
    const raw = (overrides as Record<string, unknown>)[id];
    // Re-validated, not trusted: this is exported and reachable from a
    // descriptor build, so it must hold even if a caller hands it a raw config
    // object. `Number.isInteger` excludes NaN/Infinity/fractions, and `> 0`
    // keeps the "0 means undeclared" contract single-valued.
    if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  }
  return maxOutputLengthOf(entry);
}

/**
 * Whether a catalog entry can be addressed as a CHAT model on this provider's
 * OpenAI-compatible endpoint.
 *
 * The PERMISSIVE direction of the modality judgment — a missing/unknown
 * `output_modalities` reads as chat, so an entry the platform did not annotate
 * does not vanish from the picker. Only an explicit image-GENERATION
 * declaration keeps it out (such models answer 404 on `/v1/chat/completions`,
 * verified 2026-09-29). The judgment itself lives in {@link isChatModel}
 * (`modality.ts`), the ONE place both the chat roster and the draw list read
 * from — a missing field cannot make them drift in opposite directions.
 * @param {object} entry - one normalized catalog entry.
 * @returns {boolean} whether the entry is usable as a chat model.
 */
export { isChatModel };
export { identifyVisionModel } from "./parsers.ts";
export { isImageGenModel } from "./modality.ts";

/**
 * The picker's 思考强度 levels, driven by the USER-configured per-model set.
 *
 * 2026-10-26 起：可勾选档位只含 `off`/`low`/`medium`/`high`/`max`（用户 2026-10-26
 * 拍板：默认档位只考虑原生档位，xhigh/minimal 彻底不要）。有用户配置时按它生成
 * map（不在列表的档位 = null，DSH 对话界面不提供）；未配置时回落默认档位集
 * （off/low/medium/high/max）。
 *
 * A value of `null` means "the picker must not offer this level"; a string is
 * the wire spelling the level dispatches to.
 * @param {object} entry - one normalized catalog entry.
 * @param {string[]} [userLevels] - the user-selected level ids for this model.
 * @returns {object} the thinkingLevelMap.
 */
export function thinkingLevelMapFor(entry: CatalogEntry, userLevels?: string[]): Record<string, string | null> {
  void entry; // 签名保留：调用点传 entry；档位以用户配置/默认档位集为主。
  const levels = Array.isArray(userLevels) && userLevels.length > 0
    ? new Set(userLevels)
    : null;
  const has = (level: string): boolean => levels === null || levels.has(level);
  return {
    off: has("off") ? "none" : null,
    low: has("low") ? "low" : null,
    medium: has("medium") ? "medium" : null,
    high: has("high") ? "high" : null,
    max: has("max") ? "max" : null
  };
}

/** pi-ai's escalation ladder (`EXTENDED_THINKING_LEVELS`). */
const THINKING_LADDER = ["off", "low", "medium", "high", "max"];

/**
 * The thinking levels DSH's selector will actually offer for one model.
 *
 * 2026-10-26：只含 off/low/medium/high/max（xhigh/minimal 彻底移除——默认档位
 * 只按原生档位）。DSH builds the model-settings effort list through exactly
 * this function, so a roster row quoting it cannot disagree with what the
 * picker lets the user select.
 * @param {object} entry - one normalized catalog entry.
 * @returns {string[]} level ids in escalation order, e.g. ["off","low",...].
 */
export function supportedThinkingLevels(entry: CatalogEntry, userLevels?: string[]): string[] {
  const map = thinkingLevelMapFor(entry, userLevels);
  return THINKING_LADDER.filter((level) => map[level] !== null);
}

/**
 * Map one catalog entry onto the pi-ai model descriptor the adapter offers.
 *
 * Vision is the SAME identification the snapshot publishes
 * (`identifyVisionModel`: the platform's `input_modalities` first, the name
 * fallback only when no structured field exists) — so the model picker cannot
 * disagree with the panel's vision list about which models accept images.
 * @param {object} entry - one normalized catalog entry (must carry `id`).
 * @param {object} [options] - wiring.
 * @param {string} [options.providerId] - the provider id the descriptor belongs to.
 * @param {string} [options.baseUrl] - the OpenAI-compatible base URL.
 * @returns {object} the pi-ai descriptor.
 */
export function toPiDescriptor(entry: CatalogEntry, options: AdapterConfig = {}) {
  const { providerId = LLM_PROVIDER_ID, baseUrl, thinkingOverrides } = options;
  const id = str(entry?.id, "");
  if (id === "") throw new Error("toPiDescriptor: catalog entry has no id");
  const vision = identifyVisionModel(entry).vision === true;
  // Resolved ONCE, before the literal: the spread below must not call the
  // resolver twice (two calls cannot disagree today, but a future override
  // lookup that logs or warns would then fire twice per descriptor).
  const effectiveMaxTokens = maxTokensFor(entry, options.maxTokensOverrides);
  return {
    id,
    // Prefer the catalog's own display name; fall back to the id.
    name: str(entry.name, id),
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    // Vision is automatic: the catalog's modality field decides, the user does
    // not configure it per model.
    input: vision ? ["text", "image"] : ["text"],
    // Every SenseNova chat model thinks by default and advertises
    // `supported_features: ["reasoning"]`; see the module header (decision 3)
    // for why the flag is true and what the map pins.
    reasoning: true,
    thinkingLevelMap: thinkingLevelMapFor(entry, thinkingOverrides?.[id]),
    cost: { ...NO_COST },
    contextWindow: contextWindowOf(entry),
    // `supportsDeveloperRole: false` is load-bearing — see the module header.
    // `maxTokens` carries the EFFECTIVE ceiling: the operator override when the
    // settings row states one, else the catalogue's OWN figure (the harness
    // would otherwise cap output at 32768 via defaultMaxTokens — see the module
    // header, decision 2). When neither states one the field stays UNDECLARED
    // rather than guessing a number. {@link maxTokensFor} is the only place
    // that order lives, and the panel roster quotes the same function, so the
    // figure the user reads is the figure the request carries.
    ...(effectiveMaxTokens > 0 ? { maxTokens: effectiveMaxTokens } : {}),
    compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false }
  };
}

/**
 * Narrow a catalog to the models the user enabled.
 *
 * An **empty list means "no filter"**: a fresh install has curated nothing and
 * must still be offered every model (the WorkBuddy convention). Once non-empty
 * the list is an allow-list; an id that names no current catalog entry is
 * harmless — it simply matches nothing this catalog.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {string[]} [enabledIds] - the allow-list; empty/absent disables it.
 * @returns {object[]} the entries still offered, in catalog order.
 */
export function filterByEnabled(entries: unknown, enabledIds?: unknown): object[] {
  const list = Array.isArray(enabledIds) ? enabledIds : [];
  if (list.length === 0) return Array.isArray(entries) ? entries : [];
  const allow = new Set(list);
  return (Array.isArray(entries) ? entries : []).filter((entry) => allow.has(str(entry?.id, "")));
}

/**
 * The id that stands for "nothing is offered".
 *
 * An empty allow-list already means "no filter", so there has to be a second
 * spelling for "the filter matched nothing": a string that can never be a real
 * model id, kept as the list's only entry. `filterByEnabled` then filters by
 * an id that matches nothing, which is the offer the user asked for. A bare
 * `[]` cannot mean both "all models" and "no models" at once.
 *
 * The panel carries the SAME literal (`src/client/models.ts` `HIDE_ALL_MODELS`,
 * re-exported through the client bundle) because the browser half cannot
 * import this module; `test/provider.test.mjs` pins the two together so a
 * rename on either side goes red.
 */
export const HIDE_ALL_MODELS = "__hide_all__";

/**
 * Whether one model id would be offered for a given allow-list.
 *
 * Mirrors {@link filterByEnabled}: an empty list offers everything, a
 * non-empty list is a strict allow-list, and the {@link HIDE_ALL_MODELS}
 * sentinel offers nothing.
 * @param {string[]|undefined} enabledIds - the allow-list; positionally required,
 *   though `undefined`/non-array is tolerated at runtime (treated as empty).
 * @param {string} id - the model id to ask about.
 * @returns {boolean}
 */
export function isModelEnabled(enabledIds: string[] | undefined, id: string): boolean {
  const list = Array.isArray(enabledIds) ? enabledIds : [];
  if (list.length === 0) return true;
  return list.includes(str(id, ""));
}

/**
 * The panel-facing roster: one row per addressable catalog entry.
 *
 * Deliberately a projection, not the raw entries: the snapshot carries no
 * more than the picker needs (id, a display name, and the same vision
 * verdict the descriptors use), so a catalogue field the platform adds later
 * cannot leak into the panel for no reason.
 *
 * Deduping keeps the LAST occurrence at its first-seen position, exactly like
 * {@link buildDescriptors} and `catalog-store.normalizeEntries`: a fresher
 * read of the same id wins. If this diverged, the roster and the registered
 * offer would disagree about which models exist, and a ticked model could
 * become an unregistered one.
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {{id: string, name: string, vision: boolean, imageGen: boolean}[]}
 */
export function rosterOf(entries: unknown): { id: string; name: string; vision: boolean; imageGen: boolean }[] {
  const position = new Map();
  const out: { id: string; name: string; vision: boolean; imageGen: boolean }[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    // 治本：出图模型（imageGen）从对话清单划走——它们不属于对话模型，
    // 只服务于出图/识图工具。需要完整目录（含图模）的调用方走
    // `rosterWithAvailability` 之外的路（多模态下拉不再依赖本函数）。
    if (isImageGenModel(entry) === true) continue;
    const id = str(entry?.id, "");
    if (id === "") continue;
    const row = {
      id,
      name: str(entry?.name, id),
      vision: identifyVisionModel(entry).vision === true,
      imageGen: isImageGenModel(entry) === true,
    };
    if (position.has(id)) {
      out[position.get(id)] = row;
    } else {
      position.set(id, out.length);
      out.push(row);
    }
  }
  return out;
}

/**
 * Build the whole descriptor list for one catalog.
 *
 * Entries without an id are dropped (they could not be addressed on the wire)
 * and duplicate ids keep the LAST occurrence, matching the catalog store's
 * normalization so the adapter and the persisted catalog can never diverge.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {object} options - `{ providerId, baseUrl, enabledIds, maxTokensOverrides }`.
 * @returns {object[]} the pi-ai descriptors, in first-seen order.
 */
export function buildDescriptors(entries: any[], options: AdapterConfig = {}) {
  const { providerId = LLM_PROVIDER_ID, baseUrl, enabledIds = [], unavailableModelIds = [], maxTokensOverrides, thinkingOverrides } = options;
  // Image-generation models (`output_modalities: ["image"]`) cannot be
  // addressed as chat models and are excluded BEFORE the allow-list, so a
  // stale id in `enabledIds` matches nothing rather than resurrecting one.
  const blocked = new Set(Array.isArray(unavailableModelIds) ? unavailableModelIds : []);
  const filtered = filterByEnabled(entries, enabledIds).filter(isChatModel);
  const seen = new Map();
  // `undefined` slots exist briefly: a first sighting reserves the position
  // (push), the descriptor lands at that index below — the hole is always
  // filled before `out` is returned.
  const out: (object | undefined)[] = [];
  for (const entry of Array.isArray(filtered) ? filtered : []) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const catalogEntry = entry as CatalogEntry;
    const id = str(catalogEntry.id, "");
    if (id === "") continue;
    // A model whose quota pool is exhausted would answer every request with
    // `429 quota_exceeded`, so the picker must not offer it — the panel (via
    // `rosterWithAvailability`) still shows it, greyed, with the reason. Skipping
    // here means a doomed request is never even dispatched.
    if (blocked.has(id)) continue;
    if (!seen.has(id)) {
      seen.set(id, out.length);
      out.push(undefined);
    }
    out[seen.get(id)] = toPiDescriptor({ ...catalogEntry, id }, { providerId, ...(maxTokensOverrides !== undefined ? { maxTokensOverrides } : {}), ...(baseUrl !== undefined ? { baseUrl } : {}) , ...(thinkingOverrides !== undefined ? { thinkingOverrides } : {}) });
  }
  // Every `undefined` pushed above is overwritten at that same index before the
  // loop advances (see the comment on `out`), so no hole survives to here. The
  // assertion states that invariant rather than re-filtering at runtime: a
  // `filter` would allocate a second array on every catalog poll, and this
  // function's contract is `object[]`, not "maybe a hole".
  return out as object[];
}

/**
 * The panel-facing roster with per-model quota availability.
 *
 * Like {@link rosterOf} it projects one row per chat-model id, but each row also
 * carries whether the model's quota pool is currently exhausted — the
 * "清单自带识别" the provider advertises to the panel. Unlike the PICKER
 * (which drops exhausted models via `buildDescriptors` so no doomed request is
 * dispatched), the panel keeps them in the list, greyed, so the user can see
 * *why* a model is missing from the picker rather than wondering where it went.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {object} pools - the `parsePools` result, or anything without a `pools`
 *   array (in which case every row reads as available).
 * @param {object} [maxTokensOverrides] - the SAME `{ "<model id>": ceiling }` map
 *   a descriptor build gets. Positionally third and optional, so a caller written
 *   before the field existed keeps compiling; omitting it makes every row quote
 *   the catalogue figure, which is what a deployment with no overrides wants.
 * @returns {{id: string, name: string, vision: boolean, imageGen: boolean, available: boolean, quotaExhausted: boolean, contextWindow: number, maxOutputLength: number, thinkingLevels: string[]}[]}
 */
export function rosterWithAvailability(entries: unknown, pools: { pools?: unknown }, maxTokensOverrides?: Record<string, number> | null, thinkingOverrides?: Record<string, string[]> | null) {
  const blocked = new Set(exhaustedModelIds(pools));
  const position = new Map();
  const out: { id: string; name: string; vision: boolean; imageGen: boolean; available: boolean; quotaExhausted: boolean; contextWindow: number; maxOutputLength: number; thinkingLevels: string[] }[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    // 治本：出图模型（imageGen）从面板清单整行划走——它不属于对话模型，
    // 不该出现在「接入 API 的推送清单」里（此清单是供对话模型勾选的）。
    // 图模只留给多模态 tab 的出图/识图下拉用（那里另有 imageGen 数据源）。
    if (isImageGenModel(entry) === true) continue;
    const id = str(entry?.id, "");
    if (id === "") continue;
    const row = {
      id,
      name: str(entry?.name, id),
      vision: identifyVisionModel(entry).vision === true,
      imageGen: isImageGenModel(entry) === true,
      available: !blocked.has(id),
      quotaExhausted: blocked.has(id),
      // The window the descriptor itself will use: a declared `context_length`
      // when the catalog has one, else the same 128k fallback pi-ai gets —
      // so the badge never contradicts the effective behavior.
      contextWindow: contextWindowOf(entry),
      // The EFFECTIVE output ceiling the descriptor will carry — the operator
      // override when one names this id, else the platform's figure (0 =
      // unknown). {@link maxTokensFor} is the one order, so the badge cannot
      // claim a ceiling the request does not send. Widening the projection here
      // is deliberate: the raw entry stays Host-side, and the panel quotes only
      // these two parameter figures plus the vision verdict.
      maxOutputLength: maxTokensFor(entry, maxTokensOverrides),
      // What the DSH selector will really offer this model (same rule pi-ai
      // applies to the registered descriptor) — the per-model fact worth
      // repeating on a row, unlike the provider-wide default, which the panel
      // states once in its header. 用户勾选的档位（thinking 分区）优先。
      thinkingLevels: supportedThinkingLevels(entry, thinkingOverrides?.[id])
    };
    if (position.has(id)) {
      out[position.get(id)] = row;
    } else {
      position.set(id, out.length);
      out.push(row);
    }
  }
  return out;
}

/**
 * Counts the provider-registration status reports: how many models the catalog
 * offered and how many of them accept image input, keyed by the same vision
 * identification the descriptors use.
 * @param {object[]} entries - the normalized catalog entries.
 * @returns {{modelCount: number, visionCount: number, visionIds: string[]}}
 */
export function summarizeCatalog(entries: unknown) {
  const list = (Array.isArray(entries) ? entries : []).filter(isChatModel);
  const visionIds = list
    .filter((entry) => str(entry?.id, "") !== "")
    .map((entry) => identifyVisionModel(entry))
    .filter((entry) => entry.vision === true)
    .map((entry) => entry.id);
  return {
    modelCount: list.filter((entry) => str(entry?.id, "") !== "").length,
    visionCount: visionIds.length,
    visionIds
  };
}

/**
 * Enforces one upstream = one provider identity, before the descriptors reach
 * the Host.
 *
 * DSH stamps `source.provider` on every assistant message from the ROUTE id it
 * resolved, while `replayState.response.provider` is copied from the
 * descriptor's own `provider` field. The Host's replay check compares the two
 * and, on a mismatch, drops that assistant turn to a foreign message — pi-ai
 * then replays every thinking block as plain text. A descriptor must therefore
 * carry exactly the id the adapter registers under. Two upstreams sharing one
 * identity constant break that check on whichever route is named differently,
 * which is why the two routes here own separate ids (`LLM_PROVIDER_ID`,
 * `RACCOON_PROVIDER_ID`) rather than one shared one.
 *
 * Throws instead of repairing: a mismatched descriptor means every replayed
 * turn on that route is already degraded, so assembly time is the last cheap
 * place to report it — once, instead of silently on each request.
 * @param {object[]} models - the descriptors this upstream will publish.
 * @param {string} providerId - the id this upstream registers under.
 * @returns {object[]} the same descriptors, when the invariant holds.
 */
export function assertProviderOwnership(models: unknown, providerId: unknown): object[] {
  const owner = str(providerId, "");
  if (owner === "") throw new Error("assertProviderOwnership: providerId is required");
  const list = Array.isArray(models) ? models : [];
  for (const model of list) {
    const stamp = str((model as { provider?: unknown })?.provider, "");
    if (stamp !== owner) {
      const id = str((model as { id?: unknown })?.id, "?");
      throw new Error(
        `assertProviderOwnership: descriptor "${id}" is stamped "${stamp}" but this upstream registers as "${owner}"`
      );
    }
  }
  return list as object[];
}