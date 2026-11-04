# 更新日志（Changelog）

## 0.1.52（2026-11-04）

- **U12 入口装配与生命周期审计处置全清（纯装配单元，台账代码侧零挂账）**：
  - **D1（P2）面板「多模态」三工具开关死门**：工具注册门 `settings.X || pool.X === true` 的 OR 门遇上配置默认 true（解析 `!== false`）→ 面板写 false 恒被短路——开关显示已关、工具照常注册，重挂还空转一轮；识图/转述开关（relayOn）同型。与两处契约文字双向矛盾（client「宿主注册 gating 只认 toolsEnabled」、pool-store ToolsEnabled「面板为主设置；配置为部署默认」）。拍板**案 A（tri-state 面板优先）**：`effectiveToolEnabled(saved, patchDefault)` 进 pool-store 生效视图家族（与 effectiveVisionModels 同区），relayOn / enabled() / anyEnabled 三处门换装（anyEnabled 改由 enabled() 派生 = 单一事实源）；「未存过=patch 默认、存过=面板说了算」与面板显示基 savedBool ?? fallback 同构，client 注释自动成真，面板侧零改动。pool.test +3 三态钉；routes.test 新节 R1-R4 端到端钉（自建带效果捕获挂载桩——原 mount 的 `effect: () => () => {}` 把效果整个丢弃无法驱动）：R1 首挂两工具（patch 默认）/ R2 面板全关→重挂零注册（anyEnabled 全关分支首次被真实路径踩到）/ R3 单开只回一个（存下的 false 继续压住另一个）/ R4 卸载后保存触发的迟到重挂被守卫拦下。
  - **S1 卸载竞态 ghost tools（防御门）**：重挂链可能跨越卸载时刻——cleanup 先跑掉此刻（空）的待清理清单，链继续把新工具注册进已卸载的宿主且无人认领。effect 闭包加 `disposed` 标志，链首 + 注册前各查一次过门即弃；cleanup 先立门再拆注册、拆后清空清单（防御性：宿主对 register-after-dispose 的行为未实测，R4 钉钉住插件侧语义）。
  - **D2 toolEnabled 死参数**：index 构造传给 buildToolset 的开关参数，接收方 body 从不读它（同开关事实的两道门，一道是 D1 的坏 OR、一道不通电）——连 arrow 带参数带 JSDoc 整根删。
  - **D3 poolAdmin.accounts 死装配链**：PoolAdmin 接口声明 + index 装配俱在、pool 路由 29 处消费零调用 → `accounts:` 注入 + listAccounts + accountLabel 三件传递性死码删，接口成员同步删（Wiring 经接口引用自动自洽）。
  - **D4 挂载重试簇整体死码 ≈110 行**：retryBounded + SERVICE_RETRY_ATTEMPTS/_DELAY_MS + resolveServiceWithRetry 全仓零调用——其 JSDoc 点名的全部调用方（registerDrawTool/publishVisionStepTwo/web-search mount/seedRaccoonOnMount）死于 2026-10 收编，工具未跟人走；U1 挂账「调用点核对」就此闭账（双双零调用）。
  - **D5 vision step two 残留注释五处**：机制已随收编拆除，index 头部模块表 / 整段「settings-row writer」注释 / 效果注册注释 / lifecycle JSDoc 四处改真话 + effects.ts 测试编号指错 F6→F8（初审漏 index.ts:608 一处，处置重锚定时补上）。
  - **S2 裸 ctx.get 收编**：index.ts:427 是全文件唯一不经 getService 的服务读取 → 换 getService 同款包裹（注释点名）；**前置验证按拍板撤**（修法保留——探针只会回答「旧代码当时是否真危险」，无可行动结果；抛错语义属宿主 cordis 契约）。顺带 4 同批销号（bridge.ts:191 只防 undefined 的隐患，触发前提=无 llm 的 DSH 形态不存在）。
  - **N1 维持真机验证点**：双 profile 同进程共享 trace-log 全局 sink（setTraceSink 后挂载者赢）——仅两 profile 加载同一模块实例（同 realpath）才触发，文档场景路径不同不触发；单 profile 机器直接销号。
  - 测试：typecheck 0 错；pool（+3）/ pool-route / config / vision-image / panel / render / duplication / snapshot-aggregate / contract / store 全绿；routes 148 查 6 红系 0.1.51 基线预存在名单逐字一致（本轮 R1-R4 全绿零新增）、wiring :204 崩截死 F8 钉系预存在领地（0.1.49 起，另行挂账）。真机生效 = 完整重启 DSH。

## 0.1.51（2026-11-04）

