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
协议均可),无需登录或额外认证流程。

## 0. 读前须知

1. **本指南只写 `NUWAX_*` 拼写。**每个 `NUWAX_*` 变量都有等价的旧拼写(前缀不同、
   变量名同义),两者永久兼容:只设其一即生效,同值幂等,异值启动报错并点名两个变量。
   两条入口的变量组互相独立,不要在同一进程里混用表达矛盾的选择。
2. **环境变量只管"本次运行";长期使用请写配置文件**(§1.5)。已在配置里选好 provider
   的用户,宿主 `env` 里通常只留一个 Key 就够。
3. **三个默认值最常见的坑**(两条入口都适用,详见各表的同名行):

   | 想知道的事 | 变量 | 不设时的行为 |
   | --- | --- | --- |
   | 模型按哪档"思考"跑 | `NUWAX_MODEL_REASONING_EFFORT` / `NUWAX_REASONING_EFFORT_LEVELS` | 不发票位字段,由平台默认执行(适配器兜底见 §2.3) |
   | MCP 工具是否首轮全量直出 | `NUWAX_TOOL_SEARCH` | 默认懒加载(`tool_search`),自托管网关常需设为 `false` |
   | 图片占多少请求体 | `NUWAX_IMAGE_MAX_BYTES` / `NUWAX_REQUEST_IMAGE_MAX_BYTES` | 单图按线路(2 MiB 或不限),整请求 20 MiB |

## 0.1 包与版本

| npm 包 | 命令 | 说明 |
| --- | --- | --- |
| `@nuwax-ai/nuwax-harness` | `nuwax-harness` | 引擎本体:CLI + `app-server` + 平台二进制 |
| `@nuwax-ai/nuwax-harness-acp-ts` | `nuwax-harness-acp-ts` | ACP 适配器,自带引擎作为依赖 |

本指南的功能基线:**引擎 `0.18.41` 及以上**、**适配器 `1.2.34` 及以上**。
更早的版本会缺本指南里的部分变量(例如引擎 `0.18.22` 及更早会静默忽略推理档位表,
`0.18.23` 上设推理档位表会直接启动报错;适配器 `1.2.23` 及更早不认档位表)。
已装旧版先升级:`npm install -g <包名>@latest`。

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

# 建议再显式指定推理力度:不设则不发档位字段,由平台按自家默认执行,
# 不一定是你要的档位
export NUWAX_MODEL_REASONING_EFFORT='high'                 # none|minimal|low|medium|high|xhigh|max
# 不需要模型思考:NUWAX_MODEL_REASONING_EFFORT=none

