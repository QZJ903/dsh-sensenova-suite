/**
 * 池层与分类层单测——纯 Node、无 peer。
 *
 * 钉住的契约：
 *   - classify429Full 七分类（code 8 / 429001 / 429003=rate-soft / insufficient_quota /
 *     Endpoint* / ModelAccount* / 池特征串 / 未知兜底；insufficient_quota 2026-10-31
 *     依上游 freeapi 订正从池特征串移出按 tpm 处理；429003 同日改 rate-soft——
 *     轮换不记 strike）；
 *   - parseRetryAfterMs 秒数与 HTTP 日期两形态；
 *   - KeyOrchestrator：按组亲和（商汤组粘、通用组轮）、(key,组) 池格跳过
 *     与 groupFullyPoolMarked、连续 rate 踢出（阈值 3）、探测到期恢复、
 *     全局槽排队、refreshKeys 重种（新增入池/消失摘出/存量相位保留）；
 *   - normalizeAccounts / normalizeModelGroups 的丢弃与回落。
 */
import { strict as assert } from "node:assert";
import { classify429Full, classify429Body, rateKindCountsStrike, parseRetryAfterMs } from "../src/host/rate-classify.ts";
import { KeyOrchestrator, DEFAULT_ORCHESTRATOR_PARAMS } from "../src/host/key-orchestrator.ts";
import { normalizeAccounts, normalizeModelGroups, CONFIG_DEFAULTS } from "../src/host/host-config.ts";

const results = [];
const check = (name, ok, detail = "") => results.push({ name, pass: ok === true, detail: String(detail) });
const fail = (group, error) => results.push({ name: group, pass: false, detail: String(error) });

