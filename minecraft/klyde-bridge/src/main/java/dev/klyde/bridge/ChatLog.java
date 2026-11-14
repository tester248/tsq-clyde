package dev.klyde.bridge;

import java.util.ArrayDeque;
import java.util.List;

/** Small bounded ring buffer of recent chat messages (server-side). */
final class ChatLog {
    record Entry(String player, String text, long ts) {}

    private final int limit;
    private final ArrayDeque<Entry> entries = new ArrayDeque<>();

    ChatLog(int limit) {
        this.limit = limit;
    }

    synchronized void push(String player, String text, long ts) {
        entries.addLast(new Entry(player, text, ts));
        while (entries.size() > limit) {
            entries.removeFirst();
        }
    }

    synchronized List<Entry> entries() {
        return List.copyOf(entries);
    }
}
