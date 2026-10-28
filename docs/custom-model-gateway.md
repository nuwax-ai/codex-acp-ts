# 自定义模型网关使用指南

本指南介绍如何让 `nuwax-codex-acp`(ACP 适配器)通过环境变量接入自定义模型平台
(OpenAI Chat / OpenAI Responses / Anthropic Messages 协议均可),无需登录或额外认证流程。

工作链路:

```
ACP 宿主(Zed / JetBrains / 自研客户端 ...)
  └─ stdio ─> nuwax-codex-acp 适配器(本包)
                └─ JSON-RPC ─> nuwax-harness app-server(rig 桥)
                                └─ HTTP ─> 你的模型平台
```

## 1. 安装

```bash
npm install -g @nuwax-ai/nuwax-codex-acp-ts
nuwax-codex-acp-ts --version
```

适配器依赖 `@nuwax-ai/nuwax-harness`,安装时会自动下载对应平台的二进制到
`~/.nuwax-harness-cache/`。若提示 binary 未安装,执行一次 `nuwax-harness --version`
即可触发下载(需先 `npm install -g @nuwax-ai/nuwax-harness`)。

## 2. 环境变量

### 2.1 网关配置(设置 `CODEX_BASE_URL` 即启用)

下表每个 `CODEX_*` 变量都有同义 `NUWAX_*` 别名(如 `NUWAX_BASE_URL`):仅设其一即生效、
`NUWAX_*` 是推荐写法、双设同值幂等、双设异值启动报错点名两个变量。无前缀的
`OPENAI_API_KEY`、`MODEL_PROVIDER`、`INITIAL_AGENT_MODE`、`NO_BROWSER`、
`APP_SERVER_LOGS` 不设别名。

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `CODEX_BASE_URL` | 平台的协议基址(必填,设置即启用环境网关)。用平台提供的协议基址,**不要**自行拼接 `/chat/completions`、`/responses`、`/messages` | 无 |
| `CODEX_API_KEY` | 该端点的 Key。取键链 `NUWAX_API_KEY` > `CODEX_API_KEY` > `OPENAI_API_KEY`;建议只设一个,避免串用 | 无 |
| `CODEX_API_PROTOCOL` | 协议族:`openai` 或 `anthropic` | `openai` |
| `CODEX_WIRE_API` | OpenAI 族内的 wire:`responses` 或 `chat`。**Anthropic 协议时不要设置**(由 `CODEX_API_PROTOCOL=anthropic` 选择) | `responses` |
| `CODEX_BRIDGE` | 传输桥:`rig`、`native`、`genai`。`native` 仅支持 OpenAI Responses;`genai` 仅支持 chat/anthropic;单独设置而不设 `CODEX_BASE_URL` 会报错 | `rig` |
| `CODEX_MODEL` | 平台的实际模型 ID。网关激活时会覆盖 Codex 默认模型 | 无 |
| `CODEX_MODEL_CONTEXT_WINDOW` | 模型真实上下文窗口(token 数,正整数)。强烈建议按平台规格填写,本地预算与压缩依赖它 | 无 |
| `NUWAX_MAX_OUTPUT_TOKENS` | 每次生成的输出上限(正整数,不是上下文窗口)。与 harness CLI 启动组同名,一处配置两侧生效;非法值会在适配器启动时报错 | 不设 |
| `CODEX_TOOL_SEARCH` | `false` = MCP 工具在首个请求**全量直出**(不注册 tool_search/Deferred),用于不支持 tool_search 线格式的自托管/第三方网关或需要确定性工具表的部署;`true`/不设 = 官方默认(跟随模型目录的 `supports_search_tool`)。仅接受大小写不敏感的 `true`/`false`,其他值引擎启动即报错。引擎原生读取,经适配器环境透传生效;`CODEX_CONFIG` 里的 `tools.tool_search` 属显式配置,优先于本变量 | 不设 |
| `CODEX_PROVIDER_ID` | 网关的 provider ID(可选) | `custom-gateway` |
| `CODEX_PROVIDER_NAME` | 网关展示名(可选),缺省回退 `CODEX_MODEL`,再回退 `Custom Gateway` | — |
| `CODEX_DISABLE_THINKING` | 设为 `true`/`1`/`yes`/`on` 时把推理力度固定为 `none`(用于不支持推理的模型) | 不启用 |

