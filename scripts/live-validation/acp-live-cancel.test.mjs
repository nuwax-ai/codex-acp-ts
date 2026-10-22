import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {once} from "node:events";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {assertContinuation, closeOwnedAgent} from "./acp-live-cancel.ts";
import {processTable, rememberFamily, survivingFamily} from "./workflow-contracts.ts";

const repo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("continuation needs an end_turn and exactly the newly requested nonce", () => {
    const nonce = "ACP_CONTINUE_fresh_random_identity";
    assert.doesNotThrow(() => assertContinuation({stopReason: "end_turn"}, ` ${nonce}\n`, nonce));
    for (const text of ["", "ACP_CONTINUE_old_identity", `prefix ${nonce}`, `${nonce} extra`, nonce.slice(0, -1)]) {
        assert.throws(() => assertContinuation({stopReason: "end_turn"}, text, nonce), /exactly/);
    }
    for (const stopReason of [undefined, "cancelled", "max_tokens"]) {
        assert.throws(() => assertContinuation({stopReason}, nonce, nonce), /did not complete/);
    }
});

test("an explicit binary is mandatory before a gateway or ACP process can start", () => {
    const env = {...process.env};
    for (const name of ["CODEX_PATH", "LIVE_GATEWAY_URL", "LIVE_GATEWAY_KEY", "LIVE_VENDOR"]) delete env[name];
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/live-validation/acp-live-cancel.ts"], {
        cwd: repo, env, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CODEX_PATH must explicitly name/);
    assert.doesNotMatch(result.stdout, /SMOKE-PASS|CONTINUATION-PASS/);
});

async function ownedFixture(t, stubborn) {
    const grandchildCode = `process.on("SIGTERM", () => { ${stubborn ? "" : "process.exit(0);"} }); console.log("ready"); setInterval(() => {}, 1000);`;
    const parentCode = `
        const {spawn} = require("node:child_process");
        process.on("SIGTERM", () => process.exit(0));
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], {stdio: ["ignore", "pipe", "inherit"]});
        child.stdout.once("data", () => console.log(JSON.stringify({pid: process.pid, descendant: child.pid})));
        setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", parentCode], {stdio: ["pipe", "pipe", "pipe"]});
    const tracked = new Map();
    t.after(async () => {
        const table = processTable();
        for (const entry of survivingFamily(tracked, table)) {
            try { process.kill(entry.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await once(child, "exit");
        }
    });
    const ready = await Promise.race([
        once(child.stdout, "data"),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("fixture did not start")), 5000); timer.unref(); }),
    ]);
    const identity = JSON.parse(ready[0].toString());
    rememberFamily(child.pid, processTable(), tracked);
    assert(tracked.has(identity.descendant), "real descendant must be tracked before cleanup");
    return {child, tracked, identity};
}

test("bounded cleanup terminates only its owned family and escalates a TERM-resistant descendant", {skip: process.platform === "win32", timeout: 10_000}, async t => {
    const {child, tracked} = await ownedFixture(t, true);
    const unrelated = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {stdio: ["ignore", "pipe", "ignore"]});
    t.after(async () => {
        if (unrelated.exitCode === null && unrelated.signalCode === null) {
            unrelated.kill("SIGKILL");
            await once(unrelated, "exit");
        }
    });
    await once(unrelated.stdout, "data");
    let closed = false;
    await closeOwnedAgent(child, tracked, () => { closed = true; }, 100, 2000);
    assert.equal(closed, true);
    assert(child.exitCode !== null || child.signalCode !== null);
    assert.deepEqual(survivingFamily(tracked, processTable()), []);
    assert.equal(unrelated.exitCode, null);
    assert.equal(unrelated.signalCode, null);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});

test("a transport close error stays visible after the owned processes have been reaped", {skip: process.platform === "win32", timeout: 10_000}, async t => {
    const {child, tracked} = await ownedFixture(t, false);
    const firstFailure = new Error("original transport close failure");
    await assert.rejects(closeOwnedAgent(child, tracked, () => { throw firstFailure; }, 1000, 2000), error => error === firstFailure);
    assert(child.exitCode !== null || child.signalCode !== null);
    assert.deepEqual(survivingFamily(tracked, processTable()), []);
});
