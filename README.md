# dsh-sensenova-suite

多账号 Key 池与 429 限流调度（RPM/TPM 限流分类、Key 状态机踢出与时间门恢复、积分组隔离与额度账本、多轮轮换重试与统一退避梯）、三协议适配（Anthropic / Responses / Chat Completions）与协议降级链、积分用量监控及多模态工具（出图 / 图片转述）。

## 功能速览

- **积分额度**：登录商汤控制台后，面板显示积分池（5 小时 / 周两个滚动窗）、每模型消耗趋势、输入框用量胶囊；token 自动续期；支持多账户切换。
- **语言模型接入**（面板「接入 API」tab 的「向 DSH 注册」开关，部署默认关、面板实时覆盖）：直连商汤网关注册 LLM 供应商，**每模型自选降级链**——模型设置三个槽位（anthropic / responses / chat-completions，不重复、可截短），**默认链 = chat-completions 单线**，想要 anthropic / responses 的模型需要在槽位里自己加。anthropic 线时好时坏由运行时断尾降级兜底（断尾/400 命中即内存级标记换线，重启清除）；responses 线思考档位传入无效；链上全部覆盖不了时 chat 永远兜底。模型清单由 `/v1/models` 探测。
- **多账号 key 池**：401 永久移除；**TPM 桶 429**（429001 / `…Endpoint*TPMExceeded` / `ModelAccount*Tpm*`）连续 3 次 → 阻塞态驻留 10 分钟由时间门放回（考验状态：再撞立即回笼，2xx 转正），本次换下一把 key；**RPM 桶 429**（code 8 / 429003 / `insufficient_quota` / `Throttling.AllocationQuota` / `…Endpoint*RPMExceeded` / `ModelAccount*Rpm*` / anthropic 线软形态 `rate_limit_error`，14s 级自愈）→ 轮换但不计数；**额度耗尽账本**：所有 429 记账、间隔超 30 分钟翻篇，连续段攒满 30 分钟且无成功 → 打 (key, 积分组) 池格（30 分钟 TTL，格中 key 跳过、到期放试一次），全组格满抛 `ACCOUNT_QUOTA` 快速终止；**一次请求 3 轮 + 抖动等待 5-10s + 第 4 轮**；**SenseNova 6.8 Flash Lite模型亲和 key 恒第一、其余轮转，通用组裸轮转均分**。
  - ⚠️ **每把 key 应来自不同账号**。同一账号下的多把 key 共享同一个额度池，限流时换到同账号的另一把没有意义——换 key 只有在跨账号时才真正绕开瓶颈。池本身无法判断哪几把 key 同属一个账号，需自行保证。
- **出图工具**（部署默认开，面板「多模态」逐工具开关——面板存过以面板为准）：`sn_text2img` 文生图 + `sn_img2img` 图片编辑，失败 30s 冷却，key 走池。
- **图片转述（读图桥，默认开）**：纯文本主模型拖图不再被「不支持图片」阻断——视觉模型（默认 `sensenova-6.8-flash-lite`，单模型，429 换 key 保服务、不打格不记账）把事实性观察交给主模型续接回答，界面原图不动；主模型在「可看图」勾选集里时图片原样放行。

## 快速开始

1. 通过 DSH 插件界面安装并**重启 DSH**：

 ```
https://github.com/QZJ903/dsh-sensenova-suite
```
或

```
dsh-sensenova-suite
```

2. 在「积分额度」页登录商汤控制台查看额度，支持多账号切换。
3. 在「接入 API」页保存一枚 `sk-` Key——入池成为第一把 key（池内人人平等，无主 key 特权）。
4. 在「接入 API」tab 开「向 DSH 注册」→ 模型选择器出现模型；出图与转述开关在「多模态」。

## 配置

两个配置面：**面板**（存插件状态，即时生效）与 `cordis.patch.yml`（部署默认，改完重启/重载生效；面板开关实时覆盖同名项）。常用键：

| 键 | 默认 | 说明 |
|---|---|---|
| `accounts[]` | — | 多账号：`{ id, label, apiKeyRef }`，ref 是凭据服务引用名，重载入池 |
| `activeAccount` | `""` | 钉选账号 id；空 = 纯轮转 |
| `globalConcurrency` | 2 | 全局在途上限（每把 key 固定 1；0 = 跟随 key 数） |
| `modelGroups` | — | 模型 → 积分组映射（键=精确 id）；具名组会话粘性、general 裸轮转、组间不回退 |
| `registerProvider` | false | 供应商注册部署默认；面板「接入 API」开关实时覆盖 |
| `text2imgEnabled` / `img2imgEnabled` / `visionToolsEnabled` | true | 工具开关部署默认（缺键=开、显式 false 才关）；面板「多模态」为主设置 |
| `text2imgModel` / `img2imgModel` | `sensenova-u1.5-lite` | 默认出图模型 |
| `visionModel` | `sensenova-6.8-flash-lite` | 默认转述模型 |
| `imageTimeoutMs` / `visionTimeoutMs` | 180000 / 120000 | 出图 / 转述单次超时 |
| `visionBridgePrompt` | `""` | 转述附加提示词；空 = 内置 |
| `maxTokensOverrides` / `contextWindowOverrides` | 见 yml | 每模型数值覆盖（键=精确 id）：最大输出 / 上下文窗口，本表 > 目录申报 > 兜底 |
| `trendMultipliers` | 见 yml | 趋势伪倍率：子串键、书写顺序首中；平台无官方单价，标注非官方 |
| `trendHours` / `pollSeconds` / `cacheSeconds` | 24 / 30 / 60 | 趋势窗口 / 面板轮询 / 控制台缓存秒 |
| `consoleBase` / `apiBase` | 平台默认 | 镜像/代理才改 |
| 登录端点族（`iamBase` 等 8 键） | 平台默认 | 企业镜像/暂存租户才改，yml 内整段注释说明 |

