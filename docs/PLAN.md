# dsh-sensenova-suite 方案（定稿）

2026-10-24 审查定稿 · 目标 DSH **0.2.0** · 包名 **dsh-sensenova-suite**

六个源项目（均在 `F:\Dialog\sensenova\`，一律不动）：

| 项目 | 贡献 |
|---|---|
| dsh-connect-sensenova-token-plan-main | 骨架：面板/胶囊/积分/模型管理/发布状态机 |
| dsh-sensenova-provider-master | 两个协议层 + 429 分类 |
| dsh-sensenova-freeapi-main | key 池状态机 + 实测协议事实 |
| dsh-sensenova-image-master | 出图 + 编辑工具 |
| dsh-sensenova-vision-aid-main | 图片转述 |

---

## 1. 骨架与身份

- 骨架 = token-plan v0.8.3，复制到 `F:\Dialog\sensenova\dsh-sensenova-suite` 开发。
- 包名 `dsh-sensenova-suite`（已定）；插件 id 新起，不沿用旧名。
- **目标 DSH 0.2.0**（本机实装版本）；兼容表声明 0.2.x。

## 2. 功能清单

| 功能 | 来源 | 处置 |
|---|---|---|
| 协议层 | provider | 移植 `wire/*` |
| key 池（双列表状态机） | freeapi | 移植 `key-pool.ts`，扩展双池记法 |
| 429 分类 / Retry-After 指导 | provider | 移植分类器，扩 (key, 组) 二维 |
| 重试参数 | provider-config | 数值进默认配置，文档进 README |
| 面板 / 胶囊 / 积分 / 模型管理 | token-plan | 原地保留 |
| 出图 + 编辑 | image-master | 本体移植，吸收 token-plan draw 三机制后砍 draw |
| 图片转述 | vision-aid | 移植核心，凭据统一走池 |

砍掉不搬：token-plan 的小熊 Raccoon 全家、web search 接管、它的绘图工具、它自带的模型注册（被本方案适配器替代）。

## 3. host 侧分层（依赖单向向下）

```
面板层(client)  面板卡 / 用量胶囊 / 设置页
发布层          模型目录 / 热更新开关 / unavailableIds（按组）
适配器层        对接 dsh-llm：sessionId、重试指导、请求编排（全池轮询在这层）
池层            key-pool 状态机：running/blocked/dead、亲和表、游标、探测调度
分类层          状态码+响应体 → {rate-rps|rate-tpm|pool(组)|auth|server|timeout|transport|empty, retryAfterMs}
wire 层         anthropic / responses / chat-completions 三协议
工具层          image 工具、vision-bridge（平行存在，只复用池层与分类层）
```

## 4. 协议层

- **模型清单由 chat 协议探测**（`GET /v1/models`）。
- **所有对话模型都支持三种协议**——协议层不做按模型的协议排除。
- **图像模型单独处理**：不进三协议层，走 §6 独立路径。
- 降级链（对称式）：
  - **auto 模式**：首选协议 → 另一个非 chat 协议 → chat 兜底；首选默认 anthropic（配置 `preferredProtocol: anthropic | responses`，仅 auto 生效）。
  - **强制模式**（anthropic / responses / chat 三档）：只走这一条，失败也不换协议——报错，不静默降级。
- 验证清单：
  1. 两个端点的 effort 枚举分别实测——OpenAI 端 freeapi 实测 `max` 会 400、`xhigh` 可用；Anthropic 端官方 FAQ 说只有 low/medium/high；wire 映射表按实测定档；
  2. SSE 事件序列、`stop_sequences`、工具扁平 schema、多轮不回传思维链——逐项对照 proxy 测试；
  3. 图像输入能力按模型实测清单处理（vision 集合：`kimi-k3` / `sensenova-6.8-flash-lite` / `deepseek-flash`），不支持图像输入的请求按内容能力路由/报错，不是按协议。

### 4.1 验证结果（2026-10-24，第一步已完成 ✅）

- **typecheck**：修 3 处后全绿（blocks.ts data-URL 捕获组判空、sse-anthropic mergeUsage 的 totalTokens 恒定重算、message_delta.delta 的 isRecord 守卫）。**未构建产物**。
- **effort 枚举实测**（`dsh-sensenova-suite/tools/wire-probe-effort.mjs`，12 档全 200）：Anthropic 端 low/medium/high/xhigh/max + thinking:disabled 全过；OpenAI 端 none/low/medium/high/xhigh/max 全过。**官方 FAQ「xhigh 会 400」与 freeapi 旧注「max 会 400」均与今日实测不符（已过期或校验放宽）**。保留项：200 无法区分「按档生效」与「静默忽略」，不影响请求正确性，后续由 thinking_tokens 观测确认。
- **流式+工具端到端**（`tools/wire-probe-stream.mjs`）：事件序列 `message_start → [content_block_start/delta/stop]×3 → message_delta → message_stop`，内容块 `thinking / text / tool_use`，扁平工具 schema 被接受且模型真调了工具（stop_reason=tool_use），message_delta 带 usage（含 cache_read_input_tokens、thinking_tokens）。与 proxy 测试场景和 wire v1 事件词表逐项吻合。
- **结论：wire v1 验证通过**，可进入第 2 步（token-plan 减法）。

## 5. 池与路由（核心）

### 5.1 状态空间

每 key：相位（running/blocked/dead）、连续限流计数（2xx 清零）、在途并发、探测退避相位。
全局：亲和表（sessionId→key，LRU 512）、轮转游标、**(key, 组) 的 pool-429 格子**。

### 5.2 双池分组

`model → 组` 映射进配置，组间**不回退**（实态：商汤专用模型单独积分池）：

- **商汤组**：`sensenova-6.8-flash-lite`
- **通用组**：`deepseek-v4-flash`、`deepseek-flash`、`glm-5.2`、`kimi-k3`、`sensenova-u1.5-lite/fast`

速率桶（RPM/TPM）是 key 级，踢出/探测不分组；只有 pool 类 429 按 (key, 组) 记。

### 5.3 并发（2026-11-02 定稿）

- **per-key 固定 1**（不可配）：一把 key 同时只有一个在途请求。
- **全局并发数**：用户控制的在途总上限，**默认 2**；面板填 **0 = 跟随 key 数**（加 key 自动扩容，无需改配置）；填正数 = 固定上限（调小 = 只激活部分 key 的温和模式）。`resolveGlobalConcurrency` 保证显式 0 必达（旧 `num()` 把 0 读作未设的坑已修）。
- 实际在途上限 = `min(全局值, key 数 × 1)`——per-key 闸是第二道，全局值只是天花板。
- 选 key 跳过在途中的 key；全部在途则排队等待，不报错。
- **排队超时 90s**（2026-11-02 从 60s 提到 90s）：4 轮轮询把等待搬进插件内，一次全 429 的 `stream()` 全程占全局槽约 30-50s（16 次 RTT + 10s 抖动等待）；两个会话同时全 429 时第 3 个排队者会逼近 60s，90s 留余量。

### 5.4 选 key 顺序（按组分模式）

- **商汤组：粘性**（该组 RPM 不低 → 省积分优先）：亲和命中（key 可用且在途未满）→ 用它；未命中 → 游标下一把 → 写亲和表，TTL 300s。
- **通用组：裸轮转均分**（该组 RPM 极低 → 吞吐优先）：不走亲和，每次游标下一把。
- `activeAccount` 钉选最高优先（两组都遵守，429 例外见下）。
- **每轮起点轮换（2026-11-02）**：4 轮轮询的每轮起点必须与上一轮不同（避免总是固定账户优先）。实现 = 把上一轮起点作为 `excludeStart` 交给池层，裸轮转组从它的下一位环回；亲和组忽略该参（亲和 key 恒第一，即使它刚 429 过也照打）。实测 4 把 key 的起点序列 = A → B → C → D。

### 5.5 429 处理 + 4 轮轮询（2026-11-02 定稿，取代原「单圈轮换」）

**分类（只认 `error.code`，message/type 不参与）**

| code | kind（日志标签） | bucket（踢出判据） |
|---|---|---|
| `8` / `429003` | rate / rate-soft | **rpm** |
| `429001` / `insufficient_quota` | tpm | **tpm** |
| `RateLimitExceeded.Endpoint*TPMExceeded` | endpoint | **tpm** |
| `RateLimitExceeded.Endpoint*RPMExceeded` | endpoint | **rpm** |
| `ModelAccount*Tpm*` | account | **tpm** |
| `ModelAccount*Rpm*` | account | **rpm** |
| 池特征串（"Allocated quota exceeded" 等） | pool | 无（走格子） |
| 其余 | unknown | 无（只换不记） |

`inference exceeds tpm/rpm limit` 是多个形状共用的措辞（code 8 / 429001 / 429003 / Endpoint 族都带），**不能作为判据**；作用域（Endpoint/Account）本身零处置差异，只留在 kind 日志标签里。

**轮询结构**

```
第 1 轮：所有可试 key 各一次（起点 = 首轮选中的 key）
第 2 轮：起点推进一位，再各一次
第 3 轮：起点再推进一位，再各一次
        ↓ 3 轮全 429
抖动等待 T = 5s + random()*5s（每请求独立、可 abort 打断）
        ↓
第 4 轮：再各一次
        ↓ 全败
立刻抛（不再等待）
```

- **轮的定义**：把所有可试的 key（非 dead、并发未满、未被该组池格标记；阻塞 key 按「借用」参与、不改相位）各试**一次**。轮边界由「选不出本轮未试过的 key」决定，**不是固定的账户数**——池成员变化时轮内次数自然收窄/扩大。
- **每轮清空 `tried`**：各 key 在下一轮重新获得一次机会。
- **成功优先**：任意一次 2xx 立即结束轮询并返回。
- **最大上游尝试** = 可试 key 数 × 4（4 把 key → 16 次；2 把 → 8 次；1 把 → 4 次）。
- **最大主动等待次数 = 1 次**（只有第 3 轮之后那一次抖动等待；第 4 轮之后不再等）。

**各形态的处置**

| 形态 | 插件内 | 记账 | 终止时抛出 |
|---|---|---|---|
| **RPM 桶**（code 8 / 429003 / *RPM* 族） | 4 轮轮询，不冷却 | 只换 key，**不计数**（14s 级自愈） | `RATE_LIMIT` |
| **TPM 桶**（429001 / *TPM* 族） | 4 轮轮询，不立即冷却 | 换 key + **计数**，连续 3 次踢阻塞态 | `RATE_LIMIT` |
| **pool**（积分耗尽） | **只打标不打断流程**——D 耗尽不代表 A/B/C 也耗尽，格子由池层在下一轮选 key 时自动跳过 | 记 (key, 组) 格子，30min TTL | 全组标满 → `ACCOUNT_QUOTA` |
| **401** | 移出池，换下一把 | 永久移除（纯内存，重启复活） | — |
| **402 / 403** | 兜底换 key **仅一次**，再失败上屏 | 不记账 | 原码 |
| **5xx / 超时 / 传输 / 空响应** | **不换 key**，同 key 交宿主 | — | 原码 |
| **400 / 404 / 413 / 422** | 不换 key（换了也不会变好） | — | 原码 |

**唯一「不等就终止」的路径**：该组每把 key（含阻塞态）都被池格标记（`groupFullyPoolMarked`）→ 立即抛 `ACCOUNT_QUOTA`（不在宿主可重试清单里，直接上屏，错误文案说明「积分池已耗尽，等待额度恢复或更换账号」）。积分池是滚动 5h / 周窗口，重试毫无意义。

**交宿主之后**：RATE_LIMIT 保留在宿主可重试清单里，宿主 `maxRetries: 10` → 单请求最坏 16 × 11 = 176 次上游尝试。这是刻意接受的（限流场景下密集重试的代价主要是 RTT，不耗积分；实测「几乎不交由宿主重试」）。

### 5.6 退避与阻塞态（2026-11-02 定稿）

**退避梯（全桶共用一套）**

```
3s → 5s → 10s → 15s → 30s（封顶）
```

- **入口快照**：一次 `stream()` 调用（含 4 轮所有 attempt）共用同一档；整轮失败才在 `finally` 里 +1，成功清零。原实现在 attempt 循环内就地 +1，4 把 key 各撞一次就从 0 跳到索引 3（15s 起），一次宿主重试吃掉多档。
- **快慢统一**：旧的「RPM 走 15s 静态 floor」已删——它建立在「宿主等待是唯一恢复窗口」的旧形态上；4 轮轮询落地后插件内序列本身已 20-40s，远超 14s 桶补充周期，15s 这个值失去依据。
- **封顶 30s 而非上游 freeapi 的 120s**：DSH 宿主对 `providerRetryAfterMs` 超过单次延迟上限（60s）直接放弃重试，120s 档在宿主侧形同虚设。
- **生效时机**：只挂在**终态抛出的 LlmError** 上（`min(max(floor, Retry-After头), 60s)`）；插件内换 key 成功不抛错，用不到它。

**阻塞态生命周期**

连续 `kickThreshold`（默认 3）次 **TPM 桶** 429 → blocked；探测 15s ×2ⁿ 封顶 60s，成功挂回 running 尾部。三不变量：**保底**（running 剩一把永不踢）、**借用**（候选排空借 blocked 最久的、不改相位）、**探测与请求解耦**（根治「只在 2xx 清零」死锁）。

- **RPM 桶永不踢**：14s 级自愈，计入踢出阈值只会把贴线限流的健康 key 踢出池。
- **pool 类不计数不踢**：账户级、小时级自愈，记格子 + 探测覆盖。
- **单 key 部署下踢出永不生效**（保底不变量），实际只吃退避梯；2 把 key 时也只有先撞满 3 次的那把会被踢。
- **判据单一来源** = `rate-classify.ts` 的 `bucketCountsStrike`，对话链与识图/出图链都从它取。

### 5.7 明确不做

权重（等价 key 无信息来源）、lane 分离（并发定稿已覆盖）、自动模型降级（model 级 fallback 是另一层行为，后续再说）。

## 6. 出图与编辑

- image-master 整体移植：`/v1/images/generations` + `/v1/images/edits`、savePath / Base64 / 24h URL、设置页。
- 吸收 token-plan draw 三机制：模型从 catalog `output_modalities` 结构化识别（不写死枚举）、key 按调用解析、失败 30s 冷却。
- 走同一池层与分类层；**pool 类 429 主战场**。
- 参数按官方文档核对（最多 5 张参考图、首张主图、n=1、url 24h、watermark 公测免费 false）。

## 7. 视觉转述

- vision-aid 核心移植（vision-bridge / orchestrator / direct / image-input）。
- 独立凭据解析删除，统一走池（行为变化：视觉调用也参与轮转）。
- 视觉模型清单用 freeapi 实测集：`kimi-k3` / `sensenova-6.8-flash-lite` / `deepseek-flash`；主模型实际支持图片时自动跳过。

## 8. 积分面板

- 控制台 OIDC 登录（多跳 IAM + JWKS + token 自动续期）原样保留。
- 显示**双池分列**（通用 / 商汤）+ 每模型消耗 + 趋势 + 输入框用量胶囊。
- 定位 = 可观测，不喂路由；pool 类 429 触发即时刷新。

## 9. 配置面（全清单，均可后调）

| 参数 | 默认 | 状态 |
|---|---|---|
| accounts[]（id / label / credential-ref） | — | 用户填 |
| activeAccount | 空 | 用户填 |
| globalConcurrency | **2**（0 = 跟随 key 数） | 用户控（per-key 固定 1 不可配） |
| kickThreshold | 3 | 已拍板（只对 TPM 桶计数） |
| probeInitialMs / Factor / MaxMs | 15s / 2 / 60s | 锁定候选 |
| capacity | 999（≈不限） | 已放开（原 10 出自上游 2 账号×5 把） |
| affinityTtlSecs | 300（仅商汤组） | 锁定候选 |
| 429 退避梯 | 3 / 5 / 10 / 15 / 30s（30 封顶） | 常量，全桶共用 |
| 轮询轮次 / 抖动等待 | 3 轮 + 5-10s + 第 4 轮 | 常量，不进配置 |
| 宿主重试（maxRetries / 退避） | 10 / 500ms×2ⁿ 封顶 60s | 常量（429 类用 providerRetryAfterMs 直替换） |
| 排队超时 | 90s | 常量 |
| model→组 映射 | 按 §5.2 | 组名可增 |
| preferredProtocol | anthropic | 仅 auto 生效 |
| wireProtocol | auto / anthropic / responses / chat-completions | 强制三档沿用 |
| reasoningSummary | auto | 沿用 |
| Retry-After 封顶 60s | 常量 | 不进配置 |

## 10. 打包与安装

- **peer-free 硬约束**：schemastery 打进 lib 产物、零 runtime peer——桌面 profile 的 symlink 安装按 ESM realpath 解析依赖，真实目录没依赖就 `failed to import`（三个插件实证过；token-plan 靠 peer-free 唯一存活）。
- 安装走正规 `dsh plugin add`（pnpm 实体）；web / desktop 两面各装一次。

## 11. 测试与验收

- 单测：key-pool（freeapi 套件随迁）、429 分类、降级决策表、双池格子。
- oracle：proxy 测试场景移植为 wire 测试向量。
- 实测清单：两端点 effort 枚举、探测调用成本（`GET /v1/models` vs 1-token，选便宜的不暴露配置）、人为 429 风暴下的全池轮询一轮、双池切换、商汤组粘性生效。
- 验收：日常双面使用 24h 不重启、面板数字与控制台一致、高峰期会话不因限流卡死。

## 12. 实施顺序（每步结束插件可安装可验证）

1. **验证 anthropic wire**（oracle 对照 + 实测清单）——未证实，最先做；
2. **token-plan 减法**：删 raccoon / web-search / draw / 它的模型注册（约 6k 行删除）；
3. **协议 + 池 + 分类接入**：wire 与 key-pool 进来，适配器接发布状态机，双池格子 + 按组路由实现；
4. **image + vision 移植**；
5. **收尾**：面板合并（双池显示）、i18n、README（收编 provider-config 文档）、兼容表定稿 0.2.x、装新卸旧。