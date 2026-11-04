# 429 与失败处理教义（dsh-sensenova-suite）

本文说明套件对商汤限流（429）与请求失败的完整处置：**怎么分类、每类怎么办、参数是多少、为什么**。对应实现：`src/host/rate-classify.ts`（分类）、`key-pool.ts` + `key-orchestrator.ts`（池）、`adapter.ts`（请求编排）、`llm-retry.ts`（重试类别）。

> 适用范围：套件自有的 wire 适配器路径。DSH 内置 `llm-pi-ai` 供应商行的 `retryPolicy` 配置语义属于另一条路径，本套件不经过它——下文所有行为都由代码内常量决定，不需要（也没有）对应的用户配置键。插件面另有两条**不走本教义**的 429 通道：读图桥（`vision/bridge.ts`）与出图链（`image-tools.ts`）——两者的 429 一律「换 key 保服务、不打格不记账、不碰 strike」（2026-11-04 批 G/H 拍板）。

## 1. 商汤 429 的几种形态（实测）

官方错误表把 429 统一标为 `quota_exceeded_error`（"速率/额度超限，建议指数退避重试"），**不区分速率与额度**。实测分型必须看响应体里的 `error.code`，且不能看 message（措辞随版本漂移：同 code 8 出现过 `rps exhausted` 与 `inference exceeds tpm/rpm limit` 两种写法；429001 的 type 实测是 `invalid_request_error`，按 type 分类会漏）：

| 形态 | 响应体特征 | 物理含义 | 桶（strike 判据） | 恢复时间尺度 |
|---|---|---|---|---|
| 速率类 | `code: 8`（数字或字符串） | rps/rpm 速率桶打空；实测补充 ≈1 个/14s | rpm | 秒～分钟；**轮换不记 strike** |
| 速率类（软形态） | `code: 429003` | 观测多呈 rpm 形态且快速自愈；样本 `type:rate_limit_error` + `inference exceeds tpm/rpm limit`（与 429001 的 message 全同，内容区分不了） | rpm | 同上；**轮换不记 strike** |
| TPM 类 | `code: 429001` | 推理 token 每分钟窗口打满（大上下文一口吃掉大块） | tpm | 分钟级窗口老化 |
| 端点族 · TPM 形态 | `RateLimitExceeded.Endpoint*TPMExceeded` | 这把 key 的端点级 token 窗口打满（作用域是单 key） | **tpm** | 几分钟到几小时不等（实测 10 分钟+ 未恢复） |
| 端点族 · RPM 形态 | `RateLimitExceeded.Endpoint*RPMExceeded` | 同族请求数形态（窗口长度无实测数据，按桶语义归快） | **rpm** | 秒～分钟（推定，未实测） |
| 账号族 · TPM 形态 | `ModelAccount*Tpm*` | 这把 key 的账号级 token 限流，跨模型同时受限 | **tpm** | 同端点族 |
| 账号族 · RPM 形态 | `ModelAccount*Rpm*` | 同族请求数形态（无窗口实测数据） | **rpm** | 推定同上 |
| 配额维节流 | `code: "Throttling.AllocationQuota"`（message "Workspace allocated quota exceeded…"） | workspace 对模型的分配配额节流——**2026-11-03 真机实测为 rpm 限流**（14s~1min 自愈、多账号各自撞各自的窗），不是积分池耗尽 | rpm | 秒～分钟；**轮换不记 strike** |
| （已废）池特征串 | ~~message 含 "Allocated quota exceeded" 等~~ | **2026-11-03 判定废除**：两个词条实测全为限流误标（词条 1 = AllocationQuota 限流措辞、词条 2 无任何出处），18 条真机 pool 日志均为限流。积分池耗尽的 body 形状至今零样本；请求侧识别 = **持续限流记账（已落地，2026-11-04 断流重置式）**：**所有 429 形状**（与桶解耦——rpm/unknown/an 线全入口）记账，429 间隔超 30min 翻篇重记（闲置不算持续）、连续段攒满 30min 且无成功 ⇒ 打池格（key-orchestrator.noteLimited/sustainedLimited + llm-adapter.rotateApiKey 统一分派），30min 格 TTL 到期放出试一次、段未清立即再格——每 30min 一次探测性 RTT；全组格满 → ACCOUNT_QUOTA 快速终止。池格另由 console 通道驱动 | — | — |
| `insufficient_quota` | `code: "insufficient_quota"`（message "inference exceeds tpm/rpm limit"） | 命名像配额耗尽、实为速率限流（2026-10-31 freeapi 订正；2026-11-03 真机样本实测 rpm 形态） | rpm | 秒～分钟；**轮换不记 strike**（2026-11-03 前曾按 tpm 计踢） |
| anthropic 线软形态 | `error.type: "rate_limit_error"`（`/v1/messages` 线，无数字 code） | 2026-11-05 真机样本：message 同「inference exceeds tpm/rpm limit」，用户口径实测 rpm 形态；与 `insufficient_quota` 同桶同待遇 | rpm | 秒～分钟；**轮换不记 strike** |

