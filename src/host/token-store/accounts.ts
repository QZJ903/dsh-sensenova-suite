/**
 * Block 5 of the token-store split: the multi-account vault (2026-10-29 方案 C).
 *
 * 非活动账号住在**一份清单文件**里：插件状态目录的 `accounts.json`
 * （`{ version, accounts: [{ username, password, grant }] }`，由
 * {@link createFileAccountsStore} 读写，与 pool.json 同纪律）。账号数量不设
 * 上限——枚举是单文件读，没有「扫描上限」要防。清单不存在 = 没有账号，
 * **不做任何迁移**（2026-10-29 用户拍板：无存量用户，迁移代码是纯负债——
 * 0.1.27 槽位制的旧数据直接作废，重新登录一次即重建）。
 *
 * **为什么不在凭据服务里**（2026-10-30 真机崩溃实录）：宿主 credentials-local
 * 对记录 kind 是封闭白名单，启动时整文件校验，自造 kind（account-vault）=
 * 凭据插件激活失败 = 整机无法启动。凭据服务只持有活动 grant（kind:"grant"
 * 是它认识的形状），清单自持。
 *
 * **密码落盘是用户拍板（方案 C）**：sk- key 与活动 grant 本来就明文住在同一份凭据
 * 文档里，密码是同级秘密；不落盘就做不了一键切换（方案 B 的后台保活被「商汤多会话
 * 策略文档沉默」否掉）。
 *
 * 「活动账号」不在清单里：活动槽仍是原 RECORD_ID 单槽（续期/控制台调用/配额零改动），
 * 活动身份 = `USERNAME_REF`。切换 = 当前 grant 快照回写它自己的清单条目 → 目标条目的
 * grant 装上活动槽 → `USERNAME_REF` 换人。切到冷账号时令牌多半已死，既有级联
 * （refresh 失败 → invalidate → acquire → readAccount）会用清单里的存档密码自动重登——
 * readAccount 的 vault 回退在 account.ts，本模块只提供查密码的口子（单向依赖）。
 *
 * 跨块读（当前身份/当前 grant）按 loginFromAccount 的注入纪律由门面传入，
 * 本模块绝不 import account.ts（免环）。
 *
 * @module dsh-sensenova-suite/token-store/accounts
 */
import { join } from "node:path";
import { name as RECORD_SCOPE } from "../host-config.ts";
import { obj, str, verbatim } from "../util.ts";
import { ACCOUNTS_RECORD_VERSION } from "./constants.ts";
import { createVersionedJsonWriter, createStateReadCache, profileStateDir, readStateJson } from "../state-store.ts";
import type { StoreContextWiring, StoredGrant } from "./state.ts";

/** 清单里存着的一个账号（含密码；密码绝不出本模块——对外只给 view）。 */
export interface StoredAccountRecord {
  username: string;
  password: string;
  grant: StoredGrant | null;
}

/** 对外面（路由/面板 state）的形状：绝不含密码。id = 用户名（清单内唯一）。 */
export interface StoredAccountView {
  id: string;
  username: string;
  hasGrant: boolean;
  active: boolean;
}

/**
 * 账号清单的插件状态文件存储（accounts.json，与 pool.json 同目录同纪律：
 * 版本化载荷 + 临时文件原子改名 + 短 TTL 读缓存 + 自己的写立刻可见）。
 *
 * **为什么不在凭据服务里**：宿主 credentials-local 对记录 kind 是封闭白名单，
 * 启动时整文件校验，未知 kind = 凭据插件激活失败 = 整机启动失败（2026-10-30
 * 真机崩溃，crash-2026-10-29T16-48-29Z-host.log）。自持格式自己说了算。
 */
export function createFileAccountsStore(options: {
  profile?: string | null;
  logger?: { warn?: (message: string, error?: unknown) => void } | null;
  now?: () => number;
} = {}) {
  const { profile = null, logger, now = Date.now } = options;
  const file = join(profileStateDir(RECORD_SCOPE, profile), "accounts.json");
  const writeAccounts = createVersionedJsonWriter({
    file,
    versions: [ACCOUNTS_RECORD_VERSION],
    label: "accounts",
    onRefuse: (reason: string) => { logger?.warn?.(`dsh-sensenova-suite: accounts store write refused: ${reason}`); },
    now
  });
  let held: StoredAccountRecord[] | null = null;
  const cache = createStateReadCache<StoredAccountRecord[] | null>(async () => parseAccountsFile(await readStateJson(file)), { now });
  return {
    /** 全量清单，或 null（未设置）。 */
    async read(): Promise<StoredAccountRecord[] | null> {
      held = (await cache.read()) ?? null;
      return held;
    },
    async write(accounts: StoredAccountRecord[]): Promise<void> {
      held = accounts;
      await writeAccounts({ version: ACCOUNTS_RECORD_VERSION, accounts });
      cache.remember(held);
    }
  };
}