面板侧另有：推送清单勾选、每模型降级链三槽、思考档位勾选（按模型档案，未收录默认勾 high）、可看图勾选（目录自动勾、手动取消进墓碑不翻案）、Key 池管理与并发框。全部键的代码默认值在 `src/host/host-config.ts`，yml 里有逐键中文注释。

## 功能模块

**积分额度**（「积分额度」tab）

- 积分池卡片：5 小时 / 周两个滚动窗（已用 / 剩余 / 百分比 / 重置时间）；
- 每模型消耗趋势：近 24 小时排名（伪倍率对比系数，标注非官方）；
- 登录管理：登录一次后 token 自动续期；失败直接显示平台返回的原因；面板不开时后台按 `providerRefreshMinutes` 保鲜（仅供应商注册开着时调度；注册关着时无任何后台刷新）。

**输入框用量胶囊**

- 输入框右侧常驻，切不同池的模型会显示对应积分池；点击展开额度卡（原始用量 / 重置时间）。

**语言模型接入**（「接入 API」tab，默认关）

- 注册为 DSH 供应商，模型选择器出现商汤模型；清单由 `/v1/models` 探测，新模型自动出现；
- 每模型可调：推送勾选、降级链三槽（anthropic / responses / chat-completions）、思考档位勾选、可看图勾选（目录自动勾、手动优先）；
- 最大输出 / 上下文窗口可覆盖（cordis.patch.yml）。

**Key 池**（「接入 API」tab）

- 多账号入池、跨账号轮转；加 / 删 key、全局并发数随时可调；
- key 管理块：key 列表（脱敏名、备注、相位徽标——运行绿 / 阻塞灰 / 未入池红）、停用/恢复/删除。

**出图工具**（「多模态」tab，默认开）

- `sn_text2img` 文生图 + `sn_img2img` 图片编辑；
- 每工具独立开关与参数（模型 / 尺寸 / 格式 / 水印 / 落盘目录）；失败 30s 冷却，key 走池。

**图片转述**（「多模态」tab，默认开）

- 纯文本主模型拖图不再被「不支持图片」阻断：视觉模型把观察转述给主模型续接回答，界面原图不动；可看图模型原样放行；
- 同一张图进程内只转述一次（观察缓存 200 条 FIFO，淘汰后同图会再转述一次），改提示词不重述历史图。

**诊断**

- `npm run doctor`（人读）/ `npm run doctor:json`（机器读）：面板不开也能看磁盘上的开关与目录状态。

## 429 与失败处理

四层各管一段；详细教义与参数表见 [docs/retry-policy.md](docs/retry-policy.md)。

**① 分类**（`rate-classify.ts`）：按响应体 `error.code` 分型，**不看 message**（同一句措辞出现过多种 code）。分 **TPM 桶**（429001 / `…Endpoint*TPMExceeded` / `ModelAccount*Tpm*`，分钟级窗口；端点/账号族 code 未写明 RPM/TPM 时按 TPM 兜底）与 **RPM 桶**（code 8 / 429003 / `insufficient_quota` / `Throttling.AllocationQuota` / `…Endpoint*RPMExceeded` / `ModelAccount*Rpm*` / anthropic 线软形态 `rate_limit_error`，14s 级自愈）；桶决定「计不计踢出」，作用域（端点/账号）只是日志标签。未识别形状 → 兜底换 key、不记 strike。

**② 可用性状态机**（`key-pool.ts`，运行态/阻塞态双列表，承 freeapi 设计）：

- TPM 桶**连续 3 次** → 踢入阻塞态（RPM 类不动状态机，换 key 即回）；
- **保底**：运行态只剩 1 把永不踢出——池不空，请求永远发得出去；
- **借用**：仅保底（运行态为空或轮起点全被池格标住）时借阻塞最久的一把救吞吐（不改其相位、不进常规轮询）；
- **恢复**：阻塞驻留 **10 分钟**由时间门放回，带**考验状态**——下一次 tpm 429 立即回笼再驻留，2xx 清零转正。

**③ 额度耗尽账本**：**所有 429 形状**（与桶解耦）记账，间隔超 30 分钟翻篇（闲置不算持续）；连续段攒满 30 分钟且无成功 → 打 (key, 积分组) 池格（30 分钟 TTL），格中 key 后续轮次自动跳过、到期放试一次；**全组格满 → 抛 `ACCOUNT_QUOTA` 快速失败**（不在宿主重试清单）。

