/**
 * 54-round offline stress validation for the ACP dev -> codex app-server ->
 * mock vendor main path (closure-plan item 7; tool-image rounds verified
 * per review item 6).
 *
 * Run per wire via scripts/acp-validation/run-stress.sh; each invocation
 * keeps ONE app-server alive for its wire's non-cold rounds. The round
 * table is fixed (deterministic, recorded in the summary artifact): per
 * wire 18 rounds = 5 text, 4 tool-image, 2 cancel-before-headers, 2
 * cancel-mid-stream, 1 cancel-during-tool, 2 compact+continuation, 2
 * cold-restart; three wires give 54 rounds with 15 cancels, 12 tool-image
 * rounds (>= 4 per wire), 6 compactions and 6 client cold-restarts.
 *
 * Tool-image rounds are VERIFIED end to end (review item 6):
 * shot-server.mjs serves a different solid-color PNG per call and appends
 * ground truth {ts, mcpCallId, color, event} to $SHOT_TRUTH_PATH; the mock
 * vendor decodes the typed image carried by the CURRENT turn's tail and
 * answers with the classified color name; this driver asserts the agent's
 * final message EQUALS the ground-truth color (case-insensitive). Rounds
 * where the mock answered image-missing / image-stale / image-undecodable
 * fail with that reason, and only verified rounds count toward
 * verifiedImageRounds (floor: >= 4 per wire). Cancel-during-tool rounds
 * never count.
 *
 * Cancel stages prove their precondition before cancelling: before-headers
 * waits until the mock has RECORDED the hang request (an arrival signal —
 * the hang kind never answers), mid-stream waits for an actual stream
 * delta, during-tool waits for the shot-server "start" truth record (the
 * tool subprocess really began). A precondition wait that times out FAILS
 * the round instead of silently cancelling. After each cancel, no
 * additional MAIN model request may arrive for that turn; auxiliary
 * requests (title/guardian, identified by their recorded kind) are counted
 * explicitly in auxRequestCounts instead of being silently tolerated.
 *
 * Per-round receipts: duration, model HTTP delta, mock open sockets,
 * RSS/FD counts of the agent + app-server (+ tool subprocess) via /proc on
 * Linux. After shutdown the run asserts the mock holds no open
 * connections, no shot-server processes remain, and the app-server exited.
 *
 * Credential-free: same dummy key and synthetic palette PNGs as the
 * six-scenario driver; no real vendor, no real screenshots.
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
const SHOT_TRUTH_PATH = requiredEnv("SHOT_TRUTH_PATH");
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
/** Ground-truth records appended by shot-server.mjs. */
interface TruthRecord {
    ts: string;
    mcpCallId: unknown;
    color?: string;
    event?: string;
}
function readTruth(): TruthRecord[] {
    if (!fs.existsSync(SHOT_TRUTH_PATH)) return [];
    return fs
        .readFileSync(SHOT_TRUTH_PATH, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as TruthRecord);
}

/** Poll a predicate; resolves false on timeout (callers FAIL the round). */
function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
    return new Promise((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (predicate()) {
                clearInterval(timer);
                resolve(true);
            } else if (Date.now() - started >= timeoutMs) {
                clearInterval(timer);
                resolve(false);
            }
        }, intervalMs);
    });
}

interface AuxCounts {
    title: number;
    guardian: number;
}
/** Split recorded requests into main-turn requests and auxiliary ones
 * (title/guardian are identifiable by their recorded kind marker). */
