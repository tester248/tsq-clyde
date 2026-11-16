package dev.klyde.bridge;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

/**
 * Per-player preferences (config/klyde-preferences.json):
 *
 *   privacy      — true = opt out of sharing location/chat data with Klyde
 *   showProgress  — false = hide Klyde's progress (thinking/working) messages
 *   showMessages  — false = hide all Klyde messages for this player
 *
 * Share-by-default: privacy defaults to false. All entries default to visible.
 */
public final class Preferences {
    public static final class PlayerPrefs {
        public boolean privacy = false;
        public boolean showProgress = true;
        public boolean showMessages = true;
    }

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    private final Path path;
    private final Map<String, PlayerPrefs> players = new HashMap<>();

    public Preferences() {
        this.path = FabricLoader.getInstance().getConfigDir().resolve("klyde-preferences.json");
        load();
    }

    private synchronized void load() {
        if (!Files.exists(path)) return;
        try (var in = Files.newBufferedReader(path)) {
            Map<String, PlayerPrefs> parsed = GSON.fromJson(in, new com.google.gson.reflect.TypeToken<Map<String, PlayerPrefs>>() {}.getType());
            if (parsed != null) {
                players.clear();
                players.putAll(parsed);
            }
        } catch (IOException e) {
            KlydeBridgeMod.LOGGER.warn("Could not read klyde-preferences.json", e);
        }
    }

    private synchronized void save() {
        try {
            Files.writeString(path, GSON.toJson(players));
        } catch (IOException e) {
            KlydeBridgeMod.LOGGER.warn("Could not write klyde-preferences.json", e);
        }
    }

    private String key(String player) {
        return player == null ? "" : player.toLowerCase();
    }

    private PlayerPrefs prefs(String player) {
        return players.computeIfAbsent(key(player), k -> new PlayerPrefs());
    }

    public synchronized boolean isPrivate(String player) {
        return prefs(player).privacy;
    }

    public synchronized void setPrivacy(String player, boolean on) {
        prefs(player).privacy = on;
        save();
    }

    public synchronized boolean getShowProgress(String player) {
        return prefs(player).showProgress;
    }

    public synchronized void setShowProgress(String player, boolean on) {
        prefs(player).showProgress = on;
        save();
    }

    public synchronized boolean getShowMessages(String player) {
        return prefs(player).showMessages;
    }

    public synchronized void setShowMessages(String player, boolean on) {
        prefs(player).showMessages = on;
        save();
    }
}
