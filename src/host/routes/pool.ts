/**
 * Key 池管理路由：停用 / 恢复 / 删除账号、调全局并发数。
 *
 * GET  返回管理面清单（按账号 id；key 不出——面板只需要 id 与相位）；
 * POST { action, id } 执行单账号操作，{ globalConcurrency } 调整并发。
 *
 * accounts 里的账号删除只记入 deletedIds（配置重加同名 id 后需再恢复）。
 *
 * @module dsh-sensenova-suite/routes/pool
 */
import { name } from "../host-config.ts";
import { writeJson, refuseMethod, readJsonBodyOr400, withOrigin, redactedError } from "./http.ts";
import { maskKey } from "../util.ts";
import type { Wiring } from "../types.ts";

/** Key 池管理路由。 */
export const POOL_PATH = `/api/${name}/pool`;

/** 池管理面的装配依赖（index.ts 提供）。 */
export interface PoolAdmin {
  store: {
    read(): Promise<import("../pool-store.ts").PoolStoreRecord>;
    disable(id: string): Promise<void>;
    restore(id: string): Promise<void>;
    delete(id: string): Promise<void>;
    setGlobalConcurrency(value: number | null): Promise<void>;
    setKeys(keys: Array<{ id: string; name: string }>): Promise<void>;
    setSection(
      section: "toolsEnabled" | "text2img" | "img2img" | "vision" | "thinking",
      values: Record<string, unknown>
    ): Promise<void>;
  };
  /** 原生看图模型 id（目录 input_modalities 含 image）——vision 保存据此把
   * 「期望生效集 − 原生」写进 autoOffIds 墓碑（手动取消不被自动勾翻案）。
   * 可选：测试替身省略时墓碑退化为不写（自动勾翻案的旧行为）。 */
  nativeVisionIds?: () => string[];
  /** 单账号相位（面板停用/删除的账号读作 absent）。 */
  phaseOf(id: string): "running" | "blocked" | "absent";
  /** 管理面行，与快照 pool 块**同一份** poolKeyRows（label=脱敏名、note=备注）——
   * U11 顺带1（2026-11-04 拍板案 a）：GET 与快照单源，消灭两套形状。 */
  keyRows: () => Promise<Array<{
    id: string; label: string | null; note: string | null;
    phase: "running" | "blocked" | "absent"; disabled: boolean; deleted: boolean;
  }>>;
  /** 执行停用/恢复/删除的池侧动作。 */
  apply(action: "disable" | "restore" | "delete", id: string): Promise<void>;
  /** 把一把新 key 存入凭据服务（ref 由实现分配，返回稳这篇档的 id）。 */
  addKeySecret: (id: string, apiKey: string) => Promise<void>;
  /** 移除一把 key 的凭据记录（删除 key-<n> 时调用）。 */
  removeKeySecret: (id: string) => Promise<void>;
  /** 生效中的全局并发数（面板保存值 ?? 配置 ?? key 数）。 */
  effectiveConcurrency: () => Promise<number>;
  /** 已持有这把 key 值的条目 id（面板 key 记为 default；无人持有 = null）。add 查重用。 */
  findKeyHolder: (value: string) => Promise<string | null>;
  /** 状态文件刷新（写后让 params 的本地记录跟上）。 */
  refresh: () => Promise<void>;
  /** 面板改凭据后重解析池（加 key 后让新 key 立即入池，免重启）。 */
  refreshKeys: () => Promise<void>;
}

/**
 * Register the pool management route.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param wiring - `settings`（信任围栏）与 `poolAdmin`。
 */
