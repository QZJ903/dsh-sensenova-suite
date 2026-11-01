# 更新日志（Changelog）

## 0.1.42（2026-11-01）

- **U2 审计修复轮（协议链 wire，四批处置 + N1 真机定论，台账全终态）**：
  - **glm 勾「关闭思考」走 an 线必 400 双层修（D1，拍板 B「用户选择大于协议」）**：`anthropicEffortOut` 对任何模型的 off/none 一律产出 `thinking:{type:'disabled'}`，而 GLM-5.2 文档明写「thinking.type 不支持 disabled，传入该值将导致请求失败」——档案 `forbidThinkingDisabled` 声明了却无消费者，400 后 glm 被误标 anthropicUnsupported、整条 an 线进程级失效。修=①`body-anthropic` 消费档案标志（禁 disabled 模型不发任何思考字段，第二道防线）；②`plan` 走查新增降级条件 `downgrade-effort-unsupported`（off+禁 disabled 显式跳过 an 落下一线——与 downgrade-image 同形状：线表达不了的请求特征换线，off 语义全链兑现）。kimi/deepseek-flash/6.8 不受影响（an 线 disabled 合法）。
  - **an 线 usage 口径真机定论并修复（N1，探针判定 C）**：`/v1/messages` 的 `input_tokens` 是**未缓存口径**（真机三连发：118+1536=1654=全量输入，input 与 cache_read 并列，Anthropic 原生规范）——此前把 responses 的减法（OpenAI 口径 input 已含缓存）推广到 an 线是误推广，缓存热时 118−1536 为负、被 `Math.max(0,…)` 钳成 **0**（未缓存输入恒显示 0）。修=`mapAnthropicUsage` 直取 input_tokens；totalTokens=input+cacheRead+cacheWrite+output（含缓存全口径，与 chat/responses 平台 total 对齐）。三线口径自此分立注明：responses/chat 减法对（OpenAI 口径）、an 直取对（Anthropic 口径）。
  - **mergeUsage 丢字段 + total 口径漂移（D2）**：头注声称「缺字段回落旧值」只兑现一半——message_delta（规范只带累计 output_tokens）合并后 message_start 已得的缓存读写数字被丢掉、total 重算用未缓存口径与三线漂移。修=四字段统一「incoming 带了才取新值否则沿用」+ total 全口径重算。`mergeUsage` 纯函数化 `(state, incoming) → TokenUsage`。
  - **并行 tool_result 合并（疑似 1）**：宿主并行工具循环逐条 role:'tool' 直译成连续多条 user 消息，Anthropic 规范要求严格交替且同轮多 tool_result 载于同一条 user——商汤兼容层宽松度未知，按规范合并消除该前提（出站不再产生连续 user，两边平台都能收）。只合并「content 全为 tool_result 块」的相邻 user，普通消息不受扰。
  - **`WirePlan` 删 `chainIndex` 死字段**：生产零消费（adapter 400 下一跳按 `plan.chain.indexOf` 寻址）、唯一读者是测试钉，按 audit 纪律删除收窄为 `{wire, reason, chain}`；兜底 spread 覆盖 chain 的「防同线重试」机制注释落到发生处。WireReason 的 downgrade 词族保留（reason 语义空间合法值，留总审与 adapter 日志接线一起裁）。
  - **三线 usage 映射集中 + 补钉（T2/T3）**：`mapAnthropicUsage`/`mergeUsage` 从 sse-anthropic.ts 挪入零依赖的 `wire/usage.ts`，contract 新增 7 钉 peer-free 直测（此前三线 usage 零钉、an 线映射锁在 peer 可达面外）。钉构造中拒为无真机形状的合成场景（delta 单带 input 不带 cache_read）发明拆分假设。
  - **wire-chain 块 2 整体复活（T1）**：b6469b1 新增的 call_id 钉解构错字段名（`ciInput`，实际返回 `{instructions, input}`）——TypeError 卡死全块，**其后 12 项链走查钉从未在任何环境（含 CI）执行过**；块内另有期望值漂移三处（兜底 chain 期望旧形出生即红、kimi 链漏更两线、"standard model" 钉未传模型恒落兜底）。四处全修后经临时 junction（provider-master 真实 peer）实跑 **27 钉本机历史首次全绿**。
  - **防御与验证**：`content_block_start` 内联 input 只认对象形状（null 曾被 stringify 成 'null'）；typecheck 0 错 / contract 92 / duplication 14 / wire-chain 27 全绿；S2（目录 efforts 词表错位）经真机 catalog.json 实证销号、S3 降级存档（文档 :2886-2899 背书 assistant 历史条目概念）、N2 化解。

