/**
 * 目录抓取的门槛判定（纯函数、无 peer）——fetchCatalog 的「发不发、发之前能
 * 回什么」一个判据源。
 *
 * 背景（2026-10-31）：失败退避（60s）期内旧实现无条件回现有缓存——实例从未
 * 成功过时那是空数组，DSH 侧表现为「错误横幅消失但模型列表空白干等一分钟」。
 * 现给退避期内的空缓存两条降级路，防循环的初衷不变：
 *
 *   1. **种子回落**：模块级跨实例种子（同凭据同端点且非空）可服务——同进程里
 *      兄弟实例成功过时，本实例失败期仍有目录可显（种子过期与否由认领方的 TTL
 *      判定兜住，本模块只看「能不能用」）；
 *   2. **补发一次**：进程冷启动后首次失败（通常无种子，且 10s 瞬时超时高发）
 *      每段退避期补发一枪；补发再失败继续安静到退避到期——`emptyRetryUsed`
 *      保证每段退避只补一次，不会退化成秒级重试循环（退避存在的理由）。
 *
 * 正常路径（退避到期后的实发）会重置 `emptyRetryUsed`——新的失败段又有一次
 * 补发额度。标记的存取都在调用方（adapter 实例字段），本模块只读输入。
 *
 * @module dsh-sensenova-suite/catalog-gate
 */

/** 目录抓取超时（毫秒）。商汤 /v1/models 秒级；10s 覆盖慢抖动，超过按失败退避。 */
export const MODELS_TIMEOUT_MS = 10_000;

/**
 * 目录缓存 TTL（毫秒）：宿主（模型选择器/策略 UI）会以秒级周期反复调用
 * listModels()（2026-10-10 Loon 实测 ~5s 一次），而模型目录变化极慢。
 * 缓存命中期间从内存应答，不发 HTTP；用户明确「一天一次够用」。
 */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** 目录刷新失败后的退避（毫秒）：防止故障时退化为秒级重试循环。 */
export const CATALOG_FAILURE_RETRY_MS = 60_000;

/** 判定输入的实例侧状态（adapter 实例字段的原样投影）。 */
export interface CatalogGateState {
  /**
   * 现有缓存条目数（0 = 没有可服务的缓存条目：本实例从未成功，或成功抓到过
   * 空目录——两种状态在退避期内走同两条降级路）。
   */
  cachedEntries: number;
  /** 上次成功时刻（epoch ms；0 = 从未成功）。 */
  fetchedAt: number;
  /** 失败退避到期时刻（epoch ms；0 = 无退避）。 */
  nextRetryAt: number;
  /** 本段退避期内「空缓存补发一次」是否已用掉。 */
  emptyRetryUsed: boolean;
}

/** 判定输入的请求侧与种子侧事实。 */
export interface CatalogGateInput {
  now: number;
  credential: string;
  apiBase: string;
  /** 现有缓存对应的凭据（undefined = 无记录）。 */
  cacheCredential: string | undefined;
  cacheApiBase: string | undefined;
  /** 模块级跨实例种子（同进程最后一次成功快照；可为 undefined）。 */
  seed: { credential: string; apiBase: string; entries: readonly unknown[] } | undefined;
}

export type CatalogGateDecision =
  | { action: "serve-cache" }
  | { action: "serve-seed" }
  | { action: "serve-empty" }
  | { action: "send"; invalidateFailedModels: boolean }
  | { action: "send-forced"; invalidateFailedModels: boolean };

/**
 * 目录抓取门槛：TTL 命中 → 缓存；退避期内按「有缓存 / 有种子 / 补发额度」
 * 三级降级；否则实发（凭据或端点变化时让 fetchCatalogUncached 清 404 失败缓存）。
 */
export function planCatalogFetch(state: CatalogGateState, input: CatalogGateInput): CatalogGateDecision {
  const credentialChanged = input.cacheCredential !== undefined && input.cacheCredential !== input.credential;
  const apiBaseChanged = input.cacheApiBase !== undefined && input.cacheApiBase !== input.apiBase;
  // D1 层 2（2026-11-04 拍板修）：404 失败缓存只随端点失效——MODEL_NOT_FOUND 是
  // 「模型 id 不被路由」的服务端状态，与用哪把 key 无关；旧判据含 credentialChanged
  // 会让多 key 池换 key 重拉即清失败缓存（下线模型回列表 → 又 404 → 循环）。
  // 缓存命中仍要求两者都没变：/models 列表按账号出线，换 key 的目录不可信。
  const invalidateFailedModels = apiBaseChanged;
  // 缓存命中：同 key、同 base、未过期。
  if (!credentialChanged && !apiBaseChanged && state.fetchedAt > 0 && input.now - state.fetchedAt < CATALOG_TTL_MS) {
    return { action: "serve-cache" };
  }
  // 失败退避期内：有缓存回缓存；缓存为空走两条降级路（模块头注释）。
  if (state.nextRetryAt > input.now) {
    if (state.cachedEntries > 0) return { action: "serve-cache" };
    if (input.seed !== undefined && input.seed.credential === input.credential
      && input.seed.apiBase === input.apiBase && input.seed.entries.length > 0) {
      return { action: "serve-seed" };
    }
    return state.emptyRetryUsed ? { action: "serve-empty" } : { action: "send-forced", invalidateFailedModels };
  }
  return { action: "send", invalidateFailedModels };
}
