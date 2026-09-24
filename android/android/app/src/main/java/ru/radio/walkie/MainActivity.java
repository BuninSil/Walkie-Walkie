package ru.radio.walkie;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

/*
 * Рация для Android: та же страница рации, что и в приложении для ПК, внутри WebView.
 * Здесь только то, чего странице не сделать самой: фоновый приём и кнопка «Назад».
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // «Назад» сворачивает рацию, а не закрывает: связь с сервером остаётся
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                moveTaskToBack(true);
            }
        });

        // Без уведомления фоновый приём на Android 13+ работает, но его не видно в шторке
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        // Запускаем (или обновляем) сервис, пока приложение на экране: так Android разрешает
        // ему пользоваться микрофоном — например, если выдали разрешение с прошлого раза
        WalkieService.start(this);
    }

    @Override
    public void onDestroy() {
        if (isFinishing()) WalkieService.stop(this);
        super.onDestroy();
    }
}
