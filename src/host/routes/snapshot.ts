/**
 * The snapshot route — the one read-only route the Client panel polls.
 *
 * Part of the routes split (see `../routes.ts` for the family map). The
 * aggregation itself lives in `snapshot-aggregate.ts`; this module is the
 * HTTP edge: the trust fence, the config-error short-circuit, the vision
 * write-back, and the `ok:false` shape with its code taxonomy.
 *
 * @module dsh-sensenova-suite/routes/snapshot
 */
import { name } from "../host-config.ts";
import { buildSnapshotBody, failureCode } from "../snapshot-aggregate.ts";
import { CODE } from "../codes.ts";
import { optional } from "../util.ts";
import { degrade } from "../util.ts";
import { writeJson, refuseMethod, withOrigin, redactedError } from "./http.ts";
import type { Wiring } from "../types.ts";

/** The one read-only route the Client panel polls. */
export const SNAPSHOT_PATH = `/api/${name}/snapshot`;

/**
 * Register the snapshot route. Wiring subset: `settings`, `configError`,
 * `cache`, `inflight`, `tokenStore`, `publisher`,
 * `catalogStore`, `providerStore`, `visionPublish`, `logger`.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param {Pick<Wiring, "settings" | "configError" | "cache" | "inflight" | "tokenStore" | "publisher" | "catalogStore" | "providerStore" | "logger">} wiring
 *   - the subset this route reads, as assembled by `apply()` in `index.ts`.
 *
 *   No count is spelled out here on purpose. The field list above IS the
 *   contract, and a hand-written "twelve of twenty-two" beside it is a second
 *   source with no compiler behind it — it said twenty-two while `Wiring` had
 *   twenty fields, and nothing noticed for a week. A reader who needs the
 *   size counts the names, or asks `tsc` by adding a key.
 * @returns {Function} the `off()` unregister callback.
 */
export function registerSnapshotRoute(ctx: any, wiring: Pick<Wiring, "settings" | "configError" | "cache" | "inflight" | "tokenStore" | "resolveCatalogApiKey" | "publisher" | "catalogStore" | "providerStore" | "logger"> & { poolSnapshot?: () => unknown }) {
  const { settings, configError, cache, inflight, tokenStore, publisher, catalogStore, providerStore, logger } = wiring;
  const poolSnapshot = wiring.poolSnapshot;

  return ctx.webServer.register({
    kind: "exact",
    path: SNAPSHOT_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      if (request.method !== undefined && request.method !== "GET" && request.method !== "HEAD") {
        refuseMethod(response);
        return;
      }
      if (configError !== null) {
        // The panel maps this code to its own line, so the operator sees the
        // misconfiguration instead of a generic network failure.
        writeJson(response, 200, {
          ok: false,
          code: CODE.CONFIG_ERROR,
          error: configError,
          auth: await optional(tokenStore.state())
        }, { "cache-control": "no-store" });
        return;
      }
      try {
        const body = await buildSnapshotBody({
          settings,
          cache,
          inflight,
          tokenStore,
          resolveCatalogApiKey: wiring.resolveCatalogApiKey,
          publisher,
          catalogStore,
          panelSwitch: () => optional(providerStore.enabled()),
          ...(typeof poolSnapshot === "function" ? { poolSnapshot } : {}),
          onShapeDrift: (message: string) => degrade(message, null, logger, null)
        });
        writeJson(response, 200, body, { "cache-control": "no-store" });
      } catch (error) {
        // Distinguish "we cannot get a token" from "the console call failed":
        // the first is fixed by logging in, the second is usually transient.
        writeJson(response, 200, {
          ok: false,
          error: redactedError(error),
          code: failureCode(error),
          auth: await optional(tokenStore.state())
        }, { "cache-control": "no-store" });
      }
    }, settings.allowedHosts)
  });
}
