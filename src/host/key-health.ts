/**
 * 「这次失败该不该换一把 key」的判定 —— 适配器失败出口的兜底（纯逻辑、无 peer）。
 *
 * 适配器只对「认识的理由」换 key：401、配额类 429（code 8 / 429001 / Endpoint 族 /
 * ModelAccount 族）、池类 429。平台换一种拒绝形态时，剩下的失败一律原地重试：
 *
 * - **分类器不认识的 429**：注释一直写着「unknown 兜底按 rate 处理（轮转+可重试）」，
 *   但旧实现只轮换 quota/pool 两类，unknown 落到不轮换。宿主会把同一把 key 重试到
 *   预算耗尽（10 次）才报错——`EndpointTPMExceeded` 在补分类前就是这种形态。
 * - **402/403**：账号态拒绝（欠费 / 禁用 / 无权限）。这两类不在宿主可重试清单里，
 *   不轮换就直接上屏，而另一把 key 很可能能用。
 *
 * 判据刻意很窄：400/404/413/422 是请求或路由的问题，换 key 不会变好；5xx、超时、
 * 传输错误是平台或网络的问题，换 key 也不变好。宁可漏判，不做全场误判。
 *
 * @module dsh-sensenova-suite/key-health
 */

/**
 * 这次失败是否应当触发一次「换一把 key 试」。
 *
 * @param status - HTTP 状态码。
 * @param alreadyRotating - 本次失败是否已由 401 / 配额 429 / 池 429 路径参与轮换
 *   （那三条路径自己会换，不重复触发）。
 * @returns 是否应当走兜底轮换。
 */
export function shouldRotateUnclassified(status: number, alreadyRotating: boolean): boolean {
  if (alreadyRotating) return false;
  // 429 = 分类器没认出来的限流形态；402/403 = 账号态拒绝。
  return status === 429 || status === 402 || status === 403;
}
