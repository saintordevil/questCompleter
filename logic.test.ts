/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { assessClaimResponse, calculateRetryDelay, classifyClaimFailure, isSafeInternalPath, normalizeJoinOperator, prioritizeTaskNames, resolveTask, selectClaimLocation, selectClaimPlatform } from "./logic";

test("normalizes task join operators safely", () => {
    assert.equal(normalizeJoinOperator("and"), "and");
    assert.equal(normalizeJoinOperator("AND"), "and");
    assert.equal(normalizeJoinOperator("or"), "or");
    assert.equal(normalizeJoinOperator(undefined), "or");
    assert.equal(normalizeJoinOperator("xor"), "unknown");
    assert.equal(normalizeJoinOperator(1), "unknown");
});

test("retry backoff grows and caps instead of resetting after readiness", () => {
    assert.equal(calculateRetryDelay(1, 60_000, 900_000), 60_000);
    assert.equal(calculateRetryDelay(2, 60_000, 900_000), 120_000);
    assert.equal(calculateRetryDelay(3, 60_000, 900_000), 240_000);
    assert.equal(calculateRetryDelay(10, 60_000, 900_000), 900_000);
});

test("Quest Home navigation accepts only safe internal paths", () => {
    assert.equal(isSafeInternalPath("/quest-home"), true);
    assert.equal(isSafeInternalPath("//example.com/quest-home"), false);
    assert.equal(isSafeInternalPath("https://example.com"), false);
    assert.equal(isSafeInternalPath("/quest\\home"), false);
    assert.equal(isSafeInternalPath("/quest\0home"), false);
    assert.equal(isSafeInternalPath(""), false);
    assert.equal(isSafeInternalPath(null), false);
});

test("OR task groups stop after any task is complete", () => {
    const resolution = resolveTask([
        { name: "WATCH_VIDEO", target: 30, progress: 30, runnable: true },
        { name: "PLAY_ON_XBOX", target: 600, progress: 0, runnable: true }
    ], "or");

    assert.equal(resolution.satisfied, true);
    assert.equal(resolution.selected, null);
});

test("AND task groups choose the next runnable task and retain unsupported blockers", () => {
    const resolution = resolveTask([
        { name: "WATCH_VIDEO", target: 30, progress: 30, runnable: true },
        { name: "PLAY_ACTIVITY", target: 600, progress: 0, runnable: true },
        { name: "ACHIEVEMENT_IN_GAME", target: 1, progress: 0, runnable: false }
    ], "and");

    assert.equal(resolution.selected?.name, "PLAY_ACTIVITY");
    assert.deepEqual(resolution.incompleteUnsupported, ["ACHIEVEMENT_IN_GAME"]);
});

test("legacy desktop-v2 tasks stay visible but never alias the v1 runtime", () => {
    const result = resolveTask([
        { name: "PLAY_ON_DESKTOP_V2", target: 900, progress: 0, runnable: false }
    ], "or");

    assert.equal(result.selected, null);
    assert.deepEqual(result.incompleteUnsupported, ["PLAY_ON_DESKTOP_V2"]);
    assert.equal(result.satisfied, false);
});

test("unknown explicit join operators block task automation", () => {
    const result = resolveTask([
        { name: "WATCH_VIDEO", target: 30, progress: 0, runnable: true }
    ], "unknown");

    assert.equal(result.selected, null);
    assert.deepEqual(result.incompleteUnsupported, ["WATCH_VIDEO"]);
    assert.equal(result.satisfied, false);
});

test("selected Quest platform is prioritized without dropping AND-task alternatives", () => {
    const tasks = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION"];
    assert.deepEqual(prioritizeTaskNames(tasks, "CONSOLE"), [
        "PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION", "WATCH_VIDEO", "PLAY_ON_DESKTOP"
    ]);
    assert.deepEqual(prioritizeTaskNames(tasks, "DESKTOP"), tasks);
    assert.deepEqual(prioritizeTaskNames(tasks, "future-platform"), tasks);
});

