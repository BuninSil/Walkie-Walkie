'use strict';

/*
 * Исказитель голоса: голос уходит в эфир с другим тембром, по нему не узнать, кто говорит.
 * Обработка — на телефоне, до шифрования и отправки: сервер и другие рации получают уже
 * изменённый голос, ничего для этого не меняя. Встаёт в передатчик рации между чувствительностью
 * микрофона и остальной обработкой (live.js: micGain → input), сигнал ROGER и SOS не трогает.
 * Снаружи: window.WalkieVoice { PRESETS, get(), set(id), preview(onState) }.
 */
(() => {
  const KEY = 'walkie.voice';
  const WORKLET = '/assets/android/voice-worklet.js';

  const PRESETS = {
    off: { name: 'Свой голос', note: 'без изменений' },
    low: { name: 'Бас', note: 'ниже и грубее', pitch: 0.8 },
    anon: { name: 'Аноним', note: 'как в интервью «без лица»', pitch: 0.68, lowpass: 3200 },
    high: { name: 'Выше', note: 'тоньше обычного', pitch: 1.25 },
    robot: { name: 'Робот', note: 'металлический', pitch: 0.92, ring: 55 },
    radio: { name: 'Армейская', note: 'узкая полоса, хрип', pitch: 0.9, band: [550, 2300], drive: 6 },
  };

  let current = (() => {
    try {
      const v = localStorage.getItem(KEY);
      return PRESETS[v] ? v : 'off';
    } catch {
      return 'off';
    }
  })();

  // Цепочка обработки в контексте ctx: вход → … → выход
  async function chain(ctx, id) {
    const p = PRESETS[id] || PRESETS.off;
    const input = ctx.createGain();
    const output = ctx.createGain();
    let node = input;
    const sources = [];
    const link = (next) => {
      node.connect(next);
      node = next;
    };
    if (p.pitch && p.pitch !== 1) {
      if (!ctx.__voiceWorklet) ctx.__voiceWorklet = ctx.audioWorklet.addModule(WORKLET);
      await ctx.__voiceWorklet;
      const shift = new AudioWorkletNode(ctx, 'voice-pitch', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
      shift.parameters.get('ratio').value = p.pitch;
      link(shift);
    }
    if (p.band) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = p.band[0];
      hp.Q.value = 0.9;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = p.band[1];
      lp.Q.value = 1.2;
      link(hp);
      link(lp);
    }
    if (p.drive) {
      const shaper = ctx.createWaveShaper();
      const k = p.drive;
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(k * x) / Math.tanh(k);
      }
      shaper.curve = curve;
      shaper.oversample = '2x';
      const pre = ctx.createGain();
      pre.gain.value = 0.9;
      link(pre);
      link(shaper);
    }
    if (p.ring) {
      // Кольцевая модуляция: голос × синус низкой частоты — «металл»
      const ring = ctx.createGain();
      ring.gain.value = 0;
      const osc = ctx.createOscillator();
      osc.frequency.value = p.ring;
      osc.connect(ring.gain);
      osc.start();
      sources.push(osc);
      link(ring);
      const dry = ctx.createGain();
      dry.gain.value = 0.25; // чуть исходника — чтобы оставалось разборчиво
      input.connect(dry).connect(output);
    }
    if (p.lowpass) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = p.lowpass;
      link(lp);
    }
    node.connect(output);
    const dispose = () => {
      input.disconnect();
      output.disconnect();
      for (const o of sources) o.stop();
    };
    return { input, output, dispose };
  }

  /* ───────── В передатчике рации ───────── */

  let attached = null; // { b, fx }

  // Восстановить исходный тракт рации (micGain → input, как в live.js)
  function restore(b) {
    if (attached?.fx) attached.fx.dispose();
    attached = null;
    try {
      b.micGain.disconnect();
    } catch {
      /* уже */
    }
    b.micGain.connect(b.input);
  }

  async function attach(b) {
    if (!b?.ctx || !b.micGain || !b.input) return;
    // «Свой голос»: звуковой тракт рации не трогаем вообще — всё как без исказителя
    if (current === 'off') {
      if (attached) restore(b);
      return;
    }
    const ctx = b.ctx;
    let fx = null;
    try {
      fx = await chain(ctx, current);
    } catch {
      fx = null; // обработка не собралась — голос идёт как есть
    }
    if (b.ctx !== ctx) return; // пока собирали, передатчик закрыли
    if (current === 'off') { // пока собирали — выключили
      if (fx) fx.dispose();
      restore(b);
      return;
    }
    if (attached?.b === b && attached.fx) attached.fx.dispose();
    b.micGain.disconnect();
    if (fx) {
      b.micGain.connect(fx.input);
      fx.output.connect(b.input);
    } else {
      b.micGain.connect(b.input);
    }
    attached = { b, fx };
  }

  function hook() {
    const b = window.radioWidget?.broadcaster;
    if (!b || b.__voiceHooked) return Boolean(b);
    b.__voiceHooked = true;
    const open = b.open.bind(b);
    b.open = async (...args) => {
      await open(...args);
      await attach(b);
    };
    if (b.ctx) attach(b);
    return true;
  }

  function set(id) {
    if (!PRESETS[id]) return;
    current = id;
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* не запомним */
    }
    const b = window.radioWidget?.broadcaster;
    if (b?.ctx) attach(b);
  }

  /* ───────── Проверка: записать 3 с и послушать ───────── */

  let previewing = false;
  async function preview(onState) {
    if (previewing) return;
    previewing = true;
    let stream = null;
    let ctx = null;
    try {
      onState?.('rec', 3);
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      ctx = new AudioContext();
      const fx = await chain(ctx, current);
      const src = ctx.createMediaStreamSource(stream);
      const dest = ctx.createMediaStreamDestination();
      src.connect(fx.input);
      fx.output.connect(dest);
      const rec = new MediaRecorder(dest.stream);
      const parts = [];
      rec.ondataavailable = (e) => parts.push(e.data);
      const done = new Promise((resolve) => { rec.onstop = resolve; });
      rec.start();
      for (let s = 3; s > 0; s--) {
        onState?.('rec', s);
        await new Promise((r) => setTimeout(r, 1000));
      }
      rec.stop();
      await done;
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      await ctx.close();
      ctx = null;
      onState?.('play');
      const url = URL.createObjectURL(new Blob(parts, { type: rec.mimeType || 'audio/webm' }));
      const audio = new Audio(url);
      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = resolve;
        audio.play().catch(resolve);
      });
      URL.revokeObjectURL(url);
      onState?.('done');
    } catch {
      onState?.('error');
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close();
      previewing = false;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Передатчик создаёт widget.js; ждём его и встраиваемся
    if (!hook()) {
      const t = setInterval(() => {
        if (hook()) clearInterval(t);
      }, 300);
    }
  });

  window.WalkieVoice = { PRESETS, get: () => current, set, preview, chain };
})();