- **U11 面板业务块审计处置全清（代码侧零挂账）**：
  - **D1（P2）thinking「全取消档位」删不掉**：面板把清空的模型从保存载荷滤掉 × 宿主 setSection 按键合并 → 旧档位原地复活、勾选静默还原（宿主半边 pool.test 钉着「显式空数组尊重用户选择」——两端语义相反）。复核升级：存储模型根本没有「显式零档位」拼法（thinkingLevelMapFor 与 adapter withUserThinking 都把空数组折叠回全档位），拍板**案 A**——UI 禁止取消最后一档：`lastLevelGuard` 导出纯函数 + 档位复选框接线（可看图无此守卫，visionModels 显式空数组是宿主尊重的合法状态）；render.test 真钉四断言+lastLevelGuard 五断言，均变异验红红→绿；facts.ts「面板全不勾的保存不被翻案」半截注释对齐真话。
  - **D2 saveConcurrency 吞错**：并发数保存失败一律报「无法连接本机 Host」→ catch 取 errorText 原文 + non-JSON 4xx 给 routeMissing 文案，与 act()/多模态 save 三处同款。
  - **D3 并发框回车隐式提交**：并发输入框回车触发外层表单提交、空 apiKey 误报「请输入 sk- 开头的 API Key」→ onKeyDown preventDefault + **回车=保存并发数**（与备注框同语义；同 2026-10-25 备注框实测过的坑，三常驻输入框补齐守卫）。
  - **S2 目录缺已存模型 id 下拉脱档**：出图/转述「默认模型」下拉下补提示行「已保存的模型不在当前目录中」（mm.savedModelMissing，zh 逐字拍板 + en 镜像）；saved 为空走 fallback 不提示。
  - **死字段清理（拍板「删」）**：快照三字段 catalogAvailable / catalogModels / uncountedModels 与 roster 行 thinkingLevels 整删（UI 消费者分别随 2026-10-27 PoolCard 详情折叠块删除消失/从未存在；字段兼在无存储场景下说错话）；**thinkingOverrides roster 注入链六跳端到端拆净**（index wiring → Wiring 类型 → routes/snapshot 签名与传参 → buildSnapshotBody 形参 → rosterWithAvailability 第 4 参 → 产出）——适配器侧 thinkingView 链独立保留（grep 实证分界）；测试六文件同批手术：provider 行键集钉、retry 行级钉删（supportedThinkingLevels 直测钉保留）、routes Q2/L2、render fixture、e2e 四检查、snapshot-aggregate H1/H2/H4 改写（replaceCalls 写数语义全保留）。
  - **GET /pool 单源对齐（顺带1 案 a）**：GET 行改走 `poolAdmin.keyRows` = index 的 poolKeyRows **本体**（原 GET 的 label 装备注、无 note，与快照投影语义相反且零消费者的潜伏分叉）——PoolAdmin 接口 + index 注入 + pool-route 桩同步；pool-route 29 项（+2 形状级钉：无凭据行 label 回落 id+note 字段在、有凭据行 label=maskKey）。
  - **N1 销号 + 注释对齐**：用户真机口径确认**计费排他映射**（6.8-flash-lite 只烧专属池、其他模型只烧通用池、不串）——poolFor「专属优先于 live 池」推断与 poolHit「本模型计入此池」断言成立；poolFor 四断言直导钉（render.test，活性先于专属/满表让位/limit 0=unknown，变异验红）；poolFor JSDoc 过期 hedge 改确认口径。
  - **i18n 残胶清理**：四块 raccoon 时代孤儿注释删（浣熊单位/「1 新模型」chip/字典尾部零倍率+QR walk 孤儿块/en 镜像）——描述的键均已不存在；composer.planPrefix 注释刻意保留（键活着）。
  - 测试：typecheck 0 错（3 配置）/ render 174（+2 真钉，均变异验红）/ pool-route 29（+2）/ provider 256 / contract 92 / retry 24 / panel 78（zh/en parity）/ snapshot-aggregate / duplication 14 全绿；routes 与 e2e 删钉面本机结构性 SKIP、node --check 语法过。真机生效 = 完整重启 DSH。

## 0.1.50（2026-11-04）