> **`429003` 归速率桶的依据与不确定性**：样本只有一条（来自上游 token-plan 插件的线上记录），它的 message 与 429001 完全相同、type 与端点族相同，**两者都区分不了**。归类依据是用户对「商汤 RPM 很低、429 常见」的实测观察，不是编号规律。若日后抓到的样本显示它其实是 token 窗口，改这一行即可。
>
> **strike 口径（2026-11-02 定稿）**：踢出阈值（连续 3 次）只计 **TPM 桶**——429001 / EndpointTPM / AccountTPM（窗口分钟级以上，持续命中才值得关禁闭）。RPM 桶（code 8 / 429003 / EndpointRPM / AccountRPM，14s 级自愈）轮换但不计数；判据单一来源 = `rate-classify.ts` 的 `bucketCountsStrike`（入参是桶，不是 kind），**唯一调用方 = 对话链**（`adapter.ts` 的 `rotateApiKey` 分派）。识图桥与出图链的 429 是另一套口径：换 key 保服务、**不打格不记账、不碰 strike**（`vision/bridge.ts` / `image-tools.ts`，2026-11-04 批 G/H 他拍板「与 429 分类无关」）。2026-10-31 的旧口径按 kind 白名单（tpm/endpoint/account 全计），把作用域族的 RPM 形态也计成了重形态——已改。

**作用域结论（2026-10-31 真 key 实测，推翻旧结论）**：此前有说法称 `EndpointTPMExceeded` 是「端点共享、换 key 无用」，**该结论没有实测支撑**。当日实测同一时刻三把 key 打同一模型：A 200、C 200、B 429（`EndpointTPMExceeded`）；B 换 kimi-k3 仍 429（`ModelAccountRpmRateLimitExceeded`），而 A/C 始终可用。⇒ 这两族到不了「端点共享」，**换 key 能绕开**；B 的 429 是这把 key 自己的窗口（几小时不恢复也出现过，但同一时刻别的 key 完好）。

**tpm 隔离的恢复机制（2026-11-03 批 D 重做；2026-11-04 批 E 与耗尽账本解耦）**：连续 3 次 tpm 踢出阻塞态后，**驻留 10 分钟**（`BLOCKED_RESIDENCY_MS`）由时间门放回轮换——**考验状态**（strike 预置阈值-1）：下一次 tpm 429 立即回笼再驻留 10min，2xx 成功清零转正。**不做网络探测**——旧 /models 探测对 tpm/额度耗尽恒 200（恒真信号），「放进去就出来」的假恢复循环且令探测退避机制（probeAttempts 15/30/60s）整段死码，已整体拆除；恢复检验由轮换流量的真实 429/2xx 完成。**借用自 2026-11-04 起只剩保底语义**：轮内换 key 恒不借阻塞 key（`borrow:false`，阻塞 key 只按时间门回运行态），借用仅发生在「运行态为空」的 pickStart 保底与「轮起点全被池格标住」的跳过路径上——「借用+2xx 转正」通道保留，但不再每轮例行触发。**额度耗尽账本与该机制解耦**（批 E）：连续限流段跨阻塞态与时间门持续累计，只有 2xx 清账——隔离期的空闲不算断流（是关着不是好了）。

