/** Ids and same-origin routes the client half talks to. */

/** Dictionary namespace this plugin owns. */
export const NS = "dsh-sensenova-suite";

/**
 * The plugin slug, carried by the page root's `data-dsh-plugin` marker (see
 * `panel-page.ts`), so the page stays tied to this plugin.
 *
 * Derived, not re-spelled: `REGISTRATION.id` in `index.ts`, every log
 * prefix in `apply.ts`, and every route below read {@link NS} or this
 * constant, so a rename of the slug has ONE home (`NS`) instead of a dozen
 * literals that could drift. It is NOT a sidebar row id or a slot key — the
 * card registers under `key: NS`.
 */
export const PANEL_ID = NS;

/**
 * The Host's API routes, derived exactly like the Host's own `routes.ts`
 * (`/api/${name}/<resource>`): the client has no import path to the Host,
 * but it OWNS the slug, so each route is spelled from {@link NS} instead of
 * re-writing `/api/dsh-sensenova-suite/…` seven times.
 * `test/config.test.mjs` §6b expands this template, the Host's, and the
 * suite's own literals and requires all three to agree path for path.
 */

/** The Host snapshot route. Relative, same-origin. */
export const SNAPSHOT_PATH = `/api/${NS}/snapshot`;

/** The account route: lets the panel configure itself, no `.env` editing. */
export const ACCOUNT_PATH = `/api/${NS}/account`;

/** The provider-registration switch route (docs/PROVIDER-HOT-RELOAD.md). */
export const PROVIDER_PATH = `/api/${NS}/provider`;

/** The model-roster route: which of this key's models get pushed to DSH. */
export const MODELS_PATH = `/api/${NS}/models`;

/** The key-pool management route（停用/恢复/删除、全局并发）. */
export const POOL_PATH = `/api/${NS}/pool`;

/**
 * The official sign-up / Token Plan console entry. The panel points new
 * users here to register and obtain their free quota (account + API key).
 * A plain public URL — the client only ever opens it in a new tab, never
 * sends it in a credentialed request.
 */
export const SENSENOVA_SIGNUP_URL = "https://www.sensenova.cn/token-plan";
