package ru.radio.station;

/*
 * Звук трека (любая частота, моно) → 16 кГц для эфира.
 * Сначала срезаем всё выше ~7 кГц (два биквада Баттерворта, иначе при понижении частоты
 * верха завернутся в слышимый свист), потом линейная интерполяция — как в ворклете рации.
 */
final class Resampler {

    private final double step;       // сколько входных сэмплов на один выходной
    private final double[] b = new double[3], a = new double[3];
    private final double[][] z = new double[2][4]; // состояние двух биквадов: x1 x2 y1 y2
    private final boolean filter;
    private double t = 0;            // позиция следующего выходного сэмпла относительно блока
    private float prev = 0;

    Resampler(int inRate) {
        step = inRate / (double) AirPacket.RATE;
        filter = inRate > AirPacket.RATE;
        if (filter) {
            double w = Math.tan(Math.PI * 7000.0 / inRate);
            double q = 1 / Math.sqrt(2);
            double n = 1 / (1 + w / q + w * w);
            b[0] = w * w * n;
            b[1] = 2 * b[0];
            b[2] = b[0];
            a[1] = 2 * (w * w - 1) * n;
            a[2] = (1 - w / q + w * w) * n;
        }
    }

    private float lowpass(float x) {
        double v = x;
        for (double[] s : z) {
            double y = b[0] * v + b[1] * s[0] + b[2] * s[1] - a[1] * s[2] - a[2] * s[3];
            s[1] = s[0];
            s[0] = v;
            s[3] = s[2];
            s[2] = y;
            v = y;
        }
        return (float) v;
    }

    interface Sink {
        void sample(float s);
    }

    // in — моно, -1…1; каждый выходной сэмпл уходит в sink
    void process(float[] in, int len, Sink sink) {
        if (filter) {
            for (int i = 0; i < len; i++) in[i] = lowpass(in[i]);
        }
        double pos = t;
        while (pos <= len - 1) {
            int i = (int) Math.floor(pos);
            float x0 = i < 0 ? prev : in[i];
            float x1 = i + 1 < len ? in[i + 1] : x0;
            sink.sample(x0 + (x1 - x0) * (float) (pos - i));
            pos += step;
        }
        t = pos - len;
        if (len > 0) prev = in[len - 1];
    }
}
