import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { latestUserText, selectResponse, startMockServer } from "./mock-vendor-server.mjs";

const text = (value) => ({ type: "text", text: value });
const user = (content) => ({ role: "user", content });
const screenshotTool = { type: "function", function: { name: "mcp__screenshots__take_screenshot" } };
const png = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHe";

test("merged user parts select the latest instruction after cancellation", () => {
    assert.equal(latestUserText({ messages: [user([text("essay about ocean currents"), text("<turn_aborted/>"), text("Reply with exactly: post-compact-ok")])] }), "Reply with exactly: post-compact-ok");
});

test("guardian transcript never dispatches a tool", () => {
    const body = {
        messages: [user("Review the planned take_screenshot tool")],
        response_format: { json_schema: { schema: { properties: { outcome: { enum: ["allow", "deny"] } } } } },
    };
    assert.deepEqual(selectResponse(body), { kind: "guardian", text: '{"outcome":"allow"}' });
});

test("title output remains JSON despite a quoted old prompt", () => {
    const body = {
        messages: [user("Create a title: reply pong")],
        response_format: { json_schema: { schema: { properties: { title: { type: "string" } } } } },
    };
    assert.deepEqual(selectResponse(body), { kind: "title", text: '{"title":"ACP mock acceptance"}' });
});

test("compaction ignores the interrupted essay and retains only a present token", () => {
    for (const token of ["ACP-COLD-42", "missing-token"]) {
        const body = { messages: [user(token), user([text("essay about ocean currents"), text("You are performing a CONTEXT CHECKPOINT COMPACTION")])] };
        const answer = selectResponse(body);
        assert.equal(answer.kind, "compaction");
        assert.equal(answer.text.includes("ACP-COLD-42"), token === "ACP-COLD-42");
    }
});

test("typed tool-image continuation recognizes its synthetic user label", () => {
    assert.deepEqual(selectResponse({ messages: [user([text("Images returned by tool call call_val_1:"), { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }])] }), { kind: "image", text: "red" });
});

test("old screenshot history cannot override continuation or cold recall", () => {
    for (const [prompt, kind, expected] of [
        ["Reply with exactly: post-compact-ok", "continuation", "post-compact-ok"],
        ["What token did I ask you to remember?", "recall", "ACP-COLD-42"],
    ]) {
        assert.deepEqual(selectResponse({ messages: [user(`ACP-COLD-42 ${png}`), user(prompt)] }), { kind, text: expected });
    }
    assert.ok(!selectResponse({ messages: [user("What token did I ask you to remember?")] }).text.includes("ACP-COLD-42"));
});

test("screenshot call requires an advertised tool and has a finite retry budget", () => {
    const messages = [user("Call take_screenshot")];
    assert.equal(selectResponse({ messages }).kind, "missing-tool");
    assert.deepEqual(selectResponse({ messages, tools: [screenshotTool] }), { kind: "tool", name: screenshotTool.function.name });
    assert.equal(selectResponse({ messages, tools: [screenshotTool] }, 3).kind, "tool-budget");
});

test("mock HTTP dispatch stops at its global request cap", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-mock-contract-"));
    const recordPath = path.join(dir, "requests.jsonl");
    const server = startMockServer({ port: 0, recordPath, maxRequests: 1 });
    t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    const init = { method: "POST", body: JSON.stringify({ messages: [user("pong")] }) };
    const first = await fetch(url, init);
    assert.equal(first.status, 200);
    assert.ok((await first.text()).includes("pong"));
    const second = await fetch(url, init);
    assert.equal(second.status, 429);
    assert.equal(fs.readFileSync(recordPath, "utf8").trim().split("\n").length, 1);
});
