import fs from "node:fs";
import path from "node:path";
import {resolveEnvAlias} from "./CodexEnvConfig";

interface LogContext {
    [key: string]: unknown;
}

/** `NUWAX_LOG_ENGINE_STDERR=0` keeps engine stderr out of the log directory. */
const ENGINE_STDERR_SWITCH = "NUWAX_LOG_ENGINE_STDERR";

class Logger {
    private readonly logFilePath: string | null;
    private readonly logDir: string | null;

    constructor() {
        const logDir = process.env["APP_SERVER_LOGS"] || resolveEnvAlias("NUWAX_LOG_DIR", "CODEX_LOG_DIR").value;
        if (!logDir) {
            this.logFilePath = null;
            this.logDir = null;
            return;
        }

        try {
            fs.mkdirSync(logDir, {recursive: true});
            this.logDir = logDir;
            this.logFilePath = path.join(logDir, `app-server.${formatLogDay(new Date())}.log`);
            this.log("Logger initialized", {logFilePath: this.logFilePath});
        } catch (ex) {
            console.error("Failed to initialize logger directory", ex);
            this.logFilePath = null;
            this.logDir = null;
        }
    }

    /** Whether `log` writes anything. A caller checks it before it formats a large message. */
    get enabled(): boolean {
        return this.logFilePath !== null;
    }

    /**
     * Whether engine stderr text should be mirrored into its own daily file.
     *
     * The engine logs through `tracing` to stderr; the app-server protocol keeps
     * those bytes off stdout, so they never reach the adapter's own traffic log.
     * Mirroring them is what makes "model request -> engine decision" greppable
     * from the client's log directory. `NUWAX_LOG_ENGINE_STDERR=0` opts out.
     */
    get engineStderrEnabled(): boolean {
        if (this.logDir === null) return false;
        const raw = process.env[ENGINE_STDERR_SWITCH]?.trim().toLowerCase();
        return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
    }

    /**
     * Append one engine stderr chunk to `engine.<YYYY-MM-DD>.log` in the log
     * directory. One file per calendar day; a long session keeps appending to
     * the same day's file.
     */
    engine(chunk: string): void {
        if (this.logDir === null || !this.engineStderrEnabled) return;
        const text = stripAnsi(chunk);
        if (text.length === 0) return;
        try {
            const day = formatLogDay(new Date());
            fs.appendFileSync(path.join(this.logDir as string, `engine.${day}.log`), text, "utf8");
        } catch (ex) {
            console.error("Engine log write failed", ex);
        }
    }


    error(message: string, err: unknown) {
        const formattedError = this.formatError(err);
        if (!this.logFilePath) {
            console.error(`[SYSTEM_ERROR] ${message}: ${formattedError}`);
            return;
        }
        this.log(`[SYSTEM_ERROR] ${message}`, {exception: formattedError});
    }

    log(message: string, context?: LogContext) {
        if (!this.logFilePath) return;
        try {
            const timestamp = this.formatTimestamp(new Date());
            const serializedContext = ` ${JSON.stringify({pid: process.pid, ...context})}`;

            if (!message.startsWith('[')) message = `[SYS] ${message}`;
            const line = `${timestamp} ${message}${serializedContext}`;
            fs.appendFileSync(this.logFilePath, `${line}\n`);
        } catch (ex) {
            console.error("Logger write failed", ex);
        }
    }

    private formatTimestamp(date: Date): string {
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, "0");
        const dd = String(date.getDate()).padStart(2, "0");
        const hh = String(date.getHours()).padStart(2, "0");
        const min = String(date.getMinutes()).padStart(2, "0");
        const ss = String(date.getSeconds()).padStart(2, "0");
        const ms = String(date.getMilliseconds()).padStart(3, "0");
        return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss},${ms}`;
    }

    private formatError(err: unknown): string {
        if (err instanceof Error) {
            const parts = [`${err.name}: ${err.message}`];
            if (err.stack) {
                parts.push(err.stack);
            }
            if ("cause" in err && err.cause) {
                parts.push(`Caused by: ${this.formatError(err.cause as unknown)}`);
            }
            return parts.join("\n");
        }

        if (typeof err === "string") {
            return err;
        }

        return String(err);
    }
}

/** `YYYY-MM-DD` in local time, so a file always matches the operator's day. */
function formatLogDay(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

function stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export const logger = new Logger();
