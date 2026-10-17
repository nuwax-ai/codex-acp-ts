import {spawn} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";

it("startup and default API-key authentication keep credentials out of diagnostic logs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-auth-log-"));
    const repo = fileURLToPath(new URL("../..", import.meta.url));
    const apiKey = "dummy-log-boundary-api-key";
    const configSecret = "dummy-log-boundary-config-header";
    const urlSecret = "dummy-log-boundary-url-token";
    const acknowledged = path.join(root, "auth-received.json");
    const fakeScript = path.join(root, "fake-app-server.cjs");
    fs.writeFileSync(fakeScript, `
const fs = require("node:fs");
const readline = require("node:readline");
let authenticated = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const lines = readline.createInterface({input: process.stdin});
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result = {};
    switch (request.method) {
        case "initialize":
            result = {codexHome: ${JSON.stringify(root)}, credentialEcho: ${JSON.stringify(apiKey)}};
            process.stderr.write(${JSON.stringify(apiKey)} + "\\n");
            break;
        case "account/read":
            result = {requiresOpenaiAuth: true, account: authenticated ? {type: "apiKey"} : null};
            break;
        case "account/login/start":
            authenticated = request.params.apiKey === ${JSON.stringify(apiKey)};
            fs.writeFileSync(${JSON.stringify(acknowledged)}, JSON.stringify({authenticated}));
            send({id: request.id, result: {type: "apiKey"}});
            send({method: "account/login/completed", params: {loginId: "dummy", success: authenticated, error: null, onboardingEntrypoint: null}});
            return;
        case "config/read": result = {config: {}, layers: []}; break;
        case "skills/list": result = {data: []}; break;
        case "thread/start":
            send({id: request.id, error: {code: -32603, message: "local test stops after authentication"}});
            return;
    }
    send({id: request.id, result});
});
`);
    const launcher = path.join(root, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
    const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(launcher, process.platform === "win32"
        ? `@"${process.execPath}" "${fakeScript}" %*\r\n`
        : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeScript)} "$@"\n`, {mode: 0o700});
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CODEX_|NUWAX_|OPENAI_|ANTHROPIC_|DEFAULT_AUTH_REQUEST$|MODEL_PROVIDER$|APP_SERVER_LOGS$)/.test(name)));
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        cwd: repo,
        env: {
            ...env, CODEX_PATH: launcher, APP_SERVER_LOGS: root,
            DEFAULT_AUTH_REQUEST: JSON.stringify({methodId: "api-key", _meta: {"api-key": {apiKey}}}),
            CODEX_CONFIG: JSON.stringify({model_provider: "dummy", model_providers: {dummy: {base_url: `https://unused.invalid/v1?token=${urlSecret}`, http_headers: {Authorization: `Bearer ${configSecret}`}}}}),
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const replies = new Map<number, (message: Record<string, unknown>) => void>();
    let output = "";
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.stdout.on("data", chunk => {
        output += chunk.toString();
        for (;;) {
            const end = output.indexOf("\n");
            if (end < 0) break;
            const message = JSON.parse(output.slice(0, end));
            output = output.slice(end + 1);
            replies.get(message.id)?.(message);
        }
    });
    const rpc = (id: number, method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), 4000);
        replies.set(id, message => { clearTimeout(timeout); replies.delete(id); resolve(message); });
        child.stdin.write(JSON.stringify({jsonrpc: "2.0", id, method, params}) + "\n");
    });
    try {
        expect(await rpc(1, "initialize", {protocolVersion: 1})).toHaveProperty("result");
        await rpc(2, "session/new", {cwd: root, mcpServers: []});
        expect(JSON.parse(fs.readFileSync(acknowledged, "utf8"))).toEqual({authenticated: true});
        const log = fs.readFileSync(path.join(root, "app-server.log"), "utf8");
        expect(log).toContain("Startup");
        expect(log).toContain("Authenticating with default auth request");
        expect(log).toContain('"defaultAuthMethod":"api-key"');
        expect(log).toContain("[IN]");
        expect(log).toContain('"bytes":');
        expect(log).not.toContain(apiKey);
        expect(log).not.toContain(configSecret);
        expect(log).not.toContain(urlSecret);
    } finally {
        const exited = child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.stdin.end();
        const kill = setTimeout(() => child.kill(), 3000);
        await exited;
        clearTimeout(kill);
        fs.rmSync(root, {recursive: true, force: true});
    }
}, 10_000);
