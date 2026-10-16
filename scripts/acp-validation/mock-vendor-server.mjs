// Local mock vendor for the credential-free ACP validation run.
//
// Serves all three provider wires on one port, selected by request path:
//   POST /v1/chat/completions  — OpenAI Chat-Completions (SSE chunks)
//   POST /v1/responses         — OpenAI Responses passthrough (SSE events)
//   POST /v1/messages          — Anthropic Messages (SSE events)
// Every incoming request is recorded to a JSONL file (with its wire) so the
// driver can make machine-checked assertions (env passthrough, typed image
// delivery, compaction input, persisted-history recall) without any real
// vendor or credential. Answers are scripted; where a "smart" answer would
// be needed (compaction summary, recall) the response is derived from the
// actual incoming request text, so passing still proves codex sent the right
// bytes.
//
// Responses are picked by inspecting the newest user message, not by request
// index, so retries and extra attempts stay testable. Request bodies are
// normalized to a wire-independent view first (see `normalizeRequest`), so
// the scenario logic cannot accidentally depend on one vendor's field names.
import http from "node:http";
import fs from "node:fs";
import { pathToFileURL } from "node:url";


const SESSION_TOKEN = "ACP-COLD-42";
const RED_PNG_PREFIX = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHe";

const sseHeaders = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
};

/** Detect the wire from the request path. */
export function wireForPath(pathname) {
    if (pathname === "/v1/chat/completions") return "chat";
    if (pathname === "/v1/responses") return "responses";
    if (pathname === "/v1/messages") return "anthropic";
    return null;
}

// ---------------------------------------------------------------------------
// Request normalization
// ---------------------------------------------------------------------------

/**
 * Normalize any wire's request body into a common view:
 *   messages  — chat-like [{role, content}] where text parts are
 *               {type:"text", text} regardless of the wire's native part type
 *   allText   — stringified full payload for substring recall checks
 *   schema    — structured-output schema when present (title/guardian)
 *   toolNames — advertised function tool names
 *   hasImage  — the synthetic red PNG arrived as a typed image part
 * When the wire is known from the request path it is passed explicitly; the
 * body-only inference below is a fallback for direct unit-test callers
 * (chat and anthropic bodies are ambiguous once output_config is absent).
 * Idempotent: a previously normalized view passes through unchanged.
 */
export function normalizeRequest(parsed, wireHint) {
    if (parsed && parsed.__normalized) return parsed;
    let wire;
    if (wireHint) wire = wireHint;
    else if (Array.isArray(parsed?.input)) wire = "responses";
    else if (parsed?.output_config?.format?.schema) wire = "anthropic";
    else if (Array.isArray(parsed?.messages)) wire = "chat";
    else wire = "chat";

    let messages = [];
    let allText = "";
    let schema;
    let toolNames = [];
    let hasImage = false;

    if (wire === "responses") {
        for (const item of parsed.input) {
            if (item?.type !== "message") continue;
            const content = Array.isArray(item.content) ? item.content : [];
            const parts = content.map((part) => {
                if (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text") {
                    return { type: "text", text: part.text ?? "" };
                }
                if (part?.type === "input_image" && typeof part.image_url === "string" && part.image_url.includes(RED_PNG_PREFIX)) {
                    hasImage = true;
                }
                return part;
            });
            messages.push({ role: item.role, content: parts });
        }
        allText = JSON.stringify(parsed.input);
        schema = parsed.text?.format?.schema;
        // Responses advertises MCP tools as namespaces: {type:"namespace",
        // name:"mcp__srv", tools:[{name:"tool"}]}. The canonical callback is
        // the flat `mcp__srv__tool` name (see codex flat_name_index), so
        // nested tools are expanded into the flat form.
        for (const tool of parsed.tools ?? []) {
            if (tool?.type === "namespace") {
                for (const nested of tool.tools ?? []) {
                    if (nested?.name) toolNames.push(`${tool.name}__${nested.name}`);
                }
            } else if (tool?.name) {
                toolNames.push(tool.name);
            }
        }
    } else {
        messages = parsed.messages ?? [];
        allText = JSON.stringify(parsed.messages ?? []);
        if (wire === "anthropic") {
            schema = parsed.output_config?.format?.schema;
            toolNames = (parsed.tools ?? []).map((tool) => tool?.name).filter(Boolean);
            for (const message of messages) {
                for (const block of Array.isArray(message?.content) ? message.content : []) {
                    const isImage = block?.type === "image" && block?.source?.data?.includes(RED_PNG_PREFIX);
                    // Images ride inside tool_result content arrays as well.
                    const nestedImage = Array.isArray(block?.content)
                        && block.content.some((part) => part?.type === "image" && part?.source?.data?.includes(RED_PNG_PREFIX));
                    if (isImage || nestedImage) hasImage = true;
                }
            }
        } else {
            schema = parsed.response_format?.json_schema?.schema;
            toolNames = (parsed.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean);
            for (const message of messages) {
                for (const part of Array.isArray(message?.content) ? message.content : []) {
                    if (part?.type === "image_url" && part?.image_url?.url?.includes(RED_PNG_PREFIX)) hasImage = true;
                }
            }
        }
    }
    return {
        __normalized: true,
        wire,
        messages,
        allText,
        schema,
        toolNames,
        hasImage,
        model: parsed?.model,
    };
}

