/**
 * dsh-sensenova-suite — where the sign-in throttle lives.
 *
 * It used to live in the credentials service, disguised as a `kind: "grant"`
 * record carrying a marker field. That disguise was not a stylistic choice:
 * the service admits exactly two record kinds, and an unknown one makes the
 * whole credentials document unparseable — which takes the Host down, not
 * just this panel. So a throttle could only ever be smuggled in as a grant,
 * and a single mistyped payload was enough to break every credential on the
 * machine.
 *
 * A throttle is not a credential. It is state: a deadline and a reason, plus
 * a parked flag for refusals that have no deadline. It belongs in this
 * plugin's own file, where a malformed value costs the plugin its throttle
 * and nothing else.
 *
 * 冷却按账号分钥（2026-10-29 多账号）：park 记在用户名上——B 号的密码错误
 * 不挡 A 号的重登。文件形态 v2 = `{ version: 2, parks: { "<用户名>": 冷却 } }`；
 * v1（单记录）读作空——无存量用户，不做迁移（同一拍板）。
 *
 * @module dsh-sensenova-suite/throttle-store
 */
import { join } from "node:path";
import { str, num, degrade } from "./util.ts";
import { name } from "./host-config.ts";
import { readStateJson, stateDir as pluginStateDir, createVersionedJsonWriter } from "./state-store.ts";
import type { HeldThrottle } from "./token-store/state.ts";

/**
 * Shape version of the throttle STATE FILE, bumped when the persisted form
 * changes.
 *
 * Deliberately independent of the credentials-record version the throttle used
 * to carry before the move — that constant is gone with the retired migration
 * (2026-10-29「无存量用户，迁移代码是纯负债」拍板). This one versions a file this
 * module still writes and will bump. Sharing a name and a value with the old
 * record's version was the worst kind of duplicate — bumping one "in lockstep"
 * with the other would silently orphan every parked refusal already on disk.
 */
const THROTTLE_FILE_VERSION = 2;

/**
 * Every persisted shape THIS build can read: the current version plus any
 * historical ones. Bumping {@link THROTTLE_FILE_VERSION} means adding the new
 * number here too — otherwise this build would refuse its own newest files.
 *
 * This is the ADR-006 write-side guard's whitelist, mirroring
 * `catalog-store.ts` / `provider-store.ts` / `switch-store.ts`: an on-disk
 * version not in this list was written by a NEWER build and must not be
 * clobbered. The throttle carries the guard like the other stores — and
 * unlike them it also REPORTS the refusal, because a throttle whose write
 * failed is silent until a second Host process walks into the lock.
 */
export const KNOWN_THROTTLE_VERSIONS: readonly number[] = [THROTTLE_FILE_VERSION];

/**
 * Where the throttle lives: the SHARED directory, `$DSH_HOME/state/<plugin>`.
 *
 * Deliberately NOT per-profile, even though the catalog / provider / draw
 * states are (PITFALLS §23). A throttle is not a per-profile preference, it is
 * "how long the upstream told this machine to stop knocking" — if only the
 * profile that got the 429 honoured it, the other profile's Host would resume
 * hammering the same endpoint from the same machine during the very window the
 * platform asked for. Splitting it would silently undo the whole point of the
 * throttle, and the failure only surfaces under load. Do not "make it
 * consistent" with the other three.
 * @returns {string} the directory.
 */
function throttleDir() {
  return pluginStateDir(name);
}

/** 文件载荷形状校验：v2 = `{ version: 2, parks: { "<用户名>": 冷却 } }`。 */
function parseParks(raw: unknown): Map<string, HeldThrottle> {
  const map = new Map<string, HeldThrottle>();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return map;
  const body = raw as { version?: unknown; parks?: unknown };
  if (num(body.version, 0) !== THROTTLE_FILE_VERSION || body.parks === null || typeof body.parks !== "object" || Array.isArray(body.parks)) return map;
  for (const [username, entry] of Object.entries(body.parks as Record<string, unknown>)) {
    if (username === "" || entry === null || typeof entry !== "object") continue;
    const held = entry as { code?: unknown; parked?: unknown; until?: unknown; attempt?: unknown };
    const code = str(held.code, "");
    if (code === "") continue;
    const attempt = Math.max(1, Math.floor(num(held.attempt, 1)));
    if (held.parked === true) {
      map.set(username, { username, code, parked: true, until: null, attempt });
      continue;
    }
    const until = num(held.until, NaN);
    // 已关闭的窗口条目**原样保留**（U5-D2 拍板 2026-10-31：保留 attempt）——
    // attempt 还要喂下次失败时的倍增梯。「是否仍在生效」由读侧判：acquire 闸
    // 只拦 `until > now()`，`inForceWaitMs` 把过期窗读成 null。本层不做时间
    // 过滤，只在形状坏到无法解释（until 非数）时丢弃。
    if (!Number.isFinite(until)) continue;
    map.set(username, { username, code, parked: false, until, attempt });
  }
  return map;
}

