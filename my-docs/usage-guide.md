# Nuwax Harness 使用指南

同一个引擎,两个使用入口。**按你的使用方式选读对应部分即可,两部分各自自足**:

- **第一部分 — 直接使用 `nuwax-harness`(CLI)**:终端里自己跑模型(交互式、单次执行);
- **第二部分 — 通过 `nuwax-harness-acp-ts`(ACP 协议)**:给编辑器 / Agent 宿主接模型
  (Zed、JetBrains、自研客户端),宿主通过 stdio 拉起适配器。

```
终端 ─────────────────────────────────> nuwax-harness CLI ──┐
                                                           ├─ rig / native 桥 ──> 你的模型平台
ACP 宿主 ──stdio──> nuwax-harness-acp-ts 适配器 ──JSON-RPC──┘
                    (即 nuwax-harness app-server)
```

两个入口接同一批自定义模型平台(OpenAI Chat / OpenAI Responses / Anthropic Messages
协议均可),无需登录或额外认证流程。本指南统一只展示 `NUWAX_*` 拼写;两个入口的
变量组互相独立,不要在同一进程里混用表达矛盾的选择。

---

# 第一部分:直接使用 nuwax-harness(CLI)

## 1.1 安装

```bash
npm install -g @nuwax-ai/nuwax-harness
nuwax-harness --version
```

平台二进制由 postinstall 自动下载到 `~/.nuwax-harness-cache/`。若被 npm 的
install-scripts 安全门拦截,或提示 binary 未安装,执行一次 `nuwax-harness --version`
即可补下。

## 1.2 快速开始(30 秒验证)

**4 个必填变量** + **1 个建议显式配置**(推理力度),以 OpenAI Chat 协议为例:

```bash
export NUWAX_BASE_URL='https://your-provider.example/v1'   # 平台的协议基址
export NUWAX_WIRE_API='chat'                               # chat / responses / anthropic
export NUWAX_MODEL='your-model-id'                         # 平台的模型 ID
export NUWAX_API_KEY='<YOUR_API_KEY>'

# 建议再显式指定推理力度:自定义模型默认用 medium,不一定是你平台支持的值
export NUWAX_MODEL_REASONING_EFFORT='high'                 # none|minimal|low|medium|high|xhigh|max
# 不需要模型思考:NUWAX_MODEL_REASONING_EFFORT=none

nuwax-harness exec '请只回复:OK'     # 收到 OK 即全链路正常
```

Anthropic 协议:把基址换成平台的 Anthropic 端点,`NUWAX_WIRE_API` 设为 `anthropic`。

上面的 `export` 只对当前终端有效。**长期使用请写进配置文件**(一次配置,所有终端、
所有项目生效),见 §1.5 全局配置。

三家平台(MiMo / GLM / Step)的现成基址与模型名见第二部分 §2.5;按附录 A 换算:
基址、Key、模型、桥同名,仅 wire 换成单变量拼法。

## 1.3 启动变量

| 变量 | 说明 |
| --- | --- |
| `NUWAX_BASE_URL` | 平台协议基址(必填)。用平台提供的协议基址,不要自行拼接 `/chat/completions`、`/responses`、`/messages` |
| `NUWAX_WIRE_API` | `chat` / `responses` / `anthropic`,必须显式设置 |
| `NUWAX_API_KEY` | 该端点的 Key,与上两项成组设置(在 config.toml 里用 `env_key` 按名字引用它,Key 不落盘) |
| `NUWAX_MODEL` | 平台实际模型 ID(完整启动组需要它,或用 `-m` 显式给) |
| `NUWAX_BRIDGE` | 可选 `rig`(默认)/ `native` / `genai`;`native` 仅支持 Responses,`genai` 仅支持 chat/anthropic |
| `NUWAX_MAX_OUTPUT_TOKENS` | 可选:每次生成的输出上限(正整数,不是上下文窗口) |
| `NUWAX_REQUEST_MAX_RETRIES` / `NUWAX_STREAM_MAX_RETRIES` / `NUWAX_STREAM_IDLE_TIMEOUT_MS` | 可选:请求/流重试与流空闲超时;须随完整启动组使用 |
| `NUWAX_HOME` | 可选:会话与状态目录(默认 `~/.nuwax-harness`) |
| `NUWAX_MODEL_CONTEXT_WINDOW` | 可选:模型真实上下文窗口(token) |
| `NUWAX_MODEL_REASONING_EFFORT` | 推理力度:`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` 等,不设则自定义模型按 `medium`;平台不接受该值时用它覆盖(ACP 侧的等效开关是 `NUWAX_DISABLE_THINKING`,见第二部分) |
| `NUWAX_AUTO_COMPACT_TOKEN_LIMIT` / `NUWAX_AUTO_COMPACT_RATIO` | 可选:自动压缩的 token 阈值 / 窗口比例(显式 `-c` 优先于这些种子) |

