/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import {
    ApplicationStreamingStore,
    Button,
    Flux,
    FluxDispatcher,
    Forms,
    RestAPI,
    RunningGameStore,
    useEffect,
    useRef,
    useState
} from "@webpack/common";

import { assessClaimResponse, calculateRetryDelay, classifyClaimFailure, normalizeJoinOperator, prioritizeTaskNames, resolveTask, RUNNABLE_TASKS, selectClaimLocation, selectClaimPlatform, SERVER_BOUND_TASKS, TaskName } from "./logic";

const logger = new Logger("QuestCompleter");

const DS_COUNT_KEY = "QuestCompleter_completedCount";
const DS_HISTORY_KEY = "QuestCompleter_history";
const HISTORY_MAX = 50;
const MAX_STORED_COUNT = 1_000_000;
const POLL_INTERVAL_MS = 60_000;
const ACTION_DELAY_MS = 1_500;
const QUEST_TIMEOUT_BUFFER_MS = 10 * 60_000;
const MAX_QUEST_TIMEOUT_MS = 2 * 60 * 60_000;
const CLAIM_RECONCILE_TIMEOUT_MS = 5000;
const KNOWN_TASKS = new Set<string>([...RUNNABLE_TASKS, ...SERVER_BOUND_TASKS]);
type Cleanup = () => void;

interface CaptchaModule {
    CaptchaCancelError?: new (...args: never[]) => Error;
}

const Captcha = findByPropsLazy("CaptchaCancelError", "extractCaptchaPropsFromResponse") as CaptchaModule;

type ClaimQuestReward = (questId: string, platform: number, location: number) => Promise<unknown>;
const claimQuestReward = findByCodeLazy(
    "QUESTS_CLAIM_REWARD_BEGIN",
    "QUESTS_CLAIM_REWARD_SUCCESS",
    "QUESTS_CLAIM_REWARD_FAILURE",
    "traffic_metadata_sealed"
) as ClaimQuestReward;

type FetchQuestRewardCode = (questId: string) => Promise<unknown>;
const fetchQuestRewardCode = findByCodeLazy(
    "QUESTS_FETCH_REWARD_CODE_BEGIN",
    "QUESTS_FETCH_REWARD_CODE_SUCCESS",
    "QUESTS_FETCH_REWARD_CODE_FAILURE"
) as FetchQuestRewardCode;

interface HistoryEntry {
    questId?: string;
    questName: string;
    completedAt: number;
}

interface Stats {
    count: number;
    history: HistoryEntry[];
}

interface QuestProgressEntry {
    value?: unknown;
}

interface QuestUserStatus {
    enrolledAt?: unknown;
    completedAt?: unknown;
    claimedAt?: unknown;
    streamProgressSeconds?: unknown;
    progress?: Record<string, QuestProgressEntry | undefined>;
}

interface QuestTaskConfig {
    tasks?: Record<string, unknown>;
    joinOperator?: unknown;
    join_operator?: unknown;
}

interface Quest {
    id: string;
    preview?: unknown;
    config: {
        application?: { id?: unknown; name?: unknown; };
        configVersion?: unknown;
        expiresAt?: unknown;
        startsAt?: unknown;
        features?: unknown;
        messages?: { questName?: unknown; };
        rewardsConfig?: { rewards?: unknown; rewardsExpireAt?: unknown; platforms?: unknown; };
        taskConfig?: QuestTaskConfig;
        taskConfigV2?: QuestTaskConfig;
    };
    userStatus?: QuestUserStatus | null;
}

interface QuestStoreLike {
    quests: Map<string, unknown>;
    questEnrollmentBlockedUntil?: unknown;
    getName?: () => string;
    getQuest?: (id: string) => unknown;
    getRewardCode?: (id: string) => unknown;
    selectedTaskPlatform?: (id: string) => unknown;
}

interface TaskSelection {
    name: TaskName;
    target: number;
    progress: number;
}

interface RetryEntry {
    failures: number;
    retryAt: number;
}

interface RuntimeState {
    controller: AbortController;
    pollInterval: ReturnType<typeof setInterval> | null;
    scheduledCycle: ReturnType<typeof setTimeout> | null;
    scheduledCycleAt: number;
    cyclePromise: Promise<void> | null;
    cycleQueued: boolean;
    enrollQueuePromise: Promise<void> | null;
    claimQueuePromise: Promise<void> | null;
    activeJob: QuestJob | null;
    successfulEnrollments: Map<string, number>;
    successfulClaims: Set<string>;
    inFlightClaims: Set<string>;
    claimNames: Map<string, string>;
    completedQuestIds: Map<string, number>;
    blockedQuestIds: Set<string>;
    enrollRetries: Map<string, RetryEntry>;
    claimRetries: Map<string, RetryEntry>;
    questRetries: Map<string, RetryEntry>;
    lastStoreWarningAt: number;
    observedSchemaFingerprint: string;
    observedTaskNames: string[];
    observedUnsupportedTaskNames: string[];
    observedMobileHandoffs: number;
    remoteCleanupAllowed: boolean;
}

interface QuestJob {
    runtime: RuntimeState;
    questId: string;
    controller: AbortController;
    cleanups: Cleanup[];
    cleaned: boolean;
}

class CancelledError extends Error {
    constructor() {
        super("Quest operation cancelled");
    }
}

class TerminalQuestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TerminalQuestError";
    }
}

let questsStore: QuestStoreLike | null = null;
let runtime: RuntimeState | null = null;
let statsWriteTail: Promise<void> = Promise.resolve();
const runtimeListeners = new Set<() => void>();

function emitRuntimeChange(): void {
    for (const listener of runtimeListeners) listener();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function asFiniteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asTimestamp(value: unknown): number | null {
    if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return null;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
}

function isSnowflake(value: unknown): value is string {
    return typeof value === "string" && /^\d{5,32}$/.test(value);
}

function hasTimestamp(value: unknown): boolean {
    return asTimestamp(value) !== null;
}

function getErrorSummary(error: unknown): string {
    const response = isRecord(error) && isRecord(error.response) ? error.response : null;
    const rawStatus = isRecord(error) ? error.status ?? error.statusCode ?? response?.status ?? response?.statusCode : null;
    const status = typeof rawStatus === "number" || (typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus))
        ? `HTTP ${String(rawStatus)}`
        : null;
    const body = isRecord(error) && isRecord(error.body)
        ? error.body
        : isRecord(response?.body)
            ? response.body
            : isRecord(response?.data)
                ? response.data
                : null;
    const rawCode = body?.code;
    const code = typeof rawCode === "number" && Number.isInteger(rawCode) && rawCode >= 0
        ? `code ${rawCode}`
        : typeof rawCode === "string" && /^\d{1,10}$/.test(rawCode)
            ? `code ${rawCode}`
            : null;
    const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name)
        ? error.name
        : null;
    return [status, code, errorName].filter(Boolean).join(": ") || "Unknown error";
}

function isDiscordCaptchaCancelError(error: unknown): boolean {
    try {
        const { CaptchaCancelError } = Captcha;
        return typeof CaptchaCancelError === "function" && error instanceof CaptchaCancelError;
    } catch {
        return false;
    }
}

function isTerminalQuestError(error: unknown): boolean {
    if (error instanceof TerminalQuestError) return true;
    if (!isRecord(error)) return false;
    const response = isRecord(error.response) ? error.response : null;
    const status = Number(error.status ?? error.statusCode ?? response?.status ?? response?.statusCode);
    return [400, 401, 403, 404, 409, 410].includes(status);
}

