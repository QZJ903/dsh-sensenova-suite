/**
 * The plugin's side effects — the parts of mounting that are not route
 * handlers.
 *
 * `apply()` is the single mount seam: it assembles the `wiring` object, calls
 * {@link registerRoutes} (routes.ts), then {@link startSideEffects} for:
 *
 *   - the mount seed (`seedPublisherFromCatalog`): offer models before the
 *     first poll, tracked in the effect registry (ADR-008);
 *   - the background provider refresher (`provider-refresh.ts`).
 *
 * and {@link teardown} for the unmount order that PITFALLS §18 pins: dispose
 * the publisher, release the pair, then run the route `off` callbacks. It
 * must NOT be simplified.
 *
 * 2026-10 收编裁定：出图工具、第二上游 mount seed 与 web-search 接管随其模块移除。
 *
 * Peer-free discipline: no Host peer is imported here.
 *
 * @module dsh-sensenova-suite/lifecycle
 */
import { seedPublisherFromCatalog } from "./provider-publish.ts";
import { armProviderRefresher } from "./provider-refresh.ts";
import { type EffectRegistry } from "./effects.ts";
import type { Wiring } from "./types.ts";

/**
 * Run the mount-time side effects: the persisted-catalog seed and the
 * background provider refresher.
 * @param {{ get?: (n: string) => unknown; [key: string]: unknown }} ctx - the host root context.
 * @param {Wiring} wiring - assembled by `apply()`; the fields read here are
 *   `publisher` / `catalogStore` / `settings` / `logger`
 *   / `providerRefresh`.
 * @param {EffectRegistry} effects - the mount-time effect registry (ADR-008):
 *   each side effect starts now and is tracked under a short label instead of
 *   an anonymous fire-and-forget IIFE, so the unmount can let them settle
 *   before teardown (the registry never blocks the mount itself).
 * @returns {void} — every effect starts on call and is tracked in the registry.
 */
export function startSideEffects(_ctx: { get?: (n: string) => unknown; [key: string]: unknown }, wiring: Wiring, effects: EffectRegistry) {
  const { publisher, catalogStore, settings } = wiring;

  // Seed the registration from the persisted catalog so a restarted Host
  // offers models before its first poll (and with no console login at all).
  // Tracked, not fire-and-forget: a state dir that cannot be read just waits
  // for the poll, and the unmount's drain lets a still-settling seed finish
  // before the publisher is disposed. The last KNOWN quota-exhausted set
  // rides the seed too (v2 record): a restart must not hand the picker back
  // the models the last known poll blocked (the three-state rule applies at
  // boot — a v1 record states nothing and the fresh-install offer is wide).
  effects.add("catalog-seed", () =>
    seedPublisherFromCatalog(
      publisher,
      () => catalogStore.list(),
      () => catalogStore.listEnabledIds(),
      () => catalogStore.listUnavailable()
    )
  );

  // Background freshness for the standing provider (2026-10 review #1b): the
  // panel's poll used to be the ONLY refresher of the catalog/quota state a
  // REGISTERED provider keeps serving — while the panel lives and dies with
  // the browser tab. This effect arms the same aggregate engine on a slow
  // cadence (config `providerRefreshMinutes`, default 15, 0 = off); arming
  // keys on the cadence ALONE — the EFFECTIVE provider switch is re-read
  // inside every tick, so an off Host's ticks do literally nothing (no console
  // probe, no aggregate). The handle lives in the `providerRefresh` slot and
  // `teardown` closes it.
  effects.add("provider-refresh", async () => {
    if (settings.providerRefreshMinutes <= 0) return;
    const handle = armProviderRefresher(wiring, settings.providerRefreshMinutes);
    if (handle !== null) wiring.providerRefresh.current = handle;
  });

}

/**
 * Unmount, in the order PITFALLS §18 pins:
 *
 *   1. `dispose` — a publish still in flight (the mount seed's, or a poll's)
 *      must not register into a Host that is letting this plugin go;
 *   2. `release` — stop offering the provider first, so a request cannot be
 *      routed to an adapter whose Host services are already half gone;
 *   3. the route `off()` callbacks, each guarded (the web server may already
 *      be gone during shutdown).
 *
 * This order is a concurrency fix and must NOT be simplified. The caller
 * (the unmount cleanup in `apply`) drains the effect registry BEFORE this
 * runs, so by the time these lines execute every mount-time effect has
 * either settled or been reported as a straggler by its label.
 * @param {Wiring} wiring - assembled by `apply()`; the fields read here are
 *   `publisher` / `releaseProvider` / `providerRefresh`, so the type says
 *   exactly that shape.
 * @param {Array<() => void>} offs - the unregister callbacks from
 *   {@link registerRoutes}. `Function[]` was the old spelling and it is
 *   `any[]` in disguise — a `Function` may be called with any arguments and
 *   return anything, so it pinned neither the shape nor the arity.
 * @returns {void}
 */
export function teardown(wiring: Pick<Wiring, "publisher" | "releaseProvider" | "providerRefresh">, offs: Array<() => void>) {
  // Stop the background refresher's clock FIRST among the timers: a tick that
  // fires between this line and `publisher.dispose()` would be stopped by the
  // disposed gate anyway, but clearing the interval here means a withdrawing
  // Host never schedules another one. Idempotent through the slot: never
  // armed (config 0 / provider off at mount) reads as `null`.
  try {
    wiring.providerRefresh.current?.close();
    wiring.providerRefresh.current = null;
  } catch {
    // Nothing downstream depends on the clock being stopped twice-proof.
  }
  const { publisher, releaseProvider } = wiring;
  // Before anything else: a publish still in flight (the mount seed's, or a
  // poll's) must not register into a Host that is letting this plugin go.
  publisher.dispose();
  // Stop offering the provider first, so a request cannot be routed to an
  // adapter whose Host services are already half gone.
  releaseProvider();
  for (const off of offs) {
    try {
      off();
    } catch {
      // The web server may already be gone during shutdown.
    }
  }
}
