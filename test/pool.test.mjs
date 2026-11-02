/**
 * 池层与分类层单测——纯 Node、无 peer。
 *
 * 钉住的契约：
 *   - classify429Full 七分类（code 8 / 429001 / 429003=rate-soft / insufficient_quota /
 *     Endpoint* / ModelAccount* / 池特征串 / 未知兜底；insufficient_quota 2026-10-31
 *     依上游 freeapi 订正从池特征串移出按 tpm 处理；429003 同日改 rate-soft——
 *     轮换不记 strike）；**桶维（2026-11-02 统一退避）**：踢出判据只看 bucket
 *     （tpm 计、rpm 不计），作用域族按 code 里的 TPM/RPM 定桶；退避值统一走
 *     一套梯子（PROBE_BACKOFF_STEPS_MS = 3/5/10/15/30s，30 封顶）；kind 仅日志标签；
 *   - parseRetryAfterMs 秒数与 HTTP 日期两形态；
 *   - KeyOrchestrator：按组亲和（商汤组粘、通用组轮）、(key,组) 池格跳过
 *     与 groupFullyPoolMarked、连续 rate 踢出（阈值 3）、探测到期恢复、
 *     全局槽排队（含中止不占额度）、refreshKeys 重种（新增入池/消失摘出/存量相位保留）、
 *     snapshot().poolGrid 诊断投影打码（key 段过 maskKey、组名保留，U4-D1）；
 *   - normalizeAccounts / normalizeModelGroups 的丢弃与回落。
 */
import { strict as assert } from "node:assert";
import { classify429Full, classify429Body, bucketCountsStrike, probeFloorFor, PROBE_BACKOFF_STEPS_MS, parseRetryAfterMs } from "../src/host/rate-classify.ts";
import { KeyOrchestrator, DEFAULT_ORCHESTRATOR_PARAMS } from "../src/host/key-orchestrator.ts";
import { DEFAULT_KEY_POOL_PARAMS } from "../src/host/key-pool.ts";
import { normalizeAccounts, normalizeModelGroups, CONFIG_DEFAULTS } from "../src/host/host-config.ts";

const results = [];
const check = (name, ok, detail = "") => results.push({ name, pass: ok === true, detail: String(detail) });
const fail = (group, error) => results.push({ name: group, pass: false, detail: String(error) });

