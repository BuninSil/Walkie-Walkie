'use strict';

/*
 * Сетевые фишки, как у настоящих раций (⚙ → «Канал»):
 *   • Тоновый шумодав (CTCSS): в передачу подмешивается неслышный тон 67–100 Гц (ниже среза 110 Гц,
 *     поэтому старые рации и ПК его почти не слышат). На приёме рация открывает звук только когда в
 *     эфире тот же тон — значит, на одной частоте несколько групп не мешают друг другу.
 *   • Занятый канал (BCL): пока кто-то говорит, PTT заблокирована — не перебить, как на железе.
 * Всё на телефоне, сервер и другие рации менять не нужно. Работает поверх кода рации, не трогая его.
 */
(() => {
  const shell = window.WalkieShell;
  const STORE = 'walkie.channel';

  // Стандартные «низкие» тоны CTCSS (все ниже 110 Гц — под срезом приёмника, т.е. почти неслышны)
  const TONES = [67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0];

  const cfg = (() => {
    try {
      return JSON.parse(localStorage.getItem(STORE)) || {};
    } catch {
      return {};
    }
  })();
  cfg.tone = TONES.includes(cfg.tone) ? cfg.tone : 0; // 0 — выключен
  cfg.bcl = true;                                     // «занятый канал» всегда включён
  const save = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify(cfg));
    } catch {
      /* не запомним */
    }
  };

  const w = () => window.radioWidget;

  /* ───────── Передача: подмешать свой тон ───────── */

  let txOsc = null;
  let txGain = null;
  function hookTx(b) {
    if (!b?.ctx || !b.txIn || b.__toneHooked) return;
    b.__toneHooked = true;
    const ctx = b.ctx;
    txGain = ctx.createGain();
    txGain.gain.value = 0;
    txOsc = ctx.createOscillator();
    txOsc.frequency.value = cfg.tone || 100;
    txOsc.connect(txGain).connect(b.txIn);
    txOsc.start();
  }
  function applyTxTone() {
    if (!txOsc) return;
    const on = cfg.tone && w()?.tx?.active;
    txOsc.frequency.setTargetAtTime(cfg.tone || 100, txOsc.context.currentTime, 0.01);
    txGain.gain.setTargetAtTime(on ? 0.04 : 0, txOsc.context.currentTime, 0.02);
  }

  /* ───────── Приём: детектор тона (Гёрцель) и гейт ───────── */

  let analyser = null;
  let buf = null;
  let gate = null;
  let hookedRx = false;
  function hookRx(engine) {
    if (hookedRx || !engine?.ctx || !engine.mix || !engine.master) return;
    const ctx = engine.ctx;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192; // ~170 мс при 48 кГц — хватает на 3+ периода тона 67 Гц
    buf = new Float32Array(analyser.fftSize);
    engine.mix.connect(analyser); // только слушаем, маршрут не меняем
    // Гейт между общей громкостью и выходом: master → gate → выход
    gate = ctx.createGain();
    gate.gain.value = 1;
    try {
      engine.master.disconnect(ctx.destination);
    } catch {
      /* уже иначе */
    }
    engine.master.connect(gate).connect(ctx.destination);
    hookedRx = true;
  }

  // Есть ли частота freq в том, что сейчас в миксе (нормированная энергия тона)
  function toneStrength(freq) {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(buf);
    const sr = analyser.context.sampleRate;
    const N = buf.length;
    const k = (2 * Math.PI * freq) / sr;
    const cos = Math.cos(k);
    const coeff = 2 * cos;
    let s0 = 0, s1 = 0, s2 = 0, energy = 0;
    for (let i = 0; i < N; i++) {
      const x = buf[i];
      s0 = x + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
      energy += x * x;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2; // мощность на частоте тона
    if (energy < 1e-6) return 0;
    return Math.sqrt(power) / Math.sqrt(energy * N); // доля тона в общем сигнале
  }

  let openUntil = 0;
  function applyRxGate() {
    if (!gate) return;
    const r = w();
    let open = true;
    if (cfg.tone && r && !r.radio.fm) {
      const rx = r.engine.best && r.engine.bestSignal >= 0.05 && !r.tx.active;
      if (rx) {
        const now = performance.now();
        if (toneStrength(cfg.tone) > 0.10) openUntil = now + 600; // тон есть — держим открытым ещё чуть-чуть
        open = now < openUntil;
      }
    }
    gate.gain.setTargetAtTime(open ? 1 : 0, gate.context.currentTime, open ? 0.01 : 0.05);
  }

  /* ───────── Занятый канал (BCL) ───────── */

  function channelBusy() {
    const r = w();
    if (!r || !r.radio.power || r.tx.active) return false;
    // Кто-то в эфире на нашем канале. С тоновым шумодавом — только своя группа считается «занято»
    const rx = r.engine.best && r.engine.bestSignal >= 0.05;
    if (!rx) return false;
    if (cfg.tone) return toneStrength(cfg.tone) > 0.10;
    return true;
  }

  let blockedFlash = 0;
  function blockPtt() {
    const now = performance.now();
    if (now - blockedFlash > 900) {
      blockedFlash = now;
      shell?.vibrate?.();
      try {
        const ctx = w()?.engine?.ctx;
        if (ctx && ctx.state === 'running') {
          const t = ctx.currentTime;
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.frequency.value = 380;
          g.gain.setValueAtTime(0.12, t);
          g.gain.setValueAtTime(0, t + 0.12);
          o.connect(g).connect(ctx.destination);
          o.start(t);
          o.stop(t + 0.14);
        }
      } catch {
        /* без пика */
      }
      toast('КАНАЛ ЗАНЯТ');
    }
  }

  let toastEl = null;
  let toastTimer = 0;
  function toast(text) {
    if (!toastEl) {
      toastEl = el('div', 'ch-toast');
      document.body.append(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 1100);
  }

  // Не дать начать передачу на занятом канале
  function guardPtt(down) {
    if (!cfg.bcl || !down) return false;
    if (channelBusy()) {
      blockPtt();
      return true; // заблокировано
    }
    return false;
  }

  /* Перехват всех кнопок передачи на Android: кнопка на экране, поверх приложений, экран блокировки */
  function installGuards() {
    // 1. Горячая клавиша (кнопка поверх приложений, уведомление, экран блокировки)
    const origHotkey = window.__walkieHotkey;
    window.__walkieHotkey = (action) => {
      if ((action === 'ptt-down' || action === 'ptt-toggle') && !w()?.tx?.active && guardPtt(true)) return;
      return origHotkey?.(action);
    };
    // 2. Кнопка PTT на экране рации — перехват в фазе захвата, до рации
    const ptt = document.getElementById('ptt');
    if (ptt) {
      ptt.addEventListener('pointerdown', (e) => {
        if (guardPtt(true)) {
          e.stopImmediatePropagation();
          e.preventDefault();
        }
      }, true);
    }
  }

  /* ───────── Настройки: раздел «Канал» ───────── */

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function section(rerender) {
    const sec = el('section', 'wk-sec');
    sec.append(el('h3', null, 'Канал'));

    // Тоновый шумодав
    const item = el('div', 'pv-item');
    const head = el('div', 'pv-item__head');
    head.append(el('span', null, 'Тоновый шумодав'), el('b', 'pv-value', cfg.tone ? `${cfg.tone.toFixed(1)} Гц` : 'выкл'));
    item.append(head);
    const grid = el('div', 'ch-tones');
    const add = (val, label) => {
      const b = el('button', 'ch-tone', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(cfg.tone === val));
      b.addEventListener('click', () => {
        cfg.tone = val;
        save();
        applyTxTone();
        rerender();
      });
      grid.append(b);
    };
    add(0, 'Выкл');
    for (const t of TONES) add(t, t.toFixed(1));
    item.append(grid);
    item.append(el('small', 'pv-hint', 'Одна частота — несколько групп. Слышно только тех, у кого тот же тон. Тон неслышный, старые рации его не замечают.'));
    sec.append(item);

    // «Не перебивать» всегда включено — отдельной настройки нет
    const bcl = el('div', 'pv-item');
    const bh = el('div', 'pv-item__head');
    bh.append(el('span', null, 'Не перебивать'), el('b', 'pv-value', 'всегда'));
    bcl.append(bh, el('small', 'pv-hint', 'Пока кто-то говорит на канале, ваша передача заблокирована — не перебить, как на рации.'));
    sec.append(bcl);
    return sec;
  }

  /* ───────── Пуск ───────── */

  function boot() {
    const b = w()?.broadcaster;
    const e = w()?.engine;
    if (b?.ctx) hookTx(b);
    if (e?.ctx) hookRx(e);
    return Boolean(b && e);
  }

  document.addEventListener('DOMContentLoaded', () => {
    installGuards();
    // Аудио-узлы появляются после включения питания — ждём контекст
    const t = setInterval(() => {
      if (w()?.broadcaster?.ctx && w()?.engine?.ctx) {
        boot();
        clearInterval(t);
      }
    }, 400);
    boot();
    setInterval(() => {
      if (!hookedRx || !txOsc) boot();
      applyTxTone();
      applyRxGate();
    }, 60);
  });

  window.WalkieChannel = { section, cfg, toneStrength };
})();
