/**
 * Block 4 of the token-store split: the sign-in refusal state machine.
 * Owns the throttle's read/write/clear and the local backoff doubling.
 * record adoption, and the refusal-shape error synthesis.
 *
 * No state of its own; operates on the shared context from `state.ts`.
 *
 * The two backoff constants live here because they only ever appear in this
 * block; they are still re-exported from `token-store.ts` (public surface
 * unchanged).
 *
 * @module dsh-sensenova-suite/token-store/throttle
 */

import { isCredentialRefusal } from "../codes.ts";
import { obj, numOrNull } from "../util.ts";
import type { StoreContextWiring, HeldThrottle } from "./state.ts";

/**
 * The first wait imposed on a refusal the platform gave no window for.
 *
 * Doubles from here; `MAX_LOGIN_BACKOFF_MS` caps it.
 */
export const DEFAULT_LOGIN_BACKOFF_MS = 60_000;

/**
 * Cap on a self-imposed wait.
 *
 * Applies ONLY to a wait this store invented. A window the platform stated
 * itself ("try again in 2 hours") is never truncated by it: capping that is
 * exactly what walks back into a lock that is still in force.
 */
export const MAX_LOGIN_BACKOFF_MS = 30 * 60_000;

/**
 * Where the throttle used to live, as a record in the credentials service.
 *
 * Read for MIGRATION ONLY; the marker identifies the old record.
 */
export const THROTTLE_MARKER = "signin-throttle";

/**
 * Payload version of the throttle record that used to live in the credentials
 * service, read for MIGRATION ONLY.
 *
 * A DIFFERENT constant from `THROTTLE_FILE_VERSION` (`throttle-store.ts`),
 * which versions the state file the throttle moved into. This one is frozen:
 * the plugin no longer writes that record, so there is nothing to bump it for —
 * it only has to keep recognising what previous versions parked. Sharing the
 * name and the value with the file's version is exactly what made the two worth
 * separating.
 */
/**
 * The refusal an in-force throttle stands for.
 *
 * Rethrows the platform's own failure while it is still the live one, so the
 * message the user reads is the platform's words, not this store's. Once the
 * wait has been served and re-reading finds a fresh refusal, that failure is
 * gone — so the throttle's own description takes over.
 *
 * The classification code is preserved on the synthesized error, so the panel
 * can still tell a wrong password from a lockout and say which it is.
 * @param {{code: string, parked: boolean, until: number|null, attempt: number}} held
 *   the throttle in force.
 * @param {Error} [cause] - the original refusal, when it is still current.
 * @returns {Error} the error to throw.
 */
export function throttleError(held: HeldThrottle, cause?: Error): Error {
  if (cause !== undefined) return cause;
  const error = new Error(
    held.parked
      ? "sign-in is not being retried automatically: the account needs to be entered again"
      : `sign-in is not being retried automatically: waiting out a ${held.code} refusal`
  ) as Error & { code?: string };
  error.code = held.code;
  return error;
}

/**
 * How long a refusal without a stated window should wait.
 *
 * Doubles per consecutive refusal so a persistently wrong password settles
 * at the cap instead of producing a steady one-minute trickle of attempts
 * for as long as the panel stays open.
 * @param {number} attempt - how many self-imposed waits have been served.
 * @returns {number} milliseconds to wait.
 */
export function localBackoffMs(attempt: number): number {
  const doubled = DEFAULT_LOGIN_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(doubled, MAX_LOGIN_BACKOFF_MS);
}

/**
 * Read the persisted throttle, or `null` when absent, stale, or unreadable.
 *
 * A parked refusal has no deadline, so it is keyed on its `parked` flag
 * rather than on a time: reading it back must not depend on a field that is
 * legitimately absent.
 * @returns {Promise<{code: string, parked: boolean, until: number|null, attempt: number}|null>}
 */
export async function readThrottle(wiring: StoreContextWiring, username: string): Promise<HeldThrottle | null> {
  const { throttleStore } = wiring;
  return throttleStore.read(username).catch(() => null);
}

/**
 * Remember a refusal so neither this process nor another one retries it.
 *
 * Persisted because a second Host process polling the same account would
 * otherwise walk straight into a lock this one is politely waiting out.
 *
 * Only a refusal that CARRIES A CODE is parked: every named failure (the
 * platform's own rejections and their folded codes) is something "wait" or
 * "user must act" can honestly govern. A codeless throw is an infrastructure
 * surprise — a persist that failed AFTER a sign-in that worked, a TypeError
 * inside the auth walk — and parking it under a guessed `login_failed` would
 * serve a fake countdown and a platform-flavoured line over a token that may
 * be perfectly usable, which is how a dead grant once read as a login wait.
 * Such errors are left to the caller's re-throw: the real message reaches the
 * panel, and nothing is recorded.
 * @param {object} error - the refusal thrown by `login`.
 * @param {number} [previousAttempt] - the attempt count being superseded.
 * @returns {Promise<{code: string, parked: boolean, until: number|null, attempt: number}|null>}
 *   the throttle now in force, or `null` when nothing was written because the
 *   error carried no code to park.
 */
export async function writeThrottle(wiring: StoreContextWiring, username: string, error: unknown): Promise<HeldThrottle | null> {
  const { throttleStore, now } = wiring;
  const code = obj(error).code;
  if (typeof code !== "string") {
    // No code, no parking: see the module note above. The attempt ladder is
    // left alone too — a surprise is not a refusal, and it must not reset the
    // backoff ladder a real refusal had been climbing.
    return await readThrottle(wiring, username);
  }
  const parked = isCredentialRefusal(code);
  // A window the platform stated is taken at its word; only a window we
  // invented is capped. The attempt ladder lives in THIS account's park
  // （多账号分钥：B 连错两次的倍增不串到 A 的第一次失败上）。
  const stated = numOrNull(obj(error).retryAfterMs);
  const previous = await readThrottle(wiring, username);
  const attempt = Math.max(1, (previous?.attempt ?? 0) + 1);
  const until = parked
    ? null
    : now() + (stated === null ? localBackoffMs(attempt) : Math.max(stated, 0));
  const held: HeldThrottle = { username, code, parked, until, attempt };
  await throttleStore.write(username, held).catch(() => false);
  return held;
}

/**
 * Drop ONE account's throttle, so the next sign-in for it is allowed to try.
 * Other accounts' parks are untouched（分钥的本意）.
 * @returns {Promise<void>}
 */
export async function clearThrottle(wiring: StoreContextWiring, username: string): Promise<void> {
  const { throttleStore } = wiring;
  await throttleStore.clear(username).catch(() => false);
}

/**
 * How much longer a throttle is in force, or `null` when it is not.
 *
 * A parked refusal has no deadline and so no countdown.
 * @param {{parked: boolean, until: number|null}|null} held - the throttle.
 * @returns {number|null} milliseconds remaining.
 */
export function inForceWaitMs(wiring: StoreContextWiring, held: HeldThrottle | null): number | null {
  const { now } = wiring;
  if (held === null || held.parked || held.until === null) return null;
  return Math.max(0, held.until - now());
}
