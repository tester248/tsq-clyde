# Klyde Minecraft Leg — In-Game Invocation Slice (v0.9.0) Spec

> **Status:** Design spec for review. No code until approved.
> **Parent spec:** `2026-11-09-klyde-minecraft-leg-spec.md` (revised). This
> slice builds on the long-poll bridge and the awareness tool already live.

## 0. Locked decisions (2026-11-16, with user)

| Topic | Decision |
|---|---|
| Trigger | Any player chat message containing the word "klyde" (case-insensitive, word boundary) becomes a query; the rest of the message is the prompt. No `@` required. |
| Progress messages | Same phases as Discord (searching/reading/composing), but **no emoji** — plain short text. Broadcast to the whole server by default; per-player toggle to hide. |
| Reply formatting | Minecraft-aware: short sentences, split across multiple chat messages; no large paragraphs or structured text. |
| Color | Dark blue default (`ChatFormatting.DARK_BLUE`), configurable in config. |
| Config format | **JSON** (Gson already a dependency; avoids YAML classpath issues seen with other mods on the server). Replaces `.properties`. |
| Mod roster | Hybrid: auto-inject a compact one-line summary into the prompt per invocation; full detail available on demand via a `mods` tool action. |
| Privacy | Share-by-default. `/klyde privacy <on|off>` opts a player out (hides their location + chat from queries). No LuckPerms requirement — command registered permissionless by default. |
| Reply visibility | Final answer broadcasts to the whole server (like Discord). Progress also broadcasts by default; `/klyde progress <on|off>` hides progress, `/klyde messages <on|off>` hides all Klyde messages for that player. |

## 1. Intent

Make Klyde usable **inside Minecraft chat**, naturally: a player types
anything containing "klyde", and Klyde answers in-game with a visible,
color-coded, well-formatted reply — while remaining aware of the server's mod
roster and respecting per-player privacy/visibility preferences.

## 2. Architecture

### 2.1 Reverse channel (mod → worker) + outbox

Today the bridge is worker→mod (query frames via `/poll`) and mod→worker
(results via `/result`). Invocation needs the reverse, so we extend the
protocol:

- New worker route `POST /minecraft/bridge/invoke` (Bearer-gated): body
  `{player, text}`. The worker forwards to the bridge DO.
- New worker route `POST /minecraft/bridge/roster` (Bearer-gated): body
  `{mods:[{id,name,version}]}` — the mod pushes its mod list at startup.
- Bridge DO gains:
  - `/invoke`: runs a headless agent invocation (see §2.2) and enqueues
    outgoing chat frames (progress + final) into an **outbox** queue.
  - `/roster`: stores the mod roster in DO storage.
  - Roster storage: simple `storage.put("roster", list)`, read for prompt
    injection and the `mods` tool.
  - `/poll` now returns either a query frame *or* the next outbox message:
    `{query:{...}}` / `{message:{...}}` / `{}`. (One frame per poll keeps
    ordering simple; the mod drains until empty.)
  - `queueLength` in status/probe now counts queries + outbox.

### 2.2 Headless invocation (worker side)

Add `processMinecraftInvocation` in `src/processor.js` (or a sibling module)
that reuses the existing agent stack:

- Builds messages like `processMessage` (author label, channel memory +
  current asker profile from the server's ConversationDO, summary).
- Adds the **mod roster system message** (one line, e.g.
  `Server mods (23): aether, mythicmetals, ...` — capped, say 30 names).
- Runs `runAgentLoop` with the same tools; `onPhase` calls a `deliver`
  callback that enqueues a progress frame.
- On completion, formats the answer for game chat (§2.3) and enqueues the
  final frame(s).
- Refusal/sentinel handling identical to Discord path (friendly fallback).
- The invocation runs **inside the bridge DO** (it owns the outbox and has
  env access). The DO imports `processMinecraftInvocation` and calls it with
  a `deliver` that pushes to the outbox. This keeps Discord and Minecraft on
  the same brain code.

### 2.3 Game-chat formatting

- Strip common markdown/structured artifacts (`#`, `*`, `-`, `>`), collapse
  whitespace.
- Split into short messages: sentence-boundary aware, max ~180–220 chars
  each, max ~5 messages for a reply.
- Progress frames: `Klyde is searching…`, `Klyde is reading sources…`,
  `Klyde is composing…` (no emoji).

### 2.4 Mod-side changes (`minecraft/klyde-bridge`)

- **Roster:** at startup, enumerate mods via `FabricLoader.getAllMods()`
  (filter Fabric API/loader/ours), POST to `/roster`.
- **Trigger:** in the existing `CHAT_MESSAGE` handler, after `recent_chat`
  capture, detect `klyde` (case-insensitive, word boundary). If present and
  not a bot/system message, build `{player, text}` and POST to `/invoke`
  (best-effort; failures logged, never break chat). Skip if the sender opted
  out of *all* messages? No — invocation is opt-in by typing the word; the
  `messages off` toggle suppresses *output*, not the ability to ask.
- **Outbox loop:** the existing poll loop now also handles `message` frames:
  broadcast with configured color to all online players **except** those
  with `messages off`; progress frames additionally skip `progress off`
  players.
- **Config migration:** `config/klyde-bridge.json` (was `.properties`).
  Ship a default JSON template on first boot; migrate old `.properties`
  values if present (read once, write JSON, leave properties in place or
  rename to `.bak`). Keys: `bridge.url`, `bridge.token`, `announce`,
  `color` (default `dark_blue`), plus per-player prefs.
- **Player prefs** (JSON, `config/klyde-preferences.json`): per player:
  `privacy` (bool), `showProgress` (bool, default true), `showMessages`
  (bool, default true).
- **Command tree** `/klyde`:
  - `/klyde privacy <on|off>` — opt out/in of data sharing (location, chat).
  - `/klyde progress <on|off>` — hide/show progress messages.
  - `/klyde messages <on|off>` — hide/show all Klyde messages.
  - `/klyde` (no args) — help text.
  - Registered with Fabric's command API **without a permission check**
    (permissionless by default; LuckPerms can layer on later if wanted).
- **Privacy enforcement** stays in `QueryHandler` as today, but reads the
  per-player prefs instead of `optout.*` properties.

### 2.5 Tool update

- `minecraft` tool gains a `mods` action returning the stored roster
  (`{mods:[{id,name,version}]}`). Read-only, no gate.

## 3. Non-goals

- No admin commands (Simple Discord Link `#console` + host dashboard cover it).
- No chat bridging (SDL covers game⇄Discord).
- No LuckPerms integration yet (just permissionless registration).
- No per-player *injection* beyond the existing asker profile.

## 4. Review Focus (tests must pin)

1. Trigger detection: case-insensitive, word boundary, ignores system/bot
   messages, doesn't fire on "klyde" inside other words.
2. `/invoke` auth + routing; bridge DO queues progress + final frames in
   order; `/poll` returns query vs message vs empty.
3. Roster: push, storage, prompt injection one-liner, `mods` tool action.
4. Formatting: markdown stripped, sentence-boundary chunking, caps.
5. Privacy: `/klyde privacy on` removes the player from `recent_chat` and
   `player_location`; appears `[redacted]` in `players`.
6. Visibility toggles: `progress off` / `messages off` filter broadcasts.
7. Config: JSON template created on first boot; old `.properties` migrated.
8. Command tree: `/klyde` subcommands update prefs, persist, permissionless.
9. Existing suite stays green (tools/agent/processor/bridge).

## 5. Definition of done

- Tests green across worker + mod-facing suites.
- Mod builds for 26.3 (and 26.2 unchanged).
- Live: typing `klyde what is the tps` in game returns a colored, chunked
  answer; `klyde what mods add new mobs` returns roster-aware answer;
  `/klyde privacy on` hides that player from `/mc players`/`player_location`
  and `recent_chat`; `/klyde messages off` silences output for that player.
- README + STATUS updated; tagged `v0.9.0`.