nuwax-harness exec '请只回复:OK'     # 收到 OK 即全链路正常
```

Anthropic 协议:把基址换成平台的 Anthropic 端点,`NUWAX_WIRE_API` 设为 `anthropic`。

上面的 `export` 只对当前终端有效。**长期使用请写进配置文件**(一次配置,所有终端、
所有项目生效),见 §1.5 全局配置。

三家平台(MiMo / GLM / Step)的现成基址与模型名见第二部分 §2.6;按附录 A 换算:
基址、Key、模型、桥同名,仅 wire 换成单变量拼法。

## 1.3 变量总览(按用途分组)

### 启动组(三件套 + 模型)

| 变量 | 说明 |
| --- | --- |
| `NUWAX_BASE_URL` | 平台协议基址(必填)。用平台提供的协议基址,不要自行拼接 `/chat/completions`、`/responses`、`/messages` |
| `NUWAX_WIRE_API` | `chat` / `responses` / `anthropic`,必须显式设置 |
| `NUWAX_API_KEY` | 该端点的 Key,与上两项成组设置(在 config.toml 里用 `env_key` 按名字引用它,Key 不落盘) |
| `NUWAX_MODEL` | 平台实际模型 ID(完整启动组需要它,或用 `-m` 显式给) |

三件套成组激活临时 provider `nuwax_env`。**只单独设 `NUWAX_MODEL`** 表示"换用已有
provider 的模型",不会切端点。

### 连接、传输与重试

| 变量 | 说明 | 不设时 |
| --- | --- | --- |
| `NUWAX_BRIDGE` | `rig`(默认)/ `native` / `genai`。`native` 仅支持 Responses,`genai` 仅支持 chat/anthropic | `rig` |
| `NUWAX_REQUEST_MAX_RETRIES` | 可选:HTTP 请求重试次数,`0` = 本层只发一次 | 4 |
| `NUWAX_STREAM_MAX_RETRIES` | 可选:流恢复/采样重试预算,`0` = 禁用本层重试 | 5 |
| `NUWAX_STREAM_IDLE_TIMEOUT_MS` | 可选:流空闲超时(毫秒),不是整轮总时限 | 300000 |
| `NUWAX_MAX_OUTPUT_TOKENS` | 可选:每次生成的输出上限(正整数,不是上下文窗口) | 不设 |

`NUWAX_BRIDGE`、输出上限、重试与空闲超时**须随完整启动组使用**,孤立设置会报错;
重试次数有效值最多 100。

### 模型能力

| 变量 | 说明 |
| --- | --- |
| `NUWAX_MODEL_CONTEXT_WINDOW` | 可选:模型真实上下文窗口(token)。非目录模型建议显式给,压缩阈值由它派生 |
| `NUWAX_MODEL_REASONING_EFFORT` | 推理力度:`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra` 等;不设则不发档位字段、由平台默认执行(ACP 侧另有 `NUWAX_DISABLE_THINKING`,见 §2.3) |
| `NUWAX_REASONING_EFFORT_LEVELS` | 可选:逗号分隔的档位表,声明该网关模型**真实接受**的档位(如 GLM-5.3-Flash 是 `low,high,max`)。档位词只能是 `minimal` / `low` / `medium` / `high` / `xhigh` / `max`(`none`/`off` 不是档位,写进去会报错)。声明后,选了表里没有的档位、或关思考,都会在**请求发出前**报错(指出缺哪个档位),而不是被网关静默映射成别的档位——直连官方端点也可能不校验(实测对 `medium`/`minimal`/`ultra` 一律返回 200),所以 200 不代表档位被采纳。不设则保持宽松、不校验 |

`NUWAX_REASONING_EFFORT_LEVELS` 必须能附着到一个 provider:随网关启动组使用,或配合
`-c model_provider=<id>`。纯 config.toml 选 provider 时**不要用**这个环境变量
(会报错指路),直接把档位写进该 provider 表的 `reasoning_effort_levels` 字段(见 §1.5)。

### 自动压缩

| 变量 | 说明 |
| --- | --- |
| `NUWAX_AUTO_COMPACT_TOKEN_LIMIT` / `NUWAX_AUTO_COMPACT_RATIO` | 可选:自动压缩的 token 阈值 / 窗口比例。显式 `-c` 优先;两者都不设时按窗口 **80%** 触发;显式阈值直接生效不封顶 |

迁移压缩(换小窗口模型时把历史摘要进新窗口)的参数只有 config.toml 顶层键,没有
环境变量,默认无需调整(见 §1.5)。

### 图片预算

| 变量 | 说明 | 不设时 |
| --- | --- | --- |
| `NUWAX_IMAGE_MAX_BYTES` | **单张**图片进入会话历史时的编码体积上限(字节)。超限图片无损优先处理:已达标直通;全不透明走 JPEG 阶梯 85→75→65;真半透明保 PNG 走尺寸阶梯。token 计数不变 | **按线路决定**:只有 Responses 线且模型声明支持 `detail: original` 才不设预算,其余(Chat 桥一律把 original 改写成 high、Anthropic 线没有 detail 字段)默认 **2 MiB**。设 `0` 显式关闭 |
| `NUWAX_REQUEST_IMAGE_MAX_BYTES` | **单次请求**内联图片总量上限(字节)。发请求前执行:超预算就从最大的一张开始对半重压,单张压到 192 KiB 以下不再压;压到下限仍超预算时保留原图并打 `warn`(点名 budget/total),请求照发——网关仍可能 413,但不会再无声无息 | **20 MiB**。设 `0` 关闭该 pass;非法值告警一次并回落默认 |

截图密集的网页开发任务靠这两级把请求体压回网关限制内(常见 32 MiB 门限)。
Chat 协议每轮重发历史,单图预算撞线的概率最高。

### 工具与出站开关

| 变量 | 说明 | 不设时 |
| --- | --- | --- |
| `NUWAX_TOOL_SEARCH` | `false` = MCP 工具在首个请求**全量直出**(不注册 `tool_search`/Deferred),用于不支持该线格式的自托管/第三方网关,或需要确定性工具表的部署。仅接受大小写不敏感的 `true`/`false`,其他值启动即报错;显式配置 `[tools] tool_search` 优先于它 | 官方默认(懒加载) |
| `NUWAX_OPENAI_EGRESS` | `=1` 才打开 OpenAI 第一方出站总闸。fork 面向经自有网关访问厂商模型的部署,默认**关闭**:app-server 远程控制(会向 `chatgpt.com/backend-api/` 开 websocket,并把 `installation_id` 与本机 hostname 写进日志)、插件目录/已安装态同步(`chatgpt.com/backend-api/plugins/*`)与 curated 同步(`github.com/openai/plugins`)都不自行联网。任何其他非空值按"写错"处理:报一次并保持关闭 | 关闭 |

### 目录

| 变量 | 说明 |
| --- | --- |
| `NUWAX_HOME` | 可选:会话与状态目录(默认 `~/.nuwax-harness`)。与旧拼写同时设置且值相同视为迁移期写法,值不同则启动报错 |

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
model_context_window = 1000000  # GLM-5.3-Flash 实测窗口 ~1M(2026-11-02 探针:81.5 万 token 通过、约 98 万被拒)

[model_providers.glm]
name = "GLM Coding Plan (Anthropic)"
base_url = "https://open.bigmodel.cn/api/anthropic"
env_key = "GLM_API_KEY"          # Key 从该环境变量读取,不落盘
wire_api = "anthropic"           # responses | chat | anthropic
# max_output_tokens = 8192       # 可选:输出上限
# reasoning_effort_levels = ["low", "high", "max"]   # 可选:声明 GLM-5.3 系列真实档位
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
  `stream_idle_timeout_ms`、`reasoning_effort_levels`(档位表,声明后选错档位在本地
  即报错,取值同 `NUWAX_REASONING_EFFORT_LEVELS`)、`image_byte_budget_bytes`
  (同 `NUWAX_IMAGE_MAX_BYTES`)、`anthropic_prompt_caching`(Anthropic 线 prompt
  缓存,默认关);MCP 工具全量直出可写 `[tools] tool_search = false`(同
  `NUWAX_TOOL_SEARCH=false`)。
- 迁移压缩调参(0.18.30 起;`config.toml` 顶层键,**没有环境变量**,默认无需调整):
  `migration_compact_ratio`(默认 `0.8`,迁移预算 = 历史+固定前缀可占窗口比例)、
  `migration_compact_retain_ratio`(默认 `0.16`,原样保留的尾部占比)、
  `migration_compact_max_span_ratio`(默认 `0.5`,单次摘要请求占窗口上限)、
  `migration_compact_max_ranges`(默认 `8`,单次迁移最多摘要段数,1–64)。
  越界值启动即报错并点名键。本地小窗口(16K)模型建议 `migration_compact_ratio = 0.7`
  (固定前缀已占 4–5K)。何时触发见 §1.7「切到小窗口模型」行。
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
| 报 NUWAX_* 组不完整 / 孤立设置 | CLI 启动组必须成组:`NUWAX_BASE_URL` + `NUWAX_WIRE_API` + `NUWAX_API_KEY`;`NUWAX_BRIDGE`、重试、输出上限、档位表也须随组(或用 `-c` 指定 provider) |
| 报 "Not inside a trusted directory" | 交互式与 `exec` 需在 Git 仓库内运行;非 Git 目录加 `--skip-git-repo-check`(见 §1.4) |
| 平台报 effort 取值不支持 / 不支持关闭思考 | CLI 侧不设 `NUWAX_MODEL_REASONING_EFFORT` 时不发档位字段(由平台默认执行);设了平台不接受的值就换掉(如 `low`/`high`/`max`)。**更彻底的做法**:设 `NUWAX_REASONING_EFFORT_LEVELS='low,high,max'` 声明该网关模型真实接受的档位,之后选了表里没有的档位(或关思考)会在**请求发出前**就报错,而不是被网关静默映射成别的档位——直连官方端点也可能不校验(实测对 `medium`/`minimal`/`ultra` 一律返回 200),所以 200 不代表档位被采纳。声明后务必同时给一个真实存在的档位。另:"关思考"发的是 `thinking:{type:"disabled"}`,始终思考的模型会拒,这时也给显式档位而不是关 |
| 401 / 鉴权失败 | Key 与基址不属于同一平台或套餐 |
| unknown model / 模型不存在 | `NUWAX_MODEL` 拼写与平台不一致(注意大小写) |
| bridge 相关报错 | `native` 只能配 Responses;`genai` 只能配 chat/anthropic |
| 网关返回 413 / 请求体过大 | 先设 `NUWAX_REQUEST_IMAGE_MAX_BYTES`(整请求图片预算,默认 20 MiB),再考虑 `NUWAX_IMAGE_MAX_BYTES`(单图);输出、文本、工具 schema 与图片都占请求体 |
| 抓包看到 `chatgpt.com` / 日志出现本机 hostname 与 `installation_id` | 这是 OpenAI 第一方出站总闸被打开了。检查是否误设 `NUWAX_OPENAI_EGRESS`(默认关闭,且只有 `1` 是有效值) |
| 模型不认识工具线格式 / MCP 工具在首轮缺失 | 设 `NUWAX_TOOL_SEARCH=false` 让工具表首轮全量直出;非法值会让引擎拒绝启动 |
| 上下文窗口耗尽报错 "ran out of room in the model's context window" | 0.18.25/1.2.25 起该场景会**自动压缩后重试**(事前:轮前判断把本轮待加入输入计入窗口上限,大输入先压缩再发;事后:网关拒绝或本地闸门超限时压缩一次重试一次),正常使用不应再见到该错误。若仍出现:自动压缩被显式禁用,或会话只剩单条超大消息(无可压缩)——开新会话,并把单条输入控制在 1MiB 字符以内 |
| 大窗口会话切到小窗口模型后卡住 / 报超窗 | 0.18.30 起**迁移压缩**自动处理:历史由**目标模型**逐段摘要(隐藏最老连续区间+保留尾部),在单个 turn 内循环直到装进预算(硬上限 32 个 pass);摘要不可收敛时只告警并回退旧路径,不静默丢内容。默认参数无需调整,调参键见 §1.5 |
| 上下文裁剪异常 | 设 `NUWAX_MODEL_CONTEXT_WINDOW` 为模型真实窗口;输出、文本和图片都占窗口 |

---

# 第二部分:通过 nuwax-harness-acp-ts(ACP 协议接入)

适配器把 ACP 协议(stdio)翻译给引擎,供编辑器 / Agent 宿主集成。环境变量配**环境网关**,
无需登录或显式认证。

## 1.8 配置目录与扩展：skills / agents（subagent 自定义提示词）/ 模型覆盖

配置根目录是 **`~/.nuwax-harness`**（`NUWAX_HOME` 可改走他处）。与上游 codex 的
`~/.codex` 完全隔离。目录布局与各类扩展配置的权威说明见引擎仓库
`NUWAX-HARNESS.md §8`，这里给最快上手：

**Skills（技能）** — 放 `~/.nuwax-harness/skills/<技能名>/SKILL.md`，一个目录一个
技能：

```
~/.nuwax-harness/skills/
├── my-skill/
│   └── SKILL.md        # frontmatter（名称/描述）+ 技能指令正文
└── .system/            # 内置技能（自动刷新），不要手改
```

`config.toml` 可按名字/路径逐个启停，并控制技能目录说明的注入与 token 预算：

```toml
[skills]
include_instructions = true
max_context_tokens = 10000
[[skills.config]]
name = "my-skill"
enabled = true
```

**Agents / subagent 自定义提示词** — 支持，两级：

```toml
# ~/.nuwax-harness/config.toml
[agents]
enabled = true
default_subagent_model = "GLM-5.3-Flash"      # spawn 兜底模型
default_subagent_reasoning_effort = "high"

[agents.reviewer]
description = "代码评审子代理"
nickname_candidates = ["评审", "reviewer"]
config_file = "/absolute/path/reviewer.agent.toml"
```

角色文件 `reviewer.agent.toml` 里 `developer_instructions` **必填且非空**（缺失或
空白会 fail-fast 点名文件）——这就是该角色 subagent 的自定义提示词；角色文件本身
是完整 config 层，可以再覆盖该角色的模型、沙箱等任意字段：

```toml
name = "reviewer"
developer_instructions = """
你是代码评审专家。只审查变更，不重写实现；
输出按严重度排序的问题列表，每条带文件与行号。
"""
```

没有角色专属提示词的 subagent，可用 `[features.multi_agent_v2]` 的
`subagent_developer_instructions` 提供全局兜底；顶层 `developer_instructions`
只作用于主线程。

**项目级配置** — 项目目录下放 **`.codex/`**（沿用上游约定，不是 `.nuwax-harness`）：
`${PWD}/config.toml`、逐级父目录的 `.codex/config.toml`、git 仓库根的
`.codex/config.toml` 三层都可覆盖任意字段（`[agents]` 角色、`[skills]`、provider
等）。目录被显式标记 untrusted 时这些层加载但禁用。项目指令用
`AGENTS.override.md` / `AGENTS.md`（沿目录树向上查找）。项目内技能经插件
manifest 的 `./skills` 提供或在项目层 `[[skills.config]]` 用 `path` 选择器指向。
**自定义模型** — `~/.nuwax-harness/models.d/*.toml` 逐字段覆盖目录外模型的
窗口/档位/能力声明。

ACP 侧注意：适配器与引擎读取同一份 `~/.nuwax-harness/config.toml`（§2.2 的
"只用全局配置文件"用法同样适用于 skills/agents），宿主 `env` 无需为它们添加任何
变量。

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
> `none` / `minimal` / `low` / `high` / `max` 等。
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
| `NUWAX_API_KEY` | 该端点的 Key。建议只设这一个,避免与其他 Key 串用 | 无 |
| `NUWAX_API_PROTOCOL` | 协议族:`openai` 或 `anthropic` | `openai` |
| `NUWAX_WIRE_API` | OpenAI 族内的 wire:`responses` 或 `chat`。**Anthropic 协议时不要设置**(由 `NUWAX_API_PROTOCOL=anthropic` 选择) | `responses` |
| `NUWAX_BRIDGE` | 传输桥:`rig`、`native`、`genai`。`native` 仅支持 OpenAI Responses;`genai` 仅支持 chat/anthropic;单独设置而不设 base URL 会报错 | `rig` |
| `NUWAX_MODEL` | 平台的实际模型 ID。网关激活时会覆盖默认模型 | 无 |
| `NUWAX_MODEL_CONTEXT_WINDOW` | 模型真实上下文窗口(token 数,正整数)。强烈建议按平台规格填写,本地预算与压缩依赖它 | 无 |
| `NUWAX_MAX_OUTPUT_TOKENS` | 每次生成的输出上限(正整数,不是上下文窗口)。CLI 与 ACP 两侧同名同义,一处配置两侧通用;非法值会在适配器启动时报错 | 不设 |
| `NUWAX_PROVIDER_ID` | 网关的 provider ID(可选) | `custom-gateway` |
| `NUWAX_PROVIDER_NAME` | 网关展示名(可选),缺省回退 `NUWAX_MODEL`,再回退 `Custom Gateway` | — |
| `NUWAX_DISABLE_THINKING` | 设为 `true`/`1`/`yes`/`on` 时把推理力度固定为 `none`,即**关闭思考**(用于不支持推理的模型);这是 ACP 侧关闭思考的开关,CLI 侧用 `NUWAX_MODEL_REASONING_EFFORT=none` | 不启用 |
| `NUWAX_MODEL_REASONING_EFFORT` | 推理力度。宿主界面没提供 effort 选择器时,适配器用它作为兜底,不再无条件钉 `medium` | 不设 |
| `NUWAX_REASONING_EFFORT_LEVELS` | 逗号分隔的档位表,声明该网关模型真实接受的档位(如 `low,high,max`);取值、校验时机与"200 不等于被采纳"的说明见第一部分 §1.3。适配器在需要兜底时取**你列出的第一个档位**;更重要的是它透传给引擎,之后选了表里没有的档位、或关思考,会在**请求发出前**报错 | 不设(宽松) |

> 请求/流重试与流空闲超时(`NUWAX_REQUEST_MAX_RETRIES` / `NUWAX_STREAM_MAX_RETRIES` /
> `NUWAX_STREAM_IDLE_TIMEOUT_MS`)属于 **CLI 启动组**,适配器不读它们,ACP 侧固定用
> 引擎默认值(4 / 5 / 300000 毫秒)。

## 2.4 通用与运维变量

| 变量 | 说明 |
| --- | --- |
| `NUWAX_PATH` | 指定其他 harness 可执行文件的绝对路径;默认用包内依赖。不能带子命令 |
| `NUWAX_CONFIG` | JSON 对象,合并进会话配置(高级用法) |
| `MODEL_PROVIDER` | 无活动网关时的 provider 选择;**不要**与环境网关同时表达矛盾选择 |
| `INITIAL_AGENT_MODE` | 初始模式:`read-only` / `workspace-write` / `agent` / `agent-full-access` |
| `NO_BROWSER` | 设置后隐藏浏览器登录入口 |
| `APP_SERVER_LOGS` / `NUWAX_LOG_DIR` | 适配器日志目录(两者同义,`APP_SERVER_LOGS` 优先)。日志不包含 Key 与原始协议内容,可安全粘贴提问 |
| `NUWAX_ACP_APP_SERVER_CRASH_LIMIT` | 可选运维参数:引擎 app-server 在崩溃窗口内自动重启的次数上限(默认 `5`),超过后停止自动重启 |
| `NUWAX_ACP_APP_SERVER_CRASH_WINDOW_MS` | 可选运维参数:上述崩溃计数的时间窗口,毫秒(默认 `300000`,即 5 分钟) |

## 2.5 引擎侧开关(环境变量同样生效)

适配器把环境原样传给 app-server 子进程,因此**第一部分 §1.3 里"模型能力 / 自动压缩 /
图片预算 / 工具与出站"这几组变量在这里同样有效**。适配器自己消费的
`NUWAX_BASE_URL`、`NUWAX_WIRE_API`、`NUWAX_API_PROTOCOL`、`NUWAX_API_KEY`、
`NUWAX_BRIDGE`、`NUWAX_MAX_OUTPUT_TOKENS` 会从子进程环境剥离,因此不会触发引擎
"启动组不完整/孤立设置"的报错(`NUWAX_MODEL` 例外地留在子进程环境里,单独设置它
本来就合法:只换模型不换端点)。

对 ACP 宿主最常需要显式设的三个:

| 变量 | 什么时候要设 |
| --- | --- |
| `NUWAX_TOOL_SEARCH` | 自托管/第三方网关不认识 `tool_search` 线格式,或需要确定性工具表:设 `false` |
| `NUWAX_REQUEST_IMAGE_MAX_BYTES` | 宿主常把整屏截图塞进上下文,网关 32 MiB 限制被撞:默认 20 MiB,可下调 |
| `NUWAX_OPENAI_EGRESS` | 默认关闭;确需 OpenAI 第一方插件/远程控制出站时才设 `1` |

## 2.6 平台配置示例

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
export NUWAX_MODEL_CONTEXT_WINDOW='1000000'    # GLM-5.3-Flash 实测 ~1M(非 128k)
# 推荐声明真实档位并显式选一个(GLM-5.3/5.3-Flash/5.3-FlashX 只有 low/high/max,
# 都不设时适配器兜底 medium,会被网关静默降档):
# export NUWAX_REASONING_EFFORT_LEVELS='low,high,max'
# export NUWAX_MODEL_REASONING_EFFORT='high'
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

## 2.7 在 ACP 宿主里接入

ACP 是 stdio 协议:由宿主负责启动适配器进程。**环境变量必须配进宿主的 agent 环境**,
只在终端 `export` 对已运行的宿主无效(§2.2 的最小配置即宿主 `env` 块的完整内容)。

切换平台 = 换一组 `NUWAX_BASE_URL` / `NUWAX_API_PROTOCOL` / `NUWAX_WIRE_API` /
`NUWAX_API_KEY` / `NUWAX_MODEL`,重启适配器即可。

## 2.8 排查

| 现象 | 原因与处理 |
| --- | --- |
| `session/new` 返回 Authentication required | base URL 变量没有进入适配器进程的环境;检查宿主的 env 配置 |
| 提示 binary is not installed | 运行一次 `nuwax-harness --version` 触发下载,或设 `NUWAX_PATH` 指向已有二进制 |
| 平台报 effort 取值不支持 / 不支持关闭思考 | 宿主界面可能不提供 effort 选择器,这时适配器的兜底顺序是:`NUWAX_MODEL_REASONING_EFFORT` > `NUWAX_REASONING_EFFORT_LEVELS` 的第一个档位 > `medium`。**推荐设 `NUWAX_REASONING_EFFORT_LEVELS`**(如 `'low,high,max'`)声明该网关模型真实接受的档位:它既让兜底落在真实档位上,又透传给引擎——之后选了表里没有的档位、或关思考,会在**请求发出前**报错(指出缺哪个档位),不再被网关静默映射(直连官方端点也可能不校验,实测对 `medium`/`minimal`/`ultra` 一律 200,所以 200 不代表档位被采纳)。若显式给了 `NUWAX_MODEL_REASONING_EFFORT` 而它不在档位表里,适配器**不代为替换**,按你给的值发出去,由引擎拒绝并说明——静默改写比报错更糟。"关思考"走 `NUWAX_DISABLE_THINKING`(发 `thinking:{type:"disabled"}`),始终思考的平台会拒,这时也改给显式档位 |
| 401 / 鉴权失败 | Key 与基址不属于同一平台或套餐;只设一把 Key,避免串用 |
| unknown model / 模型不存在 | 模型变量拼写与平台不一致(注意大小写) |
| 网关返回 413 / 宿主对话越聊越慢 | 图片占请求体:设 `NUWAX_REQUEST_IMAGE_MAX_BYTES`(默认 20 MiB)、必要时 `NUWAX_IMAGE_MAX_BYTES`;长会话另见下面两行 |
| 模型不认识 `tool_search` 线格式 / MCP 工具行为异常 | 设 `NUWAX_TOOL_SEARCH=false` 让 MCP 工具全量直出;非法值会让引擎拒绝启动 |
| 上下文窗口耗尽报错 "ran out of room in the model's context window" | 1.2.25 起(内置引擎 0.18.25)该场景会**自动压缩后重试**,正常使用不应再见到该错误;若仍出现,见第一部分 §1.7 同名行 |
| 大窗口会话切到小窗口模型后卡住 / 报超窗 | 内置引擎 0.18.30 起由**迁移压缩**自动处理(宿主侧无需任何配置);若仍出现,见第一部分 §1.7 同名行 |
| 上下文裁剪异常 | 上下文窗口变量未设或与实际不符;输出、文本和图片都占窗口 |
| bridge 相关报错 | `native` 只能配 Responses;`genai` 只能配 chat/anthropic;单独设 bridge 不设 base URL 会报错 |
| 宿主发送了 `providers/set` 或显式 `authenticate` | 会按优先级**替换**环境网关及其凭据;想继续用部署环境,不要让宿主主动改登录方式 |
| 日志排查 | 设 `APP_SERVER_LOGS=<目录>`(或 `NUWAX_LOG_DIR=<目录>`)后重试,日志里只有字节数不含凭据,可安全粘贴提问 |

---

# 附录

## A. CLI ↔ ACP 变量换算

| 语义 | CLI(第一部分) | ACP(第二部分) |
| --- | --- | --- |
| 协议 + wire | 单变量 `NUWAX_WIRE_API`(`chat` / `responses` / `anthropic`) | 拆成两变量:`NUWAX_API_PROTOCOL`(`openai`/`anthropic`)+ `NUWAX_WIRE_API`(`chat`/`responses`,anthropic 时不设) |
| 基址 / Key / 模型 / 桥 | `NUWAX_BASE_URL` / `NUWAX_API_KEY` / `NUWAX_MODEL` / `NUWAX_BRIDGE` | 同名同义 |
| 输出上限 | `NUWAX_MAX_OUTPUT_TOKENS` | 同名同义,一处配置两侧通用 |
| 重试与流空闲超时 | `NUWAX_REQUEST_MAX_RETRIES` / `NUWAX_STREAM_MAX_RETRIES` / `NUWAX_STREAM_IDLE_TIMEOUT_MS` | **CLI 启动组专用**;适配器不读,ACP 侧用引擎默认值 |
| 推理力度 / 关思考 | `NUWAX_MODEL_REASONING_EFFORT`(取 `none` 即关思考) | 档位同上;关思考另有开关 `NUWAX_DISABLE_THINKING=true` |
| 档位表 | `NUWAX_REASONING_EFFORT_LEVELS` | 同名同义,透传给引擎执行;适配器另外用它作为兜底档位 |
| 上下文窗口 / 自动压缩 | `NUWAX_MODEL_CONTEXT_WINDOW` / `NUWAX_AUTO_COMPACT_TOKEN_LIMIT` / `NUWAX_AUTO_COMPACT_RATIO` | 同名同义(引擎侧生效) |
| 图片预算 | `NUWAX_IMAGE_MAX_BYTES` / `NUWAX_REQUEST_IMAGE_MAX_BYTES` | 同名同义(引擎侧生效) |
| 工具表 / 出站 | `NUWAX_TOOL_SEARCH` / `NUWAX_OPENAI_EGRESS` | 同名同义(引擎侧生效) |
| 状态目录 | `NUWAX_HOME` | 同名同义 |

## B. 优先级与兼容说明

- 同一进程内只选一套入口配置:显式 CLI 模型/provider 选择 > 显式 `-c` 配置键 >
  环境种子(`NUWAX_*`)> 配置文件。显式 `authenticate` 或 `providers/set` 会替换
  环境网关、桥选择与凭据。
- 适配器消费掉的启动变量会从引擎子进程环境剥离,不会触发引擎 `NUWAX_*` 启动组的
  孤儿检测。
- 旧拼写永久兼容:只设其一即生效,同值幂等,异值启动报错并点名两个变量。
- 旧 npm 包名(已停止更新,停在 1.2.19)与旧命令名的兼容别名仍受支持,后续版本移除。

## C. 变量总索引

| 变量 | 生效层 | 一句话 | 默认 |
| --- | --- | --- | --- |
| `NUWAX_BASE_URL` | 两侧(网关) | 平台协议基址 | 必填 |
| `NUWAX_WIRE_API` | 两侧(网关) | `chat`/`responses`/`anthropic`(ACP 拆协议族另设) | 必填 / ACP `responses` |
| `NUWAX_API_KEY` | 两侧(网关) | 端点 Key | 必填 |
| `NUWAX_MODEL` | 两侧(网关) | 平台模型 ID | 必填 |
| `NUWAX_BRIDGE` | 两侧(网关) | `rig`/`native`/`genai` | `rig` |
| `NUWAX_API_PROTOCOL` | ACP | `openai`/`anthropic` | `openai` |
| `NUWAX_PROVIDER_ID` / `NUWAX_PROVIDER_NAME` | ACP | 网关 provider 的 ID / 展示名 | `custom-gateway` / 回退模型名 |
| `NUWAX_MAX_OUTPUT_TOKENS` | 两侧 | 单次输出上限 | 不设 |
| `NUWAX_REQUEST_MAX_RETRIES` / `NUWAX_STREAM_MAX_RETRIES` | CLI 启动组 | 请求 / 流重试 | 4 / 5 |
| `NUWAX_STREAM_IDLE_TIMEOUT_MS` | CLI 启动组 | 流空闲超时(毫秒) | 300000 |
| `NUWAX_MODEL_CONTEXT_WINDOW` | 两侧 | 模型真实上下文窗口 | 按模型目录 |
| `NUWAX_MODEL_REASONING_EFFORT` | 两侧 | 推理力度 | 不发票位 |
| `NUWAX_REASONING_EFFORT_LEVELS` | 两侧 | 网关真实档位表(选了非法档位请求前报错) | 宽松 |
| `NUWAX_DISABLE_THINKING` | ACP | 关闭思考 | 不启用 |
| `NUWAX_AUTO_COMPACT_TOKEN_LIMIT` / `NUWAX_AUTO_COMPACT_RATIO` | 引擎 | 自动压缩阈值 / 窗口比例 | 80% 窗口 |
| `NUWAX_IMAGE_MAX_BYTES` | 引擎 | 单图编码预算 | 按线路(2 MiB 或不限) |
| `NUWAX_REQUEST_IMAGE_MAX_BYTES` | 引擎 | 整请求内联图片预算 | 20 MiB |
| `NUWAX_TOOL_SEARCH` | 引擎 | `false` = 工具首轮全量直出 | 官方默认 |
| `NUWAX_OPENAI_EGRESS` | 引擎 | `=1` 才允许 OpenAI 第一方出站 | 关闭 |
| `NUWAX_HOME` | 引擎 | 会话与状态目录 | `~/.nuwax-harness` |
| `NUWAX_PATH` | ACP | 指定 harness 可执行文件 | 包内依赖 |
| `NUWAX_CONFIG` | ACP | 额外会话配置(JSON) | 无 |
| `NUWAX_LOG_DIR` | ACP | 适配器日志目录 | 关闭 |
| `NUWAX_ACP_APP_SERVER_CRASH_LIMIT` / `NUWAX_ACP_APP_SERVER_CRASH_WINDOW_MS` | ACP | 引擎 app-server 崩溃重启上限 / 窗口 | 5 / 300000 |
| `MODEL_PROVIDER` / `INITIAL_AGENT_MODE` / `NO_BROWSER` / `APP_SERVER_LOGS` | ACP | 无网关时的 provider、初始模式、隐藏登录、日志目录 | — |
