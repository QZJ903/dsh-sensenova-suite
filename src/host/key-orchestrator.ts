/**
 * 池编排层 —— 把 KeyPool（双列表状态机）包成
 * 「选 key → 上报结果 → 探测恢复」的完整循环，并加上 suite 特有的四件事：
 *
 *   1. **按积分组的路由模式**（§5.4）：商汤组（sensenova-*）走会话粘性（RPM 不低，
 *      粘性省积分）；通用组走裸轮转（RPM 极低，均分吞吐优先）。同一张亲和表，
 *      两种组策略。
 *   2. **全局在途上限**（§5.3）：per-key 固定 1 由适配器的每 key 闸负责；这里管
 *      用户配置的全局并发数（默认 = key 数），排队等待而非报错。
 *   3. **(key, 组) 的 pool-429 格子**（§5.2）：池类 429 不踢 key（积分池滚动窗口
 *      自愈），只按组标记；该组在所有 key 上都中招 → 本轮换 key 耗尽，快速失败。
 *   4. **探测调度**（§5.6）：到期探测由外部时钟驱动（index.ts 的 interval 调
 *      runDueProbes），探测与 agent 请求解耦——根治「只在 2xx 清零」的短路死锁。
 *
 * 纯模块：不 import cordis、不碰网络与磁盘（探测请求由 deps.probe 注入），
 * 时钟可注入以便单测。KeyPool 三不变量（保底/借用/探测解耦）由 freeapi 状态机
 * 原样保证，本层不重复实现。
 *
 * @module dsh-sensenova-suite/key-orchestrator
 */

import { SensenovaKeyPool, DEFAULT_KEY_POOL_PARAMS, type KeyPoolParams, type KeyPoolSnapshot } from "./key-pool.ts";
import { exhaustedModelIds } from "./llm-models.ts";

/** 裸轮转的空排除集（pickNext 的「从 lastPicked 环回推进」形态）。 */
const EMPTY_EXCLUDE: ReadonlySet<string> = new Set<string>();

/** 池编排参数（配置面可调部分；探测参数沿用 KeyPool 的 KeyPoolParams）。 */
export interface OrchestratorParams {
  /** 连续 rate 类 429 踢出阈值（tpm/rpm 不分；PLAN §5.6 定稿 = 3）。 */
  kickThreshold: number;
  /** KeyPool 容量。 */
  capacity: number;
  /** 探测参数三件套（初始/倍率/上限）。 */
  probeInitialMs: number;
  probeBackoffFactor: number;
  probeMaxMs: number;
  /** 会话亲和保持时长（仅商汤组使用；PLAN §5.4 = 300s）。 */
  affinityTtlMs: number;
  /** 亲和表 LRU 上限（常量级，不进配置面）。 */
  affinityMax: number;
  /** 全局在途上限（默认 = key 数，用户可调小=温和模式）。 */
  globalConcurrency: number;
  /** 模型 → 积分组映射（组名自由；未命中归 general）。 */
  modelGroups: Record<string, string>;
}

export const DEFAULT_ORCHESTRATOR_PARAMS: Readonly<OrchestratorParams> = Object.freeze({
  kickThreshold: 3,
  capacity: DEFAULT_KEY_POOL_PARAMS.capacity,
  probeInitialMs: DEFAULT_KEY_POOL_PARAMS.probeInitialMs,
  probeBackoffFactor: DEFAULT_KEY_POOL_PARAMS.probeBackoffFactor,
  probeMaxMs: DEFAULT_KEY_POOL_PARAMS.probeMaxMs,
  affinityTtlMs: 300_000,
  affinityMax: 512,
  globalConcurrency: 0, // 0 = 跟随 key 数（index.ts 归一化）
  // 与 host-config.ts CONFIG_DEFAULTS.modelGroups 同形（2026-10-31 对齐——旧表
  // 三模型→"sensenova" 是 0.1.18 改专属池前的化石）。运行时本默认不被消费
  // （index.ts 恒传 settings.modelGroups），只有测试与直接构造时生效；两处默认
  // 必须同步改，否则测试钉的形状和运行时形状再次分叉（问题 3 的教训）。
  modelGroups: { "sensenova-6.8-flash-lite": "flash-lite" },
});

/** pool-429 格子条目：命中时刻（TTL 自愈 + 探测成功清除）。 */
const GRID_TTL_MS = 30 * 60_000;

