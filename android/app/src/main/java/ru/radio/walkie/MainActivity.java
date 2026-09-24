package ru.radio.walkie;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/*
 * Рация для Android — рация с ПК как есть. В WebView открывается та же страница widget.html
 * со всеми скриптами из radio-walkie/web, без правок. Как в ПК-приложении (Electron), страница
 * получает window.radioDesktop — его даёт android/bridge.js вместо preload.js — и считает,
 * что работает в ПК-оболочке: то же меню, та же логика подключения к серверу.
 *
 * Связь с сервером идёт из Java (AirSocket) с тем же Origin, что у ПК-приложения (app://radio).
 */
public class MainActivity extends ComponentActivity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String PAGE = "https://" + HOST + "/assets/web/widget.html";
    private static final int MIC_REQUEST = 1;

    private WebView web;
    private AirSocket air;
    private PermissionRequest pendingMic;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xff0d0e10);
        web = new WebView(this);
        web.setBackgroundColor(0xff0d0e10);
        root.addView(web);
        setContentView(root);
        // Рация не лезет под строку состояния и кнопки навигации
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                 // настройки рации — в localStorage, как на ПК
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        air = new AirSocket(this, web);
        web.addJavascriptInterface(air, "AirSocket");
        web.addJavascriptInterface(new Shell(), "WalkieShell");

        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (PAGE.equals(url.buildUpon().clearQuery().build().toString())) return page();
                return assets.shouldInterceptRequest(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost()); // наружу страница не уходит
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> micRequest(request));
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                moveTaskToBack(true); // «Назад» сворачивает рацию: связь с сервером остаётся
            }
        });

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 2);
        }

        web.loadUrl(PAGE + "?view=widget");
    }

    // widget.html как есть + адаптер: bridge.js первым в <head> (до скриптов рации), стили — последними
    private WebResourceResponse page() {
        try (InputStream in = getAssets().open("web/widget.html")) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            for (int n; (n = in.read(chunk)) > 0; ) buf.write(chunk, 0, n);
            String html = buf.toString("UTF-8")
                .replaceFirst("<head>", "<head>\n  <script src=\"/assets/android/bridge.js\"></script>")
                .replaceFirst("</head>", "  <link rel=\"stylesheet\" href=\"/assets/android/android.css\">\n</head>");
            return new WebResourceResponse("text/html", "utf-8",
                new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
        } catch (IOException e) {
            return null;
        }
    }

    // Микрофон: страница просит его при первой передаче — спрашиваем Android и отвечаем странице
    private void micRequest(PermissionRequest request) {
        boolean wantsMic = false;
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
        }
        if (!wantsMic) {
            request.deny();
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            return;
        }
        if (pendingMic != null) pendingMic.deny();
        pendingMic = request;
        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, MIC_REQUEST);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != MIC_REQUEST || pendingMic == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            pendingMic.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            WalkieService.start(this); // теперь сервис может держать и микрофон
        } else {
            pendingMic.deny();
        }
        pendingMic = null;
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Пока приложение на экране, Android разрешает запустить фоновый сервис (с микрофоном — если разрешён)
        WalkieService.start(this);
    }

    @Override
    protected void onDestroy() {
        air.closeAll();
        if (isFinishing()) WalkieService.stop(this);
        web.destroy();
        super.onDestroy();
    }

    /* То, что на ПК делает окно Electron: свернуть, закрыть, клавиатура для ввода текста */
    private class Shell {
        @JavascriptInterface
        public void minimize() {
            runOnUiThread(() -> moveTaskToBack(true));
        }

        @JavascriptInterface
        public void quit() {
            runOnUiThread(() -> {
                WalkieService.stop(MainActivity.this);
                finishAndRemoveTask();
            });
        }

        @JavascriptInterface
        public void showKeyboard() {
            runOnUiThread(() -> {
                web.requestFocus(View.FOCUS_DOWN);
                InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                imm.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
            });
        }
    }
}
