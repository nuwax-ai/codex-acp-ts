/**
 * 50-round offline stress validation for the ACP dev -> codex app-server ->
 * mock vendor main path (closure-plan item 7).
 *
 * Run per wire via scripts/acp-validation/run-stress.sh; each invocation
 * keeps ONE app-server alive for its wire's non-cold rounds. The round
 * table is fixed (deterministic seed): per wire 17 rounds = 4 text, 4
 * tool-image, 2 cancel-before-headers, 2 cancel-mid-stream, 1
 * cancel-during-tool, 2 compact+continuation, 2 cold-restart; three wires
 * give 51 rounds with 15 cancels, 12 tool-image rounds, 6 compactions and
 * 6 client cold-restarts. Per-round receipts: duration, model HTTP delta,
 * mock open sockets, RSS/FD counts of the agent + app-server (+ tool
 * subprocess) via /proc on Linux. After shutdown the run asserts the mock
 * holds no open connections, no shot-server processes remain, and the
 * app-server exited.
 *
 * Credential-free: same dummy key and synthetic red PNG as the six-scenario
 * driver; no real vendor, no real screenshots.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { execSync } from "node:child_process";
import {
    PROTOCOL_VERSION,
    client as acpClient,
    methods,
    ndJsonStream,
} from "@agentclientprotocol/sdk";

const REPO = path.resolve(import.meta.dirname, "..", "..");
function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`missing ${name}; use run-stress.sh`);
    return value;
}
const CODEX_PATH = requiredEnv("CODEX_PATH");
const VAL_MODEL = process.env["VAL_MODEL"] ?? "acp-val-mock-model";
const VAL_BASE_URL = requiredEnv("VAL_BASE_URL");
const VAL_ENV_KEY = process.env["VAL_ENV_KEY"] ?? "ACP_VAL_MOCK_API_KEY";
const VAL_ENV_VALUE = requiredEnv(VAL_ENV_KEY);
const MOCK_RECORD_PATH = requiredEnv("MOCK_RECORD_PATH");
const MOCK_STATS_URL = requiredEnv("MOCK_STATS_URL");
const VAL_WIRE = process.env["VAL_WIRE"] ?? "chat";
const SHOT_TAKE_MS = process.env["SHOT_TAKE_MS"] ?? "5000";

const SESSION_TOKEN = "ACP-COLD-42";

const rootDir = process.env["VAL_ROOT"] ?? fs.mkdtempSync(path.join(os.tmpdir(), "acp-val-stress-"));
const codexHome = path.join(rootDir, "codex-home");
const workspace = path.join(rootDir, "workspace");
const logsDir = path.join(rootDir, "appserver-logs");
for (const dir of [codexHome, workspace, logsDir]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
        `model = "${VAL_MODEL}"`,
        `model_provider = "vendor"`,
        ``,
        `[model_providers.vendor]`,
        `name = "ACP stress mock vendor"`,
        `base_url = "${VAL_BASE_URL}"`,
        `env_key = "${VAL_ENV_KEY}"`,
        `wire_api = "${VAL_WIRE}"`,
        `request_max_retries = 1`,
        `stream_max_retries = 1`,
        `stream_idle_timeout_ms = 60000`,
        ``,
    ].join("\n"),
);

interface RecordedRequest {
    ts: string;
    kind?: string;
    body: string;
}
function readRecorded(): RecordedRequest[] {
    if (!fs.existsSync(MOCK_RECORD_PATH)) return [];
    return fs
        .readFileSync(MOCK_RECORD_PATH, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as RecordedRequest);
}
function mockStats(): Promise<{ openSockets: number; requests: number }> {
    // agent:false — a pooled keep-alive connection would itself show up in
    // the open-socket count and fake a leak.
    const url = new URL(MOCK_STATS_URL);
    return new Promise((resolve, reject) => {
        const request = http.get(
            { host: url.hostname, port: url.port, path: url.pathname, agent: false },
            (response) => {
                let body = "";
                response.on("data", (chunk) => { body += chunk; });
                response.on("end", () => {
                    try {
                        resolve(JSON.parse(body) as { openSockets: number; requests: number });
                    } catch (error) {
                        reject(error);
                    }
                });
            },
        );
        request.on("error", reject);
    });
}
/** Best-effort process metrics (Linux /proc; null elsewhere). */
function procMetrics(pid: number | undefined): { rssKb: number | null; fds: number | null } | null {
    if (!pid || process.platform !== "linux") return null;
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
        const rssKb = Number(status.match(/^VmRSS:\s+(\d+) kB/m)?.[1] ?? null);
        let fds: number | null = null;
        try {
            fds = fs.readdirSync(`/proc/${pid}/fd`).length;
        } catch {
            fds = null;
        }
        return { rssKb: Number.isFinite(rssKb) ? rssKb : null, fds };
    } catch {
        return null;
    }
}
function childPids(pid: number): number[] {
    if (process.platform !== "linux") return [];
    try {
        const out: number[] = [];
        for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
            const children = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim();
            if (children) out.push(...children.split(/\s+/).map(Number));
        }
        return out;
    } catch {
        return [];
    }
}

