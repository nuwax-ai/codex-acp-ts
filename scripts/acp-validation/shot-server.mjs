// Minimal MCP stdio server exposing one tool: take_screenshot.
// Returns a fixed solid-red 64x64 PNG so vision checks have a
// deterministic answer ("red"). Used only by the ACP validation driver.
import readline from "node:readline";

const RED_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAl0lEQVR4nO3QMREAIAzAwIqof2V4ARk/kOH3XObs3p+NDtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QGuADtAaoAO0BugArQE6QHuR8THh/tK1hAAAAABJRU5ErkJggg==";

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
                serverInfo: { name: "acp-shot-server", version: "1.0.0" },
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
        send({
            jsonrpc: "2.0",
            id,
            result: {
                content: [
                    { type: "image", data: RED_PNG_BASE64, mimeType: "image/png" },
                    { type: "text", text: "screenshot captured" },
                ],
            },
        });
    } else if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
    }
});
