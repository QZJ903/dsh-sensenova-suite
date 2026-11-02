DeepSeek V4.1 Flash
深度求索新一代高效通用模型，面向复杂推理、代码开发、多模态理解及多步骤 Agent 任务

具备推理、代码、工具调用与视觉理解能力，可支持复杂问题求解、代码开发及多步骤 Agent 工作流

采用 552B 参数 MoE 与非对称 Causal-Encoder-Decoder 架构，通过较低激活参数控制计算开销，兼顾模型能力与推理效率

优化 KV Cache 占用，降低长上下文及 Agent 场景下的缓存资源与调用成本，适合高频和规模化应用

model_id: deepseek-flash

请求地址：

复制
POST https://token.sensenova.cn/v1/chat/completions
基础对话
单轮对话： 模型默认为非流式输出

复制
curl https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash",
    "messages": [
      { "role": "system", "content": "你是一个智能助手。" },
      { "role": "user", "content": "介绍一下商汤科技。" }
    ]
  }'
流式输出：

复制
curl https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash",
    "messages": [
      { "role": "system", "content": "你是一个智能助手。" },
      { "role": "user","content": "介绍一下商汤科技。" }
    ],
    "stream": true
  }'
图像输入
DeepSeek V4.1 Flash 支持图片输入。content 使用对象数组，同时传入文本与图片。支持单图、多图与图文混合；图片格式支持 JPEG、PNG、GIF、WebP。

⚠️ 视频输入仅支持 Chat Completions 接口。 Anthropic Messages API 与 Responses API 不支持视频；请勿在对应请求中传入视频文件或视频 URL。

图片限制：

限制项	要求
支持格式	JPEG、PNG、GIF、WebP
单图大小	不超过 50 MB
总请求体大小	不超过 64 MB
单请求图片张数	不超过 200 张
以 URL 传入的图片总大小	不超过 200 MB
复制
curl https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "image_url","image_url": {"url": "https://www.sensenova.cn/marketing-home/showcase-hero.png"}},
          {"type": "text", "text": "描述这张图片的内容"}
        ]
      }
    ]
  }'
工具调用
支持标准 OpenAI 格式的函数调用，可自定义工具，并支持自动调用与多工具并行执行，适用于智能体工作流、外部数据查询和任务编排等场景。通过 tools 字段声明工具后，模型会按需返回 tool_calls；回传工具执行结果，即可获取最终答复。

调用流程：

用户提问 → 模型返回 tool_calls（包含函数名称和参数）
用户代码执行函数 → 以 role: tool 消息传回执
模型根据结果生成最终回答
完整闭环流程：模型调用 → 模型返回 → 本地执行 → 工具回传 → 最终模型返回

模型调用：

复制
{
  "model": "deepseek-flash",
  "messages": [
    {"role": "user", "content": "今天上海天气怎么样？"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的天气信息",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string", "description": "城市名称"}},
          "required": ["city"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "stream": false
}
模型返回： 按照模型返回获取对应的tool_call_id

本地执行： 业务侧根据模型返回的 function.name 和 function.arguments，调用对应的本地函数或外部 API

例如：

复制
//本地调用执行：
get_weather(city="上海")

//工具返回结果
{
  "city": "上海",
  "observation_time": "2026-09-15T17:30:00+08:00",
  "weather": "阴",
  "temperature_c": 26.6,
  "apparent_temperature_c": 25.6,
  "wind_speed_kmh": 11.1,
  "today_max_c": 29.4,
  "today_min_c": 22.5,
  "source": "Open-Meteo"
}
Function Calling 仅负责生成工具调用请求，不会自动执行实际函数。

工具回传：

工具执行完成后，将原始对话、模型返回的 tool_calls 以及工具执行结果一并发送给模型。

工具结果通过 role: "tool" 回传，并使用 tool_call_id 与对应的工具调用进行关联。

复制
{
  "model": "deepseek-flash",
  "messages": [
    {"role": "user", "content": "今天上海天气怎么样？"},
    {
      "role": "assistant",
      "content": "\n\n",
      "reasoning_content": "用户问的是上海今天的天气，我需要使用get_weather工具来查询上海的城市天气信息。参数只需要city，值为\"上海\"。\n",
      "tool_calls": [
        {
          "id": "call_4a…", "type": "function",
          "function": {"name": "get_weather", "arguments": "{\"city\":\"上海\"}"}
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_jm01…",
      "content": "{\"city\":\"上海\",\"observation_time\":\"2026-09-15T17:30:00+08:00\",\"weather\":\"阴\",\"temperature_c\":26.6,\"apparent_temperature_c\":25.6,\"wind_speed_kmh\":11.1,\"today_max_c\":29.4,\"today_min_c\":22.5,\"source\":\"Open-Meteo\"}"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的天气信息",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},"required": ["city"]
          }
      }
    }
  ]
}
模型最终返回： 模型根据工具执行结果生成最终回答。

复制
{
  "id": "e4d0595e-",
  "created": 1789464836,
  "model": "deepseek-flash",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "今天上海的天气情况如下：\n\n- **天气**：阴天\n- **当前气温**：26.6°C（体感温度 25.6°C）\n- **今日最高/最低**：29.4°C / 22.5°C\n- **风速**：约 11.1 公里/小时\n\n总体来看是个阴天，温度比较舒适，出门建议带件薄外套，以防体感偏凉。需要了解其他城市的天气吗？"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 531,
    "completion_tokens": 103,
    "total_tokens": 634
  },
  "request_id": "e4d0595e-"
}
参数说明：

