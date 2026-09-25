package ru.radio.walkie;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.json.JSONArray;
import org.json.JSONObject;

/*
 * Что сейчас происходит в эфире — для уведомления и кнопки поверх приложений.
 * Ничего не решает и ни во что не вмешивается: только смотрит на трафик AirSocket.
 *   • на связи — открыто соединение с сервером;
 *   • приём — сервер присылает звук (он шлёт его только тем, кто настроен на частоту станции);
 *   • передача — страница отправляет звук;
 *   • частота и позывной — из сообщений tune / onair, которые рация шлёт серверу.
 */
public final class AirState {

    public interface Listener {
        void onAirChanged();
    }

    private static final long AUDIO_HOLD_MS = 450; // звук пропал на столько — приём/передача закончились

    public static volatile boolean online = false;
    public static volatile String server = null;
    public static volatile double freq = 0;
    public static volatile String callsign = null;
    public static volatile String rxName = null;

    private static volatile long lastRx = 0;
    private static volatile long lastTx = 0;
    private static final Map<Long, String> stations = new ConcurrentHashMap<>();
    private static final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final Runnable settle = AirState::changed;

    private AirState() {}

    public static boolean receiving() {
        return SystemClock.uptimeMillis() - lastRx < AUDIO_HOLD_MS;
    }

    public static boolean transmitting() {
        return SystemClock.uptimeMillis() - lastTx < AUDIO_HOLD_MS;
    }

    public static void addListener(Listener l) {
        listeners.addIfAbsent(l);
    }

    public static void removeListener(Listener l) {
        listeners.remove(l);
    }

    static void connected(String url, boolean on) {
        boolean was = online;
        online = on;
        server = url.replaceFirst("^wss?://", "").replaceFirst("/ws$", "");
        if (!on) {
            stations.clear();
            rxName = null;
        }
        if (was != on) post();
    }

    static void incomingText(String text) {
        try {
            JSONObject msg = new JSONObject(text);
            switch (msg.optString("type")) {
                case "welcome":
                    stations.clear();
                    JSONArray list = msg.optJSONArray("stations");
                    for (int i = 0; list != null && i < list.length(); i++) remember(list.optJSONObject(i));
                    break;
                case "station-on":
                    remember(msg.optJSONObject("station"));
                    break;
                case "station-off":
                    stations.remove(msg.optLong("id"));
                    break;
                default:
                    break;
            }
        } catch (Exception ignored) {
            // не JSON — не наше дело
        }
    }

    static void outgoingText(String text) {
        try {
            JSONObject msg = new JSONObject(text);
            String type = msg.optString("type");
            if ("tune".equals(type) && !msg.isNull("freq")) {
                freq = msg.optDouble("freq", freq);
                post();
            } else if ("onair".equals(type)) {
                callsign = msg.optString("name", callsign);
                post();
            }
        } catch (Exception ignored) {
            // не JSON — не наше дело
        }
    }

    static void incomingAudio(long stationId) {
        boolean was = receiving();
        lastRx = SystemClock.uptimeMillis();
        String name = stations.get(stationId);
        if (!was || (name != null && !name.equals(rxName))) {
            rxName = name;
            post();
        }
        schedule();
    }

    static void outgoingAudio() {
        boolean was = transmitting();
        lastTx = SystemClock.uptimeMillis();
        if (!was) post();
        schedule();
    }

    private static void remember(JSONObject st) {
        if (st != null) stations.put(st.optLong("id"), st.optString("name", "?"));
    }

    // Через AUDIO_HOLD_MS после последнего пакета — ещё раз оповестить: приём или передача закончились
    private static void schedule() {
        main.removeCallbacks(settle);
        main.postDelayed(settle, AUDIO_HOLD_MS + 50);
    }

    private static void post() {
        main.post(AirState::changed);
    }

    private static void changed() {
        for (Listener l : listeners) l.onAirChanged();
    }

    // «446.00625 · PMR 1» — как пишет рация
    public static String channelText() {
        if (freq <= 0) return null;
        String f = String.format(java.util.Locale.US, "%.5f", freq).replaceAll("(\\.\\d{3}\\d*?)0+$", "$1");
        for (int i = 0; i < 16; i++) {
            if (Math.abs(freq - (446.00625 + i * 0.0125)) < 1e-6) return f + " · PMR " + (i + 1);
        }
        for (int i = 0; i < 69; i++) {
            if (Math.abs(freq - (433.075 + i * 0.025)) < 1e-6) return f + " · LPD " + (i + 1);
        }
        return freq < 300 ? String.format(java.util.Locale.US, "FM %.1f", freq) : f + " МГц";
    }
}