## 1.4 常用命令

```bash
# 路由自检:provider / wire / bridge 是否符合预期(bridge 显示 rig (model bridge))
nuwax-harness doctor --json

# 交互式对话
nuwax-harness

# 单次执行,真实调一次模型
nuwax-harness exec '请只回复:OK'
```

> **为什么要求 Git 仓库**:交互式与 `exec` 会直接改文件、跑命令,引擎以 Git 仓库作为
> **可信边界**(改动可 review、可回滚);非 Git 目录里无法判断影响范围,因此拒绝启动。
> 这不是安装问题,是引擎启动 CLI 时的安全策略。
>
> **绕过方式**(任选其一):
> 1. 在 Git 仓库内运行——最省事,`git init` 一下即可,无需任何参数;
> 2. 加 `--skip-git-repo-check`(全局 flag,`nuwax-harness --skip-git-repo-check` 或
>    `nuwax-harness exec --skip-git-repo-check '...'` 都认);
> 3. 已在外层沙箱/容器中运行时用 `--yolo`,会连同审批沙箱一起绕过。
>
> **通过 ACP 宿主使用不受此限**:该检查只在 CLI 的 exec/交互层,适配器走 app-server
> 协议(见第二部分),任何目录都能用。

独立 app-server(`nuwax-harness app-server --stdio`)是给客户端的 JSON-RPC 协议口,
启动本身不发对话,日常使用不需要手动跑它(给 ACP 宿主用时,见第二部分)。

## 1.5 全局配置(config.toml,一次配置长期生效)

上面的 `export` 只对当前终端有效。日常长期使用建议把 provider 写进配置文件,
**所有终端、所有项目通用**:

```bash
~/.nuwax-harness/config.toml        # 目录可用 NUWAX_HOME 改到别处(如外接盘)
```

以 GLM Coding Plan(Anthropic 线)为例:

```toml
# ~/.nuwax-harness/config.toml
model = "GLM-5.3-Flash"
model_provider = "glm"

# 按平台规格填真实窗口;自定义模型的显式覆盖全额生效
model_context_window = 128000

[model_providers.glm]
name = "GLM Coding Plan (Anthropic)"
base_url = "https://open.bigmodel.cn/api/anthropic"
env_key = "GLM_API_KEY"          # Key 从该环境变量读取,不落盘
wire_api = "anthropic"           # responses | chat | anthropic
# max_output_tokens = 8192       # 可选:输出上限
```

**API Key 不写进配置文件**——用 `env_key` 引用环境变量名,Key 放进受保护的环境文件:

```bash
mkdir -p "$HOME/.config/nuwax-harness"
echo "export GLM_API_KEY='<YOUR_API_KEY>'" >> "$HOME/.config/nuwax-harness/agent.env"
chmod 600 "$HOME/.config/nuwax-harness/agent.env"
. "$HOME/.config/nuwax-harness/agent.env"    # 每次开终端加载一次(可写进 ~/.zshrc)
```

之后直接 `nuwax-harness` 即用上该 provider,无需再设任何环境变量。

**多协议线对比**:每条线一个独立配置文件(放在同一目录),启动时用 `--profile` 切:

```bash
~/.nuwax-harness/mimo-responses.config.toml     # 文件名 = profile 名
```

```toml
# ~/.nuwax-harness/mimo-responses.config.toml
model = "mimo-v2.6-flash"
model_provider = "mimo-responses"

[model_providers.mimo-responses]
name = "MiMo (OpenAI Responses)"
base_url = "https://token-plan-cn.xiaomimimo.com/v1"
env_key = "MIMO_API_KEY"
wire_api = "responses"
```

