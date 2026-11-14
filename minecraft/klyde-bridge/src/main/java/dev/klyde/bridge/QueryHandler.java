package dev.klyde.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;

/**
 * Implements the bridge's query surface. All methods are called on the
 * server thread. Opt-out is enforced here, before any data is returned.
 */
final class QueryHandler {
    private final KlydeBridgeMod mod;
    private final ChatLog chatLog;

    QueryHandler(KlydeBridgeMod mod) {
        this.mod = mod;
        this.chatLog = new ChatLog(20);
    }

    void recordChat(String player, String text, long ts) {
        chatLog.push(player, text, ts);
    }

    JsonObject handle(String action, String player) {
        MinecraftServer server = mod.getServer();
        if (server == null) {
            return error("server not ready");
        }
        switch (action == null ? "" : action) {
            case "status" -> {
                return status(server);
            }
            case "players" -> {
                return players(server);
            }
            case "recent_chat" -> {
                return recentChat();
            }
            case "player_location" -> {
                return playerLocation(server, player);
            }
            default -> {
                return error("unknown action: " + action);
            }
        }
    }

    private JsonObject status(MinecraftServer server) {
        double avgTick = server.getAverageTickTime(); // ms per tick
        double tps = avgTick > 0 ? Math.min(20.0, 1000.0 / avgTick) : 20.0;
        String version = server.getVersion();

        JsonObject o = new JsonObject();
        o.addProperty("version", version);
        o.addProperty("tps", Math.round(tps * 100.0) / 100.0);
        o.addProperty("uptime", (System.nanoTime() - mod.serverStartNanos()) / 1_000_000_000L);
        o.addProperty("playersNow", server.getPlayerManager().getCurrentPlayerCount());
        o.addProperty("playersMax", server.getPlayerManager().getMaxPlayerCount());
        return o;
    }

    private JsonObject players(MinecraftServer server) {
        JsonArray names = new JsonArray();
        for (ServerPlayerEntity p : server.getPlayerManager().getPlayerList()) {
            String name = p.getName().getString();
            if (mod.getConfig().isOptedOut(name)) {
                names.add("[redacted]");
            } else {
                names.add(name);
            }
        }
        JsonObject o = new JsonObject();
        o.add("players", names);
        return o;
    }

    private JsonObject recentChat() {
        JsonArray messages = new JsonArray();
        for (ChatLog.Entry e : chatLog.entries()) {
            if (mod.getConfig().isOptedOut(e.player())) {
                continue; // privacy: never expose opted-out players' words
            }
            JsonObject m = new JsonObject();
            m.addProperty("player", e.player());
            m.addProperty("text", e.text());
            m.addProperty("ts", e.ts());
            messages.add(m);
        }
        JsonObject o = new JsonObject();
        o.add("messages", messages);
        return o;
    }

    private JsonObject playerLocation(MinecraftServer server, String player) {
        if (player == null || player.isBlank()) {
            return error("player is required");
        }
        if (mod.getConfig().isOptedOut(player)) {
            return error(player + " has opted out of location data");
        }
        ServerPlayerEntity p = server.getPlayerManager().getPlayer(player);
        if (p == null) {
            return error("player not online: " + player);
        }
        JsonObject o = new JsonObject();
        o.addProperty("player", player);
        o.addProperty("x", p.getBlockPos().getX());
        o.addProperty("y", p.getBlockPos().getY());
        o.addProperty("z", p.getBlockPos().getZ());
        o.addProperty("dimension", p.getWorld().getRegistryKey().getValue().toString());
        return o;
    }

    private JsonObject error(String message) {
        JsonObject o = new JsonObject();
        o.addProperty("error", message);
        return o;
    }
}
