// Minimal MCP stdio server exposing one tool: take_screenshot.
//
// Each call returns a SOLID-COLOR 64x64 PNG. The color advances
// round-robin through a six-color palette (red, green, blue, yellow,
// magenta, cyan) and the final pixel encodes a per-process nonce plus the
// call counter, so every image served in a run is byte-unique: a client
// that re-serves an earlier image instead of attaching this call's fresh
// output is detectable by the mock vendor (kind image-stale), and the
// ground-truth file lets the stress driver verify the model actually saw
// THIS round's color (the mock decodes and answers with the classified
// color name).
//
// Env:
//   SHOT_TAKE_MS   (optional) delays the tools/call answer so stress runs
//                  can cancel while the tool is still running.
//   SHOT_TRUTH_PATH (optional JSONL file) — ground-truth recorder. A
//                  {ts, mcpCallId, color, event:"start"} record is
//                  appended BEFORE the take-delay (so cancel-during-tool
//                  rounds can prove the tool actually started) and a
//                  {..., event:"complete"} record after the answer is
//                  sent. When unset, recording is skipped and everything
//                  else works unchanged.
import fs from "node:fs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const WIDTH = 64;
const HEIGHT = 64;

/** Palette shared with the mock vendor's classifier (name -> RGB). */
export const SHOT_PALETTE = [
    ["red", [255, 0, 0]],
    ["green", [0, 255, 0]],
    ["blue", [0, 0, 255]],
    ["yellow", [255, 255, 0]],
    ["magenta", [255, 0, 255]],
    ["cyan", [0, 255, 255]],
];

// ---------------------------------------------------------------------------
// PNG encoder (node:zlib only — no dependencies)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

/** CRC-32 (IEEE) over a buffer — every PNG chunk carries crc32(type+data). */
export function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
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

/** Apply a PNG scanline filter (types 0-4) to one raw row. */
function filterRow(filterType, target, current, previous, bpp) {
    switch (filterType) {
        case 0:
            current.copy(target);
            return;
        case 1:
            for (let i = 0; i < current.length; i += 1) {
                target[i] = (current[i] - (i >= bpp ? current[i - bpp] : 0)) & 0xff;
            }
            return;
        case 2:
            for (let i = 0; i < current.length; i += 1) {
                target[i] = (current[i] - previous[i]) & 0xff;
            }
            return;
        case 3:
            for (let i = 0; i < current.length; i += 1) {
                target[i] = (current[i] - (((i >= bpp ? current[i - bpp] : 0) + previous[i]) >> 1)) & 0xff;
            }
            return;
        case 4:
            for (let i = 0; i < current.length; i += 1) {
                const a = i >= bpp ? current[i - bpp] : 0;
                const b = previous[i];
                const c = i >= bpp ? previous[i - bpp] : 0;
                target[i] = (current[i] - paethPredictor(a, b, c)) & 0xff;
            }
            return;
        default:
            throw new Error(`unsupported PNG filter type ${filterType}`);
    }
}

/**
 * Encode raw 8-bit RGBA pixels as a base64 PNG (color type 6, non-interlaced)
 * using the requested per-row scanline filter (0-4). Exposed for unit tests
 * that verify the mock vendor's decoder round-trips every filter type.
 */
