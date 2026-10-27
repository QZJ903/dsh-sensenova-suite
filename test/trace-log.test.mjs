/**
 * 诊断文件日志单测——纯 Node、无 peer、临时目录。
 *
 * 钉住的契约（trace-log.ts 是所有宿主诊断行的唯一出口，桌面主进程接管宿主
 * stdout 后文件出口是排障生命线，见模块头注释）：
 * - traceLog 保留 console.warn 原出口 + sink 收到带 ISO 时间戳的同一行；
 * - sink 抛错不外溢（诊断失败不反噬请求路径）；
 * - openTraceFile：追加语义、超限启动轮转 .old、文件不存在 = 全新创建。
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTraceFile, setTraceSink, TRACE_MAX_BYTES, traceLog } from "../src/host/trace-log.ts";

const results = [];
const check = (name, ok, detail = "") => results.push({ name, pass: ok === true, detail: String(detail) });
const fail = (group, error) => results.push({ name: group, pass: false, detail: String(error) });

try {
  // ── 1. traceLog：console 出口保留 + 文件行带时间戳 ─────────────────────────
  const consoleLines = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => consoleLines.push(parts.map(String).join(" "));
  try {
    const sinkLines = [];
    setTraceSink((line) => sinkLines.push(line));
    traceLog("[dsh-sensenova-suite] 单测行 A");
    check("console.warn 原样保留（无时间戳）", consoleLines[0] === "[dsh-sensenova-suite] 单测行 A", consoleLines[0]);
    check("文件行带 ISO 时间戳 + 换行",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[dsh-sensenova-suite\] 单测行 A\n$/.test(sinkLines[0]),
      JSON.stringify(sinkLines[0]));

    // ── 2. sink 抛错不外溢 ────────────────────────────────────────────────────
    setTraceSink(() => { throw new Error("boom"); });
    let threw = "";
    try { traceLog("[dsh-sensenova-suite] 单测行 B"); } catch (e) { threw = String(e); }
    check("sink 抛错被吞（诊断不反噬请求）", threw === "" && consoleLines.length === 2, threw);

    // ── 3. openTraceFile：BOM + 追加 + 轮转 ──────────────────────────────────
    const dir = mkdtempSync(join(tmpdir(), "suite-trace-"));
    const file = join(dir, "dsh-sensenova-suite.log");
    const appender = openTraceFile(file);
    appender("第一行\n");
    appender("第二行\n");
    check("首建补 UTF-8 BOM（PowerShell 默认可读）",
      readFileSync(file, "utf8") === "\uFEFF第一行\n第二行\n", JSON.stringify(readFileSync(file, "utf8")));
    // 无 BOM 旧文件：轮转让位，新文件带 BOM。
    writeFileSync(file, "旧版无BOM内容", "utf8");
    const migrated = openTraceFile(file);
    migrated("迁移后新行\n");
    check("无 BOM 旧文件轮转 .old 且新文件补 BOM",
      existsSync(`${file}.old`) && readFileSync(`${file}.old`, "utf8") === "旧版无BOM内容"
      && readFileSync(file, "utf8") === "\uFEFF迁移后新行\n",
      `old=${readFileSync(`${file}.old`, "utf8")} new=${JSON.stringify(readFileSync(file, "utf8"))}`);
    // 已有 BOM：不轮转、不重复写 BOM。
    const before = readFileSync(file, "utf8");
    openTraceFile(file)("续行\n");
    check("已有 BOM 的文件不重复补 BOM",
      readFileSync(file, "utf8") === before + "续行\n", JSON.stringify(readFileSync(file, "utf8")));
    // 超限轮转。
    writeFileSync(file, "x".repeat(TRACE_MAX_BYTES + 1), "utf8");
    const rotated = openTraceFile(file);
    rotated("新起一行\n");
    check("超限轮转 .old（旧内容移走，新文件干净起步）",
      existsSync(`${file}.old`) && readFileSync(file, "utf8") === "\uFEFF新起一行\n",
      `old=${existsSync(`${file}.old`)} new=${JSON.stringify(readFileSync(file, "utf8"))}`);
    rmSync(dir, { recursive: true, force: true });

    // ── 4. 摘掉 sink：恢复纯 console ─────────────────────────────────────────
    setTraceSink(undefined);
    traceLog("[dsh-sensenova-suite] 单测行 C");
    check("undefined sink 恢复纯 console", consoleLines.length === 3);
  } finally {
    console.warn = originalWarn;
    setTraceSink(undefined);
  }
} catch (e) { fail("trace-log", e); }

let failed = 0;
for (const r of results) if (!r.pass) failed += 1;
console.log(JSON.stringify(results, null, 2));
if (failed > 0) {
  console.error(`trace-log.test.mjs：${failed}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`trace-log.test.mjs：${results.length} 项全过`);
