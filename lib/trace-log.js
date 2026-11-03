import { dirname } from "node:path";
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";

//#region src/host/trace-log.ts
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
* - 日志永不抛错：sink 挂了/磁盘满/目录缺失静默丢弃（打开失败退化为纯 console）
*   ——诊断失败不能反过来打断请求路径；
* - 无配置字段：路径由状态目录派生，无开关（配置字段要少）；
* - 时间戳只加在文件行上，console 行逐字保持原样（不扰动既有消费者）；
* - 轮转只在打开时做一次（>2MB 改名 .old）：行量是诊断级的，运行中不轮转。
*
* @module dsh-sensenova-suite/trace-log
*/
/** 单文件上限：超过则启动时轮转为 .old（保留上一份供回看）。 */
const TRACE_MAX_BYTES = 2097152;
/** UTF-8 BOM 字节序列：无 BOM 的 UTF-8 会被 PowerShell 5.1 按 ANSI（GBK）解码。 */
const UTF8_BOM_BYTES = Buffer.from([
	239,
	187,
	191
]);
/** 文件首写的 BOM 字符（文本形态，与 UTF8_BOM_BYTES 同值）。 */
const UTF8_BOM = "﻿";
let sink;
/** 接线点（index.ts 启动时调用一次）；传 undefined 恢复纯 console。 */
function setTraceSink(next) {
	sink = next;
}
/**
* 诊断行唯一出口：console.warn 原样 + 文件追加（带 ISO 时间戳，永不抛）。
* 插件内一切 `[dsh-sensenova-suite]` 行都走这里，别再直接调 console。
*/
function traceLog(line) {
	console.warn(line);
	try {
		sink?.(`${(/* @__PURE__ */ new Date()).toISOString()} ${line}\n`);
	} catch {}
}
/**
* 打开日志文件（追加语义；超限先轮转 .old，不存在 = 全新文件）。返回追加器。
*
* 状态目录可能还不存在（全新安装 / 新 profile 首挂 / 用户清过 state 目录），
* 而下面的 BOM 首写没有父目录会 ENOENT——这里抛出去，`index.ts` 的 apply()
* 就在挂载中途崩掉、整插件下线，且 store 写点全在挂载之后，目录永远没人建，
* 每次启动同崩（2026-10-31 审计 U7-D1）。所以：先建目录；打开路径的任何一环
* 仍失败（只读 Home、磁盘满）都退化为 no-op sink——诊断文件缺席是可接受的
* 降级，不能反过来挡挂载。
*/
function openTraceFile(file) {
	try {
		mkdirSync(dirname(file), {
			recursive: true,
			mode: 448
		});
		try {
			if (statSync(file).size > 2097152) renameSync(file, `${file}.old`);
		} catch {}
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
	} catch {
		return () => {};
	}
	return (line) => {
		appendFileSync(file, line);
	};
}

//#endregion
export { setTraceSink as n, traceLog as r, openTraceFile as t };