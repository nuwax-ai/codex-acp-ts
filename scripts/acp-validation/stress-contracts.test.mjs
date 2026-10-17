import assert from "node:assert/strict";
import test from "node:test";
import { cancelAndObserve, waitForTrackedProcesses } from "./stress-contracts.ts";

test("expired tracked git remains a failure after successful test cleanup", async () => {
    let now = 0;
    const proc = { pid: 42, lstart: "original", command: "git ls-remote https://github.com/openai/plugins.git", role: "descendant" };
    const table = new Map([[42, { lstart: "original" }]]);
    const killed = [];
    const expired = await waitForTrackedProcesses({
        tracked: () => [proc], table: () => table, now: () => now,
        sleep: async (ms) => { now += ms; },
        kill: (pid) => { killed.push(pid); table.delete(pid); },
    });
    assert.deepEqual(expired, [proc]);
    assert.deepEqual(killed, [42]);
    assert.equal(table.size, 0, "cleanup succeeded but did not erase the failed observation");
    assert.equal(now, 36_000);
});

test("unrelated git command gets the serving deadline and recycled PID is never killed", async () => {
    let now = 0;
    const proc = { pid: 42, lstart: "original", command: "git clone https://github.com/example/project", role: "descendant" };
    const table = new Map([[42, { lstart: "original" }]]);
    const killed = [];
    const expired = await waitForTrackedProcesses({
        tracked: () => [proc], table: () => table, now: () => now,
        sleep: async (ms) => { now += ms; }, kill: (pid) => { killed.push(pid); table.delete(pid); },
    });
    assert.deepEqual(expired, [proc]);
    assert.equal(now, 11_000);
    const gone = await waitForTrackedProcesses({
        tracked: () => [proc], table: () => new Map([[42, { lstart: "replacement" }]]),
        now: () => 0, sleep: async () => {}, kill: () => assert.fail("must not kill a recycled PID"),
    });
    assert.deepEqual(gone, []);
});

test("request arriving between cancel notification and prompt acknowledgement is observed", async () => {
    const records = [{ kind: "original" }];
    const result = await cancelAndObserve({
        recorded: () => records.slice(),
        notify: async () => { records.push({ kind: "unexpected-main" }); },
        response: async () => ({ stopReason: "cancelled" }),
        sleep: async () => { records.push({ kind: "late-main" }); },
    });
    assert.equal(result.response.stopReason, "cancelled");
    assert.deepEqual(result.afterCancel.map((r) => r.kind), ["unexpected-main", "late-main"]);
});

test("a failed process probe retains tracked identities instead of claiming zero residue", async () => {
    const proc = { pid: 42, lstart: "original", command: "server", role: "app-server" };
    assert.deepEqual(await waitForTrackedProcesses({
        tracked: () => [proc], table: () => null, now: () => 0,
        sleep: async () => {}, kill: () => assert.fail("no trustworthy identity"),
    }), [proc]);
});