**作用域不参与处置（2026-11-02）**：`Endpoint` / `ModelAccount` 这层前缀只说明窗口记在哪一层，**踢出差异全部来自它后面那个桶类型**（TPM/RPM）。旧实现把两族各当一个 kind，于是 `EndpointRPMExceeded` 跟着 `EndpointTPMExceeded` 一起计 strike——短桶被当成长窗口。现改为按桶类型判踢出，作用域只留在 `kind` 日志标签里；退避值则快慢共用一套梯子。

几种形态的**恢复时间尺度不同，处置就不同**——这是整套教义的立足点。端点族/账号族的恢复时间不可预测（几分钟到几小时），所以**不做固定长冷却**：按普通 rate 处理、换 key 继续，试到被限的那把也无害。

## 2. 分类层（`rate-classify.ts`）

一次 429 到达后先归类：

- `rate-rps`（code 8）→ **bucket=rpm**：换 key、不计数踢出；
- `rate-soft`（429003 / `insufficient_quota` / `Throttling.AllocationQuota` / anthropic 线 `error.type=rate_limit_error`）→ **bucket=rpm**：换 key、不计数踢出（与 rps 同待遇，2026-10-31 起逐个收编；an 线分支 2026-11-05 收编，见 §1 表末两行）；
- `rate-tpm`（code 429001）→ **bucket=tpm**：换 key、计数踢出；
- `rate-endpoint`（`RateLimitExceeded.Endpoint*Exceeded`）→ 桶按 code 里的命名分：`…TPMExceeded` = tpm（计数），`…RPMExceeded` = rpm（不计数）；**code 里没写 RPM 标记时按 tpm 兜底**（`bucketOfCode`：兜底往严侧，宽松侧等于闸门不存在）；
- `rate-account`（`ModelAccount*RateLimitExceeded`）→ 同上，按 code 里的 `Tpm`/`Rpm` 定桶；
- `unknown`（无 code / 非 JSON / 未知形态）→ **兜底换 key，但不记 strike**：每个 429 都是某种限速（2026-10-31 实测换 key 有实证支持），而形状不明时把一把 key 判死太武断。日志 `kind=unknown bucket=-`。

> **`kind:"pool"` 目前没有请求侧生产者**：池类 message 特征串判定 2026-11-03 已废（见 §1 表），`classify429Full` 不产出该值。池格由两条路写入——**持续限流账本**（所有 429 形状攒满 30min，`key-orchestrator.noteLimited/sustainedLimited` + `llm-adapter.rotateApiKey` 分派）与 **console 额度通道**（`reportQuotaPools`，仅池内单 key 时接线）。适配器里的 `pool429` / `'pool-exhausted'` 分派保留待用，当前分支不可达。

**两个正交维度（2026-11-02）**：`kind` 只是日志标签；`bucket`（tpm/rpm，由 code 命名决定）只决定**计不计踢出**；**退避值统一走一套梯子**（`PROBE_BACKOFF_STEPS_MS` = 3 / 5 / 10 / 15 / 30s，30 封顶），不再按桶分两套。作用域（Endpoint/Account）本身零处置差异——全仓没有分支消费两族的区别。

**为什么统一退避**：旧的「RPM 走 15s 静态 floor」建立在「宿主等待是唯一恢复窗口」的旧形态上；4 轮轮询落地后插件内序列本身已 20-40s，远超 14s 桶补充周期，15s 这个值失去依据。统一后：前几档短→瞬时抖动快恢复，后几档长→长窗口期降低请求密度。

**封顶 30s 而非上游 freeapi 的 120s**：DSH 宿主对 `providerRetryAfterMs` 超过单次延迟上限（60s）直接放弃重试，120s 档在宿主侧形同虚设。

端点族/账号族**只按 code 判定，不看 message**：实测里 `code=8` 与 `EndpointTPMExceeded` 都会附带同一句 `inference exceeds tpm/rpm limit`，message 无法区分类型。

