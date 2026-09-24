package ru.radio.walkie;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

/*
 * Кнопка PTT поверх экрана блокировки. Обычная кнопка «поверх приложений» Android прячет под
 * экран блокировки, поэтому, пока телефон заблокирован, показываем крошечное окно с той же кнопкой:
 * держите — говорите, тап — открыть рацию (тоже поверх блокировки). Касания мимо кнопки уходят
 * экрану блокировки. Разблокировали или погасили экран — окно закрывается (WalkieService).
 */
public class LockPttActivity extends Activity implements AirState.Listener {

    private static final long HOLD_MS = 160;
    private static LockPttActivity instance;

    private PttView view;

    static void close() {
        LockPttActivity a = instance;
        if (a != null) a.finish();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;
        setShowWhenLocked(true);

        Window w = getWindow();
        // Окно — только размером с кнопку; всё мимо неё — экрану блокировки
        w.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
        w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        DisplayMetrics dm = getResources().getDisplayMetrics();
        int size = Math.round(76 * dm.density);
        SharedPreferences prefs = getSharedPreferences(WalkieService.PREFS, MODE_PRIVATE);
        WindowManager.LayoutParams lp = w.getAttributes();
        lp.width = size;
        lp.height = size;
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = prefs.getInt("bubble_x", dm.widthPixels - size - size / 4);
        lp.y = prefs.getInt("bubble_y", dm.heightPixels / 2);
        w.setAttributes(lp);

        view = new PttView();
        setContentView(view);
        AirState.addListener(this);
    }

    @Override
    public void onAirChanged() {
        view.invalidate();
    }

    @Override
    protected void onDestroy() {
        if (view.talking) MainActivity.hotkey("ptt-up");
        AirState.removeListener(this);
        if (instance == this) instance = null;
        super.onDestroy();
    }

    private final class PttView extends View {
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint label = new Paint(Paint.ANTI_ALIAS_FLAG);
        boolean talking;
        private long downAt;
        private final Runnable startTalking = () -> {
            talking = true;
            performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
            MainActivity.hotkey("ptt-down");
            invalidate();
        };

        PttView() {
            super(LockPttActivity.this);
            ring.setStyle(Paint.Style.STROKE);
            label.setColor(0xffecebe6);
            label.setTextAlign(Paint.Align.CENTER);
            label.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float r = Math.min(getWidth(), getHeight()) / 2f;
            int color;
            String text = "PTT";
            if (talking || AirState.transmitting()) {
                color = 0xffff3b2f;
                text = "TX";
            } else if (!AirState.online) {
                color = 0xffff9a3c;
            } else if (AirState.receiving()) {
                color = 0xff37f06f;
                text = "RX";
            } else {
                color = 0xff5a5c64;
            }
            fill.setColor(talking ? 0xf0401614 : 0xe01a1b1f);
            canvas.drawCircle(getWidth() / 2f, getHeight() / 2f, r * 0.92f, fill);
            ring.setColor(color);
            ring.setStrokeWidth(r * 0.14f);
            canvas.drawCircle(getWidth() / 2f, getHeight() / 2f, r * 0.84f, ring);
            label.setTextSize(r * 0.5f);
            canvas.drawText(text, getWidth() / 2f, getHeight() / 2f - (label.descent() + label.ascent()) / 2, label);
        }

        @SuppressLint("ClickableViewAccessibility")
        @Override
        public boolean onTouchEvent(MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downAt = SystemClock.uptimeMillis();
                    postDelayed(startTalking, HOLD_MS);
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    removeCallbacks(startTalking);
                    if (talking) {
                        talking = false;
                        MainActivity.hotkey("ptt-up");
                        invalidate();
                    } else if (e.getActionMasked() == MotionEvent.ACTION_UP && SystemClock.uptimeMillis() - downAt < HOLD_MS) {
                        // Тап — рация целиком, поверх экрана блокировки
                        startActivity(new Intent(LockPttActivity.this, MainActivity.class)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
                        finish();
                    }
                    return true;
                default:
                    return true;
            }
        }
    }
}