- **U9 视觉与出图链审计处置（台账全部终态零挂账，仅能力覆盖双层注入一笔转总审）**：
  - **D1（P2）读图桥 lastGoodKey 401 粘死**：上次成功的转述 key 被撤销/面板删除后，每次转述仍从它起步——401 不触发桥内换 key（换 key 仅 429）也不清记忆，`resolveKey` 永远轮不到，读图桥全链静默失效直到重启。修法与 image-tools 的 401 清 lastGoodImageKey 同形（0.1.48 批 H 桥侧漏改，本轮补齐）。
  - **D2 两条诊断行改真话**：① bridge 走向日志改为分支定局后打（原生发图 / 转述关闭（原样放行）/ 转述）——旧版先打「转述」再判 relayOn，开关关闭时日志失实；② adapter「换图后仍携带图片块」诊断条件**从未触发过**（`contentHasImage` 参数是块数组、旧写法把消息数组整体喂入恒 false），改为逐消息取 content 查 + 归因文案中性化（勾选=预期原生；未勾选=转述关闭或块无附件引用）。
  - **D3 观察缓存加上限**：`OBSERVATION_CACHE_LIMIT = 200`（FIFO 按插入序淘汰，`cacheObservation` 收口写侧）——进程级 Map 此前无界；被淘汰的图下轮重转述一次，正确性不受影响。
  - **D4 describe 下线残留清理**：`vision/image-input.ts` 整文件删除（运行时归一化链全仓零消费者，`ImageAttachmentRef` 类型随唯一消费者迁入 bridge.ts）；direct.ts 删 `imagePart`/`envelopeFail`/`PostChatOptions.now` 死码；**visionImageMode 配置面全链删除**（host-config 解析/默认/类型 + index 写点 + VisionOptions 字段——运行时零读者的安慰剂开关，唯一消费者 imagePart 本身已死）。
  - **D5 注释改真话**：「peer 依赖半区 / defineTool 包装」四处失实表述清除——上游 lib/index.js 同为裸对象注册，defineTool 从未存在过；index 能力覆盖注释改「恒开、装一次」。
  - **他拍板三项落地**：img2img schema 补 `maxItems: 5`（平台「至多 5 张」入调用侧契约，不跑注定 400 的往返）；postImage 补 `redirect: 'error'`（与 direct.ts postChat 同纪律——跨源重定向剥 Authorization / POST 转 GET 丢 body）；visionToolsEnabled 补语义漂移注释（describe 下线后唯一读者是 relayOn）。
  - **销号两笔**：S1（response_format 系请求参数不存在「平台忽略」——他裁定结案）；S2（真机日志多处 N=M 实证宿主 image 块恒带 attachment ref，无附件块无实际可达面）。
- **测试**：vision-image 22→29（+桥 401 失效记忆 3 钉 / 缓存命中 / 失败不缓存 / 空 id 跳过 / relayOn=false 零请求 4 钉）；typecheck 0 错；scope-check 101 文件 0/0/0。真机生效 = 完整重启 DSH。

## 0.1.49（2026-11-04）

- **协议线档案三连修（文档口径被真机逐个推翻的收口，全部他拍板）**：
  - **responses 线 input 条目恒带 `type:'message'`**：真机 400 实证——混入 function 项的数组里 role 条目缺 type 即 `missing input.type`（MissingParameter）；文档两套形状并存（基础示例不带/工具流带）且对「tools 在场但数组尚无 function 项」的第 1 轮沉默，**方案一无条件补齐**消除漏判窗口。re 线文本对话自此真机可用（此前自 10-31 re 首发以来带工具会话轮次 ≥2 必 400 → 运行时标记 → 滑向 an）。
  - **glm-5.2 `forbidThinkingDisabled` 翻 false**：真机 curl `thinking:{type:'disabled'}` 打 /messages 得 200 推翻文档判据（11-01 时代一次真机 400 互证过、真因已不可对质）——an 线关闭表达恢复，an 优先链 glm+关直接服务；6.8-flash 不动（平台行为，档案唯一 true 载体）。
  - **kimi `noneMapsToThinkingDisabled` 死分支整根拆除**：gate 全档案 false（10-27 实测 `thinking:'disabled'` 被平台 400 invalid arguments code 3 拒）从未触发，chat 线 `thinking` 字段出站 spread 随删——「从不构造 thinking 字段」的注释从此名副其实。
  - **`anthropicSupportsImages` 整字段撤档**：文档「仅 6.8-lite 支持图片块」被 deepseek-flash/kimi-k3（10-27）与 6.8-flash（11-03）真机三度推翻、档案三次被迫翻 true——降级分支与字段全删，an 线收不收图由「可看图」勾选（换图器边界）与运行时 400 探测决定。
  - **标准链倒序 `an→re→chat`**：re 线推理档位传入无效（文档称兼容 low/medium/high/xhigh，实际后台恒用 `reasoning.effort:"high"`）——推理档位保真优先走 an（`output_config.effort` 词表真实五值）；an 的空流/断尾由运行时降级兜底（ANTHROPIC_TRUNCATED/400 内存级标记换线）。10-31 曾定 re→an>chat。
