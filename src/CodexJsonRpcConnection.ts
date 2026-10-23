import * as rpc from "vscode-jsonrpc/node";
import type {Message} from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {logger} from "./Logger";

export interface CodexConnection {
    readonly connection: MessageConnection
    readonly process: ChildProcessWithoutNullStreams;
    /**
     * Settles once the connection has handled every message that the process wrote before its stdout ended.
     * `CodexAppServerSupervisor` waits for it before it disposes the connection of a dead process.
     */
    readonly drained?: Promise<void>;
}

/** A notification that the adapter feeds into the connection after the last message of the process. */
const DRAINED_MARKER_METHOD = "codex-acp/stdoutDrained";

export interface StartCodexConnectionOptions {
    /**
     * Dispose the connection when the process exits (default). `CodexAppServerSupervisor` turns it off: it disposes
     * the connection itself, after the last output of the process was read.
     */
    disposeOnExit?: boolean;
}

export function startCodexConnection(
    codexPath: string,
    env?: NodeJS.ProcessEnv,
    appServerStartupArgs: string[] = ["app-server"],
    options: StartCodexConnectionOptions = {},
): CodexConnection {
    const spawnEnv = env ?? process.env;

    let codex: ChildProcessWithoutNullStreams;
    // The nuwax-harness binary is a native executable, so plain spawn is enough on every platform.
    // A caller-supplied path can be a `.cmd` shim, which needs the shell on Windows.
    codex = process.platform === "win32"
        ? spawn(`"${codexPath}" ${appServerStartupArgs.join(" ")}`, {shell: true, env: spawnEnv})
        : spawn(codexPath, appServerStartupArgs, {env: spawnEnv});

    attachLogs(codex);
    // A write to a process that is dying fails with EPIPE. Without a listener that error would end the adapter.
    codex.stdin.on("error", (error) => logger.log(`[STDIN ERROR] ${error.message}`));
    codex.stdout.on("error", (error) => logger.log(`[STDOUT ERROR] ${error.message}`));

    const reader = createJSONRPCReader(codex.stdout);
    const writer = createJSONRPCWriter(codex.stdin);

    let connection = rpc.createMessageConnection(reader, writer);

    connection.listen();

    // vscode-jsonrpc handles the messages that it read one by one, after the read. The marker comes after the last
    // message of the process, so its handler runs only when every earlier message was handled.
    const drained = new Promise<void>(resolve => {
        connection.onNotification(DRAINED_MARKER_METHOD, () => resolve());
    });
    codex.stdout.on("end", () => reader.deliver?.({jsonrpc: "2.0", method: DRAINED_MARKER_METHOD} as Message));

    if (options.disposeOnExit ?? true) {
        // Terminate all current activities on process termination
        codex.on("exit", _ => {
            connection.dispose();
        });
    }

    return {connection: connection, process: codex, drained};
}

/**
 * Logs the traffic of the app-server.
 * The listeners stay attached when logging is off, so that stderr keeps draining,
 * but a chunk is turned into a string only when the logger writes it.
 */
export function attachLogs(proc: ChildProcessWithoutNullStreams) {
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: any, encoding?: any, callback?: any): boolean => {
        // Protocol payloads include account/login API keys and provider headers.
        // Keep transport activity useful without persisting raw credentials.
        logger.log("[IN]", {bytes: Buffer.byteLength(chunk)});
        return originalWrite(chunk, encoding, callback);
    };

    proc.stderr.on("data", (data) => {
        logger.log("[ERR]", {bytes: data.length});
    });
    proc.stdout.on("data", (data: Buffer) => {
        logger.log("[OUT]", {bytes: data.length});
    });
    proc.on("exit", (code) => {
        logger.log(`[EXIT] code: ${code?.toString()}`);
    });
}
