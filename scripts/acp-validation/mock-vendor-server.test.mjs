import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyImageDataUrl, decodePng, latestUserText, normalizeRequest, selectResponse, startMockServer, textResponse, toolCallResponse, wireForPath } from "./mock-vendor-server.mjs";
import { SHOT_PALETTE, pngBase64FromPixels, solidColorPngBase64 } from "./shot-server.mjs";

const text = (value) => ({ type: "text", text: value });
const user = (content) => ({ role: "user", content });
const screenshotTool = { type: "function", function: { name: "mcp__screenshots__take_screenshot" } };
const png = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHe";
// Real decodable fixtures from the shot server's synthesizer (the truncated
// prefix above stays useful as a "mentioned as plain text" negative).
const shotPngUrl = (color, marker) => `data:image/png;base64,${solidColorPngBase64(color, marker)}`;

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

test("typed tool-image continuation answers with the classified color", () => {
    const answer = selectResponse({ messages: [user([text("Images returned by tool call call_val_1:"), { type: "image_url", image_url: { url: shotPngUrl("green", 0x0a0b01) } }])] });
    assert.equal(answer.kind, "image");
    assert.equal(answer.text, "green");
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

// ---------------------------------------------------------------------------
// Image-round verification (review item 6)
// ---------------------------------------------------------------------------

test("decoder classifies every palette color the shot server can serve", () => {
    SHOT_PALETTE.forEach(([name], index) => {
        assert.equal(classifyImageDataUrl(shotPngUrl(name, 0x010101 + index)), name);
        // Anthropic-style raw base64 (no data-URL prefix) classifies too.
        assert.equal(classifyImageDataUrl(solidColorPngBase64(name, 0x020202 + index)), name);
    });
});

test("decoder round-trips pixels byte-exactly through every scanline filter", () => {
    const width = 9;
    const height = 7;
    const pixels = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
        pixels[i * 4] = (i * 7) & 0xff;
        pixels[i * 4 + 1] = (i * 13 + 40) & 0xff;
        pixels[i * 4 + 2] = (i * 29 + 90) & 0xff;
        pixels[i * 4 + 3] = 255;
    }
    for (const filterType of [0, 1, 2, 3, 4]) {
        const decoded = decodePng(pngBase64FromPixels(width, height, pixels, filterType));
        assert.equal(decoded.width, width);
        assert.equal(decoded.height, height);
        assert.ok(decoded.pixels.equals(pixels), `filter ${filterType} must round-trip byte-exactly`);
    }
});

/** Follow-up request shapes per wire: newest instruction, then this turn's
 * tool call and result. `imagePart` is the typed image content of the tool
 * result, or null when the client dropped the image. */
const FORCE_PROMPT = "Force a real tool call: call the take_screenshot tool exactly once, wait for its output, then reply with ONLY the dominant color word.";

function chatFollowUp(imagePart) {
    const resultParts = [text("Images returned by tool call call_val_1:")];
    if (imagePart) resultParts.push(imagePart);
    return {
        tools: [screenshotTool],
        messages: [
            user(FORCE_PROMPT),
            { role: "assistant", content: null, tool_calls: [{ id: "call_val_1", type: "function", function: { name: screenshotTool.function.name, arguments: "{}" } }] },
            user(resultParts),
        ],
    };
}
const chatImage = (url) => ({ type: "image_url", image_url: { url } });

function responsesFollowUp(imagePart) {
    const output = imagePart ? [imagePart] : [];
    return {
        tools: [{ type: "function", name: screenshotTool.function.name }],
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: FORCE_PROMPT }] },
            { type: "function_call", name: screenshotTool.function.name, call_id: "call_val_1", arguments: "{}" },
            { type: "function_call_output", call_id: "call_val_1", output },
            { type: "message", role: "user", content: [{ type: "input_text", text: "Images returned by tool call call_val_1:" }] },
        ],
    };
}
const responsesImage = (url) => ({ type: "input_image", image_url: url });

function anthropicFollowUp(imagePart) {
    const content = imagePart ? [imagePart] : [];
    return {
        tools: [{ name: screenshotTool.function.name }],
        messages: [
            user([{ type: "text", text: FORCE_PROMPT }]),
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: screenshotTool.function.name, input: {} }] },
            user([{ type: "tool_result", tool_use_id: "toolu_1", content }, { type: "text", text: "Images returned by tool call toolu_1:" }]),
        ],
    };
}
const anthropicImage = (url) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: url.replace(/^data:image\/png;base64,/, "") } });

test("current-tail typed images are extracted on every wire; history-only ones are not", () => {
    const url = shotPngUrl("blue", 0x0c0d01);
    for (const [body, wire] of [[chatFollowUp(chatImage(url)), "chat"], [responsesFollowUp(responsesImage(url)), "responses"], [anthropicFollowUp(anthropicImage(url)), "anthropic"]]) {
        const view = normalizeRequest(body, wire);
        assert.equal(view.tailImages.length, 1, `${wire}: exactly the current turn's image in the tail`);
        assert.equal(classifyImageDataUrl(view.tailImages[0]), "blue");
        assert.ok(view.hasImage, `${wire}: typed image detected`);
    }
    // The same image sitting BEFORE a newer instruction is history, not the
    // current turn's tail.
    const historyOnly = {
        tools: [screenshotTool],
        messages: [
            user([text("Images returned by tool call call_old:"), { type: "image_url", image_url: { url } }]),
            user("Force a real tool call: call the take_screenshot tool again now."),
        ],
    };
    const view = normalizeRequest(historyOnly, "chat");
    assert.equal(view.tailImages.length, 0);
    assert.ok(view.hasImage, "history image still counts for hasImage");
});