// Rig may merge adjacent user messages into separate text parts. The newest
// instruction is the final text part, not a concatenation that re-matches an
// interrupted essay or a transcript quoted for the guardian reviewer.
export function latestUserText(view) {
    const messages = view.__normalized ? view.messages : (view.messages ?? []);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m["role"] !== "user") continue;
        const content = m["content"];
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            const text = content.filter((c) => c["type"] === "text").at(-1)?.["text"];
            if (text) return text;
        }
    }
    return "";
}

export function selectResponse(parsed, screenshotToolCalls = 0, wireHint, toolBudget = 3) {
    const view = normalizeRequest(parsed, wireHint);
    const schema = view.schema;
    if (schema?.properties?.outcome?.enum?.includes("allow")) {
        // A deterministic mock of the separate guardian classifier. This
        // proves routing/JSON parsing; it does not test approval policy.
        return { kind: "guardian", text: JSON.stringify({ outcome: "allow" }) };
    }
    if (schema?.properties?.title) {
        return { kind: "title", text: JSON.stringify({ title: "ACP mock acceptance" }) };
    }
    const userText = latestUserText(view);
    const allText = view.allText;
    if (/CONTEXT CHECKPOINT COMPACTION/i.test(userText)) {
        return { kind: "compaction", text: allText.includes(SESSION_TOKEN)
            ? `Summary: the user asked to remember ${SESSION_TOKEN}.`
            : "Summary: the remembered token was absent from the input." };
    }
    if (/post-compact-ok/i.test(userText)) {
        return { kind: "continuation", text: "post-compact-ok" };
    }
    if (/What token did I ask you to remember/i.test(userText)) {
        return { kind: "recall", text: allText.includes(SESSION_TOKEN)
            ? SESSION_TOKEN : "The remembered token was absent from the input." };
    }
    if (/Images returned by tool call/i.test(userText) && allText.includes(RED_PNG_PREFIX)) {
        return { kind: "image", text: "red" };
    }
    if (/essay about ocean currents/i.test(userText)) return { kind: "essay" };
    if (/hang before headers/i.test(userText)) {
        // Stress-only: hold the connection open without ever answering; the
        // client must cancel to release it.
        return { kind: "hang" };
    }
    if (/take_screenshot/i.test(userText)) {
        if (allText.includes(RED_PNG_PREFIX)) return { kind: "image", text: "red" };
        const name = view.toolNames.find((tool) => tool === "mcp__screenshots__take_screenshot");
        if (!name) return { kind: "missing-tool", text: "mock vendor: screenshot tool is not advertised" };
        if (screenshotToolCalls >= toolBudget) {
            return { kind: "tool-budget", text: "mock vendor: screenshot tool never produced an image" };
        }
        return { kind: "tool", name };
    }
    if (userText.includes("pong")) return { kind: "ping", text: "pong" };
    return { kind: "unscripted", text: "mock vendor: no scripted answer for this request" };
}

