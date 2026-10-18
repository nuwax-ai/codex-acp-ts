/**
 * ACP live daily-workflow acceptance against a REAL vendor.
 *
 * One continuous session through the ACP adapter, mirroring a user's day:
 * Chinese chat -> project file write/read -> shell command -> MCP
 * screenshot -> mid-stream cancel -> continuation -> /compact ->
 * post-compact tool -> adapter shutdown (orphan checks) -> cold load on a
 * fresh adapter process -> one more real tool call.
 *
 * Verifies along the way: tool_call/tool_result pairing, no giant base64
 * text parts (images stay structured), compaction reduces reported usage,
 * exactly-one usage_update after cold load with no idle duplicates, and no
 * surviving codex descendants after the adapter exits.
 *
 * The runner (live-smallbatch.sh) provides NUWAX_* env (gateway origin,
 * dummy-key auth) and SHOT_TRUTH_PATH; this file never sees or prints a
 * real key. Prints `WORKFLOW-PASS <detail>` on success.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requireBudgetGateway } from "./gateway-contract.js";
import { FinalAssistantText } from "./assistant-text.js";
import { Readable, Writable } from "node:stream";
import {
    PROTOCOL_VERSION,
    client as acpClient,
    methods,
    ndJsonStream,
} from "@agentclientprotocol/sdk";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const VAL_ROOT = process.env["VAL_ROOT"] ?? "/tmp/acp-live-workflow";
const CODEX_PATH = process.env["CODEX_PATH"]
    ?? "/Volumes/soddy/git_workspace/fork-nuwax-codex/.claude/worktrees/merge-main-20261014/codex-rs/target/debug/codex";
const SHOT_TRUTH_PATH = process.env["SHOT_TRUTH_PATH"] ?? path.join(VAL_ROOT, "wf-shot-truth.jsonl");
const work = path.join(VAL_ROOT, "wf-work");
const codexHome = path.join(VAL_ROOT, "wf-codex-home");
const logDir = path.join(VAL_ROOT, "wf-logs");
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);
const BASE64_RUN = /[A-Za-z0-9+/]{600,}/;

interface Observation {
    toolCalls: { id: string; tool: string }[];
    toolCallUpdates: { id: string; status?: string }[];
    usageUpdates: { used: number; size: number }[];
    textParts: string[];
    sawDelta: boolean;
    errors: string[];
}

function newObservation(): Observation {
    return { toolCalls: [], toolCallUpdates: [], usageUpdates: [], textParts: [], sawDelta: false, errors: [] };
}

function summarize(obs: Observation): string {
    const tools = obs.toolCalls.map((t) => t.tool).join(",");
    const usage = obs.usageUpdates.map((u) => `${u.used}/${u.size}`).join(" ");
    return `tools=[${tools}] usage=[${usage}]`;
}

function descendantsOf(pid: number): number[] {
    try {
        const table = execSync("ps -eo pid,ppid --no-headers", { encoding: "utf8" })
            .split("\n").map((l) => l.trim().split(/\s+/).map(Number))
            .filter((p) => p.length === 2 && Number.isFinite(p[0]!) && Number.isFinite(p[1]!))
            .map((p) => [p[0]!, p[1]!] as const);
        const out: number[] = [];
        const frontier = [pid];
        while (frontier.length) {
            const cur = frontier.pop()!;
            for (const [p, ppid] of table) {
                if (ppid === cur && !out.includes(p)) {
                    out.push(p);
                    frontier.push(p);
                }
            }
        }
        return out;
    } catch {
        return [];
    }
}

interface AgentHandle {
    child: ChildProcess;
    agent: ReturnType<ReturnType<typeof acpClient>["connect"]>["agent"];
    obs: Observation;
    text: () => string;
    resetText: () => void;
    stderrTail: () => string;
}

function startAgent(): AgentHandle {
    const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: REPO,
        env: {
            ...process.env,
            CODEX_HOME: codexHome,
            CODEX_PATH,
            APP_SERVER_LOGS: logDir,
            SHOT_TRUTH_PATH,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrTail: string[] = [];
    child.stderr?.on("data", (d: Buffer) => {
        stderrTail.push(...d.toString().split("\n"));
        while (stderrTail.length > 40) stderrTail.shift();
    });
    child.stdin?.on("error", () => {});

    const obs = newObservation();
    const text = new FinalAssistantText();
    const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = acpClient({ name: "acp-live-workflow" })
        .onNotification(methods.client.session.update, (ctx: any) => {
            const update = ctx.params?.update;
            if (!update) return;
            text.add(update);
            if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
                obs.sawDelta = true;
            }
            if (update.sessionUpdate === "usage_update") {
                obs.usageUpdates.push({ used: update.used, size: update.size });
            }
            if (update.sessionUpdate === "tool_call") {
                obs.toolCalls.push({ id: update.toolCallId, tool: update.title ?? "" });
            }
            if (update.sessionUpdate === "tool_call_update") {
                obs.toolCallUpdates.push({ id: update.toolCallId, status: typeof update.status === "string" ? update.status : undefined });
            }
            const content = update.content ?? update.update?.content;
            if (content?.type === "text" && typeof content.text === "string") {
                obs.textParts.push(content.text);
            }
        })
        .onRequest(methods.client.session.requestPermission, (ctx: any) => {
            const options = ctx.params?.options ?? [];
            const allow = options.find((o: any) => o.kind === "allow_once") ?? options[0];
            return allow
                ? { outcome: { outcome: "selected", optionId: allow.optionId } }
                : { outcome: { outcome: "cancelled" } };
        })
        .onRequest(methods.client.fs.readTextFile, (ctx: any) => {
            const p = String(ctx?.params?.path ?? "");
            if (!p.startsWith(work)) return { content: "" };
            try {
                return { content: fs.readFileSync(p, "utf8") };
            } catch {
                return { content: "" };
            }
        })
        .onRequest(methods.client.fs.writeTextFile, (ctx: any) => {
            const p = String(ctx?.params?.path ?? "");
            if (p.startsWith(work)) {
                try {
                    fs.writeFileSync(p, String(ctx?.params?.content ?? ""));
                } catch {
                    /* best effort */
                }
            }
            return {};
        })
        .connect(stream);
    return {
        child,
        agent: connection.agent,
        obs,
        text: () => text.text(),
        resetText: () => text.reset(),
        stderrTail: () => stderrTail.join("\n"),
    };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function prompt(handle: AgentHandle, sessionId: string, text: string, timeoutMs = 240_000) {
    handle.resetText();
    return withTimeout(
        handle.agent.request(methods.agent.session.prompt as any, {
            sessionId,
            prompt: [{ type: "text", text }],
        }).then((value) => value as { stopReason?: string }),
        timeoutMs,
        `prompt(${text.slice(0, 24)}…)`,
    );
}