/** 一次选 key 的答案。 */
export interface PickedKey {
  key: string;
  /** 选 key 时用的积分组（探测/上报时回传）。 */
  group: string;
}

export interface OrchestratorDeps {
  /** 每操作读取一次参数（设置页热改）。 */
  params: () => OrchestratorParams;
  /** 解析全部账户（id + key）；空数组 = 无可用凭据。id 面板管理用（"default"=面板 key）。 */
  resolveKeys: () => Promise<Array<{ id: string; key: string }>>;
  /** 探测回调：返回是否成功（由 index.ts 注入 GET {apiBase}/models 的轻探测）。 */
  probe: (key: string) => Promise<boolean>;
  /** 可注入时钟（测试用）。 */
  now?: () => number;
  /** 日志（可缺省）。 */
  logger?: { warn?: (message: string) => void } | null;
}

interface AffinityEntry {
  key: string;
  at: number;
}

/** 简单 FIFO 等待队列（全局在途上限的排队侧）。 */
interface SlotWaiter {
  resolve: () => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class KeyOrchestrator {
  private readonly pool: SensenovaKeyPool;
  private readonly opts: OrchestratorDeps;
  private seeded = false;
  /** 账号 id → key（seed 时建立；面板管理按 id 定位）。 */
  private readonly idToKey = new Map<string, string>();
  private readonly affinity = new Map<string, AffinityEntry>();
  /** (key \u0000 group) → 命中时刻。 */
  private readonly poolGrid = new Map<string, number>();
  private inflight = 0;
  private readonly waiters: SlotWaiter[] = [];
  private resolvingKeys: Promise<void> | undefined;

  constructor(deps: OrchestratorDeps) {
    this.opts = deps;
    const poolDeps: import("./key-pool.ts").SensenovaKeyPoolDeps = {
      params: (): KeyPoolParams => {
        const p = this.params();
        return {
          kickThreshold: p.kickThreshold,
          probeInitialMs: p.probeInitialMs,
          probeBackoffFactor: p.probeBackoffFactor,
          probeMaxMs: p.probeMaxMs,
          capacity: p.capacity,
        };
      },
    };
    if (deps.now !== undefined) poolDeps.now = deps.now;
    this.pool = new SensenovaKeyPool(poolDeps);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private params(): OrchestratorParams {
    return this.opts.params();
  }

  /** 模型 → 积分组（未命中归 general）。 */
  groupOf(model: string | undefined): string {
    if (typeof model !== "string" || model === "") return "general";
    return this.params().modelGroups[model] ?? "general";
  }

  /**
   * 具名组（专属池）会话粘性；通用组裸轮转（PLAN §5.4）。
   * 判据是「组 ≠ general」而非组名清单（2026-10-31 用户拍板恢复粘性）：0.1.18
   * 分专属池把组名改成 "flash-lite" 时本判据漏改，亲和自那时起静默死路——清单式
   * 判据每加一组都要记得同步；集合式判据（general=轮转，具名=粘）不会再断。
   */
  private groupUsesAffinity(group: string): boolean {
    return group !== "general";
  }

  /** 确保池里至少 seed 过一次（凭据服务的懒解析在 resolveKeys 里）。 */
  private async ensureSeeded(): Promise<void> {
    if (!this.seeded) await this.resolveInto();
  }

  /** 面板改凭据后重解析（加 key / 换面板 key / 清面板 key；路由侧调用）。
   * 语义 = 重启后的首次 seed：新增 key 入池，值变了的旧 key 摘出，存量 key 的
   * 相位与计数原样保留（pool.seed 幂等，只追加新 key）。被 401 移除的 key 会
   * 随重启语义复活，下一次请求再次 401 再移除——与既有重启行为一致。 */
  async refreshKeys(): Promise<void> {
    await this.resolveInto();
  }

  /** 解析凭据并把结果同步进池（首种与重种共用一条路；并发调用合并为一次解析）。
   * 解析失败不置 seeded（失败绝不装成功），下次 pick/status/refreshKeys 会再试；
   * 失败时旧 idToKey 原样保留（新映射在本地建好再原子换入）。 */
  private async resolveInto(): Promise<void> {
    if (this.resolvingKeys !== undefined) return this.resolvingKeys;
    this.resolvingKeys = (async () => {
      try {
        const entries = await this.opts.resolveKeys();
        const next = new Map<string, string>();
        const keys: string[] = [];
        for (const entry of entries) {
          if (entry.key === "" || next.has(entry.id)) continue;
          next.set(entry.id, entry.key);
          keys.push(entry.key);
        }
        // 旧映射里值已不在新解析结果的 key 先摘出池：删除/停用路径通常已
        // remove 过，这里是「换面板 key」这类 id 不变值变号的唯一清理点。
        const nextKeys = new Set(next.values());
        for (const key of this.idToKey.values()) {
          if (!nextKeys.has(key)) this.pool.remove(key);
        }
        this.idToKey.clear();
        for (const [id, key] of next) this.idToKey.set(id, key);
        this.pool.seed(keys);
        this.seeded = true;
      } finally {
        this.resolvingKeys = undefined;
      }
    })();
    return this.resolvingKeys;
  }

  /** id → key（未知名返回 undefined）。 */
  keyOf(id: string): string | undefined {
    return this.idToKey.get(id);
  }

  /** 面板停用：把该账号的 key 从池里摘除（pool-store 已先记档）。 */
  disableById(id: string): boolean {
    const key = this.idToKey.get(id);
    if (key === undefined) return false;
    this.pool.remove(key);
    return true;
  }

  /** 面板恢复：把该账号的 key 重新种回池（若凭据仍可解析）。 */
  async restoreById(id: string): Promise<boolean> {
    const known = this.idToKey.get(id);
    if (known !== undefined && !this.pool.isRunning(known)) {
      // KeyPool 没有单键重种入口：remove 后再 seed 同值即回到运行态。
      this.pool.seed([known]);
    }
    return known !== undefined;
  }

  /** 面板删除：摘除池内 key（pool-store 的 deletedIds 负责不再回种）。 */
  deleteById(id: string): boolean {
    const key = this.idToKey.get(id);
    if (key === undefined) return false;
    this.pool.remove(key);
    return true;
  }

  /** 单 key 相位（面板管理用；不在池内 = absent）。 */
  phaseOf(key: string | undefined): "running" | "blocked" | "absent" {
    if (key === undefined) return "absent";
    const snap = this.pool.snapshot();
    if (snap.blocked.some((entry) => entry.key === key)) return "blocked";
    if (snap.running.includes(key)) return "running";
    return "absent";
  }

  /** 面板管理面快照：按账号 id 给相位（masked key 不出）。 */
  async statusById(): Promise<Array<{ id: string; phase: "running" | "blocked" | "absent" }>> {
    await this.ensureSeeded();
    const snap = this.pool.snapshot();
    const phaseOf = (key: string | undefined): "running" | "blocked" | "absent" => {
      if (key === undefined) return "absent";
      if (snap.blocked.some((entry) => entry.key === key)) return "blocked";
      if (snap.running.includes(key)) return "running";
      return "absent";
    };
    return [...this.idToKey.entries()].map(([id, key]) => ({ id, phase: phaseOf(key) }));
  }

  private gridMarked(key: string, group: string): boolean {
    const at = this.poolGrid.get(`${key}\u0000${group}`);
    if (at === undefined) return false;
    if (this.now() - at > GRID_TTL_MS) {
      this.poolGrid.delete(`${key}\u0000${group}`);
      return false;
    }
    return true;
  }

  /** 从亲和表取有效粘性（过期即删）。 */
  private affinityFor(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined || sessionId === "") return undefined;
    const entry = this.affinity.get(sessionId);
    if (entry === undefined) return undefined;
    const ttl = this.params().affinityTtlMs;
    if (this.now() - entry.at > ttl) {
      this.affinity.delete(sessionId);
      return undefined;
    }
    return entry.key;
  }

  private writeAffinity(sessionId: string | undefined, key: string): void {
    if (sessionId === undefined || sessionId === "") return;
    // LRU：超上限删最旧（Map 迭代序 = 插入序）。
    if (!this.affinity.has(sessionId) && this.affinity.size >= Math.max(1, this.params().affinityMax)) {
      const oldest = this.affinity.keys().next().value;
      if (oldest !== undefined) this.affinity.delete(oldest);
    }
    this.affinity.set(sessionId, { key, at: this.now() });
  }

  /** 全局在途槽：acquire（排队等待）；返回 release。 */
  async acquireSlot(signal?: AbortSignal): Promise<() => void> {
    const cap = () => {
      const configured = Math.floor(this.params().globalConcurrency);
      if (configured > 0) return configured;
      return Math.max(1, this.pool.size);
    };
    if (this.inflight < cap()) {
      this.inflight += 1;
      return () => this.releaseSlot();
    }
    return new Promise<() => void>((resolve) => {
      const waiter: SlotWaiter = {
        resolve: () => {
          this.inflight += 1;
          if (waiter.onAbort !== undefined && signal !== undefined) signal.removeEventListener("abort", waiter.onAbort);
          resolve(() => this.releaseSlot());
        },
      };
      if (signal !== undefined) waiter.signal = signal;
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          // 中止的等待者不占额度：resolve 一个空 release，让 await 返回后由调用方抛 AbortError。
          resolve(() => {});
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private releaseSlot(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    const next = this.waiters.shift();
    if (next !== undefined) next.resolve();
  }

  /**
   * 选起始 key（适配器 stream 的第一跳）。组内策略见 §5.4；亲和命中要求
   * key 在运行态且未被该组 pool 标记。无可用 key 抛 Error（MISSING_CREDENTIAL
   * 语义由适配器的 resolveApiKeyForRequest 调用方翻译）。
   *
   * `excludeStart`（2026-11-02，4 轮轮询用）：**裸轮转组**的起点排除——每轮
   * 起点必须与上一轮不同（避免总是固定账户优先）。实现=从该 key 的下一位环回，
   * 等价 pickNext(new Set([excludeStart]))。亲和组忽略此参（亲和 key 恒第一）。
   */
  async pickStart(request: { sessionId?: string | undefined; model: string; excludeStart?: string }): Promise<PickedKey> {
    await this.ensureSeeded();
    const group = this.groupOf(request.model);
    // 裸轮转组（general）：pickStart 不推进游标（总取运行态首项），轮转语义必须
    // 走 pickNext 的环回推进——这正是「会话间均分」的落点（PLAN §5.4）。
    // 亲和组（sensenova）：pickStart 优先粘性 key，未命中取首项起步。
    // excludeStart 只作用于裸轮转组：把上一轮起点排除，起点即推进到它的下一位。
    const affinityKey = this.groupUsesAffinity(group)
      ? this.affinityFor(request.sessionId)
      : undefined;
    const rotateStart = request.excludeStart !== undefined && !this.groupUsesAffinity(group)
      ? new Set<string>([request.excludeStart])
      : EMPTY_EXCLUDE;
    let candidate = affinityKey !== undefined || this.groupUsesAffinity(group)
      ? this.pool.pickStart(affinityKey)
      : this.pool.pickNext(rotateStart);
    if (candidate !== undefined && this.gridMarked(candidate, group)) {
      const exclude = new Set<string>([candidate]);
      candidate = this.pool.pickNext(exclude) ?? undefined;
      while (candidate !== undefined && this.gridMarked(candidate, group)) {
        exclude.add(candidate);
        const next = this.pool.pickNext(exclude);
        if (next === undefined) { candidate = undefined; break; }
        candidate = next;
      }
    }
    if (candidate === undefined || candidate === "") {
      throw new Error("no usable SenseNova API key in the pool (all dead, pool-marked, or unconfigured)");
    }
    if (this.groupUsesAffinity(group)) this.writeAffinity(request.sessionId, candidate);
    return { key: candidate, group };
  }

  /**
   * 换下一把 key（适配器 rotateApiKey 的池侧实现）。候选 = 非 dead、本请求未试过、
   * 未被该组 pool 标记；全池轮询耗尽（PLAN §5.5）返回 undefined。
   */
  async pickNext(exclude: ReadonlySet<string>, group: string): Promise<string | undefined> {
    await this.ensureSeeded();
    let candidate = this.pool.pickNext(exclude);
    while (candidate !== undefined && this.gridMarked(candidate, group)) {
      const wider = new Set(exclude);
      wider.add(candidate);
      candidate = this.pool.pickNext(wider);
    }
    return candidate;
  }

  /**
   * 上报一次请求结局（适配器在成功/401/429 各路径回调）。
   * - success：清计数；借用成功自动挂回运行态（KeyPool.onSuccess）。
   * - auth(401)：永久移除（KeyPool.remove）。
   * - rate（tpm/rpm 不分）：连续计数 +1，达阈值踢阻塞态（KeyPool.recordTpmStrike）。
   * - pool：记 (key, 组) 格子；不踢不冷却。
   */
  reportSuccess(key: string): void {
    this.pool.onSuccess(key);
  }

  reportAuthRejected(key: string): void {
    this.pool.remove(key);
  }

  reportRateLimited(key: string): { kicked: boolean; strikes: number } {
    return this.pool.recordTpmStrike(key);
  }

  reportPoolExhausted(key: string, group: string): void {
    this.poolGrid.set(`${key}\u0000${group}`, this.now());
  }

  /** 清一格（reportQuotaPools 额度回正与探测成功清格共用同一份键拼接）。 */
  clearPoolCell(key: string, group: string): void {
    this.poolGrid.delete(`${key}\u0000${group}`);
  }

  /**
   * 额度驱动的池格写点（2026-10-31 建，接发布链 onQuotaPools 回调）。
   *
   * `pools` 是**一份控制台账号**的 token plan 池（每池 modelIds + window5h/7d
   * 剩余）；调用方负责 key 与该账号的归属关系（见 index.ts 接线注释的覆盖边界
   * ——归属不明时宁可不调用，错标 = 误伤健康 key，正是本机制要防的事）。
   * 判据与 llm-models.exhaustedModelIds 同源（直接复用它做模型级判定）：
   *   - 池耗尽 = (limit5>0 && rem5<=0) || (limit7>0 && rem7<=0)，limit 未知不算
   *     （形状漂移防线同款）；
   *   - 组内出现的模型全部耗尽 → 记格（沿用模型级并集教义：组内还有一个模型
   *     有余量就不标整组，避免重演「专属池 0 余量清空整个 picker」）；
   *   - 组内出现的模型全部有余量 → 清格（「额度刷新了」的判定；resetAt 可空，
   *     不作判据）；
   *   - 混合态不动，等下一拍或真实 429 校准。
   * 30min TTL 保留为兜底：轮询停摆时格子照旧自愈，不会标了永不清。
   */
  reportQuotaPools(key: string, pools: { pools?: unknown }): void {
    const list: unknown[] = Array.isArray(pools?.pools) ? pools.pools : [];
    const drainedModels = new Set(exhaustedModelIds({ pools: list }));
    const groups = new Map<string, string>();
    for (const pool of list) {
      const ids = Array.isArray((pool as { modelIds?: unknown } | undefined)?.modelIds)
        ? (pool as { modelIds?: unknown[] }).modelIds!
        : [];
      for (const id of ids) {
        if (typeof id !== "string" || id === "" || groups.has(id)) continue;
        groups.set(id, this.groupOf(id));
      }
    }
    const agg = new Map<string, { served: number; drained: number }>();
    for (const [id, group] of groups) {
      const row = agg.get(group) ?? { served: 0, drained: 0 };
      row.served += 1;
      if (drainedModels.has(id)) row.drained += 1;
      agg.set(group, row);
    }
    for (const [group, row] of agg) {
      if (row.drained === 0) this.clearPoolCell(key, group);
      else if (row.drained === row.served) this.reportPoolExhausted(key, group);
    }
  }

  /** 该组是否已全池标记（池类 429 轮完一圈后的快速失败判据）。 */
  groupFullyPoolMarked(group: string): boolean {
    const snapshot = this.pool.snapshot();
    const tracked = [...snapshot.running, ...snapshot.blocked.map((entry) => entry.key)];
    if (tracked.length === 0) return false;
    return tracked.every((key) => this.gridMarked(key, group));
  }

  /**
   * 探测一轮（外部 interval 驱动）：到期且未恢复的阻塞 key 逐个探测。
   * KeyPool 的相位只由探测结果决定（三不变量之三）。
   */
  async runDueProbes(): Promise<number> {
    await this.ensureSeeded();
    const snapshot = this.pool.snapshot();
    let probed = 0;
    for (const entry of snapshot.blocked) {
      if (!this.pool.probeDue(entry.key, this.now())) continue;
      probed += 1;
      let recovered = false;
      try {
        recovered = await this.opts.probe(entry.key);
      } catch {
        recovered = false;
      }
      if (recovered) {
        // 成功即挂回运行态并清该 key 的全部 pool 格子。
        this.pool.onSuccess(entry.key);
        for (const mark of [...this.poolGrid.keys()]) {
          if (mark.startsWith(`${entry.key} `)) this.poolGrid.delete(mark);
        }
      } else {
        this.pool.noteProbeFailed(entry.key);
      }
    }
    return probed;
  }

  /** 诊断快照（设置页/日志用）。 */
  snapshot(): KeyPoolSnapshot & { poolGrid: string[]; inflight: number } {
    return {
      ...this.pool.snapshot(),
      poolGrid: [...this.poolGrid.keys()],
      inflight: this.inflight,
    };
  }
}
