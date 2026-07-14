/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
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

const logger = new Logger("QuestCompleter");

const DS_COUNT_KEY = "QuestCompleter_completedCount";
const DS_HISTORY_KEY = "QuestCompleter_history";
const HISTORY_MAX = 50;
const MAX_STORED_COUNT = 1_000_000;
const POLL_INTERVAL_MS = 60_000;
const ACTION_DELAY_MS = 1_500;
const QUEST_TIMEOUT_BUFFER_MS = 10 * 60_000;
const MAX_QUEST_TIMEOUT_MS = 2 * 60 * 60_000;

const SUPPORTED_TASKS = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY"] as const;

type TaskName = typeof SUPPORTED_TASKS[number];
type Cleanup = () => void;

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
}

interface Quest {
    id: string;
    preview?: unknown;
    config: {
        application?: { id?: unknown; name?: unknown; };
        configVersion?: unknown;
        expiresAt?: unknown;
        startsAt?: unknown;
        messages?: { questName?: unknown; };
        rewardsConfig?: { rewardsExpireAt?: unknown; };
        taskConfig?: QuestTaskConfig;
        taskConfigV2?: QuestTaskConfig;
    };
    userStatus?: QuestUserStatus | null;
}

interface QuestStoreLike {
    quests: Map<string, unknown>;
    getName?: () => string;
    getQuest?: (id: string) => unknown;
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
    activeJob: QuestJob | null;
    successfulEnrollments: Map<string, number>;
    successfulClaims: Set<string>;
    completedQuestIds: Map<string, number>;
    enrollRetries: Map<string, RetryEntry>;
    claimRetries: Map<string, RetryEntry>;
    questRetries: Map<string, RetryEntry>;
    lastStoreWarningAt: number;
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

let questsStore: QuestStoreLike | null = null;
let runtime: RuntimeState | null = null;
let statsWriteTail: Promise<void> = Promise.resolve();

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
    const status = isRecord(error) && (typeof error.status === "number" || typeof error.status === "string")
        ? `HTTP ${String(error.status)}`
        : null;
    const message = error instanceof Error && error.message
        ? error.message
        : isRecord(error) && typeof error.message === "string"
            ? error.message
            : null;
    return [status, message].filter(Boolean).join(": ").slice(0, 240) || "Unknown error";
}

function isTerminalQuestError(error: unknown): boolean {
    if (!isRecord(error)) return false;
    const status = Number(error.status);
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
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : quest.id;
}

function getApplicationId(quest: Quest): string | null {
    const id = quest.config.application?.id;
    return isSnowflake(id) ? id : null;
}

function getApplicationName(quest: Quest): string {
    const name = quest.config.application?.name;
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : getQuestName(quest);
}

function getProgress(userStatus: QuestUserStatus | null | undefined, taskName: TaskName, configVersion?: unknown): number {
    const rawProgress = configVersion === 1 && taskName === "STREAM_ON_DESKTOP"
        ? userStatus?.streamProgressSeconds
        : userStatus?.progress?.[taskName]?.value;
    const progress = asFiniteNumber(rawProgress);
    return progress === null ? 0 : Math.max(0, progress);
}

function getTaskSelection(quest: Quest): TaskSelection | null {
    const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
    const tasks = taskConfig?.tasks;
    if (!isRecord(tasks)) return null;

    for (const name of SUPPORTED_TASKS) {
        const rawTask = tasks[name];
        if (!isRecord(rawTask)) continue;

        const target = asFiniteNumber(rawTask.target);
        if (target === null || target <= 0) continue;
        if ((name === "PLAY_ON_DESKTOP" || name === "STREAM_ON_DESKTOP") && !getApplicationId(quest)) continue;

        const progress = Math.min(target, getProgress(quest.userStatus, name, quest.config.configVersion));
        if (progress < target) return { name, target, progress };
    }

    return null;
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
    logger.info(`Cancelling active quest ${job.questId}: ${reason}`);
    cleanupJob(job);
    if (state.activeJob === job) state.activeJob = null;
}

function retryReady(retries: Map<string, RetryEntry>, id: string): boolean {
    const retry = retries.get(id);
    if (!retry) return true;
    if (retry.retryAt > Date.now()) return false;
    retries.delete(id);
    return true;
}

function markRetry(retries: Map<string, RetryEntry>, id: string, baseDelay: number, maxDelay: number): RetryEntry {
    const failures = Math.min(10, (retries.get(id)?.failures ?? 0) + 1);
    const delay = Math.min(maxDelay, baseDelay * 2 ** (failures - 1));
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

async function autoEnroll(state: RuntimeState): Promise<void> {
    const quests = getAllQuests().filter(isEnrollmentEligible).sort(sortByExpiry);

    for (let index = 0; index < quests.length && isCurrentRuntime(state); index++) {
        const quest = quests[index];
        if (hasUnexpiredMarker(state.successfulEnrollments, quest.id) || !retryReady(state.enrollRetries, quest.id)) continue;

        const questName = getQuestName(quest);
        try {
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
            const retry = markRetry(state.enrollRetries, quest.id, 60_000, 15 * 60_000);
            logger.warn(`Failed to enroll in ${questName}: ${getErrorSummary(error)}. Retry after ${new Date(retry.retryAt).toLocaleTimeString()}.`);
        }

        if (index < quests.length - 1) await sleep(ACTION_DELAY_MS, state.controller.signal);
    }
}

function responseHasRewardErrors(response: unknown): boolean {
    if (!isRecord(response) || !isRecord(response.body)) return false;
    return Array.isArray(response.body.errors) && response.body.errors.length > 0;
}

async function autoClaim(state: RuntimeState): Promise<void> {
    const quests = getAllQuests().filter(isClaimEligible).sort(sortByExpiry);

    for (let index = 0; index < quests.length && isCurrentRuntime(state); index++) {
        const quest = quests[index];
        if (state.successfulClaims.has(quest.id) || !retryReady(state.claimRetries, quest.id)) continue;

        const questName = getQuestName(quest);
        try {
            const response = await RestAPI.post({
                url: `/quests/${quest.id}/claim-reward`,
                body: {
                    platform: 0,
                    location: 11,
                    is_targeted: false,
                    metadata_raw: null,
                    metadata_sealed: null,
                    traffic_metadata_raw: null,
                    traffic_metadata_sealed: null
                }
            });
            if (!isCurrentRuntime(state)) return;
            if (responseHasRewardErrors(response)) throw new Error("Discord returned one or more reward errors");

            state.successfulClaims.add(quest.id);
            state.claimRetries.delete(quest.id);
            logger.info(`Auto-claimed reward for: ${questName}`);

            try {
                await recordCompletion(quest.id, questName);
            } catch (error) {
                logger.error(`Claimed ${questName}, but failed to update local stats: ${getErrorSummary(error)}`);
            }
        } catch (error) {
            if (!isCurrentRuntime(state)) return;
            const retry = markRetry(state.claimRetries, quest.id, 15 * 60_000, 60 * 60_000);
            logger.warn(`Failed to claim ${questName}: ${getErrorSummary(error)}. A CAPTCHA may require manual claiming; retry after ${new Date(retry.retryAt).toLocaleTimeString()}.`);
        }

        if (index < quests.length - 1) await sleep(ACTION_DELAY_MS, state.controller.signal);
    }
}

function getResponseStatus(response: unknown): QuestUserStatus | null {
    if (!isRecord(response)) return null;
    const body = isRecord(response.body) ? response.body : response;
    const nested = body.userStatus ?? body.user_status;
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
    const enrolledAt = Math.min(Date.now(), asTimestamp(quest.userStatus?.enrolledAt) ?? Date.now() - progress * 1000);
    const deadline = Date.now() + Math.min(MAX_QUEST_TIMEOUT_MS, Math.max(5 * 60_000, (task.target - progress) * 1000 + QUEST_TIMEOUT_BUFFER_MS));
    let failures = 0;

    while (isJobActive(job) && Date.now() < deadline) {
        const refreshed = getQuestById(quest.id);
        if (refreshed && hasTimestamp(refreshed.userStatus?.completedAt)) return true;
        if (refreshed && !isQuestActive(refreshed)) return false;

        const maxAllowed = Math.max(progress, Math.floor((Date.now() - enrolledAt) / 1000) + 10);
        const timestamp = Math.min(task.target, maxAllowed, progress + 7 + Math.random());
        if (timestamp <= progress + 0.01) {
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
            progress = Math.min(task.target, Math.max(progress, getResponseProgress(response, task.name) ?? timestamp));
            logger.info(`Video quest progress for ${getQuestName(quest)}: ${Math.floor(progress)}/${task.target}`);
            if (responseCompleted(response) || progress >= task.target) return true;
        } catch (error) {
            if (!isJobActive(job)) return false;
            failures++;
            logger.warn(`Video progress error for ${getQuestName(quest)}: ${getErrorSummary(error)}`);
            if (isTerminalQuestError(error) || failures >= 3) return false;
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

async function getFakeGameData(job: QuestJob, quest: Quest): Promise<{ name: string; exeName: string; }> {
    const applicationId = getApplicationId(quest)!;
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
    const status = isRecord(data.userStatus) ? data.userStatus : null;
    const id = data.questId ?? data.quest_id ?? status?.questId ?? status?.quest_id;
    return isSnowflake(id) ? id : null;
}

function getEventStatus(data: unknown): QuestUserStatus | null {
    return isRecord(data) && isRecord(data.userStatus) ? data.userStatus as QuestUserStatus : null;
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
        const onAbort = () => finish(false);
        const timeout = setTimeout(() => finish(false), timeoutMs);
        const storePoll = setInterval(() => {
            const refreshed = getQuestById(quest.id);
            if (!refreshed || !isQuestActive(refreshed)) finish(false);
            else checkStatus(refreshed.userStatus);
        }, 15_000);

        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onHeartbeat);
        job.controller.signal.addEventListener("abort", onAbort, { once: true });
        addJobCleanup(job, onAbort);
    });
}

async function completePlayQuest(job: QuestJob, quest: Quest, task: TaskSelection): Promise<boolean> {
    const applicationId = getApplicationId(quest)!;
    const appData = await getFakeGameData(job, quest);
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
    const applicationId = getApplicationId(quest)!;
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
            if (isTerminalQuestError(error) || failures >= 3) return false;
        }

        await sleep(20_000, job.controller.signal);
    }

    return false;
}

async function runQuestJob(job: QuestJob, quest: Quest, task: TaskSelection): Promise<void> {
    const questName = getQuestName(quest);
    logger.info(`Starting quest: ${questName} (${task.name}) - ${Math.floor(task.progress)}/${task.target}`);

    try {
        let completed = false;
        switch (task.name) {
            case "WATCH_VIDEO":
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

    await autoEnroll(state);
    if (!isCurrentRuntime(state)) return;
    await autoClaim(state);
    if (!isCurrentRuntime(state) || state.activeJob) return;

    const quest = getAllQuests()
        .filter(isCompletionEligible)
        .filter(candidate => !hasUnexpiredMarker(state.completedQuestIds, candidate.id))
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
        activeJob: null,
        successfulEnrollments: new Map(),
        successfulClaims: new Set(),
        completedQuestIds: new Map(),
        enrollRetries: new Map(),
        claimRetries: new Map(),
        questRetries: new Map(),
        lastStoreWarningAt: 0
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
    stopRuntime(previous);
    activateRuntime(5000);
}

function scheduleStatusRefresh(): void {
    if (runtime) scheduleCycle(runtime, 250);
}

function StatsPanel() {
    const mounted = useRef(true);
    const [count, setCount] = useState(0);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
        void refresh();
        return () => { mounted.current = false; };
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

    return (
        <>
            <Forms.FormTitle tag="h3">Quests completed: {count}</Forms.FormTitle>
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
    description: "Fully autonomous quest handler that enrolls in, progresses, and claims eligible Discord quests in the background.",
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
        QUESTS_ENROLL_SUCCESS: scheduleStatusRefresh,
        QUESTS_CLAIM_REWARD_SUCCESS: scheduleStatusRefresh,
        QUESTS_USER_COMPLETION_UPDATE: scheduleStatusRefresh,
        QUESTS_USER_STATUS_UPDATE: scheduleStatusRefresh
    }
});