常用组合:

| 目标 | `CODEX_API_PROTOCOL` | `CODEX_WIRE_API` | `CODEX_BRIDGE` |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `openai` | `chat` | `rig`(或不设) |
| OpenAI Responses | `openai` | `responses` | `rig`(或不设) |
| Anthropic Messages | `anthropic` | 不设 | `rig`(或不设) |
| 原生 OpenAI Responses(直连官方/中转) | `openai` | `responses` | `native` |

### 2.2 通用配置

| 变量 | 说明 |
| --- | --- |
| `CODEX_PATH` | 指定其他 harness 可执行文件的绝对路径;默认用包内依赖 |
| `CODEX_CONFIG` | JSON 对象,合并进 Codex 会话配置(高级用法) |
| `MODEL_PROVIDER` | 无活动网关时的 provider 选择;**不要**与环境网关同时表达矛盾选择 |
| `INITIAL_AGENT_MODE` | 初始模式:`read-only` / `workspace-write` / `agent` / `agent-full-access` |
| `NO_BROWSER` | 设置后隐藏 ChatGPT 浏览器登录入口 |
| `APP_SERVER_LOGS` | 适配器日志目录(`CODEX_LOG_DIR` 为回退)。日志不包含 Key 与原始协议内容 |
| `CODEX_ACP_APP_SERVER_CRASH_LIMIT` / `_CRASH_WINDOW_MS` | app-server 崩溃重启策略(默认 5 次 / 5 分钟) |

## 3. 平台配置示例

> 把 `<YOUR_API_KEY>` 换成你自己的 Key。以下基址与模型名来自各平台公开文档。

### 3.1 MiMo(小米)

```bash
# Chat Completions
export CODEX_BASE_URL='https://token-plan-cn.xiaomimimo.com/v1'
export CODEX_API_PROTOCOL='openai'
export CODEX_WIRE_API='chat'

# 或 Responses(同一基址)
# export CODEX_WIRE_API='responses'

# 或 Anthropic Messages
# export CODEX_BASE_URL='https://token-plan-cn.xiaomimimo.com/anthropic'
# export CODEX_API_PROTOCOL='anthropic'
# unset CODEX_WIRE_API

export CODEX_API_KEY='<YOUR_API_KEY>'
export CODEX_MODEL='mimo-v2.6-flash'          # 或 mimo-v2.5
export CODEX_MODEL_CONTEXT_WINDOW='128000'    # 按平台实际规格填写
```

### 3.2 GLM(智谱)

注意三条协议使用**不同基址**:

```bash
# Chat Completions
export CODEX_BASE_URL='https://open.bigmodel.cn/api/coding/paas/v4'
export CODEX_API_PROTOCOL='openai'
export CODEX_WIRE_API='chat'

# 或 Responses(独立基址)
# export CODEX_BASE_URL='https://open.bigmodel.cn/api/v1'
# export CODEX_WIRE_API='responses'

# 或 Anthropic Messages
# export CODEX_BASE_URL='https://open.bigmodel.cn/api/anthropic'
# export CODEX_API_PROTOCOL='anthropic'
# unset CODEX_WIRE_API

export CODEX_API_KEY='<YOUR_API_KEY>'
export CODEX_MODEL='GLM-5.3-Flash'
export CODEX_MODEL_CONTEXT_WINDOW='128000'
```

### 3.3 Step(阶跃)

```bash
# Chat Completions
export CODEX_BASE_URL='https://api.stepfun.com/step_plan/v1'
export CODEX_API_PROTOCOL='openai'
export CODEX_WIRE_API='chat'

# 或 Anthropic Messages
# export CODEX_BASE_URL='https://api.stepfun.com/step_plan'
# export CODEX_API_PROTOCOL='anthropic'
# unset CODEX_WIRE_API

export CODEX_API_KEY='<YOUR_API_KEY>'
export CODEX_MODEL='step-5-preview'           # 或 step-3.7-flash
export CODEX_MODEL_CONTEXT_WINDOW='128000'
```

