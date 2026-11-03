/**
 * Fork module: serialises concurrent session open/resume calls per session.
 * Isolated here so merges with upstream only need to change the call sites
 * in `CodexAcpServer` rather than resolve logic-level conflicts.
 */
import {RequestError} from "@agentclientprotocol/sdk/unstable";

type QueueEntry = {
    generation: number;
    completion: Promise<void>;
};

export class SessionOpenQueue {
    private readonly queues = new Map<string, QueueEntry>();

    /**
     * Serialises a session open behind any prior open for the same session.
     * `beginGeneration` allocates and returns the caller's generation (and
     * throws if the session is already closing). `canInstall` re-checks that
     * the session can still be installed after waiting for the previous open.
     */
    async enqueue<T>(
        sessionId: string,
        beginGeneration: () => number,
        canInstall: (generation: number) => boolean,
        open: () => Promise<T>,
    ): Promise<T> {
        const generation = beginGeneration();
        const pending = this.queues.get(sessionId);
        const previous = pending?.generation === generation ? pending.completion : undefined;
        let release: () => void = () => {};
        const current: QueueEntry = {
            generation,
            completion: new Promise<void>((resolve) => { release = resolve; }),
        };
        this.queues.set(sessionId, current);
        try {
            if (previous !== undefined) {
                await previous;
            }
            if (!canInstall(generation)) {
                throw RequestError.invalidRequest(`Session ${sessionId} is closing`);
            }
            return await open();
        } finally {
            release();
            if (this.queues.get(sessionId) === current) {
                this.queues.delete(sessionId);
            }
        }
    }
}
