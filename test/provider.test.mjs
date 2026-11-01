/**
 * Unit checks for the step-three LLM provider's PEER-FREE layers:
 *
 * - `llm-models.js`: catalog entry -> pi-ai descriptor mapping (vision
 *   detection, the load-bearing compat flags, context-window fallbacks,
 *   dedupe);
 * - `catalog-store.js`: the private state file (normalization, version
 *   rejection, atomic round-trip, the memory fallback);
 * - `api-key-store.js`: the `SENSENOVA_API_KEY` reference store (service
 *   precedence over env, save/forget, failure fall-through, ephemeral state).
 *
 * Nothing here imports a Host peer AT MODULE LOAD, so these decisions stay
 * covered on a clean checkout. One exception, deliberately dynamic: the T3
 * island imports the real adapter inside a try/catch and loud-skips when the
 * `@deepseek-ai/dsh-llm` peer cannot resolve (a resolution failure only — any
 * other import error fails); wherever the peer resolves, the pin really runs.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateHostEnv, isolateStateDir } from "./peer-roots.mjs";
import {
  FALLBACK_CONTEXT_WINDOW,
  contextWindowOf,
  isChatModel,
  thinkingLevelMapFor,
  filterByEnabled,
  rosterWithAvailability,
  maxTokensFor,
  maxTokensForId,
  HIDE_ALL_MODELS,
  summarizeCatalog
} from "../src/host/llm-models.ts";
import { identifyVisionModel } from "../src/host/parsers.ts";
import { isImageGenModel, inputModalitiesFor } from "../src/host/modality.ts";
import { factsFor } from "../src/host/wire/facts.ts";
import {
  CATALOG_VERSION,
  KNOWN_CATALOG_VERSIONS,
  normalizeEnabledIds,
  normalizeEntries,
  createFileCatalogStore,
  createMemoryCatalogStore
} from "../src/host/catalog-store.ts";
import { createApiKeyStore, API_KEY_REF } from "../src/host/api-key-store.ts";
import { PROVIDER_VERSION, createFileProviderStore } from "../src/host/provider-store.ts";
import { redactSecrets } from "../src/host/util.ts";
import { profileSegment, profileStateDir } from "../src/host/state-store.ts";
import { syncSignaturesAfterPublish, catalogSignature, quotaSignatureOf, seedPublisherFromCatalog, createProviderPublisher } from "../src/host/provider-publish.ts";
import { surface as clientSurface } from "./client-surface.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { results, check, fail, finish } from "./harness.mjs";

const HOST_SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "host");


const BASE_URL = "https://token.sensenova.cn/v1";

// --- 1. the thinking map: picker levels pinned to platform wire spellings --
// (The pi-ai descriptor build this section once pinned was removed 2026-10-31
// with the wire adapter serving listModels directly; the DIALECT decision
// survives in thinkingLevelMapFor and is pinned here directly.)
{
  try {
    check("off is the platform's none, not the OpenAI off (which 400s)",
      thinkingLevelMapFor({ id: "any" }).off === "none");
    check("minimal is not offered (2026-10-26: 默认档位只按原生档位)",
      thinkingLevelMapFor({ id: "any" }).minimal === undefined);
    check("xhigh is not offered (2026-10-26: xhigh 彻底移除)",
      thinkingLevelMapFor({ id: "any" }).xhigh === undefined &&
        thinkingLevelMapFor({ id: "deepseek-v4-flash" }).xhigh === undefined);
    check("all 思考档位 are user-selectable (2026-10-26: off/low/medium/high/max)",
      thinkingLevelMapFor({ id: "any" }).low === "low" &&
      thinkingLevelMapFor({ id: "any" }).medium === "medium" &&
      thinkingLevelMapFor({ id: "any" }).high === "high" &&
      thinkingLevelMapFor({ id: "any" }).max === "max");
    check("max is offered (platform accepts it since the 12-level 2026-10-24 probe)",
      thinkingLevelMapFor({ id: "sensenova-6.8-flash-lite" }).max === "max" &&
      thinkingLevelMapFor({ id: "glm-5.2" }).max === "max");
  } catch (error) {
    fail("the thinking map dialect", error);
  }
}

// --- 2. vision is automatic and identical to the panel's classification ----
{
  try {
    check("input_modalities image marks the model vision",
      identifyVisionModel({ id: "SenseNova-Vision", input_modalities: ["text", "image"] }).vision === true);
    check("the name fallback still marks a -vl model vision (and says so)",
      identifyVisionModel({ id: "SenseNova-VL" }).vision === true &&
        identifyVisionModel({ id: "SenseNova-VL" }).source === "name");
    check("flash-lite is text-only (no name-pattern vision anymore)",
      identifyVisionModel({ id: "sensenova-6.8-flash-lite", input_modalities: ["text"] }).vision === false);
  } catch (error) {
    fail("vision classification", error);
  }
}

// --- 3. context window: declared spellings win, positive fallback otherwise -
{
  try {
    check("context_window wins", contextWindowOf({ context_window: 32000 }) === 32000);
    check("contextWindow wins", contextWindowOf({ contextWindow: 65536 }) === 65536);
    check("max_context_tokens wins", contextWindowOf({ max_context_tokens: 8192 }) === 8192);
    check("context_length wins (the real /v1/models field, 2026-09)",
      contextWindowOf({ context_length: 262144 }) === 262144);
    check("context_length beats the legacy spellings when both present",
      contextWindowOf({ context_length: 262144, context_window: 32000 }) === 262144);
    check("a fractional value floors", contextWindowOf({ context_window: 100.9 }) === 100);
    check("zero falls back", contextWindowOf({ context_window: 0 }) === FALLBACK_CONTEXT_WINDOW);
    check("negative falls back", contextWindowOf({ context_window: -5 }) === FALLBACK_CONTEXT_WINDOW);
    check("junk falls back", contextWindowOf({ context_window: "lots" }) === FALLBACK_CONTEXT_WINDOW);
    check("missing falls back to a positive window (pi-ai does arithmetic on it)",
      contextWindowOf({ id: "x" }) === 131072);
  } catch (error) {
    fail("context window handling", error);
  }
}

// --- 4.5 chat-model filtering: image-generation models are not offered -----
// The catalog lists U-series image-generation models (output_modalities
// ["image"]) that answer 404 on /v1/chat/completions; offering them as chat
// models would only produce errors in DSH. Every "offered" surface — the
// descriptors, the panel roster and the registration counts — must exclude
// them identically.
{
  try {
    const gen = { id: "u-gen", output_modalities: ["image"], input_modalities: ["text"] };
    const visionChat = { id: "v-chat", output_modalities: ["text"], input_modalities: ["text", "image"] };
    const textChat = { id: "t-chat", output_modalities: ["text"] };

    check("an image-output model is not a chat model", isChatModel(gen) === false);
    check("a vision chat model is a chat model", isChatModel(visionChat) === true);
    check("a text-only model is a chat model", isChatModel(textChat) === true);
    // 2026-10-26：isImageGenModel 收紧为「output_modalities 恰好只有 ['image']」
    // ——多模态对话模型（输出 text、输入含 image）不进出图清单，只有纯出图的
    // u1.5 系才算图模。
    check("a pure output-image model IS an image-gen model",
      isImageGenModel(gen) === true);
    check("a multi-modal CHAT model (output text, input image) is NOT an image-gen model",
      isImageGenModel(visionChat) === false);
    check("a text-only model is NOT an image-gen model",
      isImageGenModel(textChat) === false);
    check("a declared-image entry (only image) is not chat", isChatModel(gen) === false);
    check("a missing output_modalities stays chat (permissive)", isChatModel({ id: "x" }) === true);
    check("a non-array output_modalities stays chat", isChatModel({ id: "y", output_modalities: "text" }) === true);
    // The modality contradiction the single judgment kills (P1-3, 2026-10-02):
    // a missing field makes the chat direction (permissive) and the draw
    // direction (strict) drift in OPPOSITE ways when they re-implement the
    // probe separately. Both read the one `modality.ts` decision now, so an
    // entry is never both chat and draw, and a missing field cannot flip either.
    check("a missing output_modalities is chat but NOT a draw model (one judgment)",
      isChatModel({ id: "z" }) === true && isImageGenModel({ id: "z" }) === false);
    check("an image-output model is draw but NOT chat (complementary)",
      isImageGenModel(gen) === true && isChatModel(gen) === false);
    check("a multi-modal chat model is NEITHER draw-only NOR contradictory",
      isImageGenModel(visionChat) === false && isChatModel(visionChat) === true);
    check("a text-output model is neither draw-only nor contradictory",
      isImageGenModel(textChat) === false && isChatModel(textChat) === true);

    // --- inputModalitiesFor：宿主侧图片闸门（2026-10-27 两次图片链路事故）----
    // 宿主见 descriptor 申报 inputModalities 而无 "image" 会把图片剥成
    // [image omitted …] 占位文本。图像能力唯一真源 = 用户「可看图」勾选集：
    // 勾选申报 image、未勾选不申报（宿主放行给转述兜底）、条目本义绝不申报纯文本。
    check("entry-level: platform text+image passes through unchanged",
      JSON.stringify(inputModalitiesFor({ input_modalities: ["text", "image"] })) === JSON.stringify(["text", "image"]));
    check("entry-level: platform text-only is undeclared, never ['text']",
      inputModalitiesFor({ input_modalities: ["text"] }) === undefined);
    check("entry-level: an undeclared row stays undeclared",
      inputModalitiesFor({}) === undefined);
    check("entry-level: a non-array platform value reads as undeclared",
      inputModalitiesFor({ input_modalities: "text,image" }) === undefined);
    check("entry-level: unknown modality names are dropped, image alone still declares",
      JSON.stringify(inputModalitiesFor({ input_modalities: ["audio", "image"] })) === JSON.stringify(["image"]));
    check("checked: declares text+image even on a bare row (user config is the truth)",
      JSON.stringify(inputModalitiesFor({}, true)) === JSON.stringify(["text", "image"]));
    check("checked: image wins over a text-only platform row (catalog lags docs)",
      JSON.stringify(inputModalitiesFor({ input_modalities: ["text"] }, true)) === JSON.stringify(["text", "image"]));
    check("unchecked: undeclared even when the platform declares image (user config wins)",
      inputModalitiesFor({ input_modalities: ["text", "image"] }, false) === undefined);

    // --- factsFor：未知模型开图（勾选注记 → 通用宽容格式集）------------------
    // 静态表未收录的新模型勾了「可看图」：adapter 在请求期给 entry 注记 image，
    // factsFor 的未知分支据此开图并给通用格式集——否则 blocks 白名单为空，
    // 图片在第三层（格式校验）再次被吃。
    const unknownFacts = factsFor("brand-new-model", { id: "brand-new-model", inputModalities: ["text", "image"] });
    check("unknown model with an image-annotated entry turns vision on",
      unknownFacts.supportsImages === true,
      JSON.stringify(unknownFacts.supportsImages));
    check("unknown vision model gets the generic permissive format set",
      JSON.stringify(unknownFacts.imageFormats) === JSON.stringify(["jpeg", "png", "webp", "gif"]),
      JSON.stringify(unknownFacts.imageFormats));
    check("unknown model without any declaration stays text-only",
      factsFor("brand-new-model", undefined).supportsImages === false);
    check("known model keeps its static formats when the entry declares image",
      JSON.stringify(factsFor("deepseek-flash", { id: "deepseek-flash", inputModalities: ["text", "image"] }).imageFormats)
        === JSON.stringify(["jpeg", "png", "gif", "webp"]));

    const roster = rosterWithAvailability([gen, visionChat, textChat], { pools: [] });
    check("the panel roster drops image-generation models (chat offer only)",
      JSON.stringify(roster.map((r) => r.id)) === JSON.stringify(["v-chat", "t-chat"]),
      JSON.stringify(roster.map((r) => r.id)));

    const summary = summarizeCatalog([gen, visionChat, textChat]);
    check("summarizeCatalog counts only chat models", summary.modelCount === 2, String(summary.modelCount));
    check("summarizeCatalog vision ids cover only offered models",
      JSON.stringify(summary.visionIds) === JSON.stringify(["v-chat"]));

  } catch (error) {
    fail("chat-model filtering", error);
  }
}

// --- 5. summarizeCatalog: what the snapshot llm block reports --------------
{
  try {
    const summary = summarizeCatalog([
      { id: "text-a" },
      { id: "vision-a", input_modalities: ["text", "image"] },
      { id: "vision-b", input_modalities: ["text", "image"] },
      { id: "", input_modalities: ["text", "image"] }
    ]);
    check("model count counts every addressable entry", summary.modelCount === 3, String(summary.modelCount));
    check("vision count uses the same identification", summary.visionCount === 2, String(summary.visionCount));
    check("vision ids are reported", JSON.stringify(summary.visionIds) === JSON.stringify(["vision-a", "vision-b"]));
    check("no catalog means zero/zero", summarizeCatalog(undefined).modelCount === 0 &&
      summarizeCatalog(undefined).visionCount === 0);
  } catch (error) {
    fail("summarizeCatalog", error);
  }
}

// --- 5.5 filterByEnabled: empty list means "no filter" ---------------------
// A fresh install has curated nothing and must still be offered every model.
// Once non-empty the list is a strict allow-list; a stale id simply matches
// nothing. This is the one pure function in this module with NO coverage
// elsewhere — it had never been asserted directly.
{
  try {
    const entries = [
      { id: "a" },
      { id: "b" },
      { id: "c" }
    ];
    check("absent enabledIds offers every entry", filterByEnabled(entries).length === 3);
    check("an empty enabledIds is the same as absent",
      filterByEnabled(entries, []).length === 3);
    check("a non-array enabledIds behaves as absent",
      filterByEnabled(entries, "a").length === 3);
    check("a non-empty list is a strict allow-list",
      JSON.stringify(filterByEnabled(entries, ["a", "c"]).map((e) => e.id)) === JSON.stringify(["a", "c"]));
    check("a stale id matches nothing rather than throwing",
      filterByEnabled(entries, ["zzz"]).length === 0);
    check("a non-array entries list reads as no entries",
      filterByEnabled(null).length === 0);
  } catch (error) {
    fail("filterByEnabled allow-list semantics", error);
  }
}

// --- 5.6 the "hide everything" sentinel and the panel roster projection -----
// An empty allow-list already means "no filter", so "the user unticked every
// model" needs a second spelling. HIDE_ALL_MODELS is that spelling: it is not a
// model, so it matches nothing and offers nothing — while staying distinct
// from "nothing curated yet". Without it the picker could not express
// "temporarily push no models" at all.
{
  try {
    const entries = [
      { id: "a", name: "Model A" },
      { id: "b", name: "Model B", input_modalities: ["text", "image"] },
      { id: "c", name: "Model C" }
    ];
    // The sentinel must be a string no real id can be.
    check("the sentinel is a non-empty string", typeof HIDE_ALL_MODELS === "string" && HIDE_ALL_MODELS !== "", String(HIDE_ALL_MODELS));
    check("a sentinel-only allow-list offers nothing",
      filterByEnabled(entries, [HIDE_ALL_MODELS]).length === 0);
    check("the sentinel filters a mixed list down to nothing",
      filterByEnabled(entries, [HIDE_ALL_MODELS, "a"]).map((e) => e.id).join(",") === "a");
    check("an empty list still means 'no filter' (not 'nothing')",
      filterByEnabled(entries, []).length === 3);
    // The store keeps the sentinel: curation survives a persist round trip.
    check("normalizeEnabledIds keeps the sentinel",
      JSON.stringify(normalizeEnabledIds([HIDE_ALL_MODELS, "a"])) === JSON.stringify([HIDE_ALL_MODELS, "a"]));
    check("normalizeEnabledIds still drops junk",
      JSON.stringify(normalizeEnabledIds([HIDE_ALL_MODELS, "", null, "a", "a"])) === JSON.stringify([HIDE_ALL_MODELS, "a"]));
    check("normalizeEnabledIds on a non-array reads as no filter",
      JSON.stringify(normalizeEnabledIds("nope")) === JSON.stringify([]));
  } catch (error) {
    fail("the hide-all sentinel", error);
  }
}

// --- 5.6b the roster projection: what the panel shows as tickable rows ------
// rosterWithAvailability is what stands between the raw catalogue and the
// checkboxes: it must project just id/name/vision/imageGen, drop junk and
// image-generation rows, dedupe by id (last wins), and reach the SAME vision
// verdict the adapter declares — otherwise the panel would advertise a model
// the provider never registered.
{
  try {
    const roster = rosterWithAvailability([
      { id: "a", name: "Model A" },
      { id: "b", name: "Model B", input_modalities: ["text", "image"], opaque_field: "must not leak" },
      { name: "no id" },
      { id: "a", name: "Model A prime" },
      { id: "gen", output_modalities: ["image"] },
      null,
      { id: "c" }
    ], { pools: [] });
    check("the roster drops id-less entries, junk and image-generation rows",
      roster.map((r) => r.id).join(",") === "a,b,c", roster.map((r) => r.id).join(","));
    check("the roster keeps only the projected fields",
      JSON.stringify(Object.keys(roster[0]).sort()) === JSON.stringify(["available", "contextWindow", "id", "imageGen", "maxOutputLength", "name", "quotaExhausted", "thinkingLevels", "vision"]),
      JSON.stringify(Object.keys(roster[0]).sort()));
    check("a missing name falls back to the id", roster[2].name === "c");
    check("the roster dedupes last-wins at the first-seen position",
      roster[0].name === "Model A prime", roster[0].name);
    check("the roster reaches the same vision verdict the adapter declares",
      JSON.stringify(roster.map((r) => r.vision)) === JSON.stringify([false, true, false]) &&
      JSON.stringify(rosterWithAvailability([{ id: "plain" }], { pools: [] }).map((r) => r.vision)) === JSON.stringify([false]));
    check("the roster on a non-array returns nothing", rosterWithAvailability(undefined, { pools: [] }).length === 0);
  } catch (error) {
    fail("roster projection", error);
  }
}

// --- 5.6c the browser bundle must carry the same sentinel -------------------
// client.js cannot import this module (the browser loader only resolves
// packages), so the literal is spelled twice. If the two diverge, the Host
// would apply a filter the panel believes is "everything on" — silently
// un-curating the whole catalogue. Materializing the shipped bundle is what
// catches that.
{
  try {
    check("client and host spell the same hide-all sentinel",
      clientSurface.helpers.HIDE_ALL_MODELS === HIDE_ALL_MODELS,
      `${clientSurface.helpers.HIDE_ALL_MODELS} !== ${HIDE_ALL_MODELS}`);
    // The picker's own predicate must agree with the Host's filter.
    const entries = [{ id: "a" }, { id: "b" }, { id: "c" }];
    for (const allow of [[], ["a", "c"], [HIDE_ALL_MODELS]]) {
      const hostIds = filterByEnabled(entries, allow).map((e) => e.id);
      const panelIds = entries.map((e) => e.id).filter((id) => clientSurface.helpers.modelIsOn(allow, id));
      check(`client modelIsOn agrees with filterByEnabled for ${JSON.stringify(allow)}`,
        JSON.stringify(panelIds) === JSON.stringify(hostIds),
        `${JSON.stringify(panelIds)} vs ${JSON.stringify(hostIds)}`);
    }
    // Ticking one model off must produce a complete allow-list, not a diff.
    check("toggleModelIn: unticking one leaves the rest on",
      JSON.stringify(clientSurface.helpers.toggleModelIn([], ["a", "b", "c"], "b")) === JSON.stringify(["a", "c"]));
    check("toggleModelIn: unticking the last one collapses to the sentinel",
      JSON.stringify(clientSurface.helpers.toggleModelIn(["a"], ["a"], "a")) === JSON.stringify([HIDE_ALL_MODELS]));
    check("toggleModelIn: ticking back on drops the sentinel",
      JSON.stringify(clientSurface.helpers.toggleModelIn([HIDE_ALL_MODELS], ["a", "b"], "b")) === JSON.stringify(["b"]));
    check("toggleModelIn: ticking everything back on collapses to an empty list",
      JSON.stringify(clientSurface.helpers.toggleModelIn(["b"], ["a", "b"], "a")) === JSON.stringify([]));
    check("toggleModelIn: ordering follows the roster, not the old list",
      JSON.stringify(clientSurface.helpers.toggleModelIn(["c", "a"], ["a", "c", "b", "d"], "b")) === JSON.stringify(["a", "c", "b"]));
    check("toggleModelIn: ticking the last unticked model collapses to the empty spelling",
      JSON.stringify(clientSurface.helpers.toggleModelIn(["c", "a"], ["a", "c", "b"], "b")) === JSON.stringify([]));
    // Bulk operations share the same extreme spellings.
    check("setAllModelsIn: tick all is the empty-list spelling",
      JSON.stringify(clientSurface.helpers.setAllModelsIn(["a", "b"], true)) === JSON.stringify([]));
    check("setAllModelsIn: untick all is the sentinel spelling",
      JSON.stringify(clientSurface.helpers.setAllModelsIn(["a", "b"], false)) === JSON.stringify([HIDE_ALL_MODELS]));
    // A bulk edit applies to the VISIBLE rows only, but the result stays a
    // complete allow-list: the rows outside the current view keep whatever the
    // Host already offers. The last case is the regression that turned the
    // picker's "tick all" into a save that hid every model, when the caller
    // handed {id} objects to a helper that wants id strings.
    check("bulkModelsIn: ticking a visible row joins the allow-list",
      JSON.stringify(clientSurface.helpers.bulkModelsIn(["b"], ["a", "b", "c"], ["c"], true)) === JSON.stringify(["b", "c"]));
    check("bulkModelsIn: ticking from the sentinel restores the picked row only",
      JSON.stringify(clientSurface.helpers.bulkModelsIn([HIDE_ALL_MODELS], ["a", "b", "c"], ["a"], true)) === JSON.stringify(["a"]));
    check("bulkModelsIn: unticking one leaves the rest offered",
      JSON.stringify(clientSurface.helpers.bulkModelsIn([], ["a", "b", "c"], ["b"], false)) === JSON.stringify(["a", "c"]));
    check("bulkModelsIn: unticking the filtered view keeps the unseen rows",
      JSON.stringify(clientSurface.helpers.bulkModelsIn([], ["a", "b", "c"], ["a"], false)) === JSON.stringify(["b", "c"]));
    check("bulkModelsIn: unticking everything is the sentinel spelling",
      JSON.stringify(clientSurface.helpers.bulkModelsIn([], ["a", "b"], ["a", "b"], false)) === JSON.stringify([HIDE_ALL_MODELS]));
    // allowListFor is the funnel: every spelling it emits is one the Host reads
    // the way the picker shows it.
    check("allowListFor: a partial set is emitted in roster order",
      JSON.stringify(clientSurface.helpers.allowListFor(new Set(["c", "a"]), ["a", "c", "b"])) === JSON.stringify(["a", "c"]));
    check("allowListFor: an unknown id can never enter the list",
      JSON.stringify(clientSurface.helpers.allowListFor(new Set(["zzz"]), ["a", "b"])) === JSON.stringify([HIDE_ALL_MODELS]));
    check("allowListFor: a junk roster reads as no models",
      JSON.stringify(clientSurface.helpers.allowListFor(new Set(["a"]), undefined)) === JSON.stringify([HIDE_ALL_MODELS]));
    // And the emitted list really offers what it was asked to offer.
    const emitted = clientSurface.helpers.allowListFor(new Set(["a", "c"]), ["a", "c", "b"]);
    check("an emitted allow-list offers exactly the requested ids",
      JSON.stringify(filterByEnabled(entries, emitted).map((e) => e.id)) === JSON.stringify(["a", "c"]));
  } catch (error) {
    fail("client/host curation parity", error);
  }
}

// --- 6. normalizeEntries: the persisted catalog shape ----------------------
{
  try {
    check("non-array normalizes to empty", normalizeEntries("nope").length === 0);
    check("id-less entries are dropped", normalizeEntries([{ name: "no id" }]).length === 0);
    const normalized = normalizeEntries([
      { id: "a", input_modalities: ["text"] },
      { id: "b" },
      { id: "a", input_modalities: ["text", "image"] }
    ]);
    check("duplicate id keeps the last whole entry in first-seen position",
      normalized.length === 2 && normalized[0].id === "a" &&
      JSON.stringify(normalized[0].input_modalities) === JSON.stringify(["text", "image"]));
  } catch (error) {
    fail("normalizeEntries", error);
  }
}

// --- 7. memory catalog store -----------------------------------------------
{
  try {
    const store = createMemoryCatalogStore(() => 42);
    check("memory store starts empty", (await store.list()).length === 0);
    await store.replace([{ id: "a" }, { id: "" }, "x"]);
    const entries = await store.list();
    check("memory replace normalizes and stamps", entries.length === 1 && entries[0].id === "a");
    await store.clear();
    check("memory clear empties the store", (await store.list()).length === 0);
  } catch (error) {
    fail("memory catalog store", error);
  }
}

// --- 8. file catalog store: round trip, corruption, foreign version ---------
{
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  let scratch = "";
  try {
    const dir = join(process.env.DSH_HOME, "state", "dsh-sensenova-suite");
    const file = join(dir, "catalog.json");
    // 可读当前值的注入时钟：断言用「最后一次 now() 的返回值」而不是硬编码的第
    // N 次调用，免得实现里多读一次时钟就让这条断言红——行为（ stamp 了注入时钟
    // 的值）才是要守的东西。
    let clockNow = 1000;
    const clock = () => (clockNow += 500);
    const store = createFileCatalogStore({ dir, now: clock });
    await store.replace([
      { id: "SenseNova-Lite", input_modalities: ["text"] },
      { id: "SenseNova-Vision", input_modalities: ["text", "image"] }
    ]);
    check("replace wrote catalog.json under the plugin state dir", (() => {
      try { readFileSync(file, "utf8"); return true; } catch { return false; }
    })());
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    check("the payload carries the format version", persisted.version === CATALOG_VERSION);
    // 不钉「第几次调用」——replace 内部还要给临时文件名与读缓存各取一次时钟；
    // 要守的是 stampedAt 出自注入时钟（既不是 Date.now() 的真值，也不是 0）。
    check("the payload stamps fetchedAt from the injected clock",
      persisted.fetchedAt > 1000 && persisted.fetchedAt <= clockNow && persisted.fetchedAt % 500 === 0,
      `fetchedAt=${persisted.fetchedAt} clockNow=${clockNow}`);
    check("the payload kept whole entries for vision detection",
      Array.isArray(persisted.entries) && persisted.entries.length === 2 &&
      JSON.stringify(persisted.entries[1].input_modalities) === JSON.stringify(["text", "image"]));

    // A SECOND store instance proves persistence, not just the held cache.
    const reopened = createFileCatalogStore({ dir, now: clock });
    const entries = await reopened.list();
    check("a fresh store reads the persisted catalog",
      entries.length === 2 && entries[0].id === "SenseNova-Lite");

    writeFileSync(file, "{ this is not json", "utf8");
    const corrupted = createFileCatalogStore({ dir, now: clock });
    check("a corrupted file reads as no catalog (never throws)", (await corrupted.list()).length === 0);

    writeFileSync(file, JSON.stringify({ version: 999, fetchedAt: 1, entries: [] }), "utf8");
    const foreign = createFileCatalogStore({ dir, now: clock });
    check("a foreign format version reads as no catalog", (await foreign.list()).length === 0);

    writeFileSync(file, JSON.stringify({ version: CATALOG_VERSION, fetchedAt: 0, entries: [] }), "utf8");
    const unstamped = createFileCatalogStore({ dir, now: clock });
    check("an unstamped catalog reads as no catalog", (await unstamped.list()).length === 0);

    await reopened.clear();
    check("clear removes the file", (() => {
      try { readFileSync(file, "utf8"); return false; } catch { return true; }
    })());
  } catch (error) {
    fail("file catalog store", error);
  } finally {
    restoreHome();
    restoreEnv();
  }
}

// --- 8q. the quota dimension rides the persisted catalog (review #1a) --------
// The restart seed must inherit the last KNOWN exhausted set, so the store
// owns three facts: a stamped quota persists and reads back; a quota-less
// `replace` PRESERVES the stored statement (an unknown poll must not erase
// what the last known one said); and a v1 record states NOTHING (null, not
// []: "never answered" must not read as "answered, nothing exhausted").
{
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  try {
    const dir = join(process.env.DSH_HOME, "state", "dsh-sensenova-suite");
    const file = join(dir, "catalog.json");
    let clockNow = 1000;
    const clock = () => (clockNow += 500);
    const store = createFileCatalogStore({ dir, now: clock });

    check("a fresh store states no quota (null, not empty)", (await store.listUnavailable()) === null);

    await store.replace([{ id: "glm-5.2" }], [], ["glm-5.2"]);
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    check("replace stamps the quota dimension with the injected clock",
      JSON.stringify(persisted.unavailableIds) === JSON.stringify(["glm-5.2"]) &&
      persisted.unavailableAt > 1000 && persisted.unavailableAt <= clockNow,
      JSON.stringify({ ids: persisted.unavailableIds, at: persisted.unavailableAt }));

    const reopened = createFileCatalogStore({ dir, now: clock });
    check("a fresh process reads back the last KNOWN exhausted set",
      JSON.stringify(await reopened.listUnavailable()) === JSON.stringify(["glm-5.2"]),
      JSON.stringify(await reopened.listUnavailable()));

    await reopened.replace([{ id: "glm-5.2" }, { id: "glm-4.6" }], ["glm-5.2"]);
    check("a quota-less replace PRESERVES the stored statement",
      JSON.stringify(await reopened.listUnavailable()) === JSON.stringify(["glm-5.2"]),
      JSON.stringify(await reopened.listUnavailable()));

    await reopened.setUnavailable([]);
    check("setUnavailable states the healthy answer (empty list, not null)",
      (await reopened.listUnavailable()) !== null && (await reopened.listUnavailable()).length === 0);

    // v1 compatibility: the record parses, the quota simply reads as never-stated.
    writeFileSync(file, JSON.stringify({ version: 1, fetchedAt: 123, entries: [{ id: "a" }], enabledModelIds: ["a"] }), "utf8");
    const v1 = createFileCatalogStore({ dir, now: clock });
    check("a v1 record still serves its catalog",
      (await v1.list()).length === 1 && JSON.stringify(await v1.listEnabledIds()) === JSON.stringify(["a"]));
    check("a v1 record states no quota (seed-wide is the fresh-install answer)",
      (await v1.listUnavailable()) === null);
    // Writing from a v1 base keeps the v2 shape and does NOT invent a statement.
    await v1.replace([{ id: "a" }, { id: "b" }], ["a"]);
    check("a v1→v2 upgrade write still omits the quota fields", (() => {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      return raw.version === CATALOG_VERSION && raw.unavailableIds === undefined;
    })(), readFileSync(file, "utf8"));

    // The ADR-006 whitelist reads both ages: v1 must not be refused at the door.
    check("KNOWN_CATALOG_VERSIONS holds the current and the prior shape",
      JSON.stringify(KNOWN_CATALOG_VERSIONS) === JSON.stringify([2, 1]), JSON.stringify(KNOWN_CATALOG_VERSIONS));

    // The memory store speaks the SAME dialect (the test seam must not be a
    // second truth about the quota contract).
    const mem = createMemoryCatalogStore(() => 77);
    check("memory store: fresh states no quota", (await mem.listUnavailable()) === null);
    await mem.replace([{ id: "x" }], [], ["x"]);
    check("memory store: replace carries the quota",
      JSON.stringify(await mem.listUnavailable()) === JSON.stringify(["x"]));
    await mem.replace([{ id: "x" }]);
    check("memory store: quota-less replace preserves",
      JSON.stringify(await mem.listUnavailable()) === JSON.stringify(["x"]));
    await mem.setEnabledIds(["x"]);
    check("memory store: setEnabledIds keeps the quota statement",
      JSON.stringify(await mem.listUnavailable()) === JSON.stringify(["x"]));
    await mem.setUnavailable([]);
    check("memory store: setUnavailable states the healthy answer",
      (await mem.listUnavailable()) !== null && (await mem.listUnavailable()).length === 0);
  } catch (error) {
    fail("catalog quota dimension", error);
  } finally {
    restoreHome();
    restoreEnv();
  }
}

// --- 8r. the restart seed inherits the quota (seedPublisherFromCatalog) ------
{
  try {
    const published = [];
    const state = { entries: [], enabledIds: [], unavailableIds: [], signature: "", quotaSignature: "" };
    const publisher = {
      state,
      publish: async (entries, enabledIds, unavailableModelIds) => {
        published.push({ entries, enabledIds, unavailableModelIds });
        state.entries = entries; state.enabledIds = enabledIds; state.unavailableIds = unavailableModelIds;
        return { ok: true };
      }
    };
    // `seedPublisherFromCatalog` returns the STARTED seed promise (the effect
    // registry tracks that promise), so await it directly. The signatures are
    // stamped INTERNALLY (syncSignaturesAfterPublish, the poll's own formulas)
    // only after a LANDED publish — no signatureOf parameter any more.
    await seedPublisherFromCatalog(
      publisher,
      async () => [{ id: "glm-5.2" }],
      async () => [],
      async () => ["glm-5.2"]
    );
    check("the seed publishes WITH the persisted exhausted set",
      published.length === 1 && JSON.stringify(published[0].unavailableModelIds) === JSON.stringify(["glm-5.2"]),
      JSON.stringify(published[0]?.unavailableModelIds));
    check("the seed stamps quotaSignature so the first identical poll does not churn",
      state.quotaSignature === quotaSignatureOf(["glm-5.2"]), state.quotaSignature);
    check("the seed stamps the catalog signature from the same single source",
      state.signature === catalogSignature([{ id: "glm-5.2" }], []), state.signature);
    check("the seed records the set on the live state (routes re-publish from it)",
      JSON.stringify(state.unavailableIds) === JSON.stringify(["glm-5.2"]), JSON.stringify(state.unavailableIds));

    const published2 = [];
    const state2 = { entries: [], enabledIds: [], unavailableIds: [], signature: "", quotaSignature: "" };
    await seedPublisherFromCatalog(
      { state: state2, publish: async (e, i, u) => { published2.push(u); return { ok: true }; } },
      async () => [{ id: "a" }],
      async () => [],
      async () => null
    );
    check("a never-stated record seeds WIDE (fresh install, nothing was ever known)",
      published2.length === 1 && JSON.stringify(published2[0]) === JSON.stringify([]), JSON.stringify(published2[0]));

    // The F2/F3 lesson at the boot boundary: a seed whose publish FAILED must
    // not stamp the signatures — pre-stamping makes the first poll compare,
    // see "no change", and never retry the persisted blocked set until a real
    // change or a restart ("a restart fixes it" in its purest form).
    const state3 = { entries: [], enabledIds: [], unavailableIds: [], signature: "", quotaSignature: "" };
    await seedPublisherFromCatalog(
      { state: state3, publish: async () => ({ ok: false }) },
      async () => [{ id: "a" }],
      async () => [],
      async () => ["a"]
    );
    check("a FAILED seed publish leaves both signatures unstamped",
      state3.signature === "" && state3.quotaSignature === "",
      JSON.stringify({ signature: state3.signature, quota: state3.quotaSignature }));
  } catch (error) {
    fail("quota seed", error);
  }
}

// --- 8a. ADR-006 (catalog): persist never clobbers a foreign version --------
// Group 8 proved the READ side treats a foreign version as "no catalog". This is
// the WRITE half, in the single `persist()` both writers share. catalog's shape
// differs from the switch stores: `replace` / `setEnabledIds` remember the value
// in memory BEFORE persisting, so a refusal must still leave the catalog
// SERVING here (only the disk write is withheld) — that is the same contract as
// an ordinary write failure, which this store already swallows.
{
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  try {
    const dir = join(process.env.DSH_HOME, "state", "dsh-sensenova-suite");
    const file = join(dir, "catalog.json");
    mkdirSync(dir, { recursive: true });
    const foreignPayload = { version: 999, fetchedAt: 1, entries: [], futureField: "x" };
    const seedForeign = () => writeFileSync(file, JSON.stringify(foreignPayload, null, 2), "utf8");
    const intact = () => {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      return raw.version === 999 && raw.futureField === "x";
    };

    seedForeign();
    const warnings = [];
    const guarded = createFileCatalogStore({ dir, logger: { warn: (m) => warnings.push(m) } });
    const refused = await guarded.replace([{ id: "fresh" }]);
    check("catalog replace() does not overwrite a foreign version", intact(), readFileSync(file, "utf8"));
    check("a refused write REPORTS that the record did not reach the disk",
      refused === false, `replace()=${refused}`);
    check("a refused catalog write still serves in memory",
      JSON.stringify(await guarded.list()) === JSON.stringify([{ id: "fresh" }]),
      JSON.stringify(await guarded.list()));
    check("the catalog refusal is logged, not silent",
      warnings.some((w) => w.includes("refusing to overwrite catalog.json") && w.includes("version 999")),
      warnings.join(" | "));

    seedForeign();
    await createFileCatalogStore({ dir }).setEnabledIds(["only-this"]);
    check("catalog setEnabledIds() does not overwrite a foreign version", intact());

    // The guard must not trip on the file's own version.
    writeFileSync(file, JSON.stringify({ version: CATALOG_VERSION, fetchedAt: 1, entries: [], enabledModelIds: [] }, null, 2), "utf8");
    const normal = createFileCatalogStore({ dir });
    await normal.replace([{ id: "ok" }]);
    const afterNormal = JSON.parse(readFileSync(file, "utf8"));
    check("a known catalog version still writes normally",
      afterNormal.version === CATALOG_VERSION && afterNormal.entries[0].id === "ok", JSON.stringify(afterNormal));

    // The reason string is load-bearing, same as the other two guards.
    const source = readFileSync(new URL("../src/host/catalog-store.ts", import.meta.url), "utf8");
    const factory = readFileSync(new URL("../src/host/state-store.ts", import.meta.url), "utf8");
    // The ADR-006 refusal reason now lives in the shared factory
    // (createVersionedJsonWriter) — one source of truth instead of a copy. Pin
    // BOTH the safety phrase in the factory and that this store still registers
    // its own label + version set, so a future edit cannot silently retarget or
    // downgrade the guard (PITFALLS §37: add the new member, never weaken).
    check("the catalog refusal marker stays in the source",
      factory.includes("refusing to overwrite") &&
      factory.includes("this build knows") &&
      source.includes("createVersionedJsonWriter({") &&
      source.includes('label: "catalog"') &&
      source.includes("KNOWN_CATALOG_VERSIONS"), "");
  } catch (error) {
    fail("ADR-006 catalog write-side version guard", error);
  } finally {
    restoreHome();
    restoreEnv();
  }
}

// --- 8b. 另一个进程的写入，本进程必须很快看得见（不等重启） --------------
// PITFALLS §22：两个 profile 的 Host 进程共享同一个 state 目录。进程内的读缓存
// 一旦没有 TTL，就是「另一个进程改了允许清单 / 开关，这边要重启才生效」——
// provider/draw 两个开关早就带 1s TTL，catalog 却完全没有，属于同一 bug 的漂移。
// 这里用两个 store 实例共享同一个 dir 模拟两个进程：第二个进程写，第一个进程读。
{
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  try {
    const dir = join(process.env.DSH_HOME, "state", "dsh-sensenova-suite");
    // 手动推进的时钟：一次 tick = 600ms，刚好跨过 1000ms TTL 需要两跳。
    let t = 10_000;
    const clock = () => (t += 600);

    const here = createFileCatalogStore({ dir, now: clock });
    const elsewhere = createFileCatalogStore({ dir, now: () => t + 5_000 });
    await elsewhere.replace([{ id: "written-by-the-other-process" }]);

    const first = await here.list();
    check("a second process's write is visible here, not cached away until restart",
      first.length === 1 && first[0].id === "written-by-the-other-process",
      `entries=${JSON.stringify(first.map((e) => e.id))}`);

    // 一次新的 replace 必须保住磁盘上真实的 allow-list——即使本进程还没读过盘。
    // 旧实现里 held 是惰性填充的，先 replace 后 list 会把别人存好的清单重置成 []。
    await elsewhere.setEnabledIds(["kept-across-processes"]);
    const fresh = createFileCatalogStore({ dir, now: () => t + 9_000 });
    await fresh.replace([{ id: "after-replace" }]);
    check("a replace before any read preserves the stored allow-list",
      JSON.stringify(await fresh.listEnabledIds()) === JSON.stringify(["kept-across-processes"]),
      `enabledModelIds=${JSON.stringify(await fresh.listEnabledIds())}`);

    // 开关 store 走同一个原语（`switch-store.ts` 包着 `state-store` 的写器 + 读缓存），
    // 所以跨过 TTL 后同样要看见另一个进程拨的开关。这里刻意**先读一次**再让对面改：
    // 只做一次冷读的话缓存是空的，断言恒真——那种写法曾经守着这个 bug 却看不见它
    // （`createSwitchStore` 把 `StoreOptions.now` 丢了，注入的时钟根本不生效，
    //  而 `catalog-store` 手搭同样的两个对象时是认这个时钟的）。
    let switchClock = 20_000;
    const switchHere = createFileProviderStore({ dir, now: () => switchClock, ttlMs: 1000 });
    const switchElsewhere = createFileProviderStore({ dir });
    await switchElsewhere.save(true);
    check("a second process's panel switch is visible here too",
      (await switchHere.enabled()) === true, `enabled=${await switchHere.enabled()}`);

    // TTL 窗口内：缓存里的值仍然够用，不替每个问题都读一次盘。
    await switchElsewhere.forget();
    check("inside the TTL the switch is served from the cache, not the disk",
      (await switchHere.enabled()) === true, `enabled=${await switchHere.enabled()}`);

    // 跨过 TTL：注入的时钟必须真的让缓存过期，否则这个 store 的 `now` 是死参数。
    switchClock += 1500;
    check("past the TTL the injected clock expires the switch cache too",
      (await switchHere.enabled()) === null, `enabled=${await switchHere.enabled()}`);
  } catch (error) {
    fail("cross-process visibility of the shared state directory", error);
  } finally {
    restoreHome();
    restoreEnv();
  }
}

// --- 8c. exactly which names may become a path segment (PITFALLS §23) ------
// `profileContext.name` is FOREIGN input that ends up as a directory name, so
// it is validated rather than trusted. The blacklist matches the Host's own
// validation (dsh-app-boot resolveProfileDir) — every traversal shape a single
// segment can carry is banned, and control characters beyond that (no
// legitimate name carries them). Host-legal names the validator used to ban
// (CJK, spaces, drive-colon) MUST segment: banning them silently dropped those
// profiles back into the shared directory, i.e. exactly the §23 crosstalk the
// partition exists to prevent (2026-10-31 audit, U7-S1).
{
  const accepted = [
    ["web", "web"],
    ["desktop", "desktop"],
    ["  web  ", "web"],
    ["a_b-c.1", "a_b-c.1"],
    ["9", "9"],
    ["我的配置", "我的配置"],
    ["a b", "a b"],
    ["c:", "c:"]
  ];
  for (const [input, expected] of accepted) {
    const got = profileSegment({ get: () => ({ name: input }) });
    check(`a safe profile name is accepted: ${JSON.stringify(input)}`, got === expected,
      `got=${JSON.stringify(got)}`);
  }

  const rejected = [
    "..", ".", "../etc", "..\\windows", "a/b", "a\\b", "", "   ",
    "x".repeat(65), "/absolute", "a\u0000b"
  ];
  for (const input of rejected) {
    const got = profileSegment({ get: () => ({ name: input }) });
    check(`an unsafe profile name degrades to null: ${JSON.stringify(input)}`, got === null,
      `got=${JSON.stringify(got)}`);
  }
  for (const input of [null, undefined, 42, {}, ["web"]]) {
    const got = profileSegment({ get: () => ({ name: input }) });
    check(`a non-string profile name degrades to null: ${JSON.stringify(input)}`, got === null,
      `got=${JSON.stringify(got)}`);
  }

  // The three ctx shapes a Host may hand us — including the one that THROWS for
  // services we did not inject (Cordis' proxy behaviour; verified against the
  // real runtime, see §23). None of them may take the plugin down.
  check("a ctx that provides no profileContext yields null",
    profileSegment({ get: () => undefined }) === null);
  check("a ctx whose get() throws is survived, not propagated",
    profileSegment({ get() { throw new Error('cannot get property "profileContext" without inject'); } }) === null);
  check("a plain-object test stub is still readable",
    profileSegment({ profileContext: { name: "web" } }) === "web");
  for (const notCtx of [null, undefined, 42, "web"]) {
    check(`a non-object ctx degrades to null: ${JSON.stringify(notCtx)}`,
      profileSegment(notCtx) === null);
  }
}

// --- 8d. the directory split, and the one-shot adoption of the old layout --
// Before §23 every profile shared `$DSH_HOME/state/<plugin>/`. A profile-scoped
// store must (a) not see the other profile's values, and (b) adopt the shared
// value exactly once so an existing install keeps its allow-list and switches.
{
  const restoreHome = isolateStateDir();
  try {
    const home = process.env.DSH_HOME;
    check("a named profile gets its own directory",
      profileStateDir("plug", "web") === join(home, "state", "web", "plug"),
      profileStateDir("plug", "web"));
    check("no profile keeps the shared directory",
      profileStateDir("plug", null) === join(home, "state", "plug"),
      profileStateDir("plug", null));

    // Seed the pre-§23 shared layout: a provider switch and a catalog
    // allow-list, exactly as an existing install would have them.
    const legacyDir = join(home, "state", "dsh-sensenova-suite");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "provider.json"),
      `${JSON.stringify({ version: PROVIDER_VERSION, enabled: true, updatedAt: "2026-01-01T00:00:00.000Z" })}\n`,
      { encoding: "utf8" });
    writeFileSync(join(legacyDir, "catalog.json"),
      `${JSON.stringify({ version: CATALOG_VERSION, fetchedAt: 1_700_000_000_000, entries: [{ id: "m1" }], enabledModelIds: ["m1"] })}\n`,
      { encoding: "utf8" });

    const webSwitch = createFileProviderStore({ profile: "web" });
    const webCatalog = createFileCatalogStore({ profile: "web" });
    check("a profile switch inherits the pre-§23 shared value",
      (await webSwitch.enabled()) === true, `enabled=${await webSwitch.enabled()}`);
    check("the catalog allow-list survives the split",
      JSON.stringify(await webCatalog.listEnabledIds()) === JSON.stringify(["m1"]),
      JSON.stringify(await webCatalog.listEnabledIds()));

    const adoptedDir = join(home, "state", "web", "dsh-sensenova-suite");
    check("the inherited value was written under the profile",
      existsSync(join(adoptedDir, "provider.json")), join(adoptedDir, "provider.json"));
    // Copy, NOT move — unlike the rename adoption in store.test.mjs §16d. An
    // older Host of this plugin still reads the shared path; taking the file
    // away would silently reset its switch.
    check("the legacy file is left in place for an older Host",
      existsSync(join(legacyDir, "provider.json")));

    // Adoption is one-shot: after the first read the profile has its own file,
    // so a later edit to the legacy one must NOT win.
    writeFileSync(join(legacyDir, "provider.json"),
      `${JSON.stringify({ version: PROVIDER_VERSION, enabled: false, updatedAt: "2026-01-02T00:00:00.000Z" })}\n`,
      { encoding: "utf8" });

    // THE POINT of the split: the two profiles end up independent, even though
    // both adopted the same legacy value.
    const desktopSwitch = createFileProviderStore({ profile: "desktop" });
    check("a sibling profile adopts the shared value too",
      (await desktopSwitch.enabled()) === false, `enabled=${await desktopSwitch.enabled()}`);
    await desktopSwitch.save(true);
    check("saving in one profile leaves the other alone",
      (await createFileProviderStore({ profile: "web" }).enabled()) === true,
      `web=${await createFileProviderStore({ profile: "web" }).enabled()}`);
    check("and the profile that was saved reports its own value",
      (await createFileProviderStore({ profile: "desktop" }).enabled()) === true);
    check("once adopted, a later legacy edit does not win",
      (await createFileProviderStore({ profile: "web" }).enabled()) === true,
      `web=${await createFileProviderStore({ profile: "web" }).enabled()}`);

    // An explicit `dir` (what the other tests use) never reaches for the shared
    // layout: it was never part of it.
    const explicit = mkdtempSync(join(tmpdir(), "dsh-explicit-dir-"));
    try {
      const isolatedStore = createFileProviderStore({ dir: explicit, profile: "web" });
      check("an explicit dir does not adopt the legacy value",
        (await isolatedStore.enabled()) === null, `enabled=${await isolatedStore.enabled()}`);
    } finally {
      rmSync(explicit, { recursive: true, force: true });
    }
  } catch (error) {
    fail("the per-profile state split and its one-shot adoption", error);
  } finally {
    restoreHome();
  }
}

// --- 9. a read-only directory degrades to in-memory, never a crash ----------
{
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  const scratch = mkdtempSync(join(tmpdir(), "catalog-readonly-"));
  try {
    const store = createFileCatalogStore({ dir: join(scratch, "missing", "deep"), now: () => 1 });
    // The "directory" is actually a plain FILE: mkdir/rename cannot succeed.
    writeFileSync(scratch + "/blocker", "x", "utf8");
    const blocked = createFileCatalogStore({ dir: join(scratch, "blocker", "no"), now: () => 1 });
    const landed = await blocked.replace([{ id: "a" }]);
    check("a write failure keeps the catalog in memory", (await blocked.list()).length === 1);
    // The write failure is still swallowed (a read-only Home must not break the
    // panel), but the CALLER has to be able to tell: the signature gates the
    // next write, so a record the disk does not hold must not be treated as
    // settled. A store that reports "true" here would let the signature
    // advance past a write that never landed.
    check("a write failure REPORTS that the record did not reach the disk",
      landed === false, `replace()=${landed}`);
    const okStore = createFileCatalogStore({ dir: join(scratch, "ok"), now: () => 1 });
    check("a write that reached the disk reports true",
      (await okStore.replace([{ id: "a" }])) === true);
  } catch (error) {
    fail("read-only directory degradation", error);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    restoreHome();
    restoreEnv();
  }
}

// --- 10. provider switch store: the panel value beats the config default ---
{
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  try {
    const dir = join(process.env.DSH_HOME, "state", "dsh-sensenova-suite");
    const file = join(dir, "provider.json");
    const store = createFileProviderStore({ dir });

    check("an untouched switch reads as unset",
      (await store.enabled()) === null && (await store.isSet()) === false);

    await store.save(true);
    check("save(true) persists a boolean",
      (await store.enabled()) === true && (await store.isSet()) === true);
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    check("the payload carries the format version",
      persisted.version === PROVIDER_VERSION && persisted.enabled === true);

    const reopened = createFileProviderStore({ dir });
    check("a fresh store reads the persisted switch", (await reopened.enabled()) === true);

    await reopened.save(false);
    check("save(false) flips the switch", (await reopened.enabled()) === false);

    writeFileSync(file, "{ this is not json", "utf8");
    const corrupted = createFileProviderStore({ dir });
    check("a corrupted file reads as unset (never true by accident)",
      (await corrupted.enabled()) === null);

    writeFileSync(file, JSON.stringify({ version: 999, enabled: true }), "utf8");
    const foreign = createFileProviderStore({ dir });
    check("a foreign format version reads as unset", (await foreign.enabled()) === null);

    writeFileSync(file, JSON.stringify({ version: PROVIDER_VERSION, enabled: "yes" }), "utf8");
    const junk = createFileProviderStore({ dir });
    check("a non-boolean enabled reads as unset", (await junk.enabled()) === null);

    try {
      await store.save("yes");
      check("save refuses non-boolean input", false);
    } catch {
      check("save refuses non-boolean input", true);
    }

    await reopened.forget();
    check("forget returns to the config default",
      (await reopened.enabled()) === null && (await reopened.isSet()) === false);
  } catch (error) {
    fail("provider switch store", error);
  } finally {
    restoreHome();
    restoreEnv();
  }
}

// --- 10a. ADR-006: the write side never clobbers a foreign version ---------
// Group 10 proved the READ side treats a foreign version as unset. This is the
// other half: the WRITE side must refuse to overwrite a file it cannot read,
// and it must say so (a `degrade` marker, not a silent no-op). Without this, a
// build running an OLDER store format would read a NEWER build's file as
// "unset", then save() and stomp the newer data we cannot even see.
{
  const restoreEnv = isolateHostEnv();
  const restoreHome = isolateStateDir();
  try {
    const dir = join(process.env.DSH_HOME, "state", "dsh-sensenova-suite");
    const file = join(dir, "provider.json");
    // Unlike group 10, the very first act here is a write, so the state dir does
    // not exist yet (group 10 reached its writes only after a save() had
    // created it). Create it up front.
    mkdirSync(dir, { recursive: true });
    const foreignPayload = { version: 999, enabled: false, futureField: "x" };

    // save() on a foreign-version file must be refused: the file is intact, the
    // switch stays unset, the refusal is logged, AND it surfaces to the caller
    // — this is an explicit user action, so the route answers `ok:false` and
    // the panel shows why (the audit's support trap: silence once left a
    // switch that appeared to work).
    writeFileSync(file, JSON.stringify(foreignPayload, null, 2), "utf8");
    const warnings = [];
    const guarded = createFileProviderStore({ dir, logger: { warn: (m) => warnings.push(m) } });
    let saveRefused = null;
    try {
      await guarded.save(true);
    } catch (error) {
      saveRefused = String(error?.message ?? error);
    }
    check("save() refuses a foreign version out loud, not silently",
      saveRefused !== null && saveRefused.includes("refusing to overwrite provider.json") && saveRefused.includes("version 999"),
      String(saveRefused));

    const afterSave = JSON.parse(readFileSync(file, "utf8"));
    check("save() does not overwrite a foreign version", afterSave.version === 999 && afterSave.futureField === "x",
      JSON.stringify(afterSave));
    check("save() leaves the switch unset after a refusal",
      (await guarded.enabled()) === null && (await guarded.isSet()) === false);
    check("the refusal is logged, not silent",
      warnings.some((w) => w.includes("refusing to overwrite provider.json") && w.includes("version 999")),
      warnings.join(" | "));
    check("a refusal with no underlying error does not log a bogus ': null'",
      warnings.every((w) => !w.includes(": null")),
      warnings.join(" | "));

    // forget() is the second writer; it must pass through the same guard.
    const warnings2 = [];
    const guarded2 = createFileProviderStore({ dir, logger: { warn: (m) => warnings2.push(m) } });
    let forgetRefused = null;
    try {
      await guarded2.forget();
    } catch (error) {
      forgetRefused = String(error?.message ?? error);
    }
    const afterForget = JSON.parse(readFileSync(file, "utf8"));
    check("forget() does not overwrite a foreign version",
      afterForget.version === 999 && afterForget.futureField === "x", JSON.stringify(afterForget));
    check("forget() surfaces the refusal too",
      forgetRefused !== null && forgetRefused.includes("refusing to overwrite provider.json"),
      String(forgetRefused));

    // The guard must not trip on the file's own (known) version: a normal write
    // still lands, so the switch keeps working for every build that owns the
    // current format.
    writeFileSync(file, JSON.stringify({ version: PROVIDER_VERSION, enabled: false }, null, 2), "utf8");
    const normal = createFileProviderStore({ dir });
    await normal.save(true);
    const afterNormal = JSON.parse(readFileSync(file, "utf8"));
    check("a known version still writes normally",
      afterNormal.version === PROVIDER_VERSION && afterNormal.enabled === true, JSON.stringify(afterNormal));

    // The guard's reason string is load-bearing: a rename would silently drop
    // it and turn the refusal back into a no-op. Pin the literal in the source
    // the same way draw.test.mjs pins its `degrade` markers.
    const source = readFileSync(new URL("../src/host/provider-store.ts", import.meta.url), "utf8");
    const switchFactory = readFileSync(new URL("../src/host/switch-store.ts", import.meta.url), "utf8");
    const factory = readFileSync(new URL("../src/host/state-store.ts", import.meta.url), "utf8");
    // The ADR-006 refusal phrase lives in the shared WRITE factory
    // (state-store.createVersionedJsonWriter); the shared READ-side factory
    // (switch-store.createSwitchStore) wires that guard for all four switches;
    // each switch still registers its OWN label + version set. Pin all three so
    // a future edit cannot silently retarget or downgrade the guard.
    check("the refusal marker stays in the source",
      factory.includes("refusing to overwrite") &&
      factory.includes("this build knows") &&
      switchFactory.includes("createVersionedJsonWriter(") &&
      source.includes('label: "provider"') &&
      source.includes("KNOWN_PROVIDER_VERSIONS") &&
      source.includes("createSwitchStore"), "");
  } catch (error) {
    fail("ADR-006 write-side version guard", error);
  } finally {
    restoreHome();
    restoreEnv();
  }
}

// --- 11. api key store: env fallback with no service ------------------------
{
  const restoreEnv = isolateHostEnv();
  try {
    const store = createApiKeyStore({ credentials: null, env: { SENSENOVA_API_KEY: "sk-env" } });
    const resolved = await store.resolve();
    check("env provides the key when no service exists",
      resolved.value === "sk-env" && resolved.source === "env");
    const state = await store.state();
    check("state reports hasApiKey + env source + ephemeral host",
      state.hasApiKey === true && state.keySource === "env" && state.ephemeral === true);
  } catch (error) {
    fail("env fallback", error);
  } finally {
    restoreEnv();
  }
}

// --- 11. api key store: memory save/validate/forget without a service -------
{
  const restoreEnv = isolateHostEnv(["SENSENOVA_API_KEY"]);
  try {
    const store = createApiKeyStore({ credentials: null, env: {} });
    check("no key anywhere resolves empty/null source",
      (await store.resolve()).source === null && (await store.state()).hasApiKey === false);

    let threw = false;
    try { await store.save("   "); } catch { threw = true; }
    check("a whitespace-only key is rejected", threw);

    await store.save("  sk-memory  ");
    const resolved = await store.resolve();
    check("a saved key is stored verbatim (no trim)", resolved.value === "  sk-memory  " &&
      resolved.source === "memory");

    await store.forget();
    check("forget clears the in-memory copy", (await store.resolve()).source === null);
  } catch (error) {
    fail("memory save/forget", error);
  } finally {
    restoreEnv();
  }
}

// --- 12. credentials service: precedence, persistence name, resolver --------
{
  const restoreEnv = isolateHostEnv();
  try {
    const refs = new Map();
    const service = {
      async resolve(ref) { const value = refs.get(ref); return value === undefined ? undefined : { value }; },
      async set(ref, value) { refs.set(ref, value); },
      async unset(ref) { refs.delete(ref); }
    };
    const store = createApiKeyStore({ credentials: () => service, env: { SENSENOVA_API_KEY: "sk-env" } });

    check("env still serves before a panel save", (await store.resolve()).source === "env");
    check("state says the host is not ephemeral with a service", (await store.state()).ephemeral === false);

    await store.save("sk-panel");
    check("the panel value lands under the shared reference name", refs.get(API_KEY_REF) === "sk-panel");
    const resolved = await store.resolve();
    check("a stored reference wins over the env fallback",
      resolved.value === "sk-panel" && resolved.source === "credentials");

    await store.forget();
    check("forget removes the reference but leaves the env value standing",
      !refs.has(API_KEY_REF) && (await store.resolve()).source === "env");
  } catch (error) {
    fail("credentials service precedence", error);
  } finally {
    restoreEnv();
  }
}

// --- 13. a failing/absent credentials service falls through safely ----------
{
  const restoreEnv = isolateHostEnv();
  try {
    const flaky = {
      async resolve() { throw new Error("credentials file locked"); },
      async set() { throw new Error("credentials file locked"); },
      async unset() { throw new Error("credentials file locked"); }
    };
    const store = createApiKeyStore({ credentials: flaky, env: { SENSENOVA_API_KEY: "sk-env" } });
    const resolved = await store.resolve();
    check("a throwing resolve falls through to env", resolved.source === "env" && resolved.value === "sk-env");

    let threw = false;
    try { await store.save("sk-x"); } catch { threw = true; }
    check("a save the service refuses propagates (route reports it, no silent loss)", threw);

    // A service whose READS throw offers no proof a durable copy exists, so
    // forget degrades to the quiet in-memory delete (the §13 shape: "the key
    // was never stored anyway"). The case that must NOT stay quiet — an unset
    // refused while the service still HOLDS a value — is pinned in §13b below.
    await store.forget();
    check("forget survives a throwing service", (await store.resolve()).source === "env");
  } catch (error) {
    fail("service failure fall-through", error);
  } finally {
    restoreEnv();
  }
}

// --- 13b. api key store: a refused unset must not read as a clean forget ----
// `resolve()` reads the credentials service FIRST, so a `forget()` that swallows
// a failed unset would be followed by the very key it "removed" coming back as
// `source: "credentials"`. The failure now propagates to the route (ok:false);
// only the no-proof cases (no service / unreadable / nothing held) stay quiet.
{
  const restoreEnv = isolateHostEnv();
  try {
    const refs = new Map();
    refs.set(API_KEY_REF, "sk-durable");
    const service = {
      async resolve(ref) { const value = refs.get(ref); return value === undefined ? undefined : { value }; },
      async set(ref, value) { refs.set(ref, value); },
      async unset() { throw new Error("credentials service refused the unset"); }
    };
    const store = createApiKeyStore({ credentials: () => service, env: {} });

    check("before the forget, the durable copy is what resolve serves",
      (await store.resolve()).source === "credentials");

    let threw = null;
    try { await store.forget(); } catch (error) { threw = error; }
    check("a refused unset with a held value propagates (the route answers ok:false)",
      threw !== null && /refused the unset/.test(String(threw.message)), String(threw));
    check("the durable copy survives, still visible to the panel",
      (await store.resolve()).source === "credentials" && refs.get(API_KEY_REF) === "sk-durable");

    // The quiet path must be unperturbed: nothing held means nothing to unset.
    refs.delete(API_KEY_REF);
    await store.forget();
    check("an unset with no durable value stays a clean forget",
      (await store.state()).hasApiKey === false, JSON.stringify(await store.state()));
  } catch (error) {
    fail("api-key forget failure propagation", error);
  } finally {
    restoreEnv();
  }
}

// --- 14. redactSecrets: a credential never reaches the panel or a log ------
// The LLM route's `providerState.error` and `ctx.logger.warn` both pass
// through `redactSecrets`, because an HTTP error object's `message` often
// embeds the request headers it was built from. Pin the patterns it must
// catch, and the texts it must leave alone.
{
  try {
    check("a bare sk- key is redacted",
      redactSecrets("cannot build: sk-a1b2c3d4e5f6g7h8") === "cannot build: sk-[REDACTED]",
      redactSecrets("cannot build: sk-a1b2c3d4e5f6g7h8"));
    check("a Bearer token is redacted",
      redactSecrets("Authorization: Bearer abc.def.ghi.jkl") === "Authorization: Bearer [REDACTED]",
      redactSecrets("Authorization: Bearer abc.def.ghi.jkl"));
    check("an Authorization header value is redacted",
      redactSecrets('request failed with "authorization": "sk-xxx123456"')
        === 'request failed with "authorization": "[REDACTED]"',
      redactSecrets('request failed with "authorization": "sk-xxx123456"'));
    check("a JSON api_key pair is redacted",
      redactSecrets('{"api_key":"sk-live-123456789"}') === '{"api_key":"[REDACTED]"}',
      redactSecrets('{"api_key":"sk-live-123456789"}'));
    // The unquoted value shape: `{ accessToken: eyJ… }`. Every quoted-pair rule
    // needs a quote to anchor the value, so this slipped through them all — and
    // it is exactly what `util.inspect` / `String(obj)` produce when something
    // interpolates the credential record it was handed, i.e. precisely what a
    // failed `saveCredential` throws. Reached the panel intact via
    // `raccoon-walk.ts` → `takeEvent()` → `loginError`.
    check("an UNQUOTED secret value (util.inspect shape) is redacted",
      !/eyJhbGciOi/.test(redactSecrets("failed to store { accessToken: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig, refreshToken: rt-abcdef123456 }")),
      redactSecrets("failed to store { accessToken: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig, refreshToken: rt-abcdef123456 }"));
    // The inverse, and the reason the rule above skips non-secret values: an
    // absent field reported as `null` IS the diagnosis. Redacting it would
    // destroy the only clue that the token was never set.
    check("a null/undefined secret field keeps its diagnostic value",
      redactSecrets("{ accessToken: null, refreshToken: undefined }")
        === "{ accessToken: null, refreshToken: undefined }",
      redactSecrets("{ accessToken: null, refreshToken: undefined }"));
    // Basic auth: that base64 IS a decodable user:password, and the user is
    // the console account name. The old rule order redacted the SCHEME word and
    // left the payload standing behind it — a redacted-looking line that still
    // carried the credential.
    check("a Basic authorization payload is redacted (it decodes to user:password)",
      !/dXNlcjpwYXNz/.test(redactSecrets("Authorization: Basic dXNlcjpwYXNzMTIzNDU=")),
      redactSecrets("Authorization: Basic dXNlcjpwYXNzMTIzNDU="));
    // Cookies are session credentials (the OIDC walk's CSRF cookie among them),
    // and a jar is `a=1; b=2` — redacting up to the first separator would leave
    // every cookie but the first one standing.
    check("a Cookie header is redacted whole, not only its first entry",
      !/abc123|xyz789/.test(redactSecrets("Cookie: oauth2_authentication_csrf=abc123; sid=xyz789")),
      redactSecrets("Cookie: oauth2_authentication_csrf=abc123; sid=xyz789"));
    check("a code_verifier pair is redacted",
      redactSecrets("login failed: code_verifier=VERIFIERVALUE_1234")
        === "login failed: code_verifier=[REDACTED]",
      redactSecrets("login failed: code_verifier=VERIFIERVALUE_1234"));
    // Separator-agnostic keys: a platform that spells the same field camelCase
    // must not slip past a snake_case-shaped rule.
    check("a camelCase token key is redacted",
      redactSecrets('{"accessToken":"AT.secret"}') === '{"accessToken":"[REDACTED]"}',
      redactSecrets('{"accessToken":"AT.secret"}'));
    // A token with NO key name in front of it. Rules 5/6/7 match on the key
    // name, so a token that arrives under a name this list never anticipated
    // (`jwt`, `id_token`, `session`, a renamed field) would sail through —
    // and that is the shape an upstream 4xx body quotes back when it rejects
    // a request. The access token IS a JWT (`readJwtExpiry` parses it), so
    // the value's shape is matched too.
    check("a bare JWT is redacted even with no key name in front of it",
      redactSecrets("request rejected, token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlX2hlcmU")
        === "request rejected, token [REDACTED]",
      redactSecrets("request rejected, token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJlX2hlcmU"));
    // Non-secret text passes through unchanged — the gate must not eat
    // diagnostic detail that has nothing to do with credentials.
    check("a credential-free error message passes through",
      redactSecrets("the llm peer packages ship with the Host")
        === "the llm peer packages ship with the Host");
    check("non-string input reads as empty", redactSecrets(undefined) === "" && redactSecrets(null) === "");
  } catch (error) {
    fail("redactSecrets strips credentials", error);
  }
}

// --- 12. syncSignaturesAfterPublish: the direct-publish invariant ----------
// After a route publishes an offer straight to the provider (bypassing the
// poll's change-detection), the signatures must track what was offered, so the
// next poll does not see a "change" and rebuild. This locks that contract and
// keeps the formulas identical to the poll's (a divergence here is a churn bug).
{
  const state = {
    entries: [{ id: "a" }, { id: "b" }],
    enabledIds: ["a"],
    unavailableIds: ["b", "a"],
    signature: "",
    quotaSignature: ""
  };
  try {
    syncSignaturesAfterPublish(state);
    check("signature mirrors catalogSignature of the offered set",
      state.signature === catalogSignature(state.entries, state.enabledIds));
    check("quotaSignature mirrors the sorted unavailable ids",
      state.quotaSignature === ["a", "b"].join(","));
    check("sync never mutates the offer fields",
      state.entries.length === 2 && state.enabledIds.length === 1
        && Array.isArray(state.unavailableIds));
    // Defensive: a half-built state must not throw or claim a bogus signature.
    // The catalog signature of an empty offer is "|" (catalogSignature's shape),
    // not "" — matching what the poll would compute, so no churn on empty.
    const blank = {};
    syncSignaturesAfterPublish(blank);
    check("a blank state syncs to empty-offer signatures without throwing",
      blank.signature === catalogSignature([], []) && blank.quotaSignature === "");
  } catch (error) {
    fail("syncSignaturesAfterPublish keeps the offer in lock-step", error);
  }
}

// === the shared control plane: one copy, or§5.5 quietly stops holding =====
// `publish-core.ts` exists for exactly one reason: the publish queue, the
// `disposed` gate and the single-point register-that-doubles-as-rollback must
// NOT differ between the two upstreams (ARCHITECTURE.md §5.5). The module
// header says so in prose, and the publisher's header points at it — but a
// comment cannot fail, so the day someone re-inlines a queue locally to
// "fix" something, every suite stays green while
// the rollback path quietly becomes upstream-specific. Rollback is the worst
// place to discover that: it only runs after something has already failed.
//
// So this asserts the sharing structurally — the publisher must CALL the
// shared factories, and may not hold its own copy of the three.
{
  const read = (name) => readFileSync(join(HOST_SRC, name), "utf8");
  const core = read("publish-core.ts");
  const tokenPlan = read("provider-publish.ts");
  const shared = ["createPublishQueue", "createPairReleaser", "registerProviderPair"];
  try {
    check("publish-core.ts declares the three load-bearing pieces",
      shared.every((fn) => new RegExp(`export function ${fn}\\b`).test(core)),
      shared.filter((fn) => !new RegExp(`export function ${fn}\\b`).test(core)).join(", "));
    // The publisher must import AND call each one.
    const drift = [{ side: "Token Plan", src: tokenPlan }]
      .flatMap(({ side, src }) => shared
        .filter((fn) => !(new RegExp(`import[\\s\\S]{0,400}?\\b${fn}\\b`).test(src) && new RegExp(`${fn}\\s*\\(`).test(src)))
        .map((fn) => `${side}: ${fn}`));
    check("the publisher calls the shared queue / releaser / register",
      drift.length === 0, drift.join(", ") || "uses all three");
    // …and it may not define its own. A local `function createPublishQueue`
    // shadowing the import is the exact shape of the drift this guards.
    const local = [{ side: "Token Plan", src: tokenPlan }].flatMap(({ side, src }) => shared
      .filter((fn) => new RegExp(`(?:function|const)\\s+${fn}\\b`).test(src))
      .map((fn) => `${side}: ${fn}`));
    check("the publisher defines no local copy of a shared piece",
      local.length === 0, local.join(", "));
    // The gate itself: `disposed` must live in the queue, not in the publisher.
    check("the disposed gate lives in the shared queue, not in a publisher",
      /disposed/.test(core) && !/let disposed\s*=\s*false/.test(tokenPlan),
      "the publisher grew its own disposed flag — the gate is shared or it is not");
  } catch (error) {
    fail("the publish control plane is shared", error);
  }
}

// --- the per-model output-ceiling override (the deployment knob) -----------
// Precedence: override > catalogue `max_output_length` > UNDECLARED. The order
// is ONE judgment (maxTokensForId) read from BOTH sides — the panel roster and
// the adapter's resolveModel (`defaultMaxTokens`) — so the badge and the wire
// cannot disagree. An override for an id with no catalogue figure still lands
// (that is the docs-first point: the catalogue can UNDERSTATE; kimi-k3's
// 131072 rides on it). A roster
// that kept quoting the catalogue while the wire carried the override is the
// exact two-sources drift this plugin pins everywhere else.
{
  try {
    const entry = { id: "deepseek-v4-flash", max_output_length: 65536 };
    const pools = { pools: [] };

    check("with no override the catalogue ceiling is the roster figure",
      maxTokensFor(entry, {}) === 65536, String(maxTokensFor(entry, {})));

    check("an override WINS over the catalogue figure",
      maxTokensForId("deepseek-v4-flash", 65536, { "deepseek-v4-flash": 131072 }) === 131072,
      String(maxTokensForId("deepseek-v4-flash", 65536, { "deepseek-v4-flash": 131072 })));

    const plain = rosterWithAvailability([entry], pools).find((row) => row.id === "deepseek-v4-flash");
    const overridden = rosterWithAvailability([entry], pools, { "deepseek-v4-flash": 131072 }).find((row) => row.id === "deepseek-v4-flash");
    check("the roster badge quotes the catalogue figure when there is no override",
      plain?.maxOutputLength === 65536, String(plain?.maxOutputLength));
    check("the roster badge quotes the OVERRIDE (panel and wire cannot disagree)",
      overridden?.maxOutputLength === 131072, String(overridden?.maxOutputLength));

    check("maxTokensFor is the one resolver both readers call",
      maxTokensFor(entry, { "deepseek-v4-flash": 131072 }) === 131072 &&
        maxTokensFor(entry, {}) === 65536 &&
        maxTokensFor({ id: "kimi-k3" }, {}) === 0 &&
        maxTokensFor({ id: "kimi-k3" }, null) === 0,
      `override=${maxTokensFor(entry, { "deepseek-v4-flash": 131072 })} catalogue=${maxTokensFor(entry, {})} undeclared=${maxTokensFor({ id: "kimi-k3" }, {})}`);

    // The wire half of the same order (U6 ledger D1): the adapter resolves the
    // REQUEST ceiling through maxTokensForId with the same map, so the roster
    // badge and the `defaultMaxTokens` on the wire are one judgment.
    check("maxTokensForId: an override for THIS id can declare a ceiling the catalogue never stated",
      maxTokensForId("kimi-k3", undefined, { "kimi-k3": 131072 }) === 131072,
      String(maxTokensForId("kimi-k3", undefined, { "kimi-k3": 131072 })));
    check("maxTokensForId: an override for another id does not leak; the catalogue figure stands",
      maxTokensForId("kimi-k3", 65536, { "deepseek-flash": 393216 }) === 65536,
      String(maxTokensForId("kimi-k3", 65536, { "deepseek-flash": 393216 })));
    check("maxTokensForId: a non-positive/fractional override is ignored, not sent",
      maxTokensForId("m", 65536, { m: 0 }) === 65536 && maxTokensForId("m", 65536, { m: 1.5 }) === 65536,
      String(maxTokensForId("m", 65536, { m: 0 })));
    check("maxTokensForId: nothing declared anywhere reads undefined (the adapter leaves defaultMaxTokens off)",
      maxTokensForId("m", undefined, {}) === undefined && maxTokensForId("m", 0, { other: 1 }) === undefined,
      String(maxTokensForId("m", undefined, {})));
    check("maxTokensForId: a null overrides map falls through to the catalogue",
      maxTokensForId("m", 65536, null) === 65536,
      String(maxTokensForId("m", 65536, null)));

    // The wiring, pinned at source: deleting either half restores the
    // "badge quotes a ceiling no request can send" split without any
    // behavior test noticing.
    const adapterSource = readFileSync(new URL("../src/host/adapter.ts", import.meta.url), "utf8");
    const factorySource = readFileSync(new URL("../src/host/llm-adapter.ts", import.meta.url), "utf8");
    check("the adapter resolves the wire ceiling through maxTokensForId with the live map",
      adapterSource.includes("maxTokensForId(model, entry?.maxOutputTokens, this.deps.maxTokensOverrides?.())") &&
      !adapterSource.includes("const DEFAULT_CONTEXT_WINDOW"),
      "resolveModel wiring");
    check("the adapter parser shares the panel's field-spelling tables (one list, one order)",
      adapterSource.includes("firstPositiveNumber(raw, CONTEXT_WINDOW_FIELDS)") &&
      adapterSource.includes("firstPositiveNumber(raw, MAX_OUTPUT_FIELDS)"),
      "shared spelling lists");
    check("the factory threads maxTokensOverrides into the adapter deps",
      factorySource.includes("maxTokensOverrides: () => maxTokensOverrides ?? null"),
      "factory wiring");
  } catch (error) {
    fail("the per-model output-ceiling override", error);
  }
}

// --- build failure vs registration failure: what the offer fields do -------
// The asymmetry is the DESIGN (U6 ledger S2/δ + T2): a REGISTRATION failure
// rolls the domain fields back to the previous pair (the offer must describe
// what is really serving), while a BUILD failure keeps the NEW values — the
// same "user intent survives" semantics as the switch-off branch, so a save
// made while the build was broken is not discarded. Retry cadence is
// signature-driven and independent of these fields (failed publishes never
// sync signatures), so this pin locks the asymmetry itself.
{
  const boomFactory = async () => ({ createSensenovaAdapter: () => { throw new Error("factory boom"); } });
  const regBoomFactory = async () => ({
    createSensenovaAdapter: () => ({ providerIds: ["sensenova-suite"], adapter: { fake: true } })
  });
  try {
    const buildFail = createProviderPublisher({
      settings: { registerProvider: true },
      loadAdapterModule: boomFactory,
      getLlm: () => ({ registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {} })
    });
    const r1 = await buildFail.publish([{ id: "m-a" }], ["m-a"], []);
    check("a BUILD failure keeps the new offer fields (user intent survives)",
      r1.ok === false && buildFail.state.entries.length === 1 &&
      buildFail.state.enabledIds[0] === "m-a" && /factory boom/.test(String(buildFail.state.error)),
      JSON.stringify({ ok: r1.ok, entries: buildFail.state.entries.length, ids: buildFail.state.enabledIds, err: buildFail.state.error }));

    const regFail = createProviderPublisher({
      settings: { registerProvider: true },
      loadAdapterModule: regBoomFactory,
      getLlm: () => ({ registerAdapter: () => { throw new Error("register boom"); } })
    });
    const r2 = await regFail.publish([{ id: "m-b" }], ["m-b"], []);
    check("a REGISTRATION failure rolls the offer fields back to the previous pair",
      r2.ok === false && regFail.state.entries.length === 0 && regFail.state.enabledIds.length === 0 &&
      regFail.state.registered === false && /register boom/.test(String(regFail.state.error)),
      JSON.stringify({ ok: r2.ok, entries: regFail.state.entries.length, ids: regFail.state.enabledIds, err: regFail.state.error }));
  } catch (error) {
    fail("build-failure vs registration-failure offer fields", error);
  }
}

// --- T3: the wire half of the ceiling order, exercised at runtime ----------
// maxTokensForId and the wiring are pinned above at unit/source level; this
// island constructs the REAL adapter (peer-dependent: `LlmAdapter` base +
// `LlmError` come from `@deepseek-ai/dsh-llm`) and calls resolveModel, so the
// deps closure -> maxTokensForId -> defaultMaxTokens composition is EXERCISED,
// not just read. A module-resolution failure loud-skips (the same structural
// skip as routes.test: no candidate root carries the peer on this machine);
// ANY other import error fails — a broken adapter must not hide behind the
// skip. (U6 ledger T3: the last unpinned half of the override chain.)
{
  let adapterMod = null;
  let skipReason = "";
  try {
    adapterMod = await import("../src/host/adapter.ts");
  } catch (error) {
    const message = String(error?.message ?? error);
    if (error?.code === "ERR_MODULE_NOT_FOUND" || message.includes("@deepseek-ai/dsh-llm")) {
      skipReason = message.slice(0, 120);
    } else {
      fail("T3 the adapter module failed to import (not a peer gap)", error);
    }
  }
  if (adapterMod !== null) {
    try {
      const { SensenovaAdapter } = adapterMod;
      const mk = (overrides) => new SensenovaAdapter({
        options: () => ({ apiBase: "https://token.sensenova.cn/v1", accountCount: 1, concurrency: 1 }),
        resolveApiKey: async () => "sk-test",
        resolveApiKeyForRequest: async () => "sk-test",
        requestSlot: async () => () => {},
        rotateApiKey: async () => { throw new Error("unused in this pin"); },
        maxTokensOverrides: () => overrides
      });
      const seeded = mk({ "deepseek-flash": 393216 });
      // resolveModel reads this.catalog; seed it directly (fetchCatalog is the
      // networked path) — the ceiling ORDER is what is under test here.
      seeded.catalog = [
        { id: "deepseek-flash", name: "deepseek-flash", maxOutputTokens: 65536 },
        { id: "glm-5.2", name: "glm-5.2" }
      ];
      const withOverride = await seeded.resolveModel("sensenova-suite", "deepseek-flash");
      check("T3 the override rides resolveModel as defaultMaxTokens (catalogue understates, docs win)",
        withOverride.defaultMaxTokens === 393216, String(withOverride.defaultMaxTokens));
      const other = await seeded.resolveModel("sensenova-suite", "glm-5.2");
      check("T3 an entry with no override and no figure stays undeclared (no leak)",
        !Object.prototype.hasOwnProperty.call(other, "defaultMaxTokens"), JSON.stringify(other));
      const bare = mk(null);
      bare.catalog = [{ id: "deepseek-flash", name: "deepseek-flash", maxOutputTokens: 65536 }];
      const noOverride = await bare.resolveModel("sensenova-suite", "deepseek-flash");
      check("T3 without overrides the catalogue figure rides through",
        noOverride.defaultMaxTokens === 65536, String(noOverride.defaultMaxTokens));
    } catch (error) {
      fail("T3 resolveModel runtime pin", error);
    }
  } else {
    check("T3 resolveModel runtime pin loud-skipped (peer not resolvable here)",
      true, skipReason);
  }
}

finish();
