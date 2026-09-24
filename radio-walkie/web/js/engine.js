'use strict';

/*
 * Движок эфира. Все станции звучат постоянно, а приёмник решает, что из них слышно:
 * чем ближе настройка к частоте станции, тем громче и чище её сигнал и тем тише шум.
 */

// Диапазоны: width — «ширина» станции на шкале, МГц
const BAND = { min: 87.5, max: 108.0, width: 0.15 };  // FM-вещание: широкие станции
const UHF = { min: 400.0, max: 470.0, width: 0.004 }; // рации: узкие каналы через 12,5 кГц
const NOISE_LEVEL = 0.13;
const LOOKAHEAD = 1.5;     // на сколько секунд вперёд планируется звук
const SQUELCH_LEVEL = 0.3; // шумоподавитель открывается, когда сигнал сильнее
const SQUELCH_TAIL = 0.15; // столько шума слышно после пропадания несущей, с

class RadioEngine {
  constructor(stations) {
    this.stations = stations;
    this.freq = 97.2;
    this.volume = 0.7;
    this.keys = new Set();
    this.ctx = null;
    this.on = false;
    this.best = null;       // самая сильная станция на текущей частоте
    this.bestSignal = 0;    // её уровень с учётом мощности, 0..1
    this.bestCloseness = 0; // насколько точно настроено, 0..1
    this.band = BAND;
    this.watch = null;      // вторая частота при двойном прослушивании
    this.squelchLevel = 0;  // порог шумоподавителя; 0 — выключен
    this.monitor = false;   // Monitor: шумоподавитель временно открыт
    this.squelchOpen = null;
  }

  get squelch() {
    return this.squelchLevel > 0;
  }

  // Частоты, которые слушает приёмник: рабочая и, при двойном прослушивании, вторая
  listening() {
    return this.watch == null ? [this.freq] : [this.freq, this.watch];
  }

  closeness(st, f) {
    let best = 0;
    for (const x of f === undefined ? this.listening() : [f]) {
      const d = (x - st.freq) / this.band.width;
      best = Math.max(best, Math.exp(-d * d));
    }
    return best;
  }

  signal(st, f) {
    return st.onAir ? st.power * this.closeness(st, f) : 0;
  }

  // Живые станции появляются и исчезают, пока приёмник работает
  addStation(st) {
    this.stations.push(st);
    if (this.ctx) this.attach(st);
    this.applyTuning();
  }

  removeStation(st) {
    const i = this.stations.indexOf(st);
    if (i === -1) return;
    this.stations.splice(i, 1);
    if (this.ctx) this.detach(st);
    this.applyTuning();
  }

  setFrequency(f) {
    this.freq = Math.min(this.band.max, Math.max(this.band.min, f));
    this.applyTuning();
  }

  setBand(band, f = this.freq) {
    this.band = band;
    this.setFrequency(f);
  }

  // Двойное прослушивание: вторая частота (null — выключено)
  setWatch(f) {
    this.watch = f;
    this.applyTuning();
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (!this.on) return;
    const g = this.master.gain;
    const t = this.ctx.currentTime;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else g.cancelScheduledValues(t);
    g.setTargetAtTime(this.volume, t, 0.03);
  }

  setKeys(keys) {
    this.keys = new Set(keys);
    for (const st of this.stations) {
      if (st instanceof CipherStation) st.setDecrypted(this.keys.has(st.keyValue));
    }
  }

  // Шумоподавитель (ШП) глушит приёмник, пока нет сильного сигнала — как у раций
  setSquelch(on) {
    this.setSquelchLevel(on ? SQUELCH_LEVEL : 0);
  }

  setSquelchLevel(level) {
    this.squelchLevel = level;
    this.squelchOpen = null;
    this.applyTuning();
  }

  setMonitor(on) {
    this.monitor = on;
    this.squelchOpen = null;
    this.applyTuning();
  }

