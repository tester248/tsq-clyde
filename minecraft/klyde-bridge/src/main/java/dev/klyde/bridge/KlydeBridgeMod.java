package dev.klyde.bridge;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Klyde Bridge — a thin, passive Fabric mod.
 *
 * It connects OUTBOUND to Klyde's Cloudflare worker over WebSocket (no
 * inbound ports), authenticates with the shared token, and answers targeted
 * queries (status, players, recent chat, player location) without streaming
 * bulk state. Per-player opt-out is honored server-side before any data
 * leaves the server.
 */
public final class KlydeBridgeMod implements ModInitializer {
    public static final String MOD_ID = "klyde-bridge";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    private static KlydeBridgeMod INSTANCE;

    private BridgeConfig config;
    private MinecraftServer server;
    private BridgeClient client;
    private QueryHandler queryHandler;
    private long serverStartNanos;

    public static KlydeBridgeMod get() {
        return INSTANCE;
    }

    public MinecraftServer getServer() {
        return server;
    }

    public BridgeConfig getConfig() {
        return config;
    }

    public long serverStartNanos() {
        return serverStartNanos;
    }

    @Override
    public void onInitialize() {
        INSTANCE = this;
        config = BridgeConfig.load();
        queryHandler = new QueryHandler(this);

        ServerLifecycleEvents.SERVER_STARTED.register(srv -> {
            this.server = srv;
            this.serverStartNanos = System.nanoTime();
            LOGGER.info("Klyde bridge: server started, connecting to {}", config.bridgeUrl());
            startClient();
        });

        ServerLifecycleEvents.SERVER_STOPPING.register(srv -> {
            stopClient();
            this.server = null;
        });

        // Chat capture feeds the recent_chat query (awareness only — the
        // Discord <-> in-game bridge is handled by Simple Discord Link, not
        // by Klyde).
        ServerMessageEvents.CHAT_MESSAGE.register((message, sender, params) -> {
            String player = sender != null ? sender.getName().getString() : "?";
            queryHandler.recordChat(player, message.content().getString(), System.currentTimeMillis());
        });

        LOGGER.info("Klyde bridge initialized (announce={})", config.announce());
    }

    private void startClient() {
        if (client != null) return;
        client = new BridgeClient(this);
        client.start();
    }

    private void stopClient() {
        if (client != null) {
            client.stop();
            client = null;
        }
    }
}
