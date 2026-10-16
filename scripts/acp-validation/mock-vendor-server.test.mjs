import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { latestUserText, normalizeRequest, selectResponse, startMockServer, textResponse, toolCallResponse, wireForPath } from "./mock-vendor-server.mjs";

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

// ---------------------------------------------------------------------------
// Three-wire contracts
// ---------------------------------------------------------------------------

test("wire routing accepts exactly the three provider paths and rejects others", () => {
    assert.equal(wireForPath("/v1/chat/completions"), "chat");
    assert.equal(wireForPath("/v1/responses"), "responses");
    assert.equal(wireForPath("/v1/messages"), "anthropic");
    assert.equal(wireForPath("/v1/embeddings"), null);
    assert.equal(wireForPath("/health"), null);
});

test("responses wire normalizes input items, text.format schema and flat tool names", () => {
    const body = {
        model: "m",
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "pong" }] },
        ],
        tools: [{ type: "function", name: "mcp__screenshots__take_screenshot" }],
        text: { format: { type: "json_schema", strict: true, schema: { properties: { title: { type: "string" } } } } },
    };
    const view = normalizeRequest(body);
    assert.equal(view.wire, "responses");
    assert.equal(latestUserText(view), "pong");
    assert.deepEqual(view.toolNames, ["mcp__screenshots__take_screenshot"]);
    assert.deepEqual(selectResponse(body), { kind: "title", text: '{"title":"ACP mock acceptance"}' });
});

test("anthropic wire normalizes content blocks, output_config schema and tool names", () => {
    const body = {
        model: "m",
        messages: [user([{ type: "text", text: "essay about ocean currents" }])],
        tools: [{ name: "mcp__screenshots__take_screenshot" }],
        output_config: { format: { type: "json_schema", schema: { properties: { outcome: { enum: ["allow"] } } } } },
    };
    const view = normalizeRequest(body);
    assert.equal(view.wire, "anthropic");
    assert.equal(latestUserText(view), "essay about ocean currents");
    assert.deepEqual(selectResponse(body), { kind: "guardian", text: '{"outcome":"allow"}' });
});

test("typed image parts are detected on every wire, text mentions are not", () => {
    const chatBody = { messages: [user([text("Images returned by tool call call_val_1:"), { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }])] };
    const responsesBody = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Images returned by tool call call_val_1:" }, { type: "input_image", image_url: `data:image/png;base64,${png}` }] }] };
    const anthropicBody = { messages: [user([{ type: "text", text: "Images returned by tool call call_val_1:" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }])] };
    // The server derives the wire from the request path; chat and anthropic
    // bodies alone are ambiguous, so detection is asserted per named wire.
    assert.ok(normalizeRequest(chatBody, "chat").hasImage);
    assert.ok(normalizeRequest(responsesBody, "responses").hasImage);
    assert.ok(normalizeRequest(anthropicBody, "anthropic").hasImage);
    for (const [body, wire] of [[chatBody, "chat"], [responsesBody, "responses"], [anthropicBody, "anthropic"]]) {
        assert.deepEqual(selectResponse(body, 0, wire), { kind: "image", text: "red" });
    }
    const textOnly = { messages: [user(`the prefix ${png} as plain text`)] };
    assert.ok(!normalizeRequest(textOnly).hasImage);
});

test("anthropic and responses emitters produce their native terminal shapes", () => {
    const anthropic = textResponse("anthropic", "pong");
    assert.ok(anthropic.includes("event: message_start"));
    assert.ok(anthropic.includes('"text_delta","text":"pong"'));
    assert.ok(anthropic.includes('"stop_reason":"end_turn"'));
    assert.ok(anthropic.includes("event: message_stop"));
    const responses = textResponse("responses", "pong");
    assert.ok(responses.includes('"response.output_text.delta"'));
    assert.ok(responses.includes('"output_text","text":"pong"'));
    assert.ok(responses.includes('"response.completed"'));
    assert.ok(responses.includes('"total_tokens":5'));
    const anthropicTool = toolCallResponse("anthropic", "mcp__screenshots__take_screenshot", "{}");
    assert.ok(anthropicTool.includes('"type":"tool_use"'));
    assert.ok(anthropicTool.includes('"input_json_delta","partial_json":"{}"'));
    assert.ok(anthropicTool.includes('"stop_reason":"tool_use"'));
    const responsesTool = toolCallResponse("responses", "mcp__screenshots__take_screenshot", "{}");
    assert.ok(responsesTool.includes('"type":"function_call"'));
    assert.ok(responsesTool.includes('"call_id":"call_val_1"'));
    assert.ok(responsesTool.includes("response.function_call_arguments.delta"));
});

test("invalid JSON and unknown paths fail fast instead of scripting an answer", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-mock-contract-"));
    const recordPath = path.join(dir, "requests.jsonl");
    const server = startMockServer({ port: 0, recordPath, maxRequests: 10 });
    t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const invalid = await fetch(`${base}/v1/responses`, { method: "POST", body: "{not json" });
    assert.equal(invalid.status, 400);
    const unknown = await fetch(`${base}/v1/other`, { method: "POST", body: "{}" });
    assert.equal(unknown.status, 404);
    assert.ok(!fs.existsSync(recordPath) || fs.readFileSync(recordPath, "utf8").trim() === "");
});

test("screenshot retry budget is shared across wires on one server instance", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-mock-contract-"));
    const recordPath = path.join(dir, "requests.jsonl");
    const server = startMockServer({ port: 0, recordPath, maxRequests: 10 });
    t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const chatBody = JSON.stringify({ messages: [user("please take_screenshot now")], tools: [screenshotTool] });
    const anthropicBody = JSON.stringify({ messages: [user([{ type: "text", text: "please take_screenshot now" }])], tools: [{ name: screenshotTool.function.name }] });
    const kinds = [];
    for (let i = 0; i < 3; i += 1) {
        const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: chatBody });
        kinds.push(JSON.parse(fs.readFileSync(recordPath, "utf8").trim().split("\n").at(-1)).kind);
        assert.equal(response.status, 200);
    }
    const fourth = await fetch(`${base}/v1/messages`, { method: "POST", body: anthropicBody });
    const fourthKind = JSON.parse(fs.readFileSync(recordPath, "utf8").trim().split("\n").at(-1)).kind;
    assert.deepEqual(kinds, ["tool", "tool", "tool"]);
    assert.equal(fourthKind, "tool-budget");
    const recorded = fs.readFileSync(recordPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(recorded.map((r) => r.wire), ["chat", "chat", "chat", "anthropic"]);
});