function parksPayload(parks: Map<string, HeldThrottle>): { version: number; parks: Record<string, Record<string, unknown>> } {
  return {
    version: THROTTLE_FILE_VERSION,
    parks: Object.fromEntries([...parks].map(([user, park]) => [user, {
      code: park.code,
      parked: park.parked === true,
      until: park.parked === true ? null : park.until,
      attempt: park.attempt
    }]))
  };
}

/**
 * Options the file-backed throttle store accepts.
 *
 * Deliberately NOT the shared `StoreOptions`: that type carries a `profile`,
 * and the throttle is shared on purpose (see {@link throttleDir}). Naming the
 * options here keeps the "no profile" property in the type, not only in a
 * comment.
 */
export interface ThrottleStoreOptions {
  /** Directory the throttle file lives in. */
  dir?: string;
  /** `ctx.logger`, for the ADR-006 write-side version-guard degrade signal. */
  logger?: { warn?: (message: string) => void };
}

/**
 * A throttle store backed by one file.
 *
 * Writes are atomic — a temporary file, then a rename — because two Host
 * processes share this path: a half-written file read by the other process
 * would read as "no throttle", which for a parked refusal means an automatic
 * retry of a password the user has not changed.
 * @param {ThrottleStoreOptions} [options] - wiring.
 * @returns the store, keyed by username（多账号分钥）.
 */
export function createFileThrottleStore(options: ThrottleStoreOptions = {}) {
  // 不带时钟（U5-D2 后本层不做时间过滤——过期判定在读侧），「测试注时钟」的
  // 旧选项随之退役：窗口穿越由 token-store 层注入的 `now` 负责。
  const { dir = throttleDir(), logger } = options;
  const file = join(dir, "throttle.json");
  // ADR-006 write-side guard + atomic write shared via createVersionedJsonWriter
  // (state-store.ts). A refusal is NOT silent: the guard's whole contract
  // (docs/ADR.md) is that a version this build does not know is refused, the
  // reason is recorded, and the reason reaches the caller — so `onRefuse`
  // degrades through the same logger the other five stores use.
  const writeThrottleFile = createVersionedJsonWriter({
    file,
    versions: KNOWN_THROTTLE_VERSIONS,
    label: "throttle",
    onRefuse: (reason) => degrade(reason, null, logger, null)
  });

  return {
    /**
     * 读某账号的冷却。过期窗口条目**原样返回**（U5-D2 拍板：attempt 保留喂
     * 下次倍增）；是否仍在生效由读侧判（acquire 闸 / inForceWaitMs）。
     */
    async read(username: string) {
      const parks = parseParks(await readStateJson(file));
      return parks.get(username) ?? null;
    },
    /**
     * Park a refusal on disk for one account.
     *
     * 读-合并-写：多账号各持各的 park，一次写只动自己的键。两个 Host 进程各写
     * 各号时的丢失窗口与旧单记录形态同级（一次尝试多付一次），可接受。
     *
     * Reports whether the record REACHED the disk. A caller that keeps
     * honouring the wait in memory while the disk never learned about it is
     * the failure this file exists to prevent.
     * @returns {Promise<boolean>} true when the record reached the disk.
     */
    async write(username: string, held: HeldThrottle) {
      const parks = parseParks(await readStateJson(file));
      parks.set(username, held);
      try {
        // `null` = written. A string = the ADR-006 guard refused the write and
        // returned its reason; `onRefuse` has already degraded that reason.
        const refusal = await writeThrottleFile(parksPayload(parks));
        return refusal === null;
      } catch (error) {
        degrade("throttle: write failed", error, logger, null);
        return false;
      }
    },
    /**
     * Drop ONE account's throttle from disk; other accounts' parks stay
     * （分钥的本意）。An empty file is kept as-is.
     * @returns {Promise<boolean>} true when the key is gone.
     */
    async clear(username: string) {
      const parks = parseParks(await readStateJson(file));
      if (!parks.has(username)) return true;
      parks.delete(username);
      try {
        const refusal = await writeThrottleFile(parksPayload(parks));
        return refusal === null;
      } catch (error) {
        degrade("throttle: clear failed", error, logger, null);
        return false;
      }
    }
  };
}

/**
 * A throttle store that forgets everything when the process ends.
 *
 * Used by the tests, and by a Host that can be given nothing writable. It is
 * deliberately NOT the default: the throttle exists so that a second Host
 * process does not walk into a lock the first is waiting out, which is a claim
 * about other processes and cannot be kept in memory.
 *
 * 不带时钟、不过滤过期窗（U5-D2 后与文件版同形）：条目原样返回，过期判定
 * 在读侧（acquire 闸 / inForceWaitMs）——窗口穿越由 token-store 层的 `now` 负责。
 * @returns the store, keyed by username.
 */
export function createMemoryThrottleStore() {
  const parks = new Map<string, HeldThrottle>();
  return {
    async read(username: string) {
      // 过期窗口也原样返回（U5-D2 拍板：attempt 保留喂下次倍增）。
      return parks.get(username) ?? null;
    },
    async write(username: string, held: HeldThrottle) {
      parks.set(username, held);
      // Nothing can fail here, so the write reports success — the same shape
      // the file store reports for a write that landed.
      return true;
    },
    async clear(username: string) {
      parks.delete(username);
      return true;
    }
  };
}
