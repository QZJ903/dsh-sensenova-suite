GLM-5.2
智谱面向长程任务的开源模型，专注复杂软件工程与多步骤 Agent 任务

支持大型代码库开发、复杂调试与多文件修改，适合中大型软件工程任务
具备长程规划与工具协同能力，可持续推进开发、性能优化及自动化研究等复杂任务
支持稳定的 1M Token 上下文及多档思考强度，适合多步骤的任务执行
model_id: glm-5.2

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
    "model": "glm-5.2",
    "messages": [
      { "role": "system", "content": "你是一个智能助手。" },
      { "role": "user",   "content": "介绍一下商汤科技。" }
    ]
  }'
流式输出：

复制
curl https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "messages": [
      { "role": "system", "content": "你是一个智能助手。" },
      { "role": "user","content": "介绍一下商汤科技。" }
    ],
    "stream": true
  }'
工具调用
Function Calling 允许模型通过调用外部工具获取实时数据或执行特定操作。模型不会直接执行函数，而是返回待调用的函数名称及参数；用户代码完成调用后，将执行结果传回模型，由模型生成最终的自然语言回答。

调用流程：

用户提问 → 模型返回 tool_calls（包含函数名称和参数）
用户代码执行函数 → 以 role: tool 消息传回执
模型根据结果生成最终回答
完整闭环流程：模型调用 → 模型返回 → 本地执行 → 工具回传 → 最终模型返回

模型调用：

