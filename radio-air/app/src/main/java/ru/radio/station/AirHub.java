package ru.radio.station;

import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.java_websocket.WebSocket;
import org.java_websocket.WebSocketImpl;
import org.java_websocket.drafts.Draft;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.exceptions.InvalidDataException;
import org.java_websocket.framing.CloseFrame;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshakeBuilder;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONArray;
import org.json.JSONObject;

/*
 * Свой сервер эфира в телефоне — то же, что air-server.js в ПК-программе «Радио», строка в строку:
 * WebSocket /ws, те же сообщения (welcome, tune, onair, offair, station-on/off, listeners, error)
 * и те же пакеты звука (4 байта номера станции + пакет). Рации и ПК подключаются к нему,
 * как к серверу на компьютере. Ничего не записывает и звук не разбирает — только пересылает.
 */
final class AirHub extends WebSocketServer {

    interface Watcher {
        void onHubChanged();
    }

    private static final double[][] BANDS = { { 87.5, 108.0 }, { 400.0, 470.0 } }; // FM и рации (UHF)
    private static final double HEAR_RANGE = 0.5;        // МГц: дальше звук станции уже не слышен
    private static final double LISTEN_RANGE = 0.2;      // МГц: слушатель FM-станции
    private static final double LISTEN_RANGE_UHF = 0.006; // МГц: у раций каналы узкие
    private static final int MAX_FRAME = 64 * 1024;
    private static final int MAX_QUEUE = 400;            // ~512 КБ звука: клиент не успевает — пропускаем
    private static final int NAME_LEN = 24;

    private static final class Client {
        final WebSocket ws;
        double[] freqs = new double[0];
        Air st;
        int listeners = -1;

        Client(WebSocket ws) {
            this.ws = ws;
        }
    }

    private static final class Air {
        final int id;
        final Client owner;
        double freq;
        String name;
        boolean monitor;

        Air(int id, Client owner) {
            this.id = id;
            this.owner = owner;
        }

        JSONObject info() {
            JSONObject o = new JSONObject();
            try {
                o.put("id", id).put("freq", freq).put("name", name);
            } catch (Exception ignored) {
                // не бросает
            }
            return o;
        }
    }

    private final Map<WebSocket, Client> clients = new java.util.LinkedHashMap<>(); // как Set в air-server.js: по порядку подключения; только под synchronized
    private final CountDownLatch started = new CountDownLatch(1);
    private volatile Exception startError;
    private volatile Watcher watcher;
    private int nextId = 1;

    AirHub(int port) {
        super(new InetSocketAddress(port), Collections.singletonList(
            (Draft) new Draft_6455(Collections.emptyList(), MAX_FRAME)));
        // Как у Node: порт сразу снова свободен после перезапуска сервера (TIME_WAIT). Второй сервер на тот же
        // порт Linux (и Android) всё равно не пустит — эфир не разделится на два
        setReuseAddr(true);
        setConnectionLostTimeout(30);
    }

    void setWatcher(Watcher w) {
        watcher = w;
    }

    // Запустить и дождаться: либо слушаем порт, либо ошибка (порт занят и т. п.)
    void startAndWait() throws Exception {
        start();
        if (!started.await(5, TimeUnit.SECONDS)) throw new Exception("сервер не запустился");
        if (startError != null) throw startError;
    }

    synchronized int clientCount() {
        return clients.size();
    }

    synchronized int stationCount() {
        int n = 0;
        for (Client c : clients.values()) if (c.st != null) n++;
        return n;
    }

    /* ───────── Подключение ───────── */

