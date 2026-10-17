/**
 * ACP live cancel against a REAL vendor: prompt a long generation, wait for
 * the first streamed agent_message_chunk, then session/cancel and require
 * stopReason=cancelled. Mirrors the mock driver's S4 on a real wire.
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
const VAL_ROOT = process.env["VAL_ROOT"] ?? "/tmp/acp-live-cancel";
const CODEX_PATH = process.env["CODEX_PATH"]
    ?? "/Volumes/soddy/git_workspace/fork-nuwax-codex/.claude/worktrees/merge-main-20261014/codex-rs/target/debug/codex";
const codexHome = path.join(VAL_ROOT, "cancel-codex-home");
fs.mkdirSync(codexHome, { recursive: true });
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function main() {
    const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: REPO,
        env: { ...process.env, CODEX_HOME: codexHome, CODEX_PATH },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrTail: string[] = [];
    child.stderr?.on("data", (d: Buffer) => {
        stderrTail.push(...d.toString().split("\n"));
        while (stderrTail.length > 30) stderrTail.shift();
    });
    child.stdin?.on("error", () => {});

    let sawDelta = false;
    const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = acpClient({ name: "acp-live-cancel" })
        .onNotification(methods.client.session.update, (ctx: any) => {
            const update = ctx.params?.update;
            if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
                sawDelta = true;
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
    const agent = connection.agent;

    try {
        await withTimeout(
            agent.request(methods.agent.initialize as any, {
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
        const session = await withTimeout(
            agent.request(methods.agent.session.new as any, { cwd: VAL_ROOT, mcpServers: [] }),
            60_000,
            "session/new",
        );
        const sessionId = (session as { sessionId?: string }).sessionId;
        if (!sessionId) throw new Error("no sessionId");

        const promptPromise = withTimeout(
            agent.request(methods.agent.session.prompt as any, {
                sessionId,
                prompt: [
                    {
                        type: "text",
                        text: "Write a detailed 1200-word essay about the history of lighthouses, with numbered sections.",
                    },
                ],
            }),
            180_000,
            "prompt",
        );
        const deadline = Date.now() + 90_000;
        while (!sawDelta && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!sawDelta) throw new Error("no streamed delta observed before cancel");
        log("delta observed; cancelling");
        // session/cancel is a notification (see the mock driver's S4).
        await agent.notify(methods.agent.session.cancel as any, { sessionId });
        const result = await promptPromise;
        const stop = (result as { stopReason?: string })?.stopReason;
        log(`stopReason=${stop}`);
        if (stop === "cancelled") {
            console.log("SMOKE-PASS acp live cancel: cancelled after a real streamed delta");
            child.kill();
            process.exit(0);
        }
        throw new Error(`unexpected stopReason ${stop}`);
    } catch (error) {
        console.error(`SMOKE-FAIL ${error}`);
        console.error(stderrTail.join("\n"));
        child.kill();
        process.exit(1);
    }
}

void main();
