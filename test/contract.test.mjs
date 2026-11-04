/**
 * The frozen SenseNova inference contract — peer-free offline gate.
 *
 * `test/baselines/sensenova-contract.json` pins the 2026-09-29 live probe of
 * `https://token.sensenova.cn/v1` (9 catalog models, thinking-field dialects,
 * reasoning_effort support surface, sampling parameters, modality fields).
 * This suite asserts that the code the panel and the provider run
 * (`llm-models.js` descriptors / vision / chat / quota logic, `parsers.js`
 * normalization, `codes.js` 429/quota classification) still matches that
 * frozen contract. A red here means the CODE drifted from the platform
 * dialect, not the platform changed — the platform side is covered by
 * `test/live-contract.mjs` (manual, `npm run test:live:contract`).
 *
 * Everything here imports no Host peer, so the contract stays covered on a
 * clean checkout. The baseline JSON is the single source of truth for the
 * dialect facts; `docs/SENSENOVA-API.md` §7 is the human-readable mirror.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isChatModel,
  exhaustedModelIds,
  contextWindowOf,
  rosterWithAvailability,
  thinkingLevelMapFor,
  LLM_PROVIDER_ID,
  KNOWN_UNROUTABLE_MODELS
} from "../src/host/llm-models.ts";
import { credits, epochSeconds, parsePools, parseTrend, checkShape, identifyVisionModel } from "../src/host/parsers.ts";
import { retryableCodes, QUOTA_CODES } from "../src/host/llm-retry.ts";
import { isCredentialRefusal, CODE } from "../src/host/codes.ts";
import { results, check, fail } from "./harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  readFileSync(join(ROOT, "test", "baselines", "sensenova-contract.json"), "utf8")
);
const baseUrl = contract.meta.baseUrl;

// The pin is load-bearing DATA, and this suite's coverage is a function of it:
// most of the checks below are `for (const model of contract.models)`, so a
// truncated pin does not FAIL them — it DELETES them, and the survivors still
// print a green summary. Emptying the array today trips two id-specific checks
// further down, so the suite is red — but by accident, and only for a total
// wipe; dropping some models shrinks coverage silently. The header above states
// the shape ("9 catalog models"); pin it here the way every other scan in this
// repo pins its input. Raising these floors is a deliberate act when re-pinning.
check("the contract pin carries the probed catalog", contract.models.length >= 9, `${contract.models.length} model(s)`);
check("the contract pin carries the chat models",
  contract.models.filter((m) => m.chat === true).length >= 7,
  `${contract.models.filter((m) => m.chat === true).length} chat model(s)`);


// --- 1. catalog entry shape from the contract ----------------------------
// The contract's `models` entries are the normalized catalog rows
// (`console-client.js` keeps each `/v1/models` row whole, plus the plugin's
// `id`). Build them exactly the way the provider would see them.
function entryFor(model) {
  return {
    id: model.id,
    input_modalities: model.visionInput ? ["text", "image"] : ["text"],
    output_modalities: model.imageGen ? ["image"] : ["text"],
    ...(model.contextLength !== undefined ? { context_length: model.contextLength } : {}),
    ...(model.maxOutputLength !== undefined ? { max_output_length: model.maxOutputLength } : {})
  };
}

// --- 2. the thinking map against the frozen contract ----------------------
// (The pi-ai descriptor build this section once pinned was removed 2026-10-31
// with the wire adapter serving listModels directly; the per-model DIALECT
// decisions survive in thinkingLevelMapFor and are pinned here per contract
// model.)
for (const model of contract.models) {
  if (model.chat !== true) continue; // 404/403 models are asserted in §3
  try {
    const entry = entryFor(model);
const map = thinkingLevelMapFor(entry);
    check(`${model.id} thinkingLevelMap.off === "none" (platform off spelling)`,
      map.off === "none", JSON.stringify(map));
    // reasoning_effort dialect: 2026-10-26 用户拍板——只含 off + low + medium +
    // high + max；xhigh/minimal 彻底移除（默认档位只按原生档位）。
    check(`${model.id} thinkingLevelMap.max === "max" (platform accepts it since 2026-10-24)`,
      map.max === "max", JSON.stringify(map.max));
    check(`${model.id} thinkingLevelMap.xhigh is undefined (2026-10-26: removed)`,
      map.xhigh === undefined, JSON.stringify(map.xhigh));
    check(`${model.id} thinkingLevelMap.low === "low" (open for self-selection)`,
      map.low === "low", JSON.stringify(map.low));
    check(`${model.id} thinkingLevelMap.medium === "medium" (open for self-selection)`,
      map.medium === "medium", JSON.stringify(map.medium));
    check(`${model.id} thinkingLevelMap.minimal is undefined (2026-10-26: removed)`,
      map.minimal === undefined, JSON.stringify(map.minimal));
  } catch (error) { fail(`${model.id} thinking map`, error); }
}

// --- 3. isChatModel excludes the image-generation + 404/403 models -------
for (const model of contract.models) {
  const entry = entryFor(model);
  if (model.imageGen === true) {
    check(`${model.id} (image-gen) is NOT a chat model (excluded from picker)`,
      isChatModel(entry) === false, "isChatModel should be false");
  }
  if (model.status === "404" || model.status === "403") {
    // 404/403 models are still catalog rows; the panel greys them via
    // `exhaustedModelIds` only when their POOL is depleted, not when the
    // endpoint 404s. The contract records them as non-chat (image-gen 404)
    // or as a plan-restriction (403). Assert the code agrees on the
    // image-gen 404 family: `output_modalities:["image"]` is the load-bearing
    // signal, not the status code.
    if (model.imageGen === true) {
      check(`${model.id} (404 image-gen) is excluded from the chat offer`,
        isChatModel(entry) === false, "isChatModel should be false");
    }
  }
}

// --- 4. identifyVisionModel mirrors the contract's visionInput ------------
for (const model of contract.models) {
  const entry = entryFor(model);
  const verdict = identifyVisionModel(entry);
  check(`${model.id} identifyVisionModel.vision matches contract`,
    verdict.vision === (model.visionInput === true),
    JSON.stringify({ got: verdict.vision, want: model.visionInput === true }));
}

// --- 5. the panel offer matches the contract ------------------------------
// The offer is every chat model NOT in a depleted pool, minus the
// KNOWN_UNROUTABLE_MODELS set. `isChatModel` is PERMISSIVE (a missing/unknown
// `output_modalities` is treated as chat), but since 2026-10-27 the
// known-uncallable ids are dropped at every offer exit — today the adapter's
// own `parseCatalog` and the snapshot's `offered` subtraction (U6 ledger D1
// removed the descriptor builder these checks used to drive); the projection
// under test here is `rosterWithAvailability`, the panel's tickable rows. The
// image-gen U-series (404) is the only family excluded by modality.
{
  const allEntries = contract.models.map(entryFor);
  // No pool depletion, no allow-list: the panel projects every chat model the
  // contract marks `chat: true`, minus the known-uncallable set (that set is
  // subtracted ABOVE the projection — snapshot exit / adapter parse).
  const chatIds = contract.models
    .filter((m) => m.chat === true && !KNOWN_UNROUTABLE_MODELS.has(m.id))
    .map((m) => m.id);
  const offered = rosterWithAvailability(
    allEntries.filter((e) => !KNOWN_UNROUTABLE_MODELS.has(e.id)), { pools: [] });
  const offeredIds = offered.map((d) => d.id);
  check("the roster offers exactly the contract's chat models (no pool depletion)",
    JSON.stringify(offeredIds) === JSON.stringify(chatIds),
    JSON.stringify({ offered: offeredIds, want: chatIds }));

  // The image-gen U-series (404 on the chat endpoint) is the only family the
  // picker excludes by modality: `output_modalities: ["image"]` is the
  // load-bearing signal. The known-uncallable ids are excluded by id, not by
  // modality.
  const imageGenIds = contract.models.filter((m) => m.imageGen === true).map((m) => m.id);
  check("the roster excludes every image-gen model from the offer",
    imageGenIds.every((id) => !offeredIds.includes(id)),
    JSON.stringify({ offered: offeredIds, imageGen: imageGenIds }));

  // A depleted pool covering `deepseek-v4-flash` must drop it from the offer
  // while the panel roster still lists it (greyed).
  const pools = parsePools({
    plan: { id: "p", name: "Token Plan", type: "monthly" },
    pools: [{
      id: "pool-1", name: "default", pool_type: "default",
      model_ids: ["deepseek-v4-flash"],
      window_5h: { limit: "100", used: "100", remaining: "0", reset_at: "1700000000" },
      window_7d: { limit: "1000", used: "500", remaining: "500", reset_at: "1700000000" }
    }]
  });
  const blocked = exhaustedModelIds(pools);
  check("exhaustedModelIds flags the depleted pool's models",
    JSON.stringify(blocked) === JSON.stringify(["deepseek-v4-flash"]),
    JSON.stringify(blocked));
  const offeredBlocked = rosterWithAvailability(allEntries, pools);
  check("the roster greys the quota-depleted model while the others stay available",
    offeredBlocked.find((d) => d.id === "deepseek-v4-flash")?.available === false &&
      offeredBlocked.find((d) => d.id === "deepseek-v4-pro")?.available === true,
    JSON.stringify(offeredBlocked.map((d) => ({ id: d.id, available: d.available }))));

  // Pool membership is not exclusive on the wire: a model with its own
  // dedicated pool is ALSO named in the general pool. A drained general pool
  // must not remove it while the dedicated pool still holds credit.
  const sharedPools = parsePools({
    plan: { id: "p", name: "Token Plan", type: "monthly" },
    pools: [
      {
        id: "pool-gen", name: "通用积分池", pool_type: "default",
        model_ids: ["deepseek-v4-flash", "deepseek-v4-pro"],
        window_5h: { limit: "60000", used: "60000", remaining: "0", reset_at: "1700000000" },
        window_7d: { limit: "600000", used: "128915", remaining: "471085", reset_at: "1700000000" }
      },
      {
        id: "pool-ded", name: "Flash-Lite积分池", pool_type: "dedicated",
        model_ids: ["deepseek-v4-flash"],
        window_5h: { limit: "60000", used: "0", remaining: "60000", reset_at: "1700000000" },
        window_7d: { limit: "600000", used: "69474", remaining: "530526", reset_at: "1700000000" }
      }
    ]
  });
  const sharedBlocked = exhaustedModelIds(sharedPools);
  check("a drained general pool does not block a model its dedicated pool still funds",
    JSON.stringify(sharedBlocked) === JSON.stringify(["deepseek-v4-pro"]),
    JSON.stringify(sharedBlocked));
  check("the roster keeps that model available while its dedicated pool has credit",
    rosterWithAvailability(allEntries, sharedPools)
      .find((d) => d.id === "deepseek-v4-flash")?.available === true,
    JSON.stringify(sharedBlocked));

  const bothDrained = parsePools({
    plan: { id: "p", name: "Token Plan", type: "monthly" },
    pools: [
      {
        id: "pool-a", name: "通用积分池", pool_type: "default",
        model_ids: ["deepseek-v4-flash"],
        window_5h: { limit: "60000", used: "60000", remaining: "0", reset_at: "1700000000" },
        window_7d: { limit: "600000", used: "1", remaining: "599999", reset_at: "1700000000" }
      },
      {
        id: "pool-b", name: "Flash-Lite积分池", pool_type: "dedicated",
        model_ids: ["deepseek-v4-flash"],
        window_5h: { limit: "60000", used: "1", remaining: "59999", reset_at: "1700000000" },
        window_7d: { limit: "600000", used: "600000", remaining: "0", reset_at: "1700000000" }
      }
    ]
  });
  check("a model is blocked only once every pool covering it is drained",
    JSON.stringify(exhaustedModelIds(bothDrained)) === JSON.stringify(["deepseek-v4-flash"]),
    JSON.stringify(exhaustedModelIds(bothDrained)));
}

// --- 6. parsers: the contract's numeric/epoch spellings -------------------
{
  check("credits() normalizes a string number (the platform's spelling)",
    credits("12345") === 12345, String(credits("12345")));
  check("credits() returns 0 for an absent value", credits(undefined) === 0, String(credits(undefined)));
  check("epochSeconds() reads a decimal-seconds STRING (not ms)",
    epochSeconds("1700000000") === 1700000000, String(epochSeconds("1700000000")));
  check("epochSeconds() returns null for absent/0",
    epochSeconds(null) === null && epochSeconds("0") === null,
    JSON.stringify([epochSeconds(null), epochSeconds("0")]));
  // The pool-usage shape the panel parses: a missing `pools` key is a drift.
  const drift = checkShape({ plan: { id: "p" } }, "pool-usage");
  check("checkShape flags a pool-usage body missing `pools` (drift, not 'no data')",
    drift.ok === false && drift.missing.includes("pools"), JSON.stringify(drift));
}

// --- 7. 429 / quota classification matches the frozen retry policy --------
{
  const codes = retryableCodes();
  check("retryableCodes keeps RATE_LIMIT (transient throttle self-clears)",
    codes.includes(QUOTA_CODES.rateLimit), JSON.stringify(codes));
  check("retryableCodes excludes QUOTA (depleted shared pool is not retried)",
    !codes.includes(QUOTA_CODES.quota), JSON.stringify(codes));
  check("retryableCodes excludes ACCOUNT_QUOTA",
    !codes.includes(QUOTA_CODES.accountQuota), JSON.stringify(codes));
  // A quota-shaped refusal is parked, never auto-retried (the credential
  // discipline the throttle-store enforces).
  check("isCredentialRefusal treats a parked quota refusal as non-retriable",
    isCredentialRefusal(CODE.LOGIN_REJECTED) === true,
    "login_rejected is the credential-shaped refusal");
}

// --- 8. vision model roster mirrors the contract's visionInput -----------
{
  const allEntries = contract.models.map(entryFor);
  // The vision LIST is asserted through `identifyVisionModel` in §4 against the
  // STRUCTURED field only (the platform's `input_modalities`), independent of a
  // model's 403/404 status. Count the vision chat models the picker offers:
  // every contract model with `chat: true` and `visionInput: true`.
  const visionChat = contract.models.filter((m) => m.chat === true && m.visionInput === true);
  const visionOffer = rosterWithAvailability(allEntries, { pools: [] })
    .filter((d) => d.vision === true);
  check("the vision offer count matches the contract's visionInput chat models",
    visionOffer.length === visionChat.length,
    `${visionOffer.length} vs ${visionChat.length}`);
}

// --- N. anthropic wire effort 出站词表（2026-10-27 真机 400 定版）------------
// 平台 400 原文：output_config.effort must be one of: low, medium, high, xhigh,
// max; got "off"。关闭思考的任何方言拼写（off/none/minimal）必须落
// thinking:{type:'disabled'}；词表外值绝不出现在 output_config。
{
  const { anthropicEffortOut } = await import("../src/host/wire/effort.ts");
  check("anthropic: 关闭思考（off）走 thinking:disabled，不发 effort",
    anthropicEffortOut("off").thinkingDisabled === true && anthropicEffortOut("off").effortWire === undefined);
  check("anthropic: chat 方言 none 同样走 thinking:disabled",
    anthropicEffortOut("none").thinkingDisabled === true && anthropicEffortOut("none").effortWire === undefined);
  check("anthropic: 静态表方言 minimal 同样走 thinking:disabled",
    anthropicEffortOut("minimal").thinkingDisabled === true);
  check("anthropic: 词表内档位走 output_config.effort",
    anthropicEffortOut("max").effortWire === "max" && anthropicEffortOut("high").effortWire === "high");
  check("anthropic: 词表外未知值不出站（不上桌让平台打 400）",
    anthropicEffortOut("ultra").effortWire === undefined && anthropicEffortOut("ultra").thinkingDisabled === false);
  check("anthropic: 未选档位两字段皆不发",
    anthropicEffortOut(undefined).effortWire === undefined && anthropicEffortOut(undefined).thinkingDisabled === false);

  // 拼写归一：面板 off / 静态表 minimal → chat·responses 方言的 none。
  // 旧实现只认 'none'：off 绕过 kimi 的 thinking:disabled 特判、responses 上
  // 整个省略 reasoning 字段（关闭静默变成「用默认」）。
  const { canonicalThinkingEffort } = await import("../src/host/wire/effort.ts");
  check("归一: 面板 off → none", canonicalThinkingEffort("off") === "none");
  check("归一: 静态表 minimal → none", canonicalThinkingEffort("minimal") === "none");
  check("归一: chat 方言 none 原样", canonicalThinkingEffort("none") === "none");
  check("归一: 实档位原样透传", canonicalThinkingEffort("low") === "low" && canonicalThinkingEffort("max") === "max");
  check("归一: 未选仍为未选", canonicalThinkingEffort(undefined) === undefined);
}

// --- 三线 usage → TokenUsage 映射（U2 审计 T2/T3，2026-11-01：此前三线零钉）---
// 减法口径的前提（input_tokens 已含 cached_tokens）是 glm /v1/responses 同 body
// 三发实测（usage.ts 头注）；an 线减法经 2026-11-01 真机探针判定 C 复核（直取
// 不减），本段 318-321 的钉即其定论。
{
  const { mapResponsesUsage, mapChatUsage, mapAnthropicUsage, mergeUsage } = await import("../src/host/wire/usage.ts");

  // responses：减法 + 字段条件展开 + total 回退。
  const r1 = mapResponsesUsage({ input_tokens: 4572, output_tokens: 64, total_tokens: 4636,
    input_tokens_details: { cached_tokens: 4352 }, output_tokens_details: { reasoning_tokens: 50 } });
  check("responses usage: input 减缓存读、total 直取平台值（含缓存口径）",
    r1.inputTokens === 220 && r1.outputTokens === 64 && r1.totalTokens === 4636
      && r1.cacheReadTokens === 4352 && r1.reasoningTokens === 50, JSON.stringify(r1));
  const r2 = mapResponsesUsage({ input_tokens: 100, output_tokens: 10, total_tokens: 0 });
  check("responses usage: total 缺失回退原始 input+output（与平台口径同含缓存）",
    r2.totalTokens === 110 && r2.cacheReadTokens === undefined, JSON.stringify(r2));

  // chat：与 responses 同为 OpenAI 口径——prompt_tokens 含缓存（减法）、details
  // 嵌套字段、total 回退。U3 审计 T1 前本线映射锁在 peer 门控的 adapter.ts 里
  // 零直测（U2-T2 同族缺口的三线补齐）。
  const c1 = mapChatUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } });
  check("chat usage: input 减缓存读、total 直取平台值、缓存读/推理字段条件展开",
    c1.inputTokens === 60 && c1.outputTokens === 20 && c1.totalTokens === 120
      && c1.cacheReadTokens === 40 && c1.reasoningTokens === 5, JSON.stringify(c1));
  const c2 = mapChatUsage({ prompt_tokens: 10, completion_tokens: 5 });
  check("chat usage: 无 details 不展开、total 缺失回退原始 prompt+completion",
    c2.inputTokens === 10 && c2.outputTokens === 5 && c2.totalTokens === 15
      && c2.cacheReadTokens === undefined && c2.reasoningTokens === undefined, JSON.stringify(c2));
  const c3 = mapChatUsage({ prompt_tokens: "50", completion_tokens: NaN, total_tokens: -1 });
  check("chat usage: 非有限数一律 0（toNumber 口径，total≤0 走回退）",
    c3.inputTokens === 0 && c3.outputTokens === 0 && c3.totalTokens === 0, JSON.stringify(c3));

  // anthropic：无 details 嵌套；input_tokens 是未缓存口径（2026-11-01 真机探针
  // 判定 C：input 与 cache_read 并列、118+1536=1654=全量输入）——直取不减；
  // total=全口径 input+cacheRead+cacheWrite+output，与 chat/responses 平台 total 对齐。
  const a1 = mapAnthropicUsage({ input_tokens: 110, output_tokens: 20,
    cache_read_input_tokens: 60, cache_creation_input_tokens: 5 });
  check("anthropic usage: input 直取（未缓存口径）、total=全口径（含缓存读写）",
    a1.inputTokens === 110 && a1.totalTokens === 195 && a1.cacheReadTokens === 60
      && a1.cacheWriteTokens === 5, JSON.stringify(a1));
  const a2 = mapAnthropicUsage({ input_tokens: 10, output_tokens: 5 });
  check("anthropic usage: 无缓存字段不展开、total=10+5",
    a2.inputTokens === 10 && a2.totalTokens === 15 && a2.cacheReadTokens === undefined
      && a2.cacheWriteTokens === undefined, JSON.stringify(a2));

  // mergeUsage：message_start 全量 + message_delta 只带 output_tokens（规范常态）——
  // 修复前 cacheRead 丢失、total 漂成未缓存口径（U2 审计 D2）。
  const start = mapAnthropicUsage({ input_tokens: 110, output_tokens: 0, cache_read_input_tokens: 60 });
  const merged = mergeUsage(start, { output_tokens: 200 });
  check("mergeUsage: delta 只带 output——input/cacheRead 沿用、total 与首帧同口径（全口径）",
    merged.inputTokens === 110 && merged.outputTokens === 200 && merged.cacheReadTokens === 60
      && merged.totalTokens === 370, JSON.stringify(merged));
  // delta 带新 input 时成对带 cache_read（刷新语义完全确定）。单带 input 不带
  // cache 的合成形状语义未定义（真机 delta 不带 input——规范只带 output 累计），
  // 不为它发明拆分假设、也不钉死现行为。
  check("mergeUsage: delta 成对带 input+cache_read——直取新值、total 全口径",
    JSON.stringify(mergeUsage(start, { input_tokens: 210, cache_read_input_tokens: 60, output_tokens: 200 }))
      === JSON.stringify({ inputTokens: 210, outputTokens: 200, totalTokens: 470, cacheReadTokens: 60 }),
    JSON.stringify(mergeUsage(start, { input_tokens: 210, cache_read_input_tokens: 60, output_tokens: 200 })));
  check("mergeUsage: 首帧缺席时全量直取（与 mapAnthropicUsage 同形）",
    JSON.stringify(mergeUsage(undefined, { input_tokens: 110, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 5 }))
      === JSON.stringify(a1),
    JSON.stringify(mergeUsage(undefined, { input_tokens: 110, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 5 })));
}

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} contract check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} contract checks passed`);
