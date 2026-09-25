'use strict';

/* Декодер Морзе на слух: слушает звук, который реально выходит из приёмника,
   ищет в нём ровный тон, меряет длину посылок и пауз и сам подстраивается под скорость.
   Ничего не знает о станциях заранее — одинаково разбирает маяк и живой эфир. */

const MORSE_DECODE = Object.fromEntries(Object.entries(MORSE).map(([ch, code]) => [code, ch]));

const CW_LOW = 250;   // Гц: где искать тон
const CW_HIGH = 1500;
const CW_WATCH = 3000; // Гц: до куда следить, чтобы в паузах было тихо (голос и треск занимают и верх)
const CW_LOCK = 20;   // дБ над шумом, чтобы поймать тон
const CW_KEY_ON = 15; // дБ над шумом: ключ нажат
const CW_KEY_OFF = 9; // дБ: ключ отпущен (гистерезис от дребезга)
const CW_PURE = 10;   // дБ: насколько тон должен быть громче всего остального в полосе
const CW_EDGE = 12;   // дБ ниже пика сигнала: фронт посылки (сильный тон режем посередине, а не у шума)
const CW_SYNC = 4;    // сколько посылок подряд на одной ноте, прежде чем верить, что это телеграф

class MorseDecoder {
  constructor(onChar) {
    this.onChar = onChar;
    this.tap = null;
    this.timer = null;
  }

  attach(engine) {
    if (this.tap || !engine.ctx) return;
    const tap = engine.ctx.createAnalyser();
    tap.fftSize = 512;               // окно ~11 мс: точки даже на 30 WPM не сливаются
    tap.smoothingTimeConstant = 0;   // сглаживание растянуло бы хвост каждой посылки
    engine.tap(tap);
    this.tap = tap;
    this.bins = new Float32Array(tap.frequencyBinCount);
    const binHz = engine.ctx.sampleRate / tap.fftSize;
    this.binHz = binHz;
    this.lo = Math.max(2, Math.floor(CW_LOW / binHz)); // с запасом: высоту меряем по соседним полосам
    this.hi = Math.min(this.bins.length - 3, Math.ceil(CW_WATCH / binHz));
    this.toneHi = Math.min(this.hi, Math.ceil(CW_HIGH / binHz));
    this.shape = new Float32Array(this.bins.length); // обычный уровень каждой полосы над медианой
    this.shapeReady = 0;
    this.ex = null;
    this.reset();
    this.timer = setInterval(() => this.poll(performance.now()), 10);
  }

  detach() {
    clearInterval(this.timer);
    this.timer = null;
    this.tap?.disconnect();
    this.tap = null;
  }

  reset() {
    this.tone = -1;       // полоса, где звучит тон
    this.cand = -1;       // кандидат на тон и сколько опросов подряд он держится
    this.candHits = 0;
    this.on = false;
    this.top = 0;         // пик сигнала на частоте тона, дБ над шумом
    this.since = performance.now();
    this.last = this.since;
    this.short = 90;      // средняя точка и тире, мс — подстраиваются под передающего
    this.long = 270;
    this.symbol = '';
    this.wordOpen = false;
    this.pitch = 0;       // высота тона передающего, Гц
    this.streak = 0;      // посылок подряд на этой высоте
    this.markHz = 0;      // сумма и число замеров высоты в текущей посылке
    this.markN = 0;
    this.dirty = 0;       // сколько опросов подряд в паузе звучит посторонний тон
  }