// ── 1. classify429Full ──────────────────────────────────────────────────────
try {
  const rps = classify429Full('{"error":{"code":8,"message":"rps exhausted"}}');
  check("code 8 → rate-rps（floor=梯子首档 3s）", rps.kind === "rate-rps" && rps.retryFloorMs === 3_000, JSON.stringify(rps));
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
  check("429003 → rate-soft（rpm 桶，不记 strike）", code429003.kind === "rate-soft" && code429003.bucket === "rpm", JSON.stringify(code429003));
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
  // 踢出阈值单一判据（2026-11-02 定稿：按桶）：只有 TPM 桶计数；RPM 桶
  // （code 8 / 429003 / *RPM* 族）14s 级自愈不计数；pool/unknown 另有口径。
  check("strike 判据：tpm 计数", bucketCountsStrike("tpm") === true);
  check("strike 判据：rpm 不计", bucketCountsStrike("rpm") === false);
  check("strike 判据：undefined（pool/unknown）不计", bucketCountsStrike(undefined) === false);
  // 桶接线：作用域族按 code 里的 TPM/RPM 定桶（2026-11-02）
  check("EndpointTPMExceeded → bucket=tpm", endpoint.bucket === "tpm", JSON.stringify(endpoint));
  check("EndpointRPMExceeded → bucket=rpm", endpointRpm.bucket === "rpm", JSON.stringify(endpointRpm));
  check("ModelAccountRpmRateLimitExceeded → bucket=rpm", account.bucket === "rpm", JSON.stringify(account));
  check("ModelAccountTpmRateLimitExceeded → bucket=tpm", accountTpm.bucket === "tpm", JSON.stringify(accountTpm));
  check("code 8 → bucket=rpm", rps.bucket === "rpm", JSON.stringify(rps));
  check("429001 → bucket=tpm", tpm.bucket === "tpm", JSON.stringify(tpm));
  check("429003 → bucket=rpm", code429003.bucket === "rpm", JSON.stringify(code429003));
  check("unknown → bucket=undefined", unknown.bucket === undefined, JSON.stringify(unknown));
  check("pool → bucket=undefined（走格子，不走 strike）", pool.bucket === undefined, JSON.stringify(pool));
  // 退避统一（2026-11-02 他拍板）：所有配额类共用一套梯子 3/5/10/15/30s、30 封顶。
  check("梯子 = 3/5/10/15/30s（30 封顶）", JSON.stringify(PROBE_BACKOFF_STEPS_MS) === "[3000,5000,10000,15000,30000]", JSON.stringify(PROBE_BACKOFF_STEPS_MS));
  check("probeFloorFor(0) = 3s（入口首档）", probeFloorFor(0) === 3_000);
  check("probeFloorFor(4) = 30s（末档）", probeFloorFor(4) === 30_000);
  check("probeFloorFor(99) 停在末档 30s", probeFloorFor(99) === 30_000);
  check("probeFloorFor(-1) 钳到首档 3s", probeFloorFor(-1) === 3_000);
  check("分类层静态 floor = 梯子首档（快慢同值）", rps.retryFloorMs === probeFloorFor(0) && tpm.retryFloorMs === probeFloorFor(0) && endpointRpm.retryFloorMs === probeFloorFor(0), `${rps.retryFloorMs}/${tpm.retryFloorMs}/${endpointRpm.retryFloorMs}`);
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

  // 3a'. 每轮起点轮换（2026-11-02 他要求「避免总是固定账户优先」）：
  // excludeStart = 上一轮起点 ⇒ 裸轮转组从它的下一位环回，起点推进一位。
  // 亲和组忽略该参（亲和 key 恒第一）。
  const seq = [];
  let start = (await orch.pickStart({ sessionId: "rot", model: "deepseek-v4-flash" })).key;
  seq.push(start);
  for (let i = 0; i < 3; i += 1) {
    start = (await orch.pickStart({ sessionId: "rot", model: "deepseek-v4-flash", excludeStart: start })).key;
    seq.push(start);
  }
  check("通用组：4 轮起点两两不同（轮换到位）", new Set(seq).size === 4 || new Set(seq).size === keys.length, JSON.stringify(seq));
  check("通用组：第 2 轮起点 ≠ 第 1 轮起点", seq[1] !== seq[0], JSON.stringify(seq));
  check("通用组：第 3 轮起点 ≠ 第 2 轮起点", seq[2] !== seq[1], JSON.stringify(seq));
  check("通用组：第 4 轮起点 ≠ 第 3 轮起点", seq[3] !== seq[2], JSON.stringify(seq));
  const aff1 = await orch.pickStart({ sessionId: "aff", model: "sensenova-6.8-flash-lite" });
  const aff2 = await orch.pickStart({ sessionId: "aff", model: "sensenova-6.8-flash-lite", excludeStart: aff1.key });
  check("亲和组：excludeStart 被忽略（亲和 key 恒第一）", aff1.key === aff2.key, `${aff1.key} vs ${aff2.key}`);

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

  // 3d-b. 探测成功不动池格（2026-11-03 S2=B 拍板）：/models 200 只证明 key 活着，
  // 不证明积分回血——探测前打的格在探测恢复后必须仍然生效，清点留给 TTL 与额度回正。
  now += 1;
  const gridVictim = (await orch.pickStart({ sessionId: "q1", model: "deepseek-v4-flash" })).key;
  orch.reportRateLimited(gridVictim);
  orch.reportRateLimited(gridVictim);
  orch.reportRateLimited(gridVictim); // 再踢进阻塞态
  orch.reportPoolExhausted(gridVictim, "flash-lite");
  now += DEFAULT_ORCHESTRATOR_PARAMS.probeInitialMs + 1;
  probeResult = true;
  await orch.runDueProbes();
  check("探测恢复后 key 回运行态", orch.snapshot().running.includes(gridVictim),
    JSON.stringify(orch.snapshot()));
  const postProbe = await orch.pickStart({ sessionId: "q2", model: "sensenova-6.8-flash-lite" });
  check("探测成功不清池格：该组仍跳过它（S2=B）", postProbe.key !== gridVictim,
    `${postProbe.key} vs ${gridVictim}`);

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

  // 3f-b. 诊断投影打码（U4-D1）：snapshot().poolGrid 的 key 段过 maskKey 再出
  // （shared/wire.ts PoolDiagData 契约），内部判据串不受影响——上一行全标判据
  // 在同一份内部 Map 上依旧为真。钉投影形状：含 maskKey 点串、无 key 原文、组名段保留。
  const maskedGrid = orch.snapshot().poolGrid;
  check("poolGrid 投影非空且 key 段已打码（含 maskKey 点串 U+00B7）",
    maskedGrid.length > 0 && maskedGrid.every((mark) => mark.includes("\u00B7")), JSON.stringify(maskedGrid));
  check("poolGrid 投影不含 key 原文",
    maskedGrid.every((mark) => !mark.includes(poolVictim)), JSON.stringify(maskedGrid));
  check("poolGrid 投影组名段保留",
    maskedGrid.every((mark) => mark.endsWith("\u0000flash-lite")), JSON.stringify(maskedGrid));

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

  // 3h-b. 排队期间中止（U4-T2）：等待者拿空 release、不占额度、不惊动队列——
  // 「中止的等待者不占额度」的 inflight 守恒语义（此前零钉）。
  const held1 = await orch.acquireSlot();
  const held2 = await orch.acquireSlot();
  const abortCtrl = new AbortController();
  let abortReleased = false;
  const waiter = orch.acquireSlot(abortCtrl.signal).then((r) => { abortReleased = true; return r; });
  await new Promise((r) => setTimeout(r, 20));
  check("中止前排队者未放行", abortReleased === false);
  abortCtrl.abort();
  const noopRelease = await waiter;
  check("中止的等待者被放行且在途不变（从未占额度）",
    abortReleased === true && orch.snapshot().inflight === 2);
  noopRelease();
  check("空 release 不动在途计数", orch.snapshot().inflight === 2);
  held1(); held2();
  check("原持者释放后归零", orch.snapshot().inflight === 0);

  // 3h-c. cap 热缩小：释放只在真有空位时放行等待者，不造超限在途（U4 顺带④）。
  const c1 = await orch.acquireSlot();
  const c2 = await orch.acquireSlot();
  let capWoken = false;
  const capWaiter = orch.acquireSlot().then((r) => { capWoken = true; return r; });
  await new Promise((r) => setTimeout(r, 20));
  params.globalConcurrency = 1; // 热缩小
  c1();
  await new Promise((r) => setTimeout(r, 20));
  check("cap 缩小后释放不放行等待者（在途不超限）", capWoken === false && orch.snapshot().inflight === 1,
    `woken=${capWoken} inflight=${orch.snapshot().inflight}`);
  c2();
  const capRelease = await capWaiter;
  check("出现真空位后放行", capWoken === true && orch.snapshot().inflight === 1,
    `woken=${capWoken} inflight=${orch.snapshot().inflight}`);
  capRelease();
  params.globalConcurrency = 2; // 还原（本段 orch 后续无消费，纯卫生）
  check("cap 热缩收尾归零", orch.snapshot().inflight === 0);
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
  // U1 审计确定问题 4：id 是池管理/显示的索引键（phaseById、disable/restoreById
  // 都按 id 作用）——重 id 先到先得，保留 id "default"（面板主 key 恒占）丢弃。
  const deduped = normalizeAccounts([
    { id: "a", apiKeyRef: "K1" },
    { id: "a", apiKeyRef: "K2" },
    { id: "default", apiKeyRef: "K3" },
    { apiKeyRef: "K4" },
    { id: "account-4", apiKeyRef: "K5" },
  ]);
  check("normalizeAccounts：重 id 先到先得、default 保留、缺省 id 不撞已占 id",
    deduped.length === 2 && deduped[0].id === "a" && deduped[0].apiKeyRef === "K1"
      && deduped[1].id === "account-4" && deduped[1].apiKeyRef === "K4",
    JSON.stringify(deduped));
  const collided = normalizeAccounts([
    { id: "account-2", apiKeyRef: "K1" },
    { apiKeyRef: "K2" },
    { apiKeyRef: "K3" },
  ]);
  check("normalizeAccounts：缺省 id 与先到显式 id 相撞时丢弃（先到先得）",
    collided.length === 2 && collided[0].id === "account-2" && collided[1].id === "account-3",
    JSON.stringify(collided));
  // U1 审计复核补记 §四：kickThreshold 双默认——池层默认运行时恒被 orchestrator
  // 层覆盖（index.ts 展开传入、poolDeps 转发），两处必须同步改（modelGroups 的
  // 同形教训），此钉防再分叉。
  check("kickThreshold 双默认同形（池层 = orchestrator 层）",
    DEFAULT_KEY_POOL_PARAMS.kickThreshold === DEFAULT_ORCHESTRATOR_PARAMS.kickThreshold,
    `${DEFAULT_KEY_POOL_PARAMS.kickThreshold} vs ${DEFAULT_ORCHESTRATOR_PARAMS.kickThreshold}`);
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

// ── vision 首装默认（2026-11-03 S3 拍板：默认值是给新用户用的）───────────────
try {
  const { emptyPoolRecord } = await import("../src/host/pool-store.ts");
  const fresh = emptyPoolRecord();
  check("首装（无文件）vision 默认勾选集就在空记录里（S3）",
    JSON.stringify(fresh.vision.visionModels) === JSON.stringify(["deepseek-flash", "kimi-k3", "sensenova-6.8-flash-lite"]),
    JSON.stringify(fresh.vision));
} catch (e) { fail("vision-defaults", e); }

// ── N. pool-store 文件面：ADR-006 拒绝表面化 + 读-改-写串行化（2026-10-31 处置轮）──
try {
  const { createFilePoolStore } = await import("../src/host/pool-store.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const homes = [];
  const withHome = (work) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "suite-poolstore-"));
    homes.push(home);
    const prev = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    return Promise.resolve()
      .then(work)
      .finally(() => {
        if (prev === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prev;
      });
  };
  // pool-store 的路径在创建时定型（profileStateDir(name, null)），env 必须先设。
  const poolFileOf = (home) => path.join(home, "state", "dsh-sensenova-suite", "pool.json");
  const logger = { warn: () => {} };

  // 1) ADR-006 拒绝表面化：盘上是「更新构建」写的 pool.json（本构建只认 v1），
  //    任何变更必须抛拒因、磁盘不被覆盖、缓存不 remember 未落盘的值。
  await withHome(async () => {
    const home = homes[homes.length - 1];
    fs.mkdirSync(path.dirname(poolFileOf(home)), { recursive: true });
    fs.writeFileSync(poolFileOf(home), JSON.stringify({ version: 2, disabledIds: ["x"] }), "utf8");
    const store = createFilePoolStore({ logger });
    let refused = "";
    try { await store.setGlobalConcurrency(4); } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    check("盘上未知版本的 pool.json：变更抛 ADR-006 拒因（不再静默 no-op）",
      refused.includes("refusing to overwrite") && refused.includes("pool.json"), refused);
    check("拒绝后磁盘仍是外来版本（未被本构建覆盖）",
      JSON.parse(fs.readFileSync(poolFileOf(home), "utf8")).version === 2);
  });

  // 2) 读-改-写串行化：并发的三个变更各自拿到同一份底稿时后写者会整份冲掉
  //    先写者——排队后三笔都必须落盘（修复前此钉必红）。
  await withHome(async () => {
    const store = createFilePoolStore({ logger });
    await Promise.all([
      store.setGlobalConcurrency(4),
      store.setDefaultNote("备注"),
      store.disable("key-1")
    ]);
    const record = await store.read();
    check("并发变更不丢更新（读-改-写串行化）",
      record.globalConcurrency === 4 && record.defaultNote === "备注" && record.disabledIds.includes("key-1"),
      JSON.stringify(record));
  });

  // 3) 队列隔离失败：一次拒绝不毒化后续变更。
  await withHome(async () => {
    const home = homes[homes.length - 1];
    fs.mkdirSync(path.dirname(poolFileOf(home)), { recursive: true });
    fs.writeFileSync(poolFileOf(home), JSON.stringify({ version: 2, disabledIds: [] }), "utf8");
    const store = createFilePoolStore({ logger });
    await store.setGlobalConcurrency(4).catch(() => {});
    // 外来构建退场：换回本构建可认的载荷，下一个变更必须照常落盘。
    fs.writeFileSync(poolFileOf(home), JSON.stringify({ version: 1, disabledIds: [], deletedIds: [], globalConcurrency: null, keys: [] }), "utf8");
    await store.setDefaultNote("拒绝之后仍要落盘");
    const onDisk = JSON.parse(fs.readFileSync(poolFileOf(home), "utf8"));
    check("拒绝不毒化队列：后一个变更照常落盘（且被拒的全局并发数没有被 remember）",
      onDisk.defaultNote === "拒绝之后仍要落盘" && onDisk.globalConcurrency === null,
      JSON.stringify(onDisk));
  });
} catch (e) { fail("pool-store-file-surface", e); }

let failed = 0;
for (const r of results) if (!r.pass) failed += 1;
console.log(JSON.stringify(results, null, 2));
if (failed > 0) {
  console.error(`pool.test.mjs：${failed}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`pool.test.mjs：${results.length} 项全过`);
