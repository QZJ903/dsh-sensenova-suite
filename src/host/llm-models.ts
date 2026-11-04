/**
 * Catalog entry → capability judgments for the directly-registered SenseNova
 * LLM provider ("one-stop service", step three) — the peer-free half.
 *
 * This module deliberately imports NO runtime peer (`@earendil-works/pi-ai`,
 * `@deepseek-ai/dsh-llm-pi-ai`): plain objects and pure functions only, so the
 * judgments stay testable on a clean checkout. The registered adapter's model
 * facts are assembled by `llm-adapter.ts`/`adapter.ts`; the panel projections
 * (`rosterWithAvailability` → snapshot) and the adapter's request ceiling
 * (`maxTokensForId` → resolveModel) read the SAME functions here, which is how
 * the picker and the wire stay one offer.
 *
 * Decisions carried here are load-bearing, not cosmetic:
 *
 * 1. `maxTokensForId`: the wire ceiling = settings `maxTokensOverrides` >
 *    the catalogue's OWN figure > UNDECLARED. The harness fills an UNDECLARED
 *    ceiling with `defaultMaxTokens ?? 32768` (`dsh-llm-pi-ai`
 *    resolveRouteModels), so "declaring nothing" does NOT mean "no ceiling" —
 *    it silently caps output at 32768, HALF the ceiling flash-lite's catalogue
 *    states (65536; probed 2026-10-02: flash-lite accepts `max_tokens: 65536`
 *    and refuses 131072 with "MaxTokens invalid, should be in [1, 65536]",
 *    while v4-flash and glm-5.2 accept 131072 — the ceiling is per-model).
 *    Declaring the figure (catalogue or override) raises the cap to what the
 *    platform allows; the override exists because the catalogue can UNDERSTATE
 *    (2026-10-26 docs-first: deepseek-flash [1, 393216] documented, catalogue
 *    probes 65536).
 * 2. `thinkingLevelMapFor`: the picker levels are the USER-configured set
 *    (2026-10-26 拍板：off/low/medium/high/max，xhigh/minimal 彻底不要),
 *    pinned to platform-valid wire values — `off: "none"` (the platform's off
 *    spelling; "off" itself 400s).
 * 3. The pi-ai descriptor build that once lived here (`toPiDescriptor`,
 *    `compat.supportsDeveloperRole: false` — the qoder-route 403 fix) was
 *    REMOVED 2026-10-31: the wire adapter serves `listModels` directly and no
 *    production path built descriptors. If a descriptor build ever returns, its
 *    assembly point must re-derive the developer-role decision — see U3 for
 *    the wire path's own developer-role posture.
 *
 * @module dsh-sensenova-suite/llm-models
 */

import { str, num } from "./util.ts";
import { identifyVisionModel } from "./parsers.ts";
import { isChatModel, isImageGenModel } from "./modality.ts";

/** Known-uncallable model ids: the catalog still lists them, but every call
 * fails, so every offer-shaped exit (the adapter's own `parseCatalog` and the
 * panel's snapshot projections) drops them, while the catalog store and the
 * contract baseline keep the platform mirror.
 * Static on purpose: the adapter's failure cache only learns from 404
 * model-not-found — a 403 never self-hides, so without this set the model
 * would be offered forever.
 * - `sensenova-6.7-flash-lite`：路由已下线，调用 404（原 adapter 本地清单，2026-10-27 上移至此共用）。
 * - `deepseek-v4.1-flash`：该 Key 套餐未开通，调用一律 403（docs/SENSENOVA-API.md「需开通」行，
 *   2026-09-30 起实测；官方文档的 DeepSeek V4.1 Flash 是 `deepseek-flash`，此 id 为目录冗余行，删除不损失能力）。 */
export const KNOWN_UNROUTABLE_MODELS: ReadonlySet<string> = new Set([
  "sensenova-6.7-flash-lite",
  "deepseek-v4.1-flash",
]);

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
export const LLM_PROVIDER_ID = "sensenova-suite";

/** What the DSH model picker shows as the provider's name. */
export const LLM_DISPLAY_NAME = "SenseNova Suite";

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
 * Advertised context window when the catalog declares no usable one.
 *
 * pi-ai's options builder does arithmetic on `model.contextWindow`, so an
 * undefined value behaves like zero rather than "unknown" and breaks max-token
 * calculation; the qoder route therefore always supplies a positive number.
 * 131072 was the request-side fallback first (adapter resolveModel), and the
 * badge now imports THIS constant — one fallback, quoted by both the roster
 * and the wire path, so the two cannot disagree (D1).
 */
export const FALLBACK_CONTEXT_WINDOW = 131_072;