  poll(now) {
    // Вкладка была скрыта и таймер спал — длительности за это время не годятся
    if (now - this.last > 120) {
      this.reset();
      this.last = now;
      return;
    }
    this.last = now;

    const { bins, shape, lo, hi } = this;
    this.tap.getFloatFrequencyData(bins);
    const band = Array.from(bins.subarray(lo, hi + 1)).sort((a, b) => a - b);
    const median = band[band.length >> 1];
    if (!Number.isFinite(median)) return; // тишина: приёмник выключен или шумоподавитель закрыт

    // Шум «окрашен»: низы громче верхов. Запоминаем обычную форму спектра и сравниваем
    // с ней, иначе гул на 300 Гц примем за сигнал. Сильные пики форма догоняет медленно:
    // прерывистый телеграф остаётся над ней, а ровный свист биений за пару секунд уходит в фон.
    const warm = this.shapeReady < 50;
    const ex = this.ex ??= new Float32Array(bins.length);
    let peak = -1;
    for (let i = lo; i <= hi; i++) {
      const rel = bins[i] - median;
      if (this.shapeReady === 0) shape[i] = rel;
      ex[i] = rel - shape[i];
      shape[i] += (rel - shape[i]) * (warm ? 0.1 : ex[i] < CW_KEY_OFF ? 0.01 : 0.003);
      if (i <= this.toneHi && (peak < 0 || ex[i] > ex[peak])) peak = i;
    }
    if (warm) {
      this.shapeReady++;
      return;
    }
    const peakEx = ex[peak];

    // Тон считаем пойманным, если сильный пик держится на одном месте несколько опросов подряд
    if (peakEx > CW_LOCK) {
      if (Math.abs(peak - this.cand) <= 1) this.candHits++;
      else {
        this.cand = peak;
        this.candHits = 1;
      }
      if (this.candHits >= 3 && Math.abs(peak - this.tone) > 1) {
        this.tone = peak;
        this.top = peakEx;
      }
    }
    if (this.tone < 0) return;

    // Уровень на частоте тона и самое громкое вне его (окно БПФ размазывает тон на ±3 полосы)
    const b = this.tone;
    let level = -Infinity;
    let other = -Infinity;
    for (let i = lo; i <= hi; i++) {
      if (Math.abs(i - b) <= 1) level = Math.max(level, ex[i]);
      else if (Math.abs(i - b) > 3) other = Math.max(other, ex[i]);
    }
    // Порог — на середине между шумом и пиком сигнала: так фронты не «плывут»
    // и точки не удлиняются. Пик медленно забывается, если станция слабеет.
    this.top = level > this.top ? level : this.top - 0.05;
    const edge = this.top - CW_EDGE;
    // Голос и музыка — это много пиков сразу, телеграф — один чистый тон
    const keyed = this.on
      ? level > Math.max(CW_KEY_OFF, edge - 3)
      : level > Math.max(CW_KEY_ON, edge) && level - other > CW_PURE;

    if (keyed !== this.on) {
      if (this.on) this.mark(now - this.since);
      this.on = keyed;
      this.since = now;
      this.markHz = 0;
      this.markN = 0;
    }
    if (this.on) {
      this.measurePitch(b);
      return;
    }

    // У телеграфа в паузах тихо. Если между посылками звучит другой тон — это мелодия
    // или цифровой треск, а не ключ. Одиночный щелчок (стык пакетов) не в счёт.
    this.dirty = other > Math.max(CW_KEY_ON, this.top - 20) ? this.dirty + 1 : 0;
    if (this.dirty >= 2) {
      this.streak = 0;
      this.symbol = '';
    }

    // Пауза: после ~2 точек кончилась буква, после ~5 — слово
    const gap = now - this.since;
    if (this.symbol && gap > 2 * this.short) this.flushLetter();
    if (this.wordOpen && gap > 5 * this.short) {
      this.wordOpen = false;
      this.onChar(' ');
    }
  }

  // Точная высота тона: вершина параболы через три соседние полосы спектра
  measurePitch(b) {
    const { bins } = this;
    let k = b;
    if (bins[b - 1] > bins[k]) k = b - 1;
    if (bins[b + 1] > bins[k]) k = b + 1;
    const a = bins[k - 1];
    const c = bins[k + 1];
    const d = a - 2 * bins[k] + c;
    const shift = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
    this.markHz += (k + shift) * this.binHz;
    this.markN++;
  }

  // Телеграф звучит на одной ноте, а мелодия и цифровой треск прыгают по высоте
  samePitch(hz) {
    if (!this.pitch) return false;
    return Math.abs(hz - this.pitch) < Math.max(10, this.pitch * 0.025);
  }

  // Посылка закончилась: точка или тире? Две «корзины» длительностей, каждая
  // подтягивается к тому, что реально приходит, — так декодер находит скорость сам.
  mark(duration) {
    if (duration < 20 || !this.markN) return; // щелчок, а не посылка
    if (duration > 8 * this.long) { // несущая или голос, а не телеграф
      this.symbol = '';
      this.streak = 0;
      return;
    }
    const hz = this.markHz / this.markN;
    const same = this.samePitch(hz);
    if (same) {
      this.streak++;
      this.pitch += (hz - this.pitch) * 0.3;
    } else {
      // Другая нота — начинаем заново, прежние посылки были не отсюда
      this.pitch = hz;
      this.streak = 1;
      this.symbol = '';
    }
    const dot = duration < Math.sqrt(this.short * this.long);
    this.symbol += dot ? '.' : '-';
    if (this.symbol.length > 7) this.symbol = '';
    // Скорость учим только на телеграфе, иначе треск собьёт её так, что маяк не разобрать
    if (!same) return;
    if (dot) {
      this.short = Math.min(300, Math.max(25, this.short + (duration - this.short) * 0.3));
      this.long = Math.min(4 * this.short, Math.max(2 * this.short, this.long));
    } else {
      this.long = Math.min(1200, Math.max(60, this.long + (duration - this.long) * 0.3));
      this.short = Math.min(this.long / 2, Math.max(this.long / 4, this.short));
    }
  }

  flushLetter() {
    const ch = MORSE_DECODE[this.symbol];
    this.symbol = '';
    if (!ch || this.streak < CW_SYNC) return;
    this.wordOpen = true;
    this.onChar(ch);
  }
}