test("screenshot follow-up whose tail lacks a typed image answers image-missing on every wire", () => {
    // The label/result message is present, the typed image is not: the
    // tool "completed" but the client dropped or flattened the image.
    for (const [body, wire] of [[chatFollowUp(null), "chat"], [responsesFollowUp(null), "responses"], [anthropicFollowUp(null), "anthropic"]]) {
        assert.deepEqual(selectResponse(body, 1, wire), { kind: "image-missing", text: "mock vendor: screenshot tool result carried no image" });
    }
});

test("byte-identical image re-served by a later tool round answers image-stale; a same-round retry does not", () => {
    const answeredImages = new Map();
    const body = chatFollowUp(chatImage(shotPngUrl("magenta", 0x0e0f01)));
    const first = selectResponse(body, 1, "chat", 3, answeredImages);
    assert.equal(first.kind, "image");
    assert.equal(first.text, "magenta");
    answeredImages.set(first.imagePayload, 1); // the server records it on answer
    // Plain retry of the same round (tool-call counter unchanged).
    const retry = selectResponse(body, 1, "chat", 3, answeredImages);
    assert.equal(retry.kind, "image");
    assert.equal(retry.text, "magenta");
    // A NEW forced round (counter advanced) presenting the same bytes.
    assert.deepEqual(selectResponse(body, 2, "chat", 3, answeredImages), { kind: "image-stale", text: "mock vendor: old image re-served" });
});

test("typed image that is not a decodable PNG answers image-undecodable", () => {
    const body = chatFollowUp(chatImage(`data:image/png;base64,${png}`)); // header-only, not a real PNG
    const answer = selectResponse(body, 1, "chat");
    assert.equal(answer.kind, "image-undecodable");
    assert.match(answer.text, /undecodable/);
});

test("an image from an earlier round does not satisfy a new screenshot instruction", () => {
    const url = shotPngUrl("cyan", 0x0a0e02);
    const body = {
        tools: [screenshotTool],
        messages: [
            user([text("Images returned by tool call call_old:"), { type: "image_url", image_url: { url } }]),
            user("please take_screenshot again now"),
        ],
    };
    const answer = selectResponse(body, 1, "chat");
    assert.equal(answer.kind, "tool", `old-history image must force a fresh tool round, got ${answer.kind}`);
    assert.equal(answer.name, screenshotTool.function.name);
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
    const url = shotPngUrl("red", 0x010203);
    const chatBody = { messages: [user([text("Images returned by tool call call_val_1:"), { type: "image_url", image_url: { url } }])] };
    const responsesBody = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Images returned by tool call call_val_1:" }, { type: "input_image", image_url: url }] }] };
    const anthropicBody = { messages: [user([{ type: "text", text: "Images returned by tool call call_val_1:" }, { type: "image", source: { type: "base64", media_type: "image/png", data: url.replace(/^data:image\/png;base64,/, "") } }])] };
    // The server derives the wire from the request path; chat and anthropic
    // bodies alone are ambiguous, so detection is asserted per named wire.
    assert.ok(normalizeRequest(chatBody, "chat").hasImage);
    assert.ok(normalizeRequest(responsesBody, "responses").hasImage);
    assert.ok(normalizeRequest(anthropicBody, "anthropic").hasImage);
    for (const [body, wire] of [[chatBody, "chat"], [responsesBody, "responses"], [anthropicBody, "anthropic"]]) {
        const answer = selectResponse(body, 0, wire);
        assert.equal(answer.kind, "image");
        assert.equal(answer.text, "red", `${wire}: classified color answer`);
    }
    const textOnly = { messages: [user(`the prefix ${png} as plain text`)] };
    assert.ok(!normalizeRequest(textOnly).hasImage);
});

test("responses namespace advertisement expands to the flat callback name", () => {
    const body = {
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "please take_screenshot now" }] }],
        tools: [
            { type: "function", name: "exec_command" },
            { type: "namespace", name: "mcp__screenshots", tools: [{ type: "function", name: "take_screenshot" }] },
        ],
    };
    const view = normalizeRequest(body);
    assert.ok(view.toolNames.includes("mcp__screenshots__take_screenshot"), `toolNames: ${view.toolNames.join(", ")}`);
    assert.deepEqual(selectResponse(body), { kind: "tool", name: "mcp__screenshots__take_screenshot" });
});

test("anthropic tool_result image blocks count as typed images", () => {
    const url = shotPngUrl("red", 0x030405);
    const body = {
        messages: [
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__screenshots__take_screenshot", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: url.replace(/^data:image\/png;base64,/, "") } }] }, { type: "text", text: "Images returned by tool call toolu_1:" }] },
        ],
    };
    const view = normalizeRequest(body, "anthropic");
    assert.ok(view.hasImage, "nested tool_result image should be detected");
    assert.equal(view.tailImages.length, 1, "current-turn tail image extracted from the tool_result block");
    const answer = selectResponse(body, 0, "anthropic");
    assert.equal(answer.kind, "image");
    assert.equal(answer.text, "red");
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