```bash
nuwax-harness --profile mimo-responses          # 用该 profile(短写法 -p)
nuwax-harness -c model_provider=mimo-responses   # 临时覆盖,不改任何文件
```

(该 profile 用的 `MIMO_API_KEY` 同样放进上面的环境文件。)

> **不要**在 `config.toml` 里写 `[profiles.<名字>]` 表——该写法已废弃,配 `--profile`
> 会直接报错;应改用上面的独立配置文件。

**要点**:

- 优先级:显式 CLI(`-m` / `-c`)> 环境种子(`NUWAX_*`)> config.toml。
- `nuwax_env` 是引擎保留的 provider ID,不要在配置文件里手工定义同名 provider。
- 自定义 provider 不弹官方登录界面,Key 在环境变量里即可直接进交互式/exec。
- 常用可选字段:`max_output_tokens`、`request_max_retries`、`stream_max_retries`、
  `stream_idle_timeout_ms`、`anthropic_prompt_caching`(Anthropic 线 prompt 缓存,
  默认关);MCP 工具全量直出可写 `[tools] tool_search = false`。
- 验证配置:`nuwax-harness doctor --json`,看 `checks["config.model_routing"].details`
  里的 `provider id` / `wire api` / `bridge` / `model` / `effective context window` /
  `endpoint source` 是否符合预期(`auth.credentials` 一项会显示 Key 环境变量是否被取到)。
  注意 doctor 输出里端点是打码的(`<redacted>`),可安全粘贴提问。

## 1.6 协议与桥

| 目标 | `NUWAX_WIRE_API` | `NUWAX_BRIDGE` |
| --- | --- | --- |
| OpenAI Chat Completions | `chat` | `rig`(或不设) |
| OpenAI Responses | `responses` | `rig`(或不设) |
| Anthropic Messages | `anthropic` | `rig`(或不设) |
| 原生 OpenAI Responses(直连 GPT 官方/中转站) | `responses` | `native` |

`native` 是进程环境到达原生 Responses 传输的唯一方式,且只允许配 `responses`;
`genai` 备用桥只支持 chat/anthropic。走原生时 `doctor` 显示 `bridge: native transport`。

## 1.7 排查

| 现象 | 原因与处理 |
| --- | --- |
| 报 NUWAX_* 组不完整 / 孤立设置 | CLI 启动组必须成组:`NUWAX_BASE_URL` + `NUWAX_WIRE_API` + `NUWAX_API_KEY` |
| 报 "Not inside a trusted directory" | 交互式与 `exec` 需在 Git 仓库内运行;非 Git 目录加 `--skip-git-repo-check`(见 §1.4) |
| 平台报 effort 取值不支持 / 不支持关闭思考 | 自定义模型默认用 `medium`,平台不接受就改 `NUWAX_MODEL_REASONING_EFFORT`(如 `low`/`high`/`max`)。**更彻底的做法**:设 `NUWAX_REASONING_EFFORT_LEVELS='low,high,max'` 声明该网关模型真实接受的档位,之后选了表里没有的档位(或关思考)会在**请求发出前**就报错并点名可用档位,而不是被网关静默映射成别的档位——直连官方端点也可能不校验(实测对 `medium`/`minimal`/`ultra` 一律返回 200),所以 200 不代表档位被采纳。声明后务必同时给一个真实存在的档位。另:“关思考”发的是 `thinking:{type:"disabled"}`,始终思考的模型会拒,这时也给显式档位而不是关 |
| 401 / 鉴权失败 | Key 与基址不属于同一平台或套餐 |
| unknown model / 模型不存在 | `NUWAX_MODEL` 拼写与平台不一致(注意大小写) |
| bridge 相关报错 | `native` 只能配 Responses;`genai` 只能配 chat/anthropic |
| 上下文裁剪异常 | 设 `NUWAX_MODEL_CONTEXT_WINDOW` 为模型真实窗口;输出、文本和图片都占窗口 |

---

# 第二部分:通过 nuwax-harness-acp-ts(ACP 协议接入)

适配器把 ACP 协议(stdio)翻译给引擎,供编辑器 / Agent 宿主集成。环境变量配**环境网关**,
无需登录或显式认证。

## 2.1 安装

```bash
npm install -g @nuwax-ai/nuwax-harness-acp-ts
nuwax-harness-acp-ts --version
```

