# Nuwax Harness 使用指南

两个入口,同一个引擎:

1. **ACP 适配器 `nuwax-harness-acp-ts`** — 给编辑器 / Agent 宿主用(Zed、JetBrains、
   自研客户端),宿主通过 stdio 协议拉起适配器;
2. **`nuwax-harness` CLI** — 终端直接用:交互式对话、单次执行、独立 app-server。

```
终端 ─────────────────────────────────> nuwax-harness CLI ──┐
                                                           ├─ rig / native 桥 ──> 你的模型平台
ACP 宿主 ──stdio──> nuwax-harness-acp-ts 适配器 ──JSON-RPC──┘
                    (即 nuwax-harness app-server)
```

两个入口接同一批自定义模型平台(OpenAI Chat / OpenAI Responses / Anthropic Messages
协议均可),无需登录或额外认证流程。本指南覆盖两者的安装、环境变量、平台示例与排查。

## 1. 安装

```bash
# ACP 适配器:自带 @nuwax-ai/nuwax-harness 依赖,装完即可被宿主拉起
npm install -g @nuwax-ai/nuwax-harness-acp-ts
nuwax-harness-acp-ts --version

# 只用 CLI 的话,单独装引擎即可
npm install -g @nuwax-ai/nuwax-harness
nuwax-harness --version
```

> 旧 npm 包名 `@nuwax-ai/nuwax-codex-acp-ts` 已停止更新(停在 1.2.19)。新包同时提供
> 旧命令名 `nuwax-codex-acp-ts` 作为兼容别名,既有启动命令不受影响;后续版本会移除。

平台二进制由依赖包的 postinstall 自动下载到 `~/.nuwax-harness-cache/`。若被 npm 的
install-scripts 安全门拦截,或提示 binary 未安装,执行一次 `nuwax-harness --version`
即可补下。

## 2. 两套环境变量,先分清入口

| 入口 | 变量组 | 规则 |
| --- | --- | --- |
| CLI | `NUWAX_*` 启动组 | `NUWAX_BASE_URL` / `NUWAX_WIRE_API` / `NUWAX_API_KEY` 必须成组设置;`NUWAX_BRIDGE`、输出上限、重试等可选项孤立设置会报错 |
| ACP 适配器 | `CODEX_*` 网关变量(每个都有同义 `NUWAX_*` 别名) | 设 `CODEX_BASE_URL`(或 `NUWAX_BASE_URL`)即启用环境网关;仅设其一即生效,双设同值幂等、异值启动报错 |

两套拼写不要在同一进程里混用表达矛盾选择。日常推荐:CLI 用 `NUWAX_*`,ACP 用
`CODEX_*` 或 `NUWAX_*` 均可(`NUWAX_*` 与 CLI 组同名,习惯一致)。

## 3. 直接使用 CLI(`nuwax-harness`)

### 3.1 启动变量

| 变量 | 说明 |
| --- | --- |
| `NUWAX_BASE_URL` | 平台协议基址(必填)。用平台提供的协议基址,不要自行拼接 `/chat/completions`、`/responses`、`/messages` |
| `NUWAX_WIRE_API` | `chat` / `responses` / `anthropic`,必须显式设置 |
| `NUWAX_API_KEY` | 该端点的 Key,与上两项成组设置(`env_key` 引用,不落配置与诊断) |
| `NUWAX_MODEL` | 平台实际模型 ID(完整启动组需要它,或用 `-m` 显式给) |
| `NUWAX_BRIDGE` | 可选 `rig`(默认)/ `native` / `genai`;`native` 仅支持 Responses,`genai` 仅支持 chat/anthropic |
| `NUWAX_MAX_OUTPUT_TOKENS` | 可选:每次生成的输出上限(正整数,不是上下文窗口) |
| `NUWAX_REQUEST_MAX_RETRIES` / `NUWAX_STREAM_MAX_RETRIES` / `NUWAX_STREAM_IDLE_TIMEOUT_MS` | 可选:请求/流重试与流空闲超时;须随完整启动组使用 |
| `CODEX_HOME` | 可选:会话与状态目录(默认 `~/.nuwax-harness`) |
| `NUWAX_MODEL_CONTEXT_WINDOW` / `CODEX_MODEL_CONTEXT_WINDOW` | 可选:模型真实上下文窗口(token) |

### 3.2 常用命令

```bash
cd /path/to/your/project
export NUWAX_BASE_URL='https://your-provider.example/v1'
export NUWAX_WIRE_API='chat'
export NUWAX_MODEL='your-model-id'
export NUWAX_API_KEY='<YOUR_API_KEY>'

# 路由自检:provider / wire / bridge 是否符合预期(bridge 显示 rig (model bridge))
nuwax-harness doctor --json

# 交互式对话
nuwax-harness

# 单次执行,真实调一次模型
nuwax-harness exec '请只回复:OK'
```

