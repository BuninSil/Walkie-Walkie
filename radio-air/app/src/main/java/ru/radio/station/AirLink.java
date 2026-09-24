package ru.radio.station;

import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/*
 * Связь с сервером эфира — тот же протокол, что у рации (link.js, air-server.js):
 * WebSocket /ws, JSON-сообщения и двоичные пакеты звука. Для сервера станция — такой же клиент,
 * как ПК-рация (Origin: app://radio). Обрыв — переподключение с растущей паузой, до 10 с.
 */
final class AirLink {

    interface Listener {
        void onLink(boolean online, String problem);
        void onMessage(JSONObject msg);
    }

    private static final String PC_ORIGIN = "app://radio";
    private static final long MAX_QUEUE = 128 * 1024; // сеть не успевает — пакет звука пропускаем

    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build();
    private final Listener listener;
    private final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());
    private volatile WebSocket ws;
    private volatile boolean online;
    private String url;
    private int retry;
    private final Runnable reconnect = this::connect;

    AirLink(Listener listener) {
        this.listener = listener;
    }

    boolean online() {
        return online;
    }

    String url() {
        return url;
    }

    // Главный поток. null — отключиться
    void setServer(String newUrl) {
        handler.removeCallbacks(reconnect);
        WebSocket old = ws;
        ws = null;
        url = newUrl;
        retry = 0;
        if (old != null) old.cancel();
        if (online) {
            online = false;
            listener.onLink(false, null);
        }
        connect();
    }

    private void connect() {
        if (url == null) return;
        Request request;
        try {
            request = new Request.Builder().url(url).header("Origin", PC_ORIGIN).build();
        } catch (IllegalArgumentException e) {
            listener.onLink(false, "неверный адрес");
            return;
        }
        WebSocket[] self = new WebSocket[1];
        self[0] = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                handler.post(() -> {
                    if (ws != self[0]) return;
                    online = true;
                    retry = 0;
                    listener.onLink(true, null);
                });
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                JSONObject msg;
                try {
                    msg = new JSONObject(text);
                } catch (Exception e) {
                    return;
                }
                handler.post(() -> {
                    if (ws == self[0]) listener.onMessage(msg);
                });
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                // звук чужих станций станции не нужен
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(1000, null);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                handler.post(() -> lost(self[0], null));
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                String why = describe(t, response);
                handler.post(() -> lost(self[0], why));
            }
        });
        ws = self[0];
    }

    private void lost(WebSocket which, String problem) {
        if (ws != which) return; // старое соединение — уже переключились
        ws = null;
        online = false;
        listener.onLink(false, problem);
        long delay = Math.min(10000, 500L << Math.min(retry++, 5));
        handler.postDelayed(reconnect, delay);
    }

    void send(JSONObject msg) {
        WebSocket w = ws;
        if (online && w != null) w.send(msg.toString());
    }

    // С любого потока
    void sendAudio(byte[] packet) {
        WebSocket w = ws;
        if (online && w != null && w.queueSize() < MAX_QUEUE) w.send(ByteString.of(packet));
    }

    static String describe(Throwable t, Response response) {
        if (response != null) {
            int code = response.code();
            if (code == 403) return "сервер отказал (403)";
            if (code == 404) return "по этому адресу нет сервера эфира";
            return "ответ сервера " + code;
        }
        if (t instanceof java.net.UnknownHostException) return "адрес не найден";
        if (t instanceof java.net.SocketTimeoutException) return "сервер не отвечает";
        if (t instanceof java.net.ConnectException) return "порт закрыт или сервер выключен";
        if (t instanceof java.net.NoRouteToHostException) return "нет маршрута до сервера";
        if (t instanceof javax.net.ssl.SSLException) return "ошибка HTTPS";
        String m = t.getMessage();
        if (m != null && m.contains("connection abort")) return "соединение оборвано (на мобильном интернете нужен VPN)";
        return m != null ? m : t.getClass().getSimpleName();
    }
}