// ── 1. classify429Full ──────────────────────────────────────────────────────
try {
  const rps = classify429Full('{"error":{"code":8,"message":"rps exhausted"}}');
  check("code 8 → rate-rps", rps.kind === "rate-rps" && rps.retryFloorMs === 15_000, JSON.stringify(rps));
  const rpsStr = classify429Full('{"error":{"code":"8"}}');
  check("code '8'（字符串）同样 rate-rps", rpsStr.kind === "rate-rps", JSON.stringify(rpsStr));
  const tpm = classify429Full('{"error":{"code":429001,"type":"invalid_request_error"}}');
  check("code 429001 → rate-tpm", tpm.kind === "rate-tpm", JSON.stringify(tpm));
  const pool = classify429Full('{"error":{"code":1213,"message":"Allocated quota exceeded"}}');
  check("Allocated quota exceeded → pool", pool.kind === "pool", JSON.stringify(pool));
  const unknown = classify429Full("not json at all");
  check("非 JSON → unknown（兜底按 rate 处理）", unknown.kind === "unknown", JSON.stringify(unknown));
  // 2026-10-31 真 key 实测：作用域写进 code。同一时刻 A/C 200、B 429 ⇒ 换 key 能绕开，
  // 两类都按配额类处理（quota:true），且只认 code 不认 message（code=8 也带同一句 message）。
  const endpoint = classify429Full('{"error":{"code":"RateLimitExceeded.EndpointTPMExceeded","message":"inference exceeds tpm/rpm limit"}}');
  check("EndpointTPMExceeded → rate-endpoint（配额类，可轮换）", endpoint.kind === "rate-endpoint" && endpoint.retryFloorMs === 3_000, JSON.stringify(endpoint));
  const endpointRpm = classify429Full('{"error":{"code":"RateLimitExceeded.EndpointRPMExceeded","message":"inference exceeds tpm/rpm limit"}}');
  check("EndpointRPMExceeded → rate-endpoint", endpointRpm.kind === "rate-endpoint", JSON.stringify(endpointRpm));
  const account = classify429Full('{"error":{"code":"ModelAccountRpmRateLimitExceeded","message":"inference exceeds tpm/rpm limit"}}');
  check("ModelAccountRpmRateLimitExceeded → rate-account", account.kind === "rate-account", JSON.stringify(account));
  const accountTpm = classify429Full('{"error":{"code":"ModelAccountTpmRateLimitExceeded"}}');
  check("ModelAccountTpmRateLimitExceeded → rate-account", accountTpm.kind === "rate-account", JSON.stringify(accountTpm));
  // 429003 → rate-soft（2026-10-31 他拍板）：样本 message 与 429001 全同、type 与
  // Endpoint 族全同（内容区分不了），归类靠观测；实测它多呈 rpm 形态快速自愈——
  // 计入踢出阈值会把贴线限流的健康 key 踢出池，故轮换不记 strike（adapter/vision
  // 侧按 kind 路由，此处钉分类器形状）。
  const code429003 = classify429Full('{"error":{"code":429003,"type":"rate_limit_error","message":"inference exceeds tpm/rpm limit"}}');
  check("429003 → rate-soft（15s 下限，轮换不记 strike）", code429003.kind === "rate-soft" && code429003.retryFloorMs === 15_000, JSON.stringify(code429003));
  const code429003Str = classify429Body('{"error":{"code":"429003"}}');
  check("429003 字符串形态同样 rate-soft（quota:true）", code429003Str.quota === true && code429003Str.kind === "rate-soft", JSON.stringify(code429003Str));
  const code8WithTpmMessage = classify429Body('{"error":{"code":8,"message":"inference exceeds tpm/rpm limit"}}');
  check("code 8 带 tpm/rpm message 仍归 rate（message 不参与分类）", code8WithTpmMessage.kind === "rate" && code8WithTpmMessage.quota === true, JSON.stringify(code8WithTpmMessage));
  const endpointQuota = classify429Body('{"error":{"code":"RateLimitExceeded.EndpointTPMExceeded"}}');
  check("classify429Body 对 endpoint 也返回 quota:true（适配器据此换 key）", endpointQuota.quota === true && endpointQuota.kind === "endpoint", JSON.stringify(endpointQuota));
  const plainQuota = classify429Body('{"error":{"code":8}}');
  check("classify429Body 兼容面：code 8 quota:true", plainQuota.quota === true && plainQuota.kind === "rate");
  // insufficient_quota：上游 freeapi 订正——命名像「配额耗尽」、实为 tpm/rpm 速率
  // 限流（2026-10-31 从池类特征串 POOL_EXHAUSTED_MARKERS 移出，按 code 归 tpm 档）。
  // 归池类的实害：速率窗被记成 (key,组) 积分格，组内全中招时错误触发「换无可换」
  // 快速失败，而实测换 key 能绕开。
  const aliasQuota = classify429Body('{"error":{"code":"insufficient_quota"}}');
  check("insufficient_quota → tpm（quota:true，3s 起分级）", aliasQuota.quota === true && aliasQuota.kind === "tpm" && aliasQuota.retryFloorMs === 3_000, JSON.stringify(aliasQuota));
  const aliasFull = classify429Full('{"error":{"code":"insufficient_quota","message":"inference exceeds tpm/rpm limit"}}');
  check("insufficient_quota 全链分类 → rate-tpm（不再归 pool）", aliasFull.kind === "rate-tpm" && aliasFull.retryFloorMs === 3_000, JSON.stringify(aliasFull));
  const aliasMsgOnly = classify429Full('{"error":{"code":1213,"message":"insufficient_quota"}}');
  check("insufficient_quota 只出现在 message（code 不认识）→ 不归 pool（unknown 兜底）", aliasMsgOnly.kind === "unknown", JSON.stringify(aliasMsgOnly));
  // 踢出阈值单一判据（2026-10-31）：只有重形态（窗口分钟级以上）计数；两个速率
  // 桶形态（code 8 / 429003）14s 级自愈不计数，pool/unknown 另有口径。
  check("strike 判据：rate-rps 不计（code 8，他拍板扩入）", rateKindCountsStrike("rate-rps") === false);
  check("strike 判据：rate-soft 不计（429003）", rateKindCountsStrike("rate-soft") === false);
  check("strike 判据：pool / unknown 不计", rateKindCountsStrike("pool") === false && rateKindCountsStrike("unknown") === false && rateKindCountsStrike(undefined) === false);
  check("strike 判据：tpm / endpoint / account 计数", rateKindCountsStrike("rate-tpm") === true && rateKindCountsStrike("rate-endpoint") === true && rateKindCountsStrike("rate-account") === true);
} catch (e) { fail("classify429Full", e); }

