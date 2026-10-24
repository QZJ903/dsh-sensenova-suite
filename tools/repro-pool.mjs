/**
 * 复现脚本：用**构建产物**（lib/index.js）挂载插件，走真实 HTTP 路由，
 * 打印每个响应体。用途：定位面板「无法连接本机 Host」背后的真实错误
 * （客户端会把 ok:false 的 error 文本吞掉，这里看原文）。
 *
 * 运行：node tools/repro-pool.mjs
 */
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "dsh-repro-"));
process.env.DSH_HOME = home;
const stateDir = join(home, "state", "dsh-sensenova-suite");
mkdirSync(stateDir, { recursive: true });

// 用桌面面真实 pool.json 做起点（有协议覆盖、无 keys）
const real = "C:/Users/17605/.dsh/state/desktop/dsh-sensenova-suite/pool.json";
try {
  copyFileSync(real, join(stateDir, "pool.json"));
} catch {
  console.log("(没有真实 pool.json，从空开始)");
}

const routes = new Map();
const webServer = { register: (route) => { routes.set(route.path, route.handler); return () => {}; } };

const refs = new Map();
const credentials = {
  async resolve(ref) {
    const value = refs.get(ref);
    return typeof value === "string" && value !== "" ? { value, source: "file" } : undefined;
  },
  async set(ref, value) { refs.set(ref, value); },
  async unset(ref) { refs.delete(ref); }
};

const ctx = {
  webServer,
  get: (service) => (service === "credentials" ? credentials : null),
  effect: () => {},
  on: () => () => {},
  emit: () => {},
  logger: { warn: (m) => console.log("[warn]", m), info: () => {} }
};

const mod = await import("../lib/index.js");
mod.apply(ctx, { apiBase: "https://token.sensenova.cn/v1", pollSeconds: 5, cacheSeconds: 5, consoleTimeoutMs: 15000 }, {});
await new Promise((r) => setTimeout(r, 100));

async function call(path, method, body) {
  const handler = routes.get(path);
  if (handler === undefined) return { status: 404, body: { error: `route ${path} NOT REGISTERED` } };
  const payload = body === undefined ? "" : JSON.stringify(body);
  const request = {
    method,
    headers: { host: "127.0.0.1:3300", origin: "http://127.0.0.1:3300" },
    async *[Symbol.asyncIterator]() { if (payload !== "") yield Buffer.from(payload); }
  };
  const out = { status: 0, body: null };
  const response = {
    writeHead(status) { out.status = status; return response; },
    end(chunk) {
      if (typeof chunk === "string") {
        try { out.body = JSON.parse(chunk); } catch { out.body = chunk; }
      }
      return response;
    }
  };
  await handler(request, response);
  return out;
}

const show = (label, r) => console.log(label, "→", r.status, JSON.stringify(r.body).slice(0, 400));

show("GET  /pool        ", await call(`/api/${mod.name}/pool`, "GET"));
show("POST add key      ", await call(`/api/${mod.name}/pool`, "POST", { action: "add", apiKey: "sk-repro-1" }));
show("GET  /pool (after)", await call(`/api/${mod.name}/pool`, "GET"));
show("POST section      ", await call(`/api/${mod.name}/pool`, "POST", { section: "text2img", values: { model: "sensenova-u1.5-fast" } }));
show("POST rename       ", await call(`/api/${mod.name}/pool`, "POST", { action: "rename", id: "key-1", name: "备用" }));
show("POST protocol     ", await call(`/api/${mod.name}/models`, "POST", { modelProtocols: { "glm-5.2": "responses" } }));
const snap = await call(`/api/${mod.name}/snapshot`, "GET");
console.log("GET  /snapshot    →", snap.status, JSON.stringify({ pool: snap.body?.pool, protocols: snap.body?.llm?.modelProtocols }).slice(0, 500));
console.log("凭据 refs:", [...refs.keys()]);
console.log("磁盘 pool.json:", readFileSync(join(stateDir, "pool.json"), "utf8").replace(/\s+/g, " ").slice(0, 300));
