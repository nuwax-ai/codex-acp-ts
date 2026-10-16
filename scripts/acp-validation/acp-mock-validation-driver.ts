/**
 * Credential-free ACP dev integration validation against a codex binary.
 *
 * Archival, re-runnable version of the one-off tmp/ driver: the vendor is a
 * local mock (scripts/acp-validation/mock-vendor-server.mjs) that records
 * every HTTP request, so each scenario gets a machine-checked assertion over
 * the actual wire bytes instead of trusting a paid vendor's behaviour. No
 * .env values, real accounts, or real screenshots are involved; the API key
 * is a dummy value this driver sets itself and the assertions only ever see
 * that dummy.
 *
 * Scenarios (see scenarios.json for the machine-readable table; each runs on
 * three wires — chat, responses, anthropic — selected via VAL_WIRE):
 *   S1 session bootstrap with an MCP screenshot server
 *   S2 env passthrough: the named env var reaches the model HTTP request
 *      with the wire's auth scheme (Bearer on chat/responses, x-api-key on
 *      anthropic) and a full turn completes; the automatic title request
 *      must use the active model id
 *   S3 screenshot delivery: the MCP image tool's output reaches the next
 *      model request as typed image content, not mangled text
 *   S4 cancel: session/cancel mid-stream resolves with stopReason cancelled
 *   S5 compaction: /compact then a continuation turn on the same session
 *   S6 cold resume: kill the agent, session/load on a fresh process, and the
 *      recall answer must be backed by the token actually being present in
 *      the resumed request history (the mock only echoes what it received)
 *
 * Run via scripts/acp-validation/run-acp-mock-validation.sh (validates the
 * binary hash receipt, starts the mock, sets the dummy key). Real-vendor
 * vision validation stays a separately authorized paid run and is NOT
 * covered here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
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
    if (!value) throw new Error(`missing ${name}; use run-acp-mock-validation.sh`);
    return value;
}
const CODEX_PATH = requiredEnv("CODEX_PATH");
const VAL_MODEL = process.env["VAL_MODEL"] ?? "acp-val-mock-model";
const VAL_BASE_URL = requiredEnv("VAL_BASE_URL");
const VAL_ENV_KEY = process.env["VAL_ENV_KEY"] ?? "ACP_VAL_MOCK_API_KEY";
const VAL_ENV_VALUE = requiredEnv(VAL_ENV_KEY);
const MOCK_RECORD_PATH = requiredEnv("MOCK_RECORD_PATH");
const VAL_WIRE = process.env["VAL_WIRE"] ?? "chat";

const SESSION_TOKEN = "ACP-COLD-42";
const RED_PNG_PREFIX = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHe";

// The runner owns the artifact root (VAL_ROOT) so orchestrators can collect
// per-wire results.json artifacts; standalone runs get their own temp dir.
const rootDir = process.env["VAL_ROOT"] ?? fs.mkdtempSync(path.join(os.tmpdir(), "acp-val-mock-"));
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
        `name = "ACP validation mock vendor"`,
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
    auth: string | null;
    /** x-api-key as sent on the anthropic wire (null elsewhere). */
    xApi?: string | null;
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
/** The wire's credential assertion: Bearer on chat/responses, the raw key in
 * x-api-key on anthropic (the bridge translates bearer -> x-api-key). */
function authOkForWire(request: RecordedRequest): boolean {
    if (VAL_WIRE === "anthropic") return request.xApi === VAL_ENV_VALUE;
    return request.auth === `Bearer ${VAL_ENV_VALUE}`;
}
/** Find the synthetic red PNG in a request as a TYPED image part of the
 * wire's native shape (image_url / input_image / image+base64 source). */
function typedImageInRequest(request: RecordedRequest): boolean {
    let parsed: any;
    try {
        parsed = JSON.parse(request.body);
    } catch {
        return false;
    }
    const isImagePart = (part: any): boolean => {
        if (!part || typeof part !== "object") return false;
        if (VAL_WIRE === "anthropic") {
            return part["type"] === "image" && String(part["source"]?.["data"] ?? "").includes(RED_PNG_PREFIX);
        }
        if (VAL_WIRE === "responses") {
            return part["type"] === "input_image" && String(part["image_url"] ?? "").includes(RED_PNG_PREFIX);
        }
        return part["type"] === "image_url" && String(part["image_url"]?.["url"] ?? "").includes(RED_PNG_PREFIX);
    };
    const containers: any[] = Array.isArray(parsed?.messages) ? parsed.messages : Array.isArray(parsed?.input) ? parsed.input : [];
    for (const message of containers) {
        const content = message?.["content"];
        if (Array.isArray(content) && content.some(isImagePart)) return true;
    }
    return false;
}

