import {afterEach, describe, expect, it, vi} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function dayStamp(): string {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${mm}-${dd}`;
}

describe("engine stderr log", () => {
    const dirs: string[] = [];
    afterEach(() => {
        vi.unstubAllEnvs();
        for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
    });

    async function freshLogger() {
        vi.resetModules();
        return (await import("../Logger")).logger;
    }

    it("mirrors engine stderr into a dated file next to the adapter log", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-log-"));
        dirs.push(dir);
        vi.stubEnv("APP_SERVER_LOGS", dir);
        const logger = await freshLogger();
        expect(logger.engineStderrEnabled).toBe(true);

        logger.engine("2026-11-13T00:00:00Z DEBUG codex_core: streaming response\n");

        const engineFile = path.join(dir, `engine.${dayStamp()}.log`);
        expect(fs.readFileSync(engineFile, "utf8")).toContain("streaming response");
        expect(fs.readdirSync(dir).some(name => /^app-server\.\d{4}-\d{2}-\d{2}\.log$/.test(name))).toBe(true);
    });

    it("strips ANSI colour codes so the file stays greppable", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-log-"));
        dirs.push(dir);
        vi.stubEnv("APP_SERVER_LOGS", dir);
        const logger = await freshLogger();

        logger.engine("\u001b[1m\u001b[33mwarning\u001b[0m: unused variable\n");
        const written = fs.readFileSync(path.join(dir, `engine.${dayStamp()}.log`), "utf8");
        // A per-process marker opens the file; the payload itself carries no escapes.
        expect(written).toContain("=== engine log opened pid=");
        expect(written.slice(written.indexOf("\n") + 1)).toBe("warning: unused variable\n");
    });

    it("keeps multi-byte UTF-8 intact when a chunk boundary splits a character", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-log-"));
        dirs.push(dir);
        vi.stubEnv("APP_SERVER_LOGS", dir);
        const logger = await freshLogger();

        const bytes = Buffer.from("流式响应失败\n", "utf8");
        // Split inside the first character's three bytes.
        expect(logger.engineChunk(bytes.subarray(0, 1))).toBe(true);
        expect(logger.engineChunk(bytes.subarray(1))).toBe(true);

        const written = fs.readFileSync(path.join(dir, `engine.${dayStamp()}.log`), "utf8");
        expect(written).toContain("流式响应失败");
        expect(written).not.toContain("\uFFFD");
    });

    it("reports that text was not captured when the log is switched off", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-log-"));
        dirs.push(dir);
        vi.stubEnv("APP_SERVER_LOGS", dir);
        vi.stubEnv("NUWAX_LOG_ENGINE_STDERR", "0");
        const logger = await freshLogger();

        expect(logger.engineChunk(Buffer.from("dropped\n"))).toBe(false);
    });

    it("reports a dead log directory once and then stops trying", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-log-"));
        vi.stubEnv("APP_SERVER_LOGS", dir);
        const logger = await freshLogger();
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        // Remove the directory: every append now fails.
        fs.rmSync(dir, {recursive: true, force: true});

        for (let i = 0; i < 5; i += 1) logger.engine(`chunk ${i}\n`);

        expect(error).toHaveBeenCalledTimes(1);
        error.mockRestore();
    });

    it("can be switched off with NUWAX_LOG_ENGINE_STDERR=0", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-log-"));
        dirs.push(dir);
        vi.stubEnv("APP_SERVER_LOGS", dir);
        vi.stubEnv("NUWAX_LOG_ENGINE_STDERR", "0");
        const logger = await freshLogger();
        expect(logger.engineStderrEnabled).toBe(false);

        logger.engine("should not appear\n");
        expect(fs.existsSync(path.join(dir, `engine.${dayStamp()}.log`))).toBe(false);
    });
});