function sanitizeCount(value: unknown): number {
    const count = asFiniteNumber(value);
    return count === null ? 0 : Math.min(MAX_STORED_COUNT, Math.max(0, Math.floor(count)));
}

function sanitizeHistory(value: unknown): HistoryEntry[] {
    if (!Array.isArray(value)) return [];

    const history: HistoryEntry[] = [];
    const seenQuestIds = new Set<string>();
    const now = Date.now();

    for (const rawEntry of value.slice(0, HISTORY_MAX * 4)) {
        if (!isRecord(rawEntry)) continue;

        const name = typeof rawEntry.questName === "string" ? rawEntry.questName.trim().slice(0, 200) : "";
        const completedAt = asFiniteNumber(rawEntry.completedAt);
        const questId = isSnowflake(rawEntry.questId) ? rawEntry.questId : undefined;

        if (!name || completedAt === null || completedAt <= 0 || completedAt > now + 5 * 60_000) continue;
        if (questId && seenQuestIds.has(questId)) continue;

        if (questId) seenQuestIds.add(questId);
        history.push({ questId, questName: name, completedAt: Math.floor(completedAt) });
        if (history.length >= HISTORY_MAX) break;
    }

    return history;
}

async function getStats(): Promise<Stats> {
    const [rawCount, rawHistory] = await DataStore.getMany<unknown>([DS_COUNT_KEY, DS_HISTORY_KEY]);
    return { count: sanitizeCount(rawCount), history: sanitizeHistory(rawHistory) };
}

function serializeStatsWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = statsWriteTail.then(operation, operation);
    statsWriteTail = result.then(() => undefined, () => undefined);
    return result;
}

async function recordCompletion(questId: string, questName: string): Promise<void> {
    await serializeStatsWrite(async () => {
        const { count, history } = await getStats();
        if (history.some(entry => entry.questId === questId)) return;

        const nextCount = Math.min(MAX_STORED_COUNT, count + 1);
        const nextHistory = [
            { questId, questName: questName.slice(0, 200), completedAt: Date.now() },
            ...history
        ].slice(0, HISTORY_MAX);

        await DataStore.setMany([
            [DS_COUNT_KEY, nextCount],
            [DS_HISTORY_KEY, nextHistory]
        ]);
        logger.info(`Recorded completion: ${questName} (total: ${nextCount})`);
    });
}

async function resetStats(): Promise<void> {
    await serializeStatsWrite(() => DataStore.setMany([
        [DS_COUNT_KEY, 0],
        [DS_HISTORY_KEY, []]
    ]));
}

function isQuest(value: unknown): value is Quest {
    if (!isRecord(value) || !isSnowflake(value.id) || !isRecord(value.config)) return false;
    return true;
}

function isQuestStore(value: unknown): value is QuestStoreLike {
    if (!isRecord(value) || !(value.quests instanceof Map)) return false;
    const name = typeof value.getName === "function" ? String(value.getName()) : "";
    return name.toLowerCase().includes("quest") || typeof value.getQuest === "function";
}

function getQuestsStore(): QuestStoreLike | null {
    if (isQuestStore(questsStore)) return questsStore;

    try {
        const stores = Flux.Store?.getAll?.();
        if (!Array.isArray(stores)) return null;

        const candidates: QuestStoreLike[] = [];
        for (const candidate of stores) {
            if (isQuestStore(candidate)) candidates.push(candidate);
        }
        const store = candidates.find(candidate => candidate.getName?.() === "QuestStore")
            ?? candidates.find(candidate => typeof candidate.getQuest === "function")
            ?? candidates[0];

        if (store) {
            questsStore = store;
            logger.info(`Discovered quest store: "${store.getName?.() ?? "unknown"}"`);
        }
    } catch (error) {
        logger.warn(`Failed to scan Flux stores: ${getErrorSummary(error)}`);
    }

    return questsStore;
}

function getAllQuests(): Quest[] {
    const store = getQuestsStore();
    if (!store) return [];
    return Array.from(store.quests.values()).filter(isQuest);
}

function getQuestById(id: string): Quest | null {
    const store = getQuestsStore();
    if (!store) return null;

    try {
        const quest = store.getQuest?.(id) ?? store.quests.get(id);
        return isQuest(quest) ? quest : null;
    } catch {
        const quest = store.quests.get(id);
        return isQuest(quest) ? quest : null;
    }
}

function getQuestName(quest: Quest): string {
    const name = quest.config.messages?.questName;
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : "Unnamed quest";
}

function getTaskConfig(quest: Quest): QuestTaskConfig | null {
    const configVersion = asFiniteNumber(quest.config.configVersion);
    if (configVersion === 1) return quest.config.taskConfig ?? quest.config.taskConfigV2 ?? null;
    return quest.config.taskConfigV2 ?? quest.config.taskConfig ?? null;
}

function isRunnableTaskName(value: string): value is TaskName {
    return (RUNNABLE_TASKS as readonly string[]).includes(value);
}

function getApplicationId(quest: Quest, taskName?: string): string | null {
    if (taskName) {
        const rawTask = getTaskConfig(quest)?.tasks?.[taskName];
        if (isRecord(rawTask) && Array.isArray(rawTask.applications)) {
            for (const application of rawTask.applications) {
                if (isRecord(application) && isSnowflake(application.id)) return application.id;
            }
        }
    }

    const id = quest.config.application?.id;
    return isSnowflake(id) ? id : null;
}

function getApplicationName(quest: Quest): string {
    const name = quest.config.application?.name;
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : getQuestName(quest);
}

function getProgress(userStatus: QuestUserStatus | null | undefined, taskName: string, configVersion?: unknown): number {
    const rawProgress = configVersion === 1 && taskName === "STREAM_ON_DESKTOP"
        ? userStatus?.streamProgressSeconds
        : userStatus?.progress?.[taskName]?.value;
    const progress = asFiniteNumber(rawProgress);
    return progress === null ? 0 : Math.max(0, progress);
}

function getTaskSelection(quest: Quest): TaskSelection | null {
    const taskConfig = getTaskConfig(quest);
    const tasks = taskConfig?.tasks;
    if (!isRecord(tasks)) return null;

    let selectedPlatform: unknown;
    try {
        selectedPlatform = getQuestsStore()?.selectedTaskPlatform?.(quest.id);
    } catch {
        selectedPlatform = null;
    }
    const orderedNames = [
        ...prioritizeTaskNames(RUNNABLE_TASKS, selectedPlatform),
        ...Object.keys(tasks).filter(name => !(RUNNABLE_TASKS as readonly string[]).includes(name))
    ];
    const candidates = orderedNames.flatMap(name => {
        const rawTask = tasks[name];
        if (!isRecord(rawTask)) return [];

        const target = asFiniteNumber(rawTask.target);
        if (target === null || target <= 0) return [];

        const progress = Math.min(target, getProgress(quest.userStatus, name, quest.config.configVersion));
        const needsApplication = name === "PLAY_ON_DESKTOP" || name === "STREAM_ON_DESKTOP";
        const runnable = isRunnableTaskName(name) && (!needsApplication || getApplicationId(quest, name) !== null);
        return [{ name, target, progress, runnable }];
    });

    const resolution = resolveTask(
        candidates,
        normalizeJoinOperator(taskConfig?.joinOperator ?? taskConfig?.join_operator)
    );
    if (!resolution.selected || !isRunnableTaskName(resolution.selected.name)) return null;

    return {
        name: resolution.selected.name,
        target: resolution.selected.target,
        progress: resolution.selected.progress
    };
}