// ── 2. parseRetryAfterMs ────────────────────────────────────────────────────
try {
  check("秒数形态", parseRetryAfterMs("30") === 30_000, parseRetryAfterMs("30"));
  check("0 秒 → undefined（立刻可试）", parseRetryAfterMs("0") === undefined);
  const date = parseRetryAfterMs(new Date(Date.now() + 60_000).toUTCString());
  check("HTTP 日期形态 ≈60s", date !== undefined && Math.abs(date - 60_000) < 2_000, String(date));
  check("垃圾串 → undefined", parseRetryAfterMs("soon") === undefined);
} catch (e) { fail("parseRetryAfterMs", e); }

// ── 3. KeyOrchestrator：按组路由 + 池格 + 踢出 + 探测 ──────────────────────
try {
  let now = 1_000_000;
  const clock = () => now;
  const keys = ["sk-a", "sk-b", "sk-c"];
  const params = { ...DEFAULT_ORCHESTRATOR_PARAMS, globalConcurrency: 2 };
  const probeCalls = [];
  let probeResult = true;
  const orch = new KeyOrchestrator({
    params: () => params,
    resolveKeys: async () => keys.map((key, index) => ({ id: `acc-${index}`, key })),
    probe: async (key) => { probeCalls.push(key); return probeResult; },
    now: clock,
  });

  // 3a. 具名组亲和：同会话连续 pick 同一把；通用组两次 pick 推进游标。
  // （2026-10-31 判据改「组 ≠ general」：flash-lite 专属池组名在 0.1.18 改定后
  // 亲和曾静默死路——本段用运行时组名 "flash-lite" 钉回归。）
  const first = await orch.pickStart({ sessionId: "s1", model: "sensenova-6.8-flash-lite" });
  const again = await orch.pickStart({ sessionId: "s1", model: "sensenova-6.8-flash-lite" });
  check("具名组：同会话粘同一把", first.key === again.key, `${first.key} vs ${again.key}`);
  check("具名组：groupOf 报 flash-lite（运行时组名）", first.group === "flash-lite", first.group);
  const g1 = await orch.pickStart({ sessionId: "t1", model: "deepseek-v4-flash" });
  const g2 = await orch.pickStart({ sessionId: "t2", model: "glm-5.2" });
  check("通用组：不同会话轮转推进", g1.key !== g2.key, `${g1.key} vs ${g2.key}`);

  // 3b. 亲和过期（TTL 300s）后换把。
  now += DEFAULT_ORCHESTRATOR_PARAMS.affinityTtlMs + 1;
  const expired = await orch.pickStart({ sessionId: "s1", model: "sensenova-6.8-flash-lite" });
  check("亲和 TTL 过期后重新选", expired.key !== undefined, expired.key);

  // 3c. 连续 rate 3 次踢出阻塞态；成功清零。
  now += 1;
  const victim = (await orch.pickStart({ sessionId: "r1", model: "deepseek-v4-flash" })).key;
  const r1 = orch.reportRateLimited(victim);
  const r2 = orch.reportRateLimited(victim);
  const r3 = orch.reportRateLimited(victim);
  check("第 3 次连续 rate 触发踢出", r1.kicked === false && r2.kicked === false && r3.kicked === true,
    JSON.stringify([r1, r2, r3]));
  const snap1 = orch.snapshot();
  check("被踢的 key 进阻塞态", snap1.blocked.some((e) => e.key === victim), JSON.stringify(snap1));
  const r4 = orch.reportRateLimited(victim);
  check("阻塞态再记 rate 不重复踢（借用语义）", r4.kicked === false);

  // 3d. 探测恢复：到期（probeInitialMs 15s 后）探测成功 → 挂回运行态。
  now += DEFAULT_ORCHESTRATOR_PARAMS.probeInitialMs + 1;
  probeResult = true;
  const probed = await orch.runDueProbes();
  check("到期探测发生且恢复", probed >= 1 && orch.snapshot().blocked.every((e) => e.key !== victim),
    `probed=${probed} blocked=${JSON.stringify(orch.snapshot().blocked)}`);

  // 3e. 池格：mark (victim, flash-lite) 后具名组跳过它；general 组不受影响。
  now += 1;
  const poolVictim = (await orch.pickStart({ sessionId: "p1", model: "sensenova-6.8-flash-lite" })).key;
  orch.reportPoolExhausted(poolVictim, "flash-lite");
  let picked = await orch.pickStart({ sessionId: "p2", model: "sensenova-6.8-flash-lite" });
  let guard = 0;
  while (picked.key === poolVictim && guard < 10) {
    picked = await orch.pickStart({ sessionId: `p${guard + 3}`, model: "sensenova-6.8-flash-lite" });
    guard += 1;
  }
  check("池格命中的 key 在具名组被跳过", picked.key !== poolVictim, `${picked.key} vs ${poolVictim}`);
  const generalPick = await orch.pickStart({ sessionId: "g9", model: "kimi-k3" });
  check("general 组不受具名组格子影响", generalPick.key !== undefined, generalPick.key);

  // 3f. 全组标记判据。
  for (const key of orch.snapshot().running) orch.reportPoolExhausted(key, "flash-lite");
  orch.reportPoolExhausted(orch.snapshot().blocked[0]?.key ?? "", "flash-lite");
  check("groupFullyPoolMarked：全池标记后为真", orch.groupFullyPoolMarked("flash-lite") === true);
  check("groupFullyPoolMarked：general 组不受影响", orch.groupFullyPoolMarked("general") === false);

  // 3g. 401 永久移除。
  const before = orch.snapshot();
  const total = before.running.length + before.blocked.length;
  const dead = before.running[0] ?? "";
  orch.reportAuthRejected(dead);
  const after = orch.snapshot();
  check("401 后池成员 -1", after.running.length + after.blocked.length === total - 1,
    JSON.stringify({ before: total, after: after.running.length + after.blocked.length }));

  // 3h. 全局槽：cap=2 下第三个 acquire 排队，release 后放行。
  const rel1 = await orch.acquireSlot();
  const rel2 = await orch.acquireSlot();
  let thirdReleased = false;
  const third = orch.acquireSlot().then((r) => { thirdReleased = true; return r; });
  await new Promise((r) => setTimeout(r, 20));
  check("全局槽满时排队不报错", thirdReleased === false);
  rel1();
  const rel3 = await third;
  check("释放后排队者放行", thirdReleased === true);
  rel2(); rel3();
} catch (e) { fail("KeyOrchestrator", e); }

