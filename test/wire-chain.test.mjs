/**
 * 全量降级链（per-model-protocol-chain，2026-10-30 用户拍板）的两组钉：
 *
 * - pool-store：modelProtocols 分区的链解析（数组值、0.1.31 字符串兼容、
 *   "auto" 丢弃、去重截三、全非法回落）——peer-free，本机可跑；
 * - plan：生效链合成（面板 ?? 配置单线 ?? 档案默认）+ 链走查 + chat 兜底。
 *   plan.ts 经 peer 依赖 `@deepseek-ai/dsh-llm`（LlmError/contentHasImage），
 *   无 peer 环境该块响亮 SKIP（与 retry.test 同纪律），CI 上实跑。
 *
 * setModelProtocol 与 parse 走同一个 normalizeChainValue，解析钉即覆盖之。
 */
import { parsePoolPayload, emptyPoolRecord } from "../src/host/pool-store.ts";
import { branchSkip } from "./env-skip.mjs";
import { results, check, fail } from "./harness.mjs";

// ── 1. pool-store：链分区解析（peer-free） ─────────────────────────────────
{
  try {
    const record = (modelProtocols) => parsePoolPayload({ ...emptyPoolRecord(), modelProtocols });
    const chainsOf = (parsed) => parsed?.modelProtocols ?? {};

    const array = record({ m1: ["anthropic", "chat-completions"] });
    check("an array chain value parses verbatim",
      JSON.stringify(chainsOf(array).m1) === JSON.stringify(["anthropic", "chat-completions"]),
      JSON.stringify(chainsOf(array)));

    const legacy = record({ m1: "responses" });
    check("a 0.1.31 string value reads as a length-1 chain",
      JSON.stringify(chainsOf(legacy).m1) === JSON.stringify(["responses"]),
      JSON.stringify(chainsOf(legacy)));

    const auto = record({ m1: "auto" });
    check("the legacy auto value drops the override (facts default governs)",
      !("m1" in chainsOf(auto)),
      JSON.stringify(chainsOf(auto)));

    const dedup = record({ m1: ["chat-completions", "chat-completions", "responses", "anthropic"] });
    check("duplicates collapse, then the chain truncates at chat (2026-10-31)",
      JSON.stringify(chainsOf(dedup).m1) === JSON.stringify(["chat-completions"]),
      JSON.stringify(chainsOf(dedup)));

    // chat 后截断（2026-10-31 他拍板）：chat 无降级条件，其后槽位永不可达——
    // 存储层即截断，面板槽位与实际行为一致。
    const chatHead = record({ m1: ["chat-completions", "responses"] });
    check("a chain is truncated at chat-completions (later slots are dead weight)",
      JSON.stringify(chainsOf(chatHead).m1) === JSON.stringify(["chat-completions"]),
      JSON.stringify(chainsOf(chatHead)));
    const chatMid = record({ m1: ["responses", "chat-completions", "anthropic"] });
    check("entries after chat drop, entries before stay",
      JSON.stringify(chainsOf(chatMid).m1) === JSON.stringify(["responses", "chat-completions"]),
      JSON.stringify(chainsOf(chatMid)));
    // 生效链合成层同样截断（面板值经 sanitizeChain 进 effectiveChain）。
    const { effectiveChain } = await import("../src/host/wire/chain.ts");
    const { factsFor } = await import("../src/host/wire/facts.ts");

  
    check("effectiveChain truncates a panel override at chat (merge layer)",
      JSON.stringify(effectiveChain({}, factsFor("m", undefined), ["chat-completions", "responses"]))
        === JSON.stringify(["chat-completions"]),
      JSON.stringify(effectiveChain({}, factsFor("m", undefined), ["chat-completions", "responses"])));

    const junk = record({ m1: ["nope"], m2: 42, m3: [] });
    check("an all-invalid / empty value drops the override entirely",
      Object.keys(chainsOf(junk)).length === 0,
      JSON.stringify(chainsOf(junk)));
  } catch (error) {
    fail("pool-store chain parse", error);
  }
}

