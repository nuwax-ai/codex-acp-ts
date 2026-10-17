/**
 * Restored usage_update numerical validation against the real app-server
 * (review follow-up: the live smoke only proved prompt/compact/continuation/
 * cold-load RPC success; the restored usage path was covered by product
 * unit tests alone).
 *
 * Two flows, both against a real codex CLI + app-server and the mock vendor
 * (chat wire, deterministic usage: input 4 / output 1 per turn):
 *   A. same-process reload — session/load on the SAME adapter process must
 *      publish a restored usage_update whose numbers match the snapshot
 *      taken before the load, and the next prompt must keep receiving
 *      per-turn usage_update values.
 *   B. fresh-process load — kill the adapter, start a new one, session/load
 *      must again restore the snapshot and continue receiving the next
 *      turn's usage.
 *
 * Fails (exit 1) on any mismatch; prints a small receipt at the end.
 */
import { spawn } from "node:child_process";
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
    if (!value) throw new Error(`missing ${name}; use the runner script`);
    return value;
}
const CODEX_PATH = requiredEnv("CODEX_PATH");
const VAL_BASE_URL = requiredEnv("VAL_BASE_URL");
const VAL_ENV_KEY = process.env["VAL_ENV_KEY"] ?? "ACP_VAL_MOCK_API_KEY";
const VAL_ENV_VALUE = requiredEnv(VAL_ENV_KEY);
const VAL_MODEL = process.env["VAL_MODEL"] ?? "acp-val-mock-model";

const rootDir = process.env["VAL_ROOT"] ?? fs.mkdtempSync(path.join(os.tmpdir(), "acp-restored-usage-"));
const codexHome = path.join(rootDir, "codex-home");
const workspace = path.join(rootDir, "workspace");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
        `model = "${VAL_MODEL}"`,
        `model_provider = "vendor"`,
        ``,
        `[model_providers.vendor]`,
        `name = "restored usage mock"`,
        `base_url = "${VAL_BASE_URL}"`,
        `env_key = "${VAL_ENV_KEY}"`,
        `wire_api = "chat"`,
        `request_max_retries = 1`,
        `stream_max_retries = 1`,
        `stream_idle_timeout_ms = 60000`,
        ``,
    ].join("\n"),
);

const failures: string[] = [];
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

interface UsageUpdate { used: number; size: number }
const pendingUsage: UsageUpdate[] = [];
function drainUsage(max: number, timeoutMs: number): Promise<UsageUpdate[]> {
    const collected: UsageUpdate[] = [];
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
            while (pendingUsage.length > 0 && collected.length < max) {
                collected.push(pendingUsage.shift()!);
            }
            if (collected.length >= max) return resolve(collected);
            if (Date.now() - started > timeoutMs) return resolve(collected);
            setTimeout(tick, 50);
        };
        tick();
    });
}

interface AgentHandle {
    child: ReturnType<typeof spawn>;
    agent: ReturnType<ReturnType<typeof acpClient>["connect"]>["agent"];
}