// ── 3i. refreshKeys：面板改凭据后免重启同步池（2026-10-27「未入池」bug）─────
// 池每进程只首种一次；加 key / 换面板 key / 清面板 key 走 refreshKeys 重解析。
// 语义 = 重启后的首次 seed：新增入池、值变/消失的旧 key 摘出、存量相位保留。
try {
  // id 必须显式稳定：不能用数组下标派生（splice 后全体 id 平移，语义就变了）。
  const accounts = [
    { id: "acc-0", key: "sk-a" },
    { id: "acc-1", key: "sk-b" },
  ];
  const orch = new KeyOrchestrator({
    params: () => ({ ...DEFAULT_ORCHESTRATOR_PARAMS, modelGroups: {} }),
    resolveKeys: async () => accounts.map((a) => ({ id: a.id, key: a.key })),
    probe: async () => true,
  });
  await orch.pickStart({ model: "m" }); // 触发首种（acc-0/acc-1 两把）
  accounts.push({ id: "acc-2", key: "sk-c" }); // 面板加第三把——修复前它永远「未入池」且轮换选不中
  await orch.refreshKeys();
  const st1 = await orch.statusById();
  check("refreshKeys：新加的 key 进池并报 running",
    st1.find((row) => row.id === "acc-2")?.phase === "running", JSON.stringify(st1));
  check("refreshKeys：新 key 可被轮换选中",
    (await orch.pickNext(new Set(["sk-a", "sk-b"]), "general")) === "sk-c",
    JSON.stringify(orch.snapshot().running));

  accounts.shift(); // 删除 acc-0
  await orch.refreshKeys();
  const st2 = await orch.statusById();
  check("refreshKeys：消失的 id 不再出现在 statusById",
    st2.some((row) => row.id === "acc-0") === false, JSON.stringify(st2));
  check("refreshKeys：消失的 key 摘出池",
    orch.snapshot().running.includes("sk-a") === false, JSON.stringify(orch.snapshot().running));

  accounts[0].key = "sk-b2"; // acc-1 换值（同 id 不同 key，面板 key 替换的形态）
  await orch.refreshKeys();
  const st3 = await orch.statusById();
  check("refreshKeys：同 id 换值后新值入池",
    st3.find((row) => row.id === "acc-1")?.phase === "running" && orch.snapshot().running.includes("sk-b2"),
    JSON.stringify(st3));
  check("refreshKeys：换值后旧值不再在池",
    orch.snapshot().running.includes("sk-b") === false, JSON.stringify(orch.snapshot().running));

  // 存量相位跨重种保留：把 acc-1 的新值连踢三次进阻塞态，refreshKeys 后不复活。
  orch.reportRateLimited("sk-b2");
  orch.reportRateLimited("sk-b2");
  const kicked = orch.reportRateLimited("sk-b2");
  check("重种用例前置：连续 3 次 rate 踢出", kicked.kicked === true, JSON.stringify(kicked));
  await orch.refreshKeys();
  const st4 = await orch.statusById();
  check("refreshKeys：阻塞相位跨重种保留（不复活成 running）",
    st4.find((row) => row.id === "acc-1")?.phase === "blocked", JSON.stringify(st4));
} catch (e) { fail("refreshKeys", e); }