- **轮转与并发闸修复（真机 90s 静默挂起事故驱动）**：
  - **轮界推进漏放并发槽**（`release` 变量被循环顶新 acquire 覆盖）：上一轮最后一把 key 槽位永久泄漏——limit=1 下第 7 发排队 90s 静默超时、宿主 10 次重试全数撞墙 ≈15min（真机 19:04 日志逐拍对齐）。轮界 `continue` 前补 `release`。
  - **并发闸排队超时补 traceLog**（此前零痕迹——事故排查瞎掉的原因）：`并发闸排队超时 model=… key=… 等=90s`。
  - **tried 下推为池的选择条件**：`pickNext` 加 `borrow` 选项、rotateApiKey 透传 `tried`——轮内恒遍历未试运行态 key，轮长=未试数（2026-11-03 真机 R2 只试 3 把缺 4R 的缺轮形态从结构消失：池共享游标 `lastPicked` 交回已试 key 不再截短轮长）；**阻塞 key 不进轮询**（borrow:false——10min 时间门专属，批 D「不因真实探测消耗 rpm」驻留设计不动），池空保底借用走 pickStart 路径不变。
- **U3 台账拍板处置全清（8 项，D3/S1 等总审、顺带⑧ 拍板维持）**：
  - **D1 两件套**：`listModels` keep 过滤加 failedModels 读侧兜底（下线模型不再被播种劫持 24h 续命）+ 404 失败缓存只随 apiBase 失效（换 key 不再清——下线是服务端路由状态与 key 无关）；缓存命中仍要求凭据+端点都没变。
  - **D2a**：`status>=500` 与 529 overloaded 归 **SERVER 档**进宿主重试名单——SERVER 从零生产者变为 5xx 的家，「重试通常可恢复」从此是真话；4xx 维持不重试。
  - **D4**：重试封顶单源（`QUOTA_RETRY_AFTER_CEILING_MS = PROVIDER_RETRY_AFTER_CAP_MS` 别名 + export 上钉）。
  - **D5**：llm-adapter 死变量 `snapshot/accountCount` 与失实注释删除。
  - **D6a**：`LLM_CODES` 完整码表单源化——adapter 14 处裸码全清（每码计数断言脚本），`QUOTA_CODES` 注释的假承诺（「peer 改名会在 adapter 浮出」——peer 构造器就是 string、不导出码表）改真话。
  - **S2a**：抖动等待中 abort 原样透传（`throw signal.reason`）——用户按停止上屏取消原因，不再冒充「传输错误」。
  - **S3**：目录响应非 JSON（网关 HTML）包 `PROVIDER_PROTOCOL_ERROR`——全文件最后一个裸抛点关门。
  - **顺带①②**：concurrency.ts「60s」→「90s」、contract.test 头注改真机判定 C 定论。
- **验证**：typecheck 0 错；provider 256（+D2a/D1/D4/S3/S2a 五钉，含轮界泄漏钉变异式验证红→绿）/ pool 124（+noBorrow 两钉）/ catalog-gate 17（D1 判据钉翻新）/ wire-chain 28（junction 重建后真跑，含 glm 翻案/链倒序/responses type 钉）/ contract 92 / vision-image 22 / retry 25 全绿。真机生效 = 完整重启 DSH（验收清单：轮次恒 4 把、排队超时可见、工具会话 re 线不再 400、下线模型从选择器消失）。

## 0.1.48（2026-11-04）

- **429 池类误判全链翻修（真机事故驱动：4 账号 key 同秒连环被误判「池耗尽」→ 1 轮抛 ACCOUNT_QUOTA + 30min 拒服）**：
  - **根因**：`POOL_EXHAUSTED_MARKERS` 两个 message 子串（"allocated quota exceeded" / "quota exceeded for the current window"）实测**全部命中限流**——词条 1 = `Throttling.AllocationQuota`（workspace 分配配额节流，真机实测 rpm 形态）的措辞、词条 2 无任何出处（两仓 git 全历史仅初始导入带入、全部参考工程/文档零命中）；18 条真机 pool 日志三簇全为限流秒级连环（10-31 簇 1 分钟后恢复成功直接反证）。**积分池耗尽的 body 形状至今零样本——pool 类从建立到今天没有一次真耗尽识别**。
  - **两个 message marker 删除**（message 彻底退出判定——「只认 code」纪律的完全体）；`Throttling.AllocationQuota` 与 `insufficient_quota` 按 2026-11-03 真机样本归 **rpm 桶**（只换不记 strike）。
  - **额度耗尽账本（断流重置式，2026-11-04 定稿）**：**所有 429 形状**（与桶解耦——rpm/unknown/an 线全入口）记账；429 间隔超 30min 翻篇重记（闲置不算持续）；连续段攒满 30min 且无成功 ⇒ 打池格（30min TTL 放出试探、429 立即再格 / 2xx 清账转正）；全组格满 ⇒ ACCOUNT_QUOTA 快速终止（文案改「持续限流不可用」，不再断言积分池耗尽）。**成功是唯一翻篇信号**；格中/最近打格的空闲豁免（隔离期不算断流）。
