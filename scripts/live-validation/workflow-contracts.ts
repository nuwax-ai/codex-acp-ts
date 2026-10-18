import type {CompactionUpdate} from "@agentclientprotocol/sdk";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type Usage = {used: number; size: number; sessionId?: string};
export type NativeCompaction = {sessionId: string; compactionId: string; status: CompactionUpdate["status"]};
export type ToolCall = {id: string; tool: string; kind?: string; status?: string};
export type ToolUpdate = {id: string; status?: string};
export type ProcessIdentity = {pid: number; ppid: number; started: string};

export function beginPrompt(obs: {sawDelta: boolean}): void { obs.sawDelta = false; }

export function isModelDelta(update: {sessionUpdate?: string; messageId?: unknown; content?: {type?: string; text?: unknown}}): boolean {
    return update.sessionUpdate === "agent_message_chunk" && typeof update.messageId === "string"
        && update.messageId.length > 0 && update.content?.type === "text"
        && typeof update.content.text === "string" && update.content.text.length > 0;
}

export function inspectContent(content: unknown): {texts: string[]; images: number} {
    const result = {texts: [] as string[], images: 0};
    const visit = (value: unknown) => {
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (!value || typeof value !== "object") return;
        const part = value as {type?: string; text?: unknown; data?: unknown; uri?: unknown; content?: unknown};
        if (part.type === "text" && typeof part.text === "string") result.texts.push(part.text);
        else if (part.type === "image" && (typeof part.data === "string" && part.data.length > 0 || typeof part.uri === "string" && part.uri.length > 0)) result.images += 1;
        else if (part.type === "content") visit(part.content);
    };
    visit(content);
    return result;
}

/** Read ACP display blocks plus the MCP mapper's explicit structured result. */
export function inspectUpdateContent(update: {
    content?: unknown;
    rawOutput?: {result?: {content?: unknown} | null; error?: unknown};
    update?: {content?: unknown};
}): {texts: string[]; images: number} {
    const display = inspectContent(update.content ?? update.update?.content);
    const raw = update.rawOutput;
    // MCP results live here rather than ACP display content. Never search or
    // parse arbitrary raw JSON, metadata, errors or serialized text for images.
    const mcp = raw?.error == null && Array.isArray(raw?.result?.content)
        ? inspectContent(raw.result.content) : {texts: [], images: 0};
    return {texts: [...display.texts, ...mcp.texts], images: display.images + mcp.images};
}

export function requireCompletedTool(calls: ToolCall[], updates: ToolUpdate[], predicate: (call: ToolCall) => boolean): void {
    const byId = new Map(calls.map(call => [call.id, call]));
    const completed = [...byId.values()].filter(call => {
        const status = updates.filter(update => update.id === call.id && update.status !== undefined).at(-1)?.status ?? call.status;
        return predicate(call) && status === "completed";
    });
    if (completed.length === 0) throw new Error("no matching tool call completed with a correlated result");
}

export function assertScreenshot(truth: {event?: string; color?: string}[], answer: string, imageToolIds: string[], calls: ToolCall[], updates: ToolUpdate[]): void {
    const complete = truth.filter(row => row.event === "complete");
    const colors: Record<string, string[]> = {
        red: ["red", "红", "红色"], green: ["green", "绿", "绿色"], blue: ["blue", "蓝", "蓝色"],
        yellow: ["yellow", "黄", "黄色"], magenta: ["magenta", "品红", "品红色", "洋红", "洋红色"], cyan: ["cyan", "青", "青色"],
    };
    const color = complete[0]?.color;
    if (complete.length !== 1 || !color || !colors[color]) throw new Error("screenshot requires exactly one completed ground-truth image");
    const shotCalls = calls.filter(call => /take_screenshot/.test(call.tool));
    if (new Set(shotCalls.map(call => call.id)).size !== 1 || !shotCalls.some(call => imageToolIds.includes(call.id))) throw new Error("screenshot requires one correlated typed image tool result");
    requireCompletedTool(shotCalls, updates, () => true);
    if (!colors[color].includes(answer.trim().toLowerCase().replace(/[。.!！]/g, ""))) throw new Error("final assistant color does not match screenshot ground truth");
}

export function latestUsageAfter(updates: Usage[], cursor: number, sessionId?: string): Usage | undefined {
    return updates.slice(cursor).filter(update => sessionId === undefined || update.sessionId === sessionId).at(-1);
}

/** A manually requested compaction must start and complete after subscription. */
export function assertNativeCompaction(updates: NativeCompaction[], cursor: number, sessionId: string): void {
    const oldIds = new Set(updates.slice(0, cursor).filter(update => update.sessionId === sessionId).map(update => update.compactionId));
    const current = updates.slice(cursor).filter(update => update.sessionId === sessionId);
    const started = new Set<string>();
    const completed = new Set<string>();
    for (const update of current) {
        if (!update.compactionId || oldIds.has(update.compactionId)) throw new Error("stale compaction identity after the manual compaction cursor");
        if (update.status === "in_progress" && !started.has(update.compactionId)) started.add(update.compactionId);
        else if (update.status === "completed" && started.has(update.compactionId) && !completed.has(update.compactionId)) completed.add(update.compactionId);
        else throw new Error("native compaction did not follow an in_progress to completed lifecycle");
    }
    if (started.size !== 1 || completed.size !== 1) throw new Error("no unique current-session native compaction completed");
}

export function assertRestoredUsage(expected: Usage, updates: Usage[]): void {
    if (updates.length !== 1 || updates[0]?.used !== expected.used || updates[0]?.size !== expected.size) {
        throw new Error("cold load must deliver exactly one unchanged authoritative usage snapshot");
    }
}

export function workspacePath(workspace: string, value: string): string {
    if (!path.isAbsolute(value)) throw new Error("filesystem request requires an absolute workspace path");
    let exists = true;
    try { fs.lstatSync(value); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        exists = false;
    }
    const resolved = exists ? fs.realpathSync(value) : path.join(fs.realpathSync(path.dirname(value)), path.basename(value));
    const relative = path.relative(fs.realpathSync(workspace), resolved);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("filesystem request escaped the workflow workspace");
    return resolved;
}

export function processTable(read: () => string = () => execFileSync("ps", ["-axo", "pid=,ppid=,lstart=,stat=,command="], {encoding: "utf8", env: {...process.env, LC_ALL: "C"}})): Map<number, ProcessIdentity> {
    const entries = new Map<number, ProcessIdentity>();
    const output = read(); // Probe errors must fail the contract, never mean zero survivors.
    for (const line of output.split("\n")) {
        const row = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(\S+)\s*/.exec(line);
        if (!row || row[4]!.startsWith("Z")) continue;
        const pid = Number(row[1]);
        entries.set(pid, {pid, ppid: Number(row[2]), started: row[3]!});
    }
    if (entries.size === 0) throw new Error("process probe produced no usable identities");
    return entries;
}

export function rememberFamily(root: number, table: Map<number, ProcessIdentity>, tracked: Map<number, ProcessIdentity>): void {
    const frontier = [root];
    const seen = new Set<number>();
    while (frontier.length > 0) {
        const pid = frontier.pop()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        const entry = table.get(pid);
        if (entry) tracked.set(pid, entry);
        for (const child of table.values()) if (child.ppid === pid) frontier.push(child.pid);
    }
}

export function survivingFamily(tracked: Map<number, ProcessIdentity>, table: Map<number, ProcessIdentity>): ProcessIdentity[] {
    return [...tracked.values()].filter(entry => table.get(entry.pid)?.started === entry.started);
}