function isQuestActive(quest: Quest): boolean {
    const expiresAt = asTimestamp(quest.config.expiresAt);
    const startsAt = asTimestamp(quest.config.startsAt);
    const now = Date.now();
    return expiresAt !== null && expiresAt > now && (startsAt === null || startsAt <= now);
}

function isEnrollmentEligible(quest: Quest): boolean {
    return quest.preview !== true
        && !hasTimestamp(quest.userStatus?.enrolledAt)
        && !hasTimestamp(quest.userStatus?.completedAt)
        && isQuestActive(quest)
        && getTaskSelection(quest) !== null;
}

function isCompletionEligible(quest: Quest): boolean {
    return hasTimestamp(quest.userStatus?.enrolledAt)
        && !hasTimestamp(quest.userStatus?.completedAt)
        && isQuestActive(quest)
        && getTaskSelection(quest) !== null;
}

function isClaimEligible(quest: Quest): boolean {
    if (!hasTimestamp(quest.userStatus?.completedAt) || hasTimestamp(quest.userStatus?.claimedAt)) return false;
    const rewardsExpireAt = asTimestamp(quest.config.rewardsConfig?.rewardsExpireAt);
    return rewardsExpireAt === null || rewardsExpireAt > Date.now();
}

function sortByExpiry(a: Quest, b: Quest): number {
    return (asTimestamp(a.config.expiresAt) ?? Number.MAX_SAFE_INTEGER)
        - (asTimestamp(b.config.expiresAt) ?? Number.MAX_SAFE_INTEGER);
}

function isCurrentRuntime(state: RuntimeState): boolean {
    return runtime === state && !state.controller.signal.aborted;
}

