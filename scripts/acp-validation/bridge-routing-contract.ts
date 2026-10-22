/** Strict postflight over local fixture artifacts; malformed evidence fails. */
export function auditBridgeRouting(
    mockRaw: string,
    captureRaw: string,
    options: { wire: string; key: string; model: string; native: boolean },
): { requests: number; captures: number; expectedPath: string } {
    const rows = (raw: string): Array<Record<string, unknown>> => raw.split("\n").filter((line) => line.trim()).map((line) => {
        let row: unknown;
        try { row = JSON.parse(line); } catch { throw new Error("artifact contains invalid JSONL"); }
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("artifact row is not an object");
        return row as Record<string, unknown>;
    });
    const requests = rows(mockRaw);
    const captures = rows(captureRaw); // Validate even on native: bad evidence is not zero entries.
    const expectedPath = options.wire === "chat" ? "/v1/chat/completions" : options.wire === "anthropic" ? "/v1/messages" : "/v1/responses";
    if (!requests.length) throw new Error("no real model HTTP request reached the fixture");
    for (const request of requests) {
        const authOk = options.wire === "anthropic" ? request["xApi"] === options.key : request["auth"] === `Bearer ${options.key}`;
        if (!authOk || request["path"] !== expectedPath || typeof request["body"] !== "string") throw new Error("model HTTP path/auth/body contract mismatch");
        let body: unknown;
        try { body = JSON.parse(request["body"]); } catch { throw new Error("model HTTP body is invalid JSON"); }
        if (!body || typeof body !== "object" || Array.isArray(body) || (body as Record<string, unknown>)["model"] !== options.model) throw new Error("model HTTP model contract mismatch");
    }
    if (options.native) {
        if (captures.length) throw new Error("native transport unexpectedly wrote a rig request capture");
    } else {
        if (captures.length !== requests.length) throw new Error("rig capture count differs from actual HTTP requests");
        for (const capture of captures) {
            if (typeof capture["url"] !== "string" || typeof capture["body_raw"] !== "string") throw new Error("rig capture is missing its exact URL/body evidence");
            let url: URL;
            try { url = new URL(capture["url"]); } catch { throw new Error("rig capture URL is invalid"); }
            if (url.pathname !== expectedPath) throw new Error("rig capture path differs from actual HTTP request path");
        }
        if (JSON.stringify(captures.map((row) => row["body_raw"]).sort()) !== JSON.stringify(requests.map((row) => row["body"]).sort())) throw new Error("rig capture bytes differ from actual HTTP request bytes");
    }
    return { requests: requests.length, captures: captures.length, expectedPath };
}
