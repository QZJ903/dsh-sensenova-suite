/**
 * The inference API-key route (`sk-…`), step three of the one-stop plan.
 *
 * Part of the routes split (see `../routes.ts` for the family map). The
 * secret-free state is all the form ever gets: present or not, and whether it
 * came from the credentials service or the environment. Forget drops the
 * panel-saved REFERENCE only and re-publishes the empty offer.
 *
 * @module dsh-sensenova-suite/routes/api-key
 */
import { name } from "../host-config.ts";
import { syncSignaturesAfterPublish } from "../provider-publish.ts";
import { optional } from "../util.ts";
import { clearCoalescedFetch } from "../coalesced-fetch.ts";
import { writeJson, refuseMethod, readJsonBodyOr400, withOrigin, redactedError } from "./http.ts";
import type { Wiring } from "../types.ts";

/** The inference API-key route (`sk-…`), step three of the one-stop plan. */
export const API_KEY_PATH = `/api/${name}/api-key`;

/**
 * Register the API-key route. Wiring subset: `settings`, `apiKeyStore`,
 * `catalogStore`, `providerState`, `publishProvider`, `cache`, `inflight`,
 * `logger`, `poolAdmin`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {Pick<Wiring, "settings" | "apiKeyStore" | "catalogStore" | "providerState" | "publishProvider" | "cache" | "inflight" | "logger" | "poolAdmin">} wiring
 *   - the subset this route reads, as assembled by `apply()` in `index.ts`.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerApiKeyRoute(ctx: any, wiring: Pick<Wiring, "settings" | "apiKeyStore" | "catalogStore" | "providerState" | "publishProvider" | "cache" | "inflight" | "logger" | "poolAdmin">) {
  const { settings, apiKeyStore, catalogStore, providerState, publishProvider, cache, inflight, logger, poolAdmin } = wiring;

  return ctx.webServer.register({
    kind: "exact",
    path: API_KEY_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      // Same trust fence as the other two routes: a foreign page must not be
      // able to plant or wipe an inference key.
      const method = request.method === undefined ? "GET" : request.method;
      // The secret-free state is all the form ever gets: present or not, and
      // whether it came from the credentials service or the environment.
      const answer = async (extra = {}) =>
        writeJson(
          response,
          200,
          { ok: true, ...(await optional(apiKeyStore.state(), { hasApiKey: false, keySource: null, ephemeral: false })), ...extra },
          { "cache-control": "no-store" }
        );
      if (method === "GET") {
        await answer();
        return;
      }
      if (method !== "POST") {
        refuseMethod(response);
        return;
      }
      const body = await readJsonBodyOr400(request, response);
      if (body === null) return;
      // Forget: drop the panel-saved REFERENCE only. An environment value is
      // deliberately left standing (forget cannot delete an operator's .env),
      // and the cached catalog answers the old key until the poll after.
      if (body.value.forget === true) {
        try {
          await apiKeyStore.forget();
          // The key itself is already gone; a leftover cached catalog would only
          // surface stale models on the next poll. If the clear fails we still
          // answer success, but record it — silently losing it would make a
          // "forgot the key but old models still offered" report undebuggable.
          await catalogStore.clear()
            .catch((error: unknown) => logger?.warn?.(`${name}: catalog cache clear failed after api-key forget`, error));
          clearCoalescedFetch(cache, inflight);
          await publishProvider([], [], []);
          // The signatures must not keep claiming a stale offer after the teardown:
          // re-sync them to what was just published, or the next poll re-publishes
          // (churns) an already-empty offer.
          syncSignaturesAfterPublish(providerState);
          // 清除面板 key 后把池里驻留的旧 default 槽一并摘出：池每进程只首种
          // 一次，不重解析则请求继续用已清除的旧 key（2026-10-27）。
          await poolAdmin?.refreshKeys()
            .catch((error: unknown) => logger?.warn?.(`${name}: pool reseed failed after api-key forget`, error));
          await answer();
        } catch (error) {
          await answer({ ok: false, error: redactedError(error) });
        }
        return;
      }
      try {
        await apiKeyStore.save(body.value.apiKey);
      } catch (error) {
        await answer({ ok: false, error: redactedError(error) });
        return;
      }
      // The next poll fetches the catalog with the new key; a stale catalog
      // cached under a previous key must not survive it. The key itself is
      // resolved per REQUEST by the adapter, so no provider rebuild is needed.
      // Generation-bumping clear: a catalog flight from the OLD key that lands
      // after this point must not be served as the new key's models.
      clearCoalescedFetch(cache, inflight);
      // 但池侧不是每请求解析：default 槽按首次 seed 的旧值驻留，保存新面板
      // key 后必须重解析，否则请求继续用旧 key（与加 key 不入池同一根因）。
      await poolAdmin?.refreshKeys()
        .catch((error: unknown) => logger?.warn?.(`${name}: pool reseed failed after api-key save`, error));
      await answer();
    }, settings.allowedHosts)
  });
}
