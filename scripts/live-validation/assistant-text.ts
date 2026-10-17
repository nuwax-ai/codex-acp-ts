/** Score model messages, excluding legacy advisory text sent as chunks. */
export class FinalAssistantText {
    private messages = new Map<string, { text: string; phase: unknown }>();

    add(update: {
        sessionUpdate?: string;
        messageId?: unknown;
        content?: { type?: string; text?: unknown };
        _meta?: { codex?: { phase?: unknown } };
    }): void {
        if (update.sessionUpdate !== "agent_message_chunk" || update.content?.type !== "text"
            || typeof update.content.text !== "string" || typeof update.messageId !== "string"
            || update.messageId.length === 0) return;
        const message = this.messages.get(update.messageId) ?? { text: "", phase: undefined };
        message.text += update.content.text;
        const phase = update._meta?.codex?.phase;
        if (phase !== undefined && phase !== null) message.phase = phase;
        this.messages.set(update.messageId, message);
    }

    text(): string {
        const messages = [...this.messages.values()];
        const finals = messages.filter((message) => message.phase === "final_answer");
        // Older/custom providers may omit phase, while identified commentary
        // and messages without an identity never count as a final answer.
        return (finals.at(-1) ?? messages.filter((message) => message.phase == null).at(-1))?.text.trim() ?? "";
    }

    reset(): void { this.messages.clear(); }
}
