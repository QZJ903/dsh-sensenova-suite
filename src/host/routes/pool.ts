/**
 * Key 池管理路由：停用 / 恢复 / 删除账号、调全局并发数。
 *
 * GET  返回管理面清单（按账号 id；key 不出——面板只需要 id 与相位）；
 * POST { action, id } 执行单账号操作，{ globalConcurrency } 调整并发。
 *
 * "删除"面板默认 key 时会连带 forget 凭据引用（apiKeyStore 的既有语义）；
 * accounts 里的账号删除只记入 deletedIds（配置重加同名 id 后需再恢复）。
 *
 * @module dsh-sensenova-suite/routes/pool
 */
import { name } from "../host-config.ts";
import { writeJson, refuseMethod, readJsonBodyOr400, withOrigin, redactedError } from "./http.ts";
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
  /** 账号清单（全量、未过滤）+ 标签；顺序即池序。 */
  accounts(): Promise<Array<{ id: string; label: string | null }>>;
  /** 单账号相位（面板停用/删除的账号读作 absent）。 */
  phaseOf(id: string): "running" | "blocked" | "absent";
  /** 执行停用/恢复/删除的池侧动作。 */
  apply(action: "disable" | "restore" | "delete", id: string): Promise<void>;
  /** 面板默认 key 的 forget（删除 default 时调用；无面板 key 时 no-op）。 */
  forgetPanelKey: () => Promise<void>;
  /** 把一把新 key 存入凭据服务（ref 由实现分配，返回稳这篇档的 id）。 */
  addKeySecret: (id: string, apiKey: string) => Promise<void>;
  /** 移除一把 key 的凭据记录（删除 key-<n> 时调用）。 */
  removeKeySecret: (id: string) => Promise<void>;
  /** 生效中的全局并发数（面板保存值 ?? 配置 ?? key 数）。 */
  effectiveConcurrency: () => Promise<number>;
  /** 面板默认 key 是否存在（编号占位 1）。 */
  hasPanelKey: () => Promise<boolean>;
  /** 状态文件刷新（写后让 params 的本地记录跟上）。 */
  refresh: () => Promise<void>;
}

/**
 * Register the pool management route.
 * @param ctx - the host root context (only `ctx.webServer` is used here).
 * @param wiring - `settings`（信任围栏）与 `poolAdmin`。
 */
export function registerPoolRoute(ctx: any, wiring: Pick<Wiring, "settings"> & { poolAdmin?: PoolAdmin }) {
  const { settings, poolAdmin } = wiring;
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
          const record = await poolAdmin.store.read();
          // 管理面列的是「配置了什么」（store 清单 + 面板默认 key），不是
          // 「凭据解析成功了什么」——解析失败时列表不能变空，否则加过的 key
          // 在面板上消失（2026-10-24 事故）。
          const keys = [];
          if (await poolAdmin.hasPanelKey()) {
            keys.push({
              id: "default",
              label: "Key1",
              phase: poolAdmin.phaseOf("default"),
              disabled: record.disabledIds.includes("default"),
              deleted: record.deletedIds.includes("default")
            });
          }
          for (const entry of record.keys) {
            // name 字段现在是「备注」。存量数据里旧的默认名（Key1/Key2…）
            // 不算备注：匹配 ^Key\d+$ 的旧默认名显示为空备注。
            const isLegacyDefault = /^Key\d+$/.test(entry.name);
            keys.push({
              id: entry.id,
              label: isLegacyDefault ? "" : entry.name,
              phase: poolAdmin.phaseOf(entry.id),
              disabled: record.disabledIds.includes(entry.id),
              deleted: record.deletedIds.includes(entry.id)
            });
          }
          writeJson(response, 200, {
            ok: true,
            keys,
            globalConcurrency: await poolAdmin.effectiveConcurrency(),
            concurrencyFromPanel: record.globalConcurrency
          }, { "cache-control": "no-store" });
          return;
        }
        const body = await readJsonBodyOr400(request, response);
        if (body === null) return;
        // 多模态分区保存：{ section, values }（部分键合并）。
        if (typeof body.value.section === "string"
          && ["toolsEnabled", "text2img", "img2img", "vision", "thinking"].includes(body.value.section)
          && typeof body.value.values === "object" && body.value.values !== null) {
          await poolAdmin.store.setSection(
            body.value.section as "toolsEnabled" | "text2img" | "img2img" | "vision" | "thinking",
            body.value.values as Record<string, unknown>
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
          const record = await poolAdmin.store.read();
          // 编号把面板默认 key 计为 1（有 default 时从 2 起）。
          const usedNumbers = record.keys
            .map((entry) => Number(/^key-(\d+)$/.exec(entry.id)?.[1] ?? 0))
            .filter((n) => n > 0);
          usedNumbers.push((await poolAdmin.hasPanelKey()) ? 1 : 0);
          const next = Math.max(...usedNumbers, 0) + 1;
          const id = `key-${next}`;
          // name 字段现在是「备注」（面板填的）；缺省/空白 = 无备注。
          const note = typeof body.value.name === "string" ? body.value.name.trim() : "";
          await poolAdmin.addKeySecret(id, body.value.apiKey.trim());
          // 新 key 默认启用：restore 把复用的 id 从停用/删除名单一并摘掉
          // （编号复用会让曾删除的 key-<n> 新增后默认显示「已删除」——2026-10-25）。
          await poolAdmin.store.setKeys([...record.keys, { id, name: note }]);
          await poolAdmin.store.restore(id);
          await poolAdmin.refresh();
          writeJson(response, 200, { ok: true, id, name: note }, { "cache-control": "no-store" });
          return;
        }
        // 改备注（原「重命名」语义保留为 update：整行 name 覆盖；备注可为空）。
        if (body.value.action === "rename" && typeof body.value.id === "string" && body.value.id !== "") {
          const note = typeof body.value.name === "string" ? body.value.name.trim() : "";
          const record = await poolAdmin.store.read();
          await poolAdmin.store.setKeys(record.keys.map((entry) =>
            entry.id === body.value.id ? { ...entry, name: note } : entry));
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
        if (action === "delete" && id === "default") await poolAdmin.forgetPanelKey();
        await poolAdmin.refresh();
        writeJson(response, 200, { ok: true }, { "cache-control": "no-store" });
      } catch (error) {
        writeJson(response, 200, { ok: false, error: redactedError(error) }, { "cache-control": "no-store" });
      }
    }, settings.allowedHosts)
  });
}