function isJobActive(job: QuestJob): boolean {
    return isCurrentRuntime(job.runtime)
        && job.runtime.activeJob === job
        && !job.controller.signal.aborted;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new CancelledError());

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
            reject(new CancelledError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function addJobCleanup(job: QuestJob, cleanup: Cleanup): void {
    if (job.cleaned) {
        cleanup();
        return;
    }
    job.cleanups.push(cleanup);
}

function cleanupJob(job: QuestJob): void {
    if (job.cleaned) return;
    job.cleaned = true;
    job.controller.abort();

    for (const cleanup of job.cleanups.reverse()) {
        try {
            cleanup();
        } catch (error) {
            logger.error(`Quest cleanup error: ${getErrorSummary(error)}`);
        }
    }
    job.cleanups = [];
}

function cancelActiveJob(state: RuntimeState, reason: string): void {
    const job = state.activeJob;
    if (!job) return;
    logger.info(`Cancelling active quest operation: ${reason}`);
    cleanupJob(job);
    if (state.activeJob === job) state.activeJob = null;
}

function retryReady(retries: Map<string, RetryEntry>, id: string): boolean {
    const retry = retries.get(id);
    return !retry || retry.retryAt <= Date.now();
}

function markRetry(retries: Map<string, RetryEntry>, id: string, baseDelay: number, maxDelay: number): RetryEntry {
    const failures = Math.min(10, (retries.get(id)?.failures ?? 0) + 1);
    const delay = calculateRetryDelay(failures, baseDelay, maxDelay);
    const entry = { failures, retryAt: Date.now() + delay };
    retries.set(id, entry);
    return entry;
}

function hasUnexpiredMarker(markers: Map<string, number>, id: string): boolean {
    const expiresAt = markers.get(id);
    if (!expiresAt) return false;
    if (expiresAt > Date.now()) return true;
    markers.delete(id);
    return false;
}

function scheduleCycle(state: RuntimeState, delay: number): void {
    if (!isCurrentRuntime(state)) return;
    const scheduledAt = Date.now() + delay;
    if (state.scheduledCycle && state.scheduledCycleAt <= scheduledAt) return;

    if (state.scheduledCycle) clearTimeout(state.scheduledCycle);
    state.scheduledCycleAt = scheduledAt;
    state.scheduledCycle = setTimeout(() => {
        state.scheduledCycle = null;
        state.scheduledCycleAt = 0;
        queueCycle(state);
    }, delay);
}

function queueCycle(state: RuntimeState): void {
    if (!isCurrentRuntime(state)) return;
    if (state.cyclePromise) {
        state.cycleQueued = true;
        return;
    }

    state.cyclePromise = runCycle(state)
        .catch(error => {
            if (!(error instanceof CancelledError)) logger.error(`Cycle error: ${getErrorSummary(error)}`);
        })
        .finally(() => {
            state.cyclePromise = null;
            if (state.cycleQueued && isCurrentRuntime(state)) {
                state.cycleQueued = false;
                queueCycle(state);
            }
        });
}

function updateObservedSchema(state: RuntimeState): void {
    const taskCounts = new Map<string, number>();
    const joinCounts = new Map<string, number>();
    let mobileHandoffs = 0;

    for (const quest of getAllQuests()) {
        if (!isQuestActive(quest)) continue;
        const taskConfig = getTaskConfig(quest);
        if (!isRecord(taskConfig?.tasks)) continue;

        const joinOperator = normalizeJoinOperator(taskConfig?.joinOperator ?? taskConfig?.join_operator);
        joinCounts.set(joinOperator, (joinCounts.get(joinOperator) ?? 0) + 1);
        for (const rawName of Object.keys(taskConfig.tasks)) {
            const name = /^[A-Za-z0-9_:-]{1,80}$/.test(rawName) ? rawName : "<invalid>";
            taskCounts.set(name, (taskCounts.get(name) ?? 0) + 1);
        }

        if (Array.isArray(quest.config.features) && quest.config.features.some(feature => feature === 7 || feature === 23)) {
            mobileHandoffs++;
        }
    }

    const taskNames = Array.from(taskCounts.keys()).sort();
    const unsupportedTaskNames = taskNames.filter(name => !KNOWN_TASKS.has(name) || (SERVER_BOUND_TASKS as readonly string[]).includes(name));
    const fingerprint = JSON.stringify({
        tasks: Array.from(taskCounts.entries()).sort(([left], [right]) => left.localeCompare(right)),
        joins: Array.from(joinCounts.entries()).sort(([left], [right]) => left.localeCompare(right)),
        mobileHandoffs
    });
    if (state.observedSchemaFingerprint === fingerprint) return;

    state.observedSchemaFingerprint = fingerprint;
    state.observedTaskNames = taskNames;
    state.observedUnsupportedTaskNames = unsupportedTaskNames;
    state.observedMobileHandoffs = mobileHandoffs;
    logger.info(
        `Observed active quest schema: tasks=${taskNames.join(",") || "none"}; `
        + `joins=${Array.from(joinCounts.entries()).map(([name, count]) => `${name}:${count}`).join(",") || "none"}; `
        + `mobile-handoffs=${mobileHandoffs}.`
    );
    emitRuntimeChange();
}

async function finalizeClaimDetails(state: RuntimeState, questId: string, questName: string): Promise<void> {
    if (state.successfulClaims.has(questId)) return;

    state.successfulClaims.add(questId);
    state.claimRetries.delete(questId);
    state.claimNames.delete(questId);
    emitRuntimeChange();

    try {
        await recordCompletion(questId, questName);
        emitRuntimeChange();
    } catch (error) {
        logger.error(`Claimed ${questName}, but failed to update local stats: ${getErrorSummary(error)}`);
    }
}

async function finalizeClaim(state: RuntimeState, quest: Quest): Promise<void> {
    return finalizeClaimDetails(state, quest.id, getQuestName(quest));
}

async function waitForClaimReconciliation(state: RuntimeState, questId: string): Promise<boolean> {
    const deadline = Date.now() + CLAIM_RECONCILE_TIMEOUT_MS;
    while (isCurrentRuntime(state) && Date.now() < deadline) {
        if (hasTimestamp(getQuestById(questId)?.userStatus?.claimedAt)) return true;
        await sleep(250, state.controller.signal);
    }
    return false;
}

async function tryRecoverRewardCodeClaim(state: RuntimeState, quest: Quest): Promise<boolean> {
    if (selectClaimLocation(quest.config.rewardsConfig?.rewards) !== 25) return false;

    try {
        await fetchQuestRewardCode(quest.id);
        if (!isCurrentRuntime(state)) return false;

        const storedRewardCode = getQuestsStore()?.getRewardCode?.(quest.id);
        if (isRecord(storedRewardCode) && (
            hasTimestamp(storedRewardCode.claimedAt) || hasTimestamp(storedRewardCode.claimed_at)
        )) return true;

        return waitForClaimReconciliation(state, quest.id);
    } catch (error) {
        logger.warn(`Reward-code recovery did not confirm ${getQuestName(quest)}: ${getErrorSummary(error)}`);
        return false;
    }
}

async function autoEnroll(state: RuntimeState): Promise<void> {
    const enrollmentBlockedUntil = asTimestamp(getQuestsStore()?.questEnrollmentBlockedUntil);
    if (enrollmentBlockedUntil !== null && enrollmentBlockedUntil > Date.now()) return;

    const quests = getAllQuests().filter(isEnrollmentEligible).sort(sortByExpiry);

    for (let index = 0; index < quests.length && isCurrentRuntime(state); index++) {
        const quest = quests[index];
        if (
            hasUnexpiredMarker(state.successfulEnrollments, quest.id)
            || state.blockedQuestIds.has(quest.id)
            || !retryReady(state.enrollRetries, quest.id)
        ) continue;

        const questName = getQuestName(quest);
        try {
            const currentBlockUntil = asTimestamp(getQuestsStore()?.questEnrollmentBlockedUntil);
            if (currentBlockUntil !== null && currentBlockUntil > Date.now()) break;

            await RestAPI.post({
                url: `/quests/${quest.id}/enroll`,
                body: { location: 11, is_targeted: false }
            });
            if (!isCurrentRuntime(state)) return;

            state.successfulEnrollments.set(quest.id, Date.now() + 5 * 60_000);
            state.enrollRetries.delete(quest.id);
            logger.info(`Auto-enrolled in quest: ${questName}`);
            scheduleCycle(state, ACTION_DELAY_MS);
        } catch (error) {
            if (!isCurrentRuntime(state)) return;
            if (isTerminalQuestError(error)) {
                state.blockedQuestIds.add(quest.id);
                state.enrollRetries.delete(quest.id);
                logger.warn(`Discord rejected enrollment for ${questName}; waiting for a quest status refresh.`);
                continue;
            }
            const retry = markRetry(state.enrollRetries, quest.id, 60_000, 15 * 60_000);
            logger.warn(`Failed to enroll in ${questName}: ${getErrorSummary(error)}. Retry after ${new Date(retry.retryAt).toLocaleTimeString()}.`);
        }

        if (index < quests.length - 1) await sleep(ACTION_DELAY_MS, state.controller.signal);
    }
}

function startEnrollmentQueue(state: RuntimeState): void {
    if (!isCurrentRuntime(state) || state.enrollQueuePromise) return;

    const enrollQueuePromise = autoEnroll(state)
        .catch(error => {
            if (isCurrentRuntime(state)) {
                logger.error(`Quest enrollment queue failed: ${getErrorSummary(error)}`);
            }
        })
        .finally(() => {
            if (state.enrollQueuePromise !== enrollQueuePromise) return;
            state.enrollQueuePromise = null;
            if (isCurrentRuntime(state)) scheduleCycle(state, 250);
            emitRuntimeChange();
        });

    state.enrollQueuePromise = enrollQueuePromise;
}

async function autoClaim(state: RuntimeState): Promise<void> {
    const quests = getAllQuests().filter(isClaimEligible).sort(sortByExpiry);

    for (let index = 0; index < quests.length && isCurrentRuntime(state); index++) {
        const quest = quests[index];
        if (
            state.successfulClaims.has(quest.id)
            || state.inFlightClaims.has(quest.id)
            || !retryReady(state.claimRetries, quest.id)
        ) continue;

        const rewards = quest.config.rewardsConfig?.rewards;
        const platformDecision = selectClaimPlatform(quest.config.rewardsConfig?.platforms, rewards);
        if (platformDecision.kind === "invalid") {
            const retry = markRetry(state.claimRetries, quest.id, 30 * 60_000, 6 * 60 * 60_000);
            logger.warn(`Discord returned an unknown reward schema for ${getQuestName(quest)}; automatic retry after ${new Date(retry.retryAt).toLocaleTimeString()}.`);
            continue;
        }

        const questName = getQuestName(quest);
        state.claimNames.set(quest.id, questName);
        state.inFlightClaims.add(quest.id);
        emitRuntimeChange();
        try {
            // Use Discord's own action creator so the request carries whatever
            // current ad-decision metadata applies and remains inside Discord's
            // built-in CAPTCHA interceptor. Challenge values never enter this plugin.
            const claimLocation = selectClaimLocation(rewards);
            logger.info(`Submitting Discord's native reward claim for: ${questName}`);
            const response = await claimQuestReward(quest.id, platformDecision.platform, claimLocation);
            if (!isCurrentRuntime(state)) return;

            const assessment = assessClaimResponse(response);
            if (assessment.kind === "rewardErrors") {
                if (await waitForClaimReconciliation(state, quest.id)) {
                    await finalizeClaim(state, quest);
                    logger.info(`Auto-claimed reward for: ${questName}`);
                    continue;
                }
                if (await tryRecoverRewardCodeClaim(state, quest)) {
                    await finalizeClaim(state, quest);
                    logger.info(`Recovered and confirmed reward-code claim for: ${questName}`);
                    continue;
                }
                const retry = markRetry(state.claimRetries, quest.id, 30 * 60_000, 6 * 60 * 60_000);
                logger.warn(`Discord returned reward errors for ${questName}; automatic retry after ${new Date(retry.retryAt).toLocaleTimeString()}.`);
                continue;
            }
            if (assessment.kind === "invalid" && !await waitForClaimReconciliation(state, quest.id)) {
                throw new Error("Discord returned an invalid claim response");
            }
            if (assessment.kind === "pending" && !await waitForClaimReconciliation(state, quest.id)) {
                throw new Error("Discord did not confirm the claim in time");
            }

            await finalizeClaim(state, quest);
            logger.info(`Auto-claimed reward for: ${questName}`);
        } catch (error) {
            if (!isCurrentRuntime(state)) return;
            const failure = isDiscordCaptchaCancelError(error)
                ? { kind: "captcha" as const, status: null }
                : classifyClaimFailure(error);
            if (failure.kind !== "captcha" && await tryRecoverRewardCodeClaim(state, quest)) {
                await finalizeClaim(state, quest);
                logger.info(`Recovered and confirmed reward-code claim for: ${questName}`);
                continue;
            }
            if (failure.kind === "captcha") {
                const retry = markRetry(state.claimRetries, quest.id, 15 * 60_000, 60 * 60_000);
                logger.warn(`Discord's native reward confirmation was dismissed for ${questName}; automatic retry after ${new Date(retry.retryAt).toLocaleTimeString()}.`);
            } else if (failure.kind === "alreadyClaimed" && hasTimestamp(getQuestById(quest.id)?.userStatus?.claimedAt)) {
                await finalizeClaim(state, quest);
            } else if (failure.kind === "alreadyClaimed" || failure.kind === "terminal") {
                const retry = markRetry(
                    state.claimRetries,
                    quest.id,
                    failure.kind === "alreadyClaimed" ? 5 * 60_000 : 30 * 60_000,
                    failure.kind === "alreadyClaimed" ? 30 * 60_000 : 6 * 60 * 60_000
                );
                logger.warn(`Discord rejected automatic claiming for ${questName} (${getErrorSummary(error)}); automatic retry after ${new Date(retry.retryAt).toLocaleTimeString()}.`);
            } else {
                const retry = markRetry(state.claimRetries, quest.id, 15 * 60_000, 60 * 60_000);
                logger.warn(`Failed to claim ${questName}: ${getErrorSummary(error)}. Retry after ${new Date(retry.retryAt).toLocaleTimeString()}.`);
            }
        } finally {
            state.inFlightClaims.delete(quest.id);
            emitRuntimeChange();
        }

        if (index < quests.length - 1) await sleep(ACTION_DELAY_MS, state.controller.signal);
    }
}

function startClaimQueue(state: RuntimeState): void {
    if (!isCurrentRuntime(state) || state.claimQueuePromise) return;

    const claimQueuePromise = autoClaim(state)
        .catch(error => {
            if (isCurrentRuntime(state)) {
                logger.error(`Reward claim queue failed: ${getErrorSummary(error)}`);
            }
        })
        .finally(() => {
            if (state.claimQueuePromise !== claimQueuePromise) return;
            state.claimQueuePromise = null;
            if (isCurrentRuntime(state)) scheduleCycle(state, 250);
            emitRuntimeChange();
        });

    state.claimQueuePromise = claimQueuePromise;
    emitRuntimeChange();
}

function getResponseStatus(response: unknown): QuestUserStatus | null {
    if (!isRecord(response)) return null;
    const body = isRecord(response.body) ? response.body : response;
    const nested = body.userStatus ?? body.user_status ?? body.questUserStatus ?? body.quest_user_status;
    return isRecord(nested) ? nested as QuestUserStatus : body as QuestUserStatus;
}

function responseCompleted(response: unknown): boolean {
    const status = getResponseStatus(response);
    return hasTimestamp(status?.completedAt) || hasTimestamp(isRecord(status) ? status.completed_at : undefined);
}

function getResponseProgress(response: unknown, taskName: TaskName): number | null {
    const status = getResponseStatus(response);
    if (!status || !isRecord(status.progress)) return null;
    const entry = status.progress[taskName];
    if (!isRecord(entry)) return null;
    return asFiniteNumber(entry.value);
}

async function completeVideoQuest(job: QuestJob, quest: Quest, task: TaskSelection): Promise<boolean> {
    let { progress } = task;
    let submittedProgress = progress;
    const enrolledAt = Math.min(Date.now(), asTimestamp(quest.userStatus?.enrolledAt) ?? Date.now() - progress * 1000);
    const deadline = Date.now() + Math.min(MAX_QUEST_TIMEOUT_MS, Math.max(5 * 60_000, (task.target - progress) * 1000 + QUEST_TIMEOUT_BUFFER_MS));
    let failures = 0;

    while (isJobActive(job) && Date.now() < deadline) {
        const refreshed = getQuestById(quest.id);
        if (refreshed && hasTimestamp(refreshed.userStatus?.completedAt)) return true;
        if (refreshed && !isQuestActive(refreshed)) return false;
        if (refreshed) {
            progress = Math.min(task.target, Math.max(progress, getProgress(refreshed.userStatus, task.name, refreshed.config.configVersion)));
            if (progress >= task.target) return true;
        }

        const maxAllowed = Math.max(submittedProgress, Math.floor((Date.now() - enrolledAt) / 1000) + 10);
        const timestamp = Math.min(task.target, maxAllowed, submittedProgress + 7 + Math.random());
        if (timestamp <= submittedProgress + 0.01) {
            await sleep(1000, job.controller.signal);
            continue;
        }

        try {
            const response = await RestAPI.post({
                url: `/quests/${quest.id}/video-progress`,
                body: { timestamp }
            });
            if (!isJobActive(job)) return false;

            failures = 0;
            submittedProgress = Math.max(submittedProgress, timestamp);
            const responseProgress = getResponseProgress(response, task.name);
            const storeProgress = getProgress(getQuestById(quest.id)?.userStatus, task.name, quest.config.configVersion);
            progress = Math.min(task.target, Math.max(progress, responseProgress ?? 0, storeProgress));
            logger.info(`Video quest progress for ${getQuestName(quest)}: ${Math.floor(progress)}/${task.target}`);
            if (responseCompleted(response) || progress >= task.target) return true;
        } catch (error) {
            if (!isJobActive(job)) return false;
            failures++;
            logger.warn(`Video progress error for ${getQuestName(quest)}: ${getErrorSummary(error)}`);
            if (isTerminalQuestError(error)) throw new TerminalQuestError("Discord rejected video progress for this quest");
            if (failures >= 3) return false;
            await sleep(3000, job.controller.signal);
            continue;
        }

        await sleep(1000, job.controller.signal);
    }

    return false;
}

function sanitizeExecutableName(value: string): string {
    const sanitized = value.replace(/[\\/:*?"<>|]/g, "").trim();
    return sanitized || "DiscordQuest.exe";
}

async function getFakeGameData(job: QuestJob, quest: Quest, taskName: TaskName): Promise<{ name: string; exeName: string; }> {
    const applicationId = getApplicationId(quest, taskName)!;
    const fallbackName = getApplicationName(quest);

    try {
        const response = await RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` });
        if (!isJobActive(job)) throw new CancelledError();

        const body = isRecord(response) && Array.isArray(response.body) ? response.body : [];
        const app = isRecord(body[0]) ? body[0] : null;
        const name = app && typeof app.name === "string" && app.name.trim() ? app.name.trim() : fallbackName;
        const executables = app && Array.isArray(app.executables) ? app.executables : [];
        const windowsExecutable = executables.find(executable => isRecord(executable) && executable.os === "win32");
        const rawExecutable = isRecord(windowsExecutable) && typeof windowsExecutable.name === "string"
            ? windowsExecutable.name.replace(">", "")
            : `${sanitizeExecutableName(name)}.exe`;
        return { name, exeName: sanitizeExecutableName(rawExecutable) };
    } catch (error) {
        if (error instanceof CancelledError) throw error;
        logger.warn(`Application metadata lookup failed for ${fallbackName}; using a safe fallback: ${getErrorSummary(error)}`);
        return { name: fallbackName, exeName: `${sanitizeExecutableName(fallbackName)}.exe` };
    }
}

function getEventQuestId(data: unknown): string | null {
    if (!isRecord(data)) return null;
    const status = isRecord(data.userStatus)
        ? data.userStatus
        : isRecord(data.user_status)
            ? data.user_status
            : null;
    const id = data.questId ?? data.quest_id ?? status?.questId ?? status?.quest_id;
    return isSnowflake(id) ? id : null;
}

function getEventStatus(data: unknown): QuestUserStatus | null {
    if (!isRecord(data)) return null;
    if (isRecord(data.userStatus)) return data.userStatus as QuestUserStatus;
    return isRecord(data.user_status) ? data.user_status as QuestUserStatus : null;
}

function waitForHeartbeatCompletion(job: QuestJob, quest: Quest, task: TaskSelection): Promise<boolean> {
    const timeoutMs = Math.min(MAX_QUEST_TIMEOUT_MS, Math.max(5 * 60_000, (task.target - task.progress) * 1000 + QUEST_TIMEOUT_BUFFER_MS));

    return new Promise(resolve => {
        let settled = false;
        const finish = (result: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            clearInterval(storePoll);
            job.controller.signal.removeEventListener("abort", onAbort);
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_FAILURE", onHeartbeatFailure);
            resolve(result);
        };
        const checkStatus = (status: QuestUserStatus | null | undefined) => {
            const progress = getProgress(status, task.name, quest.config.configVersion);
            if (progress > 0) logger.info(`${task.name} progress for ${getQuestName(quest)}: ${Math.floor(progress)}/${task.target}`);
            if (hasTimestamp(status?.completedAt) || progress >= task.target) finish(true);
        };
        const onHeartbeat = (data: unknown) => {
            const eventQuestId = getEventQuestId(data);
            if (eventQuestId && eventQuestId !== quest.id) return;
            if (eventQuestId === quest.id) checkStatus(getEventStatus(data) ?? getQuestById(quest.id)?.userStatus);
            else checkStatus(getQuestById(quest.id)?.userStatus);
        };
        const onHeartbeatFailure = (data: unknown) => {
            if (getEventQuestId(data) === quest.id) finish(false);
        };
        const onAbort = () => finish(false);
        const timeout = setTimeout(() => finish(false), timeoutMs);
        const storePoll = setInterval(() => {
            const refreshed = getQuestById(quest.id);
            if (!refreshed || !isQuestActive(refreshed)) finish(false);
            else checkStatus(refreshed.userStatus);
        }, 15_000);

        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_FAILURE", onHeartbeatFailure);
        job.controller.signal.addEventListener("abort", onAbort, { once: true });
        addJobCleanup(job, onAbort);
    });
}

async function completePlayQuest(job: QuestJob, quest: Quest, task: TaskSelection): Promise<boolean> {
    const applicationId = getApplicationId(quest, task.name)!;
    const appData = await getFakeGameData(job, quest, task.name);
    if (!isJobActive(job)) return false;

    const store = RunningGameStore as unknown as {
        getRunningGames: () => unknown[];
        getGameForPID: (pid: number) => unknown;
    };
    if (typeof store?.getRunningGames !== "function" || typeof store.getGameForPID !== "function") {
        throw new Error("RunningGameStore is unavailable");
    }

    const pid = Math.floor(Math.random() * 30_000) + 1000;
    const realGetRunningGames = store.getRunningGames;
    const realGetGameForPID = store.getGameForPID;
    const realGames = realGetRunningGames.call(store);
    const safeRealGames = Array.isArray(realGames) ? realGames : [];
    if (safeRealGames.some(game => isRecord(game) && game.id === applicationId)) {
        logger.info(`${appData.name} is already running; using the real game for ${getQuestName(quest)}.`);
        return waitForHeartbeatCompletion(job, quest, task);
    }

    const fakeGame = {
        cmdLine: `C:\\Program Files\\${appData.name}\\${appData.exeName}`,
        exeName: appData.exeName,
        exePath: `c:/program files/${appData.name.toLowerCase()}/${appData.exeName}`,
        hidden: false,
        isLauncher: false,
        id: applicationId,
        name: appData.name,
        pid,
        pidPath: [pid],
        processName: appData.name,
        start: Date.now()
    };
    const fakeGames = [...safeRealGames.filter(game => !isRecord(game) || game.id !== applicationId), fakeGame];
    const getRunningGames = () => fakeGames;
    const getGameForPID = (requestedPid: number) => requestedPid === pid
        ? fakeGame
        : realGetGameForPID.call(store, requestedPid);

    store.getRunningGames = getRunningGames;
    store.getGameForPID = getGameForPID;
    addJobCleanup(job, () => {
        if (store.getRunningGames === getRunningGames) store.getRunningGames = realGetRunningGames;
        if (store.getGameForPID === getGameForPID) store.getGameForPID = realGetGameForPID;
        const restoredGames = realGetRunningGames.call(store);
        FluxDispatcher.dispatch({
            type: "RUNNING_GAMES_CHANGE",
            removed: [fakeGame],
            added: [],
            games: Array.isArray(restoredGames) ? restoredGames : safeRealGames
        });
    });

    FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [], added: [fakeGame], games: fakeGames });
    logger.info(`Spoofed game to ${appData.name}. About ${Math.ceil((task.target - task.progress) / 60)} minutes remaining.`);
    return waitForHeartbeatCompletion(job, quest, task);
}

async function completeStreamQuest(job: QuestJob, quest: Quest, task: TaskSelection): Promise<boolean> {
    const applicationId = getApplicationId(quest, task.name)!;
    const store = ApplicationStreamingStore as unknown as {
        getStreamerActiveStreamMetadata: () => unknown;
    };
    if (typeof store?.getStreamerActiveStreamMetadata !== "function") {
        throw new Error("ApplicationStreamingStore is unavailable");
    }

    const realFunction = store.getStreamerActiveStreamMetadata;
    const pid = Math.floor(Math.random() * 30_000) + 1000;
    const spoofedFunction = () => ({ id: applicationId, pid, sourceName: null });
    store.getStreamerActiveStreamMetadata = spoofedFunction;
    addJobCleanup(job, () => {
        if (store.getStreamerActiveStreamMetadata === spoofedFunction) {
            store.getStreamerActiveStreamMetadata = realFunction;
        }
    });

    logger.info(`Spoofed stream to ${getApplicationName(quest)}. Stream a window in voice chat for about ${Math.ceil((task.target - task.progress) / 60)} minutes; Discord requires another viewer.`);
    return waitForHeartbeatCompletion(job, quest, task);
}

async function completeActivityQuest(job: QuestJob, quest: Quest, task: TaskSelection): Promise<boolean> {
    const streamKey = `call:${quest.id}:1`;
    const deadline = Date.now() + Math.min(MAX_QUEST_TIMEOUT_MS, Math.max(5 * 60_000, (task.target - task.progress) * 1000 + QUEST_TIMEOUT_BUFFER_MS));
    let failures = 0;

    while (isJobActive(job) && Date.now() < deadline) {
        try {
            const response = await RestAPI.post({
                url: `/quests/${quest.id}/heartbeat`,
                body: { stream_key: streamKey, terminal: false }
            });
            if (!isJobActive(job)) return false;

            failures = 0;
            const progress = getResponseProgress(response, task.name) ?? getProgress(getQuestById(quest.id)?.userStatus, task.name);
            logger.info(`Activity quest progress for ${getQuestName(quest)}: ${Math.floor(progress)}/${task.target}`);
            if (responseCompleted(response) || progress >= task.target) {
                try {
                    await RestAPI.post({
                        url: `/quests/${quest.id}/heartbeat`,
                        body: { stream_key: streamKey, terminal: true }
                    });
                } catch (error) {
                    logger.warn(`Final activity heartbeat failed for ${getQuestName(quest)}: ${getErrorSummary(error)}`);
                }
                return true;
            }
        } catch (error) {
            if (!isJobActive(job)) return false;
            failures++;
            logger.warn(`Activity heartbeat error for ${getQuestName(quest)}: ${getErrorSummary(error)}`);
            if (isTerminalQuestError(error)) throw new TerminalQuestError("Discord rejected activity heartbeats for this quest");
            if (failures >= 3) return false;
        }

        await sleep(20_000, job.controller.signal);
    }

    return false;
}

function responseHasConsoleErrors(response: unknown): boolean {
    if (!isRecord(response)) return true;
    const body = isRecord(response.body) ? response.body : response;
    return (Array.isArray(body.error_hints) && body.error_hints.length > 0)
        || (Array.isArray(body.error_hints_v2) && body.error_hints_v2.length > 0);
}

async function completeConsoleQuest(job: QuestJob, quest: Quest, task: TaskSelection): Promise<boolean> {
    const response = await RestAPI.post({ url: `/quests/${quest.id}/console/start` });
    if (!isJobActive(job)) return false;

    if (responseHasConsoleErrors(response)) {
        logger.info(
            `Discord could not start linked-console tracking for ${getQuestName(quest)}. `
            + "Check the Xbox or PlayStation connection, online presence, and game privacy settings."
        );
        return false;
    }

    let stopped = false;
    const stopTracking = () => {
        if (stopped) return;
        stopped = true;
        if (!job.runtime.remoteCleanupAllowed) return;
        void RestAPI.post({ url: `/quests/${quest.id}/console/stop` }).catch(error => {
            logger.warn(`Could not stop linked-console tracking cleanly: ${getErrorSummary(error)}`);
        });
    };
    addJobCleanup(job, stopTracking);

    const status = getResponseStatus(response);
    if (hasTimestamp(status?.completedAt) || getProgress(status, task.name) >= task.target) return true;

    logger.info(
        `Started linked-console tracking for ${getQuestName(quest)} (${task.name}). `
        + "Keep the linked console account online and play the required game."
    );
    return waitForHeartbeatCompletion(job, quest, task);
}

async function runQuestJob(job: QuestJob, quest: Quest, task: TaskSelection): Promise<void> {
    const questName = getQuestName(quest);
    logger.info(`Starting quest: ${questName} (${task.name}) - ${Math.floor(task.progress)}/${task.target}`);

    try {
        let completed = false;
        switch (task.name) {
            case "WATCH_VIDEO":
            case "WATCH_VIDEO_ON_MOBILE":
                completed = await completeVideoQuest(job, quest, task);
                break;
            case "PLAY_ON_DESKTOP":
                completed = await completePlayQuest(job, quest, task);
                break;
            case "STREAM_ON_DESKTOP":
                completed = await completeStreamQuest(job, quest, task);
                break;
            case "PLAY_ACTIVITY":
                completed = await completeActivityQuest(job, quest, task);
                break;
            case "PLAY_ON_XBOX":
            case "PLAY_ON_PLAYSTATION":
                completed = await completeConsoleQuest(job, quest, task);
                break;
        }

        if (!isJobActive(job)) return;
        if (completed) {
            job.runtime.completedQuestIds.set(quest.id, Date.now() + 10 * 60_000);
            job.runtime.questRetries.delete(quest.id);
            logger.info(`Quest completed: ${questName}`);
        } else {
            const retry = markRetry(job.runtime.questRetries, quest.id, 60_000, 15 * 60_000);
            logger.warn(`Quest did not complete: ${questName}. Retry after ${new Date(retry.retryAt).toLocaleTimeString()}.`);
        }
    } catch (error) {
        if (error instanceof CancelledError || !isJobActive(job)) return;
        if (error instanceof TerminalQuestError || isTerminalQuestError(error)) {
            job.runtime.blockedQuestIds.add(quest.id);
            job.runtime.questRetries.delete(quest.id);
            logger.warn(`Quest is blocked by Discord and will wait for a status change: ${questName}.`);
            emitRuntimeChange();
            return;
        }
        const retry = markRetry(job.runtime.questRetries, quest.id, 60_000, 15 * 60_000);
        logger.error(`Quest failed: ${questName}: ${getErrorSummary(error)}. Retry after ${new Date(retry.retryAt).toLocaleTimeString()}.`);
    }
}

function startQuestJob(state: RuntimeState, quest: Quest, task: TaskSelection): void {
    if (!isCurrentRuntime(state) || state.activeJob) return;

    const job: QuestJob = {
        runtime: state,
        questId: quest.id,
        controller: new AbortController(),
        cleanups: [],
        cleaned: false
    };
    const abortFromRuntime = () => job.controller.abort();
    state.controller.signal.addEventListener("abort", abortFromRuntime, { once: true });
    addJobCleanup(job, () => state.controller.signal.removeEventListener("abort", abortFromRuntime));
    state.activeJob = job;

    void runQuestJob(job, quest, task).finally(() => {
        cleanupJob(job);
        if (state.activeJob === job) state.activeJob = null;
        if (isCurrentRuntime(state)) scheduleCycle(state, 250);
    });
}

async function runCycle(state: RuntimeState): Promise<void> {
    if (!isCurrentRuntime(state)) return;

    const store = getQuestsStore();
    if (!store || typeof RestAPI?.post !== "function") {
        if (Date.now() - state.lastStoreWarningAt > 5 * 60_000) {
            state.lastStoreWarningAt = Date.now();
            logger.info("Quest APIs are not ready yet; waiting for the next cycle.");
        }
        return;
    }

    updateObservedSchema(state);

    // Discord's global CAPTCHA interceptor can keep an enrollment or claim
    // Promise pending. Isolate both serialized lanes so neither can pause
    // unrelated quest-completion work.
    startEnrollmentQueue(state);
    startClaimQueue(state);
    if (!isCurrentRuntime(state) || state.activeJob) return;

    const quest = getAllQuests()
        .filter(isCompletionEligible)
        .filter(candidate => !hasUnexpiredMarker(state.completedQuestIds, candidate.id))
        .filter(candidate => !state.blockedQuestIds.has(candidate.id))
        .filter(candidate => retryReady(state.questRetries, candidate.id))
        .sort(sortByExpiry)[0];
    if (!quest) return;

    const task = getTaskSelection(quest);
    if (task) startQuestJob(state, quest, task);
}

function createRuntime(): RuntimeState {
    return {
        controller: new AbortController(),
        pollInterval: null,
        scheduledCycle: null,
        scheduledCycleAt: 0,
        cyclePromise: null,
        cycleQueued: false,
        enrollQueuePromise: null,
        claimQueuePromise: null,
        activeJob: null,
        successfulEnrollments: new Map(),
        successfulClaims: new Set(),
        inFlightClaims: new Set(),
        claimNames: new Map(),
        completedQuestIds: new Map(),
        blockedQuestIds: new Set(),
        enrollRetries: new Map(),
        claimRetries: new Map(),
        questRetries: new Map(),
        lastStoreWarningAt: 0,
        observedSchemaFingerprint: "",
        observedTaskNames: [],
        observedUnsupportedTaskNames: [],
        observedMobileHandoffs: 0,
        remoteCleanupAllowed: true
    };
}

function stopRuntime(state: RuntimeState): void {
    state.controller.abort();
    cancelActiveJob(state, "plugin stopped");
    if (state.pollInterval) clearInterval(state.pollInterval);
    if (state.scheduledCycle) clearTimeout(state.scheduledCycle);
    state.pollInterval = null;
    state.scheduledCycle = null;
    state.cycleQueued = false;
    if (runtime === state) runtime = null;
    questsStore = null;
    emitRuntimeChange();
}

function activateRuntime(initialDelay: number): RuntimeState {
    const state = createRuntime();
    runtime = state;
    scheduleCycle(state, initialDelay);
    state.pollInterval = setInterval(() => queueCycle(state), POLL_INTERVAL_MS);
    return state;
}

function handleConnectionOpen(): void {
    const previous = runtime;
    if (!previous) return;

    // Replace the entire generation so any enrollment or claim request that
    // began before an account/gateway reconnect becomes stale when it returns.
    // Aborting only the active progress job would still let the old cycle
    // mutate retry/dedup state for the newly connected account.
    previous.remoteCleanupAllowed = false;
    stopRuntime(previous);
    activateRuntime(5000);
}

function scheduleStatusRefresh(): void {
    if (runtime) scheduleCycle(runtime, 250);
}

function handleQuestStatusRefresh(data?: unknown): void {
    if (!runtime) return;
    const questId = getEventQuestId(data);
    if (questId) runtime.blockedQuestIds.delete(questId);
    scheduleCycle(runtime, 250);
}

function handleFullQuestRefresh(): void {
    if (!runtime) return;
    runtime.blockedQuestIds.clear();
    scheduleCycle(runtime, 250);
}

function handleTaskPlatformSelection(data?: unknown): void {
    const state = runtime;
    if (!state) return;
    const questId = getEventQuestId(data);
    if (questId) {
        state.blockedQuestIds.delete(questId);
        if (state.activeJob?.questId === questId) cancelActiveJob(state, "task platform changed");
    }
    scheduleCycle(state, 250);
}

function handleClaimSuccess(data?: unknown): void {
    const state = runtime;
    if (!state) return;
    const questId = getEventQuestId(data);
    if (!questId) {
        scheduleCycle(state, 250);
        return;
    }

    state.blockedQuestIds.delete(questId);
    const quest = getQuestById(questId);
    if (quest) void finalizeClaim(state, quest);
    else {
        const questName = state.claimNames.get(questId);
        if (questName) void finalizeClaimDetails(state, questId, questName);
    }
    scheduleCycle(state, 250);
}

function StatsPanel() {
    const mounted = useRef(true);
    const [count, setCount] = useState(0);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [, setRuntimeRevision] = useState(0);

    const refresh = async () => {
        try {
            const stats = await getStats();
            if (!mounted.current) return;
            setCount(stats.count);
            setHistory(stats.history);
            setError(null);
        } catch (readError) {
            if (mounted.current) setError(`Could not load stats: ${getErrorSummary(readError)}`);
        } finally {
            if (mounted.current) setLoaded(true);
        }
    };

    useEffect(() => {
        mounted.current = true;
        const onRuntimeChange = () => {
            if (!mounted.current) return;
            setRuntimeRevision(revision => revision + 1);
            void refresh();
        };
        runtimeListeners.add(onRuntimeChange);
        void refresh();
        return () => {
            mounted.current = false;
            runtimeListeners.delete(onRuntimeChange);
        };
    }, []);

    const handleReset = async () => {
        setResetting(true);
        try {
            await resetStats();
            await refresh();
        } catch (resetError) {
            if (mounted.current) setError(`Could not reset stats: ${getErrorSummary(resetError)}`);
        } finally {
            if (mounted.current) setResetting(false);
        }
    };

    if (!loaded) return <Forms.FormText>Loading stats...</Forms.FormText>;
    const activeRuntime = runtime;
    const pendingClaims = activeRuntime?.inFlightClaims.size ?? 0;
    const activeQuest = activeRuntime?.activeJob ? getQuestById(activeRuntime.activeJob.questId) : null;
    const activeTask = activeQuest ? getTaskSelection(activeQuest)?.name ?? "quest task" : null;

    return (
        <>
            <Forms.FormTitle tag="h3">Automation status</Forms.FormTitle>
            <Forms.FormText role="status" aria-live="polite">
                {!activeRuntime
                    ? "Stopped"
                    : activeTask
                        ? `Working on ${activeTask}${pendingClaims ? "; native reward confirmation also pending" : ""}`
                        : pendingClaims
                            ? "Waiting for Discord's native reward confirmation"
                            : "Running in the background"}
            </Forms.FormText>
            {activeRuntime?.observedTaskNames.length ? (
                <Forms.FormText style={{ marginTop: 6 }}>
                    Observed task types: {activeRuntime.observedTaskNames.join(", ")}
                </Forms.FormText>
            ) : null}
            {activeRuntime?.observedUnsupportedTaskNames.length ? (
                <Forms.FormText style={{ marginTop: 6, color: "var(--text-muted)" }}>
                    Server-managed or not yet automatable: {activeRuntime.observedUnsupportedTaskNames.join(", ")}
                </Forms.FormText>
            ) : null}
            {activeRuntime?.observedMobileHandoffs ? (
                <Forms.FormText style={{ marginTop: 6, color: "var(--text-muted)" }}>
                    Mobile or QR handoffs observed: {activeRuntime.observedMobileHandoffs}. These handoffs link or move a real session; they are not a Quest progress event that can be safely spoofed.
                </Forms.FormText>
            ) : null}
            <Forms.FormTitle tag="h3" style={{ marginTop: 18 }}>Quests completed: {count}</Forms.FormTitle>
            {error && <Forms.FormText style={{ color: "var(--text-danger)" }}>{error}</Forms.FormText>}
            {history.length === 0 ? (
                <Forms.FormText>No quests claimed yet.</Forms.FormText>
            ) : (
                <>
                    <Forms.FormTitle tag="h5" style={{ marginTop: 12 }}>Recent ({history.length})</Forms.FormTitle>
                    <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--background-modifier-accent)", borderRadius: 4, padding: 8 }}>
                        {history.map((entry, index) => (
                            <div
                                key={`${entry.questId ?? "legacy"}:${entry.completedAt}:${index}`}
                                style={{ padding: "4px 0", borderBottom: index === history.length - 1 ? "none" : "1px solid var(--background-modifier-accent)" }}
                            >
                                <Forms.FormText style={{ fontWeight: 600 }}>{entry.questName}</Forms.FormText>
                                <Forms.FormText style={{ fontSize: 12, opacity: 0.7 }}>
                                    {new Date(entry.completedAt).toLocaleString()}
                                </Forms.FormText>
                            </div>
                        ))}
                    </div>
                </>
            )}
            <Button
                color={Button.Colors.RED}
                size={Button.Sizes.SMALL}
                style={{ marginTop: 12 }}
                disabled={resetting}
                onClick={() => void handleReset()}
            >
                {resetting ? "Resetting..." : "Reset stats"}
            </Button>
        </>
    );
}

export default definePlugin({
    name: "QuestCompleter",
    description: "Handles compatible Discord quests, linked-console tracking, and reward claims through Discord's native challenge flow.",
    searchTerms: ["QuestComputer"],
    authors: [{
        name: "saintordevil",
        id: 0n
    }],

    settingsAboutComponent: StatsPanel,

    start() {
        if (runtime) stopRuntime(runtime);
        logger.info("QuestCompleter started. Running autonomously.");
        activateRuntime(5000);
    },

    stop() {
        logger.info("QuestCompleter stopped.");
        if (runtime) stopRuntime(runtime);
    },

    flux: {
        CONNECTION_OPEN: handleConnectionOpen,
        QUESTS_ENROLL_SUCCESS: handleQuestStatusRefresh,
        QUESTS_ENROLL_FAILURE: scheduleStatusRefresh,
        QUESTS_CLAIM_REWARD_FAILURE: scheduleStatusRefresh,
        QUESTS_CLAIM_REWARD_SUCCESS: handleClaimSuccess,
        QUESTS_FETCH_CURRENT_QUESTS_SUCCESS: handleFullQuestRefresh,
        QUESTS_SELECT_TASK_PLATFORM: handleTaskPlatformSelection,
        QUESTS_SEND_HEARTBEAT_FAILURE: scheduleStatusRefresh,
        QUESTS_USER_COMPLETION_UPDATE: handleQuestStatusRefresh,
        QUESTS_USER_STATUS_UPDATE: handleQuestStatusRefresh
    }
});