字段	类型	必填	默认值	说明
tools	array	—	—	工具定义列表，用于声明模型可调用的 Function
tools[].type	string	✅	—	工具类型，固定为 "function"
tools[].function.name	string	✅	—	Function 名称，模型通过该名称指定需要调用的工具
tools[].function.description	string	—	—	Function 功能描述，用于帮助模型判断何时调用该工具
tools[].function.parameters	object	✅	—	Function 参数定义，使用 JSON Schema 描述参数结构
tool_choice	string/object	—	"auto"	控制模型如何选择工具。auto 表示由模型自主判断；思考模式下也支持 required
message.tool_calls	array	—	—	模型返回字段。模型需要调用工具时，返回具体的 Function 调用信息
message.tool_calls[].id	string	—	—	本次工具调用 ID。回传工具执行结果时，通过 tool_call_id 与该调用关联
message.tool_calls[].function.name	string	—	—	模型返回字段。模型决定调用的 Function 名称
message.tool_calls[].function.arguments	string	—	—	模型返回字段。模型生成的 Function 调用参数，通常为 JSON 字符串
messages[].role	string	✅	—	回传工具结果时设置为 "tool"
messages[].tool_call_id	string	✅	—	工具回传字段。填写对应 tool_calls[].id，用于关联工具调用与执行结果
messages[].content	string	✅	—	工具回传字段。填写 Function 的实际执行结果，供模型继续处理
思考模式
模型默认开启思考模式。可通过 thinking 参数控制思考模式的开启与关闭，并使用 reasoning_effort 参数设置思考程度，例如 "reasoning_effort": "high"。如需关闭思考模式，可在 Chat 接口直接设置 "reasoning_effort": "none"（Messages 接口将 output_config.effort 设为 none 仍无法关闭思考）。

参数说明：

字段	类型	必填	默认值	说明
thinking	object | string	—	开启	控制思考模式开关。OpenAI 兼容形态下支持 {"type":"enabled"} / {"type":"disabled"}（不支持 adaptive）；也可配合 reasoning_effort 使用
reasoning_effort	string	—	high	推理力度，默认 high。原生支持 none、low、high、max；Chat 接口设为 none 可关闭思考；Messages 接口将 output_config.effort 设为 none 仍无法关闭思考。兼容映射：minimal→low，medium/xhigh→high，ultra→max。Chat 接口字段为 reasoning_effort；Messages 为 output_config.effort；Responses 为 reasoning.effort
请求示例：

复制
curl https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash",
    "messages": [
      { "role": "system", "content": "你是一个智能助手。" },
      { "role": "user",   "content": "介绍一下商汤科技。" }
    ],
    "reasoning_effort": "high"
  }'
响应说明：

content：返回模型最终生成的回复内容。

reasoning_content：返回模型生成过程中的思考内容；当开启思考输出时，该字段会返回对应的推理过程。

