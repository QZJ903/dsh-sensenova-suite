/**
 * The HTTP route handlers — the registry facade of the routes family.
 *
 * `apply()` (in `index.ts`) stays the single mount seam: it assembles a
 * `wiring` object and hands it to {@link registerRoutes}; each route is its
 * own module (one per resource) that closes over the wiring, so a route never
 * imports a service directly. Nothing here imports a Host peer — the only
 * lazy peer load (the adapter module) happens in the provider publish chain,
 * injected from `apply` via `deps`.
 *
 * The family:
 *
 *   - `routes/http.ts`      — the shared primitives (writeJson, the bounded
 *                             body reader, the fence/method refusals, the
 *                             body ceilings);
 *   - `routes/snapshot.ts`  — the polled read-only snapshot (and the
 *                             failure-code taxonomy);
 *   - `routes/account.ts`   — panel sign-in / forget, trace writes;
 *   - `routes/api-key.ts`   — the `sk-` reference, forget-and-republish;
 *   - `routes/provider.ts`  — the registration switch;
 *   - `routes/models.ts`    — the curated allow-list;
 *   - `routes/pool.ts`      — the pool admin surface (stop / restore / delete
 *                             keys, global concurrency, per-group protocol
 *                             partition — the panel's read-only pool card).
 *
 * The returned `off()` callbacks are handed to `teardown` in this order; the
 * six routes are path-disjoint exact matches, so no unregister depends on
 * another. Public API and export surface are unchanged.
 *
 * 2026-10 收编裁定：出图与第二上游路由随功能移除。
 *
 * @module dsh-sensenova-suite/routes
 */
import { registerSnapshotRoute } from "./routes/snapshot.ts";
import { registerAccountRoute } from "./routes/account.ts";
import { registerApiKeyRoute } from "./routes/api-key.ts";
import { registerProviderRoute } from "./routes/provider.ts";
import { registerModelsRoute } from "./routes/models.ts";
import { registerPoolRoute } from "./routes/pool.ts";
import type { Wiring } from "./types.ts";

/**
 * Register the Token Plan routes on the Host's web server. Each route is its
 * own module; this assembler only decides what they may touch (the wiring)
 * and hands back the unregister callbacks, in registration order — `teardown`
 * runs them last.
 * @param {any} ctx - the host root context (only `ctx.webServer` is used here).
 * @param {Wiring} wiring - assembled by `apply()` in `index.ts.
 * @returns {Array<() => void>} the `off()` unregister callbacks, in
 *   registration order. Spelled out rather than `Function[]` so it matches
 *   what `teardown` now accepts — and note that a JSDoc type is a COMMENT
 *   here, not a type source, so `tsc` never checked this line either way.
 *   The real guarantee for each route is its own `Pick<Wiring, …>` parameter.
 */
export function registerRoutes(ctx: any, wiring: Wiring) {
  return [
    registerSnapshotRoute(ctx, wiring),
    registerAccountRoute(ctx, wiring),
    registerApiKeyRoute(ctx, wiring),
    registerProviderRoute(ctx, wiring),
    registerModelsRoute(ctx, wiring),
    registerPoolRoute(ctx, wiring)
  ];
}
