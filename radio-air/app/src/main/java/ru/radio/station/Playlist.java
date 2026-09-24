package ru.radio.station;

import android.content.Context;
import android.net.Uri;
import androidx.documentfile.provider.DocumentFile;
import java.text.Collator;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Random;

/*
 * Музыка из папки, которую выбрали в приложении (со всеми вложенными папками).
 * Порядок — по алфавиту, как в проводнике; «Случайно» — без повторов, пока не сыграют все треки.
 */
final class Playlist {

    static final class Track {
        final Uri uri;
        final String title;

        Track(Uri uri, String title) {
            this.uri = uri;
            this.title = title;
        }
    }

    private static final String[] AUDIO = { ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".wav", ".wma", ".3gp", ".mka" };

    final List<Track> tracks;
    private final List<Integer> bag = new ArrayList<>();
    private final Random random = new Random();

    Playlist(List<Track> tracks) {
        this.tracks = tracks;
    }

    static Playlist scan(Context context, Uri tree) {
        List<Track> found = new ArrayList<>();
        DocumentFile root = tree == null ? null : DocumentFile.fromTreeUri(context, tree);
        if (root != null && root.canRead()) walk(root, found, 0);
        Collator collator = Collator.getInstance(new Locale("ru"));
        Collections.sort(found, (a, b) -> collator.compare(a.title, b.title));
        return new Playlist(found);
    }

    private static void walk(DocumentFile dir, List<Track> out, int depth) {
        if (depth > 6) return;
        for (DocumentFile f : dir.listFiles()) {
            String name = f.getName();
            if (name == null || name.startsWith(".")) continue;
            if (f.isDirectory()) {
                walk(f, out, depth + 1);
            } else if (isAudio(name, f.getType())) {
                int dot = name.lastIndexOf('.');
                out.add(new Track(f.getUri(), dot > 0 ? name.substring(0, dot) : name));
            }
        }
    }

    private static boolean isAudio(String name, String mime) {
        if (mime != null && mime.startsWith("audio/")) return true;
        String lower = name.toLowerCase(Locale.ROOT);
        for (String ext : AUDIO) if (lower.endsWith(ext)) return true;
        return false;
    }

    int size() {
        return tracks.size();
    }

    // Следующий трек после current (-1 — первый)
    int next(int current, boolean shuffle) {
        int n = tracks.size();
        if (n == 0) return -1;
        if (!shuffle) return (current + 1) % n;
        if (bag.isEmpty()) {
            for (int i = 0; i < n; i++) if (i != current || n == 1) bag.add(i);
            Collections.shuffle(bag, random);
        }
        return bag.remove(bag.size() - 1);
    }

    void played(int index) {
        bag.remove(Integer.valueOf(index));
    }
}
