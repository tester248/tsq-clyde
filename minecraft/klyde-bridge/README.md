# Klyde Bridge (Fabric mod)

Thin, passive server-side mod that gives Klyde (Cloudflare worker) live
awareness of this server. It connects **outbound** over WebSocket to the
worker's `POST /minecraft/bridge/connect` endpoint — no inbound ports, no
port-forwarding.

**Status: builds verified for both 26.3 and 26.2** (Gradle 9.8.0, JDK 25).
Artifact: `klyde-bridge-0.1.0.jar` in `build/libs/`.

## Protocol

See `docs/superpowers/specs/2026-11-09-klyde-minecraft-leg-spec.md` §4.2.
Frames: `hello` (auth) / `query` / `result` / `ping` / `pong`.

## Build matrix

One codebase, two supported game versions. `gradle.properties` defaults to
26.3; edit the two lines (or use `-P` overrides) for 26.2:

| Minecraft | Loader | Loom | Fabric API |
|---|---|---|---|
| 26.3 | 0.20.1 | 1.19-SNAPSHOT | 0.166.2+26.3 |
| 26.2 | 0.20.1 | 1.19-SNAPSHOT | 0.161.0+26.2 |

**Toolchain (verified):** JDK 21+ (built with JDK 25), Gradle 9.8.0.
Minecraft 26.x ships unobfuscated, so there is **no mappings dependency** —
no Yarn/Mojang mappings are needed or available.

## Build

```bash
gradle build               # default: 26.3 (gradle.properties)
# 26.2 via overrides:
gradle build -Pminecraft_version=26.2 -Pfabric_api_version=0.161.0+26.2
```

Output: `build/libs/klyde-bridge-0.1.0.jar` → drop into the server's
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
- Uses the 26.x unobfuscated toolchain: `net.fabricmc.fabric-loom` plugin,
  no mappings, Java 25/`options.release = 25`. Verified builds for 26.3 and
  26.2.
