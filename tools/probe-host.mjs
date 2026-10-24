#!/usr/bin/env node
/**
 * 本机 DSH Host 诊断：从系统里取出所有监听端口，逐个探测本插件注册的六条路由，
 * 打印 HTTP 状态与响应体。
 *
 * 面板上的「无法连接本机 Host」把三种完全不同的故障说成一句话：
 *   1. 路由没注册（Host 跑的是旧构建）→ 404 非 JSON
 *   2. 被信任围栏拒绝（origin 与 host 不符）→ 403 + JSON error
 *   3. 网络层失败（端口不通 / 页面 origin 解析不到）→ fetch 抛异常
 * 这个脚本直接把 (1)(2) 分开，并把端口号告诉你。
 *
 * 用法：保持 DSH 运行，然后 `node tools/probe-host.mjs`
 */
import { execFileSync } from "node:child_process";

const NS = "dsh-sensenova-suite";
const ROUTES = ["snapshot", "account", "api-key", "provider", "models", "pool"];

/** 取本机所有 LISTENING 端口（Windows netstat；其他平台退回常见区间）。 */
function listeningPorts() {
  const ports = new Set();
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
    for (const line of out.split("\n")) {
      if (!line.includes("LISTENING")) continue;
      const match = /:(\d+)\s+\S+\s+LISTENING/.exec(line);
      if (match !== null) ports.add(Number(match[1]));
    }
  } catch {
    // 非 Windows：扫常见区间
    for (let p = 3000; p <= 3400; p += 1) ports.add(p);
    for (let p = 7700; p <= 7900; p += 1) ports.add(p);
  }
  // 排除明显的非 HTTP 端口，剩下的全试（本机端口数量有限，1.2s 超时）。
  return [...ports].filter((p) => p > 1024).sort((a, b) => a - b);
}

async function hit(port, route, body) {
  const url = `http://127.0.0.1:${port}/api/${NS}/${route}`;
  try {
    const res = await fetch(url, {
      method: route === "snapshot" ? "GET" : "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: route === "snapshot" ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(1500)
    });
    const text = (await res.text()).slice(0, 240);
    return { status: res.status, text, json: text.trimStart().startsWith("{") };
  } catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

const ports = listeningPorts();
console.log(`扫描 ${ports.length} 个监听端口…\n`);

const hits = [];
for (const port of ports) {
  const probe = await hit(port, "pool", { action: "rename", id: "__probe__", name: "__probe__" });
  // 命中条件：拿到 JSON（无论 200/400/403）——说明这个端口上确实有本插件的路由。
  if (probe.json === true) hits.push({ port, probe });
}

if (hits.length === 0) {
  console.log("❌ 没有任何端口响应本插件的 /pool 路由。");
  console.log("   可能原因：DSH 没在运行；插件未加载；或 Host 跑的是不含 /pool 的旧构建。");
  process.exit(1);
}

for (const { port, probe } of hits) {
  console.log(`✅ 端口 ${port} 有本插件路由（/pool → HTTP ${probe.status}）`);
  console.log(`   响应: ${probe.text.replace(/\s+/g, " ")}`);
}

const port = hits[0].port;
console.log(`\n=== 端口 ${port} 六路由全查 ===`);
for (const route of ROUTES) {
  const result = await hit(port, route, { action: "rename", id: "__probe__", name: "__probe__" });
  if (result.error !== undefined) {
    console.log(`  ${route.padEnd(9)} 网络失败: ${result.error}`);
  } else {
    const verdict = result.json ? (result.status < 400 ? "OK" : "被拒（JSON）") : "非 JSON ← 路由不存在";
    console.log(`  ${route.padEnd(9)} HTTP ${result.status}  ${verdict}  ${result.text.replace(/\s+/g, " ").slice(0, 110)}`);
  }
}

console.log("\n=== 快照里的池状态（面板应显示同样的内容）===");
const snap = await hit(port, "snapshot");
if (snap.json === true) {
  try {
    const body = JSON.parse(snap.text.length >= 240 ? await (await fetch(`http://127.0.0.1:${port}/api/${NS}/snapshot`, {
      headers: { origin: `http://127.0.0.1:${port}` }, signal: AbortSignal.timeout(3000)
    })).text() : snap.text);
    console.log("  pool.keys    :", JSON.stringify(body.pool?.keys));
    console.log("  protocols    :", JSON.stringify(body.llm?.modelProtocols));
    console.log("  多模态设置   :", JSON.stringify(body.pool?.settings));
  } catch (error) {
    console.log("  解析失败:", error instanceof Error ? error.message : String(error));
  }
}