// ── 3j. reportQuotaPools：额度驱动的池格写点（2026-10-31 建）───────────────
// 判据与 llm-models.exhaustedModelIds 同源：池耗尽 = (limit>0 && rem<=0)（任一窗口，
// limit 未知不算）；组内出现模型全部耗尽 → 记格、全部有余 → 清格（「判定刷新了」）、
// 混合态不动。30min TTL 兜底不变，此处不涉。
try {
  const orch = new KeyOrchestrator({
    params: () => ({
      ...DEFAULT_ORCHESTRATOR_PARAMS,
      modelGroups: { "m-flash": "flash-lite", "m-kimi": "general" },
      globalConcurrency: 2,
    }),
    resolveKeys: async () => [{ id: "acc-0", key: "sk-q" }],
    probe: async () => true,
  });
  await orch.pickStart({ model: "m-flash" }); // 先种池：groupFullyPoolMarked 对空池（tracked=0）恒 false
  const pools = (p) => ({ pools: p });
  const win = (limit, remaining) => ({ limit, remaining, used: limit - remaining, resetAt: null });
  // 耗尽池 → 记 flash-lite 组格。
  orch.reportQuotaPools("sk-q", pools([{ id: "p1", modelIds: ["m-flash"], window5h: win(100, 0), window7d: win(500, 400) }]));
  check("额度耗尽 → 记组格", orch.groupFullyPoolMarked("flash-lite") === true);
  // 同池额度回正 → 清格（「额度刷新了」的判定）。
  orch.reportQuotaPools("sk-q", pools([{ id: "p1", modelIds: ["m-flash"], window5h: win(100, 80), window7d: win(500, 400) }]));
  check("额度回正 → 清格", orch.groupFullyPoolMarked("flash-lite") === false);
  // limit 未知（0）+ remaining 0 → 不算耗尽（形状漂移防线，与 llm-models 同款）。
  orch.reportQuotaPools("sk-q", pools([{ id: "p1", modelIds: ["m-flash"], window5h: win(0, 0), window7d: win(0, 0) }]));
  check("limit 未知不算耗尽 → 不标", orch.groupFullyPoolMarked("flash-lite") === false);
  // 组内一模型耗尽、另一模型有余（混合态）→ 格子维持原状（模型级并集教义：
  // 只要组内还有模型可用就不动整组——预先手工放一格验证它不被误清）。
  orch.reportPoolExhausted("sk-q", "flash-lite");
  orch.reportQuotaPools("sk-q", pools([
    { id: "p1", modelIds: ["m-flash"], window5h: win(100, 0), window7d: win(0, 0) },
    { id: "p2", modelIds: ["m-flash2"], window5h: win(100, 50), window7d: win(0, 0) },
  ]));
  check("组内混合态 → 格子维持原状", orch.groupFullyPoolMarked("flash-lite") === true);
  // 全部回正 → 清掉混合态遗留的格子。
  orch.reportQuotaPools("sk-q", pools([
    { id: "p1", modelIds: ["m-flash"], window5h: win(100, 30), window7d: win(0, 0) },
    { id: "p2", modelIds: ["m-flash2"], window5h: win(100, 50), window7d: win(0, 0) },
  ]));
  check("全部回正 → 清格", orch.groupFullyPoolMarked("flash-lite") === false);
  // general 组同样参与记账（kimi/glm 在 general）。
  orch.reportQuotaPools("sk-q", pools([{ id: "p3", modelIds: ["m-kimi"], window5h: win(10, 0), window7d: win(0, 0) }]));
  check("general 组同样记账", orch.groupFullyPoolMarked("general") === true);
  // 轮询失败/空体 → 无模型 → 无动作（调用方还会加 error 守卫，此处钉纯函数侧）。
  orch.reportPoolExhausted("sk-q", "flash-lite");
  orch.reportQuotaPools("sk-q", pools([]));
  check("空 pools → 不动格", orch.groupFullyPoolMarked("flash-lite") === true);
} catch (e) { fail("reportQuotaPools", e); }

