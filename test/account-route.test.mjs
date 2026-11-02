/**
 * 账号路由回归（peer-free）——真路由 + 桩 wiring 真跑，不依赖 peer。
 *
 * 起因（2026-10-31 U5 审计顺带 2）：switch 失败路径不清 coalesced 缓存——
 * 快照路径失败时身份/grant 已可能换人（「切换保持生效」），上一账号的缓存
 * console 响应会越界存活 ≤cacheSeconds。routes.test 是 peer 门控（本机与
 * CI 都 loud-SKIP），这条纪律需要一份真跑的钉，本文件就是它：
 *
 *   1. switch 成功 → 缓存清场（既有纪律在此获得 peer-free 钉）；
 *   2. switch 失败 → 同样清场（顺带 2 的判别钉）+ 失败报告面原样透传
 *      code/detail/retryAfterMs；
 *   3. GET → state 透传、无密码无令牌原文；
 *   4. 登录失败 → detail 与 retryAfterMs 上屏（reportAuthFailure 契约）。
 *   5. remove 失败 → 同款报告面 + 缓存清场（2026-11-03 U8-D1 修复轮：此前
 *      remove 分支无兜底，抛错冲出 handler 被宿主兜成裸 400 空体；T1）。
 *   6. 畸形 action 拒 400 → 封闭白名单（U8-顺带2 案 a）：未知 action / switch
 *      无 id 不再掉进登录兜底冒充 MISSING_CREDENTIALS 登录失败。
 *
 * harness 与 pool-route.test.mjs 同形：webServer 桩捕获路由定义、请求用
 * async-iterator 喂 body、响应 writeHead/end 拼接断言。
 */
const results = [];
const check = (name, ok, detail = "") => results.push({ name, pass: ok === true, detail: String(detail) });
const fail = (group, error) => results.push({ name: group, pass: false, detail: String(error) });

const { registerAccountRoute } = await import("../src/host/routes/account.ts");
const { CODE } = await import("../src/host/codes.ts");

/** 桩 tokenStore：可脚本化 switchAccount/removeAccount 抛错；state/saves/removes 留痕。 */
function buildStoreStub({ switchErr = null, removeErr = null } = {}) {
  const calls = { switches: [], saves: [], removes: [] };
  return {
    calls,
    async state() {
      return { configured: true, hasAccount: true, accounts: [{ id: "a", username: "a", hasGrant: true, active: true }] };
    },
    async saveAccount(acc, opts) { calls.saves.push({ username: acc?.username, activate: opts?.activate }); },
    async switchAccount(id) { calls.switches.push(id); if (switchErr) throw switchErr; },
    async removeAccount(id) { calls.removes.push(id); if (removeErr) throw removeErr; }
  };
}

/** 桩 wiring：真 Map 当 cache/inflight——clearCoalescedFetch 的效果用 size 观测。 */
function buildWiring({ switchErr, removeErr } = {}) {
  const cache = new Map([["console:quota", { v: 1 }], ["console:catalog", { v: 2 }]]);
  const inflight = new Map([["console:quota", Promise.resolve(1)]]);
  const tokenStore = buildStoreStub({ switchErr, removeErr });
  let def;
  const ctx = { webServer: { register: (d) => { def = d; return () => {}; } } };
  registerAccountRoute(ctx, {
    settings: { allowedHosts: new Set(["127.0.0.1"]) },
    tokenStore,
    cache,
    inflight
  });
  return { def, cache, inflight, tokenStore };
}

/** 驱动一次 POST：返回 { status, body }（pool-route 同形）。 */
async function post(def, payload) {
  const body = JSON.stringify(payload);
  const request = {
    method: "POST",
    headers: { host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); }
  };
  let out = "";
  const response = {
    writeHead: (code) => { out += `status=${code} `; },
    end: (p) => { out += String(p); }
  };
  await def.handler(request, response);
  const status = Number(/status=(\d+)/.exec(out)?.[1] ?? 0);
  const jsonStart = out.indexOf("{");
  return { status, body: jsonStart >= 0 ? JSON.parse(out.slice(jsonStart)) : null };
}

