/**
 * 目录抓取的门槛判定（纯函数、无 peer）——fetchCatalog 的「发不发」一个判据源。
 *
 * 2026-11-06 重构（他拍板）：失败退避（60s）整个拆除。旧设计防「宿主秒级问询
 * 在故障时退化成秒级重试循环」，但拉模型不占上游限额、被防的风暴无害，代价却是
 * 真机事故（2026-11-06）：拉取失败后 60s 内每次问询瞬时回空，选择器失败/消失、
 * 重试按了等于没按，重启才恢复。现在的失败语义（adapter 侧实现）：
 *
 *   - 每次调用都真发（单飞去重仍在）；
 *   - 失败即回落本地底座（落盘 catalog.json，adapter 冷启动认领）——选择器
 *     永远有目录可显，不再有回空/失败行的死窗；
 *   - 失败后 30s 一次后台自动重试直到成功（不叠加、unref、卸载即停）；
 *   - 失败与恢复各落一行 traceLog（此前目录路径零留痕，事故无从查起）。
 *
 * 判据只剩两问：TTL 内吗（回缓存）？凭据/端点变了吗（实发；端点变清 404
 * 失败缓存——MODEL_NOT_FOUND 是服务端路由状态，只随端点失效，D1 层 2）。
 *
 * @module dsh-sensenova-suite/catalog-gate
 */

/** 目录抓取超时（毫秒）。商汤 /v1/models 秒级；10s 覆盖慢抖动，超过按失败处理。 */
export const MODELS_TIMEOUT_MS = 10_000;

/**
 * 目录缓存 TTL（毫秒）：宿主（模型选择器/策略 UI）会以秒级周期反复调用
 * listModels()（2026-10-10 Loon 实测 ~5s 一次），而模型目录变化极慢。
 * 缓存命中期间从内存应答，不发 HTTP；用户明确「一天一次够用」。
 */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** 拉取失败后的后台自动重试间隔（毫秒）：失败即排一次，成功即停；不叠加。 */
export const CATALOG_AUTO_RETRY_MS = 30_000;

/** 判定输入的实例侧状态（adapter 实例字段的原样投影）。 */
export interface CatalogGateState {
  /** 上次成功时刻（epoch ms；0 = 从未成功）。 */
  fetchedAt: number;
}

/** 判定输入的请求侧事实。 */
export interface CatalogGateInput {
  now: number;
  credential: string;
  apiBase: string;
  /** 现有缓存对应的凭据（undefined = 无记录）。 */
  cacheCredential: string | undefined;
  cacheApiBase: string | undefined;
}

export type CatalogGateDecision =
  | { action: "serve-cache" }
  | { action: "send"; invalidateFailedModels: boolean };

/**
 * 目录抓取门槛：TTL 命中且凭据/端点未变 → 缓存；否则实发（端点变化时让
 * fetchCatalogUncached 清 404 失败缓存）。失败不做任何门槛——调用方回落本地
 * 底座 + 30s 自动重试（模块头注释）。
 */
export function planCatalogFetch(state: CatalogGateState, input: CatalogGateInput): CatalogGateDecision {
  const credentialChanged = input.cacheCredential !== undefined && input.cacheCredential !== input.credential;
  const apiBaseChanged = input.cacheApiBase !== undefined && input.cacheApiBase !== input.apiBase;
  // D1 层 2（2026-11-04 拍板修）：404 失败缓存只随端点失效——MODEL_NOT_FOUND 是
  // 「模型 id 不被路由」的服务端状态，与用哪把 key 无关。
  const invalidateFailedModels = apiBaseChanged;
  // 缓存命中：同 key、同 base、未过期。
  if (!credentialChanged && !apiBaseChanged && state.fetchedAt > 0 && input.now - state.fetchedAt < CATALOG_TTL_MS) {
    return { action: "serve-cache" };
  }
  return { action: "send", invalidateFailedModels };
}
