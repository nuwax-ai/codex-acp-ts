// Fork customization test: locks the behavior of the system-prompt passthrough
// (see src/SystemPromptMeta.ts). Pure-function, no Codex binary required, so it
// survives merges and runs in plain `npm test`.

import {describe, expect, it} from "vitest";
import {RequestError} from "@agentclientprotocol/sdk";
import {readMetaSystemPrompt} from "../SystemPromptMeta";

describe("readMetaSystemPrompt", () => {
    describe("happy path", () => {
        it("reads _meta.systemPrompt.append and ignores sibling keys (rcoder contract)", () => {
            // rcoder's build_meta() forwards system_prompt as _meta.systemPrompt.append,
            // alongside the claudeCode namespace — only the append value must be extracted.
            const meta = {
                systemPrompt: {append: "You are a meticulous code reviewer."},
                claudeCode: {options: {settingSources: ["project"]}},
            };
            expect(readMetaSystemPrompt(meta)).toBe("You are a meticulous code reviewer.");
        });

        it("reads a plain-string systemPrompt", () => {
            expect(readMetaSystemPrompt({systemPrompt: "be brief"})).toBe("be brief");
        });

        it("preserves multi-line and quoted content verbatim", () => {
            const prompt = "line1\nline2\n  indented \"quoted\" 中文/é";
            expect(readMetaSystemPrompt({systemPrompt: {append: prompt}})).toBe(prompt);
        });
    });

    describe("returns null when absent or empty (lets Codex use its defaults)", () => {
        const nullCases: Array<[string, Record<string, unknown> | null | undefined]> = [
            ["undefined meta", undefined],
            ["null meta", null],
            ["empty object", {}],
            ["null systemPrompt", {systemPrompt: null}],
            ["object without append", {systemPrompt: {}}],
            ["empty append string", {systemPrompt: {append: ""}}],
            ["empty plain string", {systemPrompt: ""}],
            ["array-valued systemPrompt (object without append key)", {systemPrompt: ["a", "b"]}],
        ];

        it.each(nullCases)("returns null for %s", (_label, meta) => {
            expect(readMetaSystemPrompt(meta)).toBeNull();
        });
    });

    describe("fail fast on malformed values", () => {
        it("rejects a non-string, non-object systemPrompt", () => {
            const fn = () => readMetaSystemPrompt({systemPrompt: 123});
            expect(fn).toThrow(RequestError);
            expect(fn).toThrow(/systemPrompt/);
        });

        it("rejects a boolean systemPrompt", () => {
            expect(() => readMetaSystemPrompt({systemPrompt: true})).toThrow(RequestError);
        });

        it("rejects a non-string append", () => {
            const fn = () => readMetaSystemPrompt({systemPrompt: {append: 123}});
            expect(fn).toThrow(RequestError);
            expect(fn).toThrow(/append/);
        });

        it("produces a JSON-RPC -32602 invalid params error", () => {
            try {
                readMetaSystemPrompt({systemPrompt: 123});
                throw new Error("expected readMetaSystemPrompt to throw");
            } catch (error) {
                expect(error).toBeInstanceOf(RequestError);
                expect((error as RequestError).code).toBe(-32602);
            }
        });
    });
});
