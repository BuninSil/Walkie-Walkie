package ru.radio.station;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/*
 * Эфир в фоне: пока станция в эфире, Android не должен её усыплять — ни со свёрнутым
 * приложением, ни с выключенным экраном. Держит процессор и Wi-Fi и показывает уведомление
 * «В эфире»: частота, трек, слушатели; кнопки «Следующий» и «Закончить эфир».
 */
public class StationService extends Service implements Station.Listener {

    private static final String CHANNEL = "station-air";
    private static final int NOTIFICATION_ID = 1;
    private static final String ACTION_NEXT = "ru.radio.station.NEXT";
    private static final String ACTION_STOP = "ru.radio.station.STOP";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private Station station;
    private String shown;

    static void start(Context context) {
        try {
            ContextCompat.startForegroundService(context, new Intent(context, StationService.class));
        } catch (RuntimeException ignored) {
            // Android не дал запустить из фона — эфир идёт, пока приложение открыто
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, StationService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        station = Station.get(this);
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "station:air");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
        wifiLock = wm.createWifiLock(mode, "station:air");
        wifiLock.setReferenceCounted(false);
        wifiLock.acquire();
        station.addListener(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_NEXT.equals(action)) station.next();
        if (ACTION_STOP.equals(action)) {
            station.stop();
            return START_NOT_STICKY;
        }
        int types = 0;
        if (Build.VERSION.SDK_INT >= 29) {
            types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
            if (Build.VERSION.SDK_INT >= 30 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            }
        }
        try {
            shown = null;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), types);
        } catch (RuntimeException e) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onStationChanged() {
        if (!station.onAir) return;
        String text = title() + "|" + text();
        if (text.equals(shown)) return;
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID, notification());
    }

    private String title() {
        String t = "В эфире · " + station.freqText() + " МГц · " + station.name;
        if (!station.linkOnline()) t = "Нет связи с сервером · " + station.freqText() + " МГц";
        return t;
    }

    private String text() {
        String now = station.mic ? "🎙 Говорите поверх музыки" : station.nowTitle != null ? "▶ " + station.nowTitle : "Тишина в эфире";
        return now + " · слушателей: " + station.listenersCount;
    }

    private Notification notification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Станция в эфире", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Пока станция в эфире: частота, трек, слушатели");
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);

        String title = title();
        String text = text();
        shown = title + "|" + text;
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent next = PendingIntent.getService(this, 1,
            new Intent(this, StationService.class).setAction(ACTION_NEXT), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 2,
            new Intent(this, StationService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_station)
            .setColor(0xffff3b2f)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "Следующий", next)
            .addAction(0, "Закончить эфир", stop)
            .build();
    }

    @Override
    public void onDestroy() {
        station.removeListener(this);
        if (wakeLock.isHeld()) wakeLock.release();
        if (wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
