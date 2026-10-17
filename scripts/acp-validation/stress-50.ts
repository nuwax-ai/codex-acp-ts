/**
 * 54-round offline stress validation for the ACP dev -> codex app-server ->
 * mock vendor main path (closure-plan item 7, hardened per review items 6
 * and 8).
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
 * Cancel stages prove their precondition before cancelling (review item 8):
 * before-headers waits until the mock has RECORDED the hang request (an
 * arrival signal — the hang kind never answers), mid-stream waits for an
 * actual stream delta, during-tool waits for the shot-server "start" truth
 * record (the tool subprocess really began). A precondition wait that
 * times out FAILS the round instead of silently cancelling. After each
 * cancel, no additional MAIN model request may arrive for that turn;
 * auxiliary requests (title/guardian, identified by their recorded kind)
 * are counted explicitly in auxRequestCounts instead of being silently
 * tolerated.
 *
 * Probes fail loudly (review item 8): a stats fetch error, a process
 * listing error or (on Linux) an unreadable /proc entry is recorded in
 * probeFailures and FAILS the run — never a silent -1 pass.
 * STRESS_SIMULATE_PROBE_FAILURE=stats|pgrep breaks a probe class on
 * purpose for the negative self-check (the run must then exit non-zero;
 * wired into run-stress.sh as an optional check, not run by default).
 *
 * Per-round process-tree receipts: the driver knows the ACP wrapper PID it
 * spawned; the real app-server child and any shot-server / code-mode host
 * descendants are resolved via `ps` and recorded WITH start times (lstart)
 * to guard against PID reuse. After each generation's shutdown (cold
 * restarts and the final shutdown) every tracked PID must be gone within
 * 10s, or the run FAILS listing the survivors. Nothing the driver did not
 * spawn is ever killed, and no whole-machine pgrep is used as the residue
 * check.
 *
 * Credential-free: dummy key, synthetic palette PNGs, local mock vendor.
 */
import { spawn, execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
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
/** Negative self-test: break one probe class on purpose; run must fail. */
const SIMULATE_PROBE_FAILURE = process.env["STRESS_SIMULATE_PROBE_FAILURE"] ?? "";

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
    wire?: string;
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

const results: RoundReceipt[] = [];
const failures: string[] = [];
/** Probe failures are run failures: an unavailable probe never passes. */
const probeFailures: string[] = [];
const probeFailuresSeen = new Set<string>();
function noteProbeFailure(message: string) {
    failures.push(`probe: ${message}`);
    if (!probeFailuresSeen.has(message)) {
        probeFailuresSeen.add(message);
        probeFailures.push(message);
    }
}
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

/** Stats probe. Errors (and the simulated failure) mark the run FAILED. */
function mockStats(): Promise<{ openSockets: number; requests: number }> {
    if (SIMULATE_PROBE_FAILURE === "stats") {
        noteProbeFailure("simulated stats probe failure (STRESS_SIMULATE_PROBE_FAILURE=stats)");
        return Promise.resolve({ openSockets: -1, requests: -1 });
    }
    // agent:false — a pooled keep-alive connection would itself show up in
    // the open-socket count and fake a leak.
    const url = new URL(MOCK_STATS_URL);
    return new Promise((resolve) => {
        let settled = false;
        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            noteProbeFailure(`stats fetch failed: ${String(error)}`);
            resolve({ openSockets: -1, requests: -1 });
        };
        const request = http.get(
            { host: url.hostname, port: url.port, path: url.pathname, agent: false },
            (response) => {
                if (response.statusCode !== 200) {
                    fail(`HTTP ${response.statusCode ?? "?"} from /stats`);
                    response.resume();
                    return;
                }
                let body = "";
                response.on("data", (chunk: string) => { body += chunk; });
                response.on("error", fail);
                response.on("end", () => {
                    if (settled) return;
                    try {
                        const parsed = JSON.parse(body) as { openSockets: number; requests: number };
                        settled = true;
                        resolve(parsed);
                    } catch (error) {
                        fail(error);
                    }
                });
            },
        );
        request.on("error", fail);
    });
}

