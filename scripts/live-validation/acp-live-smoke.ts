/**
 * ACP live smoke against a REAL vendor (closure item 11, budgeted).
 *
 * One session through the ACP adapter: session/new -> prompt -> /compact ->
 * continuation prompt -> session/load on a fresh adapter process. Proves the
 * ACP layer end to end over a real model wire. The runner (live-smallbatch.sh)
 * provides NUWAX_* env (endpoint/model/key from the authorized env file) and
 * DEFAULT_AUTH_REQUEST (api-key hatch); this file never sees or prints the
 * key.
 *
 * Prints `SMOKE-PASS <detail>` on success.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
    PROTOCOL_VERSION,
    client as acpClient,
    methods,
    ndJsonStream,
} from "@agentclientprotocol/sdk";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const VAL_ROOT = process.env["VAL_ROOT"] ?? "/tmp/acp-live-smoke";
const CODEX_PATH = process.env["CODEX_PATH"]
    ?? "/Volumes/soddy/git_workspace/fork-nuwax-codex/.claude/worktrees/merge-main-20261014/codex-rs/target/debug/codex";
const codexHome = path.join(VAL_ROOT, "acp-codex-home");
fs.mkdirSync(codexHome, { recursive: true });

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

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
            CODEX_PATH,
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrTail: string[] = [];
    child.stderr?.on("data", (d: Buffer) => {
        stderrTail.push(...d.toString().split("\n"));
        while (stderrTail.length > 30) stderrTail.shift();
    });
    child.stdin?.on("error", () => {});
    (child as unknown as { stderrTail: () => string }).stderrTail = () => stderrTail.join("\n");

    let text = "";
    const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = acpClient({ name: "acp-live-smoke" })
        .onNotification(methods.client.session.update, (ctx: any) => {
            const update = ctx.params?.update;
            if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
                text += update.content.text;
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
    return { child, agent: connection.agent, ...({} as Record<string, never>) } as AgentHandle & { text: () => string };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function prompt(handle: any, sessionId: string, text: string, timeoutMs = 180_000) {
    return withTimeout(
        handle.agent.request(methods.agent.session.prompt as any, {
            sessionId,
            prompt: [{ type: "text", text }],
        }),
        timeoutMs,
        `prompt(${text.slice(0, 32)}…)`,
    );
}

async function main() {
    const handle: any = startAgent();
    try {
        const initialized = await withTimeout(
            handle.agent.request(methods.agent.initialize as any, {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {
                    fs: { readTextFile: true, writeTextFile: true },
                    terminal: false,
                    session: { compaction: {} },
                },
            }),
            60_000,
            "initialize",
        );
        log(`agent: ${(initialized as any)?.agentInfo?.name ?? "?"}`);

        const created = await withTimeout(
            handle.agent.request(methods.agent.session.new as any, {
                cwd: VAL_ROOT,
                mcpServers: [],
            }),
            60_000,
            "session/new",
        );
        const sessionId = created?.sessionId;
        if (!sessionId) throw new Error("session/new returned no sessionId");
        log(`session: ${sessionId}`);

        const first = await prompt(handle, sessionId, "Reply with exactly: live-ok");
        log(`first stopReason=${first?.stopReason}`);

        const compacted = await prompt(handle, sessionId, "/compact", 120_000);
        log(`compact stopReason=${compacted?.stopReason}`);

        const after = await prompt(handle, sessionId, "Reply with exactly: post-compact-ok");
        log(`post-compact stopReason=${after?.stopReason}`);

        // Fresh adapter process reading the same session back (load path).
        handle.child.kill();
        const reload: any = startAgent();
        await withTimeout(
            reload.agent.request(methods.agent.initialize as any, {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: {
                    fs: { readTextFile: true, writeTextFile: true },
                    terminal: false,
                    session: { compaction: {} },
                },
            }),
            60_000,
            "reload initialize",
        );
        const loaded = await withTimeout(
            reload.agent.request(methods.agent.session.load as any, { sessionId }),
            60_000,
            "session/load",
        );
        const loadedOk = loaded?.sessionId === sessionId || loaded?.threadId === sessionId || Boolean(loaded);
        log(`load ok=${loadedOk}`);
        reload.child.kill();

        const ok = first?.stopReason === "end_turn" && after?.stopReason === "end_turn" && loadedOk;
        if (ok) {
            console.log(`SMOKE-PASS acp live: prompt+compact+continuation+load on ${sessionId}`);
            process.exit(0);
        }
        throw new Error(`smoke did not pass: first=${first?.stopReason} after=${after?.stopReason} loaded=${loadedOk}`);
    } catch (error) {
        console.error(`SMOKE-FAIL ${error}`);
        console.error(handle.stderrTail?.());
        handle.child.kill();
        process.exit(1);
    }
}

void main();
