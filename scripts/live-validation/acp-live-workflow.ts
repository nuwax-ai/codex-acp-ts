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
 * text parts (images stay structured), compaction completes and reports usage,
 * exactly-one usage_update after cold load with no idle duplicates, and no
 * surviving codex descendants after the adapter exits.
 *
 * The runner (live-smallbatch.sh) provides NUWAX_* env (gateway origin,
 * dummy-key auth) and SHOT_TRUTH_PATH; this file never sees or prints a
 * real key. Prints `WORKFLOW-PASS <detail>` on success.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requireBudgetGateway } from "./gateway-contract.js";
import { FinalAssistantText } from "./assistant-text.js";
import {randomUUID} from "node:crypto";
import {assertRestoredUsage, assertScreenshot, beginPrompt, inspectContent, isModelDelta, latestUsageAfter,
    processTable, rememberFamily, requireCompletedTool, survivingFamily, workspacePath,
    type ProcessIdentity, type ToolCall, type ToolUpdate} from "./workflow-contracts.js";
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
    toolCalls: ToolCall[];
    toolCallUpdates: ToolUpdate[];
    usageUpdates: { used: number; size: number }[];
    textParts: string[];
    imageToolIds: string[];
    sawDelta: boolean;
    errors: string[];
}

function newObservation(): Observation {
    return { toolCalls: [], toolCallUpdates: [], usageUpdates: [], textParts: [], imageToolIds: [], sawDelta: false, errors: [] };
}

function summarize(obs: Observation): string {
    const tools = obs.toolCalls.map((t) => t.tool).join(",");
    const usage = obs.usageUpdates.map((u) => `${u.used}/${u.size}`).join(" ");
    return `tools=[${tools}] usage=[${usage}]`;
}

