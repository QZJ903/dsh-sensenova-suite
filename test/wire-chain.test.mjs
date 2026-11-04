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
    const { input: ciInput } = toResponsesInput(ciOpts); // 返回形状是 {instructions, input}——b6469b1 起解构错名，块内全部钉未在任何环境执行过
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

    // role 条目恒带 type:'message'（2026-11-04 真机 400：混入 function 项的数组
    // 缺 type 即 "missing input.type"；方案一=无条件补齐，工具会话第 1 轮也覆盖）。
    const roleItems = toResponsesInput({
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "你好" }] },
        { role: "assistant", content: [{ type: "text", text: "答" }] },
      ],
    }).input;
    check("role 条目恒带 type:'message'（2026-11-04 真机 400 修正）",
      roleItems.length === 2 && roleItems.every((i) => i.type === "message"),
      JSON.stringify(roleItems));

    const opts = (extra = {}) => ({ model: "m", messages: [], ...extra });
    const resolve = (options, config = {}, modelChain, runtime = {}, model = "m") =>
      plan.resolveWirePlan(options, config, factsFor(model), runtime, modelChain);
    const shape = (wire, reason, chain) =>
      JSON.stringify([wire, reason, chain]);

    // 档案默认链：全模型统一 chat 单线（2026-11-05 他拍板——an 线 0B 空流断尾
    // 真机高频，0.1.49 的 an 首发被推翻）。须传已知模型（factsFor("m") 是未知
    // 模型、能力面只有 chat，恒落兜底）。
    check("a standard model walks its chat default and serves chat-completions",
      shape(resolve(opts(), {}, undefined, {}, "deepseek-flash").wire, resolve(opts(), {}, undefined, {}, "deepseek-flash").reason, resolve(opts(), {}, undefined, {}, "deepseek-flash").chain)
        === shape("chat-completions", "chat-default", ["chat-completions"]),
      JSON.stringify(resolve(opts(), {}, undefined, {}, "deepseek-flash")));

    // kimi/glm 档案默认链与标准链同形（钉「不分岔」本身）。
    const kimi = resolve(opts(), {}, undefined, {}, "kimi-k3");
    check("kimi's facts default chain is the standard (no fork)",
      shape(kimi.wire, kimi.reason, kimi.chain)
        === shape("chat-completions", "chat-default", ["chat-completions"]),
      JSON.stringify(kimi));
    const glm = resolve(opts(), {}, undefined, {}, "glm-5.2");
    check("glm's facts default chain is the standard too (no fork)",
      shape(glm.wire, glm.reason, glm.chain)
        === shape("chat-completions", "chat-default", ["chat-completions"]),
      JSON.stringify(glm));

    // 面板覆盖三层之首：单线链钉死；显式加回 anthropic 也照走。
    const pinned = resolve(opts(), {}, ["chat-completions"], {}, "kimi-k3");
    check("a panel override pins the chain (single-wire chain serves it)",
      shape(pinned.wire, pinned.reason, pinned.chain)
        === shape("chat-completions", "chat-default", ["chat-completions"]),
      JSON.stringify(pinned));
    const backOnAn = resolve(opts(), {}, ["anthropic"], {}, "kimi-k3");
    check("a user can add anthropic back into kimi's chain explicitly",
      backOnAn.wire === "anthropic" && backOnAn.reason === "anthropic-default",
      JSON.stringify(backOnAn));

    // 走查跳过命中降级条件的线（运行时 400 标记）——an 被跳过由 wire+chain 组合断言。
    const marked = resolve(opts(), {}, ["anthropic", "chat-completions"],
      { anthropicUnsupported: new Set(["m"]) });
    check("a runtime-marked wire is skipped inside the walk",
      marked.wire === "chat-completions"
        && JSON.stringify(marked.chain) === JSON.stringify(["anthropic", "chat-completions"]),
      JSON.stringify(marked));

    // 链耗尽 → chat 兜底（reason 单列 chain-fallback）。
    // 兜底时 chain = 全局兜底链（spread 覆盖）——adapter 的 400 下一跳按
    // plan.chain.indexOf(wire) 寻址，兜底链使 chat 命中 0、无下一跳，不会同线重试。
    const exhausted = resolve(opts({ stop: ["x"] }), {}, ["responses"], {}, "glm-5.2");
    check("an exhausted chain falls back to chat with the chain-fallback reason",
      shape(exhausted.wire, exhausted.reason, exhausted.chain)
        === shape("chat-completions", "chain-fallback", ["chat-completions"]),
      JSON.stringify(exhausted));
    const effort = resolve(opts({ reasoningEffort: "low" }), {}, ["responses"], {}, "glm-5.2");
    check("an effort deviation exhausts a responses-only chain into the chat fallback too",
      effort.wire === "chat-completions" && effort.reason === "chain-fallback",
      JSON.stringify(effort));

    // 2026-11-04 他真机 curl（thinking:{type:'disabled'} 打 glm-5.2 /messages 得
    // 200）推翻文档判据，档案 forbidThinkingDisabled 翻 false——glm+off 不再跳线，
    // an 线直接服务（体层发 disabled，curl 同形状）。「用户选择大于协议」的跳线
    // 机制现唯一载体是 6.8-flash。
    const offServesAn = resolve(opts({ reasoningEffort: "off" }), {}, ["anthropic", "responses"], {}, "glm-5.2");
    check("off on glm serves anthropic after the 2026-11-04 real-machine flip (was skip-to-responses)",
      shape(offServesAn.wire, offServesAn.reason, offServesAn.chain)
        === shape("anthropic", "anthropic-default", ["anthropic", "responses"]),
      JSON.stringify(offServesAn));
    const offSingleAn = resolve(opts({ reasoningEffort: "off" }), {}, ["anthropic"], {}, "glm-5.2");
    check("off with a single-anthropic chain on glm serves anthropic too (post-flip)",
      offSingleAn.wire === "anthropic" && offSingleAn.reason === "anthropic-default",
      JSON.stringify(offSingleAn));
    // 对照：不勾 off 时同一条链照走 an——跳过只绑定 off 拼写，不影响其他档位与未选。
    const noEffort = resolve(opts(), {}, ["anthropic", "responses"], {}, "glm-5.2");
    check("without an off effort the same chain still serves anthropic",
      noEffort.wire === "anthropic" && noEffort.reason === "anthropic-default",
      JSON.stringify(noEffort));

    // 拍板落地轮（2026-11-01）：并行工具结果合并为一条 user 消息（Anthropic 交替
    // 纪律；商汤兼容层宽松度未知，按规范消除该前提——U2 审计疑似 1）。
    const { buildAnthropicBody } = await import("../src/host/wire/body-anthropic.ts");
    const parBody = buildAnthropicBody({
      model: "glm-5.2",
      messages: [
        { role: "assistant", content: [
          { type: "tool-call", id: "t1", name: "f", arguments: "{}" },
          { type: "tool-call", id: "t2", name: "g", arguments: "{}" },
        ] },
        { role: "tool", toolCallId: "t1", content: [{ type: "text", text: "A" }] },
        { role: "tool", toolCallId: "t2", content: [{ type: "text", text: "B" }] },
      ],
    }, undefined);
    const parUsers = parBody.messages.filter((m) => m.role === "user");
    check("parallel tool results merge into one user message (an alternation discipline)",
      parUsers.length === 1 && Array.isArray(parUsers[0].content) && parUsers[0].content.length === 2
        && parUsers[0].content.every((b) => b.type === "tool_result")
        && parUsers[0].content[0].tool_use_id === "t1" && parUsers[0].content[1].tool_use_id === "t2",
      JSON.stringify(parBody.messages));
    // 对照：普通文本 user 消息不被并进 tool_result 消息（只合并全 tool_result 形状）。
    const mixedBody = buildAnthropicBody({
      model: "glm-5.2",
      messages: [
        { role: "assistant", content: [{ type: "tool-call", id: "t1", name: "f", arguments: "{}" }] },
        { role: "tool", toolCallId: "t1", content: [{ type: "text", text: "A" }] },
        { role: "user", content: [{ type: "text", text: "继续" }] },
      ],
    }, undefined);
    check("a plain user message after a tool result stays separate",
      mixedBody.messages.length === 3 && mixedBody.messages[1].role === "user"
        && Array.isArray(mixedBody.messages[1].content) && mixedBody.messages[1].content[0].type === "tool_result"
        && mixedBody.messages[2].role === "user" && mixedBody.messages[2].content === "继续",
      JSON.stringify(mixedBody.messages));

    // 非法覆盖回落档案默认；能力门跳过链上能力外的线后兜底。
    // 期望单线 chat = 2026-11-05 拍板（全模型统一 chat 单线）。
    const junk = resolve(opts(), {}, ["nope", 42], {}, "kimi-k3");
    check("a junk override falls through to the facts default chain",
      junk.wire === "chat-completions" && JSON.stringify(junk.chain) === JSON.stringify(["chat-completions"]),
      JSON.stringify(junk));
    const gated = resolve(opts(), {}, ["anthropic"], {}, "unknown-model-x");
    check("a wire outside supportedWires is skipped, then the chat fallback serves",
      gated.wire === "chat-completions" && gated.reason === "chain-fallback",
      JSON.stringify(gated));

    // 配置层：强制值映射为单线链（auto = 档案默认，已被上面覆盖）。
    const forced = resolve(opts(), { wireProtocol: "responses" }, undefined, {}, "kimi-k3");
    check("a forced wireProtocol maps to a single-wire chain",
      shape(forced.wire, forced.reason, forced.chain)
        === shape("responses", "responses-default", ["responses"]),
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
