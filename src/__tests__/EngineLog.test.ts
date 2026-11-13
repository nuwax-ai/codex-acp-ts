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
        expect(fs.existsSync(path.join(dir, "app-server.log"))).toBe(true);
    });

    it("strips ANSI colour codes so the file stays greppable", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-log-"));
        dirs.push(dir);
        vi.stubEnv("APP_SERVER_LOGS", dir);
        const logger = await freshLogger();

        logger.engine("\u001b[1m\u001b[33mwarning\u001b[0m: unused variable\n");
        expect(fs.readFileSync(path.join(dir, `engine.${dayStamp()}.log`), "utf8")).toBe("warning: unused variable\n");
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