test("claim platform selection mirrors Discord's reward modal precedence", () => {
    assert.deepEqual(selectClaimPlatform(undefined, undefined), { kind: "selected", platform: 0 });
    assert.deepEqual(selectClaimPlatform([4], [{ type: 1 }]), { kind: "selected", platform: 0 });
    assert.deepEqual(selectClaimPlatform([2, 1, 2], [{ type: 2 }]), { kind: "selected", platform: 2 });
    assert.deepEqual(selectClaimPlatform([], [{ type: 2 }]), { kind: "selected", platform: 0 });
    assert.deepEqual(selectClaimPlatform([4], [{ type: 2 }, { type: 3 }]), { kind: "selected", platform: 0 });
    assert.deepEqual(selectClaimPlatform([4], [{ type: 2 }, { type: 4 }]), { kind: "selected", platform: 4 });
    assert.deepEqual(selectClaimPlatform(["4", 5], [{ type: 2 }]), { kind: "invalid" });
    assert.deepEqual(selectClaimPlatform([4], [{ type: 6 }]), { kind: "invalid" });
});

test("claim location follows Discord's selected reward modal", () => {
    assert.equal(selectClaimLocation([{ type: 1 }]), 25);
    assert.equal(selectClaimLocation([{ type: 3 }]), 11);
    assert.equal(selectClaimLocation([{ type: 1 }, { type: 3 }]), 11);
    assert.equal(selectClaimLocation([]), 25);
    assert.equal(selectClaimLocation([{ type: "1" }]), 11);
});

test("claim response assessment requires a known body and empty errors", () => {
    assert.deepEqual(assessClaimResponse({ status: 200, body: {} }), { kind: "invalid" });
    assert.deepEqual(assessClaimResponse({ status: 200, body: { errors: [{}] } }), { kind: "rewardErrors" });
    assert.deepEqual(assessClaimResponse({ status: 200, body: { errors: [] } }), { kind: "pending" });
    assert.deepEqual(assessClaimResponse({ status: 200, body: { errors: [], claimed_at: "2026-07-15T12:00:00Z" } }), { kind: "success" });
    assert.deepEqual(assessClaimResponse({ status: 500, body: { errors: [], claimed_at: "2026-07-15T12:00:00Z" } }), { kind: "invalid" });
    assert.deepEqual(assessClaimResponse({ errors: [], claimedAt: "2026-07-15T12:00:00Z" }), { kind: "success" });
    assert.deepEqual(assessClaimResponse({ claimed_at: "2026-07-15T12:00:00Z" }), { kind: "success" });
    assert.deepEqual(assessClaimResponse({ errors: [], user_status: { claimed_at: "2026-07-15T12:00:00Z" } }), { kind: "success" });

    class RestResponse {
        status = 200;
        body = { errors: [], claimed_at: "2026-07-15T12:00:00Z" };
    }
    assert.deepEqual(assessClaimResponse(new RestResponse()), { kind: "success" });
});

test("CAPTCHA classification requires official structural evidence", () => {
    const sentinel = "never-retain-this-challenge-value";
    const direct = classifyClaimFailure({ status: 400, body: { captcha_key: [sentinel] } });
    const nested = classifyClaimFailure({ response: { status: 400, data: { captcha_key: [sentinel] } } });
    const textOnly = classifyClaimFailure({ status: 400, message: "captcha required" });
    const rateLimited = classifyClaimFailure({ status: 429, message: "captcha required" });

    assert.deepEqual(direct, { kind: "captcha", status: 400 });
    assert.deepEqual(nested, { kind: "captcha", status: 400 });
    assert.equal(textOnly.kind, "terminal");
    assert.equal(rateLimited.kind, "transient");
    assert.equal(JSON.stringify([direct, nested]).includes(sentinel), false);
});

test("cancelled Discord CAPTCHA is classified without reading challenge data", () => {
    const error = new Error("cancelled");
    error.name = "CaptchaCancelError";
    assert.deepEqual(classifyClaimFailure(error), { kind: "captcha", status: null });
});

test("claim failures distinguish already-claimed, terminal, transient, and unknown states", () => {
    assert.equal(classifyClaimFailure({ status: 409, body: { code: 260010 } }).kind, "alreadyClaimed");
    assert.equal(classifyClaimFailure({ status: 403 }).kind, "terminal");
    assert.equal(classifyClaimFailure({ status: 503 }).kind, "transient");
    assert.equal(classifyClaimFailure(new Error("offline")).kind, "unknown");
});

test("prototype-derived challenge bodies fail closed", () => {
    const body = Object.create({ captcha_key: ["inherited"] });
    assert.notEqual(classifyClaimFailure({ status: 400, body }).kind, "captcha");
});