// ---------------------------------------------------------------------------
// Wire-specific SSE emitters
// ---------------------------------------------------------------------------

/** One chat SSE response carrying the given assistant content. */
function chatText(content) {
    const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
            id: "mock-chatcmpl",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
    return (
        chunk({ role: "assistant", content: "" }) +
        chunk({ content }) +
        chunk({}, "stop") +
        "data: [DONE]\n\n"
    );
}

function chatToolCall(name, args) {
    const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
            id: "mock-chatcmpl",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
    return (
        chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_val_1", type: "function", function: { name, arguments: args } }] }) +
        chunk({}, "tool_calls") +
        "data: [DONE]\n\n"
    );
}

const anthropicFrame = (payload) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;

function anthropicText(content) {
    return (
        anthropicFrame({ type: "message_start", message: { id: "msg-val", type: "message", role: "assistant", content: [], model: "acp-val-mock-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } } }) +
        anthropicFrame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } }) +
        anthropicFrame({ type: "content_block_stop", index: 0 }) +
        anthropicFrame({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
        anthropicFrame({ type: "message_stop" })
    );
}

function anthropicToolCall(name, args) {
    return (
        anthropicFrame({ type: "message_start", message: { id: "msg-val", type: "message", role: "assistant", content: [], model: "acp-val-mock-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } } }) +
        anthropicFrame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_val_1", name, input: {} } }) +
        anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }) +
        anthropicFrame({ type: "content_block_stop", index: 0 }) +
        anthropicFrame({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }) +
        anthropicFrame({ type: "message_stop" })
    );
}

const responsesFrame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

function responsesText(content) {
    return (
        responsesFrame({ type: "response.created", response: { id: "resp-val", model: "acp-val-mock-model" } }) +
        responsesFrame({ type: "response.output_item.added", item: { type: "message", role: "assistant", content: [], id: "msg_val_1" } }) +
        responsesFrame({ type: "response.output_text.delta", item_id: "msg_val_1", delta: content }) +
        responsesFrame({ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: content }], id: "msg_val_1" } }) +
        responsesFrame({ type: "response.completed", response: { id: "resp-val", usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } } })
    );
}

function responsesToolCall(name, args) {
    return (
        responsesFrame({ type: "response.created", response: { id: "resp-val", model: "acp-val-mock-model" } }) +
        responsesFrame({ type: "response.output_item.added", item: { type: "function_call", id: "fc_val_1", call_id: "call_val_1", name, arguments: "" } }) +
        responsesFrame({ type: "response.function_call_arguments.delta", item_id: "fc_val_1", delta: args }) +
        responsesFrame({ type: "response.output_item.done", item: { type: "function_call", id: "fc_val_1", call_id: "call_val_1", name, arguments: args } }) +
        responsesFrame({ type: "response.completed", response: { id: "resp-val", output: [], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } } })
    );
}

export function textResponse(wire, content) {
    if (wire === "anthropic") return anthropicText(content);
    if (wire === "responses") return responsesText(content);
    return chatText(content);
}

export function toolCallResponse(wire, name, args) {
    if (wire === "anthropic") return anthropicToolCall(name, args);
    if (wire === "responses") return responsesToolCall(name, args);
    return chatToolCall(name, args);
}

/** Slow essay stream: deltas every 250ms for a bounded window so any client
 * retry after a cancel drains quickly instead of holding the turn open. */