独立 app-server(`nuwax-harness app-server --stdio`)是给客户端的 JSON-RPC 协议口,
启动本身不发对话,日常使用不需要手动跑它。

### 3.3 协议与桥

| 目标 | `NUWAX_WIRE_API` | `NUWAX_BRIDGE` |
| --- | --- | --- |
| OpenAI Chat Completions | `chat` | `rig`(或不设) |
| OpenAI Responses | `responses` | `rig`(或不设) |
| Anthropic Messages | `anthropic` | `rig`(或不设) |
| 原生 OpenAI Responses(直连 GPT 官方/中转站) | `responses` | `native` |

`native` 是进程环境到达原生 Responses 传输的唯一方式,且只允许配 `responses`;
`genai` 备用桥只支持 chat/anthropic。走原生时 `doctor` 显示 `bridge: native transport`。

## 4. 通过 ACP 适配器使用

### 4.1 网关变量

下表每个 `CODEX_*` 变量都有同义 `NUWAX_*` 别名:仅设其一即生效、双设同值幂等、
双设异值启动报错点名两个变量。无前缀的 `OPENAI_API_KEY`、`MODEL_PROVIDER`、
`INITIAL_AGENT_MODE`、`NO_BROWSER`、`APP_SERVER_LOGS` 不设别名。

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `CODEX_BASE_URL` | 平台的协议基址(必填,设置即启用环境网关)。不要自行拼接 `/chat/completions`、`/responses`、`/messages` | 无 |
| `CODEX_API_KEY` | 该端点的 Key。取键链 `NUWAX_API_KEY` > `CODEX_API_KEY` > `OPENAI_API_KEY`;建议只设一个,避免串用 | 无 |
| `CODEX_API_PROTOCOL` | 协议族:`openai` 或 `anthropic` | `openai` |
| `CODEX_WIRE_API` | OpenAI 族内的 wire:`responses` 或 `chat`。**Anthropic 协议时不要设置**(由 `CODEX_API_PROTOCOL=anthropic` 选择) | `responses` |
| `CODEX_BRIDGE` | 传输桥:`rig`、`native`、`genai`。`native` 仅支持 OpenAI Responses;`genai` 仅支持 chat/anthropic;单独设置而不设 base URL 会报错 | `rig` |
| `CODEX_MODEL` | 平台的实际模型 ID。网关激活时会覆盖 Codex 默认模型 | 无 |
| `CODEX_MODEL_CONTEXT_WINDOW` | 模型真实上下文窗口(token 数,正整数)。强烈建议按平台规格填写,本地预算与压缩依赖它 | 无 |
| `NUWAX_MAX_OUTPUT_TOKENS` | 每次生成的输出上限(正整数,不是上下文窗口)。与 CLI 启动组同名,一处配置两侧生效;非法值会在适配器启动时报错 | 不设 |
| `CODEX_TOOL_SEARCH` | `false` = MCP 工具在首个请求**全量直出**(不注册 tool_search/Deferred),用于不支持 tool_search 线格式的自托管/第三方网关或需要确定性工具表的部署;`true`/不设 = 官方默认。仅接受大小写不敏感的 `true`/`false`,其他值引擎启动即报错;`CODEX_CONFIG` 里的 `tools.tool_search` 属显式配置,优先于本变量 | 不设 |
| `CODEX_PROVIDER_ID` | 网关的 provider ID(可选) | `custom-gateway` |
| `CODEX_PROVIDER_NAME` | 网关展示名(可选),缺省回退 `CODEX_MODEL`,再回退 `Custom Gateway` | — |
| `CODEX_DISABLE_THINKING` | 设为 `true`/`1`/`yes`/`on` 时把推理力度固定为 `none`(用于不支持推理的模型) | 不启用 |

CLI 拼写换算:CLI 的单变量 `NUWAX_WIRE_API` 在 ACP 侧拆成
`CODEX_API_PROTOCOL` + `CODEX_WIRE_API`(openai+chat→`chat`;openai+responses→
`responses`;anthropic→`CODEX_API_PROTOCOL=anthropic` 且不设 wire);其余变量同名。

常用组合:

| 目标 | `CODEX_API_PROTOCOL` | `CODEX_WIRE_API` | `CODEX_BRIDGE` |
| --- | --- | --- | --- |
| OpenAI Chat Completions | `openai` | `chat` | `rig`(或不设) |
| OpenAI Responses | `openai` | `responses` | `rig`(或不设) |
| Anthropic Messages | `anthropic` | 不设 | `rig`(或不设) |
| 原生 OpenAI Responses(直连官方/中转) | `openai` | `responses` | `native` |

### 4.2 通用配置

