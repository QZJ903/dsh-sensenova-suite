# 第三方声明与许可（Third-Party Notices）

本项目（`dsh-sensenova-suite`，Copyright (c) 2026 QZJ903，MIT）包含来自以下 MIT 许可项目的衍生代码与文档。各项目的完整许可证文本以其仓库的 `LICENSE` 为准。

## 1. 衍生代码

| 项目 | 出处 | 版权 | 本仓摄取内容 |
|---|---|---|---|
| dsh-connect-sensenova-token-plan | https://github.com/eghrhegpe/dsh-connect-sensenova-token-plan | 见其仓库 LICENSE（MIT） | 骨架主体：控制台 OIDC 登录与 token 续期（sensenova-auth/token-store 一族）、积分读取与解析（console-client/parsers）、快照聚合与路由、面板与用量胶囊（client 侧）、发布状态机（provider-publish/publish-core）、doctor、测试基建与大部分文档 |
| dsh-sensenova-provider | https://github.com/alaxrpg/dsh-sensenova-provider | 见其仓库 LICENSE（MIT） | 两个协议层 src/host/wire/*（body/sse × responses/chat + facts/plan/blocks/types/usage）、brand.ts、concurrency.ts |
| dsh-sensenova-freeapi | https://github.com/modesthub/dsh-sensenova-freeapi | 见其仓库 LICENSE（MIT） | key-pool.ts（运行态/阻塞态双列表状态机及其三不变量） |
| dsh-sensenova-vision-aid | https://github.com/modesthub/dsh-sensenova-vision-aid | 见其仓库 LICENSE（MIT） | vision/ 一族：直连模型链（direct）、读图桥（bridge：能力覆盖 ） |

## 2. 传递的上游谱系（经 token-plan 继承）

`sensenova-auth.ts` + `sensenova-crypto.ts` 的登录流是 Python 工具 [sensenova-usage-dashboard](https://github.com/shaobingtongzhi/sensenova-usage-dashboard)（shaobingtongzhi）的 TypeScript 重实现：IAM/控制台/Token/JWKS 四端点、`client_id=nova` 与 PKCE S256、`RSA-OAEP(SHA-1)+A256GCM` 密码封包、最多 6 跳重定向取 code、`/lite/console/v1/tokenplan/pool-usage` 端点与积分池字段语义均出自该项目。差异（凭据服务代替明文存盘、refresh_token 静默续期、节流分层与脱敏）为本仓增量。其许可证以其仓库为准。

## 3. 设计参照（未复制代码）

DSH connect 家族插件（加载协议、bundle 结构、README 与设置页范式）、dsh-sensenova-image（出图端点与参数事实参照，未取其码）、以及商汤官方文档（`docs/sensenova-api-reference/` 为版本控制内的官方文档副本）。

## 4. 随包依赖

`files` 打包清单不含任何第三方代码：`peerDependencies`（`@deepseek-ai/*` 一族与 `@earendil-works/pi-ai`）由 DSH Host 运行期提供，不随包分发；react 仅 devDependencies（类型用，不随包分发），运行时由宿主 loader 移交，MIT。

## 5. 本项目许可证

MIT，全文见 [LICENSE](./LICENSE)。
