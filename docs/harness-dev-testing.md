# 联调指南:适配器 × fork-nuwax-codex 源码

本文面向开发联调:如何把 [fork-codex-acp-ts](..)(ACP 适配器)和
[fork-nuwax-codex](https://github.com/nuwax-ai/codex)(harness,即 Codex 引擎的 fork,
本地路径如 `/Volumes/zhitai/git_workspace/fork-nuwax-codex`)接在一起,
并用自定义模型平台做端到端验证。日常使用(非开发)只需看
[custom-model-gateway.md](custom-model-gateway.md)。

两个项目的分工:

```
fork-codex-acp-ts            fork-nuwax-codex
─────────────────            ─────────────────
ACP 适配器(TypeScript)      harness 引擎(Rust)
说 ACP 协议,管会话/权限/     说 JSON-RPC app-server 协议,
工具调用渲染,通过 CODEX_*    真正调模型,源码在 codex-rs/,
环境网关拿路由和凭据          产物是单个原生二进制
        └──── CODEX_PATH 指向哪个二进制,适配器就带动哪个引擎 ────┘
```

适配器通过两种方式拿到引擎二进制,优先级 `CODEX_PATH` > 包内依赖:

- 不设 `CODEX_PATH`:用 npm 依赖 `@nuwax-ai/nuwax-harness`(发布版,装包时自动下载到 `~/.nuwax-harness-cache/`);
- 设 `CODEX_PATH=<绝对路径>`:直接用你指定的二进制——联调 fork-nuwax-codex 源码构建产物就走这条路。

## 1. 构建 fork-nuwax-codex

```bash
cd /path/to/fork-nuwax-codex

# debug 构建(日常联调用,增量编译快)。注意 `just codex` 是 cargo run,
# 会直接启动 CLI 而不是停在构建;纯构建用 cargo:
cd codex-rs && cargo build -p codex-cli
# 产物:codex-rs/target/debug/codex

# release 构建(发布物,走 bazel,较慢)
just build-for-release
```

注意:

- 产物主程序是 `codex-rs/target/debug/codex`(release 改名为 `nuwax-harness`)。
  本地 debug 构建未打版本戳,`--version` 显示 `0.0.0`,属正常。
- `CODEX_PATH` 必须指向**主程序**,不要指向 `codex-exec`、`codex-app-server`,
  也不要把 `app-server` 子命令写进路径——适配器自己会附加 `app-server`。
- 引擎协议变了(改了 app-server 相关 Rust 代码)后,适配器侧要重新生成类型,
  见第 5 节。

## 2. 直接用 harness CLI 验证引擎(第一层)

`NUWAX_*` 是 harness **CLI 自己的启动组**,不经过适配器,适合先把引擎本身调通:

| 变量 | 说明 |
| --- | --- |
| `NUWAX_BASE_URL` | 平台协议基址(必填) |
| `NUWAX_WIRE_API` | `chat` / `responses` / `anthropic`,必须显式设置 |
| `NUWAX_API_KEY` | 该端点的 Key,与上两项成组设置 |
| `NUWAX_MODEL` | 平台模型 ID(完整启动组需要它) |
| `NUWAX_BRIDGE` | 可选 `rig`(默认,可不设)/ `native` / `genai` |
| `NUWAX_MAX_OUTPUT_TOKENS` | 可选:每次生成的输出上限(正整数,不是上下文窗口) |
| `NUWAX_REQUEST_MAX_RETRIES` / `NUWAX_STREAM_MAX_RETRIES` / `NUWAX_STREAM_IDLE_TIMEOUT_MS` | 可选:请求/流重试与流空闲超时;必须随完整启动组使用,孤立设置报错 |

```bash
cd /path/to/fork-nuwax-codex
export NUWAX_BASE_URL='https://your-provider.example/v1'
export NUWAX_WIRE_API='chat'
export NUWAX_MODEL='your-model-id'
# NUWAX_BRIDGE 默认 rig,不设即可
export NUWAX_API_KEY='<YOUR_API_KEY>'

# 路由自检:确认 provider / wire / bridge 符合预期
codex-rs/target/debug/codex doctor --json

# 单次执行,真实调一次模型
codex-rs/target/debug/codex exec '请只回复:OK'
```

`doctor` 报 `bridge: rig (model bridge)` 即经 rig 桥;`native transport` 即原生
Responses。走**原生 Responses(GPT 官方 / 中转站)**的控制就是
`NUWAX_WIRE_API=responses` + `NUWAX_BRIDGE=native` 的组合——引擎源码里写明这是
从进程环境到达原生 Responses 传输的唯一入口,没有另一个独立变量;ACP 侧对应
`CODEX_BRIDGE=native`。这一层通过,说明引擎、协议、Key 都没问题,再往上层查。

## 3. 适配器侧配置(第二层)

适配器用的是 **`CODEX_*` 环境网关**(不是 `NUWAX_*`,两套变量互不通用;
`NUWAX_BRIDGE` 不是 `CODEX_BRIDGE` 的别名)。变量全表见
[custom-model-gateway.md](custom-model-gateway.md),最小集合:

| 变量 | 说明 |
| --- | --- |
| `CODEX_PATH` | **联调关键**:指向 fork-nuwax-codex 构建出的主程序绝对路径 |
| `CODEX_BASE_URL` | 平台协议基址(设置即启用环境网关) |
| `CODEX_API_PROTOCOL` | `openai`(默认)或 `anthropic` |
| `CODEX_WIRE_API` | openai 族内 `responses` / `chat`;anthropic 时不设 |
| `CODEX_BRIDGE` | `rig` / `native` / `genai`,默认 rig |
| `CODEX_MODEL` | 平台模型 ID |
| `CODEX_MODEL_CONTEXT_WINDOW` | 模型真实上下文窗口(token) |
| `CODEX_API_KEY` | 平台 Key(回退 `OPENAI_API_KEY`) |
| `INITIAL_AGENT_MODE` | `read-only` / `workspace-write` / `agent` / `agent-full-access` |

## 4. 端到端冒烟:适配器 + 源码二进制(第三层)

在 fork-codex-acp-ts 目录,让适配器带着 `CODEX_PATH` 启动,直接对平台发一条消息:

```bash
cd /path/to/fork-codex-acp-ts

CODEX_PATH=/absolute/path/to/fork-nuwax-codex/codex-rs/target/debug/codex \
CODEX_BASE_URL='https://your-provider.example/v1' \
CODEX_API_PROTOCOL=openai CODEX_WIRE_API=chat CODEX_BRIDGE=rig \
CODEX_MODEL='your-model-id' CODEX_MODEL_CONTEXT_WINDOW=128000 \
CODEX_API_KEY='<YOUR_API_KEY>' \
npm --silent start
# --silent 不能省:npm 默认会把 "> package@version start" 头行打进 stdout,
# 污染 ACP 的 JSON-RPC 流
```

启动后适配器在 stdio 上等 ACP 协议输入,手工敲 JSON 不方便,建议用脚本或宿主驱动:
`initialize` → `session/new` → `session/prompt` 三步,收到
`agent_message_chunk` 文本即全链路通。也可直接上真实宿主(Zed / JetBrains /
自研客户端),把上述环境变量配进宿主的 agent env——注意环境变量必须进**适配器进程**,
宿主单独拉起进程时终端的 export 无效。

三层验证依次做,哪层出问题查哪层:

| 层 | 命令 | 通过标准 |
| --- | --- | --- |
| 引擎 | `doctor --json` + `exec '请只回复:OK'` | doctor ok;exec 返回 OK |
| 适配器 | 第 4 节冒烟 | prompt 收到模型回复 |
| 宿主 | 真实客户端新建会话对话 | 会话可用、工具调用正常 |

## 5. 引擎协议变更后:重新生成适配器类型

改了 fork-nuwax-codex 的 app-server 协议(Rust 侧)后,适配器的
`src/app-server/` 类型必须重新生成,否则编译期发现不了不兼容:

```bash
# 1) 用源码引擎生成类型。注意 npm run generate-types 走的是 npm 依赖里的
#    发布版 harness,不读 CODEX_PATH;要按源码产物生成,直接调它的子命令:
cd /path/to/fork-codex-acp-ts
/path/to/fork-nuwax-codex/codex-rs/target/debug/codex \
  app-server generate-ts --out src/app-server

# 2) 编译器会指出所有不兼容点,按 codex-update-compat skill 逐个修
npm run typecheck
npm test
```

历史上这类升级的典型破坏(`Turn` 必填字段、item 联合类型分叉、通知新增)与修法,
见 fork-codex-acp-ts 的 `v1.2.19` 发布提交,以及
`.claude/skills/codex-update-compat/`。

## 6. 排查

| 现象 | 原因与处理 |
| --- | --- |
| `session/new` 返回 Authentication required | `CODEX_BASE_URL` 没进适配器进程环境 |
| 适配器起不来,报 binary is not installed | 未设 `CODEX_PATH` 且缓存冷;跑一次 `nuwax-harness --version`,或设 `CODEX_PATH` |
| `CODEX_PATH` 指向的二进制行为像旧版 | debug 产物过期,回 fork-nuwax-codex 重新 `cargo build -p codex-cli` |
| 协议不匹配 / 未字段报错 | 引擎改了协议没重新生成类型,见第 5 节 |
| `CODEX_BRIDGE`/`CODEX_WIRE_API` 报错 | 组合不合法:`native` 只配 Responses,`genai` 只配 chat/anthropic;anthropic 不设 wire |
| 型号 404 / unknown model | 模型 ID 与平台不符(注意大小写);确认基址与协议同族 |
| 日志 | 设 `APP_SERVER_LOGS=<目录>`,日志只记字节数不含凭据,可安全粘贴 |

## 7. 输出上限(`NUWAX_MAX_OUTPUT_TOKENS`)

输出上限的底层键是 **provider 级**的 `model_providers.<id>.max_output_tokens`
(chat 桥把它映射为 wire 的 `max_tokens`)。两个入口共用同一个变量名:

- **CLI(`NUWAX_*`)**:`NUWAX_MAX_OUTPUT_TOKENS`,随完整启动组使用(引擎自身的约束)。
- **ACP(`CODEX_*` 环境网关)**:同一个 `NUWAX_MAX_OUTPUT_TOKENS`。适配器读取后写进
  网关 provider 条目,并把它**从传给 app-server 的环境里剥掉**——引擎自己的
  `NUWAX_*` 解析器会把孤儿变量当作不完整启动组直接拒绝启动,不剥掉引擎起不来。

注意:`CODEX_CONFIG` 里塞 `model_providers.<id>.max_output_tokens` 没有用——
环境网关会整体替换自己的 provider 条目,别用这条路白排查。非法值(非正整数)
在适配器启动时即报错退出。