- **tpm 隔离恢复重做（/models 探测面整体拆除）**：探测对 tpm/额度耗尽恒 200（恒真信号）——「放进去就出来」假恢复循环且令探测退避机制（probeAttempts 15/30/60s）整段死码。改**时间门**：阻塞态驻留 10min（`BLOCKED_RESIDENCY_MS`）放回轮换，**考验状态**（strike 预置阈值-1）——1 次 tpm 即回笼、2xx 清零转正；freeapi 的「借用 + 2xx 转正」本命通道原样保留，恢复检验由轮换流量的真实 429/2xx 完成。
- **识图 describe 工具下线**（能看图的直接看了，不能的还有读图桥）：`vision/run.ts` 整删、tools 注册面改纯出图、`VisionFeedback`/`VisionOptions` 挪 bridge.ts；识图架构 = 勾「可看图」原生看图 + 未勾桥转述，无第三条路。
- **读图桥/出图链的 429 与分类解耦**（只保证服务继续）：429 ⇒ 换 key 重试，**遍历全池**（tried 集合累积、全试完才收场——出图冷却 30s + 报错；桥抛错由既有占位收场「图片转换失败」）；**记住成功的 key**（lastGoodImageKey/lastGoodKey：下一次起点优先、失败不留案底、401 清除防死 key 卡死）；不打池格不记账。
- **验证**：typecheck 两配置 0 错；pool 122（105+17）/ vision-image 22（19+3）/ contract 92 / config 152 / provider 247+ / key-health / retry 25 / docs / duplication 14 全绿；scope-check 102/102 三项 0。真机生效 = 完整重启 DSH。

## 0.1.47（2026-11-03）

- **拆除主 key（拍板：池成员人人平等）**：
  - **整删**：`api-key-store.ts`、`routes/api-key.ts`（路由注册 6→5）；`SENSENOVA_API_KEY` ref、env/memory 兜底全废——目录腿七天冻结事故的架构根因就此拔掉。
  - **池 = key-<n> + accounts 两类**，无 default 成员；池路由 default 行/编号占位/查重「主 key」特判全摘；`defaultNote`/`setDefaultNote`（只写不读死字段）顺手清。
  - **llm 块 hasApiKey/keySource/ephemeral 三字段删**（wire 同步）；面板催 key 门改「只看池」；**ApiKeyForm 留任**=池加 key 表单（10-29 起本就 POST /pool add，从来不是主 key 写入口）。
  - **测试**：provider api-key store 三组删（265→247）；routes N 组删 + M/O1/O2/O3/Q 全改池播种，O1 语义翻转钉「删池 key → 目录不可用 = 照服旧目录 + catalogError 上屏，**不拆注册**」（2026-11-03 新契约）；pool-route 33→27；wiring/e2e/panel/render-dom 同步。
- **目录腿两级回落（免费读不跟推理门瞎）**：
  - 真机事故实锤：04:55 四把 key 被 pool 429 全标满（30min TTL）→ pickStart 全拒 → 面板红字「无可用 key」——但 /v1/models 免费读不耗积分、不占推理配额，池格标记对它无意义。
  - 改两级：pickStart（健康 key 优先）→ 任意池 key（尊重 disabled/deleted）；两级全空才上屏 `catalog_unavailable`。
- **sensenova-6.8-flash 收编静态档案表**（docs/sensenova-api-reference/2 为据）：档位梯 minimal/low/medium/high/xhigh/max **无 none**（文档「不支持关闭思考」）→ `forbidThinkingDisabled=true`、面板首装勾低/中/高/最高（无「关」）；输出上限 128K；**an 线发图 false**（文档「仅 lite」——真机实测后可翻，deepseek-flash 先例）；Responses 上限 null 须实测。
- **未收录模型思考默认只勾 high**（拍板：不看档案表）：`defaultThinkingLevels` 未收录 → ["high"]（原 []——面板勾选空白 vs DSH 全开的两侧不一致就此收口）；`thinkingWithDefaults` 视图补缺键、已存值（含显式全不勾）不翻案。
- **可看图自动勾（自动为底、手动优先级最高）**：目录 input_modalities 含 image 自动勾（与面板 vision 徽章同判据 identifyVisionModel）；手动取消的原生模型进 `autoOffIds` 墓碑不翻案、手动勾选原样保留；/pool vision 保存语义 = 面板提交期望生效集、路由算墓碑；`effectiveVisionModels` 纯函数承接。
- **数值覆盖与倍率**：maxTokensOverrides + `sensenova-6.8-flash: 131072`（128K 口径 vs 探测 64K）；trendMultipliers 收窄（"sensenova" 子串会把没测的 6.8f/u1.5 全搭上 0.8）→ lite ×0.8 / **6.8f ×1**，顺序承重（lite id 包含 flash id，lite 键必须在前）。
- **文档**：sensenova-api-reference 重编号（6.8 Flash 插为 2 号，Kimi K3 补 9 号）。
- **验证**：typecheck 两配置 0 错；snapshot 44 / pool 105 / pool-route 27 / config 152 / provider 247 / panel 78 / render-dom 55 / contract 92 / key-health 14 / duplication 14 全绿；wiring·routes·e2e-gate·composer 结构性 SKIP（peer 缺）。