## 3. 处置（`key-orchestrator.ts` + `adapter.ts`）

| 类别 | 动作 |
|---|---|
| 2xx | 清该 key 连续限流计数；借用中的阻塞 key 由此救回运行态 |
| 401 | key 移出池（**不是永久**：下次面板写池会 `refreshKeys` 重种、`restoreById` 也能救回，靠 10min 时间门是另一条路），换下一把重发 |
| TPM 桶（429001 / EndpointTPM / AccountTPM） | 连续计数 +1，达 `kickThreshold`（3）踢入阻塞态；本次请求换下一把 key 立即重发（同 key 重试次数为 0） |
| RPM 桶（code 8 / 429003 / `insufficient_quota` / `Throttling.AllocationQuota` / EndpointRPM / AccountRPM / an 线 `rate_limit_error`） | 换下一把 key，**不计数**（14s 级自愈，计入会误伤贴线限流的健康 key） |
| 持续限流账本（所有 429 形状） | 连续段攒满 30min → 打 (key, 积分组) 格子（30 分钟 TTL）；换下一把重发。**格子不是「请求级的池类」**，写入点见 §2 末注 |
| 5xx / 超时 / 传输错误 / 空响应 | **同 key** 交宿主重试层，不换 key |

**全池轮询（4 轮，2026-11-02）**：一次请求的轮询结构是「3 轮 + 抖动等待 + 第 4 轮」——

1. **轮的定义**：把所有可试的 key（非 dead、未被该组池格标记、本轮未试过）各试**一次**。**阻塞 key 不进轮询**（`borrow:false`，2026-11-04 拍板：tried 下推为池的选择条件，轮长 = 未试运行态数）；per-key 并发闸不在选择条件里——同一个 key 撞闸时是**排队**（`acquire` 阻塞到有空位或排队超时），不是换 key。轮边界由「选不出本轮未试过的 key」决定，**不是固定的账户数**（池成员变化时自然收窄/扩大）。
1b. **每轮起点轮换**：裸轮转组（general）把上一轮起点排除后从它的下一位环回（`excludeStart`），所以 4 把 key 的起点序列是 A → B → C → D，避免总是固定账户优先。商汤组（亲和组）忽略该参——亲和 key 恒第一（上一轮最后粘住的那把）。
2. **3 轮**：每轮清空 `tried` 让各 key 重新获得一次机会；无间隔连打。
3. **抖动等待**：3 轮全 429 后等一次 `5-10s`（`T = 5s + random()*5s`，**每请求独立计算**，可被 abort 打断）。目的是避免并发请求同时结束等待造成第二波洪峰。
4. **第 4 轮**：再各试一次；全败**立刻抛**，不再等待（「最大主动等待次数 1 次」）。

失败后按类分叉：

- RPM / TPM 桶全灭 → 抛 `RATE_LIMIT`（带退避梯档值），交宿主重试层再走整轮；
- **积分池类全组标满 → 抛 `ACCOUNT_QUOTA`**（不在宿主可重试清单里，直接上屏）。判据 = 该组每把 key（含阻塞态）都被池格标记（`groupFullyPoolMarked`）——这是唯一「不等就终止」的路径；单把 key 的池耗尽只打标、不打断流程，格子由池层在下一轮选 key 时自动跳过。

阻塞 key 的恢复**不做网络探测**（2026-11-03 批 D，他拍板）：驻留满 `BLOCKED_RESIDENCY_MS`（10 分钟，`key-pool.ts`）由**时间门**放回运行态，并带**考验状态**（strike 预置为阈值-1）——下一次 tpm 429 立即回笼再驻留，2xx 成功清零转正。旧「每 15s 扫一次到期者、用 `GET /v1/models` 轻探测」对 tpm/额度耗尽恒 200（恒真信号），「放进去就出来」的假恢复循环且令探测退避（15s × 2ⁿ）整段死码，已整体拆除；恢复检验由轮换流量的真实 429/2xx 完成（`index.ts` 仍每 15s 跑一次**纯状态**的时间门扫描，零网络）。池的三条不变量：运行态只剩一把永不踢出（保底）、候选被排空时借阻塞最久的一把（借用、不改相位——**仅保底路径**，常规轮询不借）、恢复不依赖「请求恰好成功」（时间门放回 + 真实流量考验，与请求路径解耦）。

