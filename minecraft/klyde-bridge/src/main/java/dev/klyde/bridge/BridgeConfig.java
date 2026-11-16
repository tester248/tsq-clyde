package dev.klyde.bridge;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;

import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.ChatFormatting;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Mod configuration from config/klyde-bridge.json (Gson — no YAML dep).
 *
 * Keys:
 *   bridge.url   — https:// endpoint on the Cloudflare worker (required)
 *   bridge.token  — shared secret (required)
 *   announce      — true to announce in-game when the bridge connects (default false)
 *   color         — chat color for Klyde messages (default "dark_blue")
 *
 * On first boot a default JSON template is written. If a legacy
 * config/klyde-bridge.properties exists, its values are migrated once.
 */
public final class BridgeConfig {
    private String bridgeUrl = "";
    private String token = "";
    private boolean announce = false;
    private String color = "dark_blue";

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    private BridgeConfig() {}

    public static BridgeConfig load() {
        BridgeConfig config = new BridgeConfig();
        Path path = FabricLoader.getInstance().getConfigDir().resolve("klyde-bridge.json");
        if (Files.exists(path)) {
            try (var in = Files.newBufferedReader(path)) {
                BridgeConfig parsed = GSON.fromJson(in, BridgeConfig.class);
                if (parsed != null) config = parsed;
            } catch (IOException e) {
                KlydeBridgeMod.LOGGER.warn("Could not read klyde-bridge.json", e);
            }
        } else {
            migrateFromPropertiesIfPresent(path, config);
            if (!Files.exists(path)) {
                try {
                    Files.writeString(path, GSON.toJson(config));
                    KlydeBridgeMod.LOGGER.info(
                        "Created default config at {} — edit bridge.url / bridge.token and restart",
                        path);
                } catch (IOException e) {
                    KlydeBridgeMod.LOGGER.warn("Could not write default klyde-bridge.json", e);
                }
            }
        }
        return config;
    }

    private static void migrateFromPropertiesIfPresent(Path jsonPath, BridgeConfig config) {
        Path propsPath = FabricLoader.getInstance().getConfigDir().resolve("klyde-bridge.properties");
        if (!Files.exists(propsPath)) return;
        try {
            var props = new java.util.Properties();
            try (var in = Files.newInputStream(propsPath)) {
                props.load(in);
            }
            config.bridgeUrl = props.getProperty("bridge.url", "").trim();
            config.token = props.getProperty("bridge.token", "").trim();
            config.announce = Boolean.parseBoolean(props.getProperty("announce", "false"));
            String opt = props.getProperty("color", "").trim();
            if (!opt.isEmpty()) config.color = opt;
            // Keep the legacy file but rename to .bak so this runs once.
            Files.move(propsPath, propsPath.resolveSibling("klyde-bridge.properties.bak"));
            Files.writeString(jsonPath, GSON.toJson(config));
            KlydeBridgeMod.LOGGER.info("Migrated klyde-bridge.properties -> klyde-bridge.json");
        } catch (IOException e) {
            KlydeBridgeMod.LOGGER.warn("Legacy properties migration failed", e);
        }
    }

    public String bridgeUrl() { return bridgeUrl; }
    public String token() { return token; }
    public boolean announce() { return announce; }
    public String colorName() { return color; }

    public boolean isUsable() {
        return !bridgeUrl.isEmpty() && !token.isEmpty();
    }

    /** Resolve the configured color name to a ChatFormatting (default dark blue). */
    public ChatFormatting chatColor() {
        switch (color == null ? "" : color.trim().toLowerCase()) {
            case "black": return ChatFormatting.BLACK;
            case "dark_blue": return ChatFormatting.DARK_BLUE;
            case "dark_green": return ChatFormatting.DARK_GREEN;
            case "dark_aqua": return ChatFormatting.DARK_AQUA;
            case "dark_red": return ChatFormatting.DARK_RED;
            case "dark_purple": return ChatFormatting.DARK_PURPLE;
            case "gold": return ChatFormatting.GOLD;
            case "gray": return ChatFormatting.GRAY;
            case "dark_gray": return ChatFormatting.DARK_GRAY;
            case "blue": return ChatFormatting.BLUE;
            case "green": return ChatFormatting.GREEN;
            case "aqua": return ChatFormatting.AQUA;
            case "red": return ChatFormatting.RED;
            case "light_purple": return ChatFormatting.LIGHT_PURPLE;
            case "yellow": return ChatFormatting.YELLOW;
            case "white": return ChatFormatting.WHITE;
            default: return ChatFormatting.DARK_BLUE;
        }
    }
}
