import assert from "node:assert/strict";
import test from "node:test";
import { FinalAssistantText } from "./assistant-text.ts";

const chunk = (messageId, text, phase) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text }, _meta: { codex: { phase } } });

test("startup warnings and compaction notices cannot pollute an exact assistant answer", () => {
    const text = new FinalAssistantText();
    text.add({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "*Context compacted*" } });
    text.add(chunk("commentary", "I will answer now", "commentary"));
    text.add(chunk("final", "  live-", "final_answer"));
    text.add(chunk("final", "ok\n", "final_answer"));
    assert.equal(text.text(), "live-ok");
});

test("last identified final answer wins and a new prompt resets the prior answer", () => {
    const text = new FinalAssistantText();
    text.add(chunk("first", "wrong", "final_answer"));
    text.add(chunk("second", "right", "final_answer"));
    assert.equal(text.text(), "right");
    text.reset();
    assert.equal(text.text(), "");
    text.add(chunk("new", "post-compact-ok", null));
    assert.equal(text.text(), "post-compact-ok");
});

test("a notice or commentary alone is never a successful final answer", () => {
    const text = new FinalAssistantText();
    text.add(chunk(undefined, "live-ok", null));
    text.add(chunk("commentary", "live-ok", "commentary"));
    assert.equal(text.text(), "");
});
