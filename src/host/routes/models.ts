/**
 * The model-roster curation route.
 *
 * Part of the routes split (see `../routes.ts` for the family map). POST-only:
 * an absent `enabledModelIds` is refused rather than read as "all models", the
 * curated allow-list is capped, and a save re-publishes immediately with the
 * CURRENT catalogue (a failed publish rolls back inside `publishProvider`).
 *
 * @module dsh-sensenova-suite/routes/models
 */
import { name } from "../host-config.ts";
import { normalizeEnabledIds } from "../catalog-store.ts";
import { syncSignaturesAfterPublish } from "../provider-publish.ts";
import { optional } from "../util.ts";
import { resolveSwitchEnabled } from "../switch-precedence.ts";
import { writeJson, refuseMethod, readJsonBodyOr400, withOrigin, MAX_ENABLED_MODEL_IDS, redactedError } from "./http.ts";
import type { Wiring } from "../types.ts";

/** The model-roster route (docs/API.md). */
export const MODELS_PATH = `/api/${name}/models`;

/** 协议覆盖的最小存储面（pool-store 的子集；测试可替身）。 */
interface ProtocolStore {
  setModelProtocol(modelId: string, protocol: string | null): Promise<void>;
}

/**
 * Register the models route. Wiring subset: `settings`, `catalogStore`,
 * `providerStore`, `providerState`, `publishProvider`, and optionally
 * `poolStore`（协议覆盖的落盘处；缺省时协议保存被拒）.
 */
export function registerModelsRoute(ctx: any, wiring: Pick<Wiring, "settings" | "catalogStore" | "providerStore" | "providerState" | "publishProvider"> & { poolStore?: ProtocolStore; poolRefresh?: () => Promise<void> }) {
  const { settings, catalogStore, providerStore, providerState, publishProvider } = wiring;
  const poolStore = wiring.poolStore;
  const poolRefresh = wiring.poolRefresh;

  return ctx.webServer.register({
    kind: "exact",
    path: MODELS_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      // Same fence as the other routes: a foreign page must not be able to
      // decide which models this Host offers.
      const method = request.method === undefined ? "POST" : request.method;
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      const answer = async (extra = {}) => {
        writeJson(response, 200, {
          ok: true,
          ...(Array.isArray(body.value.enabledModelIds)
            ? { enabledModelIds: await optional(catalogStore.listEnabledIds(), providerState.enabledIds) }
            : {}),
          registerProvider:
            resolveSwitchEnabled(await optional(providerStore.enabled()), settings.registerProvider),
          providerRegistered: providerState.registered,
          ...(providerState.error !== null ? { providerError: providerState.error } : {}),
          ...extra
        }, { "cache-control": "no-store" });
      };
      try {
        // 协议覆盖可单独提交；允许清单缺席被拒绝而不是读作"全量"（那会静默
        // 把 offer 放大到整个目录）。
        const hasProtocols = typeof body.value.modelProtocols === "object"
          && body.value.modelProtocols !== null
          && !Array.isArray(body.value.modelProtocols);
        if (!Array.isArray(body.value.enabledModelIds) && !hasProtocols) {
          writeJson(response, 400, { ok: false, error: "expected { enabledModelIds: string[] } or { modelProtocols }" },
            { "cache-control": "no-store" });
          return;
        }
        // 协议覆盖先行落盘（每模型一条；"auto"/null 即清除覆盖）。
        if (hasProtocols && poolStore !== undefined) {
          for (const [modelId, protocol] of Object.entries(body.value.modelProtocols as Record<string, unknown>)) {
            if (typeof modelId !== "string" || modelId === "") continue;
            await poolStore.setModelProtocol(modelId, typeof protocol === "string" ? protocol : null);
          }
        }
        // 协议覆盖写盘后立刻刷新编排层的本地记录：快照的 modelProtocols 读的
        // 是它，不刷新的话面板要等探测周期才看到自己的改动。
        if (hasProtocols && typeof poolRefresh === "function") await poolRefresh();
        if (!Array.isArray(body.value.enabledModelIds)) {
          await answer();
          return;
        }
        const ids = normalizeEnabledIds(body.value.enabledModelIds);
        if (ids.length > MAX_ENABLED_MODEL_IDS) {
          writeJson(response, 400,
            { ok: false, error: `enabledModelIds is too long (max ${MAX_ENABLED_MODEL_IDS})` },
            { "cache-control": "no-store" });
          return;
        }
        const persisted = await catalogStore.setEnabledIds(ids);
        // Publish immediately with the CURRENT catalogue: the offer must not
        // wait for the next poll. A failed publish rolls back to the previous
        // pair inside publishProvider and surfaces its reason.
        await publishProvider(providerState.entries, ids, providerState.unavailableIds ?? []);
        // Adopt the signature of what was just offered so the next poll does not
        // see a "change" and re-publish the same set — but only when the write
        // actually reached the disk. The signature also gates the NEXT write:
        // a signature describing an offer the disk does not hold would skip the
        // write that fixes it, and the disk would keep the old allow-list until a
        // restart re-seeded it. A failed write is logged by the store.
        if (persisted) syncSignaturesAfterPublish(providerState);
      } catch (error) {
        await answer({ ok: false, error: redactedError(error) });
        return;
      }
      await answer();
    }, settings.allowedHosts)
  });
}