    // Как originAllowed в air-server.js: со страницы этого же сервера или из приложения (не http/https)
    @Override
    public ServerHandshakeBuilder onWebsocketHandshakeReceivedAsServer(WebSocket conn, Draft draft, ClientHandshake request)
        throws InvalidDataException {
        ServerHandshakeBuilder builder = super.onWebsocketHandshakeReceivedAsServer(conn, draft, request);
        String path = request.getResourceDescriptor();
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        if (!"/ws".equals(path)) throw new InvalidDataException(CloseFrame.POLICY_VALIDATION, "not found");
        String origin = request.getFieldValue("Origin");
        if (origin != null && !origin.isEmpty()) {
            try {
                URI u = new URI(origin);
                String scheme = u.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    String host = u.getRawAuthority();
                    if (host == null || !host.equalsIgnoreCase(request.getFieldValue("Host"))) {
                        throw new InvalidDataException(CloseFrame.POLICY_VALIDATION, "origin");
                    }
                }
            } catch (java.net.URISyntaxException e) {
                throw new InvalidDataException(CloseFrame.POLICY_VALIDATION, "origin");
            }
        }
        return builder;
    }

    @Override
    public void onStart() {
        started.countDown();
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        synchronized (this) {
            Client c = new Client(conn);
            clients.put(conn, c);
            JSONArray list = new JSONArray();
            for (Air st : stations()) list.put(st.info());
            sendJson(c, obj("type", "welcome", "stations", list));
        }
        changed();
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        synchronized (this) {
            Client c = clients.remove(conn);
            if (c == null) return;
            if (c.st != null) offAir(c);
            updateListeners();
        }
        changed();
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        if (conn == null) { // сам сервер: не смог занять порт
            startError = ex;
            started.countDown();
        }
    }

    /* ───────── Эфир ───────── */

    @Override
    public void onMessage(WebSocket conn, String text) {
        JSONObject msg;
        try {
            msg = new JSONObject(text);
        } catch (Exception e) {
            return;
        }
        boolean stationsChanged = false;
        synchronized (this) {
            Client c = clients.get(conn);
            if (c == null) return;
            String type = msg.optString("type");
            if ("tune".equals(type)) {
                List<Double> values = new ArrayList<>();
                JSONArray arr = msg.optJSONArray("freqs");
                if (arr != null) {
                    for (int i = 0; i < arr.length() && i < 4; i++) addFreq(values, arr.opt(i));
                } else {
                    addFreq(values, msg.opt("freq"));
                }
                double[] f = new double[values.size()];
                for (int i = 0; i < f.length; i++) f[i] = values.get(i);
                c.freqs = f;
                updateListeners();
            } else if ("onair".equals(type)) {
                Double freq = parseFreq(msg.opt("freq"));
                if (freq == null) {
                    sendJson(c, obj("type", "error", "message", "Частота должна быть 87.5–108 или 400–470 МГц"));
                    return;
                }
                onAir(c, freq, cleanName(msg.opt("name")), Boolean.TRUE.equals(msg.opt("monitor")));
                stationsChanged = true;
            } else if ("offair".equals(type) && c.st != null) {
                offAir(c);
                updateListeners();
                stationsChanged = true;
            }
        }
        if (stationsChanged) changed();
    }

    // Содержимое пакета сервер не разбирает: шифрованный звук он и не может прочитать
    @Override
    public void onMessage(WebSocket conn, ByteBuffer packet) {
        List<WebSocket> to = new ArrayList<>();
        byte[] frame;
        synchronized (this) {
            Client c = clients.get(conn);
            Air st = c != null ? c.st : null;
            if (st == null || !packet.hasRemaining()) return;
            frame = new byte[4 + packet.remaining()];
            frame[0] = (byte) (st.id >>> 24);
            frame[1] = (byte) (st.id >>> 16);
            frame[2] = (byte) (st.id >>> 8);
            frame[3] = (byte) st.id;
            packet.get(frame, 4, frame.length - 4);
            for (Client o : clients.values()) {
                // Себе — только если ведущий хочет слышать свой эфир (monitor)
                if ((o == c && !st.monitor) || !hears(o, st.freq, HEAR_RANGE)) continue;
                to.add(o.ws);
            }
        }
        for (WebSocket ws : to) {
            if (!ws.isOpen()) continue;
            if (ws instanceof WebSocketImpl && ((WebSocketImpl) ws).outQueue.size() > MAX_QUEUE) continue;
            try {
                ws.send(frame);
            } catch (RuntimeException ignored) {
                // закрылся между проверкой и отправкой
            }
        }
    }

    private void onAir(Client c, double freq, String name, boolean monitor) {
        if (c.st != null) {
            c.st.freq = freq;
            c.st.name = name;
        } else {
            Air st = new Air(nextId++, c);
            st.freq = freq;
            st.name = name;
            c.st = st;
            c.listeners = -1;
        }
        c.st.monitor = monitor;
        // О своей станции владелец узнаёт из onair-ok; её звук ему — только с monitor
        broadcast(obj("type", "station-on", "station", c.st.info()), c);
        sendJson(c, obj("type", "onair-ok", "station", c.st.info()));
        updateListeners();
    }

    private void offAir(Client c) {
        Air st = c.st;
        c.st = null;
        broadcast(obj("type", "station-off", "id", st.id), c);
    }

    private void updateListeners() {
        for (Air st : stations()) {
            int count = 0;
            for (Client c : clients.values()) {
                if (c != st.owner && hears(c, st.freq, listenRange(st.freq))) count++;
            }
            if (count != st.owner.listeners) {
                st.owner.listeners = count;
                sendJson(st.owner, obj("type", "listeners", "count", count));
            }
        }
    }

    private List<Air> stations() {
        List<Air> list = new ArrayList<>();
        for (Client c : clients.values()) if (c.st != null) list.add(c.st);
        return list;
    }

    private void broadcast(JSONObject o, Client exclude) {
        String text = o.toString();
        for (Client c : clients.values()) if (c != exclude) sendText(c, text);
    }

    private void sendJson(Client c, JSONObject o) {
        sendText(c, o.toString());
    }

    private static void sendText(Client c, String text) {
        if (!c.ws.isOpen()) return;
        try {
            c.ws.send(text);
        } catch (RuntimeException ignored) {
            // закрылся
        }
    }

    private void changed() {
        Watcher w = watcher;
        if (w != null) w.onHubChanged();
    }

    /* ───────── Как в air-server.js ───────── */

    static Double parseFreq(Object value) {
        if (value == null || JSONObject.NULL.equals(value) || "".equals(value)) return null;
        double v;
        if (value instanceof Number) {
            v = ((Number) value).doubleValue();
        } else {
            try {
                v = Double.parseDouble(value.toString().trim());
            } catch (NumberFormatException e) {
                return null;
            }
        }
        double f = Math.round(v * 1e5) / 1e5;
        if (Double.isNaN(f) || Double.isInfinite(f)) return null;
        for (double[] b : BANDS) if (f >= b[0] && f <= b[1]) return f;
        return null;
    }

    private static void addFreq(List<Double> out, Object value) {
        Double f = parseFreq(value);
        if (f != null) out.add(f);
    }

    private static double listenRange(double freq) {
        return freq < 300 ? LISTEN_RANGE : LISTEN_RANGE_UHF;
    }

    private static boolean hears(Client c, double freq, double reach) {
        for (double f : c.freqs) if (Math.abs(f - freq) <= reach) return true;
        return false;
    }

    static String cleanName(Object value) {
        String raw = value == null || JSONObject.NULL.equals(value) ? "" : value.toString();
        String text = raw.replaceAll("\\p{C}", "").replaceAll("(?U)\\s+", " ").trim();
        if (text.length() > NAME_LEN) text = text.substring(0, NAME_LEN);
        return text.isEmpty() ? "БЕЗ ПОЗЫВНОГО" : text;
    }

    private static JSONObject obj(Object... kv) {
        JSONObject o = new JSONObject();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
        } catch (Exception ignored) {
            // не бросает
        }
        return o;
    }
}
