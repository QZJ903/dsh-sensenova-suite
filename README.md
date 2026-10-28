# dsh-sensenova-suite

> 商汤 SenseNova（Token Plan）聚合套件 for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：积分面板 + 用量胶囊、多账号 key 池、三协议 LLM 接入（anthropic / responses / chat-completions）、出图工具与图片转述。

## 功能

- **积分额度**：登录商汤控制台后，面板显示积分池（5 小时 / 周两个滚动窗）、每模型消耗趋势、输入框用量胶囊；token 自动续期。
- **语言模型接入**（面板「模型接入」开关，默认关）：直连商汤网关，**anthropic → responses → chat-completions 自动降级链**（anthropic 优先，协议不匹配自动换线，chat 永远兜底）。所有对话模型三协议通吃，模型清单由 `/v1/models` 探测。
- **多账号 key 池**：401 永久移除；连续 3 次 rate 类 429 → 阻塞态、探测自动救回；积分池类 429 按 (key, 积分组) 记格不踢账号；**商汤组模型（sensenova-*）会话粘性省积分，通用组裸轮转均分**；一次请求全池轮询完才判失败。面板「API」页有只读池诊断卡。
- **出图工具**（默认关，面板「多模态」逐工具开关）：`sn_text2img` 文生图 + `sn_img2img` 图片编辑（1-5 张参考图），失败 30s 冷却，key 走池。
- **图片转述**（读图桥默认 auto）：纯文本主模型拖图不再被「不支持图片」阻断——视觉链（sensenova-6.8-flash-lite → deepseek-flash → kimi-k3）把事实性观察交给主模型，界面原图不动；主模型真支持视觉时自动让行。另有 `sn_describe_image` / `sn_describe_images` 两个显式视觉工具（随「多模态」的视觉工具开关）。

## 快速开始

1. 安装（本地路径）：
   ```bash
   dsh plugin --profile web add ./dsh-sensenova-suite
   ```
2. 面板登录商汤控制台（插件页 → SenseNova Suite → 积分额度 tab）。
3. 保存一枚 `sk-` Key（API 页）——它就是池的第一把 key。
4. 多账号：在 `~/.dsh/profiles/web/cordis.patch.yml` 的本插件 `accounts` 列表加 `{ id, label, apiKeyRef }`（ref 名对应凭据中心的引用），重载即入池。
5. 开「模型接入」开关 → 模型选择器出现商汤模型；出图工具把 `imageToolsEnabled` 置 `true`。

## 面板三个 tab

- **积分额度**：池卡片（5h/周）、每模型消耗、登录管理。
- **接入 API**：模型接入开关与推送清单、Key 池管理与全局并发、API Key。
- **多模态**：出图两工具各自的开头/参数设置（模型/尺寸/格式/水印/落盘目录）与视觉设置（视觉模型/读图桥）。

## 429 与重试（速览）

401 → 永久移除；rate 类 429（code 8 / 429001）→ 连续 3 次阻塞 + 探测恢复（15/30/60s 退避封顶）、本次换下一把 key；积分池类 429（"Allocated quota exceeded"）→ 记 (key, 组) 格子、换 key、全组轮尽快速失败；5xx/超时/网络 → 同 key 交宿主重试层（有限预算）。详细教义与参数表见 [docs/retry-policy.md](docs/retry-policy.md)。

## 文档

- [SETUP.md](docs/SETUP.md) —— 配置项逐键说明（含池与出图/视觉全部键）
- [TESTING.md](docs/TESTING.md) —— 测试套件名册
- [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) —— 症状 → 排查
- [retry-policy.md](docs/retry-policy.md) —— 429 分类与退避教义
- [PROVIDER-HOT-RELOAD.md](docs/PROVIDER-HOT-RELOAD.md) —— 模型接入热更新

## 兼容性

DSH `0.2.x`（开发与验证基线 0.2.0；重试键核对至 dsh-llm 0.2.0-rc.2）。

## License

MIT