// ── 4. 归一化 ───────────────────────────────────────────────────────────────
try {
  const accounts = normalizeAccounts([
    { apiKeyRef: "SENSENOVA_API_KEY_2" },
    { id: "b", label: "B", apiKeyRef: " K2 " },
    "junk",
    { label: "no-ref" },
  ]);
  check("normalizeAccounts：丢非法、补缺省、去空白",
    accounts.length === 2 && accounts[0].id === "account-1" && accounts[1].apiKeyRef === "K2",
    JSON.stringify(accounts));
  // 2026-10-27 分组定版：Flash-Lite 专属池只有 flash-lite；u1.5 出图两模型走
  // 通用池（不映射 → general 裸轮转），专属池的限流标记不再误伤通用池模型。
  check("normalizeModelGroups：非对象回落默认（仅 flash-lite 归专属组）",
    normalizeModelGroups("junk")["sensenova-6.8-flash-lite"] === "flash-lite"
    && !("sensenova-u1.5-lite" in normalizeModelGroups("junk"))
    && !("sensenova-u1.5-fast" in normalizeModelGroups("junk")));
  // 2026-10-31 同形钉：orchestrator 死默认表必须与 host-config 运行时默认表一致
  // （0.1.18 两表分叉致亲和静默死路三个月——测试用死默认测出绿的假象）。
  check("orchestrator 默认表与 host-config 默认表同形",
    JSON.stringify(DEFAULT_ORCHESTRATOR_PARAMS.modelGroups) === JSON.stringify(CONFIG_DEFAULTS.modelGroups),
    JSON.stringify([DEFAULT_ORCHESTRATOR_PARAMS.modelGroups, CONFIG_DEFAULTS.modelGroups]));
  const custom = normalizeModelGroups({ "my-model": " custom ", "": "x", "k": 5 });
  check("normalizeModelGroups：收 string→string、去空白、丢非法值",
    custom["my-model"] === "custom" && !("k" in custom), JSON.stringify(custom));
} catch (e) { fail("normalize", e); }

// ── 思考档位首装默认（2026-10-27 用户拍板：按文档原生档位）──────────────────
try {
  const { parsePoolPayload, POOL_STORE_VERSION } = await import("../src/host/pool-store.ts");
  const base = { version: POOL_STORE_VERSION, disabledIds: [], deletedIds: [], globalConcurrency: null, keys: [] };
  const fresh = parsePoolPayload(base);
  check("首装播种：已知模型按原生档位给默认集（deepseek-flash 原生无 medium）",
    JSON.stringify(fresh?.thinking["deepseek-flash"]) === JSON.stringify(["off", "low", "high", "max"])
    && JSON.stringify(fresh?.thinking["kimi-k3"]) === JSON.stringify(["off", "low", "medium", "high", "max"])
    && fresh?.thinking["glm-5.2"]?.includes("xhigh") !== true,
    JSON.stringify(fresh?.thinking));
  const explicit = parsePoolPayload({ ...base, thinking: { "deepseek-flash": [], "kimi-k3": ["max"] } });
  check("显式空数组（全不勾）尊重用户，未提及的模型仍播种",
    Array.isArray(explicit?.thinking["deepseek-flash"]) && explicit.thinking["deepseek-flash"].length === 0
    && JSON.stringify(explicit?.thinking["kimi-k3"]) === JSON.stringify(["max"])
    && (explicit?.thinking["glm-5.2"]?.length ?? 0) > 0,
    JSON.stringify(explicit?.thinking));
} catch (e) { fail("thinking-defaults", e); }

let failed = 0;
for (const r of results) if (!r.pass) failed += 1;
console.log(JSON.stringify(results, null, 2));
if (failed > 0) {
  console.error(`pool.test.mjs：${failed}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`pool.test.mjs：${results.length} 项全过`);