const results: Array<{ step: string; pass: boolean; detail: string }> = [];
const log = (line: string) => {
    console.log(`[${new Date().toISOString()}] ${line}`);
};
const record = (step: string, pass: boolean, detail: string) => {
    results.push({ step, pass, detail });
    log(`RESULT ${step}: ${pass ? "PASS" : "FAIL"} — ${detail}`);
};

interface TurnTrace {
    stopReason?: string;
    text: string;
    toolCalls: string[];
    completedTools: string[];
    toolNames: Map<string, string>;
    updateKinds: Set<string>;
    compactionUpdates: number;
}
const newTrace = (): TurnTrace => ({ text: "", toolCalls: [], completedTools: [], toolNames: new Map(), updateKinds: new Set(), compactionUpdates: 0 });

let trace = newTrace();

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

interface AgentHandle {
    child: ChildProcess;
    agent: ReturnType<ReturnType<typeof acpClient>["connect"]>["agent"];
}

function startAgent(): AgentHandle {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: REPO,
        env: {
            ...process.env,
            CODEX_HOME: codexHome,
            APP_SERVER_LOGS: logsDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stderrTail: string[] = [];
    child.stderr?.on("data", (d: Buffer) => {
        stderrTail = [...stderrTail, ...d.toString().split("\n")].slice(-30);
    });
    (child as unknown as { stderrTail: () => string }).stderrTail = () => stderrTail.join("\n");
    child.stdin?.on("error", () => {});

    const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = acpClient({ name: "acp-validation" })
        .onNotification(methods.client.session.update, (ctx: any) => {
            const update = ctx.params?.update;
            if (!update) return;
            trace.updateKinds.add(update.sessionUpdate);
            if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
                trace.text += update.content.text;
            }
            if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
                if (update.title) trace.toolNames.set(update.toolCallId, update.title);
                const name = update.title ?? trace.toolNames.get(update.toolCallId) ?? update.toolCallId ?? "tool";
                trace.toolCalls.push(name);
                if (update.status === "completed") {
                    trace.completedTools.push(name);
                }
            }
            if (update.sessionUpdate === "compaction_update") {
                trace.compactionUpdates += 1;
            }
        })
        .onRequest(methods.client.session.requestPermission, (ctx: any) => {
            const options = ctx.params?.options ?? [];
            const allow = options.find((o: any) => o.kind === "allow_once") ?? options[0];
            log(`permission request (${ctx.params?.toolCall?.kind ?? "?"}) -> ${allow?.optionId ?? "none"}`);
            return allow
                ? { outcome: { outcome: "selected", optionId: allow.optionId } }
                : { outcome: { outcome: "cancelled" } };
        })
        .onRequest(methods.client.fs.readTextFile, () => ({ content: "" }))
        .onRequest(methods.client.fs.writeTextFile, () => ({}))
        .connect(stream);
    return { child, agent: connection.agent };
}

async function prompt(handle: AgentHandle, sessionId: string, text: string, timeoutMs = 120_000) {
    trace = newTrace();
    const response = await withTimeout(
        handle.agent.request(methods.agent.session.prompt as any, {
            sessionId,
            prompt: [{ type: "text", text }],
        }),
        timeoutMs,
        `prompt(${text.slice(0, 40)}…)`,
    );
    return { response: response as any, trace };
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
        }, 3000).unref();
    });
}

