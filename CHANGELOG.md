# 更新日志（Changelog）

## 0.1.39（2026-10-31）

- **U7 修复轮（状态落盘原语，两批处置）**：
  - **诊断日志打开路径自愈（P2）**：openTraceFile 首写 BOM 无目录守卫——全新安装/新
    profile 首挂/清过 state 目录时 ENOENT 从 apply() 打出、整插件挂载失败且自锁
    （store 写点全在挂载之后，目录永远没人建）。现先建目录（0700）；目录建不出来/
    首写失败退化为 no-op sink（纯 console），挂载绝不被诊断文件打穿。
  - **EPERM 搁浅 temp 收扫**：Windows 上 rename 撞 EPERM/EBUSY 保留 temp 报成功，
    旧注释声称「下次写回收」但全仓无任何清扫（真机实证：10-27 一份 1076B 的
    pool.json temp 搁浅四天仍在）。现每次写前收扫**本进程**同名过龄 temp（60s
    窗口保住在飞写、pid 即所有权证明；他进程与跨生命期残留不动）。
  - **profile 分段判据与宿主对齐**：旧 ASCII 白名单把宿主完全合法的 CJK 等非
    ASCII profile 名静默打回共享目录（两个 profile 互踩——宿主 resolveProfileDir
    只拒空、`/`、`\`、`.`、`..`、`node_modules`，asar 实证）。改宿主同款黑名单 +
    多挡一层控制字符；doctor 的目录扫描随之覆盖 CJK profile。
  - **pool-store 拒绝表面化 + 变更串行化**：ADR-006 拒绝（盘上是更新构建写的
    pool.json）从静默 no-op（面板显示已保存、缓存 TTL 过期回跳旧值）改为抛拒因
    走路由 ok:false（provider-store 同款；全部写点核实都在路由面）。八个变更方法
    入 promise 队列，并发变更不再互相整份冲掉（面板多 tab、动作与分区保存并发）。
  - **PITFALLS §23 去硬计数**：「全部 6 个带版本 store」改为不按个数引用（pool 与
    token-store/accounts 其后并入同一原语，计数已漂移）。
  - **测试**：新增 peer-free 套件 state-store.test.mjs（11 钉：分段黑名单/原子写
    往返/temp 收扫）；pool.test 3 组新钉（未知版本抛因+磁盘不覆盖、三并发变更全
    落盘——修复前必红、拒绝不毒化队列）；trace-log 新钉目录缺失先建/建不出退化
    no-op；provider 8c 与 state-segmentation 源码钉随黑名单同步。

## 0.1.38（2026-10-31）

- **U1 审计修复轮（共享契约与基础件）**：
  - **工具开关缺键行兜 true（拍板）**：`text2imgEnabled/img2imgEnabled/visionToolsEnabled` 旧 `=== true` 让缺键行静默关工具、CONFIG_DEFAULTS 声明的 true 形同虚设（patch 行显式 true 只兜住首装）——改 `!== false`（只有布尔 false 是「关」的拼法），catch 路径同步回落默认；「首装默认全开」拍板在 resolver 真正生效。
  - **globalConcurrency 载入零值**：新增 `resolveGlobalConcurrency`（与 `resolveProviderRefreshMinutes` 同形）——旧 `clampInt` 底座的 `num` 把显式 0 读成「未设」回落 2，「0 = 跟随 key 数」从配置面不可达（闸门处 0 语义真实存在，orchestrator 默认值注释明写「index.ts 归一化」）；面板缝保留 0、配置缝不可达的两缝矛盾消除。CONFIG_DEFAULTS 注释同步删过时「（默认）」括注。
  - **consoleBase/apiBase URL 形状闸**：坏 origin（`"https://"` 被尾斜杠替换吃成 `"https:"`）从「每次 fetch TypeError → console_error（usually transient 措辞误导）、永不进 configError」改为 configError + catch 回落安全默认；`isHttpOrigin` 放行回环 http（e2e 假平台不受影响）。
  - **normalizeAccounts 重 id 去重**：id 是池管理/显示的索引键（phaseById、disable/restoreById 都按 id 作用）——重 id 先到先得、保留 id `default`（面板主 key 恒占）撞名丢弃；两行同 id 串号（phase 显示折叠、管理操作指向不明）堵死。
  - **maskKey 短键全遮**：≤8 字符原样返回全文 → 等宽 14 点串（U+2022）——掩码函数的兜底不得是「原样给出凭据」。
  - **redactSecrets 规则 2 加 `/i`**：全大写 `AUTHORIZATION:` 值不再漏网（真机日志零样本的理论缺口；规则 1/3 早已 `/gi`）。
  - **errMsg 防抛**：无原型对象（`Object.create(null)`）没有 toString/valueOf，`String()` 会让这个「兜底读消息」帮手在 catch 路径自己掀翻（degrade/redactedError 捕到即崩）——失配退 `Object.prototype.toString` 报形状。
  - **Wiring 注释改口径 + import 门禁**：注释从「never by importing the service directly」（失实）改为实际纪律——实例走缝、无状态助手/trace 沉降点直连是**封闭例外清单**；package.test 新增路由 import 封闭白名单门禁（7 路由文件 39 条相对 import 全单，新服务直连即红）。
  - **kickThreshold 双默认归一**：key-pool 池层默认 2 → 3 对齐 orchestrator 层（运行时零变化——原本恒被 DEFAULT_ORCHESTRATOR_PARAMS 覆盖；直接构造池的测试路径 2→3）；`docs/retry-policy.md` §5 四常量定义处修正（原写 host-config.ts，实际 kick 在 key-orchestrator、probe 三件在 key-pool）。
  - **注释归位**：shared/wire.ts 两处 JSDoc 从 imageGen 头上挪回 multiplier、SnapshotData 总注释合拢；host-config 删除指向已删模块的占位句 "the removed module"。
  - **预存在红钉修复**：config.test「Wiring 字段数 19」钉在 0.1.34 加 `onQuotaPools` 时漏更——b6469b1 起 config 套件一直红（20 字段），19 → 20 并注明沿革。
- **补钉 25 条**（U1 审计测试缺口，提前于集中处置轮）：config.test 新字段缺键等式 7 + loaded-zero 行为 5 + 三开关关拼法 2 + base-URL 四态 4（+18）；pool.test 账户去重 2 钉 + kickThreshold 同形钉（+3）；redaction-closure 全大写 AUTHORIZATION + errMsg 无原型（+2）；pool-route maskKey 形状钉（+1）；package.test 路由 import 门禁（+1）。

## 0.1.37（2026-10-31）

- **responses 线 usage 对齐「未缓存输入」口径**：真机实测（glm-5.2，同一 body
  连打三次）`input_tokens` **已含** `cached_tokens`——`total_tokens` 恒等于
  `input + output`，缓存热时 cached 占输入 95%。初版直取会把缓存命中部分多报
  进未缓存输入（缓存热时 ≈20 倍），现改为 `input_tokens − cached_tokens`，与
  chat 线（adapter.ts mapUsage）、anthropic 线（sse-anthropic.ts
  mapAnthropicUsage）三线同口径；`total_tokens` 直取不变。
- **URL 图像限制由待实测改为实测结论**：prepareImages 的「URL 总量 200MB」注记
  改写——平台抓取失败形状 `code 3 "image download failed"`（302 跳转源与签名
  过期同形状）、平台抓外国源仅 15–25KB/s、视觉 token 与文件字节无关；200MB
  拒绝/放行形状留空（需国内快速源方可测到）。TODO 标记清零。
- **工具与名册头注**：repro-pool.mjs 去掉硬编码本机用户路径（参数 > 环境变量
  `DSH_SENSENOVA_POOL_JSON` > homedir 三级取值）；suites.mjs 头注去掉两处硬编码
  套件计数（名册增长防再漂，计数由 package.test.mjs 的钉动态管）。

## 0.1.36（2026-10-31）

- **responses 线 call_id 长度约束**：平台限 `call_id` 1–64 字符，宿主侧超长工具
  调用 id 原样透传被 400（`Invalid 'call_id'`）——链改 responses 优先后带工具
  历史的会话首次踩中。现空串/超长一律合成 `sensenova-sanitized-N` 短 id，remap
  表保证调用与结果用同一 id（关联不断）；合规 id 原样透传。chat 线不限长未动。
- **面板「恢复」后同步重解析池**：恢复与删除同一条重解析纪律——上次种池时该
  账号还在停用名单里被排除的话 idToKey 不认识它，restoreById 静默 no-op，面板
  永远「未入池」（真机实录）。恢复路由现在先摘名单再触发 refreshKeys，key 带
  最新凭据值回池。
- **断尾日志加 stop 维度**：anthropic 流断尾标记行带 `stop=N`（请求携带的停止
  序列数量），实证「平台命中 stop_sequence 时少发终止事件」的假设是否成立。

## 0.1.35（2026-10-31）

- **anthropic 断尾专用码 + 内存级换线降级**：平台 an 线时好时坏（流在 message_stop
  前中断）——新错误码 `ANTHROPIC_TRUNCATED`（peer 的 retryableCodes 不锁枚举，
  asar 实证后显式入名单可重试），适配器命中即把该模型记进 `anthropicUnsupported`
  （进程内、重启清除，与 400 运行时不符同池），重试与后续请求经 resolveWirePlan
  自动走生效链下一跳。本请求不原地重发（内容已流出，重发会重复输出）。
- **统一降级链 re→an→chat**：kimi/glm 的 anthropic 加回、分岔撤销（10-30 的静态
  排除由上面的运行时降级接管），再把顺序定为 responses 优先。三槽 UI 编辑态实时
  收窄同批落地。
- **速率桶形态免踢**：踢出阈值（连续 3 次）只计重形态 tpm/endpoint/account；两个
  速率桶形态 code 8（rpm 桶本体）与 429003（`rate-soft`，观测多呈 rpm 快速自愈）
  轮换但不计数——贴线限流不再把健康 key 踢出池。判据单一来源
  `rateKindCountsStrike`，对话链与识图/出图链同取。429 日志 kind 显示区分
  rate/rate-soft。
- **目录抓取降级（catalog-gate）**：目录 10s 超时进 60s 退避期后，旧实现回空数组
  （「加载失败后模型列表空白干等一分钟」）——现退避期内空缓存先回落模块级种子
  （同凭据同端点），再每段退避期补发一次（补发再失败安静到期，防秒级循环不变）。
  判定抽纯模块 `catalog-gate.ts` 单测钉。
- **429 日志格式**：去 sid（几乎用不上）；换 key 行写出真实过渡链
  `旧key → 新key`（首版误打两个新 key——apiKey 赋值先于打印，已修）；识图/出图
  链 429 口径同步（unknown/速率桶不记 strike）。
- **chat 后截断**：chat 是参考方言、无降级条件，链走到它即服务——其后槽位是
  永不可达的死位。存储层（pool-store 归一化）与生效合成层（sanitizeChain）经
  同一 `truncateChainAtChat` 截断，面板编辑态选中 chat 实时收窄（与选空同款），
  `applyChainSlotEdit` 抽纯函数同源钉。

## 0.1.34（2026-10-31）

- **429 分类订正（交接文档 5 §四）**：`insufficient_quota` 从池类特征串移出，
  按 code 归 tpm 档（上游 freeapi 实测：命名误导、message 同为 tpm/rpm 限流措辞，
  实为速率限流）——归池类会把速率窗误记成积分格、组内全中招时错误快速失败，
  而实测换 key 能绕开。**删 `buildRetryPolicyConfig`**（零生产读者、已与
  `adapter.ts` providerRetryPolicy 的内联字面量漂移；连带删 retry.test 相应段）。
  **识图/出图链 429 口径对齐对话链**：unknown（形状不明）不再记 strike，与
  key-health 教义一致——两条链共用一个池，识图侧曾能把对话侧按教义保下的
  key 记满踢出。
- **key 路由三修（池格写读同组 / 亲和复活 / 额度驱动写点）**：
  - 轮换契约带上模型：`rotateApiKey(key, rejection, model)`，池格的组由
    `groupOf(model)` 现算——此前写侧硬编码 general、读侧按请求组查，专属池
    模型的格子两边都落空（专属池耗尽拦不住自己，反而误伤通用组健康 key）。
    `groupFullyPoolMarked` 首次接线：全池标满直接快速失败，不再借被标记的
    阻塞 key 硬试。
  - 会话粘性判据从组名清单改「组 ≠ general」：0.1.18 分专属池改组名时判据
    漏改，亲和自那时起静默死路。orchestrator 死默认表与 host-config 运行时
    默认表对齐 + pool.test 同形钉。
  - 额度驱动的池格写点 `reportQuotaPools`：发布链每次额度轮询成功（失败不喂）
    按池剩余记/清格——耗尽记格、回正清格、混合态不动，30min TTL 降为兜底。
    覆盖边界：额度数据是 console 登录账号的池子，多 key 部署在活动账号身份
    暴露前宁可不标也不错标（单 key 部署无歧义放行）。

## 0.1.33（2026-10-31）

- **每模型降级链（全量制，用户拍板）**：模型设置「协议降级链」列（原「协议」）
  升级为三槽降级链（anthropic > responses > chat-completions 全名直出、槽间
  箭头示序；不重复、选一个少一个、槽 2 可空、槽 3 在槽 2 空时禁用——**置空的
  槽本身保持可编辑**，0.1.32 内测发现的锁死 bug 已修）。每模型恒有链。生效链 =
  面板覆盖（pool.json `modelProtocols`，仅存写过的模型）?? wireProtocol 配置
  （强制值映射单线链；auto = 档案默认）?? 档案默认链（常规 an>re>chat；
  **kimi/glm = re>chat**——2026-10-30 真机实测 anthropic 线空流/偶发空流；
  能力面 supportedWires 不动，平台修复后面板可手动加回）。
- **链走查 + chat 兜底**：决策沿生效链找第一条「能力面含它且未命中该线降级
  条件」的线；链上全部覆盖不了该请求 → 落全局兜底链（单 chat，三线中表达最
  全、无降级条件）——链耗尽常态不再报错。**400 下一跳沿生效链取**，链耗尽
  同样落 chat。旧「强制模式命中降级条件抛错」语义随本模型退役（被 chat 兜底
  吸收，用户拍板「不至于一直报错」）。
- **面板**：协议链只提交变化了的模型（判脏逐条比）——全量覆盖会把没改过的
  模型钉死、档案默认的后续修正被存量冻结；快照下发 host 合并好的生效链
  （策略不进 client bundle）。0.1.31 的字符串覆盖值读取时兼容为单线链，
  "auto" 值视为清除。
- **倍率默认值换实测值**：trendMultipliers 出厂默认从移植源的拍脑袋值
  （glm ×10 / kimi ×20 / 商汤与 deepseek ×1）换成 2026-10-31 运营者实测——
  kimi-k3 ×30、glm-5.2 ×15、deepseek 两模型 ×1、商汤（sensenova 族）×0.8；
  badge 与消耗趋势共用同一匹配器，一处改两处生效。
- **429 日志文案三分 + 轨迹账本**：旧「429 换无可换」对 rate 类是张冠李戴（rate
  是设计上不换 key——换也一样限速，不是没得换）→ 三分文案（rate 不轮换 /
  换无可换 / 未轮换 quotaRotation 未开）；新增 per-session 轨迹账本，「已试 N/M
  把」从单跳轮换计数改为**跨宿主重试累计的脱敏 key 列表**（成功即清），一次
  请求试过哪些 key 一行可读（他问「都试了吗，试了哪些 key 怎么不写出来」）；
  **恢复行放宽到 rate 类**（连续 N 次限流后成功）——限速窗口时长直接可读，
  不再靠账本重置反推。
- **UI 微调（验收批次）**：保存成功绿字精简为「已保存。」；输入框用量胶囊的
  档位圆点光学居中（CJK 墨迹偏行框下方，+1.5px 补偿，DevTools 实测定值）。
- 新套件 `wire-chain.test`（pool-store 链解析 5 钉 peer-free + 生效链合成/
  链走查/chat 兜底 12 钉 peer 门控）；render 钉改三槽形状；合成逻辑抽
  `wire/chain.ts`（peer-free，快照与决策共用一份实现）。

## 0.1.31（2026-10-30）

- **每模型协议覆盖回植（0.1.19 删除令回植，从 0.1.18 逐块移植）**：面板模型卡
  新增「协议」列（自动/anthropic/responses/chat-completions），按模型把 wire
  钉死或跟随全局链序；存 pool.json `modelProtocols` 分区（解析时四值白名单
  过滤，"auto" 即清除），适配器每请求实时读取，保存即生效。决策链本体不变
  （auto 仍 anthropic→responses→chat-completions）；anthropic 线不稳定的模型
  组合（真机实测 kimi 空流、glm 偶发）由面板逐个拨到可用线。
- **三线流级诊断留痕**：三个 SSE 解析器（anthropic/responses/chat-completions）
  的流级失败每个落一行 traceLog——断尾、停摆/超时、中途失败、空响应，带
  wire/model/已收字节数/完整原消息；responses 与 chat-completions 的宽限断尾
  收口（无终止事件按 stop 收口）同样留痕，与正常结束可区分。聊天里看到的每条
  流错误在诊断文件必有一一对应行；超壳 abort（用户离开、重试层换请求）不落。
  背景：真机 0B 空 200 流（平台掐流新形状，400 降级判据接不住）此前全程无现场。
- **诊断行带 sid 会话关联**：全部流级行与 429 行（429/恢复/换 key/换无可换/
  wire 400）加 `sid=`——取 options.sessionId（粘性换 key 已依赖其跨宿主重试
  稳定），同一逻辑请求的重试序列一眼可辨，跨会话并行请求不再混淆；同会话
  先后请求靠时间戳区分。
- duplication-gate：adapter↔sse-anthropic 同构骨架白名单 34→35（流级诊断行进
  catch，三解析器刻意平行 +1 行）。
- CLIENT_BUILD 行尾历史替换事故积累的分号清理为单分号。

## 0.1.30（2026-10-30）

- **登录冷却按账号分钥（用户拍板）**：park 记在用户名上——B 号的密码错误不再
  挡 A 号的重登。三规则：①门按人查（acquire 先解析账号再查该号的 park，
  续期不受 park 管辖——park 的含义是「密码错了」，续期不用密码）；②清按人清
  （面板重新提交只清该号；成功登录清自己）；③切号不清门（切到 parked 号当场
  报错，不清门、不消耗平台尝试）。throttle.json 升 v2
  （`{version:2, parks:{用户名:冷却}}`，无迁移）；HeldThrottle 带 username；
  面板倒计时/需要改密码跟随当前活动账号。节流存储缺省改为内存版
  （注入缺席时保护不缺席；跨进程共享仍由 index.ts 显式注入文件版）。
- account-vault 套件 22 项（新增分钥三钉：B 的 park 不挡 A 重登、切到
  parked 号报错、park 仍在且不消耗尝试）；冻结基线随门序变化再生成。
- **添加模式升级为「验证但不接管」**（真机实测零验证的两处事故：错密码照样
  保存成功；切到坏条目把当前会话顶掉）：登录一次验证凭据并落令牌快照，
  错密码当场红字报平台原话、不落清单、该号进冷却（分钥）；活动槽/身份/
  当前会话不动（密码登录开新会话，不轮换当前刷新令牌）。
- **切换先登录后动会话**：无快照目标先登录成功才动会话（失败旧会话原样
  保留，孤儿会话从机制上关死）；有快照目标维持安装+当场验货，失败时旧
  会话已回写清单可一键切回。
- **假冷却修复**：平台错密码响应原文带条件式警告（"The account will be
  locked for 15 minutes after 4 attempts"——警告未来错误，非当前窗口），
  窗口解析器把它当成了生效窗口 → 面板 10-15 分钟假冷却（网站能登=平台
  没锁）。修复：retryAfterMs 只挂在时间形拒绝上；警告原文改走 detail 栏。
- **平台 detail 模式翻译**：已知警告模式转面板语言（数字插值，中英成对），
  未知消息原文兜底。
- **表单冷却按账号分**：Qiubaba1 的平台窗口不再禁「添加别的号」的提交。
- 账号卡移除按钮红字 + 宿主 Modal 二次确认；登录成功同时清空用户名。

## 0.1.29（2026-10-30）