export function streamEssay(wire, res) {
    res.writeHead(200, sseHeaders);
    if (wire === "anthropic") {
        res.write(anthropicFrame({ type: "message_start", message: { id: "msg-val", type: "message", role: "assistant", content: [], model: "acp-val-mock-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } } }));
        res.write(anthropicFrame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    } else if (wire === "responses") {
        res.write(responsesFrame({ type: "response.created", response: { id: "resp-val", model: "acp-val-mock-model" } }));
        res.write(responsesFrame({ type: "response.output_item.added", item: { type: "message", role: "assistant", content: [], id: "msg_val_1" } }));
    } else {
        res.write(`data: ${JSON.stringify({ id: "mock-chatcmpl", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
    }
    let i = 0;
    const MAX = 48; // ~12s of streaming, then a normal end
    const timer = setInterval(() => {
        i += 1;
        const text = `essay paragraph ${i} about ocean currents. `;
        let frame;
        if (wire === "anthropic") frame = anthropicFrame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
        else if (wire === "responses") frame = responsesFrame({ type: "response.output_text.delta", item_id: "msg_val_1", delta: text });
        else frame = `data: ${JSON.stringify({ id: "mock-chatcmpl", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
        if (!res.write(frame)) {
            clearInterval(timer);
            res.end();
            return;
        }
        if (i > MAX) {
            clearInterval(timer);
            if (wire === "anthropic") {
                res.write(anthropicFrame({ type: "content_block_stop", index: 0 }));
                res.write(anthropicFrame({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }));
                res.write(anthropicFrame({ type: "message_stop" }));
            } else if (wire === "responses") {
                res.write(responsesFrame({ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "essay complete" }], id: "msg_val_1" } }));
                res.write(responsesFrame({ type: "response.completed", response: { id: "resp-val", usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } } }));
            } else {
                res.write("data: [DONE]\n\n");
            }
            res.end();
        }
    }, 250);
    res.on("close", () => clearInterval(timer));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function startMockServer({ port, recordPath, maxRequests = 48, toolBudget = 3 }) {
    let screenshotToolCalls = 0;
    let requests = 0;
    let openSockets = 0;
    const server = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200).end("ok");
            return;
        }
        if (req.method === "GET" && req.url === "/stats") {
            res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({ openSockets, requests }),
            );
            return;
        }
        const wire = req.method === "POST" ? wireForPath(new URL(req.url, "http://localhost").pathname) : null;
        if (!wire) {
            res.writeHead(404).end();
            return;
        }
        if (++requests > maxRequests) {
            res.writeHead(429).end("mock request budget exhausted");
            return;
        }
        let body = "";
        req.on("data", (data) => {
            body += data;
            if (Buffer.byteLength(body) > 32 * 1024 * 1024) req.destroy();
        });
        req.on("end", () => {
            let parsed;
            try { parsed = JSON.parse(body); }
            catch { res.writeHead(400).end("invalid JSON"); return; }
            const response = selectResponse(parsed, screenshotToolCalls, wire, toolBudget);
            fs.appendFileSync(recordPath, `${JSON.stringify({
                ts: new Date().toISOString(), wire, auth: req.headers.authorization ?? null,
                xApi: req.headers["x-api-key"] ?? null,
                kind: response.kind, body,
            })}\n`);
            if (response.kind === "essay") { streamEssay(wire, res); return; }
            if (response.kind === "hang") {
                // Never answer; release only when the client cancels.
                return;
            }
            res.writeHead(200, sseHeaders);
            if (response.kind === "tool") {
                screenshotToolCalls += 1;
                res.end(toolCallResponse(wire, response.name, "{}"));
            } else res.end(textResponse(wire, response.text));
        });
    });
    server.on("connection", (socket) => {
        openSockets += 1;
        socket.on("close", () => { openSockets -= 1; });
    });
    server.listen(port, "127.0.0.1", () => {
        console.log(`mock vendor listening on http://127.0.0.1:${server.address().port}`);
    });
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const recordPath = process.env["MOCK_RECORD_PATH"];
    if (!recordPath) { console.error("MOCK_RECORD_PATH is required"); process.exit(2); }
    startMockServer({
        port: Number(process.env["MOCK_PORT"] ?? 47613),
        recordPath,
        maxRequests: Number(process.env["MOCK_MAX_REQUESTS"] ?? 48),
        toolBudget: Number(process.env["MOCK_TOOL_BUDGET"] ?? 3),
    });
}
