import {EventEmitter} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {PassThrough} from "node:stream";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {afterEach, describe, expect, it, vi} from "vitest";
import {attachLogs} from "../CodexJsonRpcConnection";
import {logger} from "../Logger";
function adapterLogPath(dir: string): string {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return path.join(dir, `app-server.${now.getFullYear()}-${mm}-${dd}.log`);
}


function fakeProcess(attach: typeof attachLogs = attachLogs) {
    const proc = new EventEmitter() as EventEmitter & {stdin: PassThrough; stdout: PassThrough; stderr: PassThrough};
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    attach(proc as unknown as ChildProcessWithoutNullStreams);
    return proc;
}

/** A chunk that records whether the adapter turned it into a string. */
function chunk(text: string): Buffer & {toString: ReturnType<typeof vi.fn>} {
    const buffer = Buffer.from(text);
    const toString = vi.fn(buffer.toString.bind(buffer));
    return Object.assign(buffer, {toString});
}

describe("attachLogs", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it("never turns protocol traffic into strings, whatever the log level", () => {
        for (const enabled of [false, true]) {
            vi.spyOn(logger, "enabled", "get").mockReturnValue(enabled);
            vi.spyOn(logger, "engineStderrEnabled", "get").mockReturnValue(false);
            const proc = fakeProcess();
            const input = chunk("{\"id\":1}\n");
            const output = chunk("{\"id\":1,\"result\":{}}\n");
            const error = chunk("warning\n");
            const written: string[] = [];
            proc.stdin.on("data", (data: Buffer) => written.push(Buffer.from(data).toString("utf8")));

            proc.stdin.write(input);
            proc.stdout.emit("data", output);
            proc.stderr.emit("data", error);

            // Protocol payloads carry API keys and provider headers, so the adapter logs sizes only.
            expect(input.toString).not.toHaveBeenCalled();
            expect(output.toString).not.toHaveBeenCalled();
            expect(error.toString).not.toHaveBeenCalled();
            expect(written).toEqual(["{\"id\":1}\n"]);
            vi.restoreAllMocks();
        }
    });

    it("mirrors engine stderr text into its own log when engine logging is on", () => {
        vi.spyOn(logger, "enabled", "get").mockReturnValue(true);
        vi.spyOn(logger, "engineStderrEnabled", "get").mockReturnValue(true);
        vi.spyOn(logger, "log").mockImplementation(() => {});
        const engine = vi.spyOn(logger, "engine").mockImplementation(() => {});
        const proc = fakeProcess();
        const stderr = chunk("DEBUG codex_core: streaming response\n");
        const stdout = chunk("{\"id\":1,\"result\":{}}\n");

        proc.stderr.emit("data", stderr);
        proc.stdout.emit("data", stdout);

        // Engine tracing text is the one stream worth reading; protocol traffic stays bytes.
        expect(stderr.toString).toHaveBeenCalled();
        expect(stdout.toString).not.toHaveBeenCalled();
        expect(engine).toHaveBeenCalledWith("DEBUG codex_core: streaming response\n");
    });

    it("logs the same lines as before when logging is on", () => {
        vi.spyOn(logger, "enabled", "get").mockReturnValue(true);
        const log = vi.spyOn(logger, "log").mockImplementation(() => {});
        const proc = fakeProcess();

        proc.stdin.write("{\"id\":1}\n");
        proc.stdout.emit("data", Buffer.from("{\"id\":1,\"result\":{}}\n"));
        proc.stderr.emit("data", Buffer.from("warning\n"));
        proc.emit("exit", 0);

        expect(log.mock.calls).toEqual([
            ["[IN]", {bytes: 9}],
            ["[OUT]", {bytes: 21}],
            ["[ERR]", {bytes: 8}],
            ["[EXIT] code: 0"],
        ]);
    });

    it("writes the traffic to the log file when APP_SERVER_LOGS is set", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "app-server-logs-"));
        try {
            vi.stubEnv("APP_SERVER_LOGS", directory);
            vi.resetModules();
            const fresh = await import("../CodexJsonRpcConnection");
            const freshLogger = (await import("../Logger")).logger;
            expect(freshLogger.enabled).toBe(true);
            const proc = fakeProcess(fresh.attachLogs);

            proc.stdin.write("{\"id\":1}\n");
            proc.stdout.emit("data", Buffer.from("{\"id\":1,\"result\":{}}\n"));
            proc.stderr.emit("data", Buffer.from("warning\n"));
            proc.emit("exit", 0);

            const lines = fs.readFileSync(adapterLogPath(directory), "utf8").split("\n")
                .map(line => line.replace(/^\S+ \S+ /, "").replace(/\{"pid":\d+,/g, "{").replace(/ \{"pid":\d+\}$/, ""));
            expect(lines.slice(1)).toEqual(["[IN] {\"bytes\":9}", "[OUT] {\"bytes\":21}", "[ERR] {\"bytes\":8}", "[EXIT] code: 0", ""]);
        } finally {
            fs.rmSync(directory, {recursive: true, force: true});
        }
    });

    it("is off without APP_SERVER_LOGS", async () => {
        vi.stubEnv("APP_SERVER_LOGS", "");
        vi.resetModules();

        expect((await import("../Logger")).logger.enabled).toBe(false);
    });
});
