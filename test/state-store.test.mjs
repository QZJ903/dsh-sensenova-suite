/**
 * 状态落盘原语单测——纯 Node、无 peer、临时目录。
 *
 * 钉住的契约（state-store.ts 是全部 store 的公共底，本套件只钉原语自身）：
 * - isProfileSegment 与宿主 profile 名判据对齐（U7-S1，2026-10-31）：宿主
 *   resolveProfileDir 只拒 ""、"/"、"\\"、"."、".."、"node_modules"，宿主放行的
 *   非 ASCII（CJK）名必须分段；traversal 形状与控制字符必须全拒；
 * - writeStateFile 的本进程陈旧 temp 收扫（U7-D2，2026-10-31）：同 pid 过龄
 *   temp 删（EPERM 搁浅残留）、同 pid 新鲜 temp 留（在飞写保护）、他进程 temp 留
 *   （所有权证明）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProfileSegment, temporaryOf, writeStateFile } from "../src/host/state-store.ts";

const results = [];
const check = (name, ok, detail = "") => results.push({ name, pass: ok === true, detail: String(detail) });
const fail = (group, error) => results.push({ name: group, pass: false, detail: String(error) });

try {
  // ── 1. isProfileSegment：与宿主黑名单对齐 ──────────────────────────────────
  check("CJK profile 名放行（宿主合法 → 插件必须分段）",
    isProfileSegment("我的配置") === true);
  check("ASCII 名照常放行",
    isProfileSegment("desktop") === true && isProfileSegment("web") === true);
  check("空串 / 非字符串拒",
    isProfileSegment("") === false && isProfileSegment(null) === false && isProfileSegment(42) === false);
  check("traversal 形状全拒",
    isProfileSegment("a/b") === false && isProfileSegment("a\\b") === false
    && isProfileSegment(".") === false && isProfileSegment("..") === false
    && isProfileSegment("node_modules") === false);
  check("控制字符拒（含 NUL）",
    isProfileSegment("a\u0000b") === false && isProfileSegment("a\nb") === false);
  check("64 上限（超长拒）",
    isProfileSegment("a".repeat(64)) === true && isProfileSegment("a".repeat(65)) === false);

  // ── 2. 原子写往返：temp 落位为正式文件、载荷带尾换行 ────────────────────────
  const root = mkdtempSync(join(tmpdir(), "suite-statestore-"));
  const dir = join(root, "state");
  mkdirSync(dir, { recursive: true }); // writeStateFile 是低层原语：目录归 writer 工厂（ensureStateDir）建。
  const file = join(dir, "pool.json");
  await writeStateFile(file, '{"version":1}', { temporary: temporaryOf(dir, "pool.json") });
  check("原子写：正式文件落位、内容带尾换行", readFileSync(file, "utf8") === '{"version":1}\n',
    JSON.stringify(readFileSync(file, "utf8")));

  // ── 3. 本进程陈旧 temp 收扫（U7-D2）─────────────────────────────────────────
  const stale = temporaryOf(dir, "pool.json");
  writeFileSync(stale, '{"version":0}\n');
  const staleTime = new Date(Date.now() - 10 * 60_000);
  utimesSync(stale, staleTime, staleTime);
  const fresh = temporaryOf(dir, "pool.json");
  writeFileSync(fresh, '{"version":0}\n');
  const foreign = join(dir, `pool.json.999999.${Date.now()}.ffffffff-ffff-4fff-8fff-ffffffffffff.tmp`);
  writeFileSync(foreign, '{"version":0}\n');
  utimesSync(foreign, staleTime, staleTime);
  await writeStateFile(file, '{"version":2}', { temporary: temporaryOf(dir, "pool.json") });
  check("同 pid 过龄 temp 收扫（EPERM 搁浅残留不再累积）", existsSync(stale) === false,
    String(existsSync(stale)));
  check("同 pid 新鲜 temp 不误杀（在飞写保护）", existsSync(fresh) === true);
  check("他进程 temp 不动（pid 即所有权证明）", existsSync(foreign) === true);
  check("收扫不打断写本身：正式文件已是新载荷",
    readFileSync(file, "utf8") === '{"version":2}\n');
  rmSync(root, { recursive: true, force: true });
} catch (e) { fail("state-store", e); }

let failed = 0;
for (const r of results) if (!r.pass) failed += 1;
console.log(JSON.stringify(results, null, 2));
if (failed > 0) {
  console.error(`state-store.test.mjs：${failed}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`state-store.test.mjs：${results.length} 项全过`);
