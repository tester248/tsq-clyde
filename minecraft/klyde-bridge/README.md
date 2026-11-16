# Klyde Bridge (Fabric mod)

Thin, passive server-side mod that gives Klyde (Cloudflare worker) live
awareness of this server **and lets players invoke Klyde in-game**. It talks
to the worker over **long-poll plain HTTPS** — no inbound ports, no
port-forwarding, and it survives egress proxies that kill WebSocket upgrades.

**Status: builds verified for both 26.3 and 26.2** (Gradle 9.8.0, JDK 25).
Artifact: `klyde-bridge-0.1.0.jar` in `build/libs/`.

## Transport & protocol

- **Poll:** `GET /minecraft/bridge/poll` (Bearer token) — long-polls up to
  15s; returns a frame: `{query:{...}}` (a tool query to answer),
  `{message:{kind,text}}` (an outgoing Klyde chat message), or `{}`.
- **Result:** `POST /minecraft/bridge/result` — answers a `query` frame.
- **Invoke:** `POST /minecraft/bridge/invoke` — sends an in-game invocation
  (`{player, text}`) to the worker when a player's chat contains "klyde".
- **Roster:** `POST /minecraft/bridge/roster` — pushes the installed-mod list
  at startup so Klyde can answer mod-aware questions.

## In-game behavior (v0.9.0)

- **Trigger:** any player chat message containing the word `klyde`
  (case-insensitive, word boundary) becomes a query. The rest of the message
  is the prompt. E.g. `klyde what is the tps`.
- **Progress:** Klyde broadcasts short plain-text progress lines while
  working (`Klyde is searching…`, reading, composing) — no emoji.
- **Replies:** broadcast to the whole server, **dark blue** (configurable),
  chunked into short sentences — not long paragraphs.
- **Mod awareness:** the mod roster is pushed at startup; Klyde injects a
  one-line summary per invocation and can enumerate full details via a tool.

## Commands (`/klyde`)

Per-player settings are permissionless for everyone; ban/unban/clear require **op**
(vanilla permission level 2+, no LuckPerms setup needed).

| Command | Effect |
|---|---|
| `/klyde` | help |
| `/klyde privacy <on|off>` | opt out/in of sharing location + chat data |
| `/klyde progress <on|off>` | hide/show Klyde's progress messages (this player) |
| `/klyde messages <on|off>` | hide/show all Klyde messages (this player) |
| `/klyde ban <player>` | (op) bar a player from invoking Klyde |
| `/klyde unban <player>` | (op) lift a ban |
| `/klyde clear` | (op) wipe the in-game conversation |

## Build matrix

One codebase, two supported game versions. `gradle.properties` defaults to
26.3; edit the two lines (or use `-P` overrides) for 26.2:

| Minecraft | Loader | Loom | Fabric API |
|---|---|---|
| 26.3 | 0.20.1 | 1.19-SNAPSHOT | 0.166.2+26.3 |
| 26.2 | 0.20.1 | 1.19-SNAPSHOT | 0.161.0+26.2 |

**Toolchain (verified):** JDK 21+ (built with JDK 25), Gradle 9.8.0.
Minecraft 26.x ships unobfuscated, so there is **no mappings dependency** —
no Yarn/Mojang mappings are needed or available.

## Build

```bash
gradle clean build       # default: 26.3 (gradle.properties)
# 26.2: edit gradle.properties (minecraft_version=26.2,
# fabric_api_version=0.161.0+26.2) and rebuild.
```

Output: `build/libs/klyde-bridge-0.1.0.jar` → drop into the server's
`mods/` folder.

> ⚠️ **Jars are per game version.** The built jar embeds its Minecraft
> compatibility range (`fabric.mod.json` → `depends.minecraft`). A jar built
> for 26.2 will be **rejected by a 26.3 server** (and vice versa) — exactly
> the `HARD_DEP_INCOMPATIBLE_PRESELECTED` failure seen on first deploy.
> Always rebuild after switching `gradle.properties`, and verify the range
> inside the jar before deploying:
>
> ```powershell
> # inspect the embedded fabric.mod.json
> Add-Type -AssemblyName System.IO.Compression.FileSystem
> $zip = [System.IO.Compression.ZipFile]::OpenRead("build/libs/klyde-bridge-0.1.0.jar")
> $e = $zip.Entries | Where-Object { $_.FullName -eq "fabric.mod.json" }
> (New-Object System.IO.StreamReader($e.Open())).ReadToEnd()
> ```
>
> Suggested: name deployed jars by version (`klyde-bridge-0.1.0-mc26.3.jar`)
> so the right one is obvious.

## Configuration (`config/klyde-bridge.json`)

**Created automatically on first boot** in the server's config directory. If
a legacy `config/klyde-bridge.properties` exists, it is migrated once (the old
file is renamed to `.bak`). Edit and restart to apply.

```json
{
  "bridgeUrl": "https://tsq-klyde.deezgames.workers.dev/minecraft/bridge",
  "token": "REPLACE_WITH_SHARED_SECRET",
  "announce": false,
  "color": "dark_blue"
}
```

- `bridgeUrl` is the worker bridge base (no trailing slash); the mod appends
  `/poll`, `/result`, `/invoke`, `/roster`.
- `token` must match the worker's `MC_BRIDGE_TOKEN` secret.
- `color` — one of the standard Minecraft chat colors (`dark_blue` is the
  default: `black`, `dark_blue`, `dark_green`, `dark_aqua`, `dark_red`,
  `dark_purple`, `gold`, `gray`, `dark_gray`, `blue`, `green`, `aqua`,
  `red`, `light_purple`, `yellow`, `white`).

## Per-player preferences (`config/klyde-preferences.json`)

Managed via `/klyde` in-game; share-by-default:

```json
{
  "alice": { "privacy": false, "showProgress": true, "showMessages": true, "banned": false }
}
```

- `privacy: true` — the player's location and chat are excluded from queries
  (they appear as `[redacted]` in `/mc players`).
- `showProgress: false` — hides Klyde's progress lines for that player.
- `showMessages: false` — hides all Klyde messages for that player.
- `banned: true` — the player cannot invoke Klyde (managed via `/klyde ban`).

## Scope notes

- **Not** a chat bridge: the server already runs "Simple Discord Link" for
  Discord ⇄ in-game chat. Klyde only reads recent chat for awareness and
  answers direct in-game invocations.
- Read-only awareness + invocation only. Admin/console commands are left to
  SDL's `#console` channel and the host dashboard.
- Uses the 26.x unobfuscated toolchain: `net.fabricmc.fabric-loom` plugin,
  no mappings, Java 25/`options.release = 25`. Verified builds for 26.3 and
  26.2.
