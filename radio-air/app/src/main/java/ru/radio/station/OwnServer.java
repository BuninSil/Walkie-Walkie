package ru.radio.station;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/*
 * «Свой сервер» станции: сервер эфира прямо в телефоне (AirHub), как кнопка HOST в ПК-программе.
 * К нему подключаются рации и ПК — по адресу телефона в Wi-Fi, а если роутер открыл порт по UPnP —
 * и из интернета. Станция сама подключается к нему же (127.0.0.1). Включённый сервер
 * запоминается и поднимается снова при запуске приложения.
 */
final class OwnServer implements AirHub.Watcher {

    interface Listener {
        void onServerChanged();
    }

    static final int DEFAULT_PORT = 8765;

    private final Context context;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private final Listener listener;
    private final Runnable renew = new Runnable() {
        @Override
        public void run() {
            PortMapper m = mapper;
            if (m != null) work.execute(m::renew);
            main.postDelayed(this, 3600_000L);
        }
    };

    // Главный поток
    boolean wanted;       // включён пользователем
    boolean running;      // слушает порт
    boolean starting;
    int port;
    boolean upnpWanted;
    String error;
    String upnpState = "off"; // off | trying | ok | fail
    String upnpError;
    String externalIp;
    List<String> lan = java.util.Collections.emptyList();

    private AirHub hub;
    private PortMapper mapper;

    OwnServer(Context context, Listener listener) {
        this.context = context;
        this.listener = listener;
        prefs = context.getSharedPreferences("station", Context.MODE_PRIVATE);
        wanted = prefs.getBoolean("host", false);
        port = prefs.getInt("hostPort", DEFAULT_PORT);
        upnpWanted = prefs.getBoolean("hostUpnp", true);
        // Сменился Wi-Fi — у телефона новый адрес, а порт надо открыть на новом роутере
        android.net.ConnectivityManager cm = context.getSystemService(android.net.ConnectivityManager.class);
        if (cm != null) {
            try {
                cm.registerDefaultNetworkCallback(new android.net.ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(android.net.Network network) {
                        netSoon();
                    }

                    @Override
                    public void onLost(android.net.Network network) {
                        netSoon();
                    }
                });
            } catch (RuntimeException ignored) {
                // без подписки — адреса обновятся при перезапуске сервера
            }
        }
    }

    private final Runnable netChanged = this::networkChanged;

    private void netSoon() {
        main.removeCallbacks(netChanged);
        main.postDelayed(netChanged, 1500);
    }

    String localUrl() {
        return running ? "ws://127.0.0.1:" + port + "/ws" : null;
    }

    void resume() {
        if (wanted && !running && !starting) start();
    }

    void set(boolean on, int newPort, boolean upnp) {
        boolean restart = running && (newPort != port);
        boolean upnpChanged = upnp != upnpWanted;
        wanted = on;
        port = newPort;
        upnpWanted = upnp;
        prefs.edit().putBoolean("host", on).putInt("hostPort", newPort).putBoolean("hostUpnp", upnp).apply();
        if (!on) {
            stop();
        } else if (restart || !running) {
            stop();
            start();
        } else if (upnpChanged) {
            if (upnp) mapPort();
            else unmapPort();
        }
        changed();
    }

    private void start() {
        starting = true;
        error = null;
        int p = port;
        changed();
        work.execute(() -> {
            AirHub h = new AirHub(p);
            h.setWatcher(this);
            String problem = null;
            try {
                h.startAndWait();
            } catch (Exception e) {
                problem = e instanceof java.net.BindException
                    ? "порт " + p + " занят — выберите другой"
                    : "не запустился: " + e.getMessage();
                try {
                    h.stop(500);
                } catch (Exception ignored) {
                    // и не работал
                }
            }
            String why = problem;
            List<String> addrs = PortMapper.lanAddresses();
            main.post(() -> {
                starting = false;
                if (why != null || !wanted || port != p) {
                    if (why == null) stopHub(h);
                    error = why;
                    running = false;
                } else {
                    hub = h;
                    running = true;
                    lan = addrs;
                    if (upnpWanted) mapPort();
                    main.removeCallbacks(renew);
                    main.postDelayed(renew, 3600_000L);
                }
                changed();
            });
        });
    }

    private void stop() {
        main.removeCallbacks(renew);
        unmapPort();
        AirHub h = hub;
        hub = null;
        running = false;
        if (h != null) stopHub(h);
    }

    private void stopHub(AirHub h) {
        work.execute(() -> {
            try {
                h.stop(1000);
            } catch (Exception ignored) {
                // уже остановлен
            }
        });
    }

    private void mapPort() {
        upnpState = "trying";
        upnpError = null;
        externalIp = null;
        int p = port;
        PortMapper m = new PortMapper();
        mapper = m;
        changed();
        work.execute(() -> {
            String ip = null, problem = null;
            try {
                m.open(p);
                ip = m.externalIp();
            } catch (Exception e) {
                problem = e.getMessage();
            }
            String got = ip, why = problem;
            main.post(() -> {
                if (mapper != m) return; // уже выключили
                upnpState = why == null ? "ok" : "fail";
                upnpError = why;
                externalIp = got;
                changed();
            });
        });
    }

    private void unmapPort() {
        PortMapper m = mapper;
        mapper = null;
        upnpState = "off";
        upnpError = null;
        externalIp = null;
        if (m != null) work.execute(m::close);
    }

    // Сеть поменялась (другой Wi-Fi) — обновить адреса и заново попросить роутер
    void networkChanged() {
        if (!running) return;
        lan = PortMapper.lanAddresses();
        if (upnpWanted) {
            unmapPort();
            mapPort();
        }
        changed();
    }

    @Override
    public void onHubChanged() {
        changed();
    }

    private void changed() {
        main.post(listener::onServerChanged);
    }

    JSONObject state() {
        JSONObject o = new JSONObject();
        try {
            AirHub h = hub;
            o.put("on", wanted).put("running", running).put("starting", starting).put("port", port)
                .put("error", error).put("upnp", upnpWanted).put("upnpState", upnpState).put("upnpError", upnpError)
                .put("externalIp", externalIp)
                .put("public", externalIp != null && PortMapper.isPublicIp(externalIp))
                .put("lan", new JSONArray(lan))
                .put("clients", h != null ? h.clientCount() : 0)
                .put("stations", h != null ? h.stationCount() : 0);
        } catch (Exception ignored) {
            // не бросает
        }
        return o;
    }
}
