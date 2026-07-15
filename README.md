# Vencord: Quest Completer

QuestCompleter is an autonomous Vencord userplugin for supported Discord Quests. It enrolls in compatible campaigns, progresses their objectives, tracks linked-console quests, submits reward claims through Discord's native action, and keeps a local history of confirmed claims.

The plugin is also searchable as **QuestComputer** in Vencord's plugin list.

## What's New

- Added `WATCH_VIDEO_ON_MOBILE` support through Discord's current video-progress flow
- Added legitimate linked-console tracking for Xbox and PlayStation quests
- Added current config v1/v2 parsing, `AND`/`OR` task groups, per-task application IDs, and Discord's selected desktop or console task preference
- Replaced handcrafted reward requests with Discord's native claim action and native reward-platform selection
- Removed the custom **Manual claim required** and reward-choice popups
- Isolated enrollment, claiming, and quest progression so a pending native challenge cannot freeze unrelated quest work
- Added bounded exponential retries, terminal-error handling, reconnect-safe runtime generations, and stricter cleanup
- Added privacy-safe runtime diagnostics for newly observed task schemas and mobile or QR handoffs
- Added a pure logic module with automated coverage for task selection, retry backoff, reward selection, response validation, and CAPTCHA classification

Mobile-only video handling was live-validated against multiple active campaigns. QR handoffs and achievement objectives are reported accurately but remain server-managed because Discord exposes no equivalent client progress contract for them.

## Core Behavior

| Feature | What it does |
|---|---|
| **Automatic enrollment** | Enrolls in active, compatible quests while respecting Discord's global enrollment cooldown |
| **Expiry prioritization** | Works on the compatible quest that expires soonest |
| **Task-aware progression** | Resolves config v1/v2 tasks, `AND`/`OR` groups, and Discord's selected desktop or console path |
| **Native reward claiming** | Calls Discord's current claim action with its sealed metadata and reward-specific platform selection |
| **Independent work lanes** | Keeps enrollment, reward claiming, and objective progression from blocking one another |
| **Bounded retries** | Uses capped exponential backoff instead of tight request loops |
| **Lifecycle cleanup** | Cancels active waits and restores temporary running-game or stream-store changes when stopped |
| **Local history** | Stores a validated count and the 50 most recent confirmed reward claims observed while the plugin is running |

## Supported Quest Tasks

| Discord task | Handling | Requirement or limitation |
|---|---|---|
| `WATCH_VIDEO` | Reports bounded video progress until Discord confirms completion | Progress cannot run ahead of plausible elapsed time |
| `WATCH_VIDEO_ON_MOBILE` | Uses the same current video-progress contract and completion checks | Discord can change campaign eligibility independently of task progress |
| `PLAY_ON_DESKTOP` | Uses the real required game when already detected, otherwise temporarily exposes a matching game to Discord's running-game store | Depends on Discord's desktop heartbeat behavior |
| `STREAM_ON_DESKTOP` | Temporarily reports the required application as the active stream | You must stream a window in voice chat, with at least one other viewer |
| `PLAY_ACTIVITY` | Sends quest-specific activity heartbeats and a final terminal heartbeat | Depends on Discord accepting the activity heartbeat contract |
| `PLAY_ON_XBOX` | Starts and stops Discord's linked-console tracking flow | Requires a linked Xbox account, online presence, compatible privacy settings, and the real game |
| `PLAY_ON_PLAYSTATION` | Starts and stops Discord's linked-console tracking flow | Requires a linked PlayStation account, online presence, compatible privacy settings, and the real game |

The plugin recognizes `PLAY_ON_DESKTOP_V2`, `ACHIEVEMENT_IN_GAME`, and `ACHIEVEMENT_IN_ACTIVITY`, but does not falsify them. Their completion evidence is server-managed or game-generated.

## Mobile and QR Quests

`WATCH_VIDEO_ON_MOBILE` is a real task type with a progress endpoint, so QuestCompleter can process it when Discord makes the campaign available to the account.

Discord's QR Quest surfaces are different. They transfer or link a real mobile, console, or login session and are not a Quest progress event. QuestCompleter records the observed handoff count in its settings panel instead of pretending that scanning a QR code completed an objective.

## Reward Claiming

QuestCompleter uses Discord's native reward action instead of constructing a partial REST body. This preserves Discord's current sealed request metadata and built-in challenge interceptor.