/**
 * The field-spelling tables for the two catalog capability figures, shared by
 * BOTH readers: the panel projections (this file's `contextWindowOf` /
 * `maxOutputLengthOf`) and the registered adapter's own parser
 * (`adapter.ts` firstContextField / firstMaxOutputField). One list, one
 * first-match order — the same fact keeps one implementation and one
 * precedence on both sides of the display/request divide (U6 ledger D1:
 * the two lists used to diverge, so an entry carrying only `max_tokens`
 * showed "undeclared" on the panel while the request declared it).
 * `max_output_length` is the field SenseNova `/v1/models` actually emits and
 * stays first; the rest are the OpenAI-style fallbacks in request-side order.
 */
export const CONTEXT_WINDOW_FIELDS: readonly string[] = ["context_length", "context_window", "max_context_length", "contextLength", "contextWindow", "max_context_tokens"];
export const MAX_OUTPUT_FIELDS: readonly string[] = ["max_output_length", "max_tokens", "max_output_tokens", "max_completion_tokens", "maxTokens", "maxOutputTokens", "maxCompletionTokens"];

/**
 * The override>catalogue order on bare ids for the CONTEXT WINDOW — the
 * adapter-side twin of {@link maxTokensForId}. The registered adapter holds an
 * already-parsed `contextWindow` figure (not the platform's field spellings),
 * so it resolves through HERE; the panel's `contextWindowOf` delegates to it
 * too — one order, two readers, no drift between the 「上下文」 badge and the
 * request-side window arithmetic.
 * @param {string} id - the model id the override map is keyed by.
 * @param {number|undefined} catalogFigure - the catalogue's declared window
 *   (already parsed; `undefined` = the entry declares none).
 * @param {object} [overrides] - `{ "<model id>": tokens }`; re-validated here,
 *   not trusted (`Number.isInteger` excludes NaN/Infinity/fractions, `> 0`
 *   keeps the map positive-only).
 * @returns {number} the effective window — never below the
 *   {@link FALLBACK_CONTEXT_WINDOW} floor when nothing declares one.
 */
export function contextWindowForId(id: string, catalogFigure: number | undefined, overrides?: Record<string, number> | null): number {
  const override = overrideFor(id, overrides);
  if (override !== undefined) return override;
  return catalogFigure !== undefined && catalogFigure > 0 ? catalogFigure : FALLBACK_CONTEXT_WINDOW;
}

/**
 * Read a positive context window off the catalog entry's known spellings.
 *
 * The spelling list is {@link CONTEXT_WINDOW_FIELDS} — shared with the
 * adapter's parser, same order. A field the platform adds later needs no
 * parser change — only its name appended to that one list.
 * Precedence: **operator override > the declared figure > the fallback** —
 * the same order `maxTokensForId` states for the output ceiling, because the
 * catalogue can UNDERSTATE a window too (2026-11-03: sensenova-6.8-flash
 * probes 262144 while the official documentation states 1M).
 * @param {object} entry - one normalized catalog entry.
 * @param {object} [overrides] - `{ "<model id>": tokens }` (the settings row
 *   `contextWindowOverrides`); re-validated in {@link contextWindowForId}.
 * @returns {number} the effective window.
 */
export function contextWindowOf(entry: CatalogEntry, overrides?: Record<string, number> | null): number {
  let declared = 0;
  for (const key of CONTEXT_WINDOW_FIELDS) {
    const value = Math.floor(num(entry?.[key], 0));
    if (value > 0) { declared = value; break; }
  }
  return contextWindowForId(str(entry?.id, ""), declared > 0 ? declared : undefined, overrides);
}

/**
 * Read the platform's declared per-request output ceiling, 0 when unknown.
 *
 * The 0 return is an OUTCOME, not a blank: the adapter then keeps
 * `defaultMaxTokens` UNDECLARED and the harness's `defaultMaxTokens ?? 32768`
 * applies — HALF of what flash-lite's catalogue states, so "declaring nothing"
 * is not "no ceiling" (module header, decision 2). A non-zero return IS a
 * request parameter: `maxTokensForId` hands it (or the override) to the
 * adapter's `defaultMaxTokens`, which is what raises the cap to what the
 * platform allows.
 *
 * The same figure is the picker's display value (`rosterWithAvailability`
 * carries it as `maxOutputLength` → `llm.metaOutput`), so the number the user
 * reads is the number the request carries — one source, not two.
 * Same spelling-first policy as {@link contextWindowOf}.
 * @param {object} entry - one normalized catalog entry.
 * @returns {number} the declared ceiling, or 0 when the entry states none.
 */
