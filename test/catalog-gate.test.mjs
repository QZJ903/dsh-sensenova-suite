/**
 * catalog-gate 纯判定单测——目录抓取的「发不发」一个判据源。
 *
 * 2026-11-06 重构（他拍板）：失败退避（60s）整个拆除——拉模型不占上游限额，
 * 冷却防的风暴无害，代价却是真机事故（拉取失败后 60s 内每次问询瞬时回空，
 * 选择器失败/消失、重试按了等于没按，重启才恢复）。现钉：TTL/凭据/端点三守卫、
 * 失败不做任何门槛（每次调用都真发）、自动重试间隔常量。失败回落与自动重试的
 * 行为钉在 provider.test.mjs 的 adapter island（需要假 fetch 与时钟缩尺）。
 * 纯 Node 无 peer。
 */
import { planCatalogFetch, MODELS_TIMEOUT_MS, CATALOG_TTL_MS, CATALOG_AUTO_RETRY_MS } from "../src/host/catalog-gate.ts";
import { results, check, fail } from "./harness.mjs";

const NOW = 10_000_000;
const baseInput = { now: NOW, credential: "sk-a", apiBase: "https://token.sensenova.cn/v1", cacheCredential: "sk-a", cacheApiBase: "https://token.sensenova.cn/v1" };
const baseState = { fetchedAt: 0 };

try {
  // ── 1. 常量（数值被 adapter 依赖，漂移即红）──────────────────────────────
  check("目录超时 10s", MODELS_TIMEOUT_MS === 10_000);
  check("目录 TTL 24h", CATALOG_TTL_MS === 86_400_000);
  check("自动重试间隔 30s", CATALOG_AUTO_RETRY_MS === 30_000);

  // ── 2. TTL / 凭据 / 端点守卫 ────────────────────────────────────────────
  check("TTL 内回缓存", planCatalogFetch({ fetchedAt: NOW - 1_000 }, baseInput).action === "serve-cache");
  check("TTL 过期 → send（不清 404 失败缓存）",
    JSON.stringify(planCatalogFetch({ fetchedAt: NOW - CATALOG_TTL_MS - 1 }, baseInput)) ===
    JSON.stringify({ action: "send", invalidateFailedModels: false }));
  check("凭据变 → send 但不清 404 失败缓存（D1 层 2：下线是服务端路由状态，与 key 无关；TTL 仍不护跨凭据）",
    JSON.stringify(planCatalogFetch({ fetchedAt: NOW - 1_000 }, { ...baseInput, credential: "sk-b" })) ===
    JSON.stringify({ action: "send", invalidateFailedModels: false }));
  check("apiBase 变 → send 且清 404 失败缓存",
    JSON.stringify(planCatalogFetch({ fetchedAt: NOW - 1_000 }, { ...baseInput, apiBase: "https://other.example/v1" })) ===
    JSON.stringify({ action: "send", invalidateFailedModels: true }));
  check("从未成功 → send（首拉）", planCatalogFetch(baseState, baseInput).action === "send");

  // ── 3. 失败不做门槛（2026-11-06 拍板：拉模型不占限额，冷却只制造死窗）────
  // 判据里没有「失败状态」输入：gate 只回答发不发，失败回落/自动重试全在
  // adapter 侧——这里钉的是「gate 不可能拦住一次重试」。
  check("判据输入不含失败/退避状态（结构钉）",
    JSON.stringify(Object.keys(baseState).sort()) === JSON.stringify(["fetchedAt"]) &&
    !("nextRetryAt" in planCatalogFetch(baseState, baseInput)) &&
    !("seed" in baseInput));
} catch (e) { fail("catalog-gate", e); }

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\ncatalog-gate.test.mjs：${failedChecks.length}/${results.length} 项失败`);
  for (const r of failedChecks) console.error(`  FAIL ${r.name} — ${r.detail}`);
  process.exit(1);
}
console.log(`catalog-gate.test.mjs：${results.length} 项全过`);
