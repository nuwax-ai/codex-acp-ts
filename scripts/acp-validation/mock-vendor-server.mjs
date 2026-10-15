// Local mock vendor for the credential-free ACP validation run.
//
// Speaks just enough of the OpenAI-compatible chat wire (POST
// /chat/completions, SSE response) to drive the six validation scenarios.
// Every incoming request is recorded to a JSONL file so the driver can make
// machine-checked assertions (env passthrough, typed image delivery,
// compaction input, persisted-history recall) without any real vendor or
// credential. Answers are scripted; where a "smart" answer would be needed
// (compaction summary, recall) the response is derived from the actual
// incoming request text, so passing still proves codex sent the right bytes.
//
// Responses are picked by inspecting the newest user message, not by request
// index, so retries and extra attempts stay testable.
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

/** One chat SSE response carrying the given assistant content. */
function textResponse(content) {
    const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
            id: "mock-chatcmpl",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
    const body =
        chunk({ role: "assistant", content: "" }) +
        chunk({ content }) +
        chunk({}, "stop") +
        "data: [DONE]\n\n";
    return body;
}

function toolCallResponse(name, args) {
    const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
            id: "mock-chatcmpl",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
    const body =
        chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_val_1", type: "function", function: { name, arguments: args } }] }) +
        chunk({}, "tool_calls") +
        "data: [DONE]\n\n";
    return body;
}

/** Slow essay stream: deltas every 250ms for a bounded window so any client
 * retry after a cancel drains quickly instead of holding the turn open. */
function handleEssay(res) {
    res.writeHead(200, sseHeaders);
    let i = 0;
    const MAX = 48; // ~12s of streaming, then a normal end
    const timer = setInterval(() => {
        i += 1;
        const delta = `data: ${JSON.stringify({
            id: "mock-chatcmpl",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: `essay paragraph ${i} about ocean currents. ` }, finish_reason: null }],
        })}\n\n`;
        if (!res.write(delta)) {
            clearInterval(timer);
            res.end();
        }
        if (i > MAX) {
            clearInterval(timer);
            res.write("data: [DONE]\n\n");
            res.end();
        }
    }, 250);
    res.on("close", () => clearInterval(timer));
}

// Rig may merge adjacent user messages into separate text parts. The newest
// instruction is the final text part, not a concatenation that re-matches an
// interrupted essay or a transcript quoted for the guardian reviewer.
export function latestUserText(parsed) {
    const messages = parsed["messages"] ?? [];
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

export function selectResponse(parsed, screenshotToolCalls = 0) {
    const schema = parsed.response_format?.json_schema?.schema;
    if (schema?.properties?.outcome?.enum?.includes("allow")) {
        // A deterministic mock of the separate guardian classifier. This
        // proves routing/JSON parsing; it does not test approval policy.
        return { kind: "guardian", text: JSON.stringify({ outcome: "allow" }) };
    }
    if (schema?.properties?.title) {
        return { kind: "title", text: JSON.stringify({ title: "ACP mock acceptance" }) };
    }
    const userText = latestUserText(parsed);
    const allText = JSON.stringify(parsed.messages ?? []);
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
    if (/take_screenshot/i.test(userText)) {
        if (allText.includes(RED_PNG_PREFIX)) return { kind: "image", text: "red" };
        const tool = (parsed.tools ?? []).find((tool) =>
            tool.function?.name === "mcp__screenshots__take_screenshot");
        if (!tool) return { kind: "missing-tool", text: "mock vendor: screenshot tool is not advertised" };
        if (screenshotToolCalls >= 3) {
            return { kind: "tool-budget", text: "mock vendor: screenshot tool never produced an image" };
        }
        return { kind: "tool", name: tool.function.name };
    }
    if (userText.includes("pong")) return { kind: "ping", text: "pong" };
    return { kind: "unscripted", text: "mock vendor: no scripted answer for this request" };
}

export function startMockServer({ port, recordPath, maxRequests = 48 }) {
    let screenshotToolCalls = 0;
    let requests = 0;
    const server = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200).end("ok");
            return;
        }
        if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
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
            const response = selectResponse(parsed, screenshotToolCalls);
            fs.appendFileSync(recordPath, `${JSON.stringify({
                ts: new Date().toISOString(), auth: req.headers.authorization ?? null,
                kind: response.kind, body,
            })}\n`);
            if (response.kind === "essay") { handleEssay(res); return; }
            res.writeHead(200, sseHeaders);
            if (response.kind === "tool") {
                screenshotToolCalls += 1;
                res.end(toolCallResponse(response.name, "{}"));
            } else res.end(textResponse(response.text));
        });
    });
    server.listen(port, "127.0.0.1", () => {
        console.log(`mock vendor listening on http://127.0.0.1:${server.address().port}`);
    });
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const recordPath = process.env["MOCK_RECORD_PATH"];
    if (!recordPath) { console.error("MOCK_RECORD_PATH is required"); process.exit(2); }
    startMockServer({ port: Number(process.env["MOCK_PORT"] ?? 47613), recordPath });
}
