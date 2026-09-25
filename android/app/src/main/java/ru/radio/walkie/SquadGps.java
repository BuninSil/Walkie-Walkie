package ru.radio.walkie;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import org.json.JSONObject;

/*
 * Местоположение для карты отряда (squad.js). Работает, пока работает рация — и в фоне, и с
 * погасшим экраном (служба рации держит тип «местоположение»). Точка уходит в рацию, а рация
 * сама решает, когда отправить её отряду. Никуда больше координаты не пишутся и не отправляются.
 */
final class SquadGps implements LocationListener {

    static final String PREF_SHARE = "share_location";

    private static SquadGps instance;
    private static volatile String last; // последняя точка — JSON для рации

    private final LocationManager lm;
    private boolean running;

    private SquadGps(Context context) {
        lm = (LocationManager) context.getApplicationContext().getSystemService(Context.LOCATION_SERVICE);
    }

    static boolean permitted(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean enabled(Context context) {
        return context.getSharedPreferences(WalkieService.PREFS, Context.MODE_PRIVATE).getBoolean(PREF_SHARE, false);
    }

    static String last() {
        return last;
    }

    // Главный поток
    static void sync(Context context) {
        if (instance == null) instance = new SquadGps(context);
        if (enabled(context) && permitted(context)) instance.start();
        else instance.stop();
    }

    static void stopAll() {
        if (instance != null) instance.stop();
    }

    @SuppressWarnings("MissingPermission")
    private void start() {
        if (running || lm == null) return;
        running = true;
        try {
            boolean fused = Build.VERSION.SDK_INT >= 31 && lm.getAllProviders().contains(LocationManager.FUSED_PROVIDER);
            if (fused) {
                lm.requestLocationUpdates(LocationManager.FUSED_PROVIDER, 4000, 3, this, Looper.getMainLooper());
            } else {
                for (String p : new String[] { LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
                    if (lm.getAllProviders().contains(p)) lm.requestLocationUpdates(p, 4000, 3, this, Looper.getMainLooper());
                }
            }
            // Сразу — последняя известная точка, чтобы карта не ждала первого спутника
            Location best = null;
            for (String p : lm.getAllProviders()) {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            }
            if (best != null && System.currentTimeMillis() - best.getTime() < 10 * 60_000L) onLocationChanged(best);
        } catch (SecurityException | IllegalArgumentException e) {
            running = false;
        }
    }

    private void stop() {
        if (!running || lm == null) return;
        running = false;
        lm.removeUpdates(this);
    }

    @Override
    public void onLocationChanged(Location l) {
        try {
            JSONObject o = new JSONObject()
                .put("lat", l.getLatitude()).put("lon", l.getLongitude())
                .put("acc", l.hasAccuracy() ? Math.round(l.getAccuracy()) : -1)
                .put("hdg", l.hasBearing() && l.hasSpeed() && l.getSpeed() > 0.7 ? Math.round(l.getBearing()) : -1)
                .put("spd", l.hasSpeed() ? Math.round(l.getSpeed() * 10) / 10.0 : -1)
                .put("ts", l.getTime());
            last = o.toString();
            MainActivity.gps(last);
        } catch (Exception ignored) {
            // JSONObject.put не бросает для чисел
        }
    }

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {}

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}
}
