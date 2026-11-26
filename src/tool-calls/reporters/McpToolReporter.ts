import type {ThreadItem} from "../../app-server/v2";
import type {ToolFacts} from "../ToolFacts";
import {toTerminalToolStatus, toToolStatus} from "./ToolStatus";

type McpToolCallItem = ThreadItem & {type: "mcpToolCall"};

/**
 * Reports a Codex MCP tool call.
 * Every client gets the whole Codex result and error in `rawOutput = {result, error}`, and no `content`.
 * AIR shows the text of `rawOutput.result` and `rawOutput.error.message`.
 */
export class McpToolReporter {
    static started(item: McpToolCallItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "start",
            kind: "execute",
            title: `mcp.${item.server}.${item.tool}`,
            status: toToolStatus(item.status),
            input: mcpInput(item),
            ...resultFacts(item),
            mcp: {server: item.server, tool: item.tool},
        };
    }

    static completed(item: McpToolCallItem): ToolFacts {
        return {
            toolCallId: item.id,
            report: "update",
            status: toTerminalToolStatus(item.status),
            input: mcpInput(item),
            ...resultFacts(item),
        };
    }

    /** MCP progress text, trimmed, for a client that is not AIR. The event handler sends no progress to AIR. */
    static progress(itemId: string, message: string): ToolFacts {
        return {toolCallId: itemId, report: "update", standard: {mcpProgress: message.trim()}};
    }
}

/**
 * `rawInput` is "raw input parameters sent to the tool" (ACP), i.e. the tool's own
 * arguments — the flat shape Claude Code and opencode emit. Wrapping them as
 * `{server, tool, arguments}` made the platform's `parseMcpAskToolInput` give up
 * (it reads `requestId`/`ui` at the top level), so `ask_question` never rendered.
 * The server/tool identity moved to `_meta.mcp` (see `mcpMeta`).
 */
function mcpInput(item: McpToolCallItem): unknown {
    return item.arguments;
}

function resultFacts(item: McpToolCallItem): Pick<ToolFacts, "opaqueResult"> {
    return item.result === null && item.error === null ? {} : {opaqueResult: {result: item.result, error: item.error}};
}
