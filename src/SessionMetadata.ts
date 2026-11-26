import type {ModeKind} from "./app-server/ModeKind";
import type {Model, Thread, ThreadItemEntry, ThreadStatus} from "./app-server/v2";
import type {SessionInstructions} from "./ClientSystemPrompt";

export type SessionMetadata = {
    sessionId: string,
    currentModelId: string,
    models: Model[],
    collaborationMode: ModeKind,
    modelProvider?: string | null,
    /**
     * The service tier the engine reported for the thread, as it reported it.
     * It is a free string: the engine names its Fast mode tier `"priority"`,
     * and a model catalog can define tiers of its own. See `isFastServiceTier`.
     */
    currentServiceTier?: string | null,
    threadStatus?: ThreadStatus,
    additionalDirectories: string[],
    skippedMcpServers?: string[],
    instructions?: SessionInstructions,
    sessionTitle?: string | null,
}

export type SessionMetadataWithThread = SessionMetadata & {
    /** The thread metadata. Its `turns` are empty: the items are in `history`. */
    thread: Thread,
    /** The items of the thread with their turns, oldest first, one page at a time. */
    history: AsyncIterable<ThreadItemEntry[]>,
}
