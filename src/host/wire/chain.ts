/** 生效降级链合成（per-model-protocol-chain，2026-10-30 用户拍板）。
 *
 * 从 plan.ts 拆出的原因：合成要在两处消费——决策走查（plan.ts，peer 环境）与
 * 快照下发（snapshot-aggregate.ts，必须 peer-free 才能在干净 checkout 上单测）。
 * 本模块只 import type（编译期擦除）与 types.ts，零运行时 peer 依赖。
 *
 * 三层合成（层层回落，结果恒非空）：
 *
 * ```
 * 面板覆盖（pool.json modelProtocols[model]，有序子集 ≤3）
 *   ?? wireProtocol 配置（auto 之外的值映射为单线链）
 *   ?? 档案默认链（facts.defaultChain：常规 an>re>chat；kimi/glm re>chat）
 * ```
 * @module dsh-sensenova-suite/wire/chain
 */
import type { ModelFacts, WireKind } from './types.ts';
import type { WirePlanConfig } from './plan.ts';

/** 链走查耗尽后的全局兜底：chat 是三线中表达最全的参考方言，无降级条件（plan 走查消费）。 */
export const GLOBAL_FALLBACK_CHAIN: readonly WireKind[] = ['chat-completions'];

/** 面板/手编链值防线：只认三条 wire，去重保序，截到 3（三槽上限，截头保留用户优先线）。 */
function sanitizeChain(chain: readonly unknown[] | undefined): readonly WireKind[] | undefined {
  if (!Array.isArray(chain)) return undefined;
  const seen = new Set<string>();
  const out: WireKind[] = [];
  for (const entry of chain) {
    if (entry !== 'anthropic' && entry !== 'responses' && entry !== 'chat-completions') continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 生效链合成：面板覆盖 ?? 配置强制单线 ?? 档案默认链。
 * @param modelChain - 面板链覆盖（可为任意形状；非法/空整体回落下一层）。
 */
export function effectiveChain(
  config: WirePlanConfig,
  facts: ModelFacts,
  modelChain?: readonly unknown[],
): readonly WireKind[] {
  const override = sanitizeChain(modelChain);
  if (override !== undefined) return override;
  const protocol = config.wireProtocol;
  if (protocol === 'anthropic' || protocol === 'responses' || protocol === 'chat-completions') {
    return [protocol];
  }
  return facts.defaultChain;
}
