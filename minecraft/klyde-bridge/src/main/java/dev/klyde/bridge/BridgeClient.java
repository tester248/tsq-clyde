package dev.klyde.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Bridge client — long-poll transport over plain HTTPS.
 *
 * Egress proxies on some hosts (e.g. managed Minecraft hosting) terminate
 * WebSocket upgrades: the handshake appears to succeed but frames never
 * arrive at the Cloudflare DO. Plain HTTPS is proven to work, so this client
 * polls the worker for queued query frames and POSTs results back.
 *
 * Transport: GET /minecraft/bridge/poll (long-poll, up to 15s) -> may return
 * {query:{id,action,player}}; then POST /minecraft/bridge/result with the
 * query's result. Both are Bearer-authenticated.
 */
public final class BridgeClient {
    private static final int POLL_TIMEOUT_MS = 15_000;
    private static final long POLL_INTERVAL_MS = 1_000;
    private static final long FIRST_SUCCESS_ANNOUNCE_MS = 5_000;

    private final KlydeBridgeMod mod;
    private final HttpClient http;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final AtomicBoolean announced = new AtomicBoolean(false);

    private QueryHandler queryHandler;
    private Thread pollThread;
    private long lastPollAt;

    public BridgeClient(KlydeBridgeMod mod) {
        this.mod = mod;
        this.http = HttpClient.newHttpClient();
        this.queryHandler = new QueryHandler(mod);
    }

    public void start() {
        running.set(true);
        connectivityCheck();
        pushRoster();
        pollThread = new Thread(this::pollLoop, "klyde-bridge-poll");
        pollThread.setDaemon(true);
        pollThread.start();
    }

