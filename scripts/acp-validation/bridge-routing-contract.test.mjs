import test from "node:test";
import assert from "node:assert/strict";
import { auditBridgeRouting } from "./bridge-routing-contract.ts";
const options = { wire: "responses", key: "dummy", model: "fixture", native: false };
const body = '{"model":"fixture","input":[]}';
const request = JSON.stringify({ path: "/v1/responses", auth: "Bearer dummy", body });
const capture = JSON.stringify({ url: "http://127.0.0.1:1/v1/responses", body_raw: body });
test("rig audit proves exact bytes with duplicate-request multiplicity", () => {
    assert.equal(auditBridgeRouting(`${request}\n${request}`, `${capture}\n${capture}`, options).captures, 2);
    assert.throws(() => auditBridgeRouting(`${request}\n${request}`, capture, options), /count/);
    assert.throws(() => auditBridgeRouting(request, JSON.stringify({ url: "http://127.0.0.1/v1/responses", body_raw: '{ "model":"fixture","input":[]}' }), options), /bytes/);
});
test("native audit requires actual requests and no rig capture", () => {
    assert.equal(auditBridgeRouting(request, "", { ...options, native: true }).requests, 1);
    assert.throws(() => auditBridgeRouting("", "", { ...options, native: true }), /no real/);
    assert.throws(() => auditBridgeRouting(request, capture, { ...options, native: true }), /unexpectedly/);
});
test("invalid evidence fails even for a native zero-ledger assertion", () => {
    for (const bad of ["{", "null", "[]"]) {
        assert.throws(() => auditBridgeRouting(request, bad, { ...options, native: true }), /artifact/);
        assert.throws(() => auditBridgeRouting(bad, "", { ...options, native: true }), /artifact/);
    }
});
test("a different path/auth/model cannot satisfy the selected route", () => {
    for (const extra of [{ path: "/v1/chat/completions" }, { auth: "Bearer wrong" }, { body: '{"model":"other"}' }]) {
        assert.throws(() => auditBridgeRouting(JSON.stringify({ ...JSON.parse(request), ...extra }), "", { ...options, native: true }), /contract/);
    }
});