## 0.1.41（2026-11-01）

- **U6 修复轮（目录与供应商发布链，四批处置全清单）**：
  - **maxTokensOverrides 接回请求侧（P2，拍板 a'）**：文档天花板覆盖滞后目录的 2026-10-26 决定被 wire adapter 迁移静默弄丢请求半边——面板显示 393216/131072 而请求被目录压在 65536。现 `maxTokensForId` 单点判据（override > 目录值 > 不申报）接进 adapter `resolveModel`（每请求现读，defaultMaxTokens 经宿主传导三线），面板与请求同一判据同一 map；字段拼写表（上下文窗/最大输出）与兜底常数（128k→131072）单源化，双实现分叉消除。
  - **路由缝失败发布门控（D2）**：models/api-key 路由发布失败（`ok:false`）不再同步签名——此前「失败发布被签名固化 → 选择器冻结到重启」从路由缝回流（轮询缝/种子缝早有门控）；`Wiring.publishProvider` 返回类型收窄 `PublishResult`；routes.test 新段 O3 变异式钉。
  - **同端点漂移姿态统一（S1，拍板 β）**：`fetchModelCatalog` 对「200 无 data 数组」从静默回空改为抛错（与 adapter parseCatalog 同姿态）——旧形状会把 catalog.json 空覆写并重启播种空目录；合法空答案（`data: []`）不受影响。snapshot-aggregate L1 钉变异式验红。
  - **快照 offered 门控（顺带2）**：发布失败时快照 roster/counts 引用真在服务的对（`providerState.entries`），不再描述未生效的新目录；M1/M2 钉。
  - **死代码清理（顺带3 + 死导出 6 个）**：删 `toPiDescriptor`/`buildDescriptors`/`isModelEnabled`/`rosterOf`/`NO_COST`/`assertProviderOwnership` 与零消费者的 `AdapterConfig` 接口（pi-ai 描述符构建自 wire adapter 接管后无生产路径）；`resolveApiKey`/`get` 死参五处清除。测试面同批手术：活语义全部改由幸存函数直钉（thinkingLevelMapFor/identifyVisionModel/rosterWithAvailability），provider 255/contract 85/retry 25 全绿；duplication 陈旧白名单条目按门禁自身检测删除。**compat.supportsDeveloperRole 决策载体随删，wire 路径 developer-role 姿势归 U3 审计。**
  - **注释真相轮（D3/D4/D5 + 顺带1）**：doctor 幽灵症状段删除；Raccoon 第二上游叙述簇四处改真（收编裁定沿革）；「the removed module」死残句×2、arming 注释×2 改实指；DSH-PLUGIN.md 路由清单改六条实形 + 套件计数去硬编码。
  - **测试**：T2 行为钉（构建失败保留 offer 字段 vs 注册失败回滚，非对称自此有锚）；T3 peer 门控岛（真 adapter resolveModel 三钉，peer 缺席大字跳过、其余 import 错误照常红）；catalog-gate cachedEntries 注释补「成功空抓」态；provider.test 头注口径同步。

## 0.1.40（2026-10-31）

