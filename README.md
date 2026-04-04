# QuestCompleter

A [Vencord](https://vencord.dev) plugin that fully automates Discord quests — enrolling, completing, and claiming rewards in the background with zero manual interaction.

## Features

- **Auto-Enroll** — Automatically enrolls in any available Discord quests as they appear
- **Auto-Complete** — Completes quest objectives without needing to actually play or stream games
- **Auto-Claim** — Claims quest rewards as soon as objectives are finished
- **Runs in Background** — Polls every 60 seconds for new quests and progress updates
- **Reconnect Aware** — Re-checks quests automatically when Discord reconnects

## Supported Quest Types

| Task Type | Method |
|-----------|--------|
| **Watch Video** | Sends video progress timestamps to the API until complete |
| **Play on Desktop** | Spoofs a running game process so Discord thinks you're playing |
| **Stream on Desktop** | Spoofs stream metadata (requires being in a voice channel with 1+ other person) |
| **Play Activity** | Sends heartbeat pings against a channel until the time requirement is met |

> Mobile-only tasks (`WATCH_VIDEO_ON_MOBILE`) are skipped since they cannot be completed on desktop.

## Installation

1. Set up [Vencord](https://vencord.dev) if you haven't already
2. Copy the `questCompleter` folder into your Vencord `src/userplugins/` directory
3. Rebuild Vencord:
   ```bash
   pnpm build
   ```
4. Enable **QuestCompleter** in Discord → Settings → Vencord → Plugins

## How It Works

The plugin hooks into Discord's internal Flux stores to discover available quests and their progress. It uses Discord's own REST API endpoints (`/quests/{id}/enroll`, `/quests/{id}/video-progress`, `/quests/{id}/heartbeat`, `/quests/{id}/claim-reward`) to interact with the quest system natively.

For play/stream quests, it temporarily patches Discord's `RunningGameStore` or `ApplicationStreamingStore` to make Discord believe the required game is running or being streamed. Once the quest is complete, the patches are cleanly removed.

## Notes

- Some quest rewards may require a CAPTCHA to claim — these will need to be claimed manually
- Stream quests require you to be in a voice channel with at least one other person
- The plugin waits for Discord's stores to fully load before attempting any actions

## License

MIT
