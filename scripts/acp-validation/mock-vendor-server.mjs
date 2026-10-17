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
//
// Screenshot rounds are verified, not assumed: the typed image carried by
// the CURRENT turn's tail is extracted per wire, decoded (minimal PNG
// decoder: base64 -> IHDR -> IDAT inflate -> unfilter filters 0-4, 8-bit
// RGB/RGBA) and answered with the CLASSIFIED color name. A tail that lacks
// a typed image answers kind image-missing; an undecodable image answers
// image-undecodable; byte-identical re-use of an image already answered in
// an earlier tool round answers image-stale. The stress driver fails the
// round on any of those kinds, and cross-checks the color against
// shot-server.mjs's ground-truth file — an "old image" or a dropped image
// can no longer produce a green round.
import http from "node:http";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { crc32, SHOT_PALETTE } from "./shot-server.mjs";


const SESSION_TOKEN = "ACP-COLD-42";

// ---------------------------------------------------------------------------
// Minimal PNG decoder + palette classifier (review item 6)
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Strip an optional data-URL prefix; returns the raw base64 payload. */
function base64Payload(input) {
    const value = String(input);
    const marker = ";base64,";
    const at = value.indexOf(marker);
    return at >= 0 ? value.slice(at + marker.length) : value;
}

function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

/**
 * Decode a base64/data-URL PNG (8-bit, color type 2 RGB or 6 RGBA,
 * non-interlaced, any scanline filter 0-4). Returns
 * {width, height, channels, pixels} where pixels is a Buffer of
 * width*height*channels bytes. Throws on anything else — the caller turns
 * the error into an image-undecodable answer, so a mangled or foreign
 * image can never fake a green round.
 */