interface AgentHandle {
    child: ChildProcess;
    agent: ReturnType<ReturnType<typeof acpClient>["connect"]>["agent"];
    obs: Observation;
    text: () => string;
    resetText: () => void;
    stderrTail: () => string;
    tracked: Map<number, ProcessIdentity>;
    stopped: boolean;
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
            if (isModelDelta(update)) obs.sawDelta = true;
            if (update.sessionUpdate === "usage_update") {
                obs.usageUpdates.push({ used: update.used, size: update.size });
            }
            if (update.sessionUpdate === "tool_call") {
                obs.toolCalls.push({ id: update.toolCallId, tool: update.title ?? "", kind: update.kind, status: update.status });
            }
            if (update.sessionUpdate === "tool_call_update") {
                obs.toolCallUpdates.push({ id: update.toolCallId, status: typeof update.status === "string" ? update.status : undefined });
            }
            const content = inspectContent(update.content ?? update.update?.content);
            obs.textParts.push(...content.texts);
            if (content.images > 0 && typeof update.toolCallId === "string") obs.imageToolIds.push(update.toolCallId);
        })
        .onRequest(methods.client.session.requestPermission, (ctx: any) => {
            const options = ctx.params?.options ?? [];
            const allow = options.find((o: any) => o.kind === "allow_once") ?? options[0];
            return allow
                ? { outcome: { outcome: "selected", optionId: allow.optionId } }
                : { outcome: { outcome: "cancelled" } };
        })
        .onRequest(methods.client.fs.readTextFile, (ctx: any) => ({
            content: fs.readFileSync(workspacePath(work, String(ctx?.params?.path ?? "")), "utf8"),
        }))
        .onRequest(methods.client.fs.writeTextFile, (ctx: any) => {
            fs.writeFileSync(workspacePath(work, String(ctx?.params?.path ?? "")), String(ctx?.params?.content ?? ""));
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
        tracked: new Map(), stopped: false,
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
    beginPrompt(handle.obs);
    if (handle.child.pid) rememberFamily(handle.child.pid, processTable(), handle.tracked);
    const result = await withTimeout(
        handle.agent.request(methods.agent.session.prompt as any, {
            sessionId,
            prompt: [{ type: "text", text }],
        }).then((value) => value as { stopReason?: string }),
        timeoutMs,
        `prompt(${text.slice(0, 24)}…)`,
    );
    if (handle.child.pid) rememberFamily(handle.child.pid, processTable(), handle.tracked);
    return result;
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

function readTruth(): {event?: string; color?: string}[] {
    if (!fs.existsSync(SHOT_TRUTH_PATH)) return [];
    return fs.readFileSync(SHOT_TRUTH_PATH, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
}

async function stopAgent(handle: AgentHandle): Promise<void> {
    if (handle.stopped) return;
    try {
        if (handle.child.pid) rememberFamily(handle.child.pid, processTable(), handle.tracked);
        handle.child.kill("SIGKILL");
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            const survivors = survivingFamily(handle.tracked, processTable());
            if (survivors.length === 0) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error("owned processes survived adapter shutdown deadline");
    } finally {
        // Preserve a failed deadline/probe result even when cleanup succeeds.
        handle.stopped = true;
        handle.child.kill("SIGKILL");
        const table = processTable();
        for (const survivor of survivingFamily(handle.tracked, table)) {
            try { process.kill(survivor.pid, "SIGKILL"); } catch { /* already exited */ }
        }
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

    for (const marker of ["note.txt", "cmd-marker.txt", "pc-marker.txt", "resumed-marker.txt"]) fs.rmSync(path.join(work, marker), {force: true});
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
        const writeCursor = handle.obs.toolCalls.length;
        const p2 = await prompt(handle, sessionId,
            "在工作目录创建文件 note.txt，内容为 nuwax-workflow，完成后只回复：文件完成");
        record("tool-file-write", () => {
            if (p2?.stopReason !== "end_turn") throw new Error(`stopReason=${p2?.stopReason}`);
            requireCompletedTool(handle.obs.toolCalls.slice(writeCursor), handle.obs.toolCallUpdates, call => call.kind !== "think");
            assertFile("note.txt", "nuwax-workflow", "tool-file-write");
        });

        // 3. Read it back through the model (tool result must reach the wire).
        const readSecret = `read-${randomUUID()}`;
        fs.writeFileSync(path.join(work, "note.txt"), readSecret);
        const readCursor = handle.obs.toolCalls.length;
        const p3 = await prompt(handle, sessionId, "读取 note.txt 的当前内容，然后只回复文件内容本身");
        record("tool-file-read", () => {
            if (p3?.stopReason !== "end_turn") throw new Error(`stopReason=${p3?.stopReason}`);
            requireCompletedTool(handle.obs.toolCalls.slice(readCursor), handle.obs.toolCallUpdates, call => call.kind === "read" || call.kind === "execute");
            assertContains(handle.text(), readSecret, "tool-file-read");
        });

        // 4. Real shell command execution.
        const shellCursor = handle.obs.toolCalls.length;
        const p4 = await prompt(handle, sessionId,
            "执行 shell 命令：printf shell-ok > cmd-marker.txt ，完成后只回复：命令完成");
        record("tool-shell", () => {
            if (p4?.stopReason !== "end_turn") throw new Error(`stopReason=${p4?.stopReason}`);
            requireCompletedTool(handle.obs.toolCalls.slice(shellCursor), handle.obs.toolCallUpdates, call => call.kind === "execute" && call.tool.includes("cmd-marker.txt"));
            assertFile("cmd-marker.txt", "shell-ok", "tool-shell");
        });

        // 5. MCP screenshot: typed tool round-trip, no base64 blob in text.
        const truthBefore = readTruth().length;
        const shotCursor = handle.obs.toolCalls.length;
        const imagesBefore = handle.obs.imageToolIds.length;
        const p5 = await prompt(handle, sessionId,
            "调用 take_screenshot 工具恰好一次，然后只回复你看到的画面主色（一个词）");
        log(`screenshot step answer: ${JSON.stringify(handle.text().slice(0, 200))}`);
        log(`screenshot step toolCalls: ${JSON.stringify(handle.obs.toolCalls)}`);
        record("mcp-screenshot", () => {
            if (p5?.stopReason !== "end_turn") throw new Error(`stopReason=${p5?.stopReason}`);
            assertScreenshot(readTruth().slice(truthBefore), handle.text(), handle.obs.imageToolIds.slice(imagesBefore),
                handle.obs.toolCalls.slice(shotCursor), handle.obs.toolCallUpdates);
            const blob = handle.obs.textParts.find((t) => BASE64_RUN.test(t));
            if (blob) throw new Error("a text part carried a giant base64 run — image leaked into plain text");
            if (!handle.text().trim()) throw new Error("no final answer about the color");
        });

        // 6. Interrupt a long generation mid-stream.
        handle.resetText();
        beginPrompt(handle.obs);
        const essay = withTimeout(
            handle.agent.request(methods.agent.session.prompt as any, {
                sessionId,
                prompt: [{ type: "text", text: "请写一篇关于灯塔历史的1200字文章，带编号章节，直接开始正文。" }],
            }).then((v) => v as { stopReason?: string }),
            180_000,
            "essay",
        );
        void essay.catch(() => {}); // The explicit await below still reports failures after the handshake.
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

        // 8. A completed compaction and fresh usage; report the observed reduction.
        const compactUsageCursor = handle.obs.usageUpdates.length;
        const compactToolCursor = handle.obs.toolCalls.length;
        const p8 = await prompt(handle, sessionId, "/compact", 240_000);
        const afterCompactWait = await waitForUsage(handle, compactUsageCursor, 20_000);
        record("compact", () => {
            if (p8?.stopReason !== "end_turn") throw new Error(`stopReason=${p8?.stopReason}`);
            if (!afterCompactWait) throw new Error("no usage_update after compaction");
            requireCompletedTool(handle.obs.toolCalls.slice(compactToolCursor), handle.obs.toolCallUpdates, call => call.tool === "Compact conversation");
            if (!Number.isFinite(afterCompactWait.used) || afterCompactWait.used < 0 || !Number.isFinite(afterCompactWait.size) || afterCompactWait.size <= 0) throw new Error("invalid post-compaction usage");
            return `usage before=${beforeCompact.used}/${beforeCompact.size}, after=${afterCompactWait.used}/${afterCompactWait.size}, shrank=${afterCompactWait.used < beforeCompact.used}`;
        });

        // 9. Tools still work after compaction.
        const compactShellCursor = handle.obs.toolCalls.length;
        const shutdownUsageCursor = handle.obs.usageUpdates.length;
        const p9 = await prompt(handle, sessionId,
            "执行 shell 命令：printf post-compact > pc-marker.txt ，完成后只回复：压缩后完成");
        record("tool-after-compact", () => {
            if (p9?.stopReason !== "end_turn") throw new Error(`stopReason=${p9?.stopReason}`);
            requireCompletedTool(handle.obs.toolCalls.slice(compactShellCursor), handle.obs.toolCallUpdates, call => call.kind === "execute" && call.tool.includes("pc-marker.txt"));
            assertFile("pc-marker.txt", "post-compact", "tool-after-compact");
        });
        const beforeShutdown = latestUsageAfter(handle.obs.usageUpdates, shutdownUsageCursor);
        if (!beforeShutdown) throw new Error("no authoritative usage before shutdown");

        // 10. Shut the adapter down; nothing may survive it.
        await stopAgent(handle);
        record("shutdown-no-orphans", () => {});

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
            record("cold-resume-usage", () => {
                assertRestoredUsage(beforeShutdown, reload.obs.usageUpdates.slice(usageCountAtLoad));
            });
            // No further usage duplicates while idle.
            const idleCount = reload.obs.usageUpdates.length;
            await new Promise((resolve) => setTimeout(resolve, 3000));
            if (reload.obs.usageUpdates.length !== idleCount) throw new Error("usage_update duplicated while idle");

            // 12. One more real tool call after the cold resume.
            const resumedShellCursor = reload.obs.toolCalls.length;
            const p10 = await prompt(reload, sessionId,
                "执行 shell 命令：printf resumed-ok > resumed-marker.txt ，完成后只回复：恢复完成");
            record("tool-after-resume", () => {
                if (p10?.stopReason !== "end_turn") throw new Error(`stopReason=${p10?.stopReason}`);
                requireCompletedTool(reload.obs.toolCalls.slice(resumedShellCursor), reload.obs.toolCallUpdates, call => call.kind === "execute" && call.tool.includes("resumed-marker.txt"));
                assertFile("resumed-marker.txt", "resumed-ok", "tool-after-resume");
            });

            const blob2 = reload.obs.textParts.find((t) => BASE64_RUN.test(t));
            if (blob2) throw new Error("post-resume text part carried a giant base64 run");

        } finally {
            await stopAgent(reload);
        }

        fs.writeFileSync(path.join(VAL_ROOT, "workflow-summary.json"), JSON.stringify({ sessionId, steps }, null, 2));
        console.log(`WORKFLOW-PASS acp daily workflow on ${sessionId}: ${steps.length} steps; ${summarize(handle.obs)}`);
    } catch (error) {
        console.error(`WORKFLOW-FAIL ${error}`);
        console.error(`last answer: ${JSON.stringify(handle.text().slice(0, 400))}`);
        console.error(`observed toolCalls: ${JSON.stringify(handle.obs.toolCalls)}`);
        console.error(`observed usageUpdates: ${JSON.stringify(handle.obs.usageUpdates)}`);
        console.error(`recent text parts: ${JSON.stringify(handle.obs.textParts.slice(-4).map((t) => t.slice(0, 120)))}`);
        console.error(handle.stderrTail());
        steps.push({step: "workflow", pass: false, detail: String(error)});
        process.exitCode = 1;
    } finally {
        try { await stopAgent(handle); }
        finally { fs.writeFileSync(path.join(VAL_ROOT, "workflow-summary.json"), JSON.stringify({sessionId, steps}, null, 2)); }
    }
}

async function waitForUsage(handle: AgentHandle, cursor: number, ms: number): Promise<{ used: number; size: number } | undefined> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const usage = latestUsageAfter(handle.obs.usageUpdates, cursor);
        if (usage) return usage;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return undefined;
}

void main().catch(() => { console.error("WORKFLOW-FAIL gateway or cleanup contract failed"); process.exitCode = 1; });
