import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {createMcpToolCallUpdate} from "../../src/CodexToolCallMapper.ts";
import {assertRestoredUsage, assertScreenshot, beginPrompt, inspectContent, inspectUpdateContent, isModelDelta, latestUsageAfter,
    processTable, rememberFamily, requireCompletedTool, survivingFamily, workspacePath} from "./workflow-contracts.ts";

test("each new prompt requires its own identified text delta; old text and advisory chunks cannot satisfy cancel", () => {
    const obs = {sawDelta: true};
    beginPrompt(obs);
    assert.equal(obs.sawDelta, false);
    assert.equal(isModelDelta({sessionUpdate: "agent_message_chunk", content: {type: "text", text: "old advisory"}}), false);
    assert.equal(isModelDelta({sessionUpdate: "agent_message_chunk", messageId: "new", content: {type: "text", text: ""}}), false);
    obs.sawDelta ||= isModelDelta({sessionUpdate: "agent_message_chunk", messageId: "new", content: {type: "text", text: "first token"}});
    assert.equal(obs.sawDelta, true);
    beginPrompt(obs);
    assert.equal(obs.sawDelta, false);
});

const truth = [{event: "start"}, {event: "complete", color: "cyan"}];
const calls = [{id: "shot", tool: "screenshots: take_screenshot", kind: "execute", status: "in_progress"}];
const updates = [{id: "shot", status: "completed"}];

test("screenshot requires exact ground truth, exactly one invocation, correlated success and typed image", () => {
    assert.doesNotThrow(() => assertScreenshot(truth, "cyan", ["shot"], calls, updates));
    assert.doesNotThrow(() => assertScreenshot(truth, "青色。", ["shot"], calls, updates));
    for (const [answer, images, observedCalls, results, observedTruth] of [
        ["red", ["shot"], calls, updates, truth],
        ["not cyan", ["shot"], calls, updates, truth],
        ["cyan", [], calls, updates, truth],
        ["cyan", ["other-tool"], calls, updates, truth],
        ["cyan", ["shot"], calls, [{id: "other", status: "completed"}], truth],
        ["cyan", ["shot"], calls, [{id: "shot", status: "failed"}], truth],
        ["cyan", ["shot"], [...calls, {...calls[0], id: "second"}], updates, truth],
        ["cyan", ["shot"], calls, updates, [...truth, {event: "complete", color: "cyan"}]],
    ]) assert.throws(() => assertScreenshot(observedTruth, answer, images, observedCalls, results));
});

test("typed tool images stay separate while nested tool text participates in base64 checks", () => {
    const blob = "A".repeat(700);
    assert.deepEqual(inspectContent([
        {type: "content", content: {type: "image", data: blob, mimeType: "image/png"}},
        {type: "content", content: {type: "text", text: blob}},
    ]), {texts: [blob], images: 1});
});

test("a file or shell step needs a correlated completed result, not merely a call name", () => {
    assert.throws(() => requireCompletedTool(calls, [], () => true));
    assert.throws(() => requireCompletedTool(calls, [{id: "unrelated", status: "completed"}], () => true));
    assert.doesNotThrow(() => requireCompletedTool(calls, updates, () => true));
    assert.doesNotThrow(() => requireCompletedTool([{id: "compact", tool: "Compact conversation", status: "completed"}], [], () => true));
});

test("usage cursor captured before awaiting compaction retains an immediate event", () => {
    const observed = [{used: 1000, size: 32000}];
    const cursor = observed.length;
    assert.equal(latestUsageAfter(observed, cursor), undefined);
    observed.push({used: 400, size: 32000});
    assert.deepEqual(latestUsageAfter(observed, cursor), {used: 400, size: 32000});
});

