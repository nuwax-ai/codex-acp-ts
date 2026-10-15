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

const PORT = Number(process.env["MOCK_PORT"] ?? 47613);
const RECORD_PATH = process.env["MOCK_RECORD_PATH"];
if (!RECORD_PATH) {
    console.error("MOCK_RECORD_PATH is required");
    process.exit(2);
}

const SESSION_TOKEN = "ACP-COLD-42";
const RED_PNG_PREFIX = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHe";
let SCREENSHOT_TOOL_CALLS = 0;

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

function latestUserText(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        return "";
    }
    const messages = parsed["messages"] ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (m["role"] !== "user") continue;
        const content = m["content"];
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            const text = content.filter((c) => c["type"] === "text").map((c) => c["text"] ?? "").join(" ");
            if (text) return text;
        }
    }
    return "";
}

const server = http.createServer((req, res) => {
    if (req["method"] === "GET" && req["url"]?.includes("/health")) {
        res.writeHead(200).end("ok");
        return;
    }
    if (req["method"] !== "POST" || !req["url"]?.includes("/chat/completions")) {
        res.writeHead(404).end();
        return;
    }
    let body = "";
    req.on("data", (d) => {
        body += d;
    });
    req.on("end", () => {
        const record = {
            ts: new Date().toISOString(),
            auth: req["headers"]["authorization"] ?? null,
            body,
        };
        fs.appendFileSync(RECORD_PATH, `${JSON.stringify(record)}\n`);

        const userText = latestUserText(body);
        const allText = body; // tool results and history live in the body too

        if (/essay about ocean currents/i.test(userText)) {
            handleEssay(res);
            return;
        }
        if (/take_screenshot/i.test(userText) && !allText.includes(RED_PNG_PREFIX)) {
            // Codex exposes MCP tools under their namespaced flat name
            // (mcp__<server>__<tool>), not the raw MCP tool name.
            const TOOL_NAME = "mcp__screenshots__take_screenshot";
            // Bound total tool requests: history-based counting alone can be
            // defeated when the client retries with a clean history. After a
            // few attempts answer plainly so a registration failure surfaces
            // as a fast, visible failure instead of an infinite tool loop.
            SCREENSHOT_TOOL_CALLS += 1;
            if (SCREENSHOT_TOOL_CALLS > 3) {
                res.writeHead(200, sseHeaders);
                res.end(textResponse("mock vendor: the screenshot tool never produced an image (not registered or result dropped)"));
                return;
            }
            // First screenshot turn: ask for the tool. The follow-up request
            // will carry the typed image; then we answer with the color.
            res.writeHead(200, sseHeaders);
            res.end(toolCallResponse(TOOL_NAME, "{}"));
            return;
        }
        if (allText.includes(RED_PNG_PREFIX)) {
            res.writeHead(200, sseHeaders);
            res.end(textResponse("red"));
            return;
        }
        if (/dominant color/i.test(userText)) {
            res.writeHead(200, sseHeaders);
            res.end(textResponse("red"));
            return;
        }
        if (userText.includes("pong")) {
            res.writeHead(200, sseHeaders);
            res.end(textResponse("pong"));
            return;
        }
        if (/post-compact-ok/i.test(userText)) {
            res.writeHead(200, sseHeaders);
            res.end(textResponse("post-compact-ok"));
            return;
        }
        if (allText.includes(SESSION_TOKEN) && /token|remember/i.test(allText)) {
            // Recall and compaction requests: answer with the token only when
            // codex actually sent it back to us.
            res.writeHead(200, sseHeaders);
            res.end(textResponse(SESSION_TOKEN));
            return;
        }
        if (/compact|summar/i.test(userText) || /CONTEXT CHECKPOINT COMPACTION/i.test(allText)) {
            // Compaction request whose history already lost the token: the
            // summary honestly says so, and the recall assertion will fail.
            res.writeHead(200, sseHeaders);
            res.end(textResponse("summary: earlier turns; the remembered token was not present in the input"));
            return;
        }
        res.writeHead(200, sseHeaders);
        res.end(textResponse("mock vendor: no scripted answer for this request"));
    });
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`mock vendor listening on http://127.0.0.1:${PORT}`);
});
