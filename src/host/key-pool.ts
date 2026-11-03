/**
 * SenseNova key 池：运行态 / 阻塞态双列表状态机。
 *
 * 背景（2026-09-27 重构）：旧的「全池饱和短路 + per-session 隐式计数器」在持续限流下会
 * 构成正反馈死锁 —— 计数只在 2xx 时清零，而短路导致零成功，于是计数永不清零、短路永不
 * 解除，只能重启进程。本模块用显式两态列表替代它：
 *
 *   - **运行态**：可被 agent 请求选中；连续 `kickThreshold` 次 tpm 类限流后被移出。
 *   - **阻塞态**：等待恢复；驻留满 `BLOCKED_RESIDENCY_MS`（10min）由时间门放回运行态
 *     （**考验状态**：strike 预置为阈值-1，下一次 tpm 429 立即回笼），或被借用后
 *     拿到 2xx 立即转正。
 *
 * 三条不可让步的性质（与旧机制的区别全在这里）：
 *
 *   1. **保底**：运行态只剩 1 把时永不踢出 ⇒ 池不会因踢出而空，agent 请求永远发得出去。
 *   2. **借用**：运行态候选被 `exclude` 排空时，从阻塞态取「阻塞最久」的一把临时使用
 *      （**不改变其相位**），使一轮内仍能试满 `accountCount` 把。
 *   3. **恢复判定只用真信号**：时间门放出的 key 由**轮换流量自己检验**（下一次
 *      真实请求的 429/2xx），没有 /models 这类恒真旁路信号——2026-11-03 批 D
 *      （他拍板）：/models 探测对 tpm/耗尽恒 200，假阳性「放进去就出来」循环且
 *      令 probeAttempts 退避机制死码，整个探测面拆除。借用+2xx 转正通道原样保留
 *      （「成功是池已恢复的最强证据」）。
 *
 * 纯模块：不 import cordis、不碰网络与磁盘，时钟可注入以便单测。
 *
 * @module dsh-sensenova-suite/key-pool
 */

/** 一把 key 在池内的相位。 */
export type KeyPhase = 'running' | 'blocked'

/** 池策略参数（来自设置页 `poolPolicy`）。 */
export interface KeyPoolParams {
  /** 连续多少次 tpm 类限流后踢出运行态（默认 2）。 */
  kickThreshold: number
  /** 池容量上限（2026-10-29 放开：999 ≈ 实际不限。上游 freeapi 默认 10，出自作者
   * 实测 2 账号×5 把；超出的 key 仍被忽略——防呆上界保留，代码路径零漂移）。 */
  capacity: number
}

/** 池策略缺省值。kickThreshold 原为 2、运行时恒被 orchestrator 层默认（3）
 * 遮蔽（index.ts 展开传入、poolDeps 转发）——2026-10-31 对齐到 3 消灭双值分叉，
 * 同形钉在 pool.test（U1 审计复核补记 §四）。probe 三参数随探测面拆除（2026-11-03
 * 批 D），旧配置残留字段由归一化自然丢弃。 */
export const DEFAULT_KEY_POOL_PARAMS: Readonly<KeyPoolParams> = Object.freeze({
  kickThreshold: 3,
  capacity: 999,
})

/**
 * 阻塞态最短驻留（毫秒）：tpm 踢出后至少等待该时长才由时间门放回轮换（考验状态）。
 * 定标：EndpointTPM 单次实测 10 分钟（窗口上限无权威数据），10min 覆盖一个窗口
 * 周期+余量；窗口已滚的 key 放出来自然 2xx 转正，没滚的 1 次 tpm 429 立即回笼。
 * 2026-11-03 批 D（他拍板）。
 */
export const BLOCKED_RESIDENCY_MS = 10 * 60_000;

/** 池内一把 key 的运行状态。 */
export interface KeyPoolEntry {
  /** key 原文（仅存内存；日志只写 sha256 指纹）。 */
  readonly key: string
  /** 当前相位。 */
  phase: KeyPhase
  /** 连续 tpm 类命中数（成功时清零；时间门放出时预置为阈值-1 = 考验状态）。 */
  tpmStrikes: number
  /** 进入阻塞态的时刻（epoch ms）；处于运行态时为 0。「阻塞最久」的判据 + 时间门计时。 */
  blockedSince: number
}

/** 只读快照，供设置页只读面板展示。 */
export interface KeyPoolSnapshot {
  readonly running: readonly string[]
  readonly blocked: readonly {
    readonly key: string
    readonly blockedSince: number
  }[]
}

/** 构造依赖。 */
export interface SensenovaKeyPoolDeps {
  /** 每操作读取一次策略（支持设置页热改）。 */
  params: () => KeyPoolParams
  /** 可注入时钟（测试用）；缺省 `Date.now`。 */
  now?: () => number
}

