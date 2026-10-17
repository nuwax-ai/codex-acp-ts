import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readVendorRoutes, startBudgetGateway } from "./budget-gateway.mjs";

async function fixture(t, budget = 6) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-gateway-test-"));
    const requests = [];
    let retry = false;
    let redirect = false;
    const upstream = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            requests.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
            if (redirect) { res.writeHead(307, { location: `http://127.0.0.1:${upstream.address().port}/unguarded` }).end(); return; }
            if (retry && requests.length === 1) { res.writeHead(503).end("retry"); return; }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write("data: first\n\n");
            res.end("data: [DONE]\n\n");
        });
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${upstream.address().port}/upstream`;
    const routes = new Map(["chat", "responses", "anthropic"].map((wire) => [`TEST/${wire}`, { url, key: "secret-upstream-key", model: "test-model" }]));
    const ledgerPath = path.join(root, "ledger.jsonl");
    let gateway = await startBudgetGateway({ routes, ledgerPath, budget });
    t.after(async () => { await gateway.close(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
    const call = async (wire, body = {}) => {
        const suffix = { chat: "chat/completions", responses: "responses", anthropic: "v1/messages" }[wire];
        const response = await fetch(`${gateway.origin}/routes/TEST/${wire}/${suffix}`, {
            method: "POST", headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.text() };
    };
    return { requests, call, root, ledgerPath, stats: () => gateway.stats(), close: () => gateway.close(), setAnthropicBase: (suffix) => { routes.get("TEST/anthropic").url = url + suffix; }, enableRetry: () => { retry = true; }, enableRedirect: () => { redirect = true; }, restart: async () => { await gateway.close(); gateway = await startBudgetGateway({ routes, ledgerPath }); } };
}

test("three wires and concurrent child clients share a real pre-forward hard cap", async (t) => {
    const f = await fixture(t, 6);
    const replies = await Promise.all(Array.from({ length: 12 }, (_, index) => f.call(["chat", "responses", "anthropic"][index % 3], { messages: [], input: [], max_tokens: 99999 })));
    assert.equal(replies.filter((r) => r.status === 200).length, 6);
    assert.equal(replies.filter((r) => r.status === 402).length, 6);
    assert.equal(f.requests.length, 6, "rejected attempts never reach upstream");
    assert.deepEqual(f.stats(), { limit: 6, used: 6, denied: 6, active: 0, remaining: 0, maxOutputTokens: 2048 });
    for (const req of f.requests) {
        assert.equal(req.headers.authorization, "Bearer secret-upstream-key");
        assert.ok((req.body.max_output_tokens ?? req.body.max_tokens) <= 2048);
        if (req.path.endsWith("/messages")) assert.equal(req.headers["x-api-key"], "secret-upstream-key");
    }
});

test("a retry is a second paid attempt and both stay charged after restart", async (t) => {
    const f = await fixture(t, 2);
    f.enableRetry();
    assert.equal((await f.call("chat")).status, 503);
    assert.equal((await f.call("chat")).status, 200);
    await f.restart();
    assert.equal(f.stats().used, 2);
    assert.equal((await f.call("anthropic")).status, 402);
    assert.equal(f.requests.length, 2);
});

test("Anthropic bare, v1 and pasted message bases preserve rig's one-v1 endpoint", async (t) => {
    const f = await fixture(t, 5);
    for (const suffix of ["", "/v1", "/v1/messages", "/messages", "/v1/"]) {
        f.setAnthropicBase(suffix);
        assert.equal((await f.call("anthropic")).status, 200);
        assert.equal(f.requests.at(-1).path, "/upstream/v1/messages");
    }
    assert.equal(f.stats().used, 5);
});

test("journal excludes API keys, request bodies, image bytes and upstream URLs", async (t) => {
    const f = await fixture(t, 1);
    await f.call("chat", { content: "private-prompt-base64-image-marker" });
    await f.call("responses");
    const journal = fs.readFileSync(f.ledgerPath, "utf8");
    for (const secret of ["secret-upstream-key", "private-prompt-base64-image-marker", "127.0.0.1", "/upstream", "authorization"]) assert.equal(journal.includes(secret), false);
    assert.equal(journal.split("\n").filter(Boolean).filter((row) => JSON.parse(row).kind === "admitted").length, 1);
});

test("upstream redirects cannot send a following client outside the gateway", async (t) => {
    const f = await fixture(t, 2);
    f.enableRedirect();
    assert.equal((await f.call("chat")).status, 502);
    assert.equal(f.requests.length, 1);
    assert.equal(f.stats().used, 1);
    assert.ok(fs.readFileSync(f.ledgerPath, "utf8").includes("redirect_refused"));
});

test("resuming cannot replace an existing budget with a fresh larger allowance", async (t) => {
    const f = await fixture(t, 2);
    await f.close();
    await assert.rejects(startBudgetGateway({ routes: new Map(), ledgerPath: f.ledgerPath, budget: 3 }), /cannot be reset/);
});

test("a second gateway cannot open the same ledger and double the allowance", async (t) => {
    const f = await fixture(t, 2);
    await assert.rejects(startBudgetGateway({ routes: new Map(), ledgerPath: f.ledgerPath, budget: 2 }), /ledger is locked/);
    assert.equal((await f.call("chat")).status, 200);
    assert.equal(f.stats().used, 1);
});

test("stale lock takeover fails closed for simultaneous recoveries", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-gateway-stale-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ledgerPath = path.join(root, "ledger.jsonl");
    const lock = ledgerPath + ".lock";
    const original = JSON.stringify({ pid: 2147483647, owner: "dead-owner" });
    fs.writeFileSync(lock, original);
    const attempts = await Promise.allSettled(Array.from({ length: 2 }, () => startBudgetGateway({ routes: new Map(), ledgerPath, budget: 1 })));
    assert.ok(attempts.every((result) => result.status === "rejected" && /ledger is locked/.test(result.reason.message)));
    assert.equal(fs.readFileSync(lock, "utf8"), original);
    assert.equal(fs.existsSync(ledgerPath), false, "no fresh allowance was created");
});

test("env parser accepts quoted values without evaluating shell contents", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-gateway-env-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "dummy.env");
    fs.writeFileSync(file, 'export LIVE_TEST_CHAT_URL="http://127.0.0.1/v1"\nLIVE_TEST_MODEL=example\nLIVE_TEST_API_KEY=\'dummy$(echo unsafe)\'\n');
    assert.deepEqual(readVendorRoutes(file).get("TEST/chat"), { url: "http://127.0.0.1/v1", model: "example", key: "dummy$(echo unsafe)" });
});
