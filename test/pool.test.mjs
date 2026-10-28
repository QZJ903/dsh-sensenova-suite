/**
 * 池层与分类层单测——纯 Node、无 peer。
 *
 * 钉住的契约：
 *   - classify429Full 四分类（code 8 / 429001 / 池特征串 / 未知兜底）；
 *   - parseRetryAfterMs 秒数与 HTTP 日期两形态；
 *   - KeyOrchestrator：按组亲和（商汤组粘、通用组轮）、(key,组) 池格跳过
 *     与 groupFullyPoolMarked、连续 rate 踢出（阈值 3）、探测到期恢复、
 *     全局槽排队、refreshKeys 重种（新增入池/消失摘出/存量相位保留）；
 *   - normalizeAccounts / normalizeModelGroups 的丢弃与回落。
 */
import { strict as assert } from "node:assert";
import { classify429Full, classify429Body, parseRetryAfterMs } from "../src/host/rate-classify.ts";
import { KeyOrchestrator, DEFAULT_ORCHESTRATOR_PARAMS } from "../src/host/key-orchestrator.ts";
import { normalizeAccounts, normalizeModelGroups } from "../src/host/host-config.ts";

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
  const plainQuota = classify429Body('{"error":{"code":8}}');
  check("classify429Body 兼容面：code 8 quota:true", plainQuota.quota === true && plainQuota.kind === "rate");
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

  // 3a. 商汤组亲和：同会话连续 pick 同一把；通用组两次 pick 推进游标。
  const first = await orch.pickStart({ sessionId: "s1", model: "sensenova-6.8-flash-lite" });
  const again = await orch.pickStart({ sessionId: "s1", model: "sensenova-6.8-flash-lite" });
  check("商汤组：同会话粘同一把", first.key === again.key, `${first.key} vs ${again.key}`);
  check("商汤组：groupOf 报 sensenova", first.group === "sensenova", first.group);
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

  // 3e. 池格：mark (victim, sensenova) 后商汤组跳过它；general 组不受影响。
  now += 1;
  const poolVictim = (await orch.pickStart({ sessionId: "p1", model: "sensenova-u1.5-lite" })).key;
  orch.reportPoolExhausted(poolVictim, "sensenova");
  let picked = await orch.pickStart({ sessionId: "p2", model: "sensenova-u1.5-lite" });
  let guard = 0;
  while (picked.key === poolVictim && guard < 10) {
    picked = await orch.pickStart({ sessionId: `p${guard + 3}`, model: "sensenova-u1.5-lite" });
    guard += 1;
  }
  check("池格命中的 key 在商汤组被跳过", picked.key !== poolVictim, `${picked.key} vs ${poolVictim}`);
  const generalPick = await orch.pickStart({ sessionId: "g9", model: "kimi-k3" });
  check("general 组不受商汤组格子影响", generalPick.key !== undefined, generalPick.key);

  // 3f. 全组标记判据。
  for (const key of orch.snapshot().running) orch.reportPoolExhausted(key, "sensenova");
  orch.reportPoolExhausted(orch.snapshot().blocked[0]?.key ?? "", "sensenova");
  check("groupFullyPoolMarked：全池标记后为真", orch.groupFullyPoolMarked("sensenova") === true);
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