请求参数
字段	类型	必填	默认值	说明
model	string	✅	—	deepseek-flash
messages	array	✅	—	对话消息列表。role 可取 system、user、assistant 或 tool；上下文长度最高支持 1M Tokens。支持文本，也支持 content 对象数组传入图片与视频（视频输入目前仅 Chat Completions（chat）接口支持）
stream	boolean	—	false	true/false是否以 SSE（server-sent events）的形式以流式发送消息增量
stream_options	object	—	"include_usage": true	仅 stream=true 生效。含 include_usage (boolean)；设为 false 可关闭流式末包 usage
temperature	float	—	1	采样温度，范围 [0, 2]，值越高输出越随机，值越低越确定。一般只调此参数或 top_p 之一
top_p	float	—	1
核采样概率阈值，范围 (0,1]。思考模式下生效，传入值 < 0.95 时自动提升至 0.95；非思考模式固定为 1.0，传入其他值将被忽略
max_tokens
integer
—	131072	单次响应最大输出 Token 数，范围 [1, 393216]；若思维链超出 max_tokens，则会截断思考
n	integer	—	1	生成条数。仅 n=1 生效，范围[1,5]
response_format	object	—	—	设置为 { "type": "json_object" } 启用 JSON 模式；也支持 json_schema、text
stop	string | array	—	—	停止序列，遇到匹配序列立即停止生成。最多支持 16 个字符串
frequency_penalty	float	—	0	频率惩罚，范围 [-2, 2]；思考模式下不生效；仅 Chat Completions（chat）接口支持
presence_penalty	float	—	0	存在惩罚，范围 [-2, 2]；思考模式下不生效；仅 Chat Completions（chat）接口支持
logprobs	boolean	—	—	是否返回 logprobs
top_logprobs
integer	—	—	仅在 logprobs=true 时生效，范围 [0, 20]；未开启 logprobs 时传入不起作用
thinking	object | string	—	开启	思考开关；OpenAI 兼容下不支持 adaptive
reasoning_effort	string	—	high	推理力度，默认 high。原生支持 none、low、high、max；Chat 接口设为 none 可关闭思考；Messages 接口将 output_config.effort 设为 none 仍无法关闭思考。兼容映射：minimal→low，medium/xhigh→high，ultra→max。Chat 接口字段为 reasoning_effort；Messages 为 output_config.effort；Responses 为 reasoning.effort
tools	array	—	—	模型可能会调用的 tool 的列表。目前仅支持 function工具
tool_choice	string | object	—	auto	控制模型调用 tool 的行为。none/auto/required 或指定工具；思考模式下支持 required
响应结构
复制
{
  "id": "b1305055-",
  "created": 1789457085,
  "model": "deepseek-flash",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "商汤科技（SenseTime）是中国领先的人工智能（AI）公司之一…",
        "reasoning_content": "这个请求很简单，直接介绍商汤科技就行…"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 93,
    "completion_tokens": 610,
    "total_tokens": 703,
    "completion_tokens_details": {
      "reasoning_tokens": 90
    },
    "prompt_tokens_details": {
      "cached_tokens": 0
    }
  },
  "request_id": "b1305055-"
}
finish_reason 枚举：

value	含义
stop	正常结束
length	达到 max_tokens 或上下文上限，消息内容可能会被部分截断。
tool_calls	模型选择调用工具
content_filter	内容被合规审核拦截
结构化输出
当业务需要对模型输出进行结构化解析时，可以设置 response_format 为 { "type": "json_object" }，使模型按照 JSON 格式返回内容。同时也支持 json_schema。

注意事项：

在 system 或 user 提示词中明确包含 json 关键字，并提供期望的 JSON 格式示例，以引导模型生成合法且符合预期结构的 JSON

合理设置 max_tokens，避免输出内容因长度限制被截断，导致内容不完整

复制
curl  https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "deepseek-flash",
  "messages": [
    { "role": "system", "content": "你是一个智能助手，回答内容需要以JSON格式输出。" },
    { "role": "user", "content": "介绍一下商汤科技" }
  ],
  "response_format": { "type": "json_object" }
}'
参数推荐
参数 / 实践	建议	说明
max_tokens	普通任务 2048~4096；思考模式建议 ≥ 4096	思考内容和输出共享 max_tokens 配额；若超出长度会截断思考
stream	长文本生成或思考模式下建议开启	可降低请求超时风险，并改善首字响应体验
temperature	非思考模式默认配置 1.0；思考模式下无需设置	创意写作可调高至 1.3-1.5；代码生成可调低至 0.2-0.5
工具调用	请求携带 tools 参数时，需回传所有历史轮次的 reasoning_content	回传的 reasoning_content 将被拼接至上下文，以保证工具调用链路的完整性
多轮对话	请求未携带 tools 参数时，无需回传历史 reasoning_content	即使传入，该字段也会被忽略且不会拼接至上下文，可减少 Token 消耗
使用限制
视频输入仅支持 Chat Completions 接口；Anthropic Messages API 与 Responses API 不支持视频

思考模式下，temperature、presence_penalty 和 frequency_penalty 参数不生效。为保持兼容性，传入这些参数不会触发报错

top_p 参数在思考模式下生效，最小值为 0.95；传入小于 0.95 的值时，系统将自动调整为 0.95。在非思考模式下，该参数固定为 1.0，传入其他值将被忽略

图片：单图不超过 50 MB，总请求体不超过 64 MB，单请求不超过 200 张；以 URL 传入时图片总大小不超过 200 MB

OpenAI 兼容协议下 thinking.type 不支持 adaptive。reasoning_effort 原生档位为 none / low / high / max；传入 minimal / medium / xhigh / ultra 时按兼容映射生效（见请求参数）

n 仅 1 生效

显式缓存不支持；Chat Completions（/v1/chat/completions）与 Responses 支持前缀续写；隐式缓存可用（usage.prompt_tokens_details.cached_tokens）

GLM-5.2