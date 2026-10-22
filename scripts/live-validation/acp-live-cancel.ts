/** Cancel a real streamed turn, continue the same session, and verify owned-process cleanup. */
import {spawn, type ChildProcess} from "node:child_process";
import {randomUUID} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {Readable, Writable} from "node:stream";
import {requireBudgetGateway} from "./gateway-contract.js";
import {FinalAssistantText} from "./assistant-text.js";
import {isModelDelta, processTable, rememberFamily, survivingFamily, type ProcessIdentity} from "./workflow-contracts.js";
import {PROTOCOL_VERSION, client as acpClient, methods, ndJsonStream} from "@agentclientprotocol/sdk";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function assertContinuation(result: {stopReason?: string}, text: string, nonce: string): void {
    if (result.stopReason !== "end_turn") throw new Error(`continuation did not complete: stopReason=${result.stopReason}`);
    if (text.trim() !== nonce) throw new Error("continuation did not return exactly the complete fresh nonce");
}

function snapshotFamily(child: ChildProcess, tracked: Map<number, ProcessIdentity>): Map<number, ProcessIdentity> {
    const table = processTable();
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null && !tracked.has(child.pid)) {
        rememberFamily(child.pid, table, tracked);
    }
    for (const entry of survivingFamily(tracked, table)) rememberFamily(entry.pid, table, tracked);
    return table;
}

