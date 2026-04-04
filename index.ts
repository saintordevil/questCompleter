import { ChannelStore, Flux, FluxDispatcher, GuildChannelStore, RestAPI, RunningGameStore } from "@webpack/common";
import { findStoreLazy } from "@webpack";
import definePlugin from "@utils/types";
import { Logger } from "@utils/Logger";

const logger = new Logger("QuestCompleter");

// QuestsStore name-based lookup fails in current Discord builds.
// Discover at runtime by scanning all registered Flux stores.
let _questsStore: any = null;

function getQuestsStore(): any {
    if (_questsStore) return _questsStore;

    try {
        const allStores = Flux.Store?.getAll?.() ?? [];
        for (const store of allStores) {
            const name = (store as any).getName?.() ?? "";
            if (
                name.includes("Quest") ||
                (store as any).quests instanceof Map
            ) {
                logger.info(`Discovered quest store: "${name}"`);
                _questsStore = store;
                return store;
            }
        }
    } catch (e) {
        logger.warn("Failed to scan Flux stores", e);
    }

    return null;
}

const ApplicationStreamingStore = findStoreLazy("ApplicationStreamingStore");

// Desktop-completable tasks only — WATCH_VIDEO_ON_MOBILE requires phone, skip it
const SUPPORTED_TASKS = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY"];

let activeQuest: string | null = null;
let cleanupFns: (() => void)[] = [];
let pollInterval: ReturnType<typeof setInterval> | null = null;

// ── Quest Discovery ──────────────────────────────────────────────

function getAllQuests(): any[] {
    const store = getQuestsStore();
    if (!store?.quests) return [];
    return [...store.quests.values()];
}

function getUnenrolledQuests(): any[] {
    return getAllQuests().filter((x: any) =>
        !x.userStatus?.enrolledAt &&
        !x.userStatus?.completedAt &&
        new Date(x.config.expiresAt).getTime() > Date.now() &&
        SUPPORTED_TASKS.some(t => {
            const taskConfig = x.config.taskConfig ?? x.config.taskConfigV2;
            return taskConfig?.tasks?.[t] != null;
        })
    );
}

function getEnrolledUncompletedQuests(): any[] {
    return getAllQuests().filter((x: any) =>
        x.userStatus?.enrolledAt &&
        !x.userStatus?.completedAt &&
        new Date(x.config.expiresAt).getTime() > Date.now() &&
        SUPPORTED_TASKS.some(t => {
            const taskConfig = x.config.taskConfig ?? x.config.taskConfigV2;
            return taskConfig?.tasks?.[t] != null;
        })
    );
}

function getCompletedUnclaimedQuests(): any[] {
    return getAllQuests().filter((x: any) =>
        x.userStatus?.completedAt &&
        !x.userStatus?.claimedAt &&
        new Date(x.config.expiresAt).getTime() > Date.now()
    );
}

// ── Auto Enroll ──────────────────────────────────────────────────

async function autoEnroll() {
    const unenrolled = getUnenrolledQuests();
    for (const quest of unenrolled) {
        const questName = quest.config.messages?.questName ?? quest.id;
        try {
            await RestAPI.post({
                url: `/quests/${quest.id}/enroll`,
                body: { location: 1 }
            });
            logger.info(`Auto-enrolled in quest: ${questName}`);
        } catch (e: any) {
            logger.warn(`Failed to enroll in ${questName}: ${e?.message ?? e}`);
        }
        // Small delay between enrollments
        await new Promise(r => setTimeout(r, 2000));
    }
}

// ── Auto Claim ───────────────────────────────────────────────────

async function autoClaim() {
    const claimable = getCompletedUnclaimedQuests();
    for (const quest of claimable) {
        const questName = quest.config.messages?.questName ?? quest.id;
        try {
            await RestAPI.post({
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
            logger.info(`Auto-claimed reward for: ${questName}`);
        } catch (e: any) {
            // Captcha or other failure — user will need to claim manually
            logger.warn(`Failed to claim ${questName} (may need manual claim): ${e?.message ?? e}`);
        }
        await new Promise(r => setTimeout(r, 2000));
    }
}

// ── Cleanup ──────────────────────────────────────────────────────

function cleanup() {
    for (const fn of cleanupFns) {
        try { fn(); } catch (e) { logger.error("Cleanup error", e); }
    }
    cleanupFns = [];
    activeQuest = null;
}

// ── Quest Completers ─────────────────────────────────────────────

async function completeVideoQuest(quest: any, taskName: string, secondsNeeded: number) {
    let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;
    const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
    const maxFuture = 10;
    const speed = 7;
    const interval = 1;

    logger.info(`Completing video quest: ${quest.config.messages.questName}`);

    let cancelled = false;
    cleanupFns.push(() => { cancelled = true; });

    while (!cancelled) {
        const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
        const diff = maxAllowed - secondsDone;
        const timestamp = secondsDone + speed;

        if (diff >= speed) {
            try {
                const res = await RestAPI.post({
                    url: `/quests/${quest.id}/video-progress`,
                    body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) }
                });
                if (res.body?.completed_at != null) {
                    logger.info("Video quest completed!");
                    cleanup();
                    return;
                }
                secondsDone = Math.min(secondsNeeded, timestamp);
            } catch (e: any) {
                logger.warn(`Video progress error: ${e?.message ?? e}`);
            }
        }

        if (timestamp >= secondsNeeded) break;
        await new Promise(r => setTimeout(r, interval * 1000));
    }

    if (!cancelled) {
        try {
            await RestAPI.post({
                url: `/quests/${quest.id}/video-progress`,
                body: { timestamp: secondsNeeded }
            });
        } catch { }
        logger.info("Video quest completed!");
        cleanup();
    }
}

function completePlayQuest(quest: any, secondsNeeded: number, secondsDone: number) {
    const applicationId = quest.config.application.id;
    const applicationName = quest.config.application.name;
    const pid = Math.floor(Math.random() * 30000) + 1000;

    RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` }).then((res: any) => {
        const appData = res.body[0];
        const exeName = appData.executables?.find((x: any) => x.os === "win32")?.name?.replace(">", "") ??
            appData.name.replace(/[\/\\:*?"<>|]/g, "");

        const fakeGame = {
            cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
            exeName,
            exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
            hidden: false,
            isLauncher: false,
            id: applicationId,
            name: appData.name,
            pid,
            pidPath: [pid],
            processName: appData.name,
            start: Date.now(),
        };

        const realGames = RunningGameStore.getRunningGames();
        const fakeGames = [fakeGame];
        const realGetRunningGames = RunningGameStore.getRunningGames;
        const realGetGameForPID = RunningGameStore.getGameForPID;

        RunningGameStore.getRunningGames = () => fakeGames;
        RunningGameStore.getGameForPID = (p: number) => fakeGames.find((x: any) => x.pid === p);
        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: fakeGames });

        cleanupFns.push(() => {
            RunningGameStore.getRunningGames = realGetRunningGames;
            RunningGameStore.getGameForPID = realGetGameForPID;
            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
        });

        const fn = (data: any) => {
            const progress = quest.config.configVersion === 1
                ? data.userStatus.streamProgressSeconds
                : Math.floor(data.userStatus.progress.PLAY_ON_DESKTOP.value);
            logger.info(`Play quest progress: ${progress}/${secondsNeeded}`);

            if (progress >= secondsNeeded) {
                logger.info("Play quest completed!");
                cleanup();
            }
        };

        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
        cleanupFns.push(() => FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn));

        logger.info(`Spoofed game to ${applicationName}. ~${Math.ceil((secondsNeeded - secondsDone) / 60)} minutes remaining.`);
    });
}

function completeStreamQuest(quest: any, secondsNeeded: number, secondsDone: number) {
    const applicationId = quest.config.application.id;
    const applicationName = quest.config.application.name;
    const pid = Math.floor(Math.random() * 30000) + 1000;

    const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
    ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
        id: applicationId,
        pid,
        sourceName: null
    });

    cleanupFns.push(() => {
        ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
    });

    const fn = (data: any) => {
        const progress = quest.config.configVersion === 1
            ? data.userStatus.streamProgressSeconds
            : Math.floor(data.userStatus.progress.STREAM_ON_DESKTOP.value);
        logger.info(`Stream quest progress: ${progress}/${secondsNeeded}`);

        if (progress >= secondsNeeded) {
            logger.info("Stream quest completed!");
            cleanup();
        }
    };

    FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
    cleanupFns.push(() => FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn));

    logger.info(`Spoofed stream to ${applicationName}. Stream any window in VC for ~${Math.ceil((secondsNeeded - secondsDone) / 60)} minutes. Need 1 other person in VC!`);
}

async function completeActivityQuest(quest: any, secondsNeeded: number) {
    const channelId = ChannelStore.getSortedPrivateChannels?.()[0]?.id ??
        Object.values(GuildChannelStore.getAllGuilds?.() ?? {}).find((x: any) => x != null && x.VOCAL?.length > 0)?.VOCAL?.[0]?.channel?.id;

    if (!channelId) {
        logger.error("No suitable channel found for activity quest.");
        return;
    }

    const streamKey = `call:${channelId}:1`;
    let cancelled = false;
    cleanupFns.push(() => { cancelled = true; });

    logger.info(`Completing activity quest: ${quest.config.messages.questName}`);

    while (!cancelled) {
        try {
            const res = await RestAPI.post({
                url: `/quests/${quest.id}/heartbeat`,
                body: { stream_key: streamKey, terminal: false }
            });
            const progress = res.body.progress.PLAY_ACTIVITY.value;
            logger.info(`Activity quest progress: ${progress}/${secondsNeeded}`);

            if (progress >= secondsNeeded) {
                await RestAPI.post({
                    url: `/quests/${quest.id}/heartbeat`,
                    body: { stream_key: streamKey, terminal: true }
                });
                logger.info("Activity quest completed!");
                cleanup();
                return;
            }
        } catch (e: any) {
            logger.warn(`Activity heartbeat error: ${e?.message ?? e}`);
        }

        await new Promise(r => setTimeout(r, 20 * 1000));
    }
}

// ── Main Loop ────────────────────────────────────────────────────

async function runCycle() {
    // Guard: wait for stores to be ready
    try {
        const store = getQuestsStore();
        if (!store || !RestAPI?.post) {
            logger.info("Stores not ready yet, waiting...");
            return;
        }
    } catch {
        logger.info("Stores not ready yet, waiting...");
        return;
    }

    try {
        // Step 1: Auto-enroll in any available quests
        await autoEnroll();

        // Step 2: Auto-claim any completed quests
        await autoClaim();

        // Step 3: Start completing an enrolled quest if none active
        if (!activeQuest) {
            const quests = getEnrolledUncompletedQuests();
            if (quests.length === 0) return;

            const quest = quests[0];
            const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
            const taskName = SUPPORTED_TASKS.find(t => taskConfig.tasks[t] != null);
            if (!taskName) return;

            const secondsNeeded = taskConfig.tasks[taskName].target;
            const secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;

            if (secondsDone >= secondsNeeded) return;

            activeQuest = quest.id;
            logger.info(`Starting quest: ${quest.config.messages.questName} (${taskName}) - ${secondsDone}/${secondsNeeded}s`);

            if (taskName === "WATCH_VIDEO") {
                completeVideoQuest(quest, taskName, secondsNeeded);
            } else if (taskName === "PLAY_ON_DESKTOP") {
                completePlayQuest(quest, secondsNeeded, secondsDone);
            } else if (taskName === "STREAM_ON_DESKTOP") {
                completeStreamQuest(quest, secondsNeeded, secondsDone);
            } else if (taskName === "PLAY_ACTIVITY") {
                completeActivityQuest(quest, secondsNeeded);
            }
        }
    } catch (e: any) {
        logger.error(`Cycle error: ${e?.message ?? e}`);
    }
}

// ── Plugin Definition ────────────────────────────────────────────

export default definePlugin({
    name: "QuestCompleter",
    description: "Fully autonomous quest handler — auto-enrolls, auto-completes, and auto-claims Discord quests in the background.",
    authors: [{
        name: "saint",
        id: 0n,
    }],

    start() {
        logger.info("QuestCompleter started. Running autonomously.");

        // Initial cycle after stores load
        setTimeout(() => runCycle(), 5000);

        // Poll every 60 seconds for new quests / claimable rewards
        pollInterval = setInterval(() => runCycle(), 60000);
    },

    stop() {
        logger.info("QuestCompleter stopped.");
        cleanup();
        _questsStore = null;
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
    },

    flux: {
        CONNECTION_OPEN() {
            // Discord reconnected — re-check after stores settle
            setTimeout(() => runCycle(), 5000);
        }
    }
});