const results: Array<Record<string, unknown>> = [];
const failures: string[] = [];
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

interface AgentHandle {
    child: ChildProcess;
    agent: ReturnType<ReturnType<typeof acpClient>["connect"]>["agent"];
}
let traceToolCalls: string[] = [];
let traceToolCompleted: string[] = [];
let traceToolNames = new Map<string, string>();
let traceText = "";

function startAgent(): AgentHandle {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: REPO,
        env: { ...process.env, CODEX_HOME: codexHome, APP_SERVER_LOGS: logsDir },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrTail: string[] = [];
    child.stderr?.on("data", (d: Buffer) => {
        stderrTail.push(...d.toString().split("\n"));
        while (stderrTail.length > 30) stderrTail.shift();
    });
    (child as unknown as { stderrTail: () => string }).stderrTail = () => stderrTail.join("\n");
    child.stdin?.on("error", () => {});
    const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = acpClient({ name: "acp-stress" })
        .onNotification(methods.client.session.update, (ctx: any) => {
            const update = ctx.params?.update;
            if (!update) return;
            if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
                traceText += update.content.text;
            }
            if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
                // The completion update may omit the title; correlate by id.
                if (update.title) traceToolNames.set(update.toolCallId, update.title);
                const name = update.title ?? traceToolNames.get(update.toolCallId) ?? update.toolCallId ?? "tool";
                traceToolCalls.push(name);
                if (update.status === "completed") traceToolCompleted.push(name);
            }
        })
        .onRequest(methods.client.session.requestPermission, (ctx: any) => {
            const options = ctx.params?.options ?? [];
            const allow = options.find((o: any) => o.kind === "allow_once") ?? options[0];
            return allow
                ? { outcome: { outcome: "selected", optionId: allow.optionId } }
                : { outcome: { outcome: "cancelled" } };
        })
        .onRequest(methods.client.fs.readTextFile, () => ({ content: "" }))
        .onRequest(methods.client.fs.writeTextFile, () => ({}))
        .connect(stream);
    return { child, agent: connection.agent };
}

