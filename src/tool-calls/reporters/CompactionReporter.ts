import type * as acp from "@agentclientprotocol/sdk/unstable";
import type {ThreadItem} from "../../app-server/v2";
import {createContextCompactionMetadata} from "../../ContextCompactionMeta";
import type {ToolFacts} from "../ToolFacts";

type ContextCompactionItem = ThreadItem & {type: "contextCompaction"};

const TITLE = "Compact conversation";

/** Shown as the tool result once the compaction ends, so the entry says what happened instead of only a status. */
export const COMPACTION_COMPLETED_TEXT = "Context compaction completed.";
export const COMPACTION_FAILED_TEXT = "Context compaction failed.";
export const COMPACTION_CANCELLED_TEXT = "Context compaction cancelled.";

type CompactionEnd = "completed" | "failed" | "cancelled";

function outcomeText(status: CompactionEnd): string {
    if (status === "completed") return COMPACTION_COMPLETED_TEXT;
    if (status === "cancelled") return COMPACTION_CANCELLED_TEXT;
    return COMPACTION_FAILED_TEXT;
}

function outcomeResult(status: CompactionEnd): acp.ToolCallContent[] {
    return [{type: "content", content: {type: "text", text: outcomeText(status)}}];
}

/** Reports a Codex context compaction as a tool call, for a client without ACP compaction updates. */
export class CompactionReporter {
    static started(item: ContextCompactionItem): ToolFacts {
        return {...facts(item, "start"), kind: "think", status: "in_progress"};
    }

    static completed(item: ContextCompactionItem): ToolFacts {
        return {...facts(item, "update"), status: "completed", result: outcomeResult("completed")};
    }

    static history(item: ContextCompactionItem): ToolFacts {
        return {...facts(item, "start"), kind: "think", status: "completed", result: outcomeResult("completed")};
    }

    /**
     * Closes the tool call the adapter announced earlier, for an engine that reports the completion under a
     * different item id. The announced id is what the client is showing, so it is the one that must end.
     */
    static completedAnnounced(toolCallId: string): ToolFacts {
        return {
            toolCallId,
            report: "update",
            title: TITLE,
            kind: "think",
            status: "completed",
            result: outcomeResult("completed"),
            contextCompaction: createContextCompactionMetadata(),
        };
    }

    /**
     * Ends a compaction that never reported a completion, when its turn ends or is interrupted.
     *
     * ACP has no `cancelled` status, so an interrupted turn also reports `failed`; the result text says which
     * of the two happened.
     */
    static ended(toolCallId: string, outcome: "failed" | "cancelled"): ToolFacts {
        return {
            toolCallId,
            report: "update",
            title: TITLE,
            kind: "think",
            status: "failed",
            result: outcomeResult(outcome),
            contextCompaction: createContextCompactionMetadata(),
        };
    }
}

function facts(item: ContextCompactionItem, report: ToolFacts["report"]): ToolFacts {
    return {toolCallId: item.id, report, title: TITLE, contextCompaction: createContextCompactionMetadata()};
}
