/** Refuse standalone helpers that could send unmetered real-model traffic. */
export async function requireBudgetGateway(): Promise<void> {
    const origin = process.env["LIVE_GATEWAY_URL"];
    const token = process.env["LIVE_GATEWAY_KEY"];
    const vendor = process.env["LIVE_VENDOR"];
    const wire = process.env["NUWAX_WIRE_API"];
    if (!origin || !token || !vendor || !wire) throw new Error("run through live-smallbatch.sh; a shared budget gateway is required");
    const url = new URL(origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || !["", "/"].includes(url.pathname)) throw new Error("a loopback budget gateway is required");
    if (process.env["NUWAX_BASE_URL"] !== `${origin}/routes/${vendor}/${wire}` || process.env["NUWAX_API_KEY"] !== token) throw new Error("direct provider endpoint/key bypasses the shared gateway");
    const response = await fetch(`${origin}/control/config?vendor=${encodeURIComponent(vendor)}&wire=${encodeURIComponent(wire)}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000), redirect: "error",
    });
    if (!response.ok) throw new Error("budget gateway configuration unavailable");
    const config = await response.json() as { baseUrl?: string };
    if (config.baseUrl !== process.env["NUWAX_BASE_URL"]) throw new Error("provider does not match the shared gateway route");
}