- Reward-code, collectible, virtual-currency, and fractional-premium claims use Discord's cross-platform selection.
- In-game rewards use the first server-configured platform, matching Discord's own reward modal.
- Unknown reward types or malformed platform data fail closed and retry later.
- Confirmed claim events are reconciled even if Discord removes the quest from the local store immediately afterward.
- Reward-code lookup is used only as post-claim reconciliation, not as a replacement claim mechanism.

There is no custom manual-claim popup. If Discord returns a CAPTCHA challenge, its native verification UI owns that request and automatically retries it after successful verification. QuestCompleter does not read, log, solve, or bypass CAPTCHA values.

Discord can still reject a completed campaign at claim time, for example when the backend no longer exposes that campaign or reward to the account. Repeating a visible button click cannot override a backend rejection.

## Reliability and Cleanup

- Only one objective job runs at a time.
- Enrollment and claim queues are serialized independently from objective progression.
- An account reconnect replaces the runtime generation so stale requests cannot mutate new retry or deduplication state.
- Console stop requests are suppressed across connection-generation replacement to avoid affecting a new session.
- Heartbeat failures terminate the matching wait instead of leaving it pinned.
- Unknown explicit join operators and malformed reward schemas fail closed.
- Persisted counts and history entries are validated, clamped, deduplicated, and length-limited on read.
- Logs contain categorical status information, not raw response bodies, challenge values, tokens, cookies, or authorization data.

## Statistics and Settings

Open **Discord Settings > Vencord > Plugins > QuestCompleter** to view:

- Current automation status
- The active task and whether native reward confirmation is pending
- Task types observed in the current Discord Quest schema
- Server-managed or currently unsupported task types
- Mobile or QR handoffs observed
- Confirmed reward claim count
- The 50 most recent confirmed reward claims observed while the plugin is running
- A **Reset stats** control

Statistics are stored locally through Vencord's data store. A quest ID is counted only once.

## Requirements

- Discord desktop
- A working [Vencord development setup](https://docs.vencord.dev/installing/)
- `pnpm`, as used by Vencord
- A linked console account for Xbox or PlayStation tasks
- A voice stream with another viewer for stream tasks

## Installation

This repository is the complete Vencord userplugin source folder.

1. From the root of your Vencord checkout, clone the repository into `src/userplugins/questCompleter`:

```bash
git clone https://github.com/saintordevil/questCompleter.git src/userplugins/questCompleter
```

2. Build Vencord:

```bash
pnpm build
```

3. Inject or reinstall that Vencord build using your normal development workflow.
4. Restart Discord and enable **QuestCompleter** in **Settings > Vencord > Plugins**.

## Validation

From the Vencord root, the included pure-logic tests can be run with:

```bash
pnpm exec tsx --test src/userplugins/questCompleter/logic.test.ts
```

The plugin should also pass Vencord's targeted ESLint, TypeScript, reporter, and production builds.

## Repository Layout

| Path | Purpose |
|---|---|
| `index.tsx` | Plugin metadata, runtime scheduler, task handlers, native claiming, lifecycle management, and settings panel |
| `logic.ts` | Pure task resolution, retry, reward-platform, response, and CAPTCHA classification logic |
| `logic.test.ts` | Dependency-light automated tests for the pure logic module |
| `LICENSE` | GNU General Public License v3.0 or later |

## Limitations

- Discord's private Quest stores, events, and endpoints can change without notice.
- CAPTCHA verification remains Discord-controlled and may require human interaction.
- Achievement and `PLAY_ON_DESKTOP_V2` evidence cannot be safely manufactured from the exposed desktop client contract.
- QR codes hand off a real session; they do not expose a spoofable Quest progress event.
- Stream quests require a real voice stream and another viewer.
- Linked-console quests require a real linked account and real console gameplay.
- Discord can refuse enrollment, progression, or claiming based on server-side campaign and account eligibility.
- Client modification and Quest automation may be subject to Discord's rules and enforcement. Use it at your own discretion.

## Privacy and Scope

- No external analytics, telemetry, or update checks
- No token, cookie, browser-storage, message-content, or authorization-header access
- No mouse, keyboard, clipboard, tray, or visible DevTools automation
- No CAPTCHA value capture or solver integration
- No persistent changes to Discord's running-game or stream stores after cleanup

## Author

Created and maintained by [saintordevil](https://github.com/saintordevil).

## License

QuestCompleter is licensed under the [GNU General Public License v3.0 or later](LICENSE), consistent with its Vencord source headers.
