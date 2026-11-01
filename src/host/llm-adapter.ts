/**
 * The peer-dependent half of the suite's LLM provider — the WIRE adapter
 * factory.
 *
 * Replaces the former pi-ai assembly module (retired with step 3): the
 * registered adapter is the ported `SensenovaAdapter` from
 * the wire implementation, speaking anthropic / responses / chat-completions
 * directly against the SenseNova gateway with the symmetric downgrade chain.
 * Everything pool-related (multi-account rotation, session affinity by credit
 * group, the (key, group) pool-429 grid, the global in-flight cap, probe
 * recovery) lives in `key-orchestrator.ts` and is handed in here as one
 * object; this module only wires the two together into the
 * `{ adapter, providerIds }` shape the publish chain registers.
 *
 * Peer-dependent by design (like its predecessor): it imports
 * `@deepseek-ai/dsh-llm` statically, so the offline suites substitute a fake
 * factory through `deps.loadAdapterModule` and never load this file.
 *
 * @module dsh-sensenova-suite/llm-adapter
 */
import { LlmError } from "@deepseek-ai/dsh-llm";
import { SensenovaAdapter } from "./adapter.ts";
import { LLM_PROVIDER_ID } from "./llm-models.ts";
import type { KeyOrchestrator } from "./key-orchestrator.ts";

/** The pool-facing contract this factory needs (index.ts provides it). */
export interface PoolFacade {
  /** 编排层本体（选 key / 轮换 / 上报 / 全局槽）。 */
  orchestrator: KeyOrchestrator;
  /** 每模型降级链覆盖（面板"协议"三槽；pool.json `modelProtocols` 分区；闭包读取，保存即生效）。 */
  protocolOverrides: () => Record<string, string[]>;
  /** 每模型可用思考档位（面板"思考档位"勾选；pool.json `thinking` 分区）。 */
  thinkingOverrides: () => Record<string, string[]>;
  /** 图片桥换图器（vision/bridge.ts createImageSwapper 的产物；缺省 = 不换）。 */
  visionSwapper?: (messages: unknown, context: { model: string }) => Promise<unknown>;
  /** 原生出图通路的图像解析（附件服务直读 → base64；缺省 = 图片占位出站）。 */
  resolveImageAccess?: (ref: unknown) => Promise<{ base64: string; mediaType: string } | undefined>;
  /** 用户「可看图」勾选集实时读（pool.json vision.visionModels）——图像能力唯一真源：
   * 目录申报边界（listModels/resolveModel）与请求期 entry 注记都从这里读。 */
  visionModelIds?: () => readonly string[];
}

/**
 * Build the factory the publish chain calls (`createSensenovaAdapter`).
 *
 * The publish chain hands `{ entries, enabledIds, baseUrl,
 * unavailableModelIds, maxTokensOverrides }`; with the wire adapter the
 * catalog is the adapter's own (`fetchCatalog` → GET {apiBase}/models), so
 * `entries` is unused and the allow-list / quota-mark semantics ride the
 * `catalogFilter` seam instead. The old `resolveApiKey`/`get` build args are
 * GONE (2026-10-31 cleanup): the key is resolved per request by the pool and
 * services come from the Host, so the args had no reader. `maxTokensOverrides`
 * IS live: it rides the adapter deps and resolveModel resolves the request
 * ceiling from it (`maxTokensForId`, override > catalogue figure — the same
 * order the panel roster quotes).
 *
 * @param {PoolFacade} pool - the orchestrator facade from `index.ts`.
 * @returns {(args: object) => Promise<{adapter: unknown, providerIds: string[]}>}
 *   the async factory matching the publish chain's await-and-shape-check.
 */
