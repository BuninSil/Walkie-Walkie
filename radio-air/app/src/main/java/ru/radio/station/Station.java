package ru.radio.station;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.LockSupport;
import org.json.JSONArray;
import org.json.JSONObject;

/*
 * Радиостанция: музыка из папки (и голос поверх) → живой эфир на FM-частоте сервера.
 * Для слушателей это обычная живая станция: рация в режиме FM (F+0) и ПК-приёмник ловят её,
 * настроившись на ту же частоту. Звук и пакеты — как у рации (см. AirPacket).
 *
 * Потоки: декодер наполняет очередь кадров музыки (с запасом ~1 с), «насос» каждые 40 мс берёт
 * кадр, подмешивает голос, шифрует при ключе и отправляет — ровно в темпе реального времени.
 */
final class Station implements AirLink.Listener {

    interface Listener {
        void onStationChanged();
    }

    static final double FM_MIN = 87.5, FM_MAX = 108.0;
    private static final int NAME_LEN = 24;
    private static final long FRAME_NS = TimeUnit.MILLISECONDS.toNanos(40);

    private static Station instance;

    static synchronized Station get(Context context) {
        if (instance == null) instance = new Station(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AirLink link = new AirLink(this);
    final OwnServer own;
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();

    // Настройки (главный поток)
    String address, name, mode;
    volatile String keyPhrase;
    double freq;
    boolean rds;
    volatile boolean monitor;
    volatile int musicLevel; // 0–100
    Uri folder;
    String folderName;

    // Состояние
    Playlist playlist = new Playlist(new java.util.ArrayList<>());
    volatile boolean onAir;
    volatile boolean mic;
    volatile int current = -1;
    volatile String nowTitle;
    volatile long positionMs, durationMs;
    volatile float level;
    int listenersCount = 0;
    String problem;
    String serverError;
    volatile AirPacket.Key key;
    boolean keyPending;
    boolean scanning;

    private final ArrayBlockingQueue<float[]> music = new ArrayBlockingQueue<>(25);
    private final ArrayBlockingQueue<short[]> voice = new ArrayBlockingQueue<>(8);
    private Thread decoderThread, pumpThread, micThread;
    private volatile int requested = -1; // трек, который выбрали вручную
    private volatile boolean skip;       // бросить текущий трек
    private String sentName;

    private Station(Context context) {
        this.context = context;
        prefs = context.getSharedPreferences("station", Context.MODE_PRIVATE);
        address = prefs.getString("address", "");
        name = prefs.getString("name", "РАДИО");
        keyPhrase = prefs.getString("key", "");
        mode = prefs.getString("mode", "loop");
        freq = Double.longBitsToDouble(prefs.getLong("freq", Double.doubleToLongBits(100.0)));
        rds = prefs.getBoolean("rds", true);
        monitor = false;
        musicLevel = prefs.getInt("music", 90);
        String f = prefs.getString("folder", null);
        folder = f == null ? null : Uri.parse(f);
        folderName = prefs.getString("folderName", null);
        own = new OwnServer(context, this::onServerChanged);
        link.setServer(currentUrl());
        deriveKey();
        rescan();
        own.resume(); // сервер был включён — поднимаем снова
    }

    // Свой сервер работает — станция на нём; иначе — на сервере по адресу
    private String currentUrl() {
        String local = own.localUrl();
        return local != null ? local : AirPacket.serverUrl(address);
    }

    private void onServerChanged() {
        String url = currentUrl();
        if (url == null ? link.url() != null : !url.equals(link.url())) {
            sentName = null;
            link.setServer(url);
        }
        // Сервер держит службу (процессор и Wi-Fi), даже когда станция не в эфире
        if (own.wanted) StationService.start(context);
        else if (!onAir) StationService.stop(context);
        changed();
    }

    void addListener(Listener l) {
        listeners.addIfAbsent(l);
    }

    void removeListener(Listener l) {
        listeners.remove(l);
    }

    private void changed() {
        main.post(() -> {
            for (Listener l : listeners) l.onStationChanged();
        });
    }

    /* ───────── Настройки ───────── */

    void setServer(String addr) {
        address = addr.trim();
        prefs.edit().putString("address", address).apply();
        serverError = null;
        String url = AirPacket.serverUrl(address);
        if (url == null && !address.isEmpty()) serverError = "неверный адрес";
        sentName = null;
        if (own.localUrl() == null) link.setServer(url); // со своим сервером станция остаётся на нём
        changed();
    }

    void setStation(String newName, double newFreq, String phrase, boolean newRds) {
        String clean = newName.replaceAll("\\p{C}", "").trim().replaceAll("\\s+", " ");
        name = clean.isEmpty() ? "РАДИО" : clean.length() > NAME_LEN ? clean.substring(0, NAME_LEN) : clean;
        freq = Math.round(Math.max(FM_MIN, Math.min(FM_MAX, newFreq)) * 10) / 10.0;
        rds = newRds;
        boolean keyChanged = !phrase.trim().equalsIgnoreCase(keyPhrase.trim());
        keyPhrase = phrase.trim();
        prefs.edit().putString("name", name).putLong("freq", Double.doubleToLongBits(freq))
            .putString("key", keyPhrase).putBoolean("rds", rds).apply();
        if (keyChanged) deriveKey();
        announce();
        changed();
    }

    void setMode(String m) {
        mode = "shuffle".equals(m) ? "shuffle" : "loop";
        prefs.edit().putString("mode", mode).apply();
        changed();
    }

    void setMusicLevel(int v) {
        musicLevel = Math.max(0, Math.min(100, v));
        prefs.edit().putInt("music", musicLevel).apply();
    }

    void setFolder(Uri uri, String displayName) {
        folder = uri;
        folderName = displayName;
        prefs.edit().putString("folder", uri.toString()).putString("folderName", displayName).apply();
        rescan();
    }

    void rescan() {
        if (folder == null) return;
        scanning = true;
        changed();
        new Thread(() -> {
            Playlist p = Playlist.scan(context, folder);
            main.post(() -> {
                playlist = p;
                scanning = false;
                if (current >= p.size()) current = -1;
                changed();
            });
        }, "playlist-scan").start();
    }

    // Ключ канала считается ~1 с; пока он не готов, в эфир ничего не уходит (открыто — тоже)
    private void deriveKey() {
        key = null;
        String phrase = keyPhrase;
        if (phrase.isEmpty()) {
            keyPending = false;
            return;
        }
        keyPending = true;
        new Thread(() -> {
            try {
                AirPacket.Key k = AirPacket.deriveKey(phrase);
                main.post(() -> {
                    if (phrase.equals(keyPhrase)) {
                        key = k;
                        keyPending = false;
                        changed();
                    }
                });
            } catch (Exception e) {
                main.post(() -> keyPending = false);
            }
        }, "air-key").start();
    }

    /* ───────── Эфир ───────── */

    // Как станцию видят слушатели: позывной или (с RDS) название трека
    private String airName() {
        String t = rds && nowTitle != null ? name + " · " + nowTitle : name;
        return t.length() > NAME_LEN ? t.substring(0, NAME_LEN) : t;
    }

    private void announce() {
        if (!onAir || !link.online()) return;
        String n = airName();
        try {
            JSONObject msg = new JSONObject().put("type", "onair").put("freq", freq).put("name", n);
            link.send(msg);
            sentName = n;
        } catch (Exception ignored) {
            // JSONObject.put не бросает для этих значений
        }
    }

    boolean start() {
        if (onAir) return true;
        if (playlist.size() == 0 && !mic) {
            problem = folder == null ? "Выберите папку с музыкой" : "В папке нет музыки";
            changed();
            return false;
        }
        problem = null;
        onAir = true;
        music.clear();
        StationService.start(context);
        decoderThread = new Thread(this::decodeLoop, "station-decoder");
        pumpThread = new Thread(this::pumpLoop, "station-pump");
        pumpThread.setPriority(Thread.MAX_PRIORITY);
        decoderThread.start();
        pumpThread.start();
        announce();
        changed();
        return true;
    }

    void stop() {
        if (!onAir) return;
        onAir = false;
        setMic(false);
        if (decoderThread != null) decoderThread.interrupt();
        if (pumpThread != null) pumpThread.interrupt();
        decoderThread = pumpThread = null;
        music.clear();
        try {
            link.send(new JSONObject().put("type", "offair"));
        } catch (Exception ignored) {
            // не бросает
        }
        sentName = null;
        listenersCount = 0;
        level = 0;
        if (!own.wanted) StationService.stop(context); // свой сервер работает и без эфира
        else StationService.start(context);            // обновить уведомление
        changed();
    }

    void next() {
        skip = true;
        music.clear();
    }

    void play(int index) {
        if (index < 0 || index >= playlist.size()) return;
        requested = index;
        if (onAir) next();
        else start();
    }

    private void decodeLoop() {
        int failures = 0;
        while (onAir && !Thread.currentThread().isInterrupted()) {
            Playlist p = playlist;
            if (p.size() == 0) {
                SystemClock.sleep(500);
                continue;
            }
            int idx = requested >= 0 && requested < p.size() ? requested : p.next(current, "shuffle".equals(mode));
            requested = -1;
            if ("shuffle".equals(mode)) p.played(idx);
            Playlist.Track t = p.tracks.get(idx);
            current = idx;
            nowTitle = t.title;
            positionMs = 0;
            durationMs = 0;
            skip = false;
            main.post(() -> {
                if (onAir && sentName != null && !sentName.equals(airName())) announce();
                changed();
            });
            TrackDecoder dec = new TrackDecoder();
            try {
                dec.play(context, t.uri, (samples) -> {
                    durationMs = dec.durationUs / 1000;
                    while (onAir && !skip) {
                        if (music.offer(samples, 100, TimeUnit.MILLISECONDS)) {
                            positionMs = Math.max(0, dec.producedSamples * 1000L / AirPacket.RATE - music.size() * 40L);
                            return true;
                        }
                    }
                    return false;
                });
                failures = 0;
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                // Файл не читается — пропускаем; если не читается ничего, не крутимся впустую
                if (++failures >= Math.min(5, p.size())) {
                    main.post(() -> {
                        problem = "Не удаётся прочитать треки из папки";
                        changed();
                    });
                    SystemClock.sleep(2000);
                }
            }
        }
    }

    private void pumpLoop() {
        long next = System.nanoTime();
        float duck = 1;
        AudioTrack out = null;
        short[] pcm = new short[AirPacket.CHUNK];
        int frames = 0;
        try {
            while (onAir && !Thread.currentThread().isInterrupted()) {
                long wait = next - System.nanoTime();
                if (wait > 0) LockSupport.parkNanos(wait);
                if (Thread.interrupted()) break;
                long now = System.nanoTime();
                if (now - next > 5 * FRAME_NS) next = now; // телефон «проспал» — не догоняем пачкой
                next += FRAME_NS;

                float[] m = music.poll();
                short[] v = mic ? voice.poll() : null;
                float target = (mic ? 0.2f : 1f) * musicLevel / 100f;
                float peak = 0;
                for (int i = 0; i < pcm.length; i++) {
                    duck += (target - duck) * 0.004f; // плавно приглушаем музыку под голос
                    float s = (m != null ? m[i] * duck : 0) + (v != null ? v[i] / 32768f * 1.6f : 0);
                    s = Math.max(-1f, Math.min(1f, s));
                    peak = Math.max(peak, Math.abs(s));
                    pcm[i] = (short) (s < 0 ? s * 32768 : s * 32767);
                }
                level = Math.max(peak, level * 0.85f);

                AirPacket.Key k = key;
                if (keyPhrase.isEmpty()) {
                    link.sendAudio(AirPacket.open(pcm));
                } else if (k != null) {
                    link.sendAudio(AirPacket.seal(k, pcm));
                } // ключ ещё считается — открыто не отправляем

                if (monitor) {
                    if (out == null) out = monitorTrack();
                    out.write(pcm, 0, pcm.length, AudioTrack.WRITE_NON_BLOCKING);
                } else if (out != null) {
                    out.release();
                    out = null;
                }
                if (m != null && ++frames % 25 == 0) changed(); // раз в секунду — позиция трека
            }
        } catch (Exception e) {
            main.post(() -> {
                problem = "Ошибка эфира: " + e.getMessage();
                stop();
            });
        } finally {
            if (out != null) out.release();
        }
    }

    // «Слышать себя»: то, что уходит в эфир, — в наушники
    private static AudioTrack monitorTrack() {
        int size = Math.max(AudioTrack.getMinBufferSize(AirPacket.RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT),
            AirPacket.CHUNK * 2 * 6);
        AudioTrack t = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(new AudioFormat.Builder()
                .setSampleRate(AirPacket.RATE)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(size)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build();
        t.play();
        return t;
    }

    void setMonitor(boolean on) {
        monitor = on;
        changed();
    }

    /* ───────── Голос поверх музыки ───────── */

    boolean setMic(boolean on) {
        if (on == mic) return true;
        if (on && context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false;
        mic = on;
        if (on) {
            voice.clear();
            micThread = new Thread(this::micLoop, "station-mic");
            micThread.start();
            if (!onAir) start();
        } else if (micThread != null) {
            micThread.interrupt();
            micThread = null;
        }
        changed();
        return true;
    }

    @SuppressWarnings("MissingPermission")
    private void micLoop() {
        int size = Math.max(AudioRecord.getMinBufferSize(AirPacket.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT),
            AirPacket.CHUNK * 2 * 4);
        AudioRecord rec;
        try {
            rec = new AudioRecord(MediaRecorder.AudioSource.MIC, AirPacket.RATE, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, size);
            rec.startRecording();
        } catch (RuntimeException e) {
            main.post(() -> {
                problem = "Микрофон недоступен";
                setMic(false);
            });
            return;
        }
        try {
            while (mic && !Thread.currentThread().isInterrupted()) {
                short[] buf = new short[AirPacket.CHUNK];
                int got = 0;
                while (got < buf.length && mic) {
                    int n = rec.read(buf, got, buf.length - got);
                    if (n <= 0) break;
                    got += n;
                }
                if (!voice.offer(buf)) {
                    voice.poll(); // насос отстал — выбрасываем самое старое, чтобы голос не запаздывал
                    voice.offer(buf);
                }
            }
        } finally {
            rec.stop();
            rec.release();
        }
    }

    /* ───────── Связь с сервером ───────── */

    @Override
    public void onLink(boolean online, String why) {
        serverError = online ? null : why;
        if (online) {
            sentName = null;
            announce();
        } else {
            listenersCount = 0;
        }
        changed();
    }

    @Override
    public void onMessage(JSONObject msg) {
        switch (msg.optString("type")) {
            case "listeners":
                listenersCount = msg.optInt("count");
                changed();
                break;
            case "error":
                problem = msg.optString("message");
                changed();
                break;
            default:
                break;
        }
    }

    /* ───────── Для экрана и уведомления ───────── */

    String freqText() {
        return String.format(Locale.US, "%.1f", freq);
    }

    boolean linkOnline() {
        return link.online();
    }

    JSONObject state() {
        JSONObject o = new JSONObject();
        try {
            o.put("address", address).put("online", link.online()).put("serverError", serverError)
                .put("name", name).put("freq", freq).put("key", keyPhrase).put("keyPending", keyPending)
                .put("rds", rds).put("monitor", monitor).put("music", musicLevel).put("mode", mode)
                .put("folder", folderName).put("scanning", scanning).put("count", playlist.size())
                .put("onAir", onAir).put("mic", mic).put("listeners", listenersCount).put("problem", problem)
                .put("current", current).put("title", nowTitle).put("position", positionMs).put("duration", durationMs)
                .put("level", (double) level).put("airName", airName())
                .put("version", BuildConfig.VERSION_NAME).put("host", own.state());
        } catch (Exception ignored) {
            // не бросает
        }
        return o;
    }

    JSONArray titles() {
        JSONArray a = new JSONArray();
        for (Playlist.Track t : playlist.tracks) a.put(t.title);
        return a;
    }
}