async function main() {
    const binary = fs.readFileSync(CODEX_PATH);
    const sha256 = crypto.createHash("sha256").update(binary).digest("hex");
    log(`validation root: ${rootDir}`);
    log(`codex: ${CODEX_PATH} sha256=${sha256} model=${VAL_MODEL} wire=${VAL_WIRE} env_key=${VAL_ENV_KEY} base_url=${VAL_BASE_URL}`);
    let handle: AgentHandle | undefined;
    let sessionId: string | undefined;
    let recordedBefore = 0;
    const attempts = (from: number) => {
        const all = readRecorded();
        return { total: all.length, delta: all.slice(from), all };
    };
    try {
        // ---- S1 bootstrap -------------------------------------------------
        handle = startAgent();
        const init = await withTimeout(
            handle.agent.request(methods.agent.initialize as any, {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {
                    fs: { readTextFile: true, writeTextFile: true },
                    terminal: false,
                    session: { compaction: {} },
                },
            }),
            30_000,
            "initialize",
        );
        log(`agent: ${(init as any).agentInfo?.name ?? "?"} v${(init as any).agentInfo?.version ?? "?"}`);
        const session = await withTimeout(
            handle.agent.request(methods.agent.session.new as any, {
                cwd: workspace,
                mcpServers: [
                    {
                        type: "stdio",
                        name: "screenshots",
                        command: process.execPath,
                        args: [path.join(REPO, "scripts", "acp-validation", "shot-server.mjs")],
                        env: [],
                        cwd: workspace,
                    },
                ],
            }),
            60_000,
            "session/new",
        );
        const createdSessionId = (session as { sessionId?: string }).sessionId;
        if (!createdSessionId) throw new Error("session/new returned no sessionId");
        sessionId = createdSessionId;
        record("S1 bootstrap", Boolean(sessionId), `session ${sessionId}`);

        // ---- S2 env passthrough + first turn --------------------------------
        recordedBefore = readRecorded().length;
        const s2 = await prompt(
            handle,
            sessionId,
            `Remember the token ${SESSION_TOKEN} for later. Now reply with exactly the single word: pong`,
        );
        // Automatic title generation is a second real model request. A
        // custom provider must never receive the built-in Luna model id.
        for (let attempt = 0; attempt < 50; attempt += 1) {
            if (attempts(recordedBefore).delta.some((r) => r.kind === "title")) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const s2rec = attempts(recordedBefore);
        const titleModelOk = s2rec.delta.some((r) =>
            r.kind === "title" && authOkForWire(r) &&
            JSON.parse(r.body)["model"] === VAL_MODEL);
        const mainRequests = s2rec.delta.filter((r) => r.kind === "ping");
        const authOk = mainRequests.some(authOkForWire);
        const modelOk = mainRequests.some((r) => {
            try {
                return JSON.parse(r.body)["model"] === VAL_MODEL;
            } catch {
                return false;
            }
        });
        const s2ok = s2.response?.stopReason === "end_turn" && /pong/i.test(s2.trace.text) && authOk && modelOk && titleModelOk && s2rec.delta.length > 0;
        record(
            "S2 env passthrough + first turn",
            s2ok,
            `stop=${s2.response?.stopReason} authOk=${authOk} modelOk=${modelOk} titleModelOk=${titleModelOk} httpAttempts=${s2rec.delta.length} text="${s2.trace.text.slice(0, 60).replace(/\s+/g, " ")}"`,
        );

        // ---- S3 screenshot typed-image delivery ------------------------------
        // A real vendor takes seconds to answer, which gives the stdio MCP
        // server time to finish registering its tools; the mock answers in
        // milliseconds, so give registration a moment before asking for the
        // tool (the mock caps re-requests either way).
        await new Promise((r) => setTimeout(r, 4000));
        recordedBefore = readRecorded().length;
        const s3 = await prompt(
            handle,
            sessionId,
            "Call the take_screenshot tool exactly once, then reply with ONLY the dominant color word of the captured image.",
        );
        const s3rec = attempts(recordedBefore);
        const toolCompleted = s3.trace.completedTools.some((t) => /screenshot/i.test(t));
        // The follow-up model request must carry the PNG as typed image
        // content in the wire's native shape, not as flattened text.
        const imageDelivered = s3rec.delta.some(typedImageInRequest);
        const s3ok = s3.response?.stopReason === "end_turn" && toolCompleted && imageDelivered && s3rec.delta.length > 0;
        record(
            "S3 screenshot typed-image delivery",
            s3ok,
            `stop=${s3.response?.stopReason} toolCompleted=${toolCompleted} imageDelivered=${imageDelivered} httpAttempts=${s3rec.delta.length} answer="${s3.trace.text.trim().slice(0, 40)}"`,
        );

        // ---- S4 cancel -------------------------------------------------------
        trace = newTrace();
        recordedBefore = readRecorded().length;
        const longPrompt = handle.agent
            .request(methods.agent.session.prompt as any, {
                sessionId,
                prompt: [
                    {
                        type: "text",
                        text: "Write a very detailed 3000-word essay about ocean currents. Do not summarize.",
                    },
                ],
            })
            .then((r) => r as any)
            .catch((e) => ({ error: String(e) }));
        const firstUpdate = new Promise<void>((resolve) => {
            const timer = setInterval(() => {
                if (trace.text.includes("essay paragraph")) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
            setTimeout(() => {
                clearInterval(timer);
                resolve();
            }, 20_000).unref();
        });
        await firstUpdate;
        await handle.agent.notify(methods.agent.session.cancel as any, { sessionId });
        const s4 = await withTimeout(longPrompt, 120_000, "cancelled prompt resolution");
        const essayRequests = attempts(recordedBefore).delta.filter((r) => r.kind === "essay");
        const s4ok = s4?.stopReason === "cancelled" && trace.text.includes("essay paragraph") && essayRequests.length > 0;
        record("S4 cancel", s4ok, `stop=${s4?.stopReason ?? s4?.error} essayRequests=${essayRequests.length}`);
        // Let any in-flight/retried vendor stream drain so the next turn
        // starts from a settled session.
        await new Promise((r) => setTimeout(r, 500));

        // ---- S5 compaction ---------------------------------------------------
        recordedBefore = readRecorded().length;
        const s5c = await prompt(handle, sessionId, "/compact", 60_000);
        const compactRequestSeen = attempts(recordedBefore).delta.some((r) =>
            r.kind === "compaction" && r.body.includes("CONTEXT CHECKPOINT COMPACTION"));
        const compacted = compactRequestSeen && s5c.response?.stopReason === "end_turn";
        const s5 = await prompt(handle, sessionId, "Reply with exactly: post-compact-ok");
        const s5ok = compacted && s5.response?.stopReason === "end_turn" && /post-compact-ok/i.test(s5.trace.text);
        record(
            "S5 compaction + continuation",
            s5ok,
            `compactRequestSeen=${compactRequestSeen} compactUpdates=${s5c.trace.compactionUpdates} compactStop=${s5c.response?.stopReason} followUp="${s5.trace.text.trim().slice(0, 40)}"`,
        );

        // ---- S6 cold resume ---------------------------------------------------
        await killAgent(handle);
        handle = startAgent();
        await withTimeout(
            handle.agent.request(methods.agent.initialize as any, {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {
                    fs: { readTextFile: true, writeTextFile: true },
                    terminal: false,
                    session: { compaction: {} },
                },
            }),
            30_000,
            "initialize (restart)",
        );
        await withTimeout(
            handle.agent.request((methods.agent.session as any).load ?? "session/load", {
                sessionId,
                cwd: workspace,
                mcpServers: [],
            }),
            60_000,
            "session/load",
        );
        recordedBefore = readRecorded().length;
        const s6 = await prompt(
            handle,
            sessionId,
            "What token did I ask you to remember at the very start of this session? Reply with just the token.",
        );
        const s6rec = attempts(recordedBefore);
        // The mock only answers with the token when the token is actually in
        // the request history, so a passing answer proves the persisted
        // rollout was really loaded by the fresh process.
        const tokenInResumedRequest = s6rec.delta.some((r) => r.body.includes(SESSION_TOKEN));
        const s6ok =
            s6.response?.stopReason === "end_turn" &&
            s6.trace.text.toUpperCase().includes(SESSION_TOKEN) &&
            tokenInResumedRequest;
        record(
            "S6 cold resume recall",
            s6ok,
            `stop=${s6.response?.stopReason} tokenInResumedRequest=${tokenInResumedRequest} recalled="${s6.trace.text.trim().slice(0, 40)}" httpAttempts=${s6rec.delta.length}`,
        );
    } catch (error) {
        record("driver", false, `unexpected: ${String(error)}`);
        if (handle) log(`agent stderr tail:\n${(handle.child as unknown as { stderrTail: () => string }).stderrTail?.() ?? ""}`);
    } finally {
        await killAgent(handle);
        const artifact = {
            codexPath: CODEX_PATH,
            codexSha256: sha256,
            valModel: VAL_MODEL,
            valBaseUrl: VAL_BASE_URL,
            valWire: VAL_WIRE,
            envKeyName: VAL_ENV_KEY,
            results,
        };
        fs.writeFileSync(path.join(rootDir, "results.json"), JSON.stringify(artifact, null, 2));
        log(`results artifact: ${path.join(rootDir, "results.json")} (mock record: ${MOCK_RECORD_PATH})`);
        const failed = results.filter((r) => !r.pass);
        log(`summary: ${results.filter((r) => r.pass).length}/${results.length} steps passed; total model HTTP requests: ${readRecorded().length}`);
        process.exit(failed.length > 0 ? 1 : 0);
    }
}

void main();