function classifyRequests(records: RecordedRequest[]): { main: RecordedRequest[]; aux: AuxCounts } {
    const aux: AuxCounts = { title: 0, guardian: 0 };
    const main: RecordedRequest[] = [];
    for (const record of records) {
        if (record.kind === "title") aux.title += 1;
        else if (record.kind === "guardian") aux.guardian += 1;
        else main.push(record);
    }
    return { main, aux };
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
        env: {
            ...process.env,
            CODEX_HOME: codexHome,
            APP_SERVER_LOGS: logsDir,
            // The wrapper's checkAuthorization() asks the app-server for an
            // account; a fresh CODEX_HOME has none, so give the wrapper its
            // supported default-auth escape hatch with the SAME dummy key
            // the mock vendor's config.toml provider uses (stored locally
            // in the throwaway CODEX_HOME; no real credential, no network
            // login).
            DEFAULT_AUTH_REQUEST: JSON.stringify({
                methodId: "api-key",
                _meta: { "api-key": { apiKey: VAL_ENV_VALUE } },
            }),
        },
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

/**
 * Fixed round table (deterministic): 18 rounds per wire, including FOUR
 * tool-image rounds (>= 4 per wire, >= 12 across the three wires) and one
 * cancel-during-tool round whose image round never counts. The table is
 * recorded verbatim in the summary artifact.
 */
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
    "tool-image",
    "cancel-during-tool",
    "cold-restart",
];
const MIN_VERIFIED_IMAGE_ROUNDS_PER_WIRE = 4;

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
    const recordBefore = readRecorded();
    const auxRequestCounts: AuxCounts = { title: 0, guardian: 0 };
    let stopReason: string | undefined;
    let error: string | undefined;
    let verifiedImage: boolean | undefined;
    let groundTruthColor: string | undefined;
    let postCancelMainRequests: number | undefined;
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
            const truthBefore = readTruth().length;
            const response = await withTimeout(
                prompt("Force a real tool call: call the take_screenshot tool exactly once, wait for its output, then reply with ONLY the dominant color word."),
                120_000,
                "tool-image round",
            );
            stopReason = response?.stopReason;
            const toolDone = traceToolCompleted.some((t) => /screenshot/i.test(t));
            // Ground truth: the NEWEST complete record of THIS round. Only a
            // round whose final message equals the served color counts.
            const truthDelta = readTruth().slice(truthBefore).filter((t) => t.event === "complete");
            groundTruthColor = truthDelta.at(-1)?.color?.toLowerCase();
            const answer = traceText.trim().toLowerCase().replace(/[^a-z]/g, "");
            const badKinds = readRecorded()
                .slice(recordBefore.length)
                .map((r) => r.kind ?? "?")
                .filter((k) => k === "image-missing" || k === "image-stale" || k === "image-undecodable");
            verifiedImage = response?.stopReason === "end_turn" && toolDone && groundTruthColor !== undefined && answer === groundTruthColor;
            if (!verifiedImage) {
                error = `tool-image round unverified: stop=${response?.stopReason ?? response?.error} toolDone=${toolDone} groundTruth=${groundTruthColor ?? "none"} answer="${traceText.trim().slice(0, 40)}"`;
                if (badKinds.length > 0) error += ` mockKinds=${badKinds.join(",")}`;
                else if (groundTruthColor !== undefined && answer !== groundTruthColor && toolDone) error += " (agent answer did not match the served image color)";
            }
        } else if (kind === "cancel-headers" || kind === "cancel-mid-stream") {
            const pending = prompt(
                kind === "cancel-headers"
                    ? "hang before headers: never answer this"
                    : "Write a very detailed 3000-word essay about ocean currents. Do not summarize.",
            );
            let precondition = true;
            if (kind === "cancel-mid-stream") {
                // A delta must actually arrive before cancelling — otherwise
                // the cancel "succeeds" against a request that never streamed.
                precondition = await waitFor(() => traceText.includes("essay paragraph"), 20_000, 100);
            } else {
                // The hang request must actually ARRIVE at the mock (it is
                // recorded the moment its body lands; it never answers).
                precondition = await waitFor(
                    () => readRecorded().slice(recordBefore.length).some((r) => r.kind === "hang"),
                    15_000,
                    100,
                );
            }
            await handle.agent.notify(methods.agent.session.cancel as any, { sessionId });
            const response = await withTimeout(pending, 120_000, "cancel round resolution");
            stopReason = response?.stopReason;
            if (!precondition) {
                error = `cancel round precondition failed: ${kind === "cancel-headers" ? "hang request never arrived at the mock" : "no stream delta observed before cancel"}`;
            } else if (response?.stopReason !== "cancelled") {
                error = `cancel round not cancelled: stop=${response?.stopReason ?? response?.error}`;
            }
            // The cancelled turn must not keep paying for MAIN model
            // attempts; auxiliary (title/guardian) requests are classified
            // and counted, not silently tolerated.
            const afterCancel = readRecorded().length;
            await new Promise((r) => setTimeout(r, 1500));
            const { main, aux: cancelAux } = classifyRequests(readRecorded().slice(afterCancel));
            postCancelMainRequests = main.length;
            if (auxRequestCounts) {
                auxRequestCounts.title += cancelAux.title;
                auxRequestCounts.guardian += cancelAux.guardian;
            }
            if (main.length > 0) {
                const kinds = main.map((m) => m.kind ?? "?").join(",");
                error = `${error ?? ""} [post-cancel MAIN model requests kept arriving: +${main.length} (${kinds})]`;
            }
        } else if (kind === "cancel-during-tool") {
            const truthBefore = readTruth().length;
            const pending = prompt(
                "Force a real tool call: call the take_screenshot tool exactly once (it is slow), wait for its output, then reply with ONLY the dominant color word.",
            );
            // The tool must actually START (shot-server appends a start
            // record before its SHOT_TAKE_MS delay) before cancelling.
            const startedOk = await waitFor(
                () => readTruth().slice(truthBefore).some((t) => t.event === "start"),
                20_000,
                100,
            );
            await handle.agent.notify(methods.agent.session.cancel as any, { sessionId });
            const response = await withTimeout(pending, 120_000, "tool-cancel resolution");
            stopReason = response?.stopReason;
            const toolDone = traceToolCompleted.some((t) => /screenshot/i.test(t));
            if (!startedOk) {
                error = `cancel-during-tool precondition failed: tool never started (no start truth record) before cancel`;
            } else if (response?.stopReason !== "cancelled" || toolDone) {
                error = `cancel-during-tool unexpected: stop=${response?.stopReason ?? response?.error} toolCompleted=${toolDone}`;
            }
            const afterCancel = readRecorded().length;
            await new Promise((r) => setTimeout(r, 1500));
            const { main, aux: cancelAux } = classifyRequests(readRecorded().slice(afterCancel));
            postCancelMainRequests = main.length;
            if (auxRequestCounts) {
                auxRequestCounts.title += cancelAux.title;
                auxRequestCounts.guardian += cancelAux.guardian;
            }
            if (main.length > 0) {
                const kinds = main.map((m) => m.kind ?? "?").join(",");
                error = `${error ?? ""} [post-cancel MAIN model requests kept arriving: +${main.length} (${kinds})]`;
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
    const roundAux = classifyRequests(readRecorded().slice(recordBefore.length)).aux;
    auxRequestCounts.title += roundAux.title;
    auxRequestCounts.guardian += roundAux.guardian;
    const receipt: Record<string, unknown> = {
        round: roundIndex,
        kind,
        pass: !error,
        error,
        stopReason,
        ms: Date.now() - started,
        httpDelta: (after.httpTotal as number) - (before.httpTotal as number),
        auxRequestCounts,
        openSockets: after.openSockets,
        metricsBefore,
        metricsAfter,
    };
    if (verifiedImage !== undefined) receipt["verifiedImage"] = verifiedImage;
    if (groundTruthColor !== undefined) receipt["groundTruthColor"] = groundTruthColor;
    if (postCancelMainRequests !== undefined) receipt["postCancelMainRequests"] = postCancelMainRequests;
    return receipt;
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
                        env: [
                            { name: "SHOT_TAKE_MS", value: SHOT_TAKE_MS },
                            { name: "SHOT_TRUTH_PATH", value: SHOT_TRUTH_PATH },
                        ],
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
                                    env: [
                                        { name: "SHOT_TAKE_MS", value: SHOT_TAKE_MS },
                                        { name: "SHOT_TRUTH_PATH", value: SHOT_TRUTH_PATH },
                                    ],
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
            const extra = receipt["kind"] === "tool-image"
                ? ` verified=${receipt["verifiedImage"] ? "yes" : "NO"} color=${receipt["groundTruthColor"] ?? "?"}`
                : "";
            log(`round ${index} ${kind}: ${receipt.error ? "FAIL " + receipt.error : `pass (${receipt.ms}ms, http+${receipt.httpDelta})${extra}`}`);
            if (receipt.error) failures.push(`round ${index} ${kind}: ${String(receipt.error)}`);
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
        const verifiedImageRounds = results.filter((r) => r["kind"] === "tool-image" && r["verifiedImage"] === true).length;
        if (verifiedImageRounds < MIN_VERIFIED_IMAGE_ROUNDS_PER_WIRE) {
            failures.push(
                `verified tool-image rounds ${verifiedImageRounds} < required ${MIN_VERIFIED_IMAGE_ROUNDS_PER_WIRE} for wire ${VAL_WIRE} (3 wires x 4 = 12 total)`,
            );
        }
        const auxTotals = results.reduce(
            (acc: AuxCounts, r) => {
                const aux = r["auxRequestCounts"] as AuxCounts | undefined;
                if (aux) {
                    acc.title += aux.title;
                    acc.guardian += aux.guardian;
                }
                return acc;
            },
            { title: 0, guardian: 0 },
        );
        const artifact = {
            codexPath: CODEX_PATH,
            codexSha256: sha256,
            valWire: VAL_WIRE,
            roundTable: ROUND_TABLE,
            roundsPlanned: ROUND_TABLE.length,
            roundsRun: results.length,
            roundsPassed: results.filter((r) => r.pass).length,
            cancels: results.filter((r) => r.kind?.startsWith("cancel")).length,
            toolImageRounds: results.filter((r) => r.kind === "tool-image").length,
            verifiedImageRounds,
            minVerifiedImageRoundsPerWire: MIN_VERIFIED_IMAGE_ROUNDS_PER_WIRE,
            compactions: results.filter((r) => r.kind === "compact").length,
            coldRestarts: results.filter((r) => r.kind === "cold-restart").length,
            auxRequestTotals: auxTotals,
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
            `summary: ${artifact.roundsPassed}/${artifact.roundsRun} rounds passed (cancels=${artifact.cancels} toolImage=${artifact.toolImageRounds} verifiedImage=${artifact.verifiedImageRounds} compact=${artifact.compactions} cold=${artifact.coldRestarts} auxRequests=${JSON.stringify(auxTotals)}); mockOpenSocketsAfter=${stats.openSockets}; shutdown=${shutdownMs}ms`,
        );
        process.exit(failures.length > 0 ? 1 : 0);
    }
}

void main();