    // Enumerate installed mods and push them to the worker so the brain can
    // inject a roster summary and answer `mods` tool queries. Best-effort.
    private void pushRoster() {
        String rosterUrl = deriveUrl("/roster");
        if (rosterUrl == null) return;
        try {
            JsonArray mods = new JsonArray();
            for (net.fabricmc.loader.api.ModContainer container : net.fabricmc.loader.api.FabricLoader.getInstance().getAllMods()) {
                String id = container.getMetadata().getId();
                if (id.startsWith("fabric") || id.equals("klyde-bridge")) continue;
                JsonObject m = new JsonObject();
                m.addProperty("id", id);
                m.addProperty("name", container.getMetadata().getName() == null ? id : container.getMetadata().getName());
                m.addProperty("version", container.getMetadata().getVersion().getFriendlyString());
                mods.add(m);
            }
            JsonObject payload = new JsonObject();
            payload.add("mods", mods);
            HttpRequest req = HttpRequest.newBuilder(URI.create(rosterUrl))
                .timeout(Duration.ofSeconds(10))
                .header("Authorization", "Bearer " + mod.getConfig().token())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload.toString()))
                .build();
            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            KlydeBridgeMod.LOGGER.info("Klyde roster pushed: {} mods (status {})", mods.size(), resp.statusCode());
        } catch (Exception e) {
            KlydeBridgeMod.LOGGER.warn("Klyde roster push failed: {}", e.toString());
        }
    }

    public void stop() {
        running.set(false);
        if (pollThread != null) {
            pollThread.interrupt();
            pollThread = null;
        }
    }

    // Probe whether plain HTTPS outbound survives the host's egress proxy
    // (diagnostic only; the poll transport itself depends on plain HTTPS).
    private void connectivityCheck() {
        String pingUrl = deriveUrl("/ping");
        if (pingUrl == null) return;
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(pingUrl))
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();
            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            KlydeBridgeMod.LOGGER.info(
                "Klyde connectivity check: plain HTTPS {} ({})",
                resp.statusCode(), pingUrl);
        } catch (Exception e) {
            KlydeBridgeMod.LOGGER.warn(
                "Klyde connectivity check failed (outbound blocked?): {}", e.toString());
        }
    }

    private String deriveUrl(String suffix) {
        String bridgeUrl = mod.getConfig().bridgeUrl();
        if (bridgeUrl.isEmpty()) return null;
        try {
            return bridgeUrl
                .replaceFirst("^wss://", "https://")
                .replaceFirst("/connect$", "") + suffix;
        } catch (Exception e) {
            return null;
        }
    }

    private void pollLoop() {
        while (running.get()) {
            try {
                pollOnce();
                Thread.sleep(POLL_INTERVAL_MS);
            } catch (InterruptedException ie) {
                return;
            } catch (Exception e) {
                KlydeBridgeMod.LOGGER.warn("Klyde bridge poll error: {}", e.toString());
                try {
                    Thread.sleep(POLL_INTERVAL_MS * 3);
                } catch (InterruptedException ie) {
                    return;
                }
            }
        }
    }

    private void pollOnce() throws Exception {
        String pollUrl = deriveUrl("/poll?timeout=" + POLL_TIMEOUT_MS);
        if (pollUrl == null) return;

        HttpRequest req = HttpRequest.newBuilder(URI.create(pollUrl))
            .timeout(Duration.ofSeconds(POLL_TIMEOUT_MS / 1000 + 5))
            .header("Authorization", "Bearer " + mod.getConfig().token())
            .GET()
            .build();
        HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());

        if (resp.statusCode() != 200) {
            KlydeBridgeMod.LOGGER.warn("Klyde bridge poll returned {}", resp.statusCode());
            return;
        }
        if (!announced.getAndSet(true)) {
            onFirstSuccess();
        }
        lastPollAt = System.currentTimeMillis();

        JsonElement el;
        try {
            el = JsonParser.parseString(resp.body());
        } catch (Exception e) {
            return;
        }
        if (!el.isJsonObject()) return;
        JsonObject body = el.getAsJsonObject();
        if (body.has("message") && body.get("message").isJsonObject()) {
            JsonObject message = body.getAsJsonObject("message");
            handleMessageFrame(message);
            return;
        }
        if (!body.has("query") || !body.get("query").isJsonObject()) return;

        JsonObject query = body.getAsJsonObject("query");
        long id = query.has("id") ? query.get("id").getAsLong() : -1L;
        String action = query.has("action") ? query.get("action").getAsString() : "";
        String player = query.has("player") && !query.get("player").isJsonNull()
            ? query.get("player").getAsString() : null;

        KlydeBridgeMod.LOGGER.info("Klyde bridge got query {} action={} player={}", id, action, player);

        // Game state must be read on the server thread.
        var server = mod.getServer();
        if (server == null) {
            postResult(id, false, "server not ready");
            return;
        }
        server.execute(() -> {
            JsonObject result = queryHandler.handle(action, player);
            postResult(id, true, result);
        });
    }

    // Broadcast an outgoing Klyde chat frame to eligible players.
    private void handleMessageFrame(JsonObject message) {
        String kind = message.has("kind") ? message.get("kind").getAsString() : "reply";
        String text = message.has("text") ? message.get("text").getAsString() : "";
        if (text.isEmpty()) return;

        var server = mod.getServer();
        if (server == null) return;
        server.execute(() -> {
            net.minecraft.network.chat.Component component =
                net.minecraft.network.chat.Component.literal(text).withStyle(mod.getConfig().chatColor());
            boolean isProgress = "phase".equals(kind);
            for (net.minecraft.server.level.ServerPlayer p : server.getPlayerList().getPlayers()) {
                String name = p.getName().getString();
                if (!mod.getPreferences().getShowMessages(name)) continue;
                if (isProgress && !mod.getPreferences().getShowProgress(name)) continue;
                p.sendSystemMessage(component);
            }
        });
    }

    // Send an in-game invocation (chat message containing "klyde") to the
    // worker. Best-effort: failures are logged, never break chat.
    public void invoke(String player, String text) {
        String invokeUrl = deriveUrl("/invoke");
        if (invokeUrl == null) return;
        JsonObject payload = new JsonObject();
        payload.addProperty("player", player);
        payload.addProperty("text", text);
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(invokeUrl))
                .timeout(Duration.ofSeconds(10))
                .header("Authorization", "Bearer " + mod.getConfig().token())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload.toString()))
                .build();
            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 202) {
                KlydeBridgeMod.LOGGER.warn("Klyde invoke returned {}", resp.statusCode());
            }
        } catch (Exception e) {
            KlydeBridgeMod.LOGGER.warn("Klyde invoke failed: {}", e.toString());
        }
    }

    private void onFirstSuccess() {
        KlydeBridgeMod.LOGGER.info("Klyde bridge connected (poll transport)");
        if (mod.getConfig().announce()) {
            var server = mod.getServer();
            if (server != null) {
                server.execute(() -> server.getPlayerList().broadcastSystemMessage(
                    net.minecraft.network.chat.Component.literal("[Klyde] bridge connected"),
                    false));
            }
        }
    }

    private void postResult(long id, boolean ok, Object data) {
        String resultUrl = deriveUrl("/result");
        if (resultUrl == null) return;
        StringBuilder sb = new StringBuilder();
        sb.append("{\"id\":").append(id)
          .append(",\"ok\":").append(ok);
        if (data != null) {
            sb.append(",\"data\":").append(data);
        }
        sb.append("}");
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(resultUrl))
                .timeout(Duration.ofSeconds(10))
                .header("Authorization", "Bearer " + mod.getConfig().token())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(sb.toString()))
                .build();
            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 200) {
                KlydeBridgeMod.LOGGER.warn("Klyde bridge result posted but got {}", resp.statusCode());
            }
        } catch (Exception e) {
            KlydeBridgeMod.LOGGER.warn("Klyde bridge result POST failed: {}", e.toString());
        }
    }
}
