# Vencord: Quest Completer

QuestCompleter is a source-only Vencord userplugin that handles eligible Discord quests in the background. It can enroll in supported quests, progress their desktop objectives, claim completed rewards when Discord permits it, and keep a local history of successful automatic claims.

The plugin is also searchable as **QuestComputer** in Vencord's plugin list.

## Features

- Enrolls in eligible active quests with supported desktop tasks
- Progresses one supported quest at a time, prioritizing the nearest expiry
- Claims completed, unclaimed rewards before their reward expiry
- Polls every 60 seconds and schedules faster checks after relevant Discord quest events
- Prevents overlapping cycles and duplicate enrollment, completion, and claim work
- Applies exponential retry backoff after failures
- Cancels active work and restores temporary store patches when disabled or reconnected
- Persists a completion count and the 50 most recent successful automatic claims
- Provides a Vencord settings panel for viewing history and resetting local statistics

## Supported Quest Tasks

| Discord task | Handling | Limitation |
|---|---|---|
| `WATCH_VIDEO` | Reports bounded video progress until Discord marks the objective complete | Stops after repeated errors and retries the quest later |
| `PLAY_ON_DESKTOP` | Uses the real required game when detected, otherwise temporarily adds a matching game to Discord's running-game store | Depends on Discord's desktop quest heartbeat behavior |
| `STREAM_ON_DESKTOP` | Temporarily reports the required application as the active stream | You must stream a window in voice chat, and Discord requires at least one other viewer |
| `PLAY_ACTIVITY` | Sends quest-specific activity heartbeats until complete | Depends on Discord accepting the activity heartbeat format |

Unsupported task types, including mobile-only objectives such as `WATCH_VIDEO_ON_MOBILE`, are skipped.

## Statistics and Settings

After the plugin successfully claims a reward, it stores the quest name, quest ID, and claim time in Vencord's local data store. Duplicate quest IDs are not counted twice, and history is limited to the 50 most recent entries.

Open **Discord Settings > Vencord > Plugins > QuestCompleter** to view:

- The number of rewards successfully claimed by the plugin
- Recent quest names and claim times
- A **Reset stats** button that clears the local count and history

Manual claims are not added to this local history.

## Reliability and Cleanup

For enrollment and progression, QuestCompleter ignores preview, future, and expired quests. Completed rewards remain claimable while their reward expiry is still valid. Enrollment, claim, and completion failures use bounded exponential backoff so a failing quest does not create a tight request loop.

Only one processing cycle and one completion job can be active at a time. Disabling the plugin aborts pending waits, removes Flux listeners, clears timers, and restores any temporary game or stream store functions. A Discord reconnect replaces the runtime generation so requests started under an earlier connection cannot update the new runtime's retry or deduplication state.

## Requirements

- Discord desktop
- A working [Vencord development setup](https://docs.vencord.dev/installing/)
- `pnpm`, as used by Vencord
- For stream quests, a voice chat stream with at least one other viewer

## Installation

This repository contains a Vencord userplugin source folder, not a standalone npm package.

1. Copy the `questCompleter` folder into `src/userplugins/` in your Vencord checkout.
2. Build Vencord using the instructions for your installation.
3. Enable **QuestCompleter** in **Discord Settings > Vencord > Plugins**.

The plugin entrypoint is `index.tsx` because its settings panel uses JSX.

## Limitations

- Discord may require a CAPTCHA for a reward claim. The plugin logs the failure and retries with backoff, but you may need to claim that reward manually.
- Stream quests are not fully unattended. You must start a stream, and another viewer must be present for Discord to grant progress.
- Mobile-only and unknown quest task types are intentionally skipped.
- The plugin relies on Discord's private stores, Flux events, and quest endpoints. Discord updates can require maintenance.
- Quest automation may be subject to Discord's rules and enforcement. Use it at your own discretion.

## License

[GNU General Public License v3.0 or later](LICENSE)
