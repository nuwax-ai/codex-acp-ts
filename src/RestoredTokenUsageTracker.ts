/**
 * Fork module: captures and replays restored `thread/tokenUsage/updated`
 * snapshots on resume. Isolated here so merges with upstream
 * `codex-acp` only need to wire a single instance into
 * `CodexAppServerClient` rather than resolve logic-level conflicts.
 */
import {logger} from "./Logger";
import type {ServerNotification} from "./app-server/ServerNotification";
import type {ThreadTokenUsageUpdatedNotification} from "./app-server/v2";

/**
 * A per-load capture of the restored `thread/tokenUsage/updated` replay.
 * Entries exist only while a load armed them; handler-less threads never
 * accumulate entries on their own.
 */
type RestoredTokenUsageCapture = {
    readonly owner: symbol;
    /** Latest replayed snapshot; null until the notification arrives. */
    snapshot: ThreadTokenUsageUpdatedNotification | null;
    /** True while the resume request that armed this capture is still in flight. */
    inFlight: boolean;
};

/** How many restored-usage snapshots a thread remembers as already applied. */
const APPLIED_RESTORED_USAGE_MEMORY = 8;

/** Retention target for restored-usage captures. */
const CAPTURE_CAP = 64;

export class RestoredTokenUsageTracker {
    private readonly pending = new Map<string, RestoredTokenUsageCapture>();
    private readonly applied = new Map<string, ThreadTokenUsageUpdatedNotification[]>();

    /**
     * Arms a per-load capture for a thread. The load flow calls this before
     * sending the resume request and consumes the snapshot after installing
     * the fresh session state. Entries are created only by explicit arming.
     */
    arm(threadId: string): symbol {
        const owner = Symbol("restored token usage capture");
        this.pending.set(threadId, {owner, snapshot: null, inFlight: true});
        this.evictSettled();
        return owner;
    }

    /** Marks the resume request that armed this capture as settled (evictable). */
    settle(threadId: string, owner: symbol): void {
        const capture = this.pending.get(threadId);
        if (capture?.owner === owner) {
            capture.inFlight = false;
            this.evictSettled();
        }
    }

    /** Drops an armed capture without consuming it — the load did not complete. */
    clear(threadId: string, owner: symbol): void {
        if (this.pending.get(threadId)?.owner === owner) {
            this.pending.delete(threadId);
        }
    }

    /** Releases every per-load capture; call when the owning client is discarded. */
    dispose(): void {
        this.pending.clear();
        this.applied.clear();
    }

    /**
     * Ends duplicate suppression because a live subscription now owns the
     * thread. An unconsumed snapshot is forwarded to `handler` so it is not lost.
     */
    release(threadId: string, handler: (event: ServerNotification) => void | Promise<void>): void {
        const pending = this.pending.get(threadId);
        if (pending === undefined) return;
        this.pending.delete(threadId);
        if (pending.snapshot !== null) {
            void Promise.resolve(handler({method: "thread/tokenUsage/updated", params: pending.snapshot}))
                .catch((error: unknown) =>
                    logger.error(`Failed to replay a restored token usage snapshot for ${threadId}`, error));
        }
    }

    /**
     * Takes the captured snapshot for a load of this thread. Consumes the
     * capture whether or not the replay arrived.
     */
    take(threadId: string): ThreadTokenUsageUpdatedNotification | null {
        const pending = this.pending.get(threadId);
        if (pending === undefined) {
            return null;
        }
        this.pending.delete(threadId);
        this.rememberApplied(threadId, pending.snapshot);
        return pending.snapshot;
    }

    /**
     * Intercepts an incoming `thread/tokenUsage/updated` notification.
     * Returns `true` when the tracker consumed the notification (either it
     * belongs to an armed capture or it is a duplicate replay); the caller
     * should not deliver it further.
     */
    intercept(threadId: string, snapshot: ThreadTokenUsageUpdatedNotification): boolean {
        const capture = this.pending.get(threadId);
        if (capture !== undefined) {
            capture.snapshot = snapshot;
            return true;
        }
        return this.isReplayed(threadId, snapshot);
    }

    /** Clears all state for a thread that is unsubscribing. */
    forget(threadId: string): void {
        this.pending.delete(threadId);
        this.applied.delete(threadId);
    }

    /** Records a snapshot this thread already applied. */
    private rememberApplied(
        threadId: string,
        snapshot: ThreadTokenUsageUpdatedNotification | null,
    ): void {
        if (snapshot === null) return;
        const list = this.applied.get(threadId) ?? [];
        list.push(snapshot);
        if (list.length > APPLIED_RESTORED_USAGE_MEMORY) list.shift();
        this.applied.set(threadId, list);
    }

    /** Whether `snapshot` is one this thread already applied. */
    private isReplayed(threadId: string, snapshot: ThreadTokenUsageUpdatedNotification): boolean {
        const encoded = JSON.stringify(snapshot);
        return (this.applied.get(threadId) ?? [])
            .some(applied => JSON.stringify(applied) === encoded);
    }

    /** Evicts settled (non-in-flight) captures when the total exceeds the cap. */
    private evictSettled(): void {
        if (this.pending.size <= CAPTURE_CAP) {
            return;
        }
        for (const [threadId, capture] of this.pending) {
            if (this.pending.size <= CAPTURE_CAP) {
                return;
            }
            if (capture.inFlight) {
                continue;
            }
            this.pending.delete(threadId);
            logger.log("Evicted a settled restored token usage capture over the capture cap", {
                threadId,
                captureCap: CAPTURE_CAP,
            });
        }
    }
}
