/**
 * catalog-gate 纯判定单测——目录抓取的「发不发、发之前能回什么」。
 *
 * 背景（2026-10-31）：失败退避（60s）期内旧实现无条件回现有缓存，实例从未成功
 * 过时那是空数组——DSH 侧表现为「错误横幅消失但模型列表空白干等一分钟」（真机
 * 横幅：`SenseNova 加载失败：The operation was aborted due to timeout`，10s 目录
 * 超时后进入退避期）。现钉：退避期内空缓存的种子回落与每段一次补发、正常路径
 * 重置补发额度、TTL/凭据变化守卫。纯 Node 无 peer。
 */
import { planCatalogFetch, MODELS_TIMEOUT_MS, CATALOG_TTL_MS, CATALOG_FAILURE_RETRY_MS } from "../src/host/catalog-gate.ts";
import { results, check, fail } from "./harness.mjs";

const NOW = 10_000_000;
const baseInput = { now: NOW, credential: "sk-a", apiBase: "https://token.sensenova.cn/v1", cacheCredential: "sk-a", cacheApiBase: "https://token.sensenova.cn/v1", seed: undefined };
const baseState = { cachedEntries: 0, fetchedAt: 0, nextRetryAt: 0, emptyRetryUsed: false };
const seed = (entries = ["m1"]) => ({ credential: "sk-a", apiBase: "https://token.sensenova.cn/v1", entries });
const inBackoff = (extraState = {}) => ({ ...baseState, nextRetryAt: NOW + 60_000, ...extraState });

try {
  // ── 1. 常量（数值被 adapter 依赖，漂移即红）──────────────────────────────
  check("目录超时 10s", MODELS_TIMEOUT_MS === 10_000);
  check("目录 TTL 24h", CATALOG_TTL_MS === 86_400_000);
  check("失败退避 60s", CATALOG_FAILURE_RETRY_MS === 60_000);

  // ── 2. TTL / 凭据守卫 ──────────────────────────────────────────────────
  check("TTL 内回缓存", planCatalogFetch({ ...baseState, cachedEntries: 5, fetchedAt: NOW - 1_000 }, baseInput).action === "serve-cache");
  check("TTL 过期 → send（不清 404 失败缓存）",
    JSON.stringify(planCatalogFetch({ ...baseState, cachedEntries: 5, fetchedAt: NOW - CATALOG_TTL_MS - 1 }, baseInput)) ===
    JSON.stringify({ action: "send", invalidateFailedModels: false }));
  check("凭据变 → send 且清 404 失败缓存（TTL 不护跨凭据）",
    JSON.stringify(planCatalogFetch({ ...baseState, cachedEntries: 5, fetchedAt: NOW - 1_000 }, { ...baseInput, credential: "sk-b" })) ===
    JSON.stringify({ action: "send", invalidateFailedModels: true }));
  check("apiBase 变 → send 且清 404 失败缓存",
    JSON.stringify(planCatalogFetch({ ...baseState, cachedEntries: 5, fetchedAt: NOW - 1_000 }, { ...baseInput, apiBase: "https://other.example/v1" })) ===
    JSON.stringify({ action: "send", invalidateFailedModels: true }));
  check("从未成功且无退避 → send（首拉）", planCatalogFetch(baseState, baseInput).action === "send");

  // ── 3. 失败退避期 ──────────────────────────────────────────────────────
  check("退避期内有缓存 → 回缓存（现状不变）",
    planCatalogFetch(inBackoff({ cachedEntries: 5, fetchedAt: NOW - CATALOG_TTL_MS - 1 }), baseInput).action === "serve-cache");
  check("退避期内空缓存 + 可用种子 → serve-seed",
    planCatalogFetch(inBackoff(), { ...baseInput, seed: seed() }).action === "serve-seed");
  check("种子凭据不符 → 不可用（退避期内空缓存未用补发 → send-forced）",
    JSON.stringify(planCatalogFetch(inBackoff(), { ...baseInput, seed: { ...seed(), credential: "sk-b" } })) ===
    JSON.stringify({ action: "send-forced", invalidateFailedModels: false }));
  check("种子 apiBase 不符 → 不可用",
    planCatalogFetch(inBackoff(), { ...baseInput, seed: { ...seed(), apiBase: "https://other.example/v1" } }).action === "send-forced");
  check("种子空数组 → 不可用",
    planCatalogFetch(inBackoff(), { ...baseInput, seed: seed([]) }).action === "send-forced");
  check("退避期内空缓存 + 无种子 + 补发未用 → send-forced（每段一次）",
    JSON.stringify(planCatalogFetch(inBackoff(), baseInput)) ===
    JSON.stringify({ action: "send-forced", invalidateFailedModels: false }));
  check("退避期内空缓存 + 补发已用 → serve-empty（不再补，防秒级循环）",
    planCatalogFetch(inBackoff({ emptyRetryUsed: true }), baseInput).action === "serve-empty");
  check("退避到期 → send（新失败段补发额度由调用方重置）",
    JSON.stringify(planCatalogFetch({ ...baseState, nextRetryAt: NOW - 1, emptyRetryUsed: true }, baseInput)) ===
    JSON.stringify({ action: "send", invalidateFailedModels: false }));
  // 退避期内种子可用但缓存非空：缓存优先（种子只是空缓存的降级路）。
  check("退避期内缓存非空时不看种子",
    planCatalogFetch(inBackoff({ cachedEntries: 3 }), { ...baseInput, seed: seed() }).action === "serve-cache");
} catch (e) { fail("catalog-gate", e); }

console.log(JSON.stringify(results, null, 2));
const failedChecks = results.filter((r) => !r.pass);
if (failedChecks.length > 0) {
  console.error(`\ncatalog-gate.test.mjs：${failedChecks.length}/${results.length} 项失败`);
  for (const r of failedChecks) console.error(`  FAIL ${r.name} — ${r.detail}`);
  process.exit(1);
}
console.log(`catalog-gate.test.mjs：${results.length} 项全过`);