// ---------------------------------------------------------------------------
// Process tree tracking (review item 8)
// ---------------------------------------------------------------------------

interface ProcEntry {
    ppid: number;
    lstart: string;
    command: string;
}
/** One `ps` listing of the whole process table. null = probe failure. */
function psTable(): Map<number, ProcEntry> | null {
    if (SIMULATE_PROBE_FAILURE === "pgrep") {
        noteProbeFailure("simulated process-listing probe failure (STRESS_SIMULATE_PROBE_FAILURE=pgrep)");
        return null;
    }
    try {
        const out = execSync("ps -axo pid=,ppid=,lstart=,command=", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        const table = new Map<number, ProcEntry>();
        for (const line of out.split("\n")) {
            if (!line.trim()) continue;
            const tokens = line.trim().split(/\s+/);
            const pid = Number(tokens[0]);
            const ppid = Number(tokens[1]);
            if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || tokens.length < 7) continue;
            // lstart is "Www Mmm [D]D HH:MM:SS YYYY" — 5 or 6 tokens
            // depending on the day-of-month padding. The command starts
            // right after the 4-digit year token.
            let yearAt = -1;
            for (let i = 2; i < Math.min(tokens.length, 9); i += 1) {
                if (/^\d{4}$/.test(tokens[i] ?? "")) { yearAt = i; break; }
            }
            if (yearAt < 0) continue; // wrapped command output, not a row
            table.set(pid, {
                ppid,
                lstart: tokens.slice(2, yearAt + 1).join(" "),
                command: tokens.slice(yearAt + 1).join(" "),
            });
        }
        if (table.size === 0) {
            noteProbeFailure("ps listing parsed to zero processes");
            return null;
        }
        return table;
    } catch (error) {
        noteProbeFailure(`process listing failed: ${String(error)}`);
        return null;
    }
}

/** All descendants of `root` (BFS over ppid edges). */
function descendantsOf(root: number, table: Map<number, ProcEntry>): number[] {
    const childrenOf = new Map<number, number[]>();
    for (const [pid, entry] of table) {
        const list = childrenOf.get(entry.ppid) ?? [];
        list.push(pid);
        childrenOf.set(entry.ppid, list);
    }
    const seen = new Set<number>();
    const frontier = [root];
    while (frontier.length > 0) {
        const current = frontier.pop();
        if (current === undefined) break;
        for (const child of childrenOf.get(current) ?? []) {
            if (!seen.has(child)) {
                seen.add(child);
                frontier.push(child);
            }
        }
    }
    return [...seen];
}

interface TrackedProc {
    pid: number;
    lstart: string;
    command: string;
    role: string;
}
interface AgentHandle {
    child: ChildProcess;
    agent: ReturnType<ReturnType<typeof acpClient>["connect"]>["agent"];
    /** PIDs ever seen under this wrapper generation (start-time keyed). */
    tracked: Map<number, TrackedProc>;
}

/** Snapshot the wrapper + its descendants, tagging known roles. */
function snapshotTree(handle: AgentHandle): TrackedProc[] {
    const pid = handle.child.pid;
    if (!pid) return [];
    const table = psTable();
    if (!table) return [];
    const out: TrackedProc[] = [];
    const self = table.get(pid);
    if (self) out.push({ pid, lstart: self.lstart, command: self.command, role: "acp-wrapper" });
    for (const descendant of descendantsOf(pid, table)) {
        const entry = table.get(descendant);
        if (!entry) continue;
        const role = /shot-server[.]mjs/.test(entry.command)
            ? "shot-server"
            : entry.command.includes("app-server") || entry.command.includes(CODEX_PATH)
                ? "app-server"
                : "descendant";
        out.push({ pid: descendant, lstart: entry.lstart, command: entry.command, role });
    }
    for (const proc of out) handle.tracked.set(proc.pid, proc);
    return out;
}

/** A tracked process survives only if its PID is still listed with the SAME
 * start time — a recycled PID with a different lstart counts as gone.
 *
 * Update-check helpers (`git ... ls-remote` against the plugins repo) are
 * bounded by the product's own 30s timeout (startup_sync.rs kills and waits
 * on expiry), so they get a window past that bound; on egress-filtered hosts
 * they visibly linger for up to 30s per app-server start. Everything else —
 * the serving stack — must drain within 10s. */