test("cold resume accepts exactly one unchanged snapshot including explicit zero", () => {
    const expected = {used: 2500, size: 128000};
    assert.doesNotThrow(() => assertRestoredUsage(expected, [expected]));
    assert.doesNotThrow(() => assertRestoredUsage({used: 0, size: 128000}, [{used: 0, size: 128000}]));
    for (const actual of [[], [expected, expected], [{used: 2501, size: 128000}], [{used: 2500, size: 64000}]]) {
        assert.throws(() => assertRestoredUsage(expected, actual));
    }
});

test("process probes parse macOS and Linux rows, reject failures, and avoid recycled PID matches", () => {
    const table = processTable(() => " 10 1 Sun Oct 18 09:10:11 2026 S owner\n 11 10 Sun Oct 18 09:10:12 2026 S child\n 12 10 Sun Oct 18 09:10:12 2026 Z zombie\n");
    const tracked = new Map();
    rememberFamily(10, table, tracked);
    assert.deepEqual([...tracked.keys()], [10, 11]);
    const recycled = processTable(() => " 11 1 Sun Oct 18 10:10:12 2026 S reused\n");
    assert.deepEqual(survivingFamily(tracked, recycled), []);
    assert.equal(survivingFamily(tracked, table).length, 2);
    assert.throws(() => processTable(() => { throw new Error("ps unavailable"); }), /ps unavailable/);
    assert.throws(() => processTable(() => ""), /no usable identities/);
});

test("filesystem handlers reject traversal, sibling-prefix paths and escaping symlinks", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-path-test-"));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const work = path.join(root, "work");
    const sibling = path.join(root, "work-other");
    fs.mkdirSync(work); fs.mkdirSync(sibling);
    const outside = path.join(sibling, "secret"); fs.writeFileSync(outside, "private");
    assert.equal(workspacePath(work, path.join(work, "new.txt")), path.join(fs.realpathSync(work), "new.txt"));
    assert.throws(() => workspacePath(work, outside), /escaped/);
    assert.throws(() => workspacePath(work, path.join(work, "..", "work-other", "secret")), /escaped/);
    assert.throws(() => workspacePath(work, "relative.txt"), /absolute/);
    if (process.platform !== "win32") {
        const link = path.join(work, "link"); fs.symlinkSync(outside, link);
        assert.throws(() => workspacePath(work, link), /escaped/);
        const dangling = path.join(work, "dangling"); fs.symlinkSync(path.join(sibling, "not-created"), dangling);
        assert.throws(() => workspacePath(work, dangling));
        assert.equal(fs.existsSync(path.join(sibling, "not-created")), false);
    }
});

test("the real MCP mapper's structured result supplies a correlated image without ACP display content", async () => {
    const update = await createMcpToolCallUpdate({
        type: "mcpToolCall", id: "mapper-shot", server: "screenshots", tool: "take_screenshot", status: "completed",
        arguments: {}, result: {content: [{type: "image", mimeType: "image/png", data: "ZHVtbXk="}, {type: "text", text: "screenshot captured"}], structuredContent: null, _meta: null}, error: null,
    });
    assert.equal(update.content, undefined);
    const observed = inspectUpdateContent(update);
    assert.deepEqual(observed, {texts: ["screenshot captured"], images: 1});
    assert.doesNotThrow(() => assertScreenshot([{event: "complete", color: "red"}], "红色", [update.toolCallId],
        [{id: update.toolCallId, tool: update.title, status: update.status}], []));
});

test("only the declared MCP content array counts; error metadata and serialized image JSON do not", () => {
    const image = {type: "image", data: "ZHVtbXk="};
    for (const rawOutput of [
        {result: {structuredContent: image}},
        {metadata: {content: [image]}},
        {result: {content: [image]}, error: {message: "failed"}},
        {result: {content: JSON.stringify([image])}},
        {result: {content: [{type: "text", text: JSON.stringify(image)}]}},
    ]) assert.equal(inspectUpdateContent({rawOutput}).images, 0);
    assert.deepEqual(inspectUpdateContent({rawOutput: {result: {content: [{type: "text", text: "A".repeat(700)}]}}}), {texts: ["A".repeat(700)], images: 0});
});