适配器自带 `@nuwax-ai/nuwax-harness` 依赖,postinstall 自动下载平台二进制到
`~/.nuwax-harness-cache/`;若提示 binary 未安装,执行一次 `nuwax-harness --version` 补下
(单独装引擎的命令见第一部分)。

> 旧 npm 包名已停止更新(停在 1.2.19),新包同时提供旧命令名作为兼容别名,
> 既有启动命令不受影响;后续版本会移除。

## 2.2 快速开始(宿主最小配置)

**4 个必填变量** + **1 个建议显式配置**(推理力度),配进宿主的 agent 环境
(以 OpenAI Chat 协议为例):

```json
{
  "nuwax-harness-acp-ts": {
    "command": "nuwax-harness-acp-ts",
    "env": {
      "NUWAX_BASE_URL": "https://your-provider.example/v1",
      "NUWAX_WIRE_API": "chat",
      "NUWAX_MODEL": "your-model-id",
      "NUWAX_API_KEY": "<YOUR_API_KEY>",
      "NUWAX_MODEL_REASONING_EFFORT": "high"
    }
  }
}
```

> 自定义模型默认用 `medium`,不一定是你平台支持的值——按平台换成
> `none` / `low` / `high` / `max` 等(完整取值见 §2.3)。
> 不需要模型思考,就把该项换成 `"NUWAX_DISABLE_THINKING": "true"`
> (等价于把力度固定为 `none`)。

在宿主里新建会话,发一句「请只回复:OK」,收到回复即接入完成。
也可以不全局安装,直接 `npx -y @nuwax-ai/nuwax-harness-acp-ts` 作为 command。

> **不想在宿主里配一串变量?** 也可以只用全局配置文件:按第一部分 §1.5 写好
> `~/.nuwax-harness/config.toml`,宿主 `env` 里只留 Key(如 `GLM_API_KEY`)即可,
> 其余变量都不用设——适配器的 app-server 同样读该配置(已实测)。
> 注意:一旦设了 `NUWAX_BASE_URL` 等网关变量,它们会**覆盖**配置文件里的
> provider 选择(优先级见附录 B),两者不要混用。

## 2.3 网关变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `NUWAX_BASE_URL` | 平台的协议基址(必填,设置即启用环境网关)。不要自行拼接 `/chat/completions`、`/responses`、`/messages` | 无 |
| `NUWAX_API_KEY` | 该端点的 Key。建议只设这一个,避免与其他 Key 串用;未设时回退 `OPENAI_API_KEY` | 无 |
| `NUWAX_API_PROTOCOL` | 协议族:`openai` 或 `anthropic` | `openai` |
| `NUWAX_WIRE_API` | OpenAI 族内的 wire:`responses` 或 `chat`。**Anthropic 协议时不要设置**(由 `NUWAX_API_PROTOCOL=anthropic` 选择) | `responses` |
| `NUWAX_BRIDGE` | 传输桥:`rig`、`native`、`genai`。`native` 仅支持 OpenAI Responses;`genai` 仅支持 chat/anthropic;单独设置而不设 base URL 会报错 | `rig` |
| `NUWAX_MODEL` | 平台的实际模型 ID。网关激活时会覆盖默认模型 | 无 |
| `NUWAX_MODEL_CONTEXT_WINDOW` | 模型真实上下文窗口(token 数,正整数)。强烈建议按平台规格填写,本地预算与压缩依赖它 | 无 |
| `NUWAX_MAX_OUTPUT_TOKENS` | 每次生成的输出上限(正整数,不是上下文窗口)。CLI 与 ACP 两侧同名同义,一处配置两侧通用;非法值会在适配器启动时报错 | 不设 |
| `NUWAX_TOOL_SEARCH` | `false` = MCP 工具在首个请求**全量直出**(不注册 tool_search/Deferred),用于不支持 tool_search 线格式的自托管/第三方网关或需要确定性工具表的部署;`true`/不设 = 官方默认。仅接受大小写不敏感的 `true`/`false`,其他值引擎启动即报错;`NUWAX_CONFIG` 里的 `tools.tool_search` 属显式配置,优先于本变量 | 不设 |
| `NUWAX_PROVIDER_ID` | 网关的 provider ID(可选) | `custom-gateway` |
| `NUWAX_PROVIDER_NAME` | 网关展示名(可选),缺省回退 `NUWAX_MODEL`,再回退 `Custom Gateway` | — |
| `NUWAX_DISABLE_THINKING` | 设为 `true`/`1`/`yes`/`on` 时把推理力度固定为 `none`,即**关闭思考**(用于不支持推理的模型);这是 ACP 侧关闭思考的开关,CLI 侧用 `NUWAX_MODEL_REASONING_EFFORT=none` | 不启用 |

