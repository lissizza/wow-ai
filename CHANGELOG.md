# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- `/r` to the agent no longer replaces the game chat box's `SendText`/`SendMessage`. That ran every line typed in chat as addon code, so `/run` and its "allow scripts" dialog were blocked as an action of WoWAI. Only `ProcessChatType` is replaced now (the game calls it just for chat-type commands); the `/r ` stays visible in the box under the "To Claude" header, and Enter sends it to the agent through that same hook.
- Signals on macOS. The macOS client plays any file that exists, so empty "off" files read as raised and the addon disabled the sound-file channel (no acks, presence, heartbeat counts, quick steps or session sync; "0 actions" while the agent worked). There the bridge now turns a signal off by deleting the file (`signalStyle: "absent"`, the macOS default): on hello it deletes every empty signal file, `ctl/empty.wav` last, and when the game quits it recreates them for the next launch. The addon, seeing an empty file read as playable, waits for `ctl/empty.wav` to disappear and then turns the channel on. `/wow-ai probe` shows how the client answers a set of prepared files. Start the bridge before the game (or keep it running across game restarts) so the files exist at launch.
- Messages typed while a chat waits for a reply are queued instead of kept as a single hidden draft (each one used to replace the previous, and nothing showed on screen). They appear under the running reply marked "queued", go out together as one message when the reply arrives, and `/wow-ai cancel` puts them back in the input box.

### Added

