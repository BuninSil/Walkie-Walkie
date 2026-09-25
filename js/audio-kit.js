'use strict';

/*
 * Звуковые кирпичики: буферы шума, огибающие, фильтры и простые инструменты.
 * Всё синтезируется на лету через Web Audio API — аудиофайлы не нужны.
 */

const AudioKit = (() => {
  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function filter(ctx, type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q != null) f.Q.value = q;
    return f;
  }

  // Белый шум с редкими щелчками атмосферных помех (crackles — щелчков в секунду)
  function whiteNoiseBuffer(ctx, seconds, crackles = 0) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const pops = Math.floor(seconds * crackles);
    for (let p = 0; p < pops; p++) {
      const n = 20 + Math.floor(Math.random() * 160);
      const at = Math.floor(Math.random() * (len - n));
      const amp = 1.2 + Math.random() * 2.5;
      for (let k = 0; k < n; k++) {
        d[at + k] += amp * Math.exp(-k / (n / 4)) * (Math.random() * 2 - 1);
      }
    }
    return buf;
  }

  // Плавная случайная кривая в диапазоне -1..1 — для дрожания и замираний сигнала.
  // Последняя точка сходится с первой, поэтому буфер можно зацикливать без скачка.
  function smoothNoiseBuffer(ctx, seconds, rateHz) {
    const stepLen = Math.max(1, Math.floor(ctx.sampleRate / rateHz));
    const steps = Math.max(2, Math.round(seconds * rateHz));
    const pts = Array.from({ length: steps }, () => Math.random() * 2 - 1);
    const buf = ctx.createBuffer(1, steps * stepLen, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const seg = Math.floor(i / stepLen);
      const x = (i % stepLen) / stepLen;
      const a = pts[seg];
      const b = pts[(seg + 1) % steps];
      d[i] = a + (b - a) * x * x * (3 - 2 * x);
    }
    return buf;
  }

  const noiseCache = new WeakMap();
  function sharedNoise(ctx) {
    if (!noiseCache.has(ctx)) noiseCache.set(ctx, whiteNoiseBuffer(ctx, 2));
    return noiseCache.get(ctx);
  }

  function loop(ctx, buffer) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start(ctx.currentTime, Math.random() * buffer.duration);
    return src;
  }

  function softClipCurve(k = 2, n = 2048) {
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    return curve;
  }

  // Удар с экспоненциальным затуханием
  function pluck(param, t, peak, attack, decay) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // Нота из нескольких осцилляторов под общей огибающей
  function voice(ctx, dest, t, peak, attack, decay, partials) {
    const env = ctx.createGain();
    env.connect(dest);
    pluck(env.gain, t, peak, attack, decay);
    for (const p of partials) {
      const osc = ctx.createOscillator();
      osc.type = p.type || 'sine';
      osc.frequency.value = p.freq;
      if (p.detune) osc.detune.value = p.detune;
      const g = ctx.createGain();
      g.gain.value = p.gain;
      osc.connect(g).connect(env);
      osc.start(t);
      osc.stop(t + attack + decay + 0.05);
    }
  }

  function noiseHit(ctx, dest, t, type, freq, q, peak, decay) {
    const src = ctx.createBufferSource();
    src.buffer = sharedNoise(ctx);
    const g = ctx.createGain();
    pluck(g.gain, t, peak, 0.002, decay);
    src.connect(filter(ctx, type, freq, q)).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + decay + 0.05);
  }

  const inst = {
    keys(ctx, dest, t, midi, vel = 0.5, len = 1.5) {
      const f = midiToFreq(midi);
      voice(ctx, dest, t, 0.11 * vel, 0.008, len, [
        { freq: f, gain: 1 },
        { freq: f * 2, gain: 0.22, type: 'triangle', detune: 4 },
        { freq: f * 3, gain: 0.05 },
      ]);
    },

    bass(ctx, dest, t, midi, vel = 0.7, len = 0.6) {
      const lp = filter(ctx, 'lowpass', 700);
      lp.connect(dest);
      voice(ctx, lp, t, 0.3 * vel, 0.01, len, [{ freq: midiToFreq(midi), gain: 1, type: 'triangle' }]);
    },

    lead(ctx, dest, t, midi, vel = 0.5, len = 0.5) {
      const f = midiToFreq(midi);
      voice(ctx, dest, t, 0.09 * vel, 0.02, len * 1.4, [
        { freq: f, gain: 1, type: 'triangle' },
        { freq: f * 2, gain: 0.12 },
      ]);
    },

    musicBox(ctx, dest, t, midi, vel = 0.6) {
      const f = midiToFreq(midi);
      voice(ctx, dest, t, 0.14 * vel, 0.003, 1.8, [
        { freq: f, gain: 1 },
        { freq: f * 2, gain: 0.35 },
        { freq: f * 4.02, gain: 0.1 },
      ]);
    },

    kick(ctx, dest, t, vel = 0.8) {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(48, t + 0.13);
      const g = ctx.createGain();
      pluck(g.gain, t, 0.6 * vel, 0.003, 0.32);
      osc.connect(g).connect(dest);
      osc.start(t);
      osc.stop(t + 0.4);
    },

    snare(ctx, dest, t, vel = 0.6) {
      noiseHit(ctx, dest, t, 'bandpass', 1900, 0.7, 0.28 * vel, 0.17);
      voice(ctx, dest, t, 0.08 * vel, 0.002, 0.09, [{ freq: 190, gain: 1, type: 'triangle' }]);
    },

    hat(ctx, dest, t, vel = 0.4) {
      noiseHit(ctx, dest, t, 'highpass', 7000, 0.7, 0.07 * vel, 0.04);
    },
  };

  return { midiToFreq, filter, whiteNoiseBuffer, smoothNoiseBuffer, sharedNoise, loop, softClipCurve, inst };
})();
