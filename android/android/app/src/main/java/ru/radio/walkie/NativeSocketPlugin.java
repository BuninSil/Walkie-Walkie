package ru.radio.walkie;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/*
 * Связь с сервером эфира из Java, а не из WebView.
 * WebView подписывает соединение заголовком Origin: http://localhost, и серверы эфира, которые
 * пускают только свою страницу (все, кроме самых новых), такое соединение отклоняют.
 * Отсюда соединение уходит без Origin — как у приложения на ПК, — и его пускает любой сервер.
 *
 * События в страницу: { id, type: open | text | binary | close, data?, code? }; двоичное — в base64.
 */
@CapacitorPlugin(name = "NativeSocket")
public class NativeSocketPlugin extends Plugin {

    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build();
    private final Map<Integer, WebSocket> sockets = new ConcurrentHashMap<>();

    @PluginMethod
    public void connect(PluginCall call) {
        Integer id = call.getInt("id");
        String url = call.getString("url");
        if (id == null || url == null) {
            call.reject("id и url обязательны");
            return;
        }
        Request request;
        try {
            request = new Request.Builder().url(url).build();
        } catch (IllegalArgumentException e) {
            call.reject("Плохой адрес: " + url);
            return;
        }
        WebSocket ws = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
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
                if (sockets.remove(id) != null) emit(id, "close", null, 1006);
            }
        });
        sockets.put(id, ws);
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        WebSocket ws = sockets.get(call.getInt("id", -1));
        JSObject ret = new JSObject();
        if (ws != null) {
            String text = call.getString("text");
            String binary = call.getString("binary");
            if (text != null) ws.send(text);
            else if (binary != null) ws.send(ByteString.of(Base64.decode(binary, Base64.NO_WRAP)));
            ret.put("queued", ws.queueSize());
        } else {
            ret.put("queued", 0);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void close(PluginCall call) {
        int id = call.getInt("id", -1);
        WebSocket ws = sockets.remove(id);
        if (ws != null) {
            ws.close(1000, null);
            emit(id, "close", null, 1000);
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (WebSocket ws : sockets.values()) ws.cancel();
        sockets.clear();
    }

    private void emit(int id, String type, String data, int code) {
        JSObject event = new JSObject();
        event.put("id", id);
        event.put("type", type);
        if (data != null) event.put("data", data);
        if (code != 0) event.put("code", code);
        notifyListeners("socket", event);
    }
}
