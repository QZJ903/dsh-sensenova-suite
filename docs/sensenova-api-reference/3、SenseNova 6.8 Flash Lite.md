SenseNova 6.8 Flash Lite
日日新轻量高效的多模态智能体模型，面向真实复杂任务，适配数据分析和复杂信息呈现场景

重点提升多模态 Agent 场景能力，更加高效且稳定执行端到端任务
复杂数据分析能力显著增强，能够高效执行规划、推理、工具调用与结果验证
通过主/次 Agent 协作并结合原生多模态能力，实现准确、美观、可编辑的演示交付物
model_id：sensenova-6.8-flash-lite

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
    "model": "sensenova-6.8-flash-lite",
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
    "model": "sensenova-6.8-flash-lite",
    "messages": [
      { "role": "system", "content": "你是一个智能助手。" },
      { "role": "user","content": "介绍一下商汤科技。" }
    ],
    "stream": true
  }'
图像输入
当 content 为内容块数组时，可通过 image_url 类型传入图像，并与文本内容组合输入。image_url.url 支持以下两种图像传入方式：

公网 URL：传入可公开访问的图像链接
Base64 Data URL：支持将本地图像编码为 Base64，并以 Data URL 格式传入
支持的格式： 支持 JPG、JPEG、PNG 和 WebP 图像（image/jpg、image/jpeg、image/png、image/webp）

请求示例：

复制
curl  https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "messages": [
      {"content": "你是图像识别专家","role": "system"},
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "图片里面有什么"},
          {"type": "image_url", "image_url": {"url": "https://www.sensenova.cn/marketing-home/showcase-hero.png"}}
        ]
      }
    ],
    "n": 1,
    "max_tokens": 1000,
    "reasoning_effort": "none"
  }'
Base64 方式：（python示例）

