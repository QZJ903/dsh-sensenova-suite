/**
 * 多账号侧槽回归（2026-10-29 方案 C）——真 store + 假凭据后端 + 假平台，无 peer。
 *
 * 起因：「积分池只能一个号用」→ 存多账号一键切换。方案 C = 密码随账号落侧槽
 * （用户拍板），切换 = 当前 grant 回写它的槽 → 目标槽 grant 装上活动槽 →
 * USERNAME_REF 换人 → 当场要一次令牌。本文件钉：
 *
 *   1. saveAccount 落槽（密码+grant 快照进侧槽；state().accounts 可见、无密码）；
 *   2. 一键切换的两种路径——热账号秒切（不触发登录）与冷账号自动重登
 *      （死刷新令牌 → acquire → readAccount 用槽里的存档密码，env 缺席也行）；
 *   3. 切走的号回写最新 grant 快照（下次切回不用重登）；
 *   4. removeAccount 只删槽、活动会话不动；
 *   5. 账号数量不设上限（清单制）；
 *   6. env 密码通道退役：env 密码在场也不使用，仅 env 不再自动登录。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "suite-account-vault-"));
process.env.DSH_HOME = HOME;

const results = [];
const check = (name, ok, detail = "") => results.push({ name, pass: ok === true, detail: String(detail) });
const fail = (group, error) => results.push({ name: group, pass: false, detail: String(error) });

/** 假凭据后端：记录 + refs 双仓，接口 = CredentialBackend 子集。 */
function fakeBackend() {
  const records = new Map();
  const refs = new Map();
  const backend = {
    async readRecord(k) { return records.get(k); },
    async modifyRecord(k, mutate) {
      const next = await mutate(records.get(k));
      if (next === undefined) return records.get(k);
      records.set(k, next);
      return next;
    },
    async deleteRecord(k) { records.delete(k); },
    async resolve(ref) { return refs.has(ref) ? { value: refs.get(ref), source: "vault" } : undefined; },
    async set(ref, value) { refs.set(ref, value); },
    async unset(ref) { refs.delete(ref); }
  };
  return { backend, records, refs };
}

/** 假平台：login/refresh 可脚本化，记录每次用的凭据。 */
function fakeAuth() {
  const logins = [];
  const refreshes = [];
  const deadRefreshes = [];
  let seq = 0;
  return {
    logins, refreshes, deadRefreshes,
    async login({ username, password }) {
      logins.push({ username, password });
      seq += 1;
      if (this.loginFailsFor?.[username] === true) { const e = new Error("login rejected: invalid account or password"); e.code = "login_rejected"; throw e; }
      if (this.failNextLogin === true) { this.failNextLogin = false; const e = new Error("login rejected: invalid account or password"); e.code = "login_rejected"; throw e; }
      return { accessToken: `at-${username}-${seq}`, refreshToken: `rt-${username}-${seq}`, expiresIn: 10800 };
    },
    async refresh(refreshToken) {
      refreshes.push({ refreshToken });
      seq += 1;
      if (this.deadRefreshes?.includes(refreshToken)) {
        const e = new Error("refresh rejected"); e.code = "refresh_rejected"; throw e;
      }
      const user = String(refreshToken).split("-")[1] ?? "?";
      return { accessToken: `at-${user}-r${seq}`, refreshToken: `rt-${user}-${seq}`, expiresIn: 10800 };
    }
  };
}

/** 假账号清单存储（方案 C：清单在插件状态文件，不在凭据服务）。 */
function fakeAccountsStore() {
  const state = { data: null };
  return {
    get data() { return state.data; },
    async read() { return state.data; },
    async write(accounts) { state.data = accounts; }
  };
}

function buildStore({ env = {}, auth, backend, accountsStore }) {
  const throttleStore = createMemoryThrottleStore();
  return {
    throttleStore,
    store: createTokenStore({
      credentials: backend,
      accountsStore: accountsStore ?? fakeAccountsStore(),
      auth,
      env,
      throttleStore,
      credentialKey: (scope, id) => `${scope}/${id}`,
      skewMs: 60_000,
      now: () => Date.now()
    })
  };
}