export function registerPoolRoute(ctx: any, wiring: Pick<Wiring, "settings" | "logger"> & { poolAdmin?: PoolAdmin }) {
  const { settings, poolAdmin, logger } = wiring;
  if (poolAdmin === undefined) {
    return () => undefined;
  }

  return ctx.webServer.register({
    kind: "exact",
    path: POOL_PATH,
    handler: withOrigin(async (request: any, response: any) => {
      const method = request.method === undefined ? "GET" : request.method;
      if (method !== "GET" && method !== "POST") {
        refuseMethod(response);
        return;
      }
      try {
        if (method === "GET") {
          // U11 顺带1（2026-11-04 拍板案 a）：GET 行与快照 pool 块**同一份实现**
          // （index 的 poolKeyRows，经 poolAdmin.keyRows 注入）——label=脱敏名
          // （maskKey）、note=备注、相位走 seed 感知的 statusById。两套形状曾经
          // 相反（此处 label 装备注、无 note 字段），无消费者的潜伏分叉在此单源
          // 收口；「配置了什么就列什么，凭据解析失败列表不变空」（2026-10-24
          // 事故）由 poolKeyRows 自身的回退语义保证（label 回落 entry.id）。
          writeJson(response, 200, {
            ok: true,
            keys: await poolAdmin.keyRows(),
            globalConcurrency: await poolAdmin.effectiveConcurrency(),
            concurrencyFromPanel: (await poolAdmin.store.read()).globalConcurrency
          }, { "cache-control": "no-store" });
          return;
        }
        const body = await readJsonBodyOr400(request, response);
        if (body === null) return;
        // 多模态分区保存：{ section, values }（部分键合并）。
        if (typeof body.value.section === "string"
          && ["toolsEnabled", "text2img", "img2img", "vision", "thinking"].includes(body.value.section)
          && typeof body.value.values === "object" && body.value.values !== null) {
          const values = body.value.values as Record<string, unknown>;
          // 可看图保存语义（2026-11-03 拍板：自动勾为底、手动优先级最高）：
          // 面板提交的是「期望生效集」——原生目录 id 不在其中 = 手动取消，
          // 进 autoOffIds 墓碑（自动勾不再翻案）；手动勾选原样入 visionModels。
          // values 含 visionModels 才算勾选集保存；只改 model/bridgePrompt 的
          // 部分保存不动墓碑。nativeVisionIds 缺席（测试替身）退化为旧行为。
          if (body.value.section === "vision" && Array.isArray(values.visionModels)
            && typeof poolAdmin.nativeVisionIds === "function") {
            const desired = (values.visionModels as unknown[]).filter((id): id is string => typeof id === "string" && id !== "");
            values.autoOffIds = poolAdmin.nativeVisionIds().filter((id) => !desired.includes(id));
            values.visionModels = desired;
          }
          await poolAdmin.store.setSection(
            body.value.section as "toolsEnabled" | "text2img" | "img2img" | "vision" | "thinking",
            values
          );
          await poolAdmin.refresh();
          writeJson(response, 200, { ok: true }, { "cache-control": "no-store" });
          return;
        }
        if (typeof body.value.globalConcurrency === "number") {
          await poolAdmin.store.setGlobalConcurrency(Math.max(0, Math.floor(body.value.globalConcurrency)));
          await poolAdmin.refresh();
          writeJson(response, 200, { ok: true, globalConcurrency: await poolAdmin.effectiveConcurrency() },
            { "cache-control": "no-store" });
          return;
        }
        // 添加面板 key：秘钥入凭据服务，清单追加（name = 备注，可为空）。
        if (body.value.action === "add" && typeof body.value.apiKey === "string" && body.value.apiKey.trim() !== "") {
          const apiKey = body.value.apiKey.trim();
          // 同值查重（2026-10-29「删一次后又冒出未入池行」定案）：池与面板都按值
          // 去重、先到先得，同值新条目会成为看不见、不轮转的僵尸——删掉正身才
          // 浮出来（相位恒「未入池」）。入池前直接拒；文案报脱敏名（与面板行首
          // 显示的 maskKey 文字一致，扫一眼就能对上行），不报行上没有的 id。
          const holder = await poolAdmin.findKeyHolder(apiKey);
          if (holder !== null) {
            writeJson(response, 200, {
              ok: false,
              error: `这把 key 已在池里（${maskKey(apiKey)}）`
            }, { "cache-control": "no-store" });
            return;
          }
          const record = await poolAdmin.store.read();
          const usedNumbers = record.keys
            .map((entry) => Number(/^key-(\d+)$/.exec(entry.id)?.[1] ?? 0))
            .filter((n) => n > 0);
          const next = Math.max(...usedNumbers, 0) + 1;
          const id = `key-${next}`;
          // name 字段现在是「备注」（面板填的）；缺省/空白 = 无备注。
          const note = typeof body.value.name === "string" ? body.value.name.trim() : "";
          await poolAdmin.addKeySecret(id, apiKey);
          // 新 key 默认启用：restore 把复用的 id 从停用/删除名单一并摘掉
          // （编号复用会让曾删除的 key-<n> 新增后默认显示「已删除」——2026-10-25）。
          await poolAdmin.store.setKeys([...record.keys, { id, name: note }]);
          await poolAdmin.store.restore(id);
          await poolAdmin.refresh();
          // 新 key 立即重种入池：池每进程只首种一次，不重种则 statusById 不认识
          // 新 id（行永远「未入池」）、请求轮换也永远选不中它（2026-10-27）。
          // 失败不推翻本次保存：key 与清单都已落盘，日志留痕，下一次改动会再试。
          await poolAdmin.refreshKeys()
            .catch((error: unknown) => logger?.warn?.(`${name}: pool reseed failed after key add`, error));
          writeJson(response, 200, { ok: true, id, name: note }, { "cache-control": "no-store" });
          return;
        }
        // 改备注（原「重命名」语义保留为 update：整行 name 覆盖；备注可为空）。
        if (body.value.action === "rename" && typeof body.value.id === "string" && body.value.id !== "") {
          const note = typeof body.value.name === "string" ? body.value.name.trim() : "";
          {
            const record = await poolAdmin.store.read();
            await poolAdmin.store.setKeys(record.keys.map((entry) =>
              entry.id === body.value.id ? { ...entry, name: note } : entry));
          }
          await poolAdmin.refresh();
          writeJson(response, 200, { ok: true }, { "cache-control": "no-store" });
          return;
        }
        const action = body.value.action;
        const id = body.value.id;
        if (action !== "disable" && action !== "restore" && action !== "delete") {
          writeJson(response, 400, { ok: false, error: "action must be add | rename | disable | restore | delete" },
            { "cache-control": "no-store" });
          return;
        }
        if (typeof id !== "string" || id === "") {
          writeJson(response, 400, { ok: false, error: "expected { id: string }" }, { "cache-control": "no-store" });
          return;
        }
        // 删除 key-<n>：凭据记录与清单条目一起消失（不留 deleted 残行——
        // 那是给 cordis.patch.yml 里配置的账号用的：配置还在，只能标已删除）。
        if (action === "delete" && id !== "default") {
          await poolAdmin.removeKeySecret(id);
          const record = await poolAdmin.store.read();
          await poolAdmin.store.setKeys(record.keys.filter((entry) => entry.id !== id));
        }
        if (action === "disable") await poolAdmin.store.disable(id);
        else if (action === "restore") await poolAdmin.store.restore(id);
        else if (action === "delete") await poolAdmin.store.delete(id);
        await poolAdmin.apply(action, id);
        await poolAdmin.refresh();
        // 删除/恢复后同步重解析池（与 add 同一条纪律）：不重解析则该 id 滞留
        // idToKey，statusById（快照相位的来源）继续按旧映射报它的相位。恢复更
        // 甚：上次种池时该 id 还在停用名单里被排除的话 idToKey 根本不认识它，
        // restoreById 静默 no-op（返回 false 无人读），面板永远「未入池」
        // （2026-10-31 真机：运行中恢复仍显示未入池）。失败不推翻本次动作，
        // 日志留痕，下一次改动会再试。
        if (action === "delete" || action === "restore") {
          await poolAdmin.refreshKeys()
            .catch((error: unknown) => logger?.warn?.(`${name}: pool reseed failed after key ${action}`, error));
        }
        writeJson(response, 200, { ok: true }, { "cache-control": "no-store" });
      } catch (error) {
        writeJson(response, 200, { ok: false, error: redactedError(error) }, { "cache-control": "no-store" });
      }
    }, settings.allowedHosts)
  });
}