支持将本地图片转换为 Base64 数据后传入。Base64 数据须包含完整前缀，格式为 data:image/*;base64,{Base64data}。

复制
import os
import base64
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["SENSENOVA_API_KEY"],
    base_url="https://token.sensenova.cn/v1"
)

with open("local-image.png", "rb") as image:
    image_base64 = base64.b64encode(image.read()).decode()

response = client.chat.completions.create(
    model="sensenova-6.8-flash-lite",
    messages=[
        {"role": "system","content": "你是图像识别专家"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "图片里面有什么？"},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_base64}"}
               }
            ]
        }
    ],
    max_tokens=1000,
    extra_body={"reasoning_effort": "none"}
)

print(response.choices[0].message.content)
流式输出：

复制
curl  https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "messages": [
      {"content": "你是图像识别专家", "role": "system"},
      {
        "role": "user",
        "content": [
          {"type": "text","text": "图片里面有什么"},
          {"type": "image_url","image_url": {"url": "https://www.sensenova.cn/marketing-home/showcase-hero.png"}}
        ]
      }
    ],
    "n": 1,
    "stream": true,
    "max_tokens": 1000,
    "reasoning_effort": "none"
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
  "model": "sensenova-6.8-flash-lite",
  "messages": [
    {"role": "user", "content": "今天上海天气怎么样？"}
  ],
  "tools": [  //在请求中通过 tools 声明可供模型调用的函数，包括函数名称、功能描述及参数定义。
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
  "model": "sensenova-6.8-flash-lite",
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
    "model": "sensenova-6.8-flash-lite",
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
模型默认开启思考模式。可通过 thinking 参数控制思考模式的开启与关闭，并使用 reasoning_effort 参数设置思考程度，例如 "reasoning_effort": "high"。如需关闭思考模式，也可直接设置 "reasoning_effort": "none"。

参数说明：

字段	类型	必填	默认值	说明
thinking	string	—	enabled	控制思考模式的开关，可选值为 "enabled" 或 "disabled"
reasoning_effort	string	—	high	推理力度，可选值为low、medium、high、max，取值越大思考强度越高； 设为none可关闭思考模式
思考强度：

取值	说明
low	轻度推理。适合简单任务及对响应速度要求较高的场景，延迟和 Token 消耗较低
medium	中等推理。在响应速度与推理效果之间取得平衡，适合一般分析、内容生成及中等复杂度任务
high	增强推理（默认值）。适合常规推理、代码生成和复杂问题分析等场景
max	深度推理。适合复杂推理、长程任务及深度代码分析等场景，通常需要更长的响应时间并消耗更多 Token
none	关闭推理。模型直接生成回答，适合无需推理的简单问答、内容提取和格式转换等场景，响应速度最快
请求示例：

复制
curl https://token.sensenova.cn/v1/chat/completions \
  -H "Authorization: Bearer $SENSENOVA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sensenova-6.8-flash-lite",
    "messages": [
      { "role": "system", "content": "你是一个智能助手。" },
      { "role": "user",   "content": "介绍一下商汤科技。" }
    ],
    "reasoning_effort": "high"
  }'
响应说明：

content：返回模型最终生成的回复内容。
reasoning：返回模型生成过程中的思考内容；当开启思考输出时，该字段会返回对应的推理过程。
复制
"id": "c3589e2f-...",
  "created": 1787822182,
  "model": "sensenova-6.8-flash-lite",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "\n\n商汤科技（SenseTime）是一家全球领先的人工智能（AI）软件公司...",
        "reasoning": "用户让我介绍一下商汤科技。首先得确认..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 24,
    "completion_tokens": 1606,
    "total_tokens": 1630,
    "completion_tokens_details": {"reasoning_tokens": 236},
    "prompt_tokens_details": {"cached_tokens": 0,"audio_tokens": 0}
  },
  "request_id": "c3589e2f-..."
}
请求参数
字段	类型	必填	默认值	说明
model	string	✅	—	固定为 sensenova-6.8-flash-lite
messages	array	✅	—	对话消息列表。role 可取 system、user、assistant 或 tool；content 支持字符串或内容块数组（图像输入需使用内容块数组）。
stream	boolean	—	false	是否以 SSE 流式返回
stream_options	object	—	"include_usage": True	仅stream=true生效。含 include_usage (boolean)
temperature	float	—	1	采样温度，范围[0, 2]，值越高输出越随机，值越低越确定。一般只调此参数或 top_p 之一
top_p	float	—	1	核采样概率阈值，范围 （0, 1]
max_tokens	integer	—	65535	单次响应最大输出 Token 数，范围 [1, 65536]
n	integer	—	1	生成回复数量，范围 1–7
stop	string | array	—	—	停止序列，遇到匹配序列立即停止生成
frequency_penalty	float	—	0	频率惩罚，范围[0,2]，正值降低已出现 Token 的重复概率
presence_penalty	float	—	0	存在惩罚，范围[0,2]，正值鼓励生成新话题
thinking	string	—	enabled	控制思考模式的开关，可选值为 "enabled" 或 "disabled"
reasoning_effort	string	—	high	推理力度，可选值为low、medium、max、high，取值越大思考强度越高； 设为none可关闭思考模式
tools	array	—	—	工具定义列表
tool_choice	string | object	—	auto	工具选择策略：auto/none/required 或指定工具
parallel_tool_calls	boolean	—	true	是否允许并行调用多个工具
seed	integer	—	—	随机种子Beta,范围[0,9999999)
content[].image_url.url	string	—	—	支持完整的公网 URL，或带有data:image/*;base64,{Base64data} 前缀的 Base64 数据
响应结构
复制
{
  "id": "42e09a46-…",
  "created": 1788749773,
  "model": "sensenova-6.8-flash-lite",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "\n\n商汤科技（SenseTime）是中国领先的人工智能软件公司之一，…",
        "reasoning": "用户现在要求我介绍商汤科技，首先我需要确认…"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 92,
    "completion_tokens": 550,
    "total_tokens": 642,
    "completion_tokens_details": {
      "reasoning_tokens": 243
    },
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "audio_tokens": 0
    }
  },
  "request_id": "42e09a46-"
}
finish_reason 枚举

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
{
  "model": "sensenova-6.8-flash-lite",
  "messages": [
    { "role": "system", "content": "你是一个智能助手，回答内容需要以JSON格式输出。" },
    { "role": "user", "content": "介绍一下商汤科技" }
  ],
  "response_format": { "type": "json_object" }
}
参数推荐
参数 / 实践	建议	说明
max_tokens	普通任务 2048～4096；思考模式建议 ≥ 4096	思考内容和输出共享 max_tokens配额
stream	长文本生成建议开启	避免请求超时，提升响应体验
temperature	一般无需修改，使用默认值 1	创意写作可调高至 1315；代码生成可调低至 0205
多轮对话	只将 content 回传，不回传 reasoning_content	减少 token 消耗
使用限制
限制项	说明
思考模式与 JSON 模式	不建议同时开启 thinking.type=enabled 和 response_format.type=json_object
超时风险	思考模式开启时响应时间较长，建议配合 stream=true 使用，避免超时