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
import type { StoreContextWiring, TokenStoreState, HeldThrottle } from "./state.ts";

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
 * Read the persisted throttle, or `null` when there is no refusal to honour.
 *
 * A parked refusal has no deadline, so it is keyed on its `parked` flag
 * rather than on a time: reading it back must not depend on a field that is
 * legitimately absent.
 *
 * U5-D3a（拍板 2026-10-31）：存储读空 ≠ 没有冷却。写侧被 ADR-006 拒或写失败
 * 时，冷却落不到盘——本进程改从 `state.throttleOverlay`（写侧失败时布下的
 * 进程内镜像）取回，照常遵守平台给的等待窗；磁盘重新可读（镜像清场条件见
 * writeThrottle）后自然回到磁盘真相。跨进程的那一半以磁盘为唯一通道，拒写
 * 窗内退化为尽力而为——degrade 日志与本注释是全部诚实。
 * @returns {Promise<{code: string, parked: boolean, until: number|null, attempt: number}|null>}
 */
export async function readThrottle(wiring: StoreContextWiring, state: TokenStoreState, username: string): Promise<HeldThrottle | null> {
  const { throttleStore } = wiring;
  // 真值判定（而非 !== null）：契约只说 read 返回「冷却或空」，桩可能以
  // undefined 表达空——非对象一律按缺席走镜像回退。
  const stored = await throttleStore.read(username).catch(() => null);
  if (stored) {
    // 磁盘（或内存桩）有真相：镜像退场，防版本恢复后僵尸条目残留。
    state.throttleOverlay.delete(username);
    return stored;
  }
  return state.throttleOverlay.get(username) ?? null;
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
export async function writeThrottle(wiring: StoreContextWiring, state: TokenStoreState, username: string, error: unknown): Promise<HeldThrottle | null> {
  const { throttleStore, now } = wiring;
  const code = obj(error).code;
  if (typeof code !== "string") {
    // No code, no parking: see the module note above. The attempt ladder is
    // left alone too — a surprise is not a refusal, and it must not reset the
    // backoff ladder a real refusal had been climbing.
    return await readThrottle(wiring, state, username);
  }
  const parked = isCredentialRefusal(code);
  // A window the platform stated is taken at its word; only a window we
  // invented is capped. The attempt ladder lives in THIS account's park
  // （多账号分钥：B 连错两次的倍增不串到 A 的第一次失败上）。
  const stated = numOrNull(obj(error).retryAfterMs);
  // previous 走 readThrottle（含镜像回退）：上次写失败进镜像的 attempt
  // 也继续爬梯，不被磁盘拒写打断（U5-D3a 的连带收益）。
  const previous = await readThrottle(wiring, state, username);
  const attempt = Math.max(1, (previous?.attempt ?? 0) + 1);
  const until = parked
    ? null
    : now() + (stated === null ? localBackoffMs(attempt) : Math.max(stated, 0));
  const held: HeldThrottle = { username, code, parked, until, attempt };
  const persisted = await throttleStore.write(username, held).catch(() => false);
  if (persisted) state.throttleOverlay.delete(username);
  else state.throttleOverlay.set(username, held);
  return held;
}

/**
 * Drop ONE account's throttle, so the next sign-in for it is allowed to try.
 * Other accounts' parks are untouched（分钥的本意）.
 *
 * 清除失败不进镜像：镜像的语义是「磁盘丢了我们的写」，不是「替磁盘记冷却」——
 * 清不掉意味着磁盘上还留着 park（可读形态）或整份不可见（版本拒写形态，
 * 此时 park 本就读不到）。残余风险见模块注释。
 * @returns {Promise<void>}
 */
export async function clearThrottle(wiring: StoreContextWiring, state: TokenStoreState, username: string): Promise<void> {
  const { throttleStore } = wiring;
  const cleared = await throttleStore.clear(username).catch(() => false);
  if (cleared) state.throttleOverlay.delete(username);
}

/**
 * 「这个冷却现在挡不挡路」的唯一判据（U5-D5）：acquire 的登录闸与
 * switchAccount 的无快照防御路径共用一份，防两处手抄漂移。parked 无限期挡；
 * time-shaped 只在窗口未过时挡。挡 = 返回要抛的错误；不挡 = null。
 */
export function throttleGateError(held: HeldThrottle | null, now: () => number): Error | null {
  if (held === null) return null;
  if (held.parked) return throttleError(held);
  if (held.until !== null && held.until > now()) return throttleError(held);
  return null;
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
  // U5-D2 拍板后过期条目会从存储原样读回：窗口已过 = 不在等待（null，不是 0），
  // 面板不该为一个已经结束的窗渲染零倒计时。
  if (held.until <= now()) return null;
  return held.until - now();
}