**④ 请求编排与兜底**（`adapter.ts`）：一次请求 **3 轮（每轮把未试过的运行态 key 各试一遍，阻塞 key 不进轮询、只在保底借用时入场；通用组每轮起点轮换、商汤组亲和 key 恒第一）→ 抖动等待 5-10s（可中止）→ 第 4 轮 → 全败即抛**。rpm/tpm 桶全灭 → 抛 `RATE_LIMIT` 交宿主重试层再走整轮；5xx/超时/网络 → **同 key** 交宿主重试层；tpm/rpm 两桶探测退避共用一套梯 **3→5→10→15→30s（30 封顶）**，5xx/超时/网络走宿主自带曲线。宿主层预算 10 次、尊重 Retry-After 但单次封顶 60s。
## 边界与凭据安全

- key 与账号凭据一律经 DSH 凭据服务存储；日志与面板只出现**打码名**，不回显明文。
- 会「动」的能力各自独立：模型接入默认关；出图/转述默认开、面板可关——都关掉时插件退化为纯额度展示。

## 目录结构

```
dsh-sensenova-suite/
├── cordis.patch.yml          # bundle 插入声明 + 全部配置键（逐键中文注释；改完重启/重载生效）
├── package.json              # dsh.bundle.patch / exports(./client) / files 白名单（src/test/docs/tools 不随 npm 包分发）
├── tsdown.config.mjs         # 双入口构建：lib/（Host 侧分块）+ client.js（面板）
├── tsconfig*.json            # 默认 / local 深检（gitignored，paths 指真 peer 树）/ strict-null
├── icon.svg · locale/        # 插件图标；面板 zh/en 文案
├── client.js · lib/          # 入库的构建产物
├── src/
│   ├── client/               # 面板：三 tab、用量胶囊、草稿式保存、轮询（peer-free 微 React）
│   ├── shared/wire.ts        # 面板 ↔ Host 快照契约（含打码承诺）
│   └── host/                 # 按域：
│       │   登录令牌     sensenova-auth / -crypto、auth-*、token-store/、throttle-store、credentials-service
│       │   额度快照     console-client、parsers、snapshot-aggregate、coalesced-fetch、codes、trace
│       │   三协议       wire/（body-anthropic / -chat / -responses、sse-*、chain、plan、facts、effort、usage、blocks、types）
│       │   请求执行     adapter.ts、llm-adapter.ts、llm-retry.ts、llm-models.ts
│       │   池与调度     key-pool、key-orchestrator、rate-classify、key-health、pool-store、concurrency
│       │   目录发布     catalog-store / -gate、provider-publish / -refresh / -store、publish-core、modality、switch-*
│       │   出图视觉     image-tools.ts、vision/（bridge / direct / tools）
│       │   路由状态     routes.ts + routes/（account / http / models / pool / provider / snapshot）、state-store、host-config
│       │   装配诊断     index.ts、lifecycle、effects、doctor、trace-log、util
├── test/                     # 离线套件 + 名册与门禁（run-all / suites / build-gate / artifact-freshness）
├── tools/                    # 独立探针与脚本：doctor.mjs、probe-host、repro-pool、wire-probe-*、update-host-range
├── types/                    # peer 缺席时的类型兜底声明
└── docs/
    ├── PLAN.md               # 方案与设计定稿：分层、池与路由、配置面全清单、实施顺序
    ├── retry-policy.md       # 自有现行文档：429 教义
    ├── sensenova-api-reference/   # 商汤官方文档逐字副本
    └── upstream/             # token-plan v0.8.3 原文参考件
```

## 致谢

本项目站在这些 MIT 项目肩膀上（谱系与许可细目见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）：

- [dsh-connect-sensenova-token-plan](https://github.com/eghrhegpe/dsh-connect-sensenova-token-plan) —— 骨架主体：控制台登录与令牌续期、额度面板与用量胶囊、发布状态机、doctor
- [dsh-sensenova-provider](https://github.com/alaxrpg/dsh-sensenova-provider) —— 协议层的 responses / chat 两线与请求执行骨架
- [dsh-sensenova-freeapi](https://github.com/modesthub/dsh-sensenova-freeapi) —— key 池的运行 / 阻塞双列表状态机
- [dsh-sensenova-vision-aid](https://github.com/modesthub/dsh-sensenova-vision-aid) —— 读图桥的结构蓝图
- [dsh-sensenova-image](https://github.com/JE668/dsh-sensenova-image) —— 出图端点对接事实参照

## 兼容性

DSH 0.2.x（开发与验证基线 0.2.0；重试键核对至 dsh-llm 0.2.0-rc.2），Node ^22.19 || >=24。peer 依赖（@deepseek-ai/* 一族与 @earendil-works/pi-ai）由 DSH 宿主运行期提供；react 仅 devDependencies（类型用），运行时由宿主 loader 移交。

## License

MIT