// ── 2. plan：生效链合成 + 链走查 + chat 兜底（需 peer） ────────────────────
let strictRefused = false;
{
  try {
    const plan = await import("../src/host/wire/plan.ts");
    const { factsFor } = await import("../src/host/wire/facts.ts");
const { toResponsesInput } = await import("../src/host/wire/body-responses.ts");
    const longId = `toolu_${"A".repeat(64)}`; // 70 字符 > 64
    const ciOpts = {
      model: "m",
      messages: [
        { role: "assistant", content: [{ type: "tool-call", id: longId, name: "f", arguments: "{}" }] },
        { role: "tool", toolCallId: longId, content: [{ type: "text", text: "ok" }] },
        { role: "assistant", content: [{ type: "tool-call", id: "short_ok", name: "g", arguments: "{}" }] },
      ],
    };
    const { ciInput } = toResponsesInput(ciOpts);
    const ciLongCall = ciInput.find((i) => i.type === "function_call" && i.name === "f");
    const ciOutput = ciInput.find((i) => i.type === "function_call_output");
    const ciShortCall = ciInput.find((i) => i.type === "function_call" && i.name === "g");
    check("超长 call_id 合成短 id（平台限 1–64）",
      ciLongCall !== undefined && ciLongCall.call_id.length <= 64 && String(ciLongCall.call_id).startsWith("sensenova-sanitized-"),
      JSON.stringify(ciLongCall));
    check("remap 保证 function_call_output 用同一合成 id（关联不断）",
      ciOutput !== undefined && ciOutput.call_id === ciLongCall.call_id,
      JSON.stringify(ciOutput));
    check("合规短 id 原样透传", ciShortCall !== undefined && ciShortCall.call_id === "short_ok", JSON.stringify(ciShortCall));

    const opts = (extra = {}) => ({ model: "m", messages: [], ...extra });
    const resolve = (options, config = {}, modelChain, runtime = {}, model = "m") =>
      plan.resolveWirePlan(options, config, factsFor(model), runtime, modelChain);
    const shape = (wire, reason, chain, chainIndex) =>
      JSON.stringify([wire, reason, chain, chainIndex]);

    // 档案默认链：全模型统一 re>an>chat（2026-10-31 他拍板）起步即 responses。
    check("a standard model walks its re>an>chat default and serves responses",
      shape(resolve(opts()).wire, resolve(opts()).reason, resolve(opts()).chain, resolve(opts()).chainIndex)
        === shape("responses", "responses-default", ["responses", "anthropic", "chat-completions"], 0),
      JSON.stringify(resolve(opts())));

    // kimi/glm 档案默认链与标准链同形（2026-10-31 他拍板：加回 anthropic 撤销分岔，
    // 再统一为 re>an>chat）。钉「不分岔」本身。
    const kimi = resolve(opts(), {}, undefined, {}, "kimi-k3");
    check("kimi's facts default chain is the standard (anthropic restored, no fork)",
      shape(kimi.wire, kimi.reason, kimi.chain, kimi.chainIndex)
        === shape("responses", "responses-default", ["responses", "anthropic", "chat-completions"], 0),
      JSON.stringify(kimi));
    const glm = resolve(opts(), {}, undefined, {}, "glm-5.2");
    check("glm's facts default chain is the standard too (no fork)",
      shape(glm.wire, glm.reason, glm.chain, glm.chainIndex)
        === shape("responses", "responses-default", ["responses", "anthropic", "chat-completions"], 0),
      JSON.stringify(glm));

    // 面板覆盖三层之首：单线链钉死；显式加回 anthropic 也照走。
    const pinned = resolve(opts(), {}, ["chat-completions"], {}, "kimi-k3");
    check("a panel override pins the chain (single-wire chain serves it)",
      shape(pinned.wire, pinned.reason, pinned.chain, pinned.chainIndex)
        === shape("chat-completions", "chat-default", ["chat-completions"], 0),
      JSON.stringify(pinned));
    const backOnAn = resolve(opts(), {}, ["anthropic"], {}, "kimi-k3");
    check("a user can add anthropic back into kimi's chain explicitly",
      backOnAn.wire === "anthropic" && backOnAn.reason === "anthropic-default",
      JSON.stringify(backOnAn));

    // 走查跳过命中降级条件的线（运行时 400 标记）。
    const marked = resolve(opts(), {}, ["anthropic", "chat-completions"],
      { anthropicUnsupported: new Set(["m"]) });
    check("a runtime-marked wire is skipped inside the walk",
      marked.wire === "chat-completions" && marked.chainIndex === 1,
      JSON.stringify(marked));

    // 链耗尽 → chat 兜底（reason 单列 chain-fallback，chainIndex = 链长）。
    const exhausted = resolve(opts({ stop: ["x"] }), {}, ["responses"], {}, "glm-5.2");
    check("an exhausted chain falls back to chat with the chain-fallback reason",
      shape(exhausted.wire, exhausted.reason, exhausted.chain, exhausted.chainIndex)
        === shape("chat-completions", "chain-fallback", ["responses"], 1),
      JSON.stringify(exhausted));
    const effort = resolve(opts({ reasoningEffort: "low" }), {}, ["responses"], {}, "glm-5.2");
    check("an effort deviation exhausts a responses-only chain into the chat fallback too",
      effort.wire === "chat-completions" && effort.reason === "chain-fallback",
      JSON.stringify(effort));

    // 非法覆盖回落档案默认；能力门跳过链上能力外的线后兜底。
    const junk = resolve(opts(), {}, ["nope", 42], {}, "kimi-k3");
    check("a junk override falls through to the facts default chain",
      junk.wire === "responses" && JSON.stringify(junk.chain) === JSON.stringify(["responses", "chat-completions"]),
      JSON.stringify(junk));
    const gated = resolve(opts(), {}, ["anthropic"], {}, "unknown-model-x");
    check("a wire outside supportedWires is skipped, then the chat fallback serves",
      gated.wire === "chat-completions" && gated.reason === "chain-fallback",
      JSON.stringify(gated));

    // 配置层：强制值映射为单线链（auto = 档案默认，已被上面覆盖）。
    const forced = resolve(opts(), { wireProtocol: "responses" }, undefined, {}, "kimi-k3");
    check("a forced wireProtocol maps to a single-wire chain",
      shape(forced.wire, forced.reason, forced.chain, forced.chainIndex)
        === shape("responses", "responses-default", ["responses"], 0),
      JSON.stringify(forced));
  } catch (error) {
    if (String(error?.message ?? error).includes("@deepseek-ai/dsh-llm")) {
      strictRefused = branchSkip(
        "wire-chain.test.mjs",
        "peer @deepseek-ai/dsh-llm not resolvable here; the chain-walk block is covered in CI",
        ["plan 生效链合成/链走查/chat 兜底 12 项未运行（本机无 peer，CI 实跑）"]
      );
    } else {
      fail("plan chain walk", error);
    }
  }
}

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\n${failedChecks.length}/${results.length} check(s) FAILED`);
  process.exit(1);
}
if (strictRefused) {
  console.error(
    `\n[skip refused] wire-chain.test.mjs left a coverage gap that STRICT mode treats as a regression ` +
      `(DSH_TEST_STRICT_SKIP=1 / CI). Re-run with the @deepseek-ai/dsh-llm peer resolvable.`
  );
  process.exit(1);
}
console.log(`\nall ${results.length} checks passed`);