## 0.1.46（2026-11-03）

- **面板目录腿修源（池优先 key + 失败上屏）**：
  - **根因（真机实锤）**：sk- 框迁池后凭据库里 `SENSENOVA_API_KEY` ref 已不存在（只剩 `dsh_pool_key_1..4`），旧目录腿只认主 key 且 `.catch(() => null)` 静默——catalog.json 自 10-27 起七天零写入（mtime 实锤），面板清单冻结在旧目录，平台上新模型（sensenova-6.8-flash）在 DSH `/model`（走池 key）可见而面板永不出现。
  - **解析改池优先**：新增 wiring 缝 `resolveCatalogApiKey`（池 pickStart 通用组挑活 key 优先、主 key 仅回落；不推进游标、不占并发槽），两个调用方（snapshot 路由 + 后台刷新 tick）同源；死 wiring 字段 `resolveApiKey` 删除。
  - **失败上屏（堵静默缺口）**：无 key 可用 → `catalogError`（新码 `catalog_unavailable` + 指向「API Key」卡片的文案）；拉取失败 → failureCode 共享分类 + 原始 message 透传；成功 = 无字段。wire 契约 `SnapshotData.catalogError`，面板「语言模型」卡红字行（zh/en）。
- **contextWindowOverrides（上下文窗口覆盖，与 maxTokensOverrides 全链同构）**：
  - **动机**：目录低报新模型——sensenova-6.8-flash 探测 262144（256K），官方文档 1M（运营者口径，docs dump 未收录该新模型）。
  - **判据**：`contextWindowForId`（override > 目录申报 > 131072 兜底），`overrideFor` 与 `maxTokensForId` 抽共用验证核、`sanitizePositiveIntMap` 同理（duplication-gate 抓到两处自克隆后按其裁决抽取）；读取点两处同源：面板徽章（rosterWithAvailability 第 5 参）+ 适配器 resolveModel（context.contextWindow）——徽章显示的 = 请求用的（D1 同款承诺）。
  - **配置**：CONFIG_DEFAULTS 单行默认 `{ "sensenova-6.8-flash": 1048576 }`；provider-publish 每 publish 现读（改 yml 无需重启，下轮目录轮询/开关翻转生效）。
- **cordis.patch.yml 全文中文重写**：注释从 130 行英文长段收到约 55 行中文短块（分节头 + 注释块前空行）；值/键/顺序/active 态逐字不变（纯注释重写，行为零变化）；`plugins.bundle.config` / `sidebar` 槽位词保留（docs.test 受检面）；rosterHint 文案 zh/en 增「最大输出与上下文长度可在 cordis.patch.yml 调整」。
- **测试补钉**：snapshot-aggregate H1–H5（有 key 拉取落盘 / 无 key 上屏且不拉不写 / 500 走共享分类）+ render-dom C2a/C2b（目录失败红行渲染/不渲染）+ config 7b 组 8 钉（窗口 sanitizer 同规）+ provider context 覆盖 4 钉。
- **验证**：typecheck 两配置 0 错；config 152 / provider 260 / contract 92 / pool 100 / panel 78 / provider-refresh 17 / snapshot-aggregate 44 / duplication 14 全绿；wiring·routes 结构性 SKIP（@deepseek-ai junction 缺席）。

## 0.1.45（2026-11-03）

