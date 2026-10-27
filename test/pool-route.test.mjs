/**
 * 池管理路由回归——真 store + 真路由处理器（无 peer；DSH_HOME 指向临时目录）。
 *
 * 起因（2026-10-27）：面板「备注无法保存」报障。服务端链路（rename → setKeys →
 * parsePoolPayload 回读）当时无任何钉子，排障只能逐环手测——本文件把「写入
 * 确实落盘」钉成回归：rename → 200 + name 落盘；空备注合法；未知 action 400。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "suite-pool-route-"));
const { createFilePoolStore, POOL_STORE_VERSION } = await import("../src/host/pool-store.ts");
const { registerPoolRoute } = await import("../src/host/routes/pool.ts");

const results = [];
const check = (name, ok, detail = "") => results.push({ name, pass: ok === true, detail: String(detail) });
const fail = (group, error) => results.push({ name: group, pass: false, detail: String(error) });

try {
  const store = createFilePoolStore({ profile: null, logger: null });
  await store.setKeys([{ id: "key-2", name: "" }, { id: "key-3", name: "" }]);

  let def;
  const ctx = { webServer: { register: (d) => { def = d; return () => {}; } } };
  registerPoolRoute(ctx, {
    settings: { allowedHosts: new Set(["127.0.0.1"]) },
    logger: null,
    poolAdmin: {
      store,
      setDefaultNote: (note) => store.setDefaultNote(note),
      phaseOf: () => "running",
      refresh: async () => {},
      effectiveConcurrency: async () => 2,
      apply: async () => {},
      addKeySecret: async () => {},
      removeKeySecret: async () => {},
      hasPanelKey: async () => false
    }
  });

  /** 驱动一次 POST：返回 { status, body }。 */
  const post = async (payload) => {
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
  };

  // 1. rename → 200 + name 落盘（读侧走同一条 parsePoolPayload 链）。
  const renamed = await post({ action: "rename", id: "key-2", name: "我的主力 key" });
  const afterRename = JSON.parse(readFileSync(join(process.env.DSH_HOME, "state", "dsh-sensenova-suite", "pool.json"), "utf8"));
  check("rename 返回 200 ok", renamed.status === 200 && renamed.body?.ok === true, `${renamed.status} ${JSON.stringify(renamed.body)}`);
  check("rename 落盘（磁盘文件里的 name 更新）",
    afterRename.keys.find((k) => k.id === "key-2")?.name === "我的主力 key",
    JSON.stringify(afterRename.keys));

  // 2. 空备注（清空）合法。
  const cleared = await post({ action: "rename", id: "key-2", name: "" });
  const afterClear = JSON.parse(readFileSync(join(process.env.DSH_HOME, "state", "dsh-sensenova-suite", "pool.json"), "utf8"));
  check("rename 空备注合法且落盘",
    cleared.status === 200 && afterClear.keys.find((k) => k.id === "key-2")?.name === "");

  // 3. 其他 key 不被波及。
  check("rename 不影响其他 key 条目",
    afterClear.keys.find((k) => k.id === "key-3")?.name === "" && afterClear.keys.length === 2,
    JSON.stringify(afterClear.keys));

  // 4.5 default（面板默认 key）的备注：它不在 keys 清单里，走单独的 defaultNote
  // 字段——2026-10-27 真机：rename id=default 在 keys.map 零命中、静默丢失。
  const defaultRenamed = await post({ action: "rename", id: "default", name: "面板主 key" });
  const afterDefault = JSON.parse(readFileSync(join(process.env.DSH_HOME, "state", "dsh-sensenova-suite", "pool.json"), "utf8"));
  check("rename id=default 落到 defaultNote 字段",
    defaultRenamed.status === 200 && afterDefault.defaultNote === "面板主 key",
    `${defaultRenamed.status} ${JSON.stringify(afterDefault.defaultNote)}`);
  check("default 备注不影响 keys 清单",
    afterDefault.keys.find((k) => k.id === "key-2")?.name === "" && afterDefault.keys.length === 2);
  const defaultCleared = await post({ action: "rename", id: "default", name: "" });
  const afterDefaultClear = JSON.parse(readFileSync(join(process.env.DSH_HOME, "state", "dsh-sensenova-suite", "pool.json"), "utf8"));
  check("default 备注可清空", defaultCleared.status === 200 && afterDefaultClear.defaultNote === "");

  // 4. 未知 action 拒 400。
  const bad = await post({ action: "explode", id: "key-2" });
  check("未知 action 拒 400", bad.status === 400 && bad.body?.ok === false, `${bad.status}`);

  // 5. GET 列出 keys（池管理页的数据源）。
  const getRequest = { method: "GET", headers: { host: "127.0.0.1:19387", origin: "" } };
  let out = "";
  const getResponse = { writeHead: (code) => { out += `status=${code} `; }, end: (p) => { out += String(p); } };
  await def.handler(getRequest, getResponse);
  const got = JSON.parse(out.slice(out.indexOf("{")));
  check("GET 列出 store 清单（不解析凭据也列）",
    got.ok === true && Array.isArray(got.keys) && got.keys.some((k) => k.id === "key-3"),
    out.slice(0, 120));
} catch (e) { fail("pool-route", e); }

let failed = 0;
for (const r of results) if (!r.pass) failed += 1;
console.log(JSON.stringify(results, null, 2));
if (failed > 0) {
  console.error(`pool-route.test.mjs：${failed}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`pool-route.test.mjs：${results.length} 项全过`);
