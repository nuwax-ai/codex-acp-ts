#!/usr/bin/env node
/** Streaming loopback gateway. Every upstream HTTP attempt reserves budget
 * synchronously before it can connect; the persistent journal contains only
 * counters, vendor/wire names and status codes, never URLs, headers or bodies. */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function readVendorRoutes(envFile) {
    const fields = new Map();
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        fields.set(match[1], value);
    }
    const routes = new Map();
    for (const [name, url] of fields) {
        const match = /^LIVE_([A-Z0-9_]+)_(CHAT|RESPONSES|ANTHROPIC)_URL$/.exec(name);
        if (!match || !url) continue;
        const vendor = match[1];
        const wire = match[2].toLowerCase();
        const key = fields.get(`LIVE_${vendor}_API_KEY`);
        const model = fields.get(`LIVE_${vendor}_MODEL`);
        if (key && model) routes.set(`${vendor}/${wire}`, { url, key, model });
    }
    return routes;
}

export async function startBudgetGateway({ routes, ledgerPath, budget, maxOutputTokens = 2048, token = crypto.randomBytes(24).toString("hex") }) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const lockPath = ledgerPath + ".lock";
    const lockValue = JSON.stringify({ pid: process.pid, owner: crypto.randomBytes(16).toString("hex") });
    try {
        fs.writeFileSync(lockPath, lockValue, { flag: "wx", mode: 0o600 });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // Never automatically unlink a stale owner: two simultaneous
        // recoveries could both replace the same old lock and double-spend.
        throw new Error("gateway ledger is locked; confirm the recorded owner is stopped before manually removing its lock");
    }
    const release = () => {
        if (fs.existsSync(lockPath) && fs.readFileSync(lockPath, "utf8") === lockValue) fs.unlinkSync(lockPath);
    };
    try {
    const previous = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const metadata = previous.find((row) => row.kind === "budget");
    const limit = budget ?? metadata?.limit ?? 96;
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error("invalid gateway budget/output cap");
    if (metadata && (metadata.limit !== limit || metadata.maxOutputTokens !== maxOutputTokens)) throw new Error("existing run budget/output cap cannot be reset; use a new run directory");
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const journal = (row) => fs.appendFileSync(ledgerPath, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n", { mode: 0o600 });
    if (!metadata) journal({ kind: "budget", limit, maxOutputTokens });
    let used = previous.filter((row) => row.kind === "admitted").length;
    let denied = previous.filter((row) => row.kind === "denied").length;
    let active = 0;
    const stats = () => ({ limit, used, denied, active, remaining: Math.max(0, limit - used), maxOutputTokens });
    const sockets = new Set();
    let origin;
    const server = http.createServer((req, res) => {
        const reply = (status, value) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(value));
        };
        if (req.headers.authorization !== `Bearer ${token}` && req.headers["x-api-key"] !== token) { reply(403, { error: "gateway authorization required" }); return; }
        const incoming = new URL(req.url, "http://127.0.0.1");
        if (req.method === "GET" && incoming.pathname === "/control/stats") { reply(200, stats()); return; }
        if (req.method === "GET" && incoming.pathname === "/control/config") {
            const routeName = `${incoming.searchParams.get("vendor")}/${incoming.searchParams.get("wire")}`;
            const route = routes.get(routeName);
            if (!route) { reply(404, { error: "vendor/wire is not configured" }); return; }
            reply(200, { baseUrl: `${origin}/routes/${routeName}`, model: route.model });
            return;
        }
        const match = /^\/routes\/([A-Z0-9_]+)\/(chat|responses|anthropic)(\/.*)$/.exec(incoming.pathname);
        const route = match && routes.get(`${match[1]}/${match[2]}`);
        const expectedPaths = { chat: ["/chat/completions"], responses: ["/responses"], anthropic: ["/v1/messages", "/messages"] };
        if (req.method !== "POST" || !route || !expectedPaths[match[2]].includes(match[3])) { reply(404, { error: "unsupported model route" }); return; }
        const vendor = match[1];
        const wire = match[2];
        const chunks = [];
        let bytes = 0;
        req.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 32 * 1024 * 1024) { reply(413, { error: "request body too large" }); req.destroy(); return; }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (res.destroyed || res.writableEnded) return;
            let body;
            let target;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
                target = new URL(route.url);
                if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error("invalid upstream");
            } catch { reply(400, { error: "invalid request or upstream configuration" }); return; }
            if (used >= limit) {
                denied += 1;
                journal({ kind: "denied", vendor, wire, used, limit });
                // A non-transient refusal: callers must not retry around the cap.
                reply(402, { error: { message: "shared live request budget exhausted", type: "budget_exhausted" } });
                return;
            }
            const capField = wire === "responses" ? "max_output_tokens" : wire === "chat" && "max_completion_tokens" in body ? "max_completion_tokens" : "max_tokens";
            body[capField] = Number.isSafeInteger(body[capField]) && body[capField] > 0 ? Math.min(body[capField], maxOutputTokens) : maxOutputTokens;
            if (wire === "chat" && capField === "max_completion_tokens") delete body.max_tokens;
            const payload = Buffer.from(JSON.stringify(body));
            let basePath = target.pathname.replace(/\/+$/, "");
            if (wire === "anthropic") {
                // Match rig 0.44 AnthropicConfig::normalize_base_url: pasted
                // /v1, /messages or /v1/messages bases all yield one v1 path.
                for (const suffix of ["/v1/messages", "/messages", "/v1"]) {
                    if (basePath.endsWith(suffix)) { basePath = basePath.slice(0, -suffix.length); break; }
                }
                target.pathname = basePath + "/v1/messages";
            } else {
                target.pathname = basePath + match[3];
            }
            for (const [key, value] of incoming.searchParams) target.searchParams.append(key, value);
            const headers = { ...req.headers, host: target.host, "content-length": String(payload.length), authorization: `Bearer ${route.key}` };
            delete headers.connection;
            delete headers["x-api-key"];
            if (wire === "anthropic") headers["x-api-key"] = route.key;
            // Synchronous reservation and persistence happen before request()
            // can open a socket. Retries, tools and auxiliary calls all arrive
            // through this same path and share this counter across processes.
            const attempt = ++used;
            journal({ kind: "admitted", attempt, vendor, wire });
            active += 1;
            let finished = false;
            const finish = (status) => {
                if (finished) return;
                finished = true;
                active -= 1;
                journal({ kind: "finished", attempt, vendor, wire, status });
            };
            const upstream = (target.protocol === "https:" ? https : http).request(target, { method: "POST", headers }, (response) => {
                // Returning an upstream Location would let a following client
                // leave this gateway and evade the shared counter. A changed
                // vendor endpoint must be configured explicitly for the run.
                if (response.statusCode >= 300 && response.statusCode < 400) {
                    finish("redirect_refused");
                    reply(502, { error: "upstream redirects are refused by the budget gateway" });
                    response.destroy();
                    return;
                }
                res.writeHead(response.statusCode ?? 502, response.headers);
                response.pipe(res);
                response.on("end", () => finish(response.statusCode ?? 502));
                response.on("error", () => { finish("response_error"); res.destroy(); });
            });
            upstream.setTimeout(120_000, () => upstream.destroy(new Error("upstream timeout")));
            upstream.on("error", () => {
                finish("upstream_error");
                if (!res.headersSent && !res.destroyed) reply(502, { error: "upstream request failed" });
                else res.destroy();
            });
            res.on("close", () => {
                if (!res.writableEnded) { finish("cancelled"); upstream.destroy(); }
            });
            upstream.end(payload);
        });
    });
    server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    server.on("upgrade", (_req, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    return { origin, token, stats, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); release(); } };
    } catch (error) { release(); throw error; }
}

async function main() {
    const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 === 0 ? [...pairs, [value.replace(/^--/, ""), all[index + 1]]] : pairs, []));
    const gateway = await startBudgetGateway({
        routes: readVendorRoutes(args["env-file"]), ledgerPath: path.join(args.root, "request-ledger.jsonl"),
        budget: args.budget ? Number(args.budget) : undefined, maxOutputTokens: Number(args["max-output"] ?? 2048),
    });
    const ready = path.join(args.root, "gateway-ready.json");
    fs.writeFileSync(ready, JSON.stringify({ origin: gateway.origin, token: gateway.token, pid: process.pid }), { mode: 0o600 });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await gateway.close(); process.exit(0); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(() => { console.error("live budget gateway failed; inspect configuration and persistent ledger"); process.exitCode = 1; });
}