- **U8 审计修复轮（HTTP 路由面与快照聚合，台账全终态）**：
  - **account 补整体兜底（六路由唯一缺口，D1）**：handler 包同族 catch → `clearCoalescedFetch` + `reportAuthFailure`（与 switch 失败分支逐句同构）——此前 remove 分支与三处 `state()` 裸 await，任一抛错直接冲出 handler，宿主兜底是裸 400 空体（asar 取证 dsh-host-webserver）；且 remove 中途失败（身份可能已换人）会漏清 coalesced 缓存。
  - **畸形 action 封闭白名单（顺带2 案 a）**：未知 action / switch·remove 缺 id 拒 400——此前会双双跳过掉进登录兜底，以 MISSING_CREDENTIALS 冒充「登录失败」（语义错位；形状本身安全，saveAccount 首行校验在一切写动作之前）。
  - **api-key answer 条件回显 providerError（顺带3）**：与 models/provider 同口径——forget-and-republish 发布失败在本路由自己脸上可见，不只在下一轮快照。
  - **rename 备注 traceLog 整行删除（S1 拍板「本来就没用」）**：排障钉连注释带死 import 删——备注原文直落诊断日志是凭据入日志的相邻面。
  - **注释对齐现实三处（D2 案 b / S3 案 a / routes load-bearing）**：`MAX_ENABLED_MODEL_IDS=500` 写明 DESIGN INTENT（JSON id 数组 ~25B/id，~150 个先撞 4096 字节家族上限，行为零变化）；models JSDoc「缺省时协议保存被拒」→「静默跳过（生产恒注入，仅测试替身可达）」；routes.ts「registration ORDER is load-bearing」改为事实句（六路由 path 互不相交、off 无互相依赖）。
  - **测试补钉当轮清账（T1/T2/T3）**：pool-route 24→33（globalConcurrency 负数钳 0 路由+store 两层 / 小数取整 / 0 合法保存值 / 非有限数两可见面自愈 null——原始字节体绕开 JSON.stringify(Infinity) 桩内变形，首跑抓到错误期望=钉会红自证；readJsonBody 恰等 4096 通过且落盘 / 超 1 字节 400 / 空体 / 数组各专属文案）；account-route 6→10（remove 抛错 200 ok:false + code 透传 + 缓存清场判别钉；未知 action 400；switch 无 id 400 且 saves=0）。
  - **自结定论（无码）**：非有限数 globalConcurrency 三层防线销号（消费端并发闸 `normalizeConcurrencyLimit` 非整数一律回退 1）；宿主 webserver handler 抛错契约 asar 实锤（未写出=裸 400 空体 / 已写出=`res.destroy()`）；面板只读 `llm.modelProtocols`（pool 块 raw 副本 wire 上无消费者）；`wireProtocol` 生产两端恒 auto。
  - **验证**：typecheck 0 错；account-route 10 / pool-route 33 / contract / snapshot-aggregate / duplication 全绿；routes 套件本机结构性 SKIP（@deepseek-ai junction 缺席，U6 O3 同因）。

## 0.1.44（2026-11-03）

- **U4 审计修复轮（键池与配额状态机，问题清单零挂账终态）**：
  - **poolGrid 裸 key 明文上屏修复（P2）**：诊断快照的 (key,组) 池格串曾把**完整 key 明文**带进面板快照 HTTP 响应（wire 契约写明「key 打码」但生产者无人打码，面板也未消费该字段）。修=诊断投影按首个分隔符拆分、key 段过 `maskKey` 再出；池格判据串不变，行为零变化。
  - **探测不再清池格**：探测成功（GET /models 200）只把 key 挂回运行态、**不动 (key,组) 积分格**——/models 不耗积分，200 不证明积分回血；清格留给 30min TTL 自愈与额度回正。此前的「成功清全部格子」会把仍然成立的标记洗掉，让该组下一个请求白撞一次 pool 429。
  - **踢出可见**：key 被踢出运行态时 trace 日志记一行（`key 踢出运行态 key=… strikes=3 连续限流达阈值`）——此前踢出全程静默，真机无法统计「踢→探测回→再踢」循环。
  - **新用户默认勾选集**：首装（pool.json 不存在）时「可看图」默认三件套即刻生效（此前要等首次任意保存+缓存过期才出现，期间全部图走转述桥）。语义定版：默认值是给新用户用的，老用户配置一经落盘即冻结（即使是当初的默认也不随版本变动）。
  - **sticky 有界**：quota 轮换粘住的会话→key 映射此前只增不清无上限，改为成功即清 + 512 上限（副作用：通用组会话成功后不再永久粘轮换 key，商汤组亲和粘性不受影响）。
  - **词表统一**：存储层档位白名单与面板勾选统一 `off/low/medium/high/max` 五值（xhigh 从白名单移除，对齐「xhigh 彻底移除」既有拍板；API 归一层词表不动）。
  - **常量与卫生**：`PROVIDER_RETRY_AFTER_CAP_MS` 收敛 rate-classify 唯一真源（adapter 本地副本删除）；index 空白记录改调 `emptyPoolRecord()`；相位判定去重；releaseSlot 唤醒受并发上限约束（cap 热缩小不再造超限在途）；诊断快照单帧取用。
  - **验证**：typecheck 0 错；pool 100（87→100，新增打码/中止/池格存活/热缩 cap/首装默认钉）/ contract 92 / retry / duplication 14 / snapshot-aggregate / pool-route / vision-image / key-health / provider / docs / doctor / package 全绿；key-orchestrator.ts 源码字面 NUL 归零。

