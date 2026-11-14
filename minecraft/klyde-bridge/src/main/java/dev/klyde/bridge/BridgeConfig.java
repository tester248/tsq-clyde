package dev.klyde.bridge;

import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Properties;
import java.util.Set;

/**
 * Mod configuration from config/klyde-bridge.properties.
 *
 * Keys:
 *   bridge.url    — wss:// endpoint on the Cloudflare worker (required)
 *   bridge.token  — shared secret (required)
 *   announce      — true to announce in-game when the bridge connects (default false)
 *   optout.<name> — true to exclude a player from location/chat data (default off)
 */
public final class BridgeConfig {
    private final String bridgeUrl;
    private final String token;
    private final boolean announce;
    private final Set<String> optedOut;

    private BridgeConfig(String bridgeUrl, String token, boolean announce, Set<String> optedOut) {
        this.bridgeUrl = bridgeUrl;
        this.token = token;
        this.announce = announce;
        this.optedOut = optedOut;
    }

    public static BridgeConfig load() {
        String url = "";
        String token = "";
        boolean announce = false;
        Set<String> optedOut = new HashSet<>();

        Path configPath = FabricLoader.getInstance().getConfigDir().resolve("klyde-bridge.properties");
        if (Files.exists(configPath)) {
            Properties props = new Properties();
            try (var in = Files.newInputStream(configPath)) {
                props.load(in);
                url = props.getProperty("bridge.url", "").trim();
                token = props.getProperty("bridge.token", "").trim();
                announce = Boolean.parseBoolean(props.getProperty("announce", "false"));
                for (String key : props.stringPropertyNames()) {
                    if (key.startsWith("optout.") && Boolean.parseBoolean(props.getProperty(key))) {
                        optedOut.add(key.substring("optout.".length()).trim().toLowerCase());
                    }
                }
            } catch (IOException e) {
                KlydeBridgeMod.LOGGER.warn("Could not read klyde-bridge.properties", e);
            }
        } else {
            KlydeBridgeMod.LOGGER.warn(
                "klyde-bridge.properties not found at {} — bridge disabled until configured",
                configPath
            );
        }

        return new BridgeConfig(url, token, announce, optedOut);
    }

    public String bridgeUrl() {
        return bridgeUrl;
    }

    public String token() {
        return token;
    }

    public boolean announce() {
        return announce;
    }

    public boolean isUsable() {
        return !bridgeUrl.isEmpty() && !token.isEmpty();
    }

    public boolean isOptedOut(String playerName) {
        return playerName != null && optedOut.contains(playerName.toLowerCase());
    }
}
