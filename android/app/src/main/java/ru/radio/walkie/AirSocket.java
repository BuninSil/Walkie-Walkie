package ru.radio.walkie;

import android.app.Activity;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.net.UnknownServiceException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLException;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/*
 * WebSocket к серверу эфира — из Java, а не из WebView.
 * Сервер эфира пускает только свою страницу или приложение (Origin не http/https). Страница в
 * WebView — это https://appassets.androidplatform.net, её сервер отклонил бы. Поэтому соединение
 * открывается здесь с тем же Origin, что у ПК-рации в Electron (app://radio): для сервера телефон —
 * такой же клиент, как рация на ПК. Страница видит обычный WebSocket (см. android/bridge.js).
 *
 * В страницу: window.__airSocket({ id, type: open | text | binary | close, data?, code? }), двоичное — в base64.
 */
public class AirSocket {

    private static final String PC_ORIGIN = "app://radio";

    private final Activity activity;
    private final WebView web;
    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build();
    private final Map<Integer, WebSocket> sockets = new ConcurrentHashMap<>();
    private volatile String lastProblem = null; // чтобы не повторять одно и то же сообщение при каждой попытке

    AirSocket(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    @JavascriptInterface
    public void open(int id, String url) {
        Request request;
        try {
            request = new Request.Builder().url(url).header("Origin", PC_ORIGIN).build();
        } catch (IllegalArgumentException e) {
            problem(url, "неверный адрес");
            emit(id, "close", null, 1006);
            return;
        }
        WebSocket ws = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                lastProblem = null;
                emit(id, "open", null, 0);
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                emit(id, "text", text, 0);
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                emit(id, "binary", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP), 0);
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(1000, null);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                if (sockets.remove(id) != null) emit(id, "close", null, code);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                if (sockets.remove(id) == null) return;
                problem(url, describe(t, response));
                emit(id, "close", null, 1006);
            }
        });
        sockets.put(id, ws);
    }

    @JavascriptInterface
    public long sendText(int id, String text) {
        WebSocket ws = sockets.get(id);
        if (ws == null) return 0;
        ws.send(text);
        return ws.queueSize();
    }

    @JavascriptInterface
    public long sendBinary(int id, String base64) {
        WebSocket ws = sockets.get(id);
        if (ws == null) return 0;
        ws.send(ByteString.of(Base64.decode(base64, Base64.NO_WRAP)));
        return ws.queueSize();
    }

    @JavascriptInterface
    public void close(int id) {
        WebSocket ws = sockets.remove(id);
        if (ws == null) return;
        ws.close(1000, null);
        emit(id, "close", null, 1000);
    }

    void closeAll() {
        for (WebSocket ws : sockets.values()) ws.cancel();
        sockets.clear();
    }

    private void emit(int id, String type, String data, int code) {
        StringBuilder js = new StringBuilder("window.__airSocket&&window.__airSocket({id:").append(id)
            .append(",type:'").append(type).append('\'');
        if (data != null) js.append(",data:").append(JSONObject.quote(data));
        if (code != 0) js.append(",code:").append(code);
        js.append("})");
        web.post(() -> web.evaluateJavascript(js.toString(), null));
    }

    // Рация на экране пишет только «нет связи» — причину показываем сообщением Android, один раз
    private void problem(String url, String what) {
        String text = "Рация: нет связи с " + url.replaceFirst("^wss?://", "").replaceFirst("/ws$", "") + " — " + what;
        if (text.equals(lastProblem)) return;
        lastProblem = text;
        activity.runOnUiThread(() -> Toast.makeText(activity, text, Toast.LENGTH_LONG).show());
    }

    private static String describe(Throwable t, Response response) {
        if (response != null) {
            int code = response.code();
            if (code == 403) return "сервер отказал (403)";
            if (code == 404) return "по этому адресу нет сервера эфира (404)";
            return "ответ сервера " + code;
        }
        if (t instanceof UnknownHostException) return "адрес не найден";
        if (t instanceof SocketTimeoutException) return "сервер не отвечает";
        if (t instanceof ConnectException) return "порт закрыт или сервер выключен";
        if (t instanceof NoRouteToHostException) return "нет маршрута до сервера";
        if (t instanceof SSLException) return "ошибка HTTPS";
        if (t instanceof UnknownServiceException) return "HTTP запрещён";
        String m = t.getMessage();
        return m != null ? m : t.getClass().getSimpleName();
    }
}