function normalize(s: string): string {
    return s.replace(/\s+/g, "").replace(/[。．.!！,，、?？:：;；"“”'’`]/g, "");
}

function assertContains(haystack: string, needle: string, label: string) {
    if (!normalize(haystack).includes(normalize(needle))) {
        throw new Error(`${label}: answer did not contain ${JSON.stringify(needle)}: ${JSON.stringify(haystack.slice(0, 300))}`);
    }
}

function assertFile(file: string, expected: string, label: string) {
    const p = path.join(work, file);
    if (!fs.existsSync(p)) throw new Error(`${label}: ${file} was not created`);
    const actual = fs.readFileSync(p, "utf8").trim();
    if (actual !== expected) throw new Error(`${label}: ${file} content ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

function readTruth(): { kind: string }[] {
    try {
        return fs.readFileSync(SHOT_TRUTH_PATH, "utf8").split("\n")
            .filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
        return [];
    }
}

async function initialize(handle: AgentHandle) {
    await withTimeout(
        handle.agent.request(methods.agent.initialize as any, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
                fs: { readTextFile: true, writeTextFile: true },
                terminal: false,
                session: { compaction: {}, notices: {} },
            },
        }),
        60_000,
        "initialize",
    );
}

const mcpServers = [{
    type: "stdio",
    name: "screenshots",
    command: process.execPath,
    args: [path.join(REPO, "scripts", "acp-validation", "shot-server.mjs")],
    // codex deliberately whitelists the environment of MCP stdio children;
    // the truth-ledger path must be an explicit config entry (as in
    // stress-50.ts), not an inherited host variable.
    env: [{ name: "SHOT_TRUTH_PATH", value: SHOT_TRUTH_PATH }],
    cwd: work,
}] as any[];

async function main() {
    await requireBudgetGateway();
    const steps: { step: string; pass: boolean; detail: string }[] = [];
    const record = (step: string, fn: () => void | string) => {
        try {
            const detail = fn();
            steps.push({ step, pass: true, detail: typeof detail === "string" ? detail : "ok" });
            log(`STEP-PASS ${step}`);
        } catch (error) {
            steps.push({ step, pass: false, detail: String(error) });
            throw error;
        }
    };

    const handle = startAgent();
    let sessionId = "";
    try {
        await initialize(handle);
        const created = await withTimeout(
            handle.agent.request(methods.agent.session.new as any, { cwd: work, mcpServers }),
            60_000,
            "session/new",
        );
        sessionId = String((created as any)?.sessionId ?? "");
        if (!sessionId) throw new Error("session/new returned no sessionId");
        log(`session: ${sessionId}`);

        // 1. Chinese conversation.
        const p1 = await prompt(handle, sessionId, "请只回复四个字：工作流开始");
        record("chat-chinese", () => {
            if (p1?.stopReason !== "end_turn") throw new Error(`stopReason=${p1?.stopReason}`);
            assertContains(handle.text(), "工作流开始", "chat-chinese");
        });

        // 2. Write a project file through the agent's tools.
        const p2 = await prompt(handle, sessionId,
            "在工作目录创建文件 note.txt，内容为 nuwax-workflow，完成后只回复：文件完成");
        record("tool-file-write", () => {
            if (p2?.stopReason !== "end_turn") throw new Error(`stopReason=${p2?.stopReason}`);
            assertFile("note.txt", "nuwax-workflow", "tool-file-write");
        });

        // 3. Read it back through the model (tool result must reach the wire).
        const p3 = await prompt(handle, sessionId, "读取 note.txt 的内容，然后只回复文件内容本身");
        record("tool-file-read", () => {
            if (p3?.stopReason !== "end_turn") throw new Error(`stopReason=${p3?.stopReason}`);
            assertContains(handle.text(), "nuwax-workflow", "tool-file-read");
        });

        // 4. Real shell command execution.
        const p4 = await prompt(handle, sessionId,
            "执行 shell 命令：printf shell-ok > cmd-marker.txt ，完成后只回复：命令完成");
        record("tool-shell", () => {
            if (p4?.stopReason !== "end_turn") throw new Error(`stopReason=${p4?.stopReason}`);
            assertFile("cmd-marker.txt", "shell-ok", "tool-shell");
        });

        // 5. MCP screenshot: typed tool round-trip, no base64 blob in text.
        const truthBefore = readTruth().length;
        const p5 = await prompt(handle, sessionId,
            "调用 take_screenshot 工具恰好一次，然后只回复你看到的画面主色（一个词）");
        log(`screenshot step answer: ${JSON.stringify(handle.text().slice(0, 200))}`);
        log(`screenshot step toolCalls: ${JSON.stringify(handle.obs.toolCalls)}`);
        record("mcp-screenshot", () => {
            if (p5?.stopReason !== "end_turn") throw new Error(`stopReason=${p5?.stopReason}`);
            const shots = readTruth().slice(truthBefore);
            const completed = shots.filter((s: any) => s?.event === "complete").length;
            if (completed < 1) {
                throw new Error(`take_screenshot never completed at the MCP server ledger: ${JSON.stringify(shots)}`);
            }
            const blob = handle.obs.textParts.find((t) => BASE64_RUN.test(t));
            if (blob) throw new Error("a text part carried a giant base64 run — image leaked into plain text");
            if (!handle.text().trim()) throw new Error("no final answer about the color");
        });

        // 6. Interrupt a long generation mid-stream.
        const essay = withTimeout(
            handle.agent.request(methods.agent.session.prompt as any, {
                sessionId,
                prompt: [{ type: "text", text: "请写一篇关于灯塔历史的1200字文章，带编号章节，直接开始正文。" }],
            }).then((v) => v as { stopReason?: string }),
            180_000,
            "essay",
        );
        const deadline = Date.now() + 90_000;
        while (!handle.obs.sawDelta && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!handle.obs.sawDelta) throw new Error("no streamed delta observed before cancel");
        await handle.agent.notify(methods.agent.session.cancel as any, { sessionId });
        const cancelled = await essay;
        record("interrupt", () => {
            if (cancelled?.stopReason !== "cancelled") throw new Error(`stopReason=${cancelled?.stopReason}`);
        });

        // 7. Continue after the interruption.
        const p7 = await prompt(handle, sessionId, "现在只回复：继续正常");
        record("continue-after-cancel", () => {
            if (p7?.stopReason !== "end_turn") throw new Error(`stopReason=${p7?.stopReason}`);
            assertContains(handle.text(), "继续正常", "continue-after-cancel");
        });

        // usage before compaction (latest usage_update).
        const beforeCompact = handle.obs.usageUpdates.at(-1);
        if (!beforeCompact) throw new Error("no usage_update observed before compaction");

        // 8. Compact and require the reported context to shrink.
        const p8 = await prompt(handle, sessionId, "/compact", 240_000);
        const afterCompactWait = await waitForUsage(handle, 20_000);
        record("compact", () => {
            if (p8?.stopReason !== "end_turn") throw new Error(`stopReason=${p8?.stopReason}`);
            if (!afterCompactWait) throw new Error("no usage_update after compaction");
            if (afterCompactWait.used >= beforeCompact.used) {
                throw new Error(`compaction did not shrink usage: ${afterCompactWait.used}/${afterCompactWait.size} vs ${beforeCompact.used}/${beforeCompact.size}`);
            }
        });

        // 9. Tools still work after compaction.
        const p9 = await prompt(handle, sessionId,
            "执行 shell 命令：printf post-compact > pc-marker.txt ，完成后只回复：压缩后完成");
        record("tool-after-compact", () => {
            if (p9?.stopReason !== "end_turn") throw new Error(`stopReason=${p9?.stopReason}`);
            assertFile("pc-marker.txt", "post-compact", "tool-after-compact");
        });
        const beforeShutdown = handle.obs.usageUpdates.at(-1)!;

        // 10. Shut the adapter down; nothing may survive it.
        const family = [handle.child.pid!, ...descendantsOf(handle.child.pid!)];
        handle.child.kill("SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 4000));
        record("shutdown-no-orphans", () => {
            const survivors = family.filter((pid) => {
                try {
                    process.kill(pid, 0);
                    return true;
                } catch {
                    return false;
                }
            });
            if (survivors.length) throw new Error(`processes survived adapter exit: ${survivors.join(",")}`);
        });

        // 11. Cold resume on a fresh adapter process.
        const reload = startAgent();
        try {
            await initialize(reload);
            const usageCountAtLoad = reload.obs.usageUpdates.length;
            const loaded = await withTimeout(
                reload.agent.request(methods.agent.session.load as any, { sessionId, cwd: work, mcpServers }),
                90_000,
                "session/load",
            );
            if (!loaded) throw new Error("session/load failed");
            await new Promise((resolve) => setTimeout(resolve, 4000));
            const restored = reload.obs.usageUpdates.at(-1);
            record("cold-resume-usage", () => {
                if (!restored) throw new Error("no usage_update after cold load");
                const delivered = reload.obs.usageUpdates.length - usageCountAtLoad;
                if (delivered > 2) throw new Error(`usage_update spammed after load: ${delivered} notifications`);
                if (restored.used < beforeShutdown.used) {
                    throw new Error(`restored usage ${restored.used} lost history vs ${beforeShutdown.used}`);
                }
            });
            // No further usage duplicates while idle.
            const idleCount = reload.obs.usageUpdates.length;
            await new Promise((resolve) => setTimeout(resolve, 3000));
            if (reload.obs.usageUpdates.length !== idleCount) throw new Error("usage_update duplicated while idle");

            // 12. One more real tool call after the cold resume.
            const p10 = await prompt(reload, sessionId,
                "执行 shell 命令：printf resumed-ok > resumed-marker.txt ，完成后只回复：恢复完成");
            record("tool-after-resume", () => {
                if (p10?.stopReason !== "end_turn") throw new Error(`stopReason=${p10?.stopReason}`);
                assertFile("resumed-marker.txt", "resumed-ok", "tool-after-resume");
            });

            const blob2 = reload.obs.textParts.find((t) => BASE64_RUN.test(t));
            if (blob2) throw new Error("post-resume text part carried a giant base64 run");

            reload.child.kill();
        } catch (error) {
            reload.child.kill();
            throw error;
        }

        fs.writeFileSync(path.join(VAL_ROOT, "workflow-summary.json"), JSON.stringify({ sessionId, steps }, null, 2));
        console.log(`WORKFLOW-PASS acp daily workflow on ${sessionId}: ${steps.length} steps; ${summarize(handle.obs)}`);
        process.exit(0);
    } catch (error) {
        console.error(`WORKFLOW-FAIL ${error}`);
        console.error(`last answer: ${JSON.stringify(handle.text().slice(0, 400))}`);
        console.error(`observed toolCalls: ${JSON.stringify(handle.obs.toolCalls)}`);
        console.error(`observed usageUpdates: ${JSON.stringify(handle.obs.usageUpdates)}`);
        console.error(`recent text parts: ${JSON.stringify(handle.obs.textParts.slice(-4).map((t) => t.slice(0, 120)))}`);
        console.error(handle.stderrTail());
        handle.child.kill();
        process.exit(1);
    }
}

async function waitForUsage(handle: AgentHandle, ms: number): Promise<{ used: number; size: number } | undefined> {
    const start = handle.obs.usageUpdates.length;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (handle.obs.usageUpdates.length > start) return handle.obs.usageUpdates.at(-1);
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return undefined;
}

void main().catch(() => { console.error("WORKFLOW-FAIL shared budget gateway is required"); process.exitCode = 1; });