async function waitUntilGone(handle: AgentHandle): Promise<TrackedProc[]> {
    const isUpdateCheck = (proc: TrackedProc) =>
        proc.command.includes("github.com") || /\bgit\b/.test(proc.command);
    const SERVING_DEADLINE = Date.now() + 10_000;
    const UPDATE_CHECK_DEADLINE = Date.now() + 35_000;
    for (;;) {
        const table = psTable();
        const survivors = ([...handle.tracked.values()] as TrackedProc[]).filter((proc) => {
            const current = table?.get(proc.pid);
            return current !== undefined && current.lstart === proc.lstart;
        });
        if (survivors.length === 0) return [];
        const deadline = survivors.every(isUpdateCheck) ? UPDATE_CHECK_DEADLINE : SERVING_DEADLINE;
        if (Date.now() >= deadline) {
            if (survivors.every(isUpdateCheck)) {
                // Round-owned update-check orphans: when the app-server is
                // killed before its own 30s timeout fires, the git children
                // lose the only process that would kill them and can hang on
                // a black-holed network until the TCP stack gives up. They
                // belong to THIS round's tree, so reap them here instead of
                // waiting minutes.
                for (const proc of survivors) {
                    try {
                        process.kill(proc.pid, "SIGKILL");
                    } catch {
                        // already gone
                    }
                }
                await new Promise((r) => setTimeout(r, 1000));
                const table2 = psTable();
                const still = table2
                    ? survivors.filter((proc) => {
                        const current = table2.get(proc.pid);
                        return current !== undefined && current.lstart === proc.lstart;
                    })
                    : [];
                return still;
            }
            return survivors;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
}

async function killAgent(handle: AgentHandle | undefined): Promise<void> {
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

/** Kill a generation and assert its whole tracked tree drained. */
async function shutdownGeneration(handle: AgentHandle | undefined, label: string): Promise<TrackedProc[]> {
    if (!handle) return [];
    await killAgent(handle);
    const survivors = await waitUntilGone(handle);
    if (survivors.length > 0) {
        failures.push(
            `${label}: tracked process(es) still alive after shutdown: ${survivors
                .map((s) => `${s.pid}(${s.role}, started ${s.lstart}, ${s.command.slice(0, 80)})`)
                .join("; ")}`,
        );
    }
    return survivors;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
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

/** Best-effort RSS/FD metrics (Linux /proc; null elsewhere). */
function procMetrics(pid: number | undefined): { rssKb: number | null; fds: number | null } | null {
    if (!pid || process.platform !== "linux") return null;
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
        const rssKb = Number(status.match(/^VmRSS:\s+(\d+) kB/m)?.[1] ?? 0);
        let fds: number | null = null;
        try {
            fds = fs.readdirSync(`/proc/${pid}/fd`).length;
        } catch {
            fds = null;
        }
        return { rssKb: Number.isFinite(rssKb) ? rssKb : null, fds };
    } catch {
        // Unreadable /proc entry for a live pid is a probe failure, not a
        // silent null (a dead pid simply is not listed anymore).
        let alive = false;
        try {
            process.kill(pid, 0);
            alive = true;
        } catch {
            alive = false;
        }
        if (alive) noteProbeFailure(`/proc/${pid}/status unreadable while process is alive`);
        return null;
    }
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

interface RoundSnapshot {
    httpTotal: number;
    openSockets: number;
}
interface ColdRestartSurvivor {
    pid: number;
    role: string;
    lstart: string;
}
interface RoundReceipt {
    round: number;
    kind: RoundKind | string;
    pass: boolean;
    error: string | undefined;
    ms: number;
    httpDelta: number;
    openSockets: number;
    stopReason: unknown;
    verifiedImage: boolean | undefined;
    groundTruthColor: string | undefined;
    postCancelMainRequests: number | undefined;
    auxRequestCounts: AuxCounts | undefined;
    pidTree: TrackedProc[] | undefined;
    coldRestartSurvivors: ColdRestartSurvivor[] | undefined;
    metricsBefore: unknown;
    metricsAfter: unknown;
}

async function roundSnapshot(): Promise<RoundSnapshot> {
    const stats = await mockStats();
    return { httpTotal: readRecorded().length, openSockets: stats.openSockets };
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
    return { child, agent: connection.agent, tracked: new Map<number, TrackedProc>() };
}

function mcpServerConfig() {
    return [
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
    ];
}

async function runRound(
    handle: AgentHandle,
    sessionId: string,
    kind: RoundKind,
    roundIndex: number,
): Promise<RoundReceipt> {
    const started = Date.now();
    traceToolCalls = [];
    traceToolCompleted = [];
    traceText = "";
    const before = await roundSnapshot();
    const pidTree = snapshotTree(handle);
    const metricsBefore = { agent: procMetrics(handle.child.pid) };
    const recordBefore = readRecorded();
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
            const { main } = classifyRequests(readRecorded().slice(afterCancel));
            postCancelMainRequests = main.length;
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
            const { main } = classifyRequests(readRecorded().slice(afterCancel));
            postCancelMainRequests = main.length;
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
    const metricsAfter = { agent: procMetrics(handle.child.pid) };
    const { aux } = classifyRequests(readRecorded().slice(recordBefore.length));
    const receipt: RoundReceipt = {
        round: roundIndex,
        kind,
        pass: !error,
        error,
        stopReason,
        ms: Date.now() - started,
        httpDelta: after.httpTotal - before.httpTotal,
        auxRequestCounts: aux,
        openSockets: after.openSockets,
        pidTree,
        metricsBefore,
        metricsAfter,
        verifiedImage,
        groundTruthColor,
        postCancelMainRequests,
        coldRestartSurvivors: undefined,
    };
    return receipt;
}

async function main() {
    const binary = fs.readFileSync(CODEX_PATH);
    const sha256 = crypto.createHash("sha256").update(binary).digest("hex");
    log(`stress root: ${rootDir}`);
    log(`codex: ${CODEX_PATH} sha256=${sha256} wire=${VAL_WIRE}`);
    if (SIMULATE_PROBE_FAILURE) log(`NEGATIVE SELF-TEST: breaking '${SIMULATE_PROBE_FAILURE}' probes on purpose — this run MUST fail`);
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
                mcpServers: mcpServerConfig(),
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

        for (const [index, kind] of ROUND_TABLE.entries()) {
            if (kind === "cold-restart") {
                const started = Date.now();
                const before = await roundSnapshot();
                let error: string | undefined;
                // Kill this generation and assert its whole tracked tree
                // (app-server, shot-server, any other descendant) drained.
                const survivors = await shutdownGeneration(handle, `round ${index} cold-restart`);
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
                            mcpServers: mcpServerConfig(),
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
                if (survivors.length > 0) {
                    error = `${error ?? ""} [${survivors.length} tracked process(es) survived the restart kill]`.trimStart();
                }
                const after = await roundSnapshot();
                results.push({
                    round: index,
                    kind,
                    pass: !error,
                    error,
                    ms: Date.now() - started,
                    httpDelta: after.httpTotal - before.httpTotal,
                    openSockets: after.openSockets,
                    stopReason: undefined,
                    verifiedImage: undefined,
                    groundTruthColor: undefined,
                    postCancelMainRequests: undefined,
                    auxRequestCounts: undefined,
                    pidTree: undefined,
                    coldRestartSurvivors: survivors.map((s): ColdRestartSurvivor => ({ pid: s.pid, role: s.role, lstart: s.lstart })),
                    metricsBefore: undefined,
                    metricsAfter: undefined,
                });
                log(`round ${index} cold-restart: ${error ? "FAIL " + error : "pass"}`);
                if (error) failures.push(`round ${index} cold-restart: ${error}`);
                continue;
            }
            const receipt = await runRound(handle!, sessionId, kind, index);
            results.push(receipt);
            const extra = kind === "tool-image"
                ? ` verified=${receipt.verifiedImage ? "yes" : "NO"} color=${receipt.groundTruthColor ?? "?"}`
                : "";
            log(`round ${index} ${kind}: ${receipt.error ? "FAIL " + receipt.error : `pass (${receipt.ms}ms, http+${receipt.httpDelta})${extra}`}`);
            if (receipt.error) failures.push(`round ${index} ${kind}: ${receipt.error}`);
        }
    } catch (error) {
        failures.push(`driver: ${String(error)}`);
        if (handle) log(`agent stderr tail:\n${(handle.child as unknown as { stderrTail: () => string }).stderrTail?.() ?? ""}`);
    } finally {
        const shutdownStarted = Date.now();
        const finalSurvivors = await shutdownGeneration(handle, "final shutdown");
        const shutdownMs = Date.now() - shutdownStarted;
        await new Promise((r) => setTimeout(r, 1500));
        const stats = await mockStats();
        const leftoverShotServers = finalSurvivors.filter((s) => s.role === "shot-server").length;
        if (stats.openSockets > 0) failures.push(`mock still holds ${stats.openSockets} open sockets after shutdown`);
        if (shutdownMs > 15_000) failures.push(`app-server/agent took ${shutdownMs}ms to shut down`);
        if (leftoverShotServers > 0) failures.push(`${leftoverShotServers} shot-server processes still alive after shutdown`);
        const verifiedImageRounds = results.filter((r) => r.kind === "tool-image" && r.verifiedImage === true).length;
        if (verifiedImageRounds < MIN_VERIFIED_IMAGE_ROUNDS_PER_WIRE) {
            failures.push(
                `verified tool-image rounds ${verifiedImageRounds} < required ${MIN_VERIFIED_IMAGE_ROUNDS_PER_WIRE} for wire ${VAL_WIRE} (3 wires x 4 = 12 total)`,
            );
        }
        const auxTotals = results.reduce(
            (acc: AuxCounts, r) => {
                if (r.auxRequestCounts) {
                    acc.title += r.auxRequestCounts.title;
                    acc.guardian += r.auxRequestCounts.guardian;
                }
                return acc;
            },
            { title: 0, guardian: 0 },
        );
        const agentRss = results
            .map((r) => (r.metricsAfter as { agent?: { rssKb?: number | null } } | undefined)?.agent?.rssKb)
            .filter((v: unknown): v is number => typeof v === "number");
        const artifact = {
            codexPath: CODEX_PATH,
            codexSha256: sha256,
            valWire: VAL_WIRE,
            roundTable: ROUND_TABLE,
            roundsPlanned: ROUND_TABLE.length,
            roundsRun: results.length,
            roundsPassed: results.filter((r) => r.pass).length,
            cancels: results.filter((r) => r.kind.startsWith("cancel")).length,
            toolImageRounds: results.filter((r) => r.kind === "tool-image").length,
            verifiedImageRounds,
            minVerifiedImageRoundsPerWire: MIN_VERIFIED_IMAGE_ROUNDS_PER_WIRE,
            compactions: results.filter((r) => r.kind === "compact").length,
            coldRestarts: results.filter((r) => r.kind === "cold-restart").length,
            auxRequestTotals: auxTotals,
            probeFailures,
            shutdownMs,
            mockOpenSocketsAfter: stats.openSockets,
            leftoverShotServers,
            agentRssSeriesKb: agentRss,
            results,
            failures,
        };
        fs.writeFileSync(path.join(rootDir, "stress-results.json"), JSON.stringify(artifact, null, 2));
        log(`stress artifact: ${path.join(rootDir, "stress-results.json")}`);
        log(
            `summary: ${artifact.roundsPassed}/${artifact.roundsRun} rounds passed (cancels=${artifact.cancels} toolImage=${artifact.toolImageRounds} verifiedImage=${artifact.verifiedImageRounds} compact=${artifact.compactions} cold=${artifact.coldRestarts} auxRequests=${JSON.stringify(auxTotals)}); mockOpenSocketsAfter=${stats.openSockets}; shutdown=${shutdownMs}ms; probeFailures=${probeFailures.length}`,
        );
        process.exit(failures.length > 0 ? 1 : 0);
    }
}

void main();
