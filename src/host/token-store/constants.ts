/**
 * The credential-domain string constants, in one place.
 *
 * These strings are RECORD ADDRESSES and MIGRATION KEYS: a value that drifts
 * from the one a record was written under does not fail a type check, does not
 * fail a test, and fails instead as "the user has to log in again" or "a parked
 * password is retried after a restart" — the two failures hardest to trace back
 * to a renamed string. One declaration, imported by every site that addresses a
 * record.
 *
 * NOT here, and deliberately so:
 *
 *   - `RECORD_SCOPE` — that is this plugin's own `name` from `host-config.ts`
 *     (the namespace half of every key below). It already has exactly one
 *     declaration; aliasing it a second time would create the same drift.
 *   - the payload version numbers — each belongs to the ONE persisted shape it
 *     versions. `grant.ts` owns the grant's, and the throttle's two live in the
 *     two modules that write and adopt them respectively, under names that say
 *     which storage they version (`token-store/throttle.ts` reads a shape this
 *     plugin no longer writes, so its number is a frozen historical fact and
 *     must never be bumped in lockstep with the file-backed one).
 *
 * @module dsh-sensenova-suite/token-store/constants
 */

/**
 * Record name: this plugin's own console grant.
 *
 * Namespaced by `RECORD_SCOPE`, so a stranger's plugin cannot collide with it.
 */
export const RECORD_ID = "sensenova-console";

/**
 * Record name of the throttle that used to live in the credentials service.
 *
 * The throttle itself now lives in a state file (PITFALLS §23: throttle and
 * the credential grant deliberately share their store, everything else is
 * per-profile). 迁移收养已随 2026-10-29「无存量用户，迁移代码是纯负债」拍板
 * 整体退役——没有任何代码读这个地址（U5-D1）；常量保留只因门面的 re-export
 * 面冻结（TOKEN-STORE-SPLIT §5），删它等于借清理之名改公共面。
 */
export const THROTTLE_ID = "sensenova-console-throttle";

/**
 * 多账号清单记录（2026-10-29 方案 C；同日槽位制改清单制——「账号不限数量」用
 * 槽位制实现会把枚举成本钉在扫描上限上，单记录数组一次读全拿）。
 *
 * 活动账号仍在 {@link RECORD_ID} 单槽，活动身份 = `USERNAME_REF`——下游
 * （续期/配额/目录）零改动。0.1.27 槽位制的 `<prefix><n>` 侧槽随同日「无存量
 * 用户，迁移代码是纯负债」拍板整体作废：不收编、不读取、无收编代码（U5-D1，
 * 遗产常量已删）。
 */
export const ACCOUNTS_RECORD_ID = "sensenova-console-accounts";
/** 账号清单记录形状版本；不兼容变更时递增。 */
export const ACCOUNTS_RECORD_VERSION = 1;

/**
 * 账号身份/密码的凭据 ref 名（原属 account.ts；2026-10-29 多账号侧槽需要引用它们，
 * 上移到常量块斩断 account↔accounts 的循环 import。account.ts 原地 re-export 保持
 * 既有 import 路径不变）。密码落盘策略见 accounts.ts 头注（方案 C，用户拍板）。
 */
export const USERNAME_REF = "SENSENOVA_USERNAME";
// SENSENOVA_PASSWORD 的 env 密码通道已随 2026-10-29 方案 C 退役：清单天生落盘
// 多账号密码，env 只能装一个号，没有存在价值（用户拍板）。账号.ts 的重登密码
// 只查清单。

/**
 * The namespace this plugin used before the rename.
 *
 * Read for MIGRATION ONLY: an account and grant saved under the old name must
 * survive the rename, or the panel would demand a fresh login and abandon a
 * refresh token that is still good. Nothing is ever written here again; each
 * legacy record is adopted once and deleted.
 */
// LEGACY_SCOPE（dsh-llm-rate-panel 改名时代的 grant/throttle 收编迁移）已随
// 2026-10-29「无存量用户，迁移代码是纯负债」拍板整体退役。