## 0.1.43（2026-11-02）

- **429 调度重做：4 轮轮询 + 桶维判据 + 统一退避梯**：
  - **4 轮轮询取代单圈轮换**：一次请求「3 轮（每轮把所有可试 key 各试一次）→ 抖动等待 5-10s → 第 4 轮 → 全败立刻抛」。轮边界由「选不出本轮未试过的 key」决定（不按固定账户数，池成员变化时轮内次数自然收窄/扩大），每轮清空 `tried` 让各 key 重新获得一次机会；抖动等待每请求独立计算、可 abort 打断；最大主动等待 1 次。设计目标=不因短暂限流过早排除账户，同时把重试控制在可预期上限（可试 key 数 × 4）。
  - **每轮起点轮换**：裸轮转组把上一轮起点作为 `excludeStart` 交给池层、从它的下一位环回（4 把 key 的起点序列 = A→B→C→D，避免总是固定账户优先）；亲和组（商汤组）忽略该参——亲和 key 恒第一（上一轮最后粘住的那把），即使刚 429 过也照打。
  - **踢出判据改桶维（`windowCountsStrike` → `bucketCountsStrike`）**：只认 **TPM 桶**（429001 / `…Endpoint*TPMExceeded` / `ModelAccount*Tpm*`），RPM 桶（code 8 / 429003 / `…Endpoint*RPMExceeded` / `ModelAccount*Rpm*`）永不踢。作用域（Endpoint/Account）本身零处置差异，只留 `kind` 日志标签；`window` 字段退役为 `bucket`（正交：桶只决定踢不踢，不再决定退避）。修掉旧实现把 `EndpointRPMExceeded` 跟 `EndpointTPMExceeded` 一起计 strike 的错位。
  - **退避统一（`PROBE_BACKOFF_STEPS_MS` = 3 / 5 / 10 / 15 / 30s，30 封顶）**：快慢窗口共用一套梯子，旧的「RPM 走 15s 静态 floor」删除——它建立在「宿主等待是唯一恢复窗口」的旧形态上，4 轮轮询落地后插件内序列本身已 20-40s，远超 14s 桶补充周期。不采用上游 freeapi 的 120s 封顶：DSH 宿主对 `providerRetryAfterMs` 超过单次延迟上限（60s）直接放弃重试。档位推进保持入口快照语义（一次 `stream()` 调用含 4 轮共吃一档）。
  - **积分池类独立出口**：单把 key 的 pool 429 **只打标不打断流程**（格子由池层在下一轮选 key 时自动跳过），该组全部 key 标满才 `groupFullyPoolMarked` 快速失败——抛 `ACCOUNT_QUOTA`（`QUOTA_CODES.accountQuota` 自此有生产读者），宿主不重试、直接上屏并说明「积分池已耗尽，等待额度恢复或更换账号」。这是唯一「不等就终止」的路径。
  - **非 429 失败不进轮询**（本批修）：轮次推进块补 `attempt.status === 429` 守卫——5xx/超时/传输此前会被误判成「本轮已无 key」而白等 5-10s 重打 3 轮。
  - **排队超时 60s → 90s**：4 轮轮询把等待搬进插件内，一次全 429 的 `stream()` 全程占全局槽约 30-50s；`globalConcurrency=2` 时两个会话同时全 429，第 3 个排队者会逼近 60s，90s 留余量。
  - **面板文案**：并发提示改为「全局在途上限（0代表跟随key数）」/ "global in-flight cap (0 = follow key count)"——0 语义（跟随 key 数）此前在界面上不可见。
  - **验证**：typecheck 0 错；pool 87 / vision-image 19 / contract 92 / retry 25 / wire-chain 8 / key-health 14 / panel 78 / render 173 / duplication 14 全绿。`docs/retry-policy.md` 形态表改桶列并补 4 轮结构与 pool 快速失败、`docs/TESTING.md` 判据名同步、README 429 速览重写。

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

- **登录冷却按账号分钥**：park 记在用户名上——B 号的密码错误不再
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
- 账号卡移除按钮红字 + 宿主 Modal 二次确认；登录成功同时清空用户名。

## 0.1.0~0.1.29（2026-10-24~2026-10-30）