// 动态加载（ESM import 而非 require0——保持与其它套件同形）。
let createTokenStore;
let createMemoryThrottleStore;
let RECORD_SCOPE;
try {
  ({ createTokenStore } = await import("../src/host/token-store.ts"));
  ({ createMemoryThrottleStore } = await import("../src/host/throttle-store.ts"));
  ({ name: RECORD_SCOPE } = await import("../src/host/host-config.ts"));
} catch (e) { fail("load", e); }

try {
  if (createTokenStore !== undefined) {
    const key = (id) => `${RECORD_SCOPE}/${id}`;
    const ACTIVE = key("sensenova-console");
    const USERNAME_REF = "SENSENOVA_USERNAME";

    // ── 场景 1-3：加两号、落槽可见、热切换不触发登录 ──
    const backend1 = fakeBackend();
    const auth1 = fakeAuth();
    const vstore1 = fakeAccountsStore();
    const store1wrap = buildStore({ env: {}, auth: auth1, backend: backend1.backend, accountsStore: vstore1 });
    const store1 = store1wrap.store;

    await store1.saveAccount({ username: "alpha", password: "pw-alpha" });
    await store1.saveAccount({ username: "beta", password: "pw-beta" });
    const list1 = await store1.listAccounts();
    check("saveAccount 两号各落一槽（清单可见、无密码字段；后保存者=当前）",
      list1.length === 2
        && list1.some((a) => a.username === "alpha" && a.active === false)
        && list1.some((a) => a.username === "beta" && a.active === true)
        && list1.every((a) => !("password" in a)),
      JSON.stringify(list1));
    check("清单里确实存了密码（方案 C 的本体；单记录数组、不进凭据服务）",
      Array.isArray(vstore1.data) && vstore1.data.length === 2
        && vstore1.data[0].password === "pw-alpha" && vstore1.data[1].password === "pw-beta"
        && backend1.records.get(key("sensenova-console-accounts")) === undefined,
      JSON.stringify(vstore1.data?.map((r) => ({ u: r.username, p: r.password }))));

    const loginsBefore = auth1.logins.length;
    await store1.switchAccount("beta");
    const tokenB = await store1.getToken();
    check("热切换：活动 grant 换成 beta 的快照，不触发新登录",
      tokenB === "at-beta-2"
        && auth1.logins.length === loginsBefore
        && backend1.refs.get(USERNAME_REF) === "beta",
      `token=${tokenB} logins=${auth1.logins.length} user=${backend1.refs.get(USERNAME_REF)}`);
    check("切换后当前号标记跟随",
      (await store1.listAccounts()).find((a) => a.username === "beta")?.active === true,
      JSON.stringify(await store1.listAccounts()));
    check("切走的 alpha 回写了最新 grant 快照",
      vstore1.data?.find((a) => a.username === "alpha")?.grant?.accessToken === "at-alpha-1",
      JSON.stringify(vstore1.data?.find((a) => a.username === "alpha")?.grant?.accessToken));

    // ── 场景 4：冷账号自动重登（死刷新令牌 + 无 env 密码 → 槽里存档密码顶上）──
    // 给 beta 槽造一个平台已拒绝的刷新令牌；切换回来必须用槽里的 pw-beta 重登。
    auth1.deadRefreshes = ["rt-beta-2"];
    await store1.switchAccount("beta");
    const tokenCold = await store1.getToken();
    check("冷切换：死刷新令牌 → 用槽里的存档密码自动重登（env 缺席也行）",
      tokenCold.startsWith("at-beta-")
        && auth1.logins.some((l) => l.username === "beta" && l.password === "pw-beta"),
      `token=${tokenCold} logins=${JSON.stringify(auth1.logins)}`);

    // ── 场景 5：removeAccount 只删槽、活动会话不动 ──
    await store1.switchAccount("alpha");
    const tokenAlpha = await store1.getToken();
    await store1.removeAccount("beta");
    const list5 = await store1.listAccounts();
    check("移除：槽消失、活动会话照常",
      list5.length === 1 && list5[0].username === "alpha"
        && backend1.records.get(key("sensenova-console-account-2")) === undefined
        && (await store1.getToken()) === tokenAlpha,
      JSON.stringify(list5));

    // ── 场景 5b：移除当前登录账号 = 退出登录（用户拍板 B：孤儿会话不允许存在）──
    // 删条目 + 活动令牌记录 + 身份引用一起清；面板回登录态。
    await store1.removeAccount("alpha");
    check("移除当前号：令牌记录与身份一并清除（退出登录）",
      backend1.records.get(ACTIVE) === undefined
        && backend1.refs.get(USERNAME_REF) === undefined,
      `records=${JSON.stringify([...backend1.records.keys()])} user=${backend1.refs.get(USERNAME_REF)}`);
    let err5b = null;
    try { await store1.getToken(); } catch (e) { err5b = e; }
    check("移除当前号后：取令牌报 not_configured（面板回登录态）",
      err5b?.code === "not_configured",
      `err=${err5b?.message} code=${err5b?.code}`);
    check("移除当前号后：清单为空",
      (await store1.listAccounts()).length === 0,
      JSON.stringify(await store1.listAccounts()));

    // ── 场景 6：清单制不限数量（2026-10-29 用户拍板）——7 个号全部落清单 ──
    const backend6 = fakeBackend();
    const auth6 = fakeAuth();
    const vstore6 = fakeAccountsStore();
    const store6wrap = buildStore({ env: {}, auth: auth6, backend: backend6.backend, accountsStore: vstore6 });
    const store6 = store6wrap.store;
    for (const name of ["u1", "u2", "u3", "u4", "u5", "u6", "u7"]) {
      await store6.saveAccount({ username: name, password: `pw-${name}` });
    }
    check("清单制不限数量：7 个号全部落清单",
      vstore6.data?.length === 7,
      JSON.stringify(vstore6.data?.map((a) => a.username)));

    // ── 场景 7：重登密码只来自清单（env 密码通道已退役，2026-10-29 用户拍板）──
    const backend7 = fakeBackend();
    const auth7 = fakeAuth();
    backend7.backend.set(USERNAME_REF, "alpha");
    backend7.backend.set("SENSENOVA_PASSWORD", "pw-STALE-env");
    const store7wrap = buildStore({ env: { SENSENOVA_USERNAME: "alpha" }, auth: auth7, backend: backend7.backend });
    const store7 = store7wrap.store;
    await store7.saveAccount({ username: "alpha", password: "pw-fresh-slot" });
    // 令牌作废 + 刷新令牌死了 → 重登只认清单存档密码，env 旧值在场也不使用。
    await store7.invalidate();
    auth7.deadRefreshes = ["rt-alpha-1"];
    const token7 = await store7.getToken();
    check("env 密码在场也不使用：重登只认清单存档密码",
      token7.startsWith("at-alpha-")
        && auth7.logins.at(-1)?.password === "pw-fresh-slot",
      `logins=${JSON.stringify(auth7.logins)}`);

    // ── 场景 7b：只有 env 密码、清单没有 → 不再自动登录（env 通道真的死了）──
    const backend9 = fakeBackend();
    const auth9 = fakeAuth();
    const store9wrap = buildStore({
      env: { SENSENOVA_USERNAME: "solo", SENSENOVA_PASSWORD: "pw-env-only" },
      auth: auth9, backend: backend9.backend
    });
    const store9 = store9wrap.store;
    let err9 = null;
    try { await store9.getToken(); } catch (e) { err9 = e; }
    check("env 密码通道退役：仅 env 密码不再自动登录（not_configured，面板再要账号）",
      err9 !== null && err9.code === "not_configured" && auth9.logins.length === 0,
      `err=${err9?.message} code=${err9?.code} logins=${auth9.logins.length}`);

    // ── 场景 7c：冷却按账号分钥——B 的 park 不挡 A；切到 parked 号报错不清门 ──
    // 最小流：bob 登录态（有令牌快照），alice 用添加模式入清单（只有密码）。
    const backendC = fakeBackend();
    const authC = fakeAuth();
    const vstoreC = fakeAccountsStore();
    const storeCwrap = buildStore({ env: {}, auth: authC, backend: backendC.backend, accountsStore: vstoreC });
    const storeC = storeCwrap.store;
    await storeC.saveAccount({ username: "bob-c", password: "pw-bc" });      // 登录模式，active=bob
    await storeC.saveAccount({ username: "alice-c", password: "pw-ac" }, { activate: false }); // 添加模式
    // 切到 alice：无令牌快照 → 清活动槽 → 用存档密码登录接管。
    await storeC.switchAccount("alice-c");
    const tokA = await storeC.getToken();
    check("切到添加的号：存档密码登录接管",
      tokA.startsWith("at-alice-c-"), `token=${tokA}`);
    // alice 的平台密码被改：刷新令牌死 + 存档密码失效 → 重登被拒 → alice 被 park。
    const aliceRt = backendC.records.get(ACTIVE)?.payload?.refreshToken;
    authC.deadRefreshes.push(aliceRt);
    authC.loginFailsFor = { "alice-c": true };
    await storeC.invalidate(tokA);
    let aliceParkErr = null;
    try { await storeC.getToken(); } catch (e) { aliceParkErr = e; }
    check("alice 刷新死+密码错 → alice 被 park（报平台原话）",
      aliceParkErr !== null && /invalid account or password/.test(String(aliceParkErr.message)),
      `err=${aliceParkErr?.message}`);
    // bob 不受 alice 的 park 影响：切到 bob（有快照）→ 刷新死 → 存档密码重登 ✓。
    const bobRt = vstoreC.data.find((a) => a.username === "bob-c").grant.refreshToken;
    authC.deadRefreshes.push(bobRt);
    await storeC.switchAccount("bob-c");
    const bobAt = backendC.records.get(ACTIVE)?.payload?.accessToken;
    await storeC.invalidate(bobAt);
    const tokB = await storeC.getToken();
    check("分钥：alice 的 park 不挡 bob 的重登",
      tokB.startsWith("at-bob-c-") && authC.logins.at(-1)?.username === "bob-c",
      `token=${tokB} logins=${JSON.stringify(authC.logins.map((l) => l.username))}`);
    // 切回 parked 的 alice：门当场拒（不清门、不消耗平台尝试），bob 登录次数不变。
    const bobLogins = authC.logins.filter((l) => l.username === "bob-c").length;
    let parkErr2 = null;
    try {
      await storeC.switchAccount("alice-c");
      const aliceAt2 = backendC.records.get(ACTIVE)?.payload?.accessToken;
      await storeC.invalidate(aliceAt2);
      await storeC.getToken();
    } catch (e) { parkErr2 = e; }
    check("切到 parked 号：报错且 park 仍在（不清门）",
      parkErr2 !== null && /not being retried automatically/.test(String(parkErr2.message))
        && authC.logins.filter((l) => l.username === "bob-c").length === bobLogins,
      `err=${parkErr2?.message} bobLogins=${bobLogins}->${authC.logins.filter((l) => l.username === "bob-c").length}`);

    // ── 场景 8：添加模式（activate=false）= 验证但不接管（2026-10-30 方案 A）──
    // 登录一次验证凭据并拿快照，随条目落清单；活动槽/身份/当前会话全不动。
    // 密码错当场拒：坏条目不进清单，该号进冷却（分钥），重提交正确密码即清。
    const backendA = fakeBackend();
    const authA = fakeAuth();
    const vstoreA = fakeAccountsStore();
    const storeAwrap = buildStore({ env: {}, auth: authA, backend: backendA.backend, accountsStore: vstoreA });
    const storeA = storeAwrap.store;
    await storeA.saveAccount({ username: "first", password: "pw-first" });          // 登录模式（成为当前）
    await storeA.switchAccount("first");
    const activeBefore = backendA.records.get(ACTIVE)?.payload?.accessToken;
    const loginsBeforeA = authA.logins.length;
    await storeA.saveAccount({ username: "second", password: "pw-second" }, { activate: false });
    check("添加模式：验证登录一次（凭据核对）",
      authA.logins.length === loginsBeforeA + 1 && authA.logins.at(-1)?.username === "second",
      `logins=${JSON.stringify(authA.logins)}`);
    check("添加模式：清单多一条（密码+验证过的令牌快照），活动槽与身份不动",
      vstoreA.data?.length === 2
        && vstoreA.data[1].password === "pw-second"
        && vstoreA.data[1].grant?.accessToken === "at-second-2"
        && backendA.records.get(ACTIVE)?.payload?.accessToken === activeBefore
        && backendA.refs.get(USERNAME_REF) === "first",
      JSON.stringify(vstoreA.data));
    check("添加模式后：当前会话照常服务",
      (await storeA.getToken()) === activeBefore,
      JSON.stringify(await storeA.getToken()));
    // 错密码添加：当场拒（报平台原话）、不落清单、该号进冷却；重提交正确密码即清。
    authA.loginFailsFor = { "third": true };
    let addErr = null;
    try { await storeA.saveAccount({ username: "third", password: "pw-wrong" }, { activate: false }); }
    catch (e) { addErr = e; }
    check("错密码添加：当场拒（报平台原话）、不落清单、该号被 park",
      addErr !== null && /invalid account or password/.test(String(addErr.message))
        && vstoreA.data?.length === 2
        && (await storeA.listAccounts()).every((a) => a.username !== "third"),
      `err=${addErr?.message} vault=${JSON.stringify(vstoreA.data?.map((a) => a.username))}`);
    authA.loginFailsFor = {};
    await storeA.saveAccount({ username: "third", password: "pw-right" }, { activate: false });
    check("同号重提交正确密码：冷却清除、条目落清单",
      vstoreA.data?.length === 3 && vstoreA.data[2].password === "pw-right",
      JSON.stringify(vstoreA.data?.map((a) => ({ u: a.username, p: a.password }))));

    // ── 场景 8b：0.1.27 槽位遗产直接作废（2026-10-29 用户拍板：无存量用户，
    // 迁移代码是纯负债）——旧侧槽不收编、不读取，清单为空 ──
    const backend8 = fakeBackend();
    const auth8 = fakeAuth();
    backend8.records.set(key("sensenova-console-account-2"), {
      kind: "account", version: 1, username: "legacy-user", password: "pw-legacy",
      grant: { kind: "grant", payload: { version: 1, accessToken: "at-legacy-9", refreshToken: "rt-legacy-9", expiresAt: Date.now() + 1000 } }
    });
    const store8wrap = buildStore({ env: {}, auth: auth8, backend: backend8.backend });
    const store8 = store8wrap.store;
    check("槽位遗产作废：不收编、清单为空、旧槽原样不动",
      (await store8.listAccounts()).length === 0
        && backend8.records.get(key("sensenova-console-account-2")) !== undefined
        && backend8.records.get(key("sensenova-console-accounts")) === undefined,
      JSON.stringify(await store8.listAccounts()));
  }
} catch (e) { fail("account-vault", e); }

let failed = 0;
for (const r of results) if (!r.pass) failed += 1;
console.log(JSON.stringify(results, null, 2));
if (failed > 0) {
  console.error(`account-vault.test.mjs：${failed}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`account-vault.test.mjs：${results.length} 项全过`);