/** 驱动一次 GET。 */
async function get(def) {
  const request = { method: "GET", headers: { host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387" } };
  let out = "";
  const response = {
    writeHead: (code) => { out += `status=${code} `; },
    end: (p) => { out += String(p); }
  };
  await def.handler(request, response);
  return JSON.parse(out.slice(out.indexOf("{")));
}

try {
  // 1. switch 成功：缓存清场（既有纪律，此处给 peer-free 钉）。
  {
    const w = buildWiring();
    const res = await post(w.def, { action: "switch", id: "b" });
    check("switch 成功：ok 且 coalesced 缓存清场",
      res.status === 200 && res.body?.ok === true
        && w.cache.size === 0 && w.inflight.size === 0
        && w.tokenStore.calls.switches.length === 1,
      `${res.status} cache=${w.cache.size} inflight=${w.inflight.size}`);
  }

  // 2. switch 失败：同样清场（U5 顺带 2 的判别钉）+ 失败面透传。
  {
    const err = new Error("snapshot dead and vault password rejected");
    err.code = CODE.REFRESH_REJECTED;
    err.detail = "platform: invalid grant";
    err.retryAfterMs = 45000;
    const w = buildWiring({ switchErr: err });
    const res = await post(w.def, { action: "switch", id: "b" });
    check("switch 失败：coalesced 缓存同样清场（快照路径失败时身份可能已换人）",
      res.body?.ok === false && w.cache.size === 0 && w.inflight.size === 0,
      `cache=${w.cache.size} inflight=${w.inflight.size}`);
    check("switch 失败：code/detail/retryAfterMs 原样上屏（reportAuthFailure 契约）",
      res.body?.code === CODE.REFRESH_REJECTED
        && res.body?.detail === "platform: invalid grant"
        && res.body?.retryAfterMs === 45000
        && res.body?.configured === true,
      JSON.stringify({ code: res.body?.code, detail: res.body?.detail, wait: res.body?.retryAfterMs }));
  }

  // 3. 登录失败：同一报告面（detail 上屏、trace 缺席时不写文件）。
  {
    const err = new Error("platform: invalid account or password");
    err.code = CODE.LOGIN_REJECTED;
    err.detail = "Wrong account or password";
    const w = buildWiring();
    w.tokenStore.saveAccount = async () => { throw err; };
    const res = await post(w.def, { username: "u", password: "p" });
    check("登录失败：code=login_rejected、detail 平台原话、ok=false",
      res.body?.ok === false && res.body?.code === CODE.LOGIN_REJECTED && res.body?.detail === "Wrong account or password",
      JSON.stringify({ code: res.body?.code, detail: res.body?.detail }));
  }

  // 4. GET：state 透传，且不回显密码/令牌原文。
  {
    const w = buildWiring();
    const res = await get(w.def);
    const serialized = JSON.stringify(res);
    check("GET：state 透传（ok + configured + accounts）",
      res.ok === true && res.configured === true && Array.isArray(res.accounts),
      serialized.slice(0, 120));
    check("GET：不回显密码与令牌原文",
      !/"password"/.test(serialized) && !/at-|eyJ/.test(serialized.replace(/"configured"/, "")),
      serialized.slice(0, 120));
  }
  // 5. remove 失败：与 switch 失败同款报告面 + 缓存清场（U8-D1 修复轮钉）。
  //    修复前：remove 分支裸 await，抛错冲出 handler，宿主兜成裸 400 空体、
  //    缓存不清（身份可能已换人而旧号缓存越界存活 ≤cacheSeconds）。
  {
    const err = new Error("vault write failed");
    err.code = CODE.AUTH_ERROR;
    const w = buildWiring({ removeErr: err });
    const res = await post(w.def, { action: "remove", id: "b" });
    check("remove 失败：200 ok:false + code 透传（不再是宿主裸 400 空体）",
      res.status === 200 && res.body?.ok === false && res.body?.code === CODE.AUTH_ERROR,
      `${res.status} ${JSON.stringify(res.body)}`);
    check("remove 失败：coalesced 缓存清场（身份可能已换人，与 switch 失败同纪律）",
      w.cache.size === 0 && w.inflight.size === 0,
      `cache=${w.cache.size} inflight=${w.inflight.size}`);
  }

  // 6. 畸形 action 拒 400（U8-顺带2 案 a）：白名单挡在登录兜底之前——
  //    saves 留痕为 0 证明没有掉进 saveAccount 冒充登录失败。
  {
    const w = buildWiring();
    const unknown = await post(w.def, { action: "explode", id: "b" });
    check("未知 action 拒 400（pool 同款纪律）",
      unknown.status === 400 && unknown.body?.ok === false
        && /action must be switch \| remove/.test(String(unknown.body?.error)),
      `${unknown.status} ${JSON.stringify(unknown.body)}`);
    const noId = await post(w.def, { action: "switch" });
    check("switch 无 id 拒 400（不再冒充登录失败，saves=0）",
      noId.status === 400 && noId.body?.ok === false
        && /id: string/.test(String(noId.body?.error))
        && w.tokenStore.calls.saves.length === 0,
      `${noId.status} saves=${w.tokenStore.calls.saves.length} ${JSON.stringify(noId.body)}`);
  }
} catch (e) { fail("account-route", e); }

let failed = 0;
for (const r of results) if (!r.pass) failed += 1;
console.log(JSON.stringify(results, null, 2));
if (failed > 0) {
  console.error(`account-route.test.mjs：${failed}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`account-route.test.mjs：${results.length} 项全过`);