/**
 * 运行态 / 阻塞态双列表 key 池。
 *
 * 实例应当是**池级单例**（由 `index.ts` 的 `apply()` 创建一次并注入适配器），
 * 因此其状态对所有会话共享 —— key 的配额本来就是全局属性。
 */
export class SensenovaKeyPool {
  private readonly running: KeyPoolEntry[] = []
  private readonly blocked: KeyPoolEntry[] = []
  private readonly index = new Map<string, KeyPoolEntry>()
  /** 上次选中的 key，作为环回起点（比维护数组下标更耐增删）。 */
  private lastPicked: string | undefined
  private readonly opts: SensenovaKeyPoolDeps

  constructor(deps: SensenovaKeyPoolDeps) {
    this.opts = deps
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private params(): KeyPoolParams {
    return this.opts.params()
  }

  /** 池内被追踪的 key 总数（运行态 + 阻塞态）。 */
  get size(): number {
    return this.index.size
  }

  /** 该 key 是否处于运行态。不在池内或已阻塞都返回 false。 */
  isRunning(key: string): boolean {
    return this.index.get(key)?.phase === 'running'
  }

  /** 阻塞态条目（顺序 = 进入阻塞态的顺序）。 */
  blockedEntries(): readonly KeyPoolEntry[] {
    return this.blocked
  }

  /**
   * 把当前解析出的全部 key 灌入池。
   *
   * **幂等**：已存在的 key 保持其相位与计数（不重置），只有新 key 追加到运行态末尾。
   * 超过 `capacity` 的部分被忽略。
   *
   * @param keys - 按配置顺序解析出的 key（调用方已按 key 去重）。
   * @returns 因容量被丢弃的 key 数量（0 = 未截断），供调用方决定是否 warning。
   */
  seed(keys: readonly string[]): number {
    const capacity = Math.max(1, Math.floor(this.params().capacity))
    let dropped = 0
    for (const key of keys) {
      if (key === '') continue
      if (this.index.has(key)) continue
      if (this.index.size >= capacity) {
        dropped += 1
        continue
      }
      const entry: KeyPoolEntry = {
        key,
        phase: 'running',
        tpmStrikes: 0,
        blockedSince: 0,
      }
      this.running.push(entry)
      this.index.set(key, entry)
    }
    return dropped
  }

  /**
   * 选本次请求的起始 key。
   *
   * 顺序：会话粘性 `preferred`（**必须在运行态**，否则忽略）→ 运行态首项 →
   * （运行态为空的兜底）阻塞最久的一把。
   *
   * ⚠️ 粘性 key 若已被踢出或被 401 移除，这里会自动落到运行态的正确一把 ——
   * 这是旧实现起始处 `stickyKey ?? resolveApiKey` 留下的死锁残留的修复点。
   */
  pickStart(preferred?: string): string | undefined {
    if (this.running.length === 0) {
      const borrowed = this.oldestBlocked(EMPTY_EXCLUDE)
      if (borrowed !== undefined) this.lastPicked = borrowed.key
      return borrowed?.key
    }
    const first = this.running[0]
    if (first === undefined) return undefined
    const chosen = preferred !== undefined && this.isRunning(preferred) ? preferred : first.key
    this.lastPicked = chosen
    return chosen
  }

  /**
   * 轮换到下一把 key。
   *
   * 从 `lastPicked` 的下一个位置在运行态里**环回**查找第一个不在 `exclude` 的 key；
   * 运行态候选全部被排除时，**借用**阻塞态中 `blockedSince` 最小（阻塞最久）且不在
   * `exclude` 的一把 —— 借用**不改变其相位**，仅本次使用。
   *
   * @param exclude - 本轮已试过的 key（适配器的 `tried` 集合）。
   * @param options.borrow - 扫描耗尽是否借阻塞态 key。默认 true=保底借用（池空
   *   /单 key 场景，pickStart 语义不变）；轮内换 key 传 false——阻塞 key 只按
   *   10min 时间门回运行态，不进轮询（2026-11-04 他拍板：tried 下推为池的选择
   *   条件，轮长=未试运行态数；借用若随轮耗尽例行触发，会破坏批 D 的驻留设计）。
   * @returns 下一把 key；池内已无可试者返回 undefined（调用方据此结束本轮）。
   */
  pickNext(exclude: ReadonlySet<string>, options?: { borrow?: boolean }): string | undefined {
    const count = this.running.length
    if (count > 0) {
      const anchor = this.lastPicked === undefined
        ? -1
        : this.running.findIndex(entry => entry.key === this.lastPicked)
      for (let step = 1; step <= count; step += 1) {
        const entry = this.running[(anchor + step + count) % count]
        if (entry === undefined || exclude.has(entry.key)) continue
        this.lastPicked = entry.key
        return entry.key
      }
    }
    if (options?.borrow === false) return undefined
    const borrowed = this.oldestBlocked(exclude)
    if (borrowed !== undefined) this.lastPicked = borrowed.key
    return borrowed?.key
  }

  /**
   * 记一次 tpm 类限流。
   *
   * - **运行态**：计数 +1；达到 `kickThreshold` 且**运行态多于 1 把**时移入阻塞态。
   * - **阻塞态**：**不计 strikes**（相位只由时间门与成功信号决定）。
   * - **不在池内**：忽略。
   *
   * @returns `kicked` = 本次是否发生「运行态 → 阻塞态」迁移；`strikes` = 当前计数。
   */
  recordTpmStrike(key: string): { kicked: boolean; strikes: number } {
    const entry = this.index.get(key)
    if (entry === undefined) return { kicked: false, strikes: 0 }
    if (entry.phase === 'blocked') {
      return { kicked: false, strikes: entry.tpmStrikes }
    }
    entry.tpmStrikes += 1
    const threshold = Math.max(1, Math.floor(this.params().kickThreshold))
    if (entry.tpmStrikes < threshold) return { kicked: false, strikes: entry.tpmStrikes }
    // 🔑 保底：运行态只剩这一把时不踢 —— 池不会因踢出而空。
    if (this.running.length <= 1) return { kicked: false, strikes: entry.tpmStrikes }
    this.moveToBlocked(entry)
    return { kicked: true, strikes: entry.tpmStrikes }
  }

  /**
   * 记一次成功（agent 请求拿到 2xx）。
   *
   * 计数清零；若该 key 正处于阻塞态（被借用后成功）⇒ 立即挂回运行态末尾 ——
   * 「成功是池已恢复的最强证据」的落点。
   */
  onSuccess(key: string): void {
    const entry = this.index.get(key)
    if (entry === undefined) return
    entry.tpmStrikes = 0
    if (entry.phase !== 'blocked') return
    this.moveToRunning(entry)
  }

  /**
   * 时间门（2026-11-03 批 D，他拍板）：把阻塞驻留满 `BLOCKED_RESIDENCY_MS` 的 key
   * 放回运行态，**以考验状态返回**（strike 预置为阈值-1——下一次 tpm 429 立即回笼；
   * 2xx 成功清零即正常留在轮换面）。取代旧 /models 探测：不发起任何网络请求，
   * 恢复检验由轮换流量的真实 429/2xx 完成（/models 对 tpm/耗尽恒 200，假阳性
   * 「放进去就出来」循环且令退避机制死码——探测面整体拆除的依据）。
   *
   * @returns 本次放出的 key 列表（调用方打日志）。
   */
  releaseDueBlocked(): string[] {
    const due: KeyPoolEntry[] = []
    for (const entry of this.blocked) {
      if (this.now() - entry.blockedSince < BLOCKED_RESIDENCY_MS) continue
      due.push(entry)
    }
    const threshold = Math.max(1, Math.floor(this.params().kickThreshold))
    for (const entry of due) {
      this.moveToRunning(entry)
      // 考验状态：差 1 次即回笼。2xx 成功会清零并退出考验。
      entry.tpmStrikes = threshold - 1
    }
    return due.map(entry => entry.key)
  }

  /** 401 永久禁用：把该 key 从池中彻底移除。 */
  remove(key: string): void {
    const entry = this.index.get(key)
    if (entry === undefined) return
    this.detach(entry)
    this.index.delete(key)
    if (this.lastPicked === key) this.lastPicked = undefined
  }

  /** 只读快照（设置页诊断面板用）。 */
  snapshot(): KeyPoolSnapshot {
    return {
      running: this.running.map(entry => entry.key),
      blocked: this.blocked.map(entry => ({
        key: entry.key,
        blockedSince: entry.blockedSince,
      })),
    }
  }

  /** 阻塞态中 `blockedSince` 最小且不在 `exclude` 的一把（即「阻塞最久」）。 */
  private oldestBlocked(exclude: ReadonlySet<string>): KeyPoolEntry | undefined {
    let oldest: KeyPoolEntry | undefined
    for (const entry of this.blocked) {
      if (exclude.has(entry.key)) continue
      if (oldest === undefined || entry.blockedSince < oldest.blockedSince) oldest = entry
    }
    return oldest
  }

  private moveToBlocked(entry: KeyPoolEntry): void {
    this.detach(entry)
    entry.phase = 'blocked'
    entry.blockedSince = this.now()
    this.blocked.push(entry)
  }

  private moveToRunning(entry: KeyPoolEntry): void {
    this.detach(entry)
    entry.phase = 'running'
    entry.blockedSince = 0
    this.running.push(entry)
  }

  /** 从当前所属列表摘除（不改变相位字段，供上层决定挂到哪里）。 */
  private detach(entry: KeyPoolEntry): void {
    const from = entry.phase === 'running' ? this.running : this.blocked
    const index = from.indexOf(entry)
    if (index >= 0) from.splice(index, 1)
  }
}

/** 复用的空集合，避免 `pickStart` 每次分配。 */
const EMPTY_EXCLUDE: ReadonlySet<string> = new Set<string>()