## 4. 在 ACP 宿主里接入

ACP 是 stdio 协议:由宿主负责启动适配器进程。**环境变量必须配进宿主的 agent 环境**,
只在终端 `export` 对已运行的宿主无效。

以通用 ACP 客户端配置为例:

```json
{
  "nuwax-codex-acp": {
    "command": "nuwax-codex-acp-ts",
    "env": {
      "CODEX_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
      "CODEX_API_PROTOCOL": "anthropic",
      "CODEX_API_KEY": "<YOUR_API_KEY>",
      "CODEX_MODEL": "GLM-5.3-Flash",
      "CODEX_MODEL_CONTEXT_WINDOW": "128000",
      "INITIAL_AGENT_MODE": "workspace-write"
    }
  }
}
```

也可以不全局安装,直接 `npx -y @nuwax-ai/nuwax-codex-acp-ts` 作为 command。

切换平台 = 换一组 `CODEX_BASE_URL` / `CODEX_API_PROTOCOL` / `CODEX_WIRE_API` /
`CODEX_API_KEY` / `CODEX_MODEL`,重启适配器即可。

## 5. 验证与排查

1. `command -v nuwax-codex-acp-ts`、`--version` 确认安装;
   `nuwax-harness doctor --json` 查看实际 provider / wire / bridge 路由。
2. 在宿主里新建会话,发一句「请只回复:OK」,确认收到回复即通路正常。
3. 常见问题:

| 现象 | 原因与处理 |
| --- | --- |
| `session/new` 返回 Authentication required | `CODEX_BASE_URL` 没有进入适配器进程的环境;检查宿主的 env 配置 |
| 提示 nuwax-harness binary is not installed | 运行一次 `nuwax-harness --version` 触发下载,或设 `CODEX_PATH` 指向已有二进制 |
| 401 / 鉴权失败 | Key 与基址不属于同一平台或套餐;只设 `CODEX_API_KEY` 一把 Key |
| unknown model / 模型不存在 | `CODEX_MODEL` 拼写与平台不一致(注意大小写) |
| 上下文裁剪异常 | `CODEX_MODEL_CONTEXT_WINDOW` 未设或与实际不符;输出、文本和图片都占窗口 |
| `CODEX_BRIDGE` 相关报错 | `native` 只能配 Responses;`genai` 只能配 chat/anthropic;单独设 bridge 不设 base URL 会报错 |
| 模型不认识 `tool_search` 线格式 / MCP 工具行为异常 | 设 `CODEX_TOOL_SEARCH=false` 让 MCP 工具全量直出(见上表);`false` 字符串非法值会让引擎拒绝启动 |
| 宿主发送了 `providers/set` 或显式 `authenticate` | 会按优先级**替换**环境网关及其凭据;想继续用部署环境,不要让宿主主动改登录方式 |

4. 日志:设 `APP_SERVER_LOGS=<目录>` 后重试,日志里只有字节数不含凭据,可安全粘贴提问。

## 6. 优先级说明

同一进程内只选一套入口配置:

- 显式 CLI 模型/provider 选择 > 显式 `-c` 配置键 > `CODEX_*` 环境网关 > 配置文件。
- 显式 `authenticate` 或 `providers/set` 会替换环境网关、桥选择与凭据。
- 每个网关 `CODEX_*` 变量都有同义 `NUWAX_*` 别名(2026-10-28 起,含 `NUWAX_BRIDGE`——
  旧文档"不是别名、刻意忽略"的规则已废止):仅设其一即生效、同值幂等、异值启动报错
  点名两个变量;适配器消费掉的别名会从 app-server 子进程环境剥离,不会触发引擎
  `NUWAX_*` 启动组的孤儿检测。日常通过 ACP 使用时任选一套拼写即可,不要双设异值。