export function decodePng(input) {
    const buffer = Buffer.from(base64Payload(input), "base64");
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error("not a PNG (bad signature)");
    }
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    let interlace = -1;
    const idatChunks = [];
    let sawIend = false;
    let offset = 8;
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString("ascii", offset + 4, offset + 8);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (data.length !== length) throw new Error(`truncated ${type} chunk`);
        if (crc32(Buffer.concat([buffer.subarray(offset + 4, offset + 8), data])) !== buffer.readUInt32BE(offset + 8 + length)) {
            throw new Error(`CRC mismatch in ${type} chunk`);
        }
        if (type === "IHDR") {
            if (length !== 13) throw new Error("malformed IHDR");
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === "IDAT") {
            idatChunks.push(data);
        } else if (type === "IEND") {
            sawIend = true;
            break;
        }
        offset += 12 + length;
    }
    if (!width || !height) throw new Error("missing IHDR");
    if (!sawIend) throw new Error("missing IEND");
    if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
    if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported color type ${colorType}`);
    if (interlace !== 0) throw new Error("interlaced PNG not supported");
    if (width * height <= 0) throw new Error("empty pixel area");
    const channels = colorType === 6 ? 4 : 3;
    const stride = width * channels;
    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    if (raw.length < (stride + 1) * height) throw new Error("IDAT shorter than image size");
    const pixels = Buffer.alloc(stride * height);
    const zeros = Buffer.alloc(stride);
    let previous = zeros;
    for (let y = 0; y < height; y += 1) {
        const lineStart = y * (stride + 1);
        const filterType = raw[lineStart];
        const line = raw.subarray(lineStart + 1, lineStart + 1 + stride);
        const outStart = y * stride;
        switch (filterType) {
            case 0:
                line.copy(pixels, outStart);
                break;
            case 1:
                for (let i = 0; i < stride; i += 1) {
                    pixels[outStart + i] = (line[i] + (i >= channels ? pixels[outStart + i - channels] : 0)) & 0xff;
                }
                break;
            case 2:
                for (let i = 0; i < stride; i += 1) {
                    pixels[outStart + i] = (line[i] + previous[i]) & 0xff;
                }
                break;
            case 3:
                for (let i = 0; i < stride; i += 1) {
                    pixels[outStart + i] = (line[i] + (((i >= channels ? pixels[outStart + i - channels] : 0) + previous[i]) >> 1)) & 0xff;
                }
                break;
            case 4:
                for (let i = 0; i < stride; i += 1) {
                    const a = i >= channels ? pixels[outStart + i - channels] : 0;
                    const b = i >= channels ? previous[i - channels] : 0;
                    pixels[outStart + i] = (line[i] + paethPredictor(a, previous[i], b)) & 0xff;
                }
                break;
            default:
                throw new Error(`unsupported scanline filter type ${filterType}`);
        }
        previous = pixels.subarray(outStart, outStart + stride);
    }
    return { width, height, channels, pixels };
}

/** Average the RGB channels and return the nearest palette color name. */
export function classifyPng(image) {
    const { width, height, channels, pixels } = image;
    let r = 0;
    let g = 0;
    let b = 0;
    const count = width * height;
    for (let i = 0; i < count; i += 1) {
        r += pixels[i * channels];
        g += pixels[i * channels + 1];
        b += pixels[i * channels + 2];
    }
    r /= count;
    g /= count;
    b /= count;
    let best = null;
    let bestDistance = Infinity;
    for (const [name, [pr, pg, pb]] of SHOT_PALETTE) {
        const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = name;
        }
    }
    if (!best) throw new Error("no palette color to classify against");
    return best;
}

/** Decode + classify a base64 or data-URL PNG in one step. */
export function classifyImageDataUrl(input) {
    return classifyPng(decodePng(input));
}


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
 *   hasImage  — a typed image part arrived ANYWHERE in the request
 *               (history included); scenario answers never rely on this
 *               alone — see tailImages
 *   tailImages — base64 payloads of the typed image parts in the CURRENT
 *               turn's tail (everything after the newest real instruction),
 *               in request order. This is what distinguishes "this round's
 *               fresh screenshot result" from "an image somewhere in
 *               history": responses `function_call_output.output[]`
 *               input_image parts, anthropic `tool_result` nested image
 *               blocks, chat `image_url` parts of tail messages.
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
    /** Raw wire items that follow the newest user message — used to tell
     * whether the CURRENT turn already carries a screenshot tool result
     * (history from earlier turns must not suppress a forced tool call). */
    let tailAfterLastUser = "";
    const tailImages = [];

    if (wire === "responses") {
        const items = parsed.input;
        let lastUser = -1;
        for (let i = items.length - 1; i >= 0; i -= 1) {
            const item = items[i];
            if (item?.type !== "message" || item.role !== "user") continue;
            // Tool-result user items (and codex's generated image label) are
            // not instructions; anchor on the newest real instruction.
            const content = Array.isArray(item.content) ? item.content : [];
            const hasInstruction = content.some((part) =>
                part?.type === "input_text" && part.text && !/^Images returned by tool call/.test(part.text));
            if (hasInstruction) { lastUser = i; break; }
        }
        tailAfterLastUser = JSON.stringify(items.slice(lastUser + 1));
        // Typed images of the current turn: function_call_output items carry
        // the tool's structured result (output[] with input_image parts);
        // label messages may also hold input_image content parts.
        const collectResponsesImages = (parts) => {
            for (const part of parts) {
                if (part?.type === "input_image" && typeof part.image_url === "string") {
                    tailImages.push(base64Payload(part.image_url));
                }
            }
        };
        for (const item of items.slice(lastUser + 1)) {
            if (item?.type === "function_call_output") {
                if (Array.isArray(item.output)) collectResponsesImages(item.output);
            } else if (item?.type === "message" && Array.isArray(item.content)) {
                collectResponsesImages(item.content);
            }
        }
        for (const item of items) {
            if (item?.type === "function_call_output") {
                // Tool results carry typed images in their output array.
                for (const part of Array.isArray(item.output) ? item.output : []) {
                    if (part?.type === "input_image" && typeof part.image_url === "string") hasImage = true;
                }
                continue;
            }
            if (item?.type !== "message") continue;
            const content = Array.isArray(item.content) ? item.content : [];
            const parts = content.map((part) => {
                if (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text") {
                    return { type: "text", text: part.text ?? "" };
                }
                if (part?.type === "input_image" && typeof part.image_url === "string") {
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
        let lastUser = -1;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const m = messages[i];
            if (m?.role !== "user") continue;
            // Tool-result messages carry role "user" too; anchor on the
            // newest message that actually holds an instruction (codex's
            // generated image label is excluded).
            const content = m.content;
            const hasInstruction = typeof content === "string"
                ? content.length > 0 && !/^Images returned by tool call/.test(content)
                : Array.isArray(content) && content.some((part) =>
                    part?.type === "text" && part.text && !/^Images returned by tool call/.test(part.text));
            if (hasInstruction) { lastUser = i; break; }
        }
        const tailMessages = messages.slice(lastUser + 1);
        tailAfterLastUser = JSON.stringify(tailMessages);
        if (wire === "anthropic") {
            // Typed images of the current turn: image blocks (including
            // blocks nested in tool_result content) of tail messages.
            const collectAnthropicImages = (blocks) => {
                for (const block of blocks) {
                    if (block?.type === "image" && typeof block.source?.data === "string") {
                        tailImages.push(base64Payload(block.source.data));
                    }
                }
            };
            for (const m of tailMessages) {
                const content = Array.isArray(m?.content) ? m.content
                    : m?.content && typeof m.content === "object" ? [m.content] : [];
                for (const block of content) {
                    collectAnthropicImages([block]);
                    if (block?.type === "tool_result") {
                        const nested = Array.isArray(block.content) ? block.content
                            : block.content && typeof block.content === "object" ? [block.content] : [];
                        collectAnthropicImages(nested);
                    }
                }
            }
        } else {
            for (const m of tailMessages) {
                for (const part of Array.isArray(m?.content) ? m.content : []) {
                    if (part?.type === "image_url" && typeof part?.image_url?.url === "string") {
                        tailImages.push(base64Payload(part.image_url.url));
                    }
                }
            }
        }
        allText = JSON.stringify(parsed.messages ?? []);
        if (wire === "anthropic") {
            schema = parsed.output_config?.format?.schema;
            toolNames = (parsed.tools ?? []).map((tool) => tool?.name).filter(Boolean);
            for (const message of messages) {
                for (const block of Array.isArray(message?.content) ? message.content : []) {
                    const isImage = block?.type === "image" && typeof block.source?.data === "string";
                    // Images ride inside tool_result content arrays as well.
                    const nestedImage = Array.isArray(block?.content)
                        && block.content.some((part) => part?.type === "image" && typeof part?.source?.data === "string");
                    if (isImage || nestedImage) hasImage = true;
                }
            }
        } else {
            schema = parsed.response_format?.json_schema?.schema;
            toolNames = (parsed.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean);
            for (const message of messages) {
                for (const part of Array.isArray(message?.content) ? message.content : []) {
                    if (part?.type === "image_url" && typeof part?.image_url?.url === "string") hasImage = true;
                }
            }
        }
    }
    return {
        __normalized: true,
        wire,
        messages,
        allText,
        tailAfterLastUser,
        tailImages,
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

/**
 * Pick the scripted response for a request.
 *
 * `answeredImages` (optional Map base64 -> screenshotToolCalls-at-answer)
 * carries per-run freshness state: an image answered during tool round N
 * and re-presented verbatim once the counter has advanced past N is an old
 * image being re-served, answered as kind image-stale. Re-presenting it
 * with an UNCHANGED counter is a plain retry of the same round and is
 * answered normally. The mock server passes one persistent Map; direct
 * unit-test callers get a fresh one per call.
 */
export function selectResponse(parsed, screenshotToolCalls = 0, wireHint, toolBudget = 3, answeredImages = new Map()) {
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
    // Screenshot follow-up: the newest user text is codex's generated label,
    // or the original take_screenshot instruction with this turn's tool
    // call/result already in the tail. Either way the answer must come from
    // the typed image of the CURRENT turn's tail — an image that exists only
    // in older history never satisfies this path.
    const screenshotInCurrentTail = view.tailAfterLastUser.includes("take_screenshot");
    if (/Images returned by tool call/i.test(userText) || (/take_screenshot/i.test(userText) && screenshotInCurrentTail)) {
        if (view.tailImages.length === 0) {
            return { kind: "image-missing", text: "mock vendor: screenshot tool result carried no image" };
        }
        const stalePayload = view.tailImages.find((payload) => {
            const answeredAt = answeredImages.get(payload);
            return answeredAt !== undefined && answeredAt !== screenshotToolCalls;
        });
        if (stalePayload !== undefined) {
            return { kind: "image-stale", text: "mock vendor: old image re-served" };
        }
        try {
            // Answer with the CLASSIFIED color of the newest tail image —
            // the stress driver cross-checks this against shot-server's
            // ground-truth record for the round.
            const payload = view.tailImages[view.tailImages.length - 1];
            return { kind: "image", text: classifyImageDataUrl(payload), imagePayload: payload };
        } catch (error) {
            return { kind: "image-undecodable", text: `mock vendor: typed image undecodable (${String(error?.message ?? error)})` };
        }
    }
    if (/essay about ocean currents/i.test(userText)) return { kind: "essay" };
    if (/hang before headers/i.test(userText)) {
        // Stress-only: hold the connection open without ever answering; the
        // client must cancel to release it.
        return { kind: "hang" };
    }
    if (/take_screenshot/i.test(userText)) {
        // Stress rounds force a REAL tool execution even when an image from
        // an earlier round already sits in history; the forced call repeats
        // until the follow-up request carries this round's result in its
        // tail (handled above).
        const name = view.toolNames.find((tool) => tool === "mcp__screenshots__take_screenshot");
        if (!name) return { kind: "missing-tool", text: "mock vendor: screenshot tool is not advertised" };
        if (screenshotToolCalls >= toolBudget) {
            return { kind: "tool-budget", text: "mock vendor: screenshot tool never produced an image" };
        }
        return { kind: "tool", name };
    }
    if (/run the shell marker command/i.test(userText)) {
        const name = view.toolNames.find((tool) => tool === "exec_command");
        if (!name) return { kind: "missing-tool", text: "mock vendor: shell tool is not advertised" };
        // Once the exec_command result is back in the tail, close the turn.
        const tail = String(view.tailAfterLastUser ?? "");
        if (tail.includes('"role":"tool"') || tail.includes("function_call_output")) {
            return { kind: "ping", text: "pong" };
        }
        return {
            kind: "tool",
            name,
            args: JSON.stringify({ cmd: "printf shell-sandbox-ok > /tmp/probe-ws/marker.txt" }),
        };
    }
    if (userText.includes("pong")) return { kind: "ping", text: "pong" };
    return { kind: "unscripted", text: "mock vendor: no scripted answer for this request" };
}

// ---------------------------------------------------------------------------
// Wire-specific SSE emitters
// ---------------------------------------------------------------------------

/** Trailing usage-only chunk: codex requests stream_options.include_usage,
 * so every scripted chat response ends with a deterministic usage frame
 * (input 4 / output 1 / total 5) exactly like a compliant vendor. */
function chatUsageChunk() {
    return `data: ${JSON.stringify({
        id: "mock-chatcmpl",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    })}\n\n`;
}

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
        chatUsageChunk() +
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
        chatUsageChunk() +
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
                res.write(chatUsageChunk());
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
    // Per-run freshness state: base64 payload -> screenshotToolCalls at the
    // time it was answered. A later tool round presenting the same bytes is
    // an old image re-served (image-stale); an unchanged counter means a
    // retry of the same round and answers normally.
    const answeredImages = new Map();
    const server = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200).end("ok");
            return;
        }
        if (req.method === "GET" && req.url === "/stats") {
            // The stats probe's own connection is open while being served;
            // exclude it so a lone reader never looks like a leak.
            res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({ openSockets: Math.max(0, openSockets - 1), requests }),
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
            const response = selectResponse(parsed, screenshotToolCalls, wire, toolBudget, answeredImages);
            fs.appendFileSync(recordPath, `${JSON.stringify({
                ts: new Date().toISOString(), wire, auth: req.headers.authorization ?? null,
                xApi: req.headers["x-api-key"] ?? null,
                kind: response.kind, body,
            })}\n`);
            if (response.kind === "essay") { streamEssay(wire, res); return; }
            if (response.kind === "hang") {
                // Never answer; release only when the client cancels. The
                // record above IS the arrival signal the stress driver
                // awaits before cancelling a before-headers round.
                return;
            }
            res.writeHead(200, sseHeaders);
            if (response.kind === "tool") {
                if (response.name === "mcp__screenshots__take_screenshot") screenshotToolCalls += 1;
                res.end(toolCallResponse(wire, response.name, response.args ?? "{}"));
            } else {
                if (response.kind === "image" && response.imagePayload) {
                    answeredImages.set(response.imagePayload, screenshotToolCalls);
                }
                res.end(textResponse(wire, response.text));
            }
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