export function createAdapterFactory(pool: PoolFacade) {
  const { orchestrator } = pool;
  return async function createSensenovaAdapter({
    baseUrl,
    enabledIds,
    unavailableModelIds,
    maxTokensOverrides,
  }: {
    entries?: unknown;
    enabledIds?: unknown;
    baseUrl: string;
    unavailableModelIds?: string[];
    /**
     * `{ "<model id>": ceiling }` — the deployment's per-model output ceiling
     * (settings row `maxTokensOverrides`, sanitized at the config seam).
     * resolveModel consults it BEFORE the catalogue's own figure via
     * `llm-models.maxTokensForId` — the SAME order the panel roster quotes, so
     * the displayed 「最大输出」 and the wire's `defaultMaxTokens` cannot
     * disagree. Absent/empty = the catalogue is authoritative.
     */
    maxTokensOverrides?: Record<string, number>;
  }): Promise<{ adapter: unknown; providerIds: string[] }> {
    const apiBase = typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : "https://token.sensenova.cn/v1";
    const enabled = Array.isArray(enabledIds) ? enabledIds.filter((id): id is string => typeof id === "string") : [];
    const unavailable = Array.isArray(unavailableModelIds)
      ? unavailableModelIds.filter((id): id is string => typeof id === "string")
      : [];
    const snapshot = orchestrator.snapshot();
    const accountCount = Math.max(1, snapshot.running.length + snapshot.blocked.length);

    const adapter = new SensenovaAdapter({
      options: () => ({
        apiBase,
        // accountCount 驱动轮换上限（全池轮询一圈）。每请求重读快照，
        // 池成员变化（401 移除 / 探测恢复）即时生效。
        accountCount: (() => {
          const live = orchestrator.snapshot();
          return Math.max(1, live.running.length + live.blocked.length);
        })(),
        // per-key 固定 1；全局上限在池层的 requestSlot。
        concurrency: 1,
        // suite 默认开：429 粘性换 key（PLAN 翻 D5，freeapi+proxy 双佐证）。
        quotaRotation: true,
        wireProtocol: "auto",
        reasoningSummary: "auto",
      }),
      // 目录拉取等非请求上下文：走通用组（无亲和），无 key 时按宿主契约
      // 抛 MISSING_CREDENTIAL 让目录优雅降级为空。
      resolveApiKey: async () => {
        try {
          const picked = await orchestrator.pickStart({ model: "" });
          return picked.key;
        } catch {
          throw new LlmError("dsh-sensenova-suite: no usable SenseNova API key (pool empty)", "MISSING_CREDENTIAL");
        }
      },
      // 请求路径：带会话与模型，池层按积分组分派（商汤组粘性 / 通用组轮转）。
      resolveApiKeyForRequest: async (request) => {
        try {
          const picked = await orchestrator.pickStart(request);
          return picked.key;
        } catch {
          throw new LlmError("dsh-sensenova-suite: no usable SenseNova API key (pool empty)", "MISSING_CREDENTIAL");
        }
      },
      // 全局在途上限：排队等待而非报错。
      requestSlot: async (signal?: AbortSignal) => orchestrator.acquireSlot(signal),
      // 轮换：401 → 永久移除并取下一把；rate/pool 类 429 → 记数/记格并取下一把。
      // 组一律按 groupOf(本次请求模型) 现算（2026-10-31 修：此前写侧硬编码
      // "general"，读侧按请求模型的组查——专属池模型的格子写读两侧组名错位，
      // 专属池耗尽拦不住自己、反而误伤通用组的健康 key）。额度侧的主动记/清走
      // 发布链 reportQuotaPools（snapshot-aggregate 的 onQuotaPools 回调），
      // 两条路写同一份格子，此处注释不再假设另一条不存在。
      rotateApiKey: async (rejectedKey, rejection, model) => {
        const group = orchestrator.groupOf(model);
        const exclude = new Set([rejectedKey]);
        if (rejection === "invalid-credential") {
          orchestrator.reportAuthRejected(rejectedKey);
          return orchestrator.pickNext(exclude, group);
        }
        if (rejection === "pool-exhausted") {
          orchestrator.reportPoolExhausted(rejectedKey, group);
          // 全池中招快速失败（PLAN §5.2 判据首次接线，2026-10-31）：该组每把
          // key（含阻塞态）都标着池耗尽时不再借阻塞 key 硬试，直接让本请求
          // 落「换无可换」——borrow 语义会无视格子，这里必须显式拦。
          if (orchestrator.groupFullyPoolMarked(group)) return undefined;
          return orchestrator.pickNext(exclude, group);
        }
        // rate-unclassified（未知形状 429 / 402 / 403）：只换，不记 strike——
        // 一次未知形态不足以断定这把 key 坏了；真正的判断留给后续重复命中。
        // rate-soft（两个速率桶形态 code 8 / 429003，2026-10-31 他拍板）：rpm 桶
        // 14s 级自愈，计入踢出阈值会把贴线限流的健康 key 踢出池——同样只换不记。
        if (rejection !== "rate-unclassified" && rejection !== "rate-soft") orchestrator.reportRateLimited(rejectedKey);
        return orchestrator.pickNext(exclude, group);
      },
      // 2xx 上报：清连续限流计数、救回被借用的阻塞 key。
      reportOutcome: (key) => orchestrator.reportSuccess(key),
      // 面板允许清单与额度标记在目录出线处过滤（每次 publish 重新读）。
      catalogFilter: () => ({ enabledIds: enabled, unavailableIds: unavailable }),
      // 图片桥换图器（vision/bridge.ts）：请求边界把图片块换成转述观察。
      // exactOptionalPropertyTypes：缺省用条件展开，不显式传 undefined。
      ...(pool.visionSwapper !== undefined ? { imageSwapper: pool.visionSwapper } : {}),
      // 原生出图通路：勾选「可看图」的模型图片原样进请求，字节从这里读。
      ...(pool.resolveImageAccess !== undefined ? { resolveImageAccess: pool.resolveImageAccess } : {}),
      // 可看图勾选集实时读：申报边界 + 请求期注记的唯一真源（见 adapter Deps）。
      ...(pool.visionModelIds !== undefined ? { visionModelIds: pool.visionModelIds } : {}),
      // 每模型协议覆盖（面板"协议"列；每次请求读取）。
      protocolOverrides: () => pool.protocolOverrides(),
      // 每模型可用思考档位（面板"思考档位"勾选；存 pool.json thinking 分区）。
      thinkingOverrides: () => pool.thinkingOverrides(),
      // 每模型最大输出天花板（settings 行 maxTokensOverrides，文档天花板覆盖
      // 滞后目录）：resolveModel 经 maxTokensForId 以「override > 目录值」现算
      // defaultMaxTokens——与面板「最大输出」同一判据，读到的数字即请求上限。
      maxTokensOverrides: () => maxTokensOverrides ?? null,
    });
    // accountCount 的初值只在构造期用一次（上面的 IIFE 每请求重读）。
    void accountCount;
    return { adapter, providerIds: [LLM_PROVIDER_ID] };
  };
}