export function maxOutputLengthOf(entry: CatalogEntry): number {
  for (const key of MAX_OUTPUT_FIELDS) {
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
 * The panel roster quotes THIS function, and the registered adapter resolves
 * the REQUEST ceiling through {@link maxTokensForId} with the same map
 * (`adapter.ts` resolveModel → `defaultMaxTokens`) — the "最大输出" the user
 * reads is the number the request carries, by construction (D1: the wire side
 * used to drop the map, so the badge quoted a ceiling no request could send).
 * @param {object} entry - one normalized catalog entry.
 * @param {object} [overrides] - `{ "<model id>": ceiling }`; unsanitized input
 *   is tolerated (each value is re-validated here) but `host-config.ts` already
 *   sanitized it at the config seam.
 * @returns {number} the effective ceiling, or 0 when nothing declares one.
 */
export function maxTokensFor(entry: CatalogEntry, overrides?: Record<string, number> | null): number {
  return maxTokensForId(str(entry?.id, ""), maxOutputLengthOf(entry) || undefined, overrides) ?? 0;
}

/**
 * The validated override for one id, or undefined — the shared core of
 * {@link maxTokensForId} and {@link contextWindowForId} (inlining it twice was
 * a duplication-gate finding; this is the extraction it asked for). Re-validates
 * untrusted config: `Number.isInteger` excludes NaN/Infinity/fractions, `> 0`
 * keeps both maps positive-only.
 */
function overrideFor(id: string, overrides?: Record<string, number> | null): number | undefined {
  if (id !== "" && overrides !== null && overrides !== undefined && typeof overrides === "object") {
    const raw = (overrides as Record<string, unknown>)[id];
    if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  }
  return undefined;
}

/**
 * The override>catalogue order on bare ids — the ONE resolver both the wire
 * path and the panel projection call.
 *
 * Split out of {@link maxTokensFor} so the registered adapter can apply the
 * same precedence without a raw catalog entry: it holds an already-parsed
 * `maxOutputTokens` figure, not the platform's field spellings. Returns
 * `undefined` for "nothing declares a ceiling" (the adapter then leaves
 * `defaultMaxTokens` undeclared and the harness's `defaultMaxTokens ?? 32768`
 * applies) — the same OUTCOME `maxTokensFor` spells as `0`.
 * @param {string} id - the model id the override map is keyed by.
 * @param {number|undefined} catalogFigure - the catalogue's own figure
 *   (already parsed; `undefined` = the entry declares none).
 * @param {object} [overrides] - `{ "<model id>": ceiling }`; re-validated
 *   here, not trusted.
 * @returns {number|undefined} the effective ceiling, or `undefined` when
 *   nothing declares one.
 */
export function maxTokensForId(id: string, catalogFigure: number | undefined, overrides?: Record<string, number> | null): number | undefined {
  const override = overrideFor(id, overrides);
  if (override !== undefined) return override;
  return catalogFigure !== undefined && catalogFigure > 0 ? catalogFigure : undefined;
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
 * The panel-facing roster with per-model quota availability.
 *
 * Projects one row per chat-model id, each carrying whether the model's quota
 * pool is currently exhausted — the "清单自带识别" the provider advertises to
 * the panel. Unlike the PICKER (whose registered adapter drops exhausted
 * models at `listModels` so no doomed request is dispatched), the panel keeps
 * them in the list, greyed, so the user can see *why* a model is missing from
 * the picker rather than wondering where it went.
 * @param {object[]} entries - the normalized catalog entries.
 * @param {object} pools - the `parsePools` result, or anything without a `pools`
 *   array (in which case every row reads as available).
 * @param {object} [maxTokensOverrides] - the SAME `{ "<model id>": ceiling }` map
 *   a descriptor build gets. Positionally third and optional, so a caller written
 *   before the field existed keeps compiling; omitting it makes every row quote
 *   the catalogue figure, which is what a deployment with no overrides wants.
 * @param {object} [contextWindowOverrides] - `{ "<model id>": tokens }`, the
 *   settings row the adapter's resolveModel reads too (contextWindowForId) —
 *   the badge and the request-side window stay one fact.
 * @returns {{id: string, name: string, vision: boolean, imageGen: boolean, available: boolean, quotaExhausted: boolean, contextWindow: number, maxOutputLength: number}[]}
 */
export function rosterWithAvailability(entries: unknown, pools: { pools?: unknown }, maxTokensOverrides?: Record<string, number> | null, contextWindowOverrides?: Record<string, number> | null) {
  const blocked = new Set(exhaustedModelIds(pools));
  const position = new Map();
  const out: { id: string; name: string; vision: boolean; imageGen: boolean; available: boolean; quotaExhausted: boolean; contextWindow: number; maxOutputLength: number }[] = [];
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
      // The window the descriptor itself will use: override > declared
      // `context_length` when the catalog has one, else the same 128k fallback
      // pi-ai gets — so the badge never contradicts the effective behavior.
      contextWindow: contextWindowOf(entry, contextWindowOverrides),
      // The EFFECTIVE output ceiling the descriptor will carry — the operator
      // override when one names this id, else the platform's figure (0 =
      // unknown). {@link maxTokensFor} is the one order, so the badge cannot
      // claim a ceiling the request does not send. Widening the projection here
      // is deliberate: the raw entry stays Host-side, and the panel quotes only
      // these two parameter figures plus the vision verdict.
      maxOutputLength: maxTokensFor(entry, maxTokensOverrides)
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