复制
{
  "model": "glm-5.2",
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
//本地执行：
get_weather(city="上海")

//获取结果
{
  "city": "上海",
  "weather": "晴",
  "temperature": "29°C"
}
Function Calling 仅负责生成工具调用请求，不会自动执行实际函数。

工具回传：

工具执行完成后，将原始对话、模型返回的 tool_calls 以及工具执行结果一并发送给模型。

工具结果通过 role: "tool" 回传，并使用 tool_call_id 与对应的工具调用进行关联。

复制
{
  "model": "glm-5.2",
  "messages": [
    {"role": "user", "content": "今天上海天气怎么样？"},
    {
      "role": "assistant",
      "content": "\n\n",
      "reasoning": "用户问的是上海今天的天气，我需要使用get_weather工具来查询上海的城市天气信息。参数只需要city，值为\"上海\"。\n",
      "tool_calls": [
        {
          "id": "call_4a…", "type": "function",
          "function": {"name": "get_weather", "arguments": "{\"city\":\"上海\"}"}
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_4a…", 
      "content": "{\"city\":\"上海\",\"weather\":\"晴\",\"temperature\":\"29°C\"}"
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
    "id": "6808ced8-...",
    "created": 1788404443,
    "model": "glm-5.2",
    "object": "chat.completion",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "\n\n根据查询结果，今天上海的天气是**晴天**，气温为**30°C**。天气不错，适合户外活动哦！",
                "reasoning": "工具返回了上海天气信息：天气晴朗，温度30°C。我需要将这些信息以自然、友好的方式反馈给用户。\n"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 383,
        "completion_tokens": 56,
        "total_tokens": 439,
        "completion_tokens_details": {"reasoning_tokens": 0},
        "prompt_tokens_details": {"cached_tokens": 0,"audio_tokens": 0}
     },
    "request_id": "6808ced8-..."
}
参数说明：

字段	类型	必填	默认值	说明
tools	array	—	—	工具定义列表，用于声明模型可调用的 Function
tools[].type	string	✅	—	工具类型，固定为 "function"
tools[].function.name	string	✅	—	Function 名称，模型通过该名称指定需要调用的工具
tools[].function.description	string	—	—	Function 功能描述，用于帮助模型判断何时调用该工具
tools[].function.parameters	object	✅	—	Function 参数定义，使用 JSON Schema 描述参数结构
tool_choice	string/object	—	"auto"	控制模型如何选择工具。auto 表示由模型自主判断
message.tool_calls	array	—	—	模型返回字段。模型需要调用工具时，返回具体的 Function 调用信息
message.tool_calls[].id	string	—	—	本次工具调用 ID。回传工具执行结果时，通过 tool_call_id 与该调用关联
message.tool_calls[].function.name	string	—	—	模型返回字段。模型决定调用的 Function 名称
message.tool_calls[].function.arguments	string	—	—	模型返回字段。模型生成的 Function 调用参数，通常为 JSON 字符串
messages[].role	string	✅	—	回传工具结果时设置为 "tool"
messages[].tool_call_id	string	✅	—	工具回传字段。填写对应 tool_calls[].id，用于关联工具调用与执行结果
messages[].content	string	✅	—	工具回传字段。填写 Function 的实际执行结果，供模型继续处理
思考模式
模型默认开启思考模式。可通过配置 reasoning_effort 参数设置思考程度，例如 "reasoning_effort": "high"。如需关闭思考模式，可直接设置 "reasoning_effort": "none"。

参数说明：

字段	类型	必填	默认值	说明
reasoning_effort
string	—	max	推理力度，可选值为max, xhigh, high, medium, low, minimal, none设为none可关闭思考模式
请求示例：

复制
curl https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
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
model	string	✅	—	固定为 glm-5.2
messages	array
✅	—	对话消息列表。role 可取 system、user、assistant 或 tool；上下文长度最高支持 1M Tokens
stream	boolean	—	false	是否启用流式输出模式
temperature	float	—	1	采样温度，范围 [0, 2)，值越高输出越随机，值越低越确定。一般只调此参数或 top_p 之一
top_p	float	—	0.95	核采样概率阈值，范围 (0, 1]
max_tokens	integer	—	64K	单次响应最大输出 Token 数，范围 [1, 128K]
stop	string | array	—	—	停止序列，遇到匹配序列立即停止生成
reasoning_effort
string	—	max	推理力度，可选值为max, xhigh, high, medium, low, minimal, none;
设为none可关闭思考模式
response_format	object	—	text	指定模型的响应输出格式，默认为text，仅文本模型支持此字段。type 取值收敛为三种：text（普通文本输出）、json_object（JSON 格式输出）。
tools	array	—	—	工具定义列表
tool_choice	string	—	auto	控制模型如何选择工具。
do_sample	true		true	是否启用采样生成文本。
- true：根据 temperature、top_p 等参数随机采样，输出更多样。
- false：始终选择概率最高的词，输出更稳定；此时忽略 temperature 和 top_p。
对于代码生成、翻译等强调一致性和可重复性的任务，建议设为 false。
响应结构
复制
{
  "id": "cec17345-",
  "created": 1789457496,
  "model": "glm-5.2",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "商汤科技（SenseTime）成立于2014年，是全球最具影响力的AI独角兽企业之一…",
        "reasoning_content": "1. 理解目标:用户希望获得关于商汤科技（商汤科技）的介绍…"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 23,
    "completion_tokens": 1718,
    "total_tokens": 1741,
    "completion_tokens_details": {
      "reasoning_tokens": 912
    },
    "prompt_tokens_details": {
      "cached_tokens": 0
    }
  },
  "request_id": "cec17345-"
}
finish_reason 枚举：

value	含义
stop	正常结束
length	达到 max_tokens 或上下文上限
tool_calls	模型选择调用工具
content_filter	内容被合规审核拦截
结构化输出
当业务需要对模型输出进行结构化解析时，可以设置response_format参数为 {'type': 'json_object'}，使模型按照指定的 JSON 格式返回内容。

注意事项：

在 system 或 user 提示词中明确包含 json 关键字，并提供期望的 JSON 格式示例，以引导模型生成合法且符合预期结构的 JSON
合理设置 max_tokens，避免输出内容因长度限制被截断，导致内容不完整
复制
curl https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "model": "glm-5.2",
  "messages": [
    { "role": "system", "content": "你是一个智能助手，回答内容需要以JSON格式输出。" },
    { "role": "user", "content": "介绍一下商汤科技" }
  ],
  "response_format": { "type": "json_object" }
}'
参数推荐
参数 / 实践	建议	说明
max_tokens	普通任务 2048~4096；思考模式建议 ≥ 4096	思考内容和输出共享 max_tokens配额
stream	长文本生成建议开启	避免请求超时，提升响应体验
temperature	一般无需修改，使用默认值 1	创意写作可调高至 1.3-1.5；代码生成可调低至 0.2-0.5
多轮对话	只将 content 回传，不回传 reasoning_content	减少 token 消耗
使用限制
限制项	说明
思考模式与 JSON 模式	不建议同时开启 thinking.type=enabled 和 response_format.type=json_object
超时风险	思考模式开启时响应时间较长，建议配合 stream=true 使用，避免超时
关闭思考	模型默认启用思考模式。若需关闭，请将 reasoning_effort 设置为 none。thinking.type 不支持 disabled，传入该值将导致请求失败。