## 2.4 通用配置

| 变量 | 说明 |
| --- | --- |
| `NUWAX_PATH` | 指定其他 harness 可执行文件的绝对路径;默认用包内依赖 |
| `NUWAX_CONFIG` | JSON 对象,合并进会话配置(高级用法) |
| `MODEL_PROVIDER` | 无活动网关时的 provider 选择;**不要**与环境网关同时表达矛盾选择 |
| `INITIAL_AGENT_MODE` | 初始模式:`read-only` / `workspace-write` / `agent` / `agent-full-access` |
| `NO_BROWSER` | 设置后隐藏浏览器登录入口 |
| `APP_SERVER_LOGS` | 适配器日志目录。日志不包含 Key 与原始协议内容 |
| `NUWAX_ACP_APP_SERVER_CRASH_LIMIT` | 可选运维参数:引擎 app-server 在崩溃窗口内自动重启的次数上限(默认 `5`),超过后停止自动重启 |
| `NUWAX_ACP_APP_SERVER_CRASH_WINDOW_MS` | 可选运维参数:上述崩溃计数的时间窗口,毫秒(默认 `300000`,即 5 分钟) |

## 2.5 平台配置示例

> 把 `<YOUR_API_KEY>` 换成你自己的 Key。以下基址与模型名来自各平台公开文档。

#### MiMo(小米)

```bash
# Chat Completions
export NUWAX_BASE_URL='https://token-plan-cn.xiaomimimo.com/v1'
export NUWAX_API_PROTOCOL='openai'
export NUWAX_WIRE_API='chat'

# 或 Responses(同一基址)
# export NUWAX_WIRE_API='responses'

# 或 Anthropic Messages
# export NUWAX_BASE_URL='https://token-plan-cn.xiaomimimo.com/anthropic'
# export NUWAX_API_PROTOCOL='anthropic'
# unset NUWAX_WIRE_API

export NUWAX_API_KEY='<YOUR_API_KEY>'
export NUWAX_MODEL='mimo-v2.6-flash'          # 或 mimo-v2.5
export NUWAX_MODEL_CONTEXT_WINDOW='128000'    # 按平台实际规格填写
```

#### GLM(智谱)

注意三条协议使用**不同基址**:

```bash
# Chat Completions
export NUWAX_BASE_URL='https://open.bigmodel.cn/api/coding/paas/v4'
export NUWAX_API_PROTOCOL='openai'
export NUWAX_WIRE_API='chat'

# 或 Responses(独立基址)
# export NUWAX_BASE_URL='https://open.bigmodel.cn/api/v1'
# export NUWAX_WIRE_API='responses'

# 或 Anthropic Messages
# export NUWAX_BASE_URL='https://open.bigmodel.cn/api/anthropic'
# export NUWAX_API_PROTOCOL='anthropic'
# unset NUWAX_WIRE_API

export NUWAX_API_KEY='<YOUR_API_KEY>'
export NUWAX_MODEL='GLM-5.3-Flash'
export NUWAX_MODEL_CONTEXT_WINDOW='128000'
```

#### Step(阶跃)

```bash
# Chat Completions
export NUWAX_BASE_URL='https://api.stepfun.com/step_plan/v1'
export NUWAX_API_PROTOCOL='openai'
export NUWAX_WIRE_API='chat'

# 或 Anthropic Messages
# export NUWAX_BASE_URL='https://api.stepfun.com/step_plan'
# export NUWAX_API_PROTOCOL='anthropic'
# unset NUWAX_WIRE_API

export NUWAX_API_KEY='<YOUR_API_KEY>'
export NUWAX_MODEL='step-5-preview'           # 或 step-3.7-flash
export NUWAX_MODEL_CONTEXT_WINDOW='128000'
```

## 2.6 在 ACP 宿主里接入

ACP 是 stdio 协议:由宿主负责启动适配器进程。**环境变量必须配进宿主的 agent 环境**,
只在终端 `export` 对已运行的宿主无效(§2.2 的最小配置即宿主 `env` 块的完整内容)。

切换平台 = 换一组 `NUWAX_BASE_URL` / `NUWAX_API_PROTOCOL` / `NUWAX_WIRE_API` /
`NUWAX_API_KEY` / `NUWAX_MODEL`,重启适配器即可。

## 2.7 排查

| 现象 | 原因与处理 |
| --- | --- |
| `session/new` 返回 Authentication required | base URL 变量没有进入适配器进程的环境;检查宿主的 env 配置 |
| 提示 binary is not installed | 运行一次 `nuwax-harness --version` 触发下载,或设 `NUWAX_PATH` 指向已有二进制 |
| 平台报 effort 取值不支持 / 不支持关闭思考 | 适配器默认把 effort 钉成 `medium`(会话信息显示 `<模型>[medium]`),宿主界面可能不提供 effort 选择器;在宿主 `env` 加 `NUWAX_MODEL_REASONING_EFFORT` 覆盖。**推荐同时设 `NUWAX_REASONING_EFFORT_LEVELS`**(如 `'low,high,max'`)声明该网关模型真实接受的档位:之后选了表里没有的档位会在**请求发出前**报错并点名可用档位,不再被网关静默映射。**注意**:声明后适配器那个 `medium` 默认值也会被拒,所以必须同时给 `NUWAX_MODEL_REASONING_EFFORT` 或让宿主选一个真实档位,否则每轮都会失败。“关思考”走 `NUWAX_DISABLE_THINKING`(发 `thinking:{type:"disabled"}`),始终思考的平台会拒,这时也改给显式档位 |
| 401 / 鉴权失败 | Key 与基址不属于同一平台或套餐;只设一把 Key,避免串用 |
| unknown model / 模型不存在 | 模型变量拼写与平台不一致(注意大小写) |
| 上下文裁剪异常 | 上下文窗口变量未设或与实际不符;输出、文本和图片都占窗口 |
| bridge 相关报错 | `native` 只能配 Responses;`genai` 只能配 chat/anthropic;单独设 bridge 不设 base URL 会报错 |
| 模型不认识 `tool_search` 线格式 / MCP 工具行为异常 | 设 `NUWAX_TOOL_SEARCH=false` 让 MCP 工具全量直出(见上表);非法值会让引擎拒绝启动 |
| 宿主发送了 `providers/set` 或显式 `authenticate` | 会按优先级**替换**环境网关及其凭据;想继续用部署环境,不要让宿主主动改登录方式 |
| 日志排查 | 设 `APP_SERVER_LOGS=<目录>` 后重试,日志里只有字节数不含凭据,可安全粘贴提问 |

---

# 附录

## A. CLI ↔ ACP 变量换算

| 语义 | CLI(第一部分) | ACP(第二部分) |
| --- | --- | --- |
| 协议 + wire | 单变量 `NUWAX_WIRE_API`(`chat` / `responses` / `anthropic`) | 拆成两变量:`NUWAX_API_PROTOCOL`(`openai`/`anthropic`)+ `NUWAX_WIRE_API`(`chat`/`responses`,anthropic 时不设) |
| 基址 / Key / 模型 / 桥 | `NUWAX_BASE_URL` / `NUWAX_API_KEY` / `NUWAX_MODEL` / `NUWAX_BRIDGE` | 同名同义 |
| 输出上限 | `NUWAX_MAX_OUTPUT_TOKENS` | 同名同义,一处配置两侧通用 |
| 推理力度 / 关思考 | `NUWAX_MODEL_REASONING_EFFORT`(取 `none` 即关思考) | 档位同上;关思考另有开关 `NUWAX_DISABLE_THINKING=true` |

## B. 优先级与兼容说明

- 同一进程内只选一套入口配置:显式 CLI 模型/provider 选择 > 显式 `-c` 配置键 >
  环境网关变量 > 配置文件。显式 `authenticate` 或 `providers/set` 会替换环境网关、
  桥选择与凭据。
- 适配器消费掉的启动变量会从引擎子进程环境剥离,不会触发引擎 `NUWAX_*` 启动组的
  孤儿检测。
- 旧 npm 包名(已停止更新,停在 1.2.19)与旧命令名的兼容别名仍受支持,后续版本移除。