export function pngBase64FromPixels(width, height, pixels, filterType = 0) {
    const bpp = 4;
    const stride = width * bpp;
    if (pixels.length !== stride * height) throw new Error("pixel buffer size mismatch");
    const raw = Buffer.alloc((stride + 1) * height);
    const zeros = Buffer.alloc(stride);
    for (let y = 0; y < height; y += 1) {
        const rowStart = y * stride;
        raw[y * (stride + 1)] = filterType;
        filterRow(
            filterType,
            raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)),
            pixels.subarray(rowStart, rowStart + stride),
            y > 0 ? pixels.subarray(rowStart - stride, rowStart) : zeros,
            bpp,
        );
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter method
    ihdr[12] = 0; // interlace
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([
        PNG_SIGNATURE,
        chunk("IHDR", ihdr),
        chunk("IDAT", idat),
        chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64");
}

/**
 * Base64 of a solid-color 64x64 RGBA PNG. `marker` (optional, < 2^24) is
 * encoded into the final pixel's RGB channels: a per-process nonce plus
 * call counter keeps every served image byte-unique (average-pixel color
 * classification is unaffected — one pixel out of 4096).
 */
export function solidColorPngBase64(colorName, marker = null) {
    const entry = SHOT_PALETTE.find(([name]) => name === colorName);
    if (!entry) throw new Error(`unknown palette color: ${colorName}`);
    const [r, g, b] = entry[1];
    const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
    for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
        pixels[i * 4] = r;
        pixels[i * 4 + 1] = g;
        pixels[i * 4 + 2] = b;
        pixels[i * 4 + 3] = 255;
    }
    if (marker !== null && marker !== undefined) {
        const offset = (WIDTH * HEIGHT - 1) * 4;
        pixels[offset] = (marker >> 16) & 0xff;
        pixels[offset + 1] = (marker >> 8) & 0xff;
        pixels[offset + 2] = marker & 0xff;
        pixels[offset + 3] = 255;
    }
    return pngBase64FromPixels(WIDTH, HEIGHT, pixels, 0);
}

// ---------------------------------------------------------------------------
// stdio MCP server
// ---------------------------------------------------------------------------

function recordTruth(record, truthPath) {
    if (!truthPath) return; // unset -> skip recording, keep serving
    try {
        fs.appendFileSync(truthPath, `${JSON.stringify(record)}\n`);
    } catch (error) {
        // Recording is best-effort telemetry; a broken truth path must not
        // corrupt the MCP protocol, but it should be visible.
        process.stderr.write(`shot-server: truth record failed: ${String(error)}\n`);
    }
}

function main() {
    const TAKE_MS = Number(process.env["SHOT_TAKE_MS"] ?? 0);
    const truthPath = process.env["SHOT_TRUTH_PATH"] ?? "";
    // 16-bit per-process nonce (never zero) keeps bytes unique across
    // shot-server restarts (session/load spawns a fresh process whose call
    // counter restarts at 1).
    const nonce = ((Math.random() * 0x10000) | 0) || 1;
    let callIndex = 0;

    const rl = readline.createInterface({ input: process.stdin });
    const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

    rl.on("line", (line) => {
        if (!line.trim()) return;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        const { id, method } = msg;
        if (method === "initialize") {
            send({
                jsonrpc: "2.0",
                id,
                result: {
                    protocolVersion: "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "acp-shot-server", version: "1.1.0" },
                },
            });
        } else if (method === "notifications/initialized") {
            // notification — no response
        } else if (method === "tools/list") {
            send({
                jsonrpc: "2.0",
                id,
                result: {
                    tools: [
                        {
                            name: "take_screenshot",
                            description: "Capture a screenshot and return it as an image.",
                            inputSchema: { type: "object", properties: {} },
                        },
                    ],
                },
            });
        } else if (method === "tools/call") {
            callIndex += 1;
            const color = SHOT_PALETTE[(callIndex - 1) % SHOT_PALETTE.length][0];
            const marker = (nonce << 8) | (callIndex & 0xff);
            const data = solidColorPngBase64(color, marker);
            // The start record lands BEFORE the take-delay so a
            // cancel-during-tool round can prove the tool really started.
            recordTruth({ ts: new Date().toISOString(), mcpCallId: id, color, event: "start" }, truthPath);
            const answer = () => {
                send({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [
                            { type: "image", data, mimeType: "image/png" },
                            { type: "text", text: "screenshot captured" },
                        ],
                    },
                });
                recordTruth({ ts: new Date().toISOString(), mcpCallId: id, color, event: "complete" }, truthPath);
            };
            if (TAKE_MS > 0) setTimeout(answer, TAKE_MS);
            else answer();
        } else if (id !== undefined) {
            send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
        }
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