## 4. 宿主重试层的参数

适配器通过 `providerRetryPolicy()` 向宿主 `dsh-llm-retry` 申报策略（`adapter.ts`，类别清单由 `llm-retry.ts` 单点给出）：

```text
mode: normal          ← 只重试申报过的类别，有上限
maxRetries: 10        ← 单次 agent 步骤内预算；更长故障显式失败
retryableCodes: EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, ANTHROPIC_TRUNCATED
backoff: maxDelayMs 60s（单次等待上限）
```

三条刻意为之：

1. **`ACCOUNT_QUOTA` 故意不在重试清单里**（`QUOTA` 码位保留但本仓零生产者）。它的实际判据是额度耗尽账本「全组 key 持续限流满 30 分钟」——这是本仓自己定的行为阈值（积分池耗尽的 body 形状至今零样本，判据纯行为观测），按该口径连续 30 分钟无成功即视为「现在等也没用」，重试只会立刻重撞同一堵墙；快速失败让面板说出原因。这与「把额度类写进 retryableCodes」的常见建议**相反**——那适用于单 key、池语义不同的路径。
2. **Retry-After 头被尊重但封顶 60s**（`PROVIDER_RETRY_AFTER_CAP_MS`）。上游给的等待过长时宁可多探测几次，也不把一次请求挂死在单一等待上。
3. **重试耗尽必须向上暴露**，而不是静默吞掉：无上限重试把「限流」变成「假死」，用户分不清是在等还是在挂；耗尽即失败，错误与面板负责解释。

## 5. 数值总表（全部是代码常量，改值请改对应文件）

| 数值 | 值 | 定义处 |
|---|---|---|
| 配额类退避梯（全桶共用） | 3 / 5 / 10 / 15 / 30s（30 封顶） | `rate-classify.ts` `PROBE_BACKOFF_STEPS_MS` |
| 退避档位推进单位 | 每次 stream() 调用一档（入口快照、整轮失败才 +1） | `adapter.ts` `stream()` 的 `entryProbeFloorMs` / `probeHitThisCall` |
| 轮询轮次 | 3 轮 → 抖动等待 5-10s → 第 4 轮 → 抛 | `adapter.ts` `MAX_POLL_ROUNDS` / `JITTER_WAIT_MIN_MS` / `JITTER_WAIT_MAX_MS` |
| Retry-After 封顶 | 60s | `rate-classify.ts` `PROVIDER_RETRY_AFTER_CAP_MS` |
| 踢出阈值 | 连续 3 次 **tpm 桶** | `key-orchestrator.ts` `DEFAULT_ORCHESTRATOR_PARAMS.kickThreshold`（=3；池层 `key-pool.ts` 的 `DEFAULT_KEY_POOL_PARAMS.kickThreshold` 2026-10-31 起同为 3，两道默认已对齐、不再有覆盖关系） |
| 阻塞驻留（时间门） | 10 分钟 | `key-pool.ts` `BLOCKED_RESIDENCY_MS` |
| 池格 TTL | 30 分钟 | `key-orchestrator.ts` `GRID_TTL_MS` |
| 出图失败冷却 | 30s | `image-tools.ts` `IMAGE_COOLDOWN_MS` |
| 重试预算 | 10 次 / 单次 ≤60s | `adapter.ts` `providerRetryPolicy()` |

## 6. 排错入口

- 面板「接入 API」tab 的 **API Key** 卡内池管理块：key 列表（脱敏名 + 相位徽标：运行绿 / 阻塞灰 / 未入池红，停用/恢复/删除）与全局并发框（0 = 跟随 key 数）；
- `npm run doctor`：磁盘上的开关与目录状态；
- 阻塞 key 长期不恢复 → 时间门每 10 分钟放回考验一次；反复回笼说明它仍在真实撞 tpm 桶，或该 key 已被 401 移除。