function startAgent(): AgentHandle {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: REPO,
        env: {
            ...process.env,
            CODEX_HOME: codexHome,
            DEFAULT_AUTH_REQUEST: JSON.stringify({
                methodId: "api-key",
                _meta: { "api-key": { apiKey: VAL_ENV_VALUE } },
            }),
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin?.on("error", () => {});
    const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = acpClient({ name: "acp-restored-usage" })
        .onNotification(methods.client.session.update, (ctx: any) => {
            const update = ctx.params?.update;
            if (update?.sessionUpdate === "usage_update") {
                pendingUsage.push({ used: update.used, size: update.size });
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

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function stopAgent(handle: AgentHandle): Promise<void> {
    handle.child.kill("SIGKILL");
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        handle.child.once("exit", () => {
            clearTimeout(timer);
            resolve(null);
        });
    });
}

async function main() {
    const mockShas = await fetchStats();
    log(`codex ${CODEX_PATH} mock requests at start: ${mockShas?.requests ?? "?"}`);

    // --- Flow setup: one session, one prompt, capture usage numbers.
    let handle = startAgent();
    await withTimeout(
        handle.agent.request(methods.agent.initialize as any, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, session: { compaction: {} } },
        }),
        30_000,
        "initialize",
    );
    const newSession = await withTimeout(
        handle.agent.request(methods.agent.session.new as any, {
            cwd: workspace,
            mcpServers: [],
        }),
        30_000,
        "session/new",
    ) as any;
    const sessionId = newSession.sessionId as string;
    log(`session ${sessionId}`);

    pendingUsage.length = 0;
    const first = await withTimeout(
        handle.agent.request(methods.agent.session.prompt as any, {
            sessionId,
            prompt: [{ type: "text", text: "Reply with exactly the single word: pong" }],
        }),
        120_000,
        "first prompt",
    ) as any;
    if (first?.stopReason !== "end_turn") {
        throw new Error(`first prompt stopReason=${first?.stopReason ?? first?.error}`);
    }
    const turnUsage = await drainUsage(/*max*/ 1, 10_000);
    if (turnUsage.length === 0) failures.push("no usage_update observed for the first turn");
    const snapshot = turnUsage[0];
    log(`turn usage: used=${snapshot?.used} size=${snapshot?.size}`);
    if (snapshot && !(snapshot.used > 0 && snapshot.size > 0)) {
        failures.push(`usage_update numbers not positive: ${JSON.stringify(snapshot)}`);
    }

    // --- Flow A: same-process reload.
    pendingUsage.length = 0;
    await withTimeout(
        handle.agent.request((methods.agent.session as any).load ?? "session/load", {
            sessionId,
            cwd: workspace,
            mcpServers: [],
        }),
        60_000,
        "session/load (same process)",
    );
    const restoredSame = await drainUsage(1, 15_000);
    const restored = restoredSame[0];
    log(`same-process restored usage: used=${restored?.used} size=${restored?.size}`);
    if (!restored) {
        failures.push("same-process load published no restored usage_update");
    } else {
        if (restored.used !== snapshot?.used) {
            failures.push(`same-process restored used ${restored.used} != snapshot ${snapshot?.used}`);
        }
        if (restored.size !== snapshot?.size) {
            failures.push(`same-process restored size ${restored.size} != snapshot ${snapshot?.size}`);
        }
    }
    pendingUsage.length = 0;
    const second = await withTimeout(
        handle.agent.request(methods.agent.session.prompt as any, {
            sessionId,
            prompt: [{ type: "text", text: "Reply with exactly the single word: pong" }],
        }),
        120_000,
        "post-reload prompt",
    ) as any;
    if (second?.stopReason !== "end_turn") {
        failures.push(`post-reload prompt stopReason=${second?.stopReason ?? second?.error}`);
    }
    const postReloadUsage = await drainUsage(1, 10_000);
    if (postReloadUsage.length === 0) {
        failures.push("no usage_update after the post-reload prompt (stream did not continue)");
    } else {
        log(`post-reload turn usage: used=${postReloadUsage[0].used}`);
    }

    // --- Flow B: fresh-process load.
    await stopAgent(handle);
    handle = startAgent();
    await withTimeout(
        handle.agent.request(methods.agent.initialize as any, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, session: { compaction: {} } },
        }),
        30_000,
        "initialize (fresh process)",
    );
    pendingUsage.length = 0;
    await withTimeout(
        handle.agent.request((methods.agent.session as any).load ?? "session/load", {
            sessionId,
            cwd: workspace,
            mcpServers: [],
        }),
        60_000,
        "session/load (fresh process)",
    );
    const restoredFresh = await drainUsage(1, 15_000);
    const fresh = restoredFresh[0];
    log(`fresh-process restored usage: used=${fresh?.used} size=${fresh?.size}`);
    if (!fresh) {
        failures.push("fresh-process load published no restored usage_update");
    } else {
        if (fresh.used !== snapshot?.used) {
            failures.push(`fresh-process restored used ${fresh.used} != snapshot ${snapshot?.used}`);
        }
        if (fresh.size !== snapshot?.size) {
            failures.push(`fresh-process restored size ${fresh.size} != snapshot ${snapshot?.size}`);
        }
    }
    pendingUsage.length = 0;
    const third = await withTimeout(
        handle.agent.request(methods.agent.session.prompt as any, {
            sessionId,
            prompt: [{ type: "text", text: "Reply with exactly the single word: pong" }],
        }),
        120_000,
        "fresh-process prompt",
    ) as any;
    if (third?.stopReason !== "end_turn") {
        failures.push(`fresh-process prompt stopReason=${third?.stopReason ?? third?.error}`);
    }
    const freshTurnUsage = await drainUsage(1, 10_000);
    if (freshTurnUsage.length === 0) {
        failures.push("no usage_update after the fresh-process prompt");
    } else {
        log(`fresh-process turn usage: used=${freshTurnUsage[0].used}`);
    }

    await stopAgent(handle);

    console.log(JSON.stringify({
        rootDir,
        snapshot,
        sameProcessRestored: restored ?? null,
        freshProcessRestored: fresh ?? null,
        failures,
    }, null, 2));
    if (failures.length > 0) {
        for (const failure of failures) log(`FAIL: ${failure}`);
        process.exit(1);
    }
    log("restored usage validation PASS");
}

async function fetchStats(): Promise<{ requests: number; openSockets: number } | null> {
    const statsUrl = process.env["MOCK_STATS_URL"];
    if (!statsUrl) return null;
    const url = new URL(statsUrl);
    return new Promise((resolve) => {
        const request = http.get(
            { host: url.hostname, port: url.port, path: url.pathname, agent: false },
            (response) => {
                if (response.statusCode !== 200) return resolve(null);
                let body = "";
                response.on("data", (chunk) => (body += chunk));
                response.on("end", () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch {
                        resolve(null);
                    }
                });
            },
        );
        request.on("error", () => resolve(null));
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
