/**
 * Host-side diagnostic lines → a real file (companion exit of console.warn).
 *
 * 桌面主进程把宿主半区（插件所在进程）的 stdout/stderr 管道接管，只在崩溃时
 * 落一份 crash-host.log——终端里永远看不到插件的 `[dsh-sensenova-suite]` 诊断行
 * （2026-10-27 图片链路排查实测：终端启动也只有主进程自己的行）。本模块让所有
 * 诊断行在保留 console 出口的同时同步追加进 `<状态目录>/dsh-sensenova-suite.log`
 * （与 pool.json 同目录），`Get-Content -Wait` 它即可排障。
 *
 * 设计约束：
 * - 日志永不抛错：sink 挂了/磁盘满静默丢弃——诊断失败不能反过来打断请求路径；
 * - 无配置字段：路径由状态目录派生，无开关（配置字段要少）；
 * - 时间戳只加在文件行上，console 行逐字保持原样（不扰动既有消费者）；
 * - 轮转只在打开时做一次（>2MB 改名 .old）：行量是诊断级的，运行中不轮转。
 *
 * @module dsh-sensenova-suite/trace-log
 */
import { appendFileSync, closeSync, openSync, readSync, renameSync, statSync } from "node:fs";

/** 单文件上限：超过则启动时轮转为 .old（保留上一份供回看）。 */
export const TRACE_MAX_BYTES = 2 * 1024 * 1024;

/** UTF-8 BOM 字节序列：无 BOM 的 UTF-8 会被 PowerShell 5.1 按 ANSI（GBK）解码。 */
const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);
/** 文件首写的 BOM 字符（文本形态，与 UTF8_BOM_BYTES 同值）。 */
const UTF8_BOM = "\uFEFF";

let sink: ((line: string) => void) | undefined;

/** 接线点（index.ts 启动时调用一次）；传 undefined 恢复纯 console。 */
export function setTraceSink(next: ((line: string) => void) | undefined): void {
  sink = next;
}

/**
 * 诊断行唯一出口：console.warn 原样 + 文件追加（带 ISO 时间戳，永不抛）。
 * 插件内一切 `[dsh-sensenova-suite]` 行都走这里，别再直接调 console。
 */
export function traceLog(line: string): void {
  console.warn(line);
  try {
    sink?.(`${new Date().toISOString()} ${line}\n`);
  } catch {
    // 诊断失败不反噬。
  }
}

/** 打开日志文件（追加语义；超限先轮转 .old，不存在 = 全新文件）。返回追加器。 */
export function openTraceFile(file: string): (line: string) => void {
  try {
    if (statSync(file).size > TRACE_MAX_BYTES) renameSync(file, `${file}.old`);
  } catch {
    // 文件不存在 = 首次创建，正当路径。
  }
  // 无 BOM 的 UTF-8 会被 PowerShell 5.1 默认按 ANSI（GBK）解码成乱码——首建补
  // BOM；旧版无 BOM 文件轮转让位，保证默认 Get-Content 直接可读。
  let fresh = true;
  try {
    const head = Buffer.alloc(3);
    const fd = openSync(file, "r");
    try {
      readSync(fd, head, 0, 3, 0);
      fresh = !head.equals(UTF8_BOM_BYTES);
    } finally {
      closeSync(fd);
    }
    if (fresh) renameSync(file, `${file}.old`);
  } catch {
    fresh = true;
  }
  if (fresh) appendFileSync(file, UTF8_BOM);
  return (line: string) => {
    appendFileSync(file, line);
  };
}
