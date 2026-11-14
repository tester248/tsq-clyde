# Klyde Bridge (Fabric mod)

Thin, passive server-side mod that gives Klyde (Cloudflare worker) live
awareness of this server. It connects **outbound** over WebSocket to the
worker's `POST /minecraft/bridge/connect` endpoint — no inbound ports, no
port-forwarding.

## Protocol

See `docs/superpowers/specs/2026-11-09-klyde-minecraft-leg-spec.md` §4.2.
Frames: `hello` (auth) / `query` / `result` / `ping` / `pong`.

## Build matrix

One codebase, two supported game versions (edit `gradle.properties` or pass
`-P` flags):

| Minecraft | Loader | Loom | Fabric API |
|---|---|---|---|
| 26.3 | 0.20.1 | 1.19-SNAPSHOT | 0.166.2+26.3 |
| 26.2 | 0.20.1 | 1.19-SNAPSHOT | 0.161.0+26.2 |

**Requires JDK 21+** (Minecraft 26.x). The current dev machine has JDK 17 —
install a JDK 21 or newer before building.

**Also required:** `yarn_mappings` in `gradle.properties` — look up the exact
Yarn build for your Minecraft version at <https://fabricmc.net/develop/>.

## Build

```bash
# Gradle (v8.x) or the wrapper:
gradle build          # uses gradle.properties (default 26.3)

# For 26.2:
gradle build -Pminecraft_version=26.2 -Pfabric_api_version=0.161.0+26.2
```

Output: `build/libs/klyde-bridge-<version>.jar` → drop into the server's
`mods/` folder.

## Configuration (`config/klyde-bridge.properties`)

```properties
# Required
bridge.url=wss://tsq-klyde.deezgames.workers.dev/minecraft/bridge/connect
bridge.token=REPLACE_WITH_SHARED_SECRET

# Optional
announce=false
# optout.Alice=true
# optout.Bob=true
```

- `bridge.token` must match the worker's `MC_BRIDGE_TOKEN` secret.
- `optout.<name>=true` excludes that player from `recent_chat` and
  `player_location` (filtered before data leaves the server); they appear as
  `[redacted]` in `players`.
- `announce=true` broadcasts a message in-game when the bridge connects.

## Scope notes

- **Not** a chat bridge: the server already runs "Simple Discord Link" for
  Discord ⇄ in-game chat. Klyde only reads recent chat for awareness.
- Read-only queries only. Admin command execution is a future slice.
- Compile-time checkpoint: `ServerMessageEvents.CHAT_MESSAGE` and
  `getAverageTickTime`/`getCurrentPlayerCount` resolve against Yarn mappings
  for your version — if a signature shifted for 26.2/26.3, adjust in
  `KlydeBridgeMod` / `QueryHandler` (one-line fixes).