function killAgent(handle: AgentHandle | undefined): Promise<void> {
    return new Promise((resolve) => {
        if (!handle || handle.child.exitCode !== null || handle.child.signalCode !== null) {
            resolve();
            return;
        }
        handle.child.on("exit", () => resolve());
        handle.child.kill("SIGTERM");
        setTimeout(() => {
            if (handle.child.exitCode === null) handle.child.kill("SIGKILL");
        }, 5000).unref();
    });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

type RoundKind =
    | "text"
    | "tool-image"
    | "cancel-headers"
    | "cancel-mid-stream"
    | "cancel-during-tool"
    | "compact"
    | "cold-restart";

/** Fixed round table (deterministic): 17 rounds per wire. */
const ROUND_TABLE: RoundKind[] = [
    "text", // seed the token first
    "tool-image",
    "text",
    "cancel-headers",
    "compact",
    "text",
    "cancel-mid-stream",
    "tool-image",
    "cold-restart",
    "text",
    "cancel-headers",
    "tool-image",
    "compact",
    "cancel-mid-stream",
    "text",
    "cancel-during-tool",
    "cold-restart",
];

async function roundSnapshot(): Promise<Record<string, unknown>> {
    const stats = await mockStats().catch(() => ({ openSockets: -1, requests: -1 }));
    return { httpTotal: readRecorded().length, openSockets: stats.openSockets };
}

async function runRound(
    handle: AgentHandle,
    sessionId: string,
    kind: RoundKind,
    roundIndex: number,
): Promise<Record<string, unknown>> {
    const started = Date.now();
    traceToolCalls = [];
    traceToolCompleted = [];
    traceText = "";
    const before = await roundSnapshot();
    const metricsBefore = { agent: procMetrics(handle.child.pid), children: childPids(handle.child.pid ?? 0).map(procMetrics) };
    let stopReason: string | undefined;
    let error: string | undefined;
    const prompt = (text: string) =>
        handle.agent.request(methods.agent.session.prompt as any, {
            sessionId,
            prompt: [{ type: "text", text }],
        }).then((r) => r as any).catch((e) => ({ error: String(e) }));

    try {
        if (kind === "text") {
            const text =
                roundIndex === 0
                    ? `Remember the token ${SESSION_TOKEN} for later. Now reply with exactly the single word: pong`
                    : `Round ${roundIndex}: reply with exactly the single word: pong`;
            const response = await withTimeout(prompt(text), 120_000, "text round");
            stopReason = response?.stopReason;
            if (response?.stopReason !== "end_turn" || !/pong/i.test(traceText)) {
                error = `text round unexpected: stop=${response?.stopReason ?? response?.error} text="${traceText.slice(0, 60)}"`;
            }
        } else if (kind === "tool-image") {
            const response = await withTimeout(
                prompt("Force a real tool call: call the take_screenshot tool exactly once, wait for its output, then reply with ONLY the dominant color word."),
                120_000,
                "tool-image round",
            );
            stopReason = response?.stopReason;
            const toolDone = traceToolCompleted.some((t) => /screenshot/i.test(t));
            if (response?.stopReason !== "end_turn" || !toolDone || !/red/i.test(traceText)) {
                error = `tool-image round unexpected: stop=${response?.stopReason ?? response?.error} toolDone=${toolDone} answer="${traceText.trim().slice(0, 30)}"`;
            }
        } else if (kind === "cancel-headers" || kind === "cancel-mid-stream") {
            const pending = prompt(
                kind === "cancel-headers"
                    ? "hang before headers: never answer this"
                    : "Write a very detailed 3000-word essay about ocean currents. Do not summarize.",
            );
            if (kind === "cancel-mid-stream") {
                await new Promise<void>((resolve) => {
                    const timer = setInterval(() => {
                        if (traceText.includes("essay paragraph")) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 100);
                    setTimeout(() => {
                        clearInterval(timer);
                        resolve();
                    }, 20_000).unref();
                });
            } else {
                await new Promise((r) => setTimeout(r, 1500));
            }
            await handle.agent.notify(methods.agent.session.cancel as any, { sessionId });
            const response = await withTimeout(pending, 120_000, "cancel round resolution");
            stopReason = response?.stopReason;
            if (response?.stopReason !== "cancelled") {
                error = `cancel round not cancelled: stop=${response?.stopReason ?? response?.error}`;
            }
            // The cancelled turn must not keep paying for model attempts.
            const afterCancel = readRecorded().length;
            await new Promise((r) => setTimeout(r, 1500));
            const drained = readRecorded().length;
            if (drained - afterCancel > 1) {
                error = `${error ?? ""} [post-cancel requests kept arriving: +${drained - afterCancel}]`;
            }
        } else if (kind === "cancel-during-tool") {
            const pending = prompt(
                "Force a real tool call: call the take_screenshot tool exactly once (it is slow), wait for its output, then reply with ONLY the dominant color word.",
            );
            await new Promise<void>((resolve) => {
                const timer = setInterval(() => {
                    if (traceToolCalls.some((t) => /screenshot/i.test(t))) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
                setTimeout(() => {
                    clearInterval(timer);
                    resolve();
                }, 20_000).unref();
            });
            await handle.agent.notify(methods.agent.session.cancel as any, { sessionId });
            const response = await withTimeout(pending, 120_000, "tool-cancel resolution");
            stopReason = response?.stopReason;
            const toolDone = traceToolCompleted.some((t) => /screenshot/i.test(t));
            if (response?.stopReason !== "cancelled" || toolDone) {
                error = `cancel-during-tool unexpected: stop=${response?.stopReason ?? response?.error} toolCompleted=${toolDone}`;
            }
        } else if (kind === "compact") {
            const compact = await withTimeout(prompt("/compact"), 90_000, "compact round");
            stopReason = compact?.stopReason;
            const compactSeen = readRecorded().slice(before.httpTotal as number).some((r) => r.kind === "compaction");
            const followUp = await withTimeout(prompt("Reply with exactly: post-compact-ok"), 120_000, "compact follow-up");
            if (compact?.stopReason !== "end_turn" || !compactSeen || followUp?.stopReason !== "end_turn" || !/post-compact-ok/i.test(traceText)) {
                error = `compact round unexpected: compactStop=${compact?.stopReason ?? compact?.error} seen=${compactSeen} followStop=${followUp?.stopReason ?? followUp?.error} text="${traceText.trim().slice(0, 30)}"`;
            }
        }
        // cold-restart is handled by the caller (needs a new process).
    } catch (e) {
        error = `round threw: ${String(e)}`;
    }
    const after = await roundSnapshot();
    const metricsAfter = { agent: procMetrics(handle.child.pid), children: childPids(handle.child.pid ?? 0).map(procMetrics) };
    return {
        round: roundIndex,
        kind,
        pass: !error,
        error,
        stopReason,
        ms: Date.now() - started,
        httpDelta: (after.httpTotal as number) - (before.httpTotal as number),
        openSockets: after.openSockets,
        metricsBefore,
        metricsAfter,
    };
}

async function main() {
    const binary = fs.readFileSync(CODEX_PATH);
    const sha256 = crypto.createHash("sha256").update(binary).digest("hex");
    log(`stress root: ${rootDir}`);
    log(`codex: ${CODEX_PATH} sha256=${sha256} wire=${VAL_WIRE}`);
    let handle: AgentHandle | undefined;
    try {
        handle = startAgent();
        await withTimeout(
            handle.agent.request(methods.agent.initialize as any, {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, session: { compaction: {} } },
            }),
            30_000,
            "initialize",
        );
        const session = await withTimeout(
            handle.agent.request(methods.agent.session.new as any, {
                cwd: workspace,
                mcpServers: [
                    {
                        type: "stdio",
                        name: "screenshots",
                        command: process.execPath,
                        args: [path.join(REPO, "scripts", "acp-validation", "shot-server.mjs")],
                        env: [{ name: "SHOT_TAKE_MS", value: SHOT_TAKE_MS }],
                        cwd: workspace,
                    },
                ],
            }),
            60_000,
            "session/new",
        );
        const sessionId = (session as { sessionId?: string }).sessionId;
        if (!sessionId) throw new Error("session/new returned no sessionId");
        // Warm-up turn outside the measured table (model + MCP registration).
        const warm = await withTimeout(
            handle.agent.request(methods.agent.session.prompt as any, {
                sessionId,
                prompt: [{ type: "text", text: `Remember the token ${SESSION_TOKEN}. Reply with exactly: pong` }],
            }).then((r) => r as any).catch((e) => ({ error: String(e) })),
            120_000,
            "warm-up",
        );
        log(`warm-up stop=${warm?.stopReason ?? warm?.error}`);
        await new Promise((r) => setTimeout(r, 4000));

        for (let index = 0; index < ROUND_TABLE.length; index += 1) {
            const kind = ROUND_TABLE[index];
            if (kind === "cold-restart") {
                const started = Date.now();
                const before = await roundSnapshot();
                let error: string | undefined;
                await killAgent(handle);
                handle = startAgent();
                try {
                    await withTimeout(
                        handle.agent.request(methods.agent.initialize as any, {
                            protocolVersion: PROTOCOL_VERSION,
                            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, session: { compaction: {} } },
                        }),
                        30_000,
                        "initialize (restart)",
                    );
                    await withTimeout(
                        handle.agent.request((methods.agent.session as any).load ?? "session/load", {
                            sessionId,
                            cwd: workspace,
                            // Re-register the MCP server: later tool rounds in
                            // the table must find take_screenshot advertised.
                            mcpServers: [
                                {
                                    type: "stdio",
                                    name: "screenshots",
                                    command: process.execPath,
                                    args: [path.join(REPO, "scripts", "acp-validation", "shot-server.mjs")],
                                    env: [{ name: "SHOT_TAKE_MS", value: SHOT_TAKE_MS }],
                                    cwd: workspace,
                                },
                            ],
                        }),
                        60_000,
                        "session/load",
                    );
                    traceText = "";
                    const recall = await withTimeout(
                        handle.agent.request(methods.agent.session.prompt as any, {
                            sessionId,
                            prompt: [{ type: "text", text: "What token did I ask you to remember at the very start? Reply with just the token." }],
                        }).then((r) => r as any).catch((e) => ({ error: String(e) })),
                        120_000,
                        "recall",
                    );
                    const tokenInRequest = readRecorded().slice(before.httpTotal as number).some((r) => r.body.includes(SESSION_TOKEN));
                    if (recall?.stopReason !== "end_turn" || !traceText.toUpperCase().includes(SESSION_TOKEN) || !tokenInRequest) {
                        error = `cold-restart recall failed: stop=${recall?.stopReason ?? recall?.error} tokenInRequest=${tokenInRequest} text="${traceText.trim().slice(0, 30)}"`;
                    }
                } catch (e) {
                    error = `cold-restart threw: ${String(e)}`;
                }
                const after = await roundSnapshot();
                results.push({
                    round: index,
                    kind,
                    pass: !error,
                    error,
                    ms: Date.now() - started,
                    httpDelta: (after.httpTotal as number) - (before.httpTotal as number),
                    openSockets: after.openSockets,
                });
                log(`round ${index} cold-restart: ${error ? "FAIL " + error : "pass"}`);
                if (error) failures.push(`round ${index} cold-restart: ${error}`);
                continue;
            }
            const receipt = await runRound(handle!, sessionId, kind, index);
            results.push(receipt);
            log(`round ${index} ${kind}: ${receipt.error ? "FAIL " + receipt.error : `pass (${receipt.ms}ms, http+${receipt.httpDelta})`}`);
            if (receipt.error) failures.push(`round ${index} ${kind}: ${receipt.error}`);
        }
    } catch (error) {
        failures.push(`driver: ${String(error)}`);
        if (handle) log(`agent stderr tail:\n${(handle.child as unknown as { stderrTail: () => string }).stderrTail?.() ?? ""}`);
    } finally {
        const shutdownStarted = Date.now();
        await killAgent(handle);
        const shutdownMs = Date.now() - shutdownStarted;
        await new Promise((r) => setTimeout(r, 1500));
        const stats = await mockStats().catch(() => ({ openSockets: -1, requests: -1 }));
        let leftoverTools = -1;
        if (process.platform === "linux") {
            // Children drain asynchronously after the SIGTERM chain; poll
            // instead of snapshotting (a lone survivor at +1.5s that exits
            // within the window is teardown, not a leak).
            const countShotServers = () => {
                try {
                    // [.] keeps the pattern from matching this probe's own
                    // /bin/sh -c wrapper (which contains the literal string).
                    return Number(execSync('pgrep -fc "shot-server[.]mjs" || true', { encoding: "utf8" }).trim() || 0);
                } catch {
                    return -1;
                }
            };
            for (let i = 0; i < 20; i += 1) {
                leftoverTools = countShotServers();
                if (leftoverTools === 0) break;
                await new Promise((r) => setTimeout(r, 500));
            }
        }
        if (stats.openSockets > 0) failures.push(`mock still holds ${stats.openSockets} open sockets after shutdown`);
        if (shutdownMs > 15_000) failures.push(`app-server/agent took ${shutdownMs}ms to shut down`);
        if (leftoverTools > 0) failures.push(`${leftoverTools} shot-server processes still alive after shutdown`);
        const agentRss = results
            .map((r) => (r as any).metricsAfter?.agent?.rssKb)
            .filter((v: unknown): v is number => typeof v === "number");
        const artifact = {
            codexPath: CODEX_PATH,
            codexSha256: sha256,
            valWire: VAL_WIRE,
            roundsPlanned: ROUND_TABLE.length,
            roundsRun: results.length,
            roundsPassed: results.filter((r) => r.pass).length,
            cancels: results.filter((r) => r.kind?.startsWith("cancel")).length,
            toolImageRounds: results.filter((r) => r.kind === "tool-image").length,
            compactions: results.filter((r) => r.kind === "compact").length,
            coldRestarts: results.filter((r) => r.kind === "cold-restart").length,
            shutdownMs,
            mockOpenSocketsAfter: stats.openSockets,
            leftoverShotServers: leftoverTools,
            agentRssSeriesKb: agentRss,
            results,
            failures,
        };
        fs.writeFileSync(path.join(rootDir, "stress-results.json"), JSON.stringify(artifact, null, 2));
        log(`stress artifact: ${path.join(rootDir, "stress-results.json")}`);
        log(
            `summary: ${artifact.roundsPassed}/${artifact.roundsRun} rounds passed (cancels=${artifact.cancels} toolImage=${artifact.toolImageRounds} compact=${artifact.compactions} cold=${artifact.coldRestarts}); mockOpenSocketsAfter=${stats.openSockets}; shutdown=${shutdownMs}ms`,
        );
        process.exit(failures.length > 0 ? 1 : 0);
    }
}

void main();
