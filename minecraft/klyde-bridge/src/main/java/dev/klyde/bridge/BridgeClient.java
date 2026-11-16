package dev.klyde.bridge;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Outbound WebSocket client. Connects to the Cloudflare worker's
 * /minecraft/bridge/connect endpoint, authenticates with a hello frame, and
 * answers query frames. Reconnects with backoff. Game-state reads happen on
 * the server thread (via MinecraftServer.execute) — never on WS threads.
 */
public final class BridgeClient {
    private static final int MAX_BACKOFF_MS = 30_000;

    private final KlydeBridgeMod mod;
    private final HttpClient http;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    private WebSocket socket;
    private QueryHandler queryHandler;
    private int backoffMs = 1_000;

    public BridgeClient(KlydeBridgeMod mod) {
        this.mod = mod;
        this.http = HttpClient.newHttpClient();
        this.queryHandler = new QueryHandler(mod);
    }

    public void start() {
        running.set(true);
        connectivityCheck();
        connect();
    }

    // Probe whether plain HTTPS outbound survives the host's egress proxy
    // (WebSocket upgrades may be intercepted/terminated while normal HTTPS
    // still works). Diagnostic only — the WS remains the primary transport.
    private void connectivityCheck() {
        String bridgeUrl = mod.getConfig().bridgeUrl();
        if (!mod.getConfig().isUsable()) return;
        String pingUrl;
        try {
            pingUrl = bridgeUrl
                .replaceFirst("^wss://", "https://")
                .replaceFirst("/connect$", "/ping");
        } catch (Exception e) {
            return;
        }
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(pingUrl))
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();
            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() == 200) {
                KlydeBridgeMod.LOGGER.info(
                    "Klyde connectivity check: plain HTTPS OK ({} -> {})",
                    resp.statusCode(), pingUrl);
            } else {
                KlydeBridgeMod.LOGGER.warn(
                    "Klyde connectivity check: plain HTTPS returned {} ({})",
                    resp.statusCode(), pingUrl);
            }
        } catch (Exception e) {
            KlydeBridgeMod.LOGGER.warn(
                "Klyde connectivity check failed (outbound blocked?): {}", e.toString());
        }
    }

    public void stop() {
        running.set(false);
        if (socket != null) {
            try {
                socket.sendClose(WebSocket.NORMAL_CLOSURE, "server stopping");
            } catch (Exception ignored) {
            }
            socket = null;
        }
        scheduler.shutdownNow();
    }

    private void connect() {
        if (!running.get() || !mod.getConfig().isUsable()) return;
        try {
            URI uri = URI.create(mod.getConfig().bridgeUrl());
            socket = http.newWebSocketBuilder()
                .header("Authorization", "Bearer " + mod.getConfig().token())
                .buildAsync(uri, new Listener())
                .get(10, TimeUnit.SECONDS);
            backoffMs = 1_000; // reset on successful connect
        } catch (Exception e) {
            KlydeBridgeMod.LOGGER.warn("Klyde bridge connect failed: {}", e.toString());
            scheduleReconnect();
        }
    }

    private void scheduleReconnect() {
        if (!running.get()) return;
        final int delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        scheduler.schedule(this::connect, delay, TimeUnit.MILLISECONDS);
    }

    private void send(String json) {
        WebSocket ws = socket;
        if (ws != null) {
            try {
                ws.sendText(json, true);
                KlydeBridgeMod.LOGGER.info("Klyde bridge sent: {}", json);
            } catch (Exception e) {
                KlydeBridgeMod.LOGGER.warn("Klyde bridge send failed: {}", e.toString());
            }
        }
    }

    private void handleFrame(String raw) {
        KlydeBridgeMod.LOGGER.info("Klyde bridge received frame: {}", raw);
        JsonElement el;
        try {
            el = JsonParser.parseString(raw);
        } catch (Exception e) {
            return;
        }
        if (!el.isJsonObject()) return;
        JsonObject frame = el.getAsJsonObject();
        String type = frame.has("type") ? frame.get("type").getAsString() : "";

        switch (type) {
            case "query" -> {
                long id = frame.has("id") ? frame.get("id").getAsLong() : -1L;
                String action = frame.has("action") ? frame.get("action").getAsString() : "";
                String player = frame.has("player") && !frame.get("player").isJsonNull()
                    ? frame.get("player").getAsString() : null;
                // Game state must be read on the server thread.
                var server = mod.getServer();
                if (server == null) {
                    sendResult(id, false, "server not ready");
                    return;
                }
                server.execute(() -> {
                    JsonObject result = queryHandler.handle(action, player);
                    sendResult(id, true, result);
                });
            }
            case "ping" -> send("{\"type\":\"pong\"}");
            case "hello" -> {
                if (!frame.has("ok") || !frame.get("ok").getAsBoolean()) {
                    KlydeBridgeMod.LOGGER.warn("Klyde bridge rejected hello; closing");
                    closeSocket();
                }
            }
            default -> { /* ignore */ }
        }
    }

    private void sendResult(long id, boolean ok, Object data) {
        StringBuilder sb = new StringBuilder();
        sb.append("{\"type\":\"result\",\"id\":").append(id)
          .append(",\"ok\":").append(ok);
        if (data != null) {
            sb.append(",\"data\":").append(data);
        }
        sb.append("}");
        send(sb.toString());
    }

    private void closeSocket() {
        WebSocket ws = socket;
        socket = null;
        if (ws != null) {
            try {
                ws.sendClose(WebSocket.NORMAL_CLOSURE, "bye");
            } catch (Exception ignored) {
            }
        }
    }

    /** WebSocket listener — callbacks arrive on HttpClient threads. */
    private final class Listener implements WebSocket.Listener {
        private final StringBuilder buffer = new StringBuilder();

        @Override
        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            buffer.append(data);
            if (last) {
                String raw = buffer.toString();
                buffer.setLength(0);
                handleFrame(raw);
            }
            ws.request(1);
            return null;
        }

        @Override
        public void onOpen(WebSocket ws) {
            KlydeBridgeMod.LOGGER.info("Klyde bridge connected; sending hello");
            // Authenticate first frame.
            send("{\"type\":\"hello\",\"token\":\"" + mod.getConfig().token() + "\"}");
            ws.request(1);
            if (mod.getConfig().announce()) {
                mod.getServer().execute(() ->
                    mod.getServer().getPlayerList().broadcastSystemMessage(
                        net.minecraft.network.chat.Component.literal("[Klyde] bridge connected"),
                        false));
            }
        }

        @Override
        public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
            KlydeBridgeMod.LOGGER.info("Klyde bridge closed ({} {})", statusCode, reason);
            socket = null;
            scheduleReconnect();
            return null;
        }

        @Override
        public void onError(WebSocket ws, Throwable error) {
            KlydeBridgeMod.LOGGER.warn("Klyde bridge error: {}", error.toString());
            scheduleReconnect();
        }
    }
}