/** Signals only sampled descendants, excluding identities whose PIDs have been recycled. */
export async function closeOwnedAgent(
    child: ChildProcess,
    tracked: Map<number, ProcessIdentity>,
    closeTransport: () => void,
    graceMs = 5000,
    killMs = 3000,
): Promise<void> {
    let firstFailure: unknown;
    let failed = false;
    const noteFailure = (error: unknown) => { if (!failed) { failed = true; firstFailure = error; } };
    try { snapshotFamily(child, tracked); } catch (error) { noteFailure(error); }
    try { closeTransport(); } catch (error) { noteFailure(error); }
    try { child.stdin?.end(); } catch (error) { noteFailure(error); }
    const signalFamily = (signal: NodeJS.Signals) => {
        try {
            const table = snapshotFamily(child, tracked);
            // The direct child also receives the signal through its handle
            // below; descendants are signalled before their parent exits.
            for (const survivor of survivingFamily(tracked, table).reverse()) {
                if (survivor.pid === child.pid) continue;
                try { process.kill(survivor.pid, signal); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") noteFailure(error); }
            }
        } catch (error) { noteFailure(error); }
        try {
            if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        } catch (error) { noteFailure(error); }
    };
    signalFamily("SIGTERM");
    const waitForExit = async (ms: number): Promise<boolean> => {
        const deadline = Date.now() + ms;
        do {
            const table = snapshotFamily(child, tracked);
            const parentExited = child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
            if (parentExited && survivingFamily(tracked, table).length === 0) return true;
            await delay(50);
        } while (Date.now() < deadline);
        return false;
    };
    let stopped = false;
    try { stopped = await waitForExit(graceMs); } catch (error) { noteFailure(error); }
    if (!stopped) {
        signalFamily("SIGKILL");
        try { stopped = await waitForExit(killMs); } catch (error) { noteFailure(error); }
    }
    if (!stopped) noteFailure(new Error("owned processes survived the bounded cleanup deadline"));
    if (failed) throw firstFailure;
}

async function main(): Promise<void> {
    const codexPath = process.env["CODEX_PATH"]?.trim();
    if (!codexPath) throw new Error("CODEX_PATH must explicitly name the Codex binary under test");
    await requireBudgetGateway();
    const valRoot = process.env["VAL_ROOT"] ?? "/tmp/acp-live-cancel";
    const codexHome = path.join(valRoot, "cancel-codex-home");
    fs.mkdirSync(codexHome, {recursive: true});
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: REPO,
        env: {...process.env, CODEX_HOME: codexHome, CODEX_PATH: codexPath},
        stdio: ["pipe", "pipe", "pipe"],
    });
    const tracked = new Map<number, ProcessIdentity>();
    let probeError: unknown;
    let probeFailed = false;
    const recordFamily = () => {
        try { snapshotFamily(child, tracked); }
        catch (error) { if (!probeFailed) { probeError = error; probeFailed = true; } }
    };
    recordFamily();
    const trackingTimer = setInterval(recordFamily, 250);
    const stderrTail: string[] = [];
    child.stderr?.on("data", (data: Buffer) => {
        stderrTail.push(...data.toString().split("\n"));
        while (stderrTail.length > 30) stderrTail.shift();
    });
    child.stdin?.on("error", () => {});
    const text = new FinalAssistantText();
    let sessionId: string | undefined;
    let sawDelta = false;
    const stream = ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = acpClient({name: "acp-live-cancel"})
        .onNotification(methods.client.session.update, (ctx: any) => {
            if (ctx.params?.sessionId !== sessionId || sessionId === undefined) return;
            const update = ctx.params.update;
            if (!update) return;
            text.add(update);
            sawDelta ||= isModelDelta(update);
        })
        .onRequest(methods.client.session.requestPermission, (ctx: any) => {
            const options = ctx.params?.options ?? [];
            const allow = options.find((option: any) => option.kind === "allow_once") ?? options[0];
            return allow ? {outcome: {outcome: "selected", optionId: allow.optionId}} : {outcome: {outcome: "cancelled"}};
        })
        .onRequest(methods.client.fs.readTextFile, () => ({content: ""}))
        .onRequest(methods.client.fs.writeTextFile, () => ({}))
        .connect(stream);
    const agent = connection.agent;
    let firstFailure: unknown;
    let failed = false;
    try {
        await withTimeout(agent.request(methods.agent.initialize as any, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {fs: {readTextFile: true, writeTextFile: true}, terminal: false, session: {compaction: {}}},
        }), 60_000, "initialize");
        const session = await withTimeout(agent.request(methods.agent.session.new as any, {cwd: valRoot, mcpServers: []}), 60_000, "session/new");
        sessionId = (session as {sessionId?: string}).sessionId;
        if (!sessionId) throw new Error("no sessionId");
        let promptFinished = false;
        const promptPromise = withTimeout(agent.request(methods.agent.session.prompt as any, {
            sessionId,
            prompt: [{type: "text", text: "Write a detailed 1200-word essay about the history of lighthouses, with numbered sections."}],
        }), 180_000, "cancel prompt").finally(() => { promptFinished = true; });
        // Observe rejection while waiting for a delta; rethrow that same failure below.
        void promptPromise.catch(() => {});
        const deadline = Date.now() + 90_000;
        while (!sawDelta && !promptFinished && Date.now() < deadline) await delay(100);
        if (promptFinished) {
            await promptPromise;
            throw new Error("generation completed before a mid-stream cancellation could be observed");
        }
        if (!sawDelta) throw new Error("no identified streamed delta observed before cancel");
        log("delta observed; cancelling");
        await withTimeout(agent.notify(methods.agent.session.cancel as any, {sessionId}), 5000, "session/cancel notification");
        const result = await promptPromise as {stopReason?: string};
        if (result.stopReason !== "cancelled") throw new Error(`unexpected cancel stopReason ${result.stopReason}`);
        log("cancelled after a real streamed delta");
        const nonce = `ACP_CONTINUE_${randomUUID().replaceAll("-", "")}`;
        text.reset();
        sawDelta = false;
        const continued = await withTimeout(agent.request(methods.agent.session.prompt as any, {
            sessionId,
            prompt: [{type: "text", text: `Reply with exactly this token and nothing else: ${nonce}`}],
        }), 90_000, "same-session continuation") as {stopReason?: string};
        assertContinuation(continued, text.text(), nonce);
        if (probeFailed) throw probeError;
        console.log("CONTINUATION-PASS same session returned the complete fresh nonce after cancel");
    } catch (error) {
        failed = true;
        firstFailure = error;
    } finally {
        clearInterval(trackingTimer);
        try { await closeOwnedAgent(child, tracked, () => connection.close()); }
        catch (error) {
            if (!failed) { failed = true; firstFailure = error; }
            else console.error(`CLEANUP-FAIL ${error}`);
        }
    }
    if (failed) {
        console.error(stderrTail.join("\n"));
        throw firstFailure;
    }
    console.log("CLEANUP-PASS owned ACP process family exited");
    console.log("SMOKE-PASS acp live cancel and same-session continuation");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main().catch(error => { console.error(`SMOKE-FAIL ${error}`); process.exitCode = 1; });
}
