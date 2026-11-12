/**
 * 每 API key 的并发闸（host 侧，无依赖）。
 *
 * SenseNova 渠道对 API key 存在并发限制，瞬时并发超限会触发 429。本模块在
 * provider 侧把同一 key 的并发生成请求压到配置上限内：达到上限的新请求排队
 * 等待（FIFO），前序请求释放额度后按序开始，而不是立即失败。429 语义不变，
 * 仍由宿主重试层退避后原 key 重试，此闸只是从源头抑制并发超限。
 *
 * 队列与在途计数均以 key 为键；key 条目在排空后惰性删除。排队等待受
 * `queueTimeoutMs`（默认 150s，沿革见常量注：09-04 定 60s、11-02 提到 90s、
 * 11-13 随建连分档提到 150s）约束：超时以可重试 TimeoutError
 * reject 且不占额度，交宿主重试层退避后重试。本模块刻意不依赖 cordis，
 * node 测试可直接驱动。建连/首包预算的分档判定（connectTimeoutFor）同为
 * 请求路径的时间预算，也住这里。
 *
 * @module dsh-sensenova-suite/concurrency
 */

export type Release = () => void;

/**
 * 排队超时默认值（毫秒）。
 *
 * 2026-09-04 定 60s（与 TPM 60s 窗口对齐，design D4/D6）；2026-11-02 提到 90s：
 * 4 轮轮询把「等待」搬进了插件内，一次全 429 的 stream() 全程占全局槽约
 * 30-50s（16 次 RTT + 10s 抖动等待）。globalConcurrency=2 时两个会话同时
 * 全 429，第 3 个排队者的等待会逼近 60s；90s 留出余量，避免排队者因别人的
 * 限流重试而超时失败。
 * 2026-11-13 提到 150s：建连/首包档分档化后，大包预算 120s 超过旧 90s——挂死
 * 的占槽者还没被建连闸放出来，排队的先被本闸判死（占槽的没死排队的先死）。
 * 150s 恢复「排队预算 > 单次占槽」的顺序（120s + 调度余量）。
 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 150_000;

/**
 * 建连/首包预算分档（毫秒）——freeapi 底座 2026-09-04 定 45s 单档（实测传输
 * 挂起 ≈1/5 且无 RST），2026-11-13 分档化：
 *
 *   - 小包（< {@link CONNECT_TIER_BODY_BYTES}）→ 60s：挂起几乎必是死连接，
 *     快砍保槽位卫生（per-key=1，挂死的连接占的是整把 key）；
 *   - 大包 → 120s：响应头时间 ≈ 上行 + 服务器预处理，都正比于包大小（请求体
 *     是纯文本 JSON——图片走宿主附件引用不进请求体），45s 对老会话长历史是
 *     冤枉砍（真机反馈 45000ms 报错的直接成因）。
 *
 * 恰等阈值归大档（≥ 语义，钉在 connectTimeoutFor）。
 */
export const CONNECT_TIMEOUT_MS = 60_000;
export const CONNECT_TIMEOUT_BIG_MS = 120_000;
export const CONNECT_TIER_BODY_BYTES = 256 * 1024;

/** 建连/首包预算按请求体字节分档（纯函数，peer-free 直钉）。 */
export function connectTimeoutFor(bodyBytes: number): number {
  return bodyBytes >= CONNECT_TIER_BODY_BYTES ? CONNECT_TIMEOUT_BIG_MS : CONNECT_TIMEOUT_MS;
}

/** 把配置的并发上限归一化为正整数：非整数、负数或无法解析一律回退 1。 */
export function normalizeConcurrencyLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

/** 排队/等待期间中止时抛出的取消错误（不占额度）。 */
export function concurrencyAbortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** 排队超时抛出的超时错误（不占额度；adapter 层映射为可重试 LlmError 'TIMEOUT'）。 */
export function concurrencyQueueTimeoutError(): Error {
  return new DOMException('The operation was timed out.', 'TimeoutError');
}

interface QueueEntry {
  signal: AbortSignal | undefined;
  resolve: () => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

interface KeyState {
  inFlight: number;
  queue: QueueEntry[];
}

/**
 * 按 key 隔离的并发闸：`acquire(key, limit, signal?, queueTimeoutMs?)` 在额度
 * 允许时立即返回 `release()`；达到上限时按 FIFO 排队，前序释放后唤起队首。
 * 排队期间 signal 中止则 reject 取消错误且不占额度；排队超过 `queueTimeoutMs`
 * （非法值回退默认 90s，2026-11-02 定版）则以可重试 TimeoutError reject，同样不占额度、从队列
 * 移除并清 abort listener。release 幂等，排空后惰性删除 key 条目。
 */
export class KeyedConcurrencyGate {
  private readonly states = new Map<string, KeyState>();

  acquire(key: string, limit: unknown, signal?: AbortSignal, queueTimeoutMs?: number): Promise<Release> {
    const capacity = normalizeConcurrencyLimit(limit);
    const timeoutMs = typeof queueTimeoutMs === 'number' && Number.isFinite(queueTimeoutMs) && queueTimeoutMs > 0
      ? queueTimeoutMs
      : DEFAULT_QUEUE_TIMEOUT_MS;
    if (signal?.aborted) return Promise.reject(concurrencyAbortError());
    let state = this.states.get(key);
    if (state === undefined) {
      state = { inFlight: 0, queue: [] };
      this.states.set(key, state);
    }
    if (state.inFlight < capacity) {
      state.inFlight += 1;
      return Promise.resolve(this.releaseOf(key, state));
    }
    return new Promise<Release>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: QueueEntry = {
        signal,
        resolve: () => {
          if (timer !== undefined) clearTimeout(timer);
          if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort);
          state.inFlight += 1;
          resolve(this.releaseOf(key, state));
        },
        reject: (error) => {
          if (timer !== undefined) clearTimeout(timer);
          if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort);
          reject(error);
        },
        onAbort: () => {
          if (timer !== undefined) clearTimeout(timer);
          const index = state.queue.indexOf(entry);
          if (index >= 0) state.queue.splice(index, 1);
          reject(concurrencyAbortError());
        },
      };
      // 排队超时（不占额度）：从队列移除、清 abort listener 后以 TimeoutError reject；
      // 消息在 adapter 层包装为可重试 LlmError 'TIMEOUT'（design D4 三段超时统一该码）。
      const onTimeout = () => {
        const index = state.queue.indexOf(entry);
        if (index >= 0) state.queue.splice(index, 1);
        if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort);
        reject(concurrencyQueueTimeoutError());
      };
      state.queue.push(entry);
      timer = setTimeout(onTimeout, timeoutMs);
      if (signal !== undefined) {
        if (signal.aborted) entry.onAbort();
        else signal.addEventListener('abort', entry.onAbort, { once: true });
      }
    });
  }

  private releaseOf(key: string, state: KeyState): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.inFlight -= 1;
      const next = state.queue.shift();
      if (next !== undefined) {
        next.resolve();
      } else if (state.inFlight === 0) {
        this.states.delete(key);
      }
    };
  }
}