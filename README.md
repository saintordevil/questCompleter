# QuestCompleter

Discord Quest automation for Vencord: enroll in available quests, complete supported desktop objectives, and claim rewards in the background.

QuestCompleter monitors Discord's quest stores, handles supported quest types automatically, and re-checks progress after reconnects. It is designed to run quietly once enabled, with no manual quest interaction required unless Discord requires a CAPTCHA or the quest type is not desktop-completable.

## Core Behavior

| Feature | What it does |
|---|---|
| **Auto-Enroll** | Enrolls in available Discord quests as they appear |
| **Auto-Complete** | Completes supported quest objectives without manually managing quest progress |
| **Auto-Claim** | Claims quest rewards as soon as objectives are finished |
| **Background Polling** | Checks for new quests and progress updates every 60 seconds |
| **Reconnect Aware** | Re-checks quests automatically after Discord reconnects |

## Supported Quest Types

| Task Type | Method | Notes |
|---|---|---|
| **Watch Video** | Sends video progress timestamps to the API until complete | Desktop-completable |
| **Play on Desktop** | Spoofs a running game process so Discord sees the required game as active | Desktop-completable |
| **Stream on Desktop** | Spoofs stream metadata for the required application | Requires being in a voice channel with at least one other person |
| **Play Activity** | Sends heartbeat pings against a channel until the time requirement is met | Desktop-completable |

Mobile-only tasks such as `WATCH_VIDEO_ON_MOBILE` are skipped because they cannot be completed on desktop.

## Requirements

- A working [Vencord](https://vencord.dev) development setup
- Discord desktop
- `pnpm`, as used by Vencord
- A voice channel with at least one other person for stream quests

## Install

1. Set up [Vencord](https://vencord.dev) if you have not already.
2. Copy the `questCompleter` folder into your Vencord `src/userplugins/` directory.
3. Rebuild Vencord:

```bash
pnpm build
```

4. Enable **QuestCompleter** in Discord Settings > Vencord > Plugins.

## Usage

Once enabled, QuestCompleter starts automatically with Discord.

The plugin waits for Discord's stores to load, then runs an initial quest check after startup. It continues polling every 60 seconds and runs another check when Discord reconnects.

## How It Works

QuestCompleter hooks into Discord's internal Flux stores to discover available quests and track progress. It uses Discord's own REST API endpoints to enroll in quests, report progress, send heartbeats, and claim completed rewards.

For play and stream quests, QuestCompleter temporarily patches Discord's `RunningGameStore` or `ApplicationStreamingStore` so Discord sees the required game as running or streaming. After the quest is complete, the temporary patches are removed.

## Technical Details

- Discovers the quest store at runtime by scanning registered Flux stores
- Supports `WATCH_VIDEO`, `PLAY_ON_DESKTOP`, `STREAM_ON_DESKTOP`, and `PLAY_ACTIVITY`
- Uses `/quests/{id}/enroll`, `/quests/{id}/video-progress`, `/quests/{id}/heartbeat`, and `/quests/{id}/claim-reward`
- Polls every 60 seconds while enabled
- Cleans up active spoofing patches when stopped or after quest completion

## Notes

- Some quest rewards may require a CAPTCHA and must be claimed manually
- Stream quests require a voice channel with at least one other person
- Mobile-only quests are intentionally skipped
- The plugin waits for Discord's stores to load before attempting actions

## License

MIT