| 变量 | 说明 |
| --- | --- |
| `CODEX_PATH`(别名 `NUWAX_PATH`) | 指定其他 harness 可执行文件的绝对路径;默认用包内依赖 |
| `CODEX_CONFIG` | JSON 对象,合并进 Codex 会话配置(高级用法) |
| `MODEL_PROVIDER` | 无活动网关时的 provider 选择;**不要**与环境网关同时表达矛盾选择 |
| `INITIAL_AGENT_MODE` | 初始模式:`read-only` / `workspace-write` / `agent` / `agent-full-access` |
| `NO_BROWSER` | 设置后隐藏 ChatGPT 浏览器登录入口 |
| `APP_SERVER_LOGS` | 适配器日志目录(`CODEX_LOG_DIR` 为回退)。日志不包含 Key 与原始协议内容 |
| `CODEX_ACP_APP_SERVER_CRASH_LIMIT` / `_CRASH_WINDOW_MS` | app-server 崩溃重启策略(默认 5 次 / 5 分钟) |

### 4.3 平台配置示例

> 把 `<YOUR_API_KEY>` 换成你自己的 Key。以下基址与模型名来自各平台公开文档。

#### MiMo(小米)

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

#### GLM(智谱)

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

#### Step(阶跃)

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

### 4.4 在 ACP 宿主里接入

ACP 是 stdio 协议:由宿主负责启动适配器进程。**环境变量必须配进宿主的 agent 环境**,
只在终端 `export` 对已运行的宿主无效。

以通用 ACP 客户端配置为例:

```json
{
  "nuwax-harness-acp-ts": {
    "command": "nuwax-harness-acp-ts",
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

也可以不全局安装,直接 `npx -y @nuwax-ai/nuwax-harness-acp-ts` 作为 command。

切换平台 = 换一组 `CODEX_BASE_URL` / `CODEX_API_PROTOCOL` / `CODEX_WIRE_API` /
`CODEX_API_KEY` / `CODEX_MODEL`,重启适配器即可。

## 5. 验证与排查

1. `command -v nuwax-harness-acp-ts`(或 `nuwax-harness`)、`--version` 确认安装;
   `nuwax-harness doctor --json` 查看实际 provider / wire / bridge 路由。
2. CLI 发一句 `nuwax-harness exec '请只回复:OK'`,或在宿主里新建会话发同样的话,
   收到回复即通路正常。
3. 常见问题:

| 现象 | 原因与处理 |
| --- | --- |
| `session/new` 返回 Authentication required | base URL 变量没有进入适配器进程的环境;检查宿主的 env 配置 |
| 提示 nuwax-harness binary is not installed | 运行一次 `nuwax-harness --version` 触发下载,或设 `CODEX_PATH` 指向已有二进制 |
| CLI 报 NUWAX_* 组不完整 / 孤立设置 | CLI 启动组必须成组:`NUWAX_BASE_URL` + `NUWAX_WIRE_API` + `NUWAX_API_KEY` |
| 401 / 鉴权失败 | Key 与基址不属于同一平台或套餐;只设一把 Key,避免串用 |
| unknown model / 模型不存在 | 模型变量拼写与平台不一致(注意大小写) |
| 上下文裁剪异常 | 上下文窗口变量未设或与实际不符;输出、文本和图片都占窗口 |
| bridge 相关报错 | `native` 只能配 Responses;`genai` 只能配 chat/anthropic;单独设 bridge 不设 base URL 会报错 |
| 模型不认识 `tool_search` 线格式 / MCP 工具行为异常 | 设 `CODEX_TOOL_SEARCH=false` 让 MCP 工具全量直出(见上表);非法值会让引擎拒绝启动 |
| 宿主发送了 `providers/set` 或显式 `authenticate` | 会按优先级**替换**环境网关及其凭据;想继续用部署环境,不要让宿主主动改登录方式 |

4. 日志:设 `APP_SERVER_LOGS=<目录>` 后重试,日志里只有字节数不含凭据,可安全粘贴提问。

## 6. 优先级与别名规则

同一进程内只选一套入口配置:

- 显式 CLI 模型/provider 选择 > 显式 `-c` 配置键 > `CODEX_*` 环境网关 > 配置文件。
- 显式 `authenticate` 或 `providers/set` 会替换环境网关、桥选择与凭据。
- ACP 网关每个 `CODEX_*` 变量都有同义 `NUWAX_*` 别名(含 `NUWAX_BRIDGE`):仅设其一
  即生效、同值幂等、异值启动报错点名两个变量;适配器消费掉的别名会从 app-server
  子进程环境剥离,不会触发引擎 `NUWAX_*` 启动组的孤儿检测。日常通过 ACP 使用时
  任选一套拼写即可,不要双设异值。