- **U5 审计修复轮（控制台鉴权与凭据链，两批全毕）**：
  - **拍板三落地**：`throttle.json` 过期窗条目**保留 attempt**（D2：parseParks 去时间过滤，`inForceWaitMs` 过期窗读 null；倍增梯不再每窗重置）；节流写盘失败的**进程内镜像**（D3a：`writeThrottle` 拒写/写失败时挂 `state.throttleOverlay`，`readThrottle` 读空回退——ADR-006 拒写窗内本进程继续守平台的等待窗，不再重新撞门）；登录表单**失败回滚身份**（S-Bc：persist-first 金丝雀保留，登录本身没落地时把 `USERNAME_REF` 写回原号/首装 unset——面板标题与自动重登链条不再指向没登录成的号）。
  - **假冷却 login_failed 后门双修（D7，N1 真机测试测出）**：表外 reason 兜底 LOGIN_FAILED 时旧闸仍会把它 LocalizedMessage 里的**条件式**锁定警告（"will be locked for 15 minutes after N attempts"，N 递减——16 份真机 trace 实证）读成 15 分钟真窗。修=①`retryWindowMs` prose 前置计数子句闸（只闸 `after N attempts` 子句，将来时真窗无子句仍解析）；②新 `TIME_SHAPED_REFUSALS={ACCOUNT_LOCKED,RATE_LIMITED}` 收窄窗闸——LOGIN_FAILED 语义未知不信任 prose，走本地退避梯。
  - **其余五修**：acquire 登录兜底前探测 grant 记录可读（S-A：凭据服务读故障不再烧一次真实密码登录，无码不 park）；相对 `Location` 一族（S-C：`paramOf` 相对兜底 + `followUntil` 逐跳以发跳为基归一——带 code 的成功流不再被误判 login_flow）；IAM 登录路径段 `iamLoginPath` override 点（S-D，默认形状不变）；非 JSON 体与 sanitizeUrl 逃生口的值形状擦除（S-E/S-F：JWT/sk- 自由文本不再穿透，双解析失败不裸奔）。
  - **清理**：死迁移键（THROTTLE_MARKER/THROTTLE_KEY/LEGACY_ACCOUNT_SLOTS/ACCOUNT_RECORD_PREFIX）与三处「收养后清扫」失实注释（D1）；`rejected.clear()` 移入 activate 分支——add 模式不再抹掉活动 grant 的 401 记忆（D4）；switchAccount 无快照防御路径过 park 闸，判据抽 `throttleGateError` 单源（D5，拍板③补齐）；假定令牌寿命 `ASSUMED_TOKEN_LIFETIME_SECONDS` 单源三处同用（D6）。
  - **路由与文档**：switch **失败**路径同样清 coalesced 缓存（快照路径失败时身份已可能换人）；三处「添加模式不验证不登录」旧话术修正为「验证但不接管」现状（路由头注 + 面板注释 ×2）；trace 0600 的 Windows 语义说诚实。
- **新套件两份（peer-free）**：`account-route.test.mjs`（switch 成败都清缓存 + reportAuthFailure 契约 + GET 无秘密）；`coalesced-fetch.test.mjs`（代际闸并发语义六钉——单飞/清场不 join/迟到写不可见/迟到落场不清继任/per-key 清场，N2 宿主半边，该机制此前全仓零钉）。
- **钉 21 条**：account-vault 场景 9–14（回滚两形态/park 闸/拒绝记忆/attempt 梯/拒写镜像/存储读故障）；auth.test 7e–7h（相对 Location 两走查变体、值形状擦除、iamLoginPath override、D7 双层）；config.test D6 源钉。
- **冻结基线重生成 ×2**（reason 留档）：S-Bc——S3「parked refusal survives a restart」的失败登录不再残留 `refs.$USER`（旧形状=身份挂在没登录成的号上）；S-A——每个走 acquire 的场景 calls 多一次探测 readRecord，无 result/refs 变化。
- **N1 真机实测（写进台账）**：凭据拒绝两拼写真机 parked ✓；IAM 拒绝**无 Retry-After 头**（探针全量头）；条件式警告形状与递减计数实锤。

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