/** 解析 accounts.json 载荷；形状不符 = 未设置（空态，绝不抛）。 */
function parseAccountsFile(raw: unknown): StoredAccountRecord[] | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = obj(raw) as Record<string, unknown>;
  if (numOf(rec.version) !== ACCOUNTS_RECORD_VERSION || !Array.isArray(rec.accounts)) return null;
  const out: StoredAccountRecord[] = [];
  for (const entry of rec.accounts) {
    if (entry === null || typeof entry !== "object") continue;
    const e = obj(entry) as Record<string, unknown>;
    const username = verbatim(e.username, "");
    if (username === "") continue;
    const grant = obj(e.grant) as Record<string, unknown>;
    const accessToken = verbatim(grant.accessToken, "");
    out.push({
      username,
      password: verbatim(e.password, ""),
      grant: accessToken === "" ? null : {
        accessToken,
        refreshToken: verbatim(grant.refreshToken, ""),
        expiresAt: typeof grant.expiresAt === "number" && Number.isFinite(grant.expiresAt) ? grant.expiresAt : null
      }
    });
  }
  return out;
}

/** util num 的本地形状（grant.ts 同款：非有限数 = null）。 */
function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 读清单。清单不存在（或读失败）= 没有账号；宿主没带 accountsStore（旧接线）
 * 同样读作空——功能降级但宿主照常。
 */
async function readVault(wiring: StoreContextWiring): Promise<StoredAccountRecord[]> {
  const store = wiring.accountsStore;
  if (store === undefined) return [];
  // 载荷形状由本模块的文件存储写定（createFileAccountsStore），此处收窄。
  const raw = (await store.read().catch(() => null)) as StoredAccountRecord[] | null | undefined;
  return raw ?? [];
}


async function writeVault(wiring: StoreContextWiring, accounts: StoredAccountRecord[]): Promise<void> {
  const store = wiring.accountsStore;
  if (store === undefined) return;
  await store.write(accounts);
}

/**
 * 按用户名落一个账号：同名条目更新（password 未给时只刷 grant），新号追加。
 * 数量不设上限（清单制单记录读，枚举成本与数量无关）。
 */
export async function upsertAccount(
  wiring: StoreContextWiring,
  account: { username: string; grant: StoredGrant | null; password?: string | undefined }
): Promise<void> {
  const accounts = await readVault(wiring);
  const mine = accounts.find((entry) => entry.username === account.username);
  if (mine !== undefined) {
    mine.grant = account.grant;
    if (account.password !== undefined) mine.password = account.password;
  } else {
    accounts.push({ username: account.username, password: account.password ?? "", grant: account.grant });
  }
  await writeVault(wiring, accounts);
}

/** 活动用户的存档密码（readAccount 的 vault 回退）；没有 = ""。 */
export async function vaultPasswordFor(wiring: StoreContextWiring, username: string): Promise<string> {
  if (username === "") return "";
  return (await readVault(wiring)).find((entry) => entry.username === username)?.password ?? "";
}

/** 读一个条目（按用户名）；没有 = undefined。切换的执行半边用。 */
export async function readVaultEntry(wiring: StoreContextWiring, username: string): Promise<StoredAccountRecord | undefined> {
  if (username === "") return undefined;
  return (await readVault(wiring)).find((entry) => entry.username === username);
}

/** 全量条目（含密码；仅本模块与门面的切换编排可达）。 */
export async function listVaultEntries(wiring: StoreContextWiring): Promise<StoredAccountRecord[]> {
  return readVault(wiring);
}

/** 整体写回（切换编排的落盘半边：旧会话回写 + 身份变更后一次落盘）。 */
export async function writeVaultEntries(wiring: StoreContextWiring, accounts: StoredAccountRecord[]): Promise<void> {
  await writeVault(wiring, accounts);
}

/** 面板/state 的账号清单：无密码。id = 用户名；active = 用户名等于当前活动身份。 */
export async function listAccountViews(wiring: StoreContextWiring, activeUsername: string): Promise<StoredAccountView[]> {
  return (await readVault(wiring)).map((entry) => ({
    id: entry.username,
    username: entry.username,
    hasGrant: entry.grant !== null,
    active: activeUsername !== "" && entry.username === activeUsername
  }));
}

/** 移除一个存档账号。活动 grant 不动：删的只是「存档的密码+令牌快照」。 */
export async function removeAccountRecord(wiring: StoreContextWiring, id: string): Promise<void> {
  const username = str(id, "").trim();
  const accounts = await readVault(wiring);
  const next = accounts.filter((entry) => entry.username !== username);
  if (next.length === accounts.length) return;
  await writeVault(wiring, next);
}
