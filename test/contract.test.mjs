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
  toPiDescriptor,
  buildDescriptors,
  isChatModel,
  exhaustedModelIds,
  contextWindowOf,
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

// --- 2. toPiDescriptor against the frozen contract ------------------------
for (const model of contract.models) {
  if (model.chat !== true) continue; // 404/403 models are asserted in §3
  try {
    const entry = entryFor(model);
    const descriptor = toPiDescriptor(entry, { baseUrl });
    check(`${model.id} descriptor.id is the catalog id`, descriptor.id === model.id, descriptor.id);
    check(`${model.id} descriptor pins max_tokens field`,
      descriptor.compat?.maxTokensField === "max_tokens" && descriptor.compat?.supportsDeveloperRole === false,
      JSON.stringify(descriptor.compat));
    // The 2026-10-02 ceiling decision: the harness fills an UNDECLARED
    // maxTokens with 32768, so a catalogue-stated ceiling (flash-lite: 65536,
    // probed) must be DECLARED as maxTokens, and a catalogue entry without a
    // ceiling keeps the field absent (never a guessed number).
    if (model.maxOutputLength !== undefined) {
      check(`${model.id} descriptor declares the catalogue ceiling as maxTokens`,
        descriptor.maxTokens === model.maxOutputLength,
        `got ${String(descriptor.maxTokens)}`);
    } else {
      check(`${model.id} descriptor leaves maxTokens undeclared (no catalogue ceiling)`,
        !Object.prototype.hasOwnProperty.call(descriptor, "maxTokens"),
        JSON.stringify(descriptor));
    }
    check(`${model.id} descriptor declares reasoning + thinkingLevelMap`,
      descriptor.reasoning === true && typeof descriptor.thinkingLevelMap === "object",
      JSON.stringify({ reasoning: descriptor.reasoning }));
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
    // vision: the descriptor's input array mirrors the contract's
    // visionInput flag (structured `input_modalities` wins).
    const expectedInput = model.visionInput ? ["text", "image"] : ["text"];
    check(`${model.id} descriptor.input matches contract visionInput`,
      JSON.stringify(descriptor.input) === JSON.stringify(expectedInput),
      JSON.stringify({ got: descriptor.input, want: expectedInput }));
    if (model.contextLength !== undefined) {
      check(`${model.id} descriptor.contextWindow reads catalog context_length`,
        descriptor.contextWindow === model.contextLength,
        `${descriptor.contextWindow} vs ${model.contextLength}`);
    }
  } catch (error) { fail(`${model.id} descriptor`, error); }
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

// --- 5. buildDescriptors: the picker offer matches the contract -----------
// The offer is every chat model NOT in a depleted pool, filtered by the
// allow-list AND by KNOWN_UNROUTABLE_MODELS. `isChatModel` is PERMISSIVE (a
// missing/unknown `output_modalities` is treated as chat), but since
// 2026-10-27 the known-uncallable ids are dropped at every offer exit:
// `deepseek-v4.1-flash` (the key's plan never activated it — every call 403s,
// and the failure cache only learns 404s, so it never self-hides) joins the
// offline `sensenova-6.7-flash-lite`. The panel hides the row entirely (same
// set, subtracted at the snapshot exit); the baseline below still pins the
// PLATFORM catalog, which keeps returning both ids. The image-gen U-series
// (404) is the only family excluded by modality.
{
  const allEntries = contract.models.map(entryFor);
  // No pool depletion, no allow-list: the picker offers every chat model the
  // contract marks `chat: true`, minus the known-uncallable set.
  const chatIds = contract.models
    .filter((m) => m.chat === true && !KNOWN_UNROUTABLE_MODELS.has(m.id))
    .map((m) => m.id);
  const offered = buildDescriptors(allEntries, { baseUrl, enabledIds: [], unavailableModelIds: [] });
  const offeredIds = offered.map((d) => d.id);
  check("buildDescriptors offers exactly the contract's chat models (no pool depletion)",
    JSON.stringify(offeredIds) === JSON.stringify(chatIds),
    JSON.stringify({ offered: offeredIds, want: chatIds }));

  // The image-gen U-series (404 on the chat endpoint) is the only family the
  // picker excludes by modality: `output_modalities: ["image"]` is the
  // load-bearing signal. The known-uncallable ids are excluded by id, not by
  // modality.
  const imageGenIds = contract.models.filter((m) => m.imageGen === true).map((m) => m.id);
  check("buildDescriptors excludes every image-gen model from the offer",
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
  const offeredBlocked = buildDescriptors(allEntries, { baseUrl, enabledIds: [], unavailableModelIds: blocked });
  check("buildDescriptors drops the quota-depleted model from the offer",
    offeredBlocked.every((d) => d.id !== "deepseek-v4-flash") &&
      offeredBlocked.some((d) => d.id === "deepseek-v4-pro"),
    JSON.stringify(offeredBlocked.map((d) => d.id)));

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
  check("the picker still offers that model while its dedicated pool has credit",
    buildDescriptors(allEntries, { baseUrl, enabledIds: [], unavailableModelIds: sharedBlocked })
      .some((d) => d.id === "deepseek-v4-flash"),
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
  const visionOffer = buildDescriptors(allEntries, { baseUrl, enabledIds: [], unavailableModelIds: [] })
    .filter((d) => JSON.stringify(d.input) === JSON.stringify(["text", "image"]));
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

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} contract check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${results.length} contract checks passed`);
