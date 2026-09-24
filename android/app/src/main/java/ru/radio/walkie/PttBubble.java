package ru.radio.walkie;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;

/*
 * Кнопка PTT поверх других приложений.
 *   Держите — говорите (как PTT на рации). Короткое нажатие — открыть рацию. Потащите — переставить.
 * Цвет кольца: серый — на связи, зелёный — приём, красный — передача, оранжевый — нет связи.
 * Нажатия уходят в рацию так же, как горячая клавиша на ПК (ptt-down / ptt-up), — логика рации та же.
 */
final class PttBubble {

    private static final String PREF_X = "bubble_x";
    private static final String PREF_Y = "bubble_y";
    private static final long HOLD_MS = 160; // дольше — это PTT, а не нажатие «открыть»

    private final Context context;
    private final WindowManager wm;
    private final SharedPreferences prefs;
    private final int size;
    private BubbleView view;
    private WindowManager.LayoutParams lp;

    PttBubble(Context context) {
        this.context = context;
        this.wm = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        this.prefs = context.getSharedPreferences(WalkieService.PREFS, Context.MODE_PRIVATE);
        this.size = Math.round(68 * context.getResources().getDisplayMetrics().density);
    }

    void show() {
        if (view != null) return;
        DisplayMetrics dm = context.getResources().getDisplayMetrics();
        lp = new WindowManager.LayoutParams(size, size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = prefs.getInt(PREF_X, dm.widthPixels - size - size / 4);
        lp.y = prefs.getInt(PREF_Y, dm.heightPixels / 2);
        view = new BubbleView(context);
        try {
            wm.addView(view, lp);
        } catch (RuntimeException e) {
            view = null; // разрешения «поверх других приложений» нет
        }
    }

    void hide() {
        if (view == null) return;
        if (view.talking) MainActivity.hotkey("ptt-up");
        try {
            wm.removeView(view);
        } catch (RuntimeException ignored) {
            // уже убрана
        }
        view = null;
    }

    void refresh() {
        if (view != null) view.invalidate();
    }

    private final class BubbleView extends View {
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint label = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final int slop;
        private float downX, downY;
        private int startX, startY;
        private long downAt;
        private boolean dragging;
        boolean talking;
        private final Runnable startTalking = () -> {
            talking = true;
            performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
            MainActivity.hotkey("ptt-down");
            invalidate();
        };

        BubbleView(Context c) {
            super(c);
            slop = ViewConfiguration.get(c).getScaledTouchSlop();
            ring.setStyle(Paint.Style.STROKE);
            label.setColor(0xffecebe6);
            label.setTextAlign(Paint.Align.CENTER);
            label.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float r = getWidth() / 2f;
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
            canvas.drawCircle(r, r, r * 0.92f, fill);
            ring.setColor(color);
            ring.setStrokeWidth(r * 0.14f);
            canvas.drawCircle(r, r, r * 0.84f, ring);
            label.setTextSize(r * 0.5f);
            canvas.drawText(text, r, r - (label.descent() + label.ascent()) / 2, label);
        }

        @SuppressLint("ClickableViewAccessibility")
        @Override
        public boolean onTouchEvent(MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = e.getRawX();
                    downY = e.getRawY();
                    startX = lp.x;
                    startY = lp.y;
                    downAt = SystemClock.uptimeMillis();
                    dragging = false;
                    postDelayed(startTalking, HOLD_MS);
                    return true;
                case MotionEvent.ACTION_MOVE:
                    if (talking) return true; // во время передачи кнопка стоит на месте
                    float dx = e.getRawX() - downX;
                    float dy = e.getRawY() - downY;
                    if (!dragging && Math.hypot(dx, dy) > slop) {
                        dragging = true;
                        removeCallbacks(startTalking);
                    }
                    if (dragging) {
                        lp.x = startX + Math.round(dx);
                        lp.y = startY + Math.round(dy);
                        wm.updateViewLayout(this, lp);
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    removeCallbacks(startTalking);
                    if (talking) {
                        talking = false;
                        MainActivity.hotkey("ptt-up");
                        invalidate();
                    } else if (dragging) {
                        prefs.edit().putInt(PREF_X, lp.x).putInt(PREF_Y, lp.y).apply();
                    } else if (e.getActionMasked() == MotionEvent.ACTION_UP && SystemClock.uptimeMillis() - downAt < HOLD_MS) {
                        Intent open = new Intent(context, MainActivity.class)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                        context.startActivity(open);
                    }
                    return true;
                default:
                    return false;
            }
        }
    }
}