  // Короткий писк прямо в динамик, мимо эфира и шумоподавителя (звук кнопок)
  beep(freq = 1200, duration = 0.04, level = 0.12) {
    if (!this.on) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.setValueAtTime(0, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  async powerOn() {
    if (!this.ctx) this.build();
    await this.ctx.resume();
    this.on = true;
    const g = this.master.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(this.volume, t + 0.8); // лампы прогреваются
    this.tick();
    this.timer = setInterval(() => this.tick(), 100);
    this.applyTuning();
  }

  async powerOff() {
    this.on = false;
    clearInterval(this.timer);
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    await new Promise((r) => setTimeout(r, 250));
    if (!this.on) await this.ctx.suspend();
  }

  // Подключить к выходу приёмника анализатор (например, декодер Морзе) — он слышит то же, что и вы
  tap(node) {
    this.out.connect(node);
  }

  build() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    // Выходной тракт — маленький динамик приёмника
    this.mix = ctx.createGain();
    const drive = ctx.createWaveShaper();
    drive.curve = AudioKit.softClipCurve(1.6);
    drive.oversample = '2x';
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.squelchGate = ctx.createGain();
    this.mix
      .connect(this.squelchGate)
      .connect(AudioKit.filter(ctx, 'highpass', 110))
      .connect(AudioKit.filter(ctx, 'lowpass', 6500))
      .connect(drive)
      .connect(comp);
    comp.connect(this.analyser);
    this.out = comp;
    comp.connect(this.master).connect(ctx.destination);

    // Шум эфира
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = NOISE_LEVEL;
    AudioKit.loop(ctx, AudioKit.whiteNoiseBuffer(ctx, 8, 4))
      .connect(AudioKit.filter(ctx, 'lowpass', 5200))
      .connect(this.noiseGain)
      .connect(this.mix);

    // Свист биений, когда настройка чуть мимо станции
    this.whistle = ctx.createOscillator();
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;
    this.whistle.connect(this.whistleGain).connect(this.mix);
    this.whistle.start();

    // Дрожание сигнала при неточной настройке и медленные замирания дальних станций
    this.flutterSrc = AudioKit.loop(ctx, AudioKit.smoothNoiseBuffer(ctx, 6, 14));
    this.fadeSrc = AudioKit.loop(ctx, AudioKit.smoothNoiseBuffer(ctx, 40, 0.25));

    for (const st of this.stations) this.attach(st);
  }

  // Станция → фильтр «расстройки» → громкость по силе сигнала → общий микс
  attach(st) {
    const ctx = this.ctx;
    const chain = {
      lp: AudioKit.filter(ctx, 'lowpass', 6000),
      level: ctx.createGain(),
      flutter: ctx.createGain(),
      fade: null,
    };
    chain.level.gain.value = 0;
    chain.flutter.gain.value = 0;
    st.build(ctx).connect(chain.lp).connect(chain.level).connect(this.mix);
    this.flutterSrc.connect(chain.flutter).connect(chain.level.gain);
    if (st.fading) {
      chain.fade = ctx.createGain();
      chain.fade.gain.value = 0;
      this.fadeSrc.connect(chain.fade).connect(chain.level.gain);
    }
    st.chain = chain;
  }

  detach(st) {
    const { chain } = st;
    if (!chain) return;
    st.output.disconnect();
    chain.level.disconnect();
    this.flutterSrc.disconnect(chain.flutter);
    if (chain.fade) this.fadeSrc.disconnect(chain.fade);
    st.chain = null;
  }

  tick() {
    const until = this.ctx.currentTime + LOOKAHEAD;
    for (const st of this.stations) st.schedule(until);
    this.applyTuning(); // у живых станций несущая появляется и пропадает сама
  }

  applyTuning() {
    let best = null;
    let bestE = 0;
    let bestC = 0;
    for (const st of this.stations) {
      const c = this.closeness(st);
      const e = this.signal(st);
      if (e > bestE) {
        best = st;
        bestE = e;
        bestC = c;
      }
    }
    this.best = bestE > 0.01 ? best : null;
    this.bestSignal = bestE;
    this.bestCloseness = bestC;
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const k = 0.04;
    for (const st of this.stations) {
      const c = this.closeness(st);
      const e = this.signal(st);
      st.chain.level.gain.setTargetAtTime(e, t, k);
      st.chain.flutter.gain.setTargetAtTime(e * (1 - c) * 0.9, t, k);
      if (st.chain.fade) st.chain.fade.gain.setTargetAtTime(e * 0.45 * st.fading, t, k);
      st.chain.lp.frequency.setTargetAtTime(450 + 6500 * c * c, t, k);
    }

    this.noiseGain.gain.setTargetAtTime(NOISE_LEVEL * Math.pow(1 - 0.96 * Math.min(1, bestE), 1.4), t, k);

    // Свист зависит от расстройки в долях ширины станции — одинаково на FM и в узких каналах раций
    let whistle = 0;
    let whistleFreq = 1000;
    if (best) {
      const x = Math.min(...this.listening().map((f) => Math.abs(f - best.freq))) / this.band.width;
      whistle = best.power * Math.exp(-(((x - 0.6) / 0.33) ** 2)) * 0.03;
      whistleFreq = Math.min(180 + 1350 * x, 6000); // дальше свист всё равно не слышен
    }
    this.whistleGain.gain.setTargetAtTime(whistle, t, k);
    this.whistle.frequency.setTargetAtTime(whistleFreq, t, 0.02);

    // Открывается сразу, закрывается с задержкой — отсюда характерное «кх-х» в конце передачи
    const open = this.monitor || this.squelchLevel === 0 || bestE >= this.squelchLevel;
    if (open !== this.squelchOpen) {
      this.squelchOpen = open;
      const g = this.squelchGate.gain;
      g.cancelScheduledValues(t);
      if (open) g.setTargetAtTime(1, t, 0.005);
      else g.setTargetAtTime(0, t + SQUELCH_TAIL, 0.02);
    }
  }
}