- `WoW AI.app` (macOS): `npm run app` builds `~/Applications/WoW AI.app`, which starts the bridge in a Terminal window (unless it already runs) and then opens the Battle.net app (not the "World of Warcraft Launcher.app" stub in the game folder, which is an installer), so the bridge is up before the game and Battle.net still logs you in. `bridge/play-mac.sh` is the script behind it; `WOWAI_LAUNCHER` picks another app.
- File links. Paths of files that exist on the bridge's computer in a reply (absolute, `~/...`, or relative to the chat's folder, with an optional `:line`) become link buttons too, labelled `models.py:394`. A click opens the file at that line in Cursor (`cursor -g`, or `editor` in `config.json`; `code` as a fallback), in the window of the open project that holds the file (read from the editor's `storage.json`; the deepest folder wins), else the last active window. They travel as `file:///path#L394` links; the bridge only opens an existing regular file, and only as an argument to the editor. Restart the bridge to pick this up.
- Development chats. A chat is now either a **game chat** (the character/zone context, the addon/macro primer and the map/macro hints go into the agent's system prompt, as before) or a **development chat** (none of that: only the reply-format rule, a few thousand tokens less per run). New chats are development chats; `/wow-ai game on|off` switches the current chat, `/wow-ai game default on|off` sets what chats that never picked use. Game chats are marked `game` in the chat list. The strip record carries a `dev` flag (and the reload outbox `dev = true`); the bridge skips the context for such a run and logs `[dev]`.
- Step announcements. When the agent ticks off an item of its plan (Claude Code's `TodoWrite`, or `TaskCreate`/`TaskUpdate`; Codex's `todo_list`), the game chat gets `[Claude · chat] step N done: <item>` with a soft sound, while the agent keeps working. The bridge publishes the working record with every finished step so far (`steps` in the slot file) and flips `step/NNN/kk.wav`; the addon polls the next file for free and spends one slot to read the text. Subagents' plans are not announced. `/wow-ai steps on|off` (default on); `stepMax` in `config.json` (default 30). **Re-run `node setup.js` (or `npm run slots`) and restart WoW** so the client indexes the new `step/` files; without them steps still arrive with the scheduled slot polls, just later.
- Link buttons. Every http(s) URL in a reply becomes a button under it in the window and a `[label]` link on a `links:` line in the game chat (GitHub pull requests and issues read `repo#42`, Jira issues their key). A click sends an `o` record with the URL and the bridge opens it in the browser on your computer (`open`, `xdg-open` or `url.dll`); it refuses anything but http(s). With `jiraUrl` in `config.json`, issue keys like `ABC-123` become links to `<jiraUrl>/browse/ABC-123` too. Without the bridge, the link opens in the copy box. Up to 8 links per reply, sent as `links` on the reply record.
- Quick replies. When the agent needs you to pick or confirm, it ends the reply with a ```` ```choices ```` block, one option per line (up to 5); the newest reply shows each as a button in the window and on an `answer:` line in the game chat, and a click sends it as your next message. The bridge takes the block out of the text and sends `choices` on the reply record.
- `/wow-ai import [folder or session id]`: opens Claude Code sessions as chats. Without an argument it takes the lists the Claude Sessions Keeper editor extension saved in Cursor or VS Code over the last 3 days (a word narrows them to folders containing it); a session id imports that one session. The bridge binds each new chat to its session and folder, so the chat's next message runs `claude --resume <id>` there, and brings the last 20 messages of the transcript along. Sessions some chat already uses are skipped. Imported chats are development chats on Claude.
- Session sync. The bridge watches the Claude session of every chat (imported or started in game). Messages typed into it somewhere else, such as a terminal in Cursor, appear in that chat within seconds of the terminal going quiet, with an unread count and a line in the game chat; the bridge's own runs are recognised by `entrypoint: "sdk-cli"` and skipped. A new `sync/NNNN.wav` signal tells the addon there is something to read, so it spends a slot only then. **Run `npm run slots` and restart WoW** so the client sees the new files. `sessionSync: false` in `config.json` turns it off. The other direction can't be live: Claude open in a terminal keeps its conversation in memory, so it has to be restarted with `--resume` to see what was said in game.
- `/wow-ai ...` typed into the window's input box now runs the command, as it does in the game chat box, instead of going to the agent as a message. Other slash words (`/compact`, your skills) still go to the agent.

## [0.5.0] - 2026-11-04

### Added

- Linux support: the game under Wine on an X11 session. `bridge/capture_x11.py` (python3 + libX11 through ctypes, no packages) does what `capture.ps1` does, finding the game window by its Wine WM_CLASS (`wow.exe`) and tolerating a few pixels of misalignment. `npm run probe` saves what the capture sees to `bridge/probe.png`. New `capture` keys: `python`, `windowName`, `keepComposited`. `setup.js` looks for the client inside Wine prefixes. See [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md).
- Map layers drawn by the agent: numbered route pins joined by lines, quest stops and marks on the world map (zone and continent views), plus a navigator with an arrow and the distance in yards to the next stop that advances as you arrive. The agent's tools append commands to the file in `WOW_AI_MAP_FILE` (set per run), or the agent ends its reply with a ```` ```wowmap ```` block; the system prompt explains both. The bridge validates them, keeps the layers versioned in `state.json` and ships the whole set in the slot files, so nothing is applied twice and a client that lost its saved data gets them back on its next hello. See [docs/MAP.md](docs/MAP.md).
- Herb and ore spawns on the world map from an optional `WoWAI_Nodes` data addon, filtered by your gathering skill. `/wow-ai map` (or `/aimap`) toggles them (`ore`, `herb`, `filter all|skill`) and controls layers and navigation (`show`, `hide`, `nav`, `next`, `prev`, `stop`).
- The game context includes the quest log (quest ids, `*` when ready to turn in); its cap goes from 700 to 900 bytes.
- Ready-made macros: when you ask for a macro, the agent writes it in a ```` ```wowmacro <Name> ```` block and the reply gets a **Create macro** button (or **Update macro** when one with that name exists). A click saves it as an account or character macro and puts it on your cursor to drop on an action bar. It asks before replacing a different macro of yours or saving one that runs code (`/run`, `/script`, `/click`); `/wow-ai macro undo` reverts the last one. The bridge validates the blocks (name up to 16 characters, body up to 255 bytes, 6 per reply), sends them as `macros` on the reply record and keeps a readable copy in the text; blocks after the `TL;DR:` never reach the game-chat summary. Nothing is saved in combat, and the addon never runs a macro.
- macOS support for a native client: `bridge/capture_mac.py` (python3 stdlib only) finds the game window through System Events and grabs its top-left corner with `screencapture`; the bridge starts it on macOS, and `setup.js` recognises a `.app` client under `/Applications/World of Warcraft` and sets `capture.processName` from the bundle. `npm run probe:mac` saves what the capture sees. Contributed and tested live by its author; the decoder is covered by the codec round-trip test.
- **Antigravity** (`agy`, Google's Antigravity CLI) and **Hermes Agent** (`hermes`) next to Claude Code, Codex and Grok: `/wow-ai agent agy` or `hermes`, with their own blocks under `agents` in `config.json`. Hermes prints plain text, so the bridge reads its reply when the process ends (no live progress) and never passes it `--yolo`, even from `extraArgs`. Contributed with captured streams in `tests/agents_test.js` and a live check by their author on Windows. `CODEX_BIN` names the Codex launcher when the one on `PATH` isn't the right one.

### Changed

- The Forever release: the client moved to `_forever_` and its exe to `Wow.exe` (from `_classic_beta_` and `WowB.exe`). `setup.js` looks for `_forever_` first and moves a config still on the beta to it, keeping the other settings. The bridge's banner warns about a beta config when `_forever_` is installed. Defaults and docs follow.
- `setup.js` no longer needs a first login: it installs the addon and slots without an account folder, and the bridge finds the account once the game creates it.

### Fixed

- Re-running `setup.js --wow` with another client copied the addon there but kept the config and built the slots in the old one. The config now moves with it.
- Windows: the capture skips a game running from a different client folder than `addonDir`. Retail's exe is also `Wow.exe`, and the capture stayed attached to the first window it found.
- Codex, Claude or Grok installed with `npm install -g` on Windows were not found behind npm's `.cmd` launchers: current npm shims mention `node.exe` before the program, and the bridge took the first path it saw. It now takes the launcher whatever its name (`.js`, `.exe` or a bare script), and honours `agents.<id>.path` pointing at a `.cmd` or `.bat`.
- Professions in the game context were always empty on Forever: the client only has `C_SkillInfo` (one table per skill line), not the classic `GetNumSkillLines`/`GetSkillLineInfo` globals, which stay as fallback. Child lines that repeat their parent are skipped.

## [0.4.0] - 2026-09-24

This release renames the project from **wow-claude** to **WoW AI** (`wow-ai`) and adds two more agents next to Claude Code. Existing installs: `git pull`, `node setup.js` (it migrates the saved data, removes the old addon and updates `config.json`), then quit and relaunch the game. See "Upgrading from wow-claude" in `docs/INSTALL-WINDOWS.md`.

### Added

- **Short replies in the game chat, the full reply in the window.** The system prompt now goes out on every run (game context or not) and asks the agent to end each reply with a `TL;DR:` block of one or two lines; the bridge splits it off (`protocol.splitSummary`) and sends it as `summary` in the slot record next to the full `text`. The new `/wow-ai echo summary` mode, now the default, prints only those lines under `[Claude · chat]` with the `[open]` link to the whole reply; a reply without the block shows its first two lines and a hint to open the rest. Installs that still had the old `full` default saved move to `summary` once; `/wow-ai echo full` brings the old behaviour back.
- **Codex and Grok Build** next to Claude Code. `bridge/agents.js` holds one entry per agent (its command line, how the prompt is handed over, a parser for its output stream), `agent` in `config.json` is the default, and each chat can pick its own with `/wow-ai agent <name>` or the **Agent...** item in the chat's right-click menu (an `agent=` flag on the strip record and in the reload-path outbox). Bubbles, the game-chat echo and the `/r` header name the agent that answered; sessions are kept per agent and folder, so a chat that switches agent starts a fresh session. Per-agent settings live under `agents.<id>` (`permissionMode`, `allowedTools`, `model`, `path`, `extraArgs`; `networkAccess` for Codex). Codex runs `codex exec --json` in a sandbox chosen from `permissionMode`, with the game context at the top of the prompt since it has no system-prompt flag; Grok runs `grok --prompt-file … --output-format streaming-json` with `--permission-mode dontAsk` and the allowlist translated to its globs (headless Grok runs ordinary commands on its own and blocks dangerous ones unless a rule allows them), or `--always-approve`; `deniedTools` adds deny rules for Claude and Grok. Grok's refused tool calls feed the Allow button like Claude's denials; Codex explains a sandbox-blocked command in its own words. Both were tested live against codex 0.156.1 and Grok Build 1.0.41. The banner lists each agent's executable or what to install, `--agent` picks one for `--inject`, and `npm run test:live -- --agent codex` tries one without the game.
- On Windows the bridge unwraps npm's `.cmd` launchers (Codex, or Claude installed with npm) into the script or native binary they run, instead of spawning through `cmd.exe`, and a run that hits `timeoutMs` is killed together with its child processes.
- `docs/AGENTS.md`: per-agent install, command lines, what each permission mode means, limits, and how to add another agent. `tests/agents_test.js` covers the command lines and each CLI's stream format.
- Claude is told which game and client you are on, your character (name, realm, level, race, class, faction, guild), zone and map coordinates, money, talents and professions. The addon sends these few lines with its hello and again when they change (a `c` flag and an extra field in the strip record), the bridge keeps the latest in `state.json` and passes it to every run with `--append-system-prompt`. `/wow-ai context` shows it, `/wow-ai context off` stops it (and clears the bridge's copy), `"gameContext": false` in `config.json` disables it on the bridge side.
- `docs/WOW-ADDON-PRIMER.md`, a short reference on writing addons and macros for the Forever client, goes into the system prompt with the game context on every run, whatever folder the chat works in. `primerFile` in `config.json` points elsewhere or (`""`) drops it; edits are picked up without a restart.
- Shift-click an item, spell, quest or name while the addon's input box has focus to link it into the message, as in the game chat (hooked on `ChatFrameUtil.InsertLink`, the modern chat code the Forever client runs; the old `ChatEdit_InsertLink` global is used only where that is missing). On send, each link becomes `[Name]` in the text and its tooltip is appended in a "Linked from the game" block, so Claude can read an item's stats or a spell's description. Links typed in the game chat (`/ai … [item]`) get the same treatment.

### Changed

- **Renamed to WoW AI.** The addon is `WoWAI` (saved data `WoWAIDB`, slot addons `WoWAI_S###`, signal files under `Interface\AddOns\WoWAI`), the slash command `/wow-ai` (`/ai`, `/ask`, `/wowai` and the old `/wow-claude` are aliases of it, so `/ai agent codex` works; `/claude` is gone; `/r` stays), the bridge command `wow-ai`, the environment variable `WOW_AI_PROJECT`, the repository `chelinho139/wow-ai`. `node setup.js` migrates an install of the old name: it copies the saved data (chats, settings, session token) to `WoWAI.lua`, removes the `WoWClaude` addon and its slot folders, and rewrites `bridge/config.json` (paths, and Claude's `claudePath`/`model`/`permissionMode`/`allowedTools` moved under `agents.claude`). The bridge still reads a config in the old layout. Re-run `npm link` (after `npm unlink -g wow-claude`) and `/wow-ai bind` if you used them.
- A message typed after `/ai` or `/wow-ai` that starts with a command word (`/ai help me write a macro`, `/ai delete the unused imports`) is sent as a message unless the rest of the line fits that command; before, `delete` would have deleted the chat and `help` printed the help.
- Replies are stored with role `assistant` plus the agent that wrote them, in the addon's history and the bridge's `transcripts.json`; older entries with role `claude` are read as Claude's. The `[reply]`/`[open]` hyperlinks in the game chat use the `wowai:` prefix, and the window's cwd line shows the chat's agent.
- Rename and Folder moved off the bottom row into a small menu that opens when you right-click a chat in the left panel.
- Each chat row has a trash can that deletes the chat after an OK/Cancel confirm; `/wow-ai delete` still deletes without asking.
- Send sits at the right end of the input box instead of at the left of the bottom row.
- The bridge no longer exits when the addon folder is missing from `Interface\AddOns`; it logs one warning and the banner shows `addon : NOT INSTALLED`.

### Fixed

- Reload-mode messages now preserve permission grants for the bridge.
- Outbound wire fields now replace record separators inside user text and context.
- State, transcript, and permission-config writes now use the existing atomic writer.
- Agent parser failures now return a bridge error instead of terminating the bridge.
- Windows paths now keep their drive roots in portable protocol tests and progress labels.
- Non-Windows test runs now skip the PowerShell codec check with a clear message.
- Deleting a chat in game now tells the bridge to forget its transcript and agent session (a `d` strip record), so a later restore no longer brings the chat back. Deletions made while the bridge was away are resent with the next hello.
- On clients where the sound-file self-test fails (an empty `.wav` reports as playable), the addon can't hear the bridge's 30-second presence beats, and the status light went yellow 90 s after every reply, so each new message needed a Reconnect click and burned a slot. In that mode the light now allows for the 10-minute idle slot poll (green up to 12 min without news, "down" after 22), so it stays green while the bridge is running.
- A message sent while the light is not green is now sent automatically once the bridge answers the reconnect, instead of waiting for a second click on Send.

## [0.3.0] - 2026-09-22

First public release.

### Added

- In-game chat window (`/wow-claude`) with multiple chats, each backed by its own persistent Claude Code session, running in parallel up to `maxParallel`.
- Outbound transport: messages drawn as a pixel strip in the top-left corner and decoded by a PowerShell screen capture.
- Inbound transport: a pool of 200 load-on-demand slot addons the bridge writes replies into, plus `Inbox.lua` for the `/reload` fallback.
- Empty-wav signal files for acknowledgements, reply readiness, per-action heartbeats, and a 30-second presence beat that drives the status light.
- Live progress in the working bubble: action count, elapsed time, and the files and commands Claude is touching.
- Replies echoed into the game chat; `/r` replies to Claude when it was the last to message you; `/ai <text>` sends from the chat box.
- **Allow & retry** button when Claude is denied a tool, which appends the rule to `allowedTools` and resumes.
- Per-chat working folder (`/wow-claude cd`, **Folder** button) resolved against the bridge's default folder.
- Bridge-side transcripts and automatic restore of chats after the client wipes addon saved data.
- `wow-claude` command (`npm link`) that uses the folder it is started from as the default project.
- `setup.js` installer: finds the client, copies the addon, writes `config.json`, builds the slot pool.
- Test suite: addon in a Lua VM with a stub client, protocol unit tests, slot-file round trip, codec-to-decoder round trip, and a live inject test.

[Unreleased]: https://github.com/chelinho139/wow-ai/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/chelinho139/wow-ai/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/chelinho139/wow-ai/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/chelinho139/wow-ai/releases/tag/v0.3.0
