'use strict';

/*
 * Адаптер ПК-рации под Android. Грузится первым, до скриптов рации; сами скрипты — без правок.
 *
 * 1. window.radioDesktop — то же, что на ПК даёт preload.js (оболочка Electron). С ним рация
 *    работает как ПК-приложение: пункты меню SERVER, AUTO, HOST, TOP и подключение при запуске.
 *    Чего у телефона нет (свой сервер, горячие клавиши, полоска поверх игр), отвечает «нет».
 * 2. WebSocket — через Java (AirSocket): сервер эфира видит телефон как ПК-рацию.
 * 3. Экран: рация на весь экран телефона, ввод текста — окном Android.
 * 4. Кнопка PTT поверх приложений (нажатия приходят как горячая клавиша ПК), вибрация, внешний вид.
 */

(() => {
  const shell = window.WalkieShell;
  const air = window.AirSocket;

  /* ───────── 1. Оболочка, как preload.js на ПК ───────── */

  const ACTIONS = ['ptt', 'ab', 'chUp', 'chDown', 'mute', 'view', 'hide'];
  const hotkeyState = () => ({
    hooked: false,
    error: 'на телефоне нет',
    pttMode: 'hold',
    bindings: Object.fromEntries(ACTIONS.map((a) => [a, { combo: null, label: '' }])),
  });
  const bar = { opacity: 0.92, clickThrough: false };
  let hotkeyHandler = null;
  // Кнопка PTT поверх приложений нажимает рацию так же, как горячая клавиша на ПК
  window.__walkieHotkey = (action) => hotkeyHandler?.(action);

  window.radioDesktop = {
    hostStart: async () => ({ ok: false, error: 'на телефоне нет своего сервера' }),
    hostStop: async () => undefined,
    hostStatus: async () => null,

    setHotkeysActive: async () => true,
    hotkeys: async () => hotkeyState(),
    setHotkey: async () => hotkeyState(),
    setPttMode: async () => hotkeyState(),
    captureHotkey: async () => ({ cancelled: true }),
    cancelCapture: async () => undefined,
    onHotkey: (callback) => { hotkeyHandler = callback; },

    windowState: async () => ({ walkieOnly: true, mode: 'widget', view: 'widget', onTop: false, bar: { ...bar } }),
    switchMode: async () => false,
    setView: async () => false,
    setBarPanel: async () => undefined,
    setBarSettings: async () => ({ ...bar }),
    onBarAlt: () => {},
    setOnTop: async () => false,
    minimize: async () => shell?.minimize(),
    quit: async () => shell?.quit(),
  };

  /* ───────── Кто в сети ─────────
   * Сервер эфира не отдаёт список подключённых, но каждая включённая рация «стоит на канале»:
   * регистрируется станцией со своим позывным и частотой (welcome / station-on / station-off
   * приходят всем). Их и показываем; себя — по onair-ok. Кто говорит — по звуку, который доходит
   * до нас (сервер шлёт его только тем, кто рядом по частоте). Сервер для этого менять не нужно. */
  const net = {
    online: false,
    self: null,          // id своей станции на сервере
    myName: '',
    myFreqs: [],         // что сейчас слушает рация (из tune)
    people: new Map(),   // id → { id, freq, name, since }
    heard: new Map(),    // id → когда последний раз пришёл звук
    listeners: new Set(),
    changed() {
      for (const fn of this.listeners) fn();
    },
    reset() {
      this.people.clear();
      this.heard.clear();
      this.self = null;
    },
    fromServer(text) {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const put = (st) => {
        if (!st || !Number.isInteger(st.id) || !Number.isFinite(st.freq)) return;
        if (st.freq === 470 && String(st.name).startsWith('⌁')) return; // канал данных отряда — не человек
        const was = this.people.get(st.id);
        this.people.set(st.id, { id: st.id, freq: st.freq, name: String(st.name ?? ''), since: was?.since ?? Date.now() });
      };
      switch (msg?.type) {
        case 'welcome':
          this.reset();
          (Array.isArray(msg.stations) ? msg.stations : []).forEach(put);
          break;
        case 'station-on': put(msg.station); break;
        case 'station-off':
          this.people.delete(msg.id);
          this.heard.delete(msg.id);
          break;
        case 'onair-ok': this.self = msg.station?.id ?? null; break;
        default: return;
      }
      this.changed();
    },
    toServer(text) {
      if (!text.includes('"tune"') && !text.includes('"onair"')) return;
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'tune') this.myFreqs = (Array.isArray(msg.freqs) ? msg.freqs : [msg.freq]).map(Number).filter(Number.isFinite);
        else if (msg.type === 'onair') this.myName = String(msg.name ?? '');
      } catch {
        /* не JSON */
      }
    },
    audio(buffer) {
      if (buffer.byteLength < 4) return;
      const id = new DataView(buffer).getUint32(0);
      if (id !== this.self) this.heard.set(id, Date.now());
    },
  };
  window.__walkieNet = net;

  /* ───────── 2. WebSocket через Java ───────── */

  if (air) {
    const sockets = new Map();
    let nextId = 1;

    const toBase64 = (bytes) => {
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(text);
    };
    const fromBase64 = (b64) => {
      const text = atob(b64);
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
      return bytes.buffer;
    };

    class AirWebSocket {
      constructor(url) {
        this.url = String(url);
        this.data = this.url.includes('data=1'); // служебный канал отряда (squad.js) — не эфир
        this.id = nextId++;
        this.binaryType = 'arraybuffer';
        this.readyState = AirWebSocket.CONNECTING;
        this.bufferedAmount = 0;
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        sockets.set(this.id, this);
        air.open(this.id, this.url);
      }

      event(e) {
        if (e.type === 'open') {
          this.readyState = AirWebSocket.OPEN;
          if (!this.data) net.online = true;
          this.onopen?.({ type: 'open', target: this });
        } else if (e.type === 'text') {
          if (!this.data) net.fromServer(e.data);
          this.onmessage?.({ type: 'message', data: e.data, target: this });
        } else if (e.type === 'binary') {
          const data = fromBase64(e.data);
          if (!this.data) net.audio(data);
          this.onmessage?.({ type: 'message', data, target: this });
        } else if (e.type === 'close') {
          if (this.readyState === AirWebSocket.CLOSED) return;
          this.readyState = AirWebSocket.CLOSED;
          sockets.delete(this.id);
          if (!this.data && ![...sockets.values()].some((x) => !x.data)) {
            net.online = false;
            net.reset();
            net.changed();
          }
          this.onclose?.({ type: 'close', code: e.code ?? 1006, target: this });
        }
      }

      send(data) {
        if (this.readyState !== AirWebSocket.OPEN) return;
        let queued;
        if (typeof data === 'string') {
          if (!this.data) net.toServer(data);
          queued = air.sendText(this.id, data);
        } else {
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          queued = air.sendBinary(this.id, toBase64(bytes));
        }
        this.bufferedAmount = typeof queued === 'number' ? queued : 0;
      }

      close() {
        if (this.readyState >= AirWebSocket.CLOSING) return;
        this.readyState = AirWebSocket.CLOSING;
        air.close(this.id);
      }
    }
    Object.assign(AirWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

    window.__airSocket = (e) => sockets.get(e.id)?.event(e);
    window.WebSocket = AirWebSocket;
  }

  /* ───────── 3. Экран телефона ───────── */

  // Рация сделана под окно 300 px — увеличиваем её целиком на весь экран
  function fit() {
    const rig = document.getElementById('rig');
    if (!rig) return;
    rig.style.zoom = '1';
    // Высокая антенна поднимает рацию (margin-top) — её тоже вписываем в экран
    const top = parseFloat(getComputedStyle(rig).marginTop) || 0;
    const zoom = Math.min(window.innerWidth / (rig.offsetWidth + 16), window.innerHeight / (rig.offsetHeight + top));
    rig.style.zoom = String(Math.max(0.5, zoom));
  }
  window.addEventListener('resize', fit); // и под открытую клавиатуру: экран рации остаётся виден
  window.__walkieFit = fit; // внешний вид поменял высоту (антенна) — вписать заново

  // Фонарик рации (боковая кнопка ☼) включает и настоящий фонарик телефона
  function setupTorch() {
    const rig = document.getElementById('rig');
    if (!rig || !shell?.torch) return;
    let on = false;
    new MutationObserver(() => {
      const now = rig.classList.contains('torch-on');
      if (now !== on) {
        on = now;
        shell.torch(on);
      }
    }).observe(rig, { attributes: true, attributeFilter: ['class'] });
  }

  /* ───────── SOS: долгое нажатие на ☼, как тревога на настоящей рации ─────────
   * Фонарик мигает «··· ——— ···», тот же сигнал тоном уходит в эфир на рабочем канале
   * (≈5 с сигнал, 5 с пауза — услышать ответ), на экране мигает SOS. Короткое нажатие на ☼ — стоп. */
  const SOS_UNIT = 150; // мс — длина точки
  const SOS_MS = 5100;  // один круг «SOS» с паузой между словами
  const SOS_PAUSE = 5000;
  // Вкл/выкл по порядку в единицах: S (···) пауза O (———) пауза S (···) и пауза до следующего круга
  const SOS_PATTERN = [1, 1, 1, 1, 1, 3, 3, 1, 3, 1, 3, 3, 1, 1, 1, 1, 1, 7];

  function setupSos() {
    const key = document.getElementById('side2');
    const lcd = document.getElementById('lcd');
    const w = () => window.radioWidget;
    if (!key || !lcd) return;
    const label = document.createElement('div');
    label.className = 'wk-sos';
    label.textContent = 'SOS';
    label.hidden = true;
    lcd.append(label);

    let holdTimer = null;
    let swallowClick = false;
    let active = false;
    let timers = [];
    let tone = null;

    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    const torchPhone = (on) => shell?.torch?.(on);

    function flashLoop() {
      if (!active) return;
      let t = 0;
      SOS_PATTERN.forEach((units, i) => {
        const on = i % 2 === 0;
        later(() => active && torchPhone(on), t);
        t += units * SOS_UNIT;
      });
      later(flashLoop, t);
    }

    // Тон SOS: в эфир (через передатчик рации) и тихо — в свой динамик
    function playTone(ctx, toAir) {
      const osc = ctx.createOscillator();
      const air = ctx.createGain();
      const local = ctx.createGain();
      osc.frequency.value = 1000;
      air.gain.value = 0;
      local.gain.value = 0;
      osc.connect(air);
      osc.connect(local);
      if (toAir) air.connect(toAir);
      local.connect(ctx.destination);
      let t = ctx.currentTime + 0.05;
      SOS_PATTERN.forEach((units, i) => {
        const on = i % 2 === 0 && i < SOS_PATTERN.length - 1;
        air.gain.setValueAtTime(on ? 0.45 : 0, t);
        local.gain.setValueAtTime(on ? 0.08 : 0, t);
        t += (units * SOS_UNIT) / 1000;
      });
      osc.start();
      osc.stop(t);
      return osc;
    }

    function airCycle() {
      if (!active) return;
      const r = w();
      if (!r?.radio.power) return stop();
      window.__walkieHotkey?.('ptt-down'); // как горячая клавиша на ПК — рация выходит в эфир
      let waited = 0;
      const go = () => {
        if (!active) return;
        const b = r.broadcaster;
        if (!r.tx.active || !b?.ctx) {
          if ((waited += 100) > 3000) return later(airCycle, SOS_PAUSE); // нет связи/микрофона — попробуем позже
          return later(go, 100);
        }
        b.micGain?.gain.setValueAtTime(0, b.ctx.currentTime); // голос не мешает сигналу
        tone = playTone(b.ctx, b.txIn);
        later(() => {
          if (b.micGain) b.micGain.gain.setValueAtTime(b.micLevel ?? 1, b.ctx.currentTime);
          window.__walkieHotkey?.('ptt-up');
          later(airCycle, SOS_PAUSE);
        }, SOS_MS + 100);
      };
      go();
    }

    function start() {
      const r = w();
      if (active || !r?.radio.power) return;
      active = true;
      window.__walkieSquadSos?.(true); // и координаты отряду (squad.js)
      label.hidden = false;
      shell?.vibrate?.();
      flashLoop();
      airCycle();
    }

    function stop() {
      if (!active) return;
      active = false;
      window.__walkieSquadSos?.(false);
      timers.forEach(clearTimeout);
      timers = [];
      try {
        tone?.stop();
      } catch {
        /* уже остановлен */
      }
      tone = null;
      const r = w();
      const b = r?.broadcaster;
      if (b?.micGain && b.ctx) b.micGain.gain.setValueAtTime(b.micLevel ?? 1, b.ctx.currentTime);
      if (r?.tx.active && r.tx.source === 'hotkey') window.__walkieHotkey?.('ptt-up');
      label.hidden = true;
      torchPhone(document.getElementById('rig')?.classList.contains('torch-on') ?? false); // как у рации
    }

    key.addEventListener('pointerdown', () => {
      clearTimeout(holdTimer);
      if (active) return;
      holdTimer = setTimeout(() => {
        swallowClick = true; // это было долгое нажатие — фонарик рации не переключаем
        start();
      }, 900);
    });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) key.addEventListener(t, () => clearTimeout(holdTimer));
    // Щелчок после долгого нажатия и щелчок-«стоп» не должны переключать фонарик рации
    document.addEventListener('click', (e) => {
      if (!e.target.closest?.('#side2')) return;
      if (swallowClick || active) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (!swallowClick) stop();
        swallowClick = false;
      }
    }, true);
    // Выключили рацию — тревогу тоже
    new MutationObserver(() => {
      if (document.getElementById('rig')?.dataset.power === 'off') stop();
    }).observe(document.getElementById('rig'), { attributes: true, attributeFilter: ['data-power'] });
  }

  /* ───────── Плашка «Что нового» после обновления ─────────
   * Версия поменялась — берём описание этого релиза с GitHub (раздел «## Новое…») и показываем
   * списком. Нет интернета — покажем в следующий раз. Первая установка — молча запоминаем версию. */
  function whatsNew(version, tag, hadData, css) {
    const SEEN = 'walkie.seenVersion';
    let seen = null;
    try {
      seen = localStorage.getItem(SEEN);
    } catch {
      return;
    }
    if (!version || seen === version) return;
    if (!seen && !hadData) {
      localStorage.setItem(SEEN, version);
      return;
    }
    fetch(`https://api.github.com/repos/BuninSil/Walkie-Walkie/releases/tags/${tag}`, { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((rel) => {
        const items = notesList(rel?.body || '');
        if (items) showPlate(version, items, css);
        try {
          localStorage.setItem(SEEN, version);
        } catch {
          /* покажем ещё раз — не страшно */
        }
      })
      .catch(() => { /* нет сети — в следующий раз */ });
  }

  // Из Markdown релиза — пункты раздела «## Новое…» (или первого списка) с вложенными
  function notesList(md) {
    const lines = md.replace(/\r/g, '').split('\n');
    let start = lines.findIndex((l) => /^##\s+Новое/i.test(l));
    if (start < 0) start = lines.findIndex((l) => /^\s*[-*]\s/.test(l)) - 1;
    if (start < -1) return null;
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^##\s/.test(l)) break;
      const m = /^(\s*)[-*]\s+(.*)$/.exec(l);
      if (m) out.push({ level: m[1].length >= 2 ? 1 : 0, text: m[2] });
      else if (out.length && l.trim() && !/^\s*$/.test(l) && /^\s{2,}/.test(l)) out[out.length - 1].text += ` ${l.trim()}`;
      else if (out.length && !l.trim()) break;
    }
    return out.length ? out : null;
  }

  function inline(text) {
    const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return esc.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  }

  function showPlate(version, items, css) {
    const wrap = document.createElement('div');
    wrap.className = 'wn';
    const card = document.createElement('div');
    card.className = 'wn__card';
    const head = document.createElement('div');
    head.className = 'wn__head';
    head.innerHTML = `<span>✨</span><b>Обновлено до ${inline(version)}</b>`;
    const list = document.createElement('ul');
    list.className = 'wn__list';
    list.innerHTML = items.map((it) => `<li class="${it.level ? 'is-sub' : ''}">${inline(it.text)}</li>`).join('');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'wn__ok';
    ok.textContent = 'Понятно';
    const close = () => {
      wrap.classList.add('is-out');
      setTimeout(() => wrap.remove(), 250);
    };
    ok.addEventListener('click', close);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close();
    });
    card.append(head, list, ok);
    wrap.append(card);
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    document.body.append(wrap);
  }

  const WN_CSS = `
    .wn { position: fixed; inset: 0; z-index: 80; display: flex; align-items: flex-start; justify-content: center;
      padding: 14px 12px; background: rgba(5, 6, 8, 0.45); animation: wn-in 0.25s ease-out; touch-action: pan-y; }
    .wn.is-out { animation: wn-out 0.25s ease-in forwards; }
    .wn__card { width: 100%; max-width: 440px; max-height: 70vh; display: flex; flex-direction: column;
      border: 1px solid #2c2d33; border-radius: 16px; background: linear-gradient(180deg, #1f2025, #15161a);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6); color: #ecebe6; font: 14px/1.4 system-ui, sans-serif; overflow: hidden; }
    .wn__head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 6px; font-size: 16px; }
    .wn__list { margin: 0; padding: 4px 18px 4px 34px; overflow-y: auto; }
    .wn__list li { margin: 5px 0; }
    .wn__list li.is-sub { margin-left: 16px; list-style: circle; color: #c9c6be; font-size: 13px; }
    .wn__list b { color: #fff; }
    .wn__list code { font-size: 12px; color: #c9c6be; }
    .wn__ok { margin: 10px 14px 14px; padding: 11px; border: 0; border-radius: 12px; background: var(--wn-accent, #ff9a3c);
      color: #141414; font: 700 15px system-ui, sans-serif; }
    @keyframes wn-in { from { opacity: 0; transform: translateY(-16px); } }
    @keyframes wn-out { to { opacity: 0; transform: translateY(-16px); } }
  `;

  document.addEventListener('DOMContentLoaded', () => {
    fit();
    setupTorch();
    setupSos();
    // Версия — из Android; «уже была рация» — есть её сохранённые настройки
    let version = null;
    try {
      version = JSON.parse(shell?.options?.() || '{}').version;
    } catch {
      /* нет версии — нет плашки */
    }
    let hadData = false;
    try {
      hadData = Boolean(localStorage.getItem('radio.widget.v1'));
    } catch {
      /* пусто */
    }
    setTimeout(() => whatsNew(version, `v${version}`, hadData, WN_CSS.replace('var(--wn-accent, #ff9a3c)', 'var(--label-alt, #ff9a3c)')), 1200);
    setupTextEntry();
    setupLook();
    setupNet();
    setupMicRelease();
    // На ПК страница открыта с app:// и «своего» сервера у неё нет; здесь адрес страницы https://,
    // и link.js принял бы его за сервер. Сервер не выбран — пусть рация так и показывает
    const link = window.radioWidget?.link;
    if (link && !link.ws) link.url = null;
  });

  /* ───────── Микрофон — только на время передачи ─────────
   * На ПК рация держит микрофон открытым с первой передачи. На Android открытый микрофон WebView
   * переводит весь телефон в режим звонка: звук застревает в динамике, наушники не подхватываются —
   * и у других приложений тоже. Поэтому после передачи микрофон отпускаем (со следующей передачей
   * рация откроет его сама, как в первый раз). С VOX микрофон нужен всё время — тогда не трогаем. */
  const MIC_IDLE_MS = 1500;

  function setupMicRelease() {
    let idleSince = 0;
    setInterval(() => {
      const w = window.radioWidget;
      const tx = w?.tx;
      if (!w?.broadcaster?.mic || !tx) return;
      if (tx.active || tx.starting || tx.stopping || w.cfg.vox > 0) {
        idleSince = 0;
        return;
      }
      if (!idleSince) idleSince = Date.now();
      else if (Date.now() - idleSince >= MIC_IDLE_MS) {
        idleSince = 0;
        w.broadcaster.setMic(false);
      }
    }, 500);
  }

  /* ───────── Ввод текста: окно Android вместо клавиатуры компьютера ─────────
   * Рация начинает ввод, фокусируя скрытое поле (как на ПК). Мы показываем окно Android с полем
   * ввода, а ответ отдаём рации так же, как клавиатура ПК: текст в поле и Enter (или Esc — отмена). */
  function setupTextEntry() {
    const input = document.getElementById('text-entry');
    if (!input || !shell?.editText) return;
    input.inputMode = 'none'; // своя клавиатура у окна ввода; у скрытого поля — не нужна
    let open = false;
    input.addEventListener('focus', () => {
      if (open) return;
      open = true;
      // Что вводим, рация пишет на экране (NAME, SERVER, SCR) — уже после фокуса
      setTimeout(() => shell.editText(document.getElementById('menu-code')?.textContent || '', input.value), 0);
    });
    window.__walkieText = ({ ok, text }) => {
      open = false;
      if (ok) input.value = text;
      const key = ok ? 'Enter' : 'Escape';
      input.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
    };
  }

  /* ───────── Внешний вид и настройки телефона ───────── */

  // Цвета, темы, шрифты, фоны и неон — в look.js (window.WalkieLook)

  // Настройки, которые живут в Android (кнопка поверх, экран), — через WalkieShell
  let native = {};
  const readNative = () => {
    try {
      native = JSON.parse(shell?.options?.() || '{}');
    } catch {
      native = {};
    }
  };
  window.__walkieOptions = (o) => {
    native = o;
    renderPanel();
  };

  let panel = null;

  function setupLook() {
    readNative();

    // Шестерёнка — рядом со «свернуть» и «закрыть», как кнопки окна на ПК
    const chrome = document.getElementById('chrome');
    const gear = document.createElement('button');
    gear.className = 'chrome__btn';
    gear.id = 'win-settings';
    gear.type = 'button';
    gear.title = 'Настройки';
    gear.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.8 1h2.4l.4 1.9 1.2.5 1.6-1.1 1.7 1.7-1.1 1.6.5 1.2 1.9.4v2.4l-1.9.4-.5 1.2 1.1 1.6-1.7 1.7-1.6-1.1-1.2.5-.4 1.9H6.8l-.4-1.9-1.2-.5-1.6 1.1-1.7-1.7 1.1-1.6-.5-1.2L.6 9.2V6.8l1.9-.4.5-1.2-1.1-1.6 1.7-1.7 1.6 1.1 1.2-.5zM8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8"/></svg>';
    gear.addEventListener('click', () => openPanel(true));
    chrome?.prepend(gear);

    // Вибрация — как щелчок настоящей кнопки
    const buzz = () => window.WalkieLook?.haptics !== false && shell?.vibrate?.();
    for (const el of document.querySelectorAll('.key, #ptt, .side__key, #knob')) el.addEventListener('pointerdown', buzz);

    panel = document.createElement('div');
    panel.className = 'wk-panel';
    panel.hidden = true;
    panel.addEventListener('click', (e) => {
      if (e.target === panel) openPanel(false);
    });
    document.body.append(panel);
  }

  function openPanel(open) {
    if (open) readNative();
    panel.hidden = !open;
    if (open) renderPanel();
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function toggle(label, note, on, change) {
    const row = el('label', 'wk-row');
    const text = el('span', 'wk-row__text', label);
    if (note) text.append(el('small', null, note));
    const sw = el('button', 'wk-switch');
    sw.type = 'button';
    sw.setAttribute('aria-pressed', String(Boolean(on)));
    sw.append(el('span'));
    sw.addEventListener('click', () => change(!on));
    row.append(text, sw);
    return row;
  }

  function updateText(u) {
    const cur = `Версия ${u.current || native.version || ''}`;
    switch (u.state) {
      case 'checking': return `${cur} · проверяю…`;
      case 'latest': return `${cur} · последняя`;
      case 'available': return `${cur} · есть ${u.latest}`;
      case 'downloading': return `${cur} · скачиваю ${u.latest}: ${u.progress || 0}%`;
      case 'ready': return `${cur} · ${u.latest} скачана`;
      case 'installing': return `${cur} · ставлю ${u.latest}…`;
      case 'confirm': return `${cur} · подтвердите установку ${u.latest}`;
      default: return cur;
    }
  }

  function updateButton(u) {
    if (u.state === 'available') return 'Скачать';
    if (u.state === 'ready' || u.state === 'confirm') return u.canInstall ? 'Установить' : 'Разрешить';
    if (u.state === 'downloading' || u.state === 'installing') return '…';
    return 'Проверить';
  }

  function renderPanel() {
    if (!panel || panel.hidden) return;
    const sheet = el('div', 'wk-sheet');
    sheet.append(el('h2', null, 'Настройки рации'));

    const lookBtn = el('button', 'wk-look', '🎨  Внешний вид и темы');
    lookBtn.type = 'button';
    lookBtn.addEventListener('click', () => {
      openPanel(false);
      window.WalkieLook?.open();
    });
    sheet.append(lookBtn);

    const sec = el('section', 'wk-sec');
    sec.append(el('h3', null, 'Телефон'));
    sec.append(toggle('Кнопка PTT поверх приложений', 'Держите — говорите, тап — открыть рацию', native.bubble,
      (on) => shell?.setOption?.('bubble', on)));
    sec.append(toggle('На экране блокировки', 'Кнопка PTT и рация без разблокировки', native.lockScreen !== false,
      (on) => shell?.setOption?.('lockScreen', on)));
    sec.append(toggle('Делиться местом с отрядом', 'Карта 📍: ваша точка видна тем, кто на сервере (с ключом SCR — только им)', native.shareLocation,
      (on) => shell?.setOption?.('shareLocation', on)));
    sec.append(toggle('Кто вышел в сеть', 'Уведомление, когда кто-то включил рацию или станция вышла в эфир', native.joinAlerts !== false,
      (on) => shell?.setOption?.('joinAlerts', on)));
    sec.append(toggle('Не гасить экран', 'Пока рация открыта', native.keepScreen,
      (on) => shell?.setOption?.('keepScreen', on)));
    sheet.append(sec);

    // Обновления из релизов GitHub
    const up = native.update || {};
    const usec = el('section', 'wk-sec');
    usec.append(el('h3', null, 'Обновления'));
    const urow = el('div', 'wk-row');
    const utext = el('span', 'wk-row__text', updateText(up));
    if (up.error) utext.append(el('small', null, up.error));
    const ubtn = el('button', 'wk-btn', updateButton(up));
    ubtn.type = 'button';
    ubtn.disabled = ['checking', 'downloading', 'installing'].includes(up.state);
    ubtn.addEventListener('click', () => shell?.update?.());
    urow.append(utext, ubtn);
    usec.append(urow);
    usec.append(toggle('Обновлять автоматически', 'Скачать и поставить, когда рация не передаёт', up.auto !== false,
      (on) => shell?.setUpdateAuto?.(on)));
    sheet.append(usec);

    const done = el('button', 'wk-done', 'Готово');
    done.type = 'button';
    done.addEventListener('click', () => openPanel(false));
    sheet.append(done);
    sheet.append(el('p', 'wk-ver', `Рация для Android${native.version ? ` ${native.version}` : ''} · Авторы: BuninSil и Valex`));
    panel.replaceChildren(sheet);
  }

  /* ───────── Кто в сети: кнопка 👥 над рацией ───────── */

  const UHF_CHANNEL = 0.006; // как на сервере: у раций узкие каналы
  const FM_CHANNEL = 0.2;
  let netPanel = null;
  let netTimer = 0;

  function fmtFreq(f) {
    if (f < 300) return `${f.toFixed(1)} FM`;
    let t = f.toFixed(5).replace(/0+$/, '');
    if (t.split('.')[1].length < 3) t = f.toFixed(3);
    return t;
  }

  function fmtSince(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'только что';
    if (min < 60) return `${min} мин`;
    const h = Math.floor(min / 60);
    return h < 24 ? `${h} ч ${min % 60} мин` : `${Math.floor(h / 24)} д`;
  }

  /* Тап по человеку — рация переходит на его частоту. Частоту крутим так же, как её крутит
   * горячая клавиша «канал вверх» на ПК (stepTuning в рации): встаём на шаг ниже и делаем шаг
   * вверх — рация сама перестроит приёмник, скажет серверу и сохранит канал. */
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  const PLANS = { // как в рации: PMR и LPD
    PMR: Array.from({ length: 16 }, (_, i) => r5(446.00625 + i * 0.0125)),
    LPD: Array.from({ length: 69 }, (_, i) => r5(433.075 + i * 0.025)),
  };
  const STEPS = [2.5, 5, 6.25, 10, 12.5, 25];

  function tuneTo(f) {
    const w = window.radioWidget;
    if (!w || !window.__walkieHotkey) return 'Рация ещё не готова';
    if (!w.radio.power) return 'Сначала включите рацию';
    if (w.tx.active) return 'Отпустите PTT';
    const step = (dir) => window.__walkieHotkey(dir > 0 ? 'chUp' : 'chDown');
    if (f < 300) {
      w.radio.fm = true;
      const up = f - 0.1 >= 87.5;
      w.radio.fmFreq = r5(up ? f - 0.1 : f + 0.1);
      step(up ? 1 : -1);
      return null;
    }
    w.radio.fm = false;
    const v = w.vfo[w.radio.active];
    // Рация в режиме каналов (MR), а частота — канал PMR/LPD: выбираем его номер
    if (v.mode === 'mr') {
      for (const [plan, list] of Object.entries(PLANS)) {
        const i = list.findIndex((c) => Math.abs(c - f) < 1e-6);
        if (i < 0) continue;
        v.plan = plan;
        v.ch = (i - 1 + list.length) % list.length;
        step(1);
        return null;
      }
    }
    // Частота (VFO): шаг, в сетку которого она попадает; настройку шага пользователя возвращаем
    const keep = w.cfg.step;
    let s = STEPS.findIndex((k) => Math.abs(Math.round(f / (k / 1000)) * (k / 1000) - f) < 1e-6);
    if (s < 0) s = 0;
    const d = STEPS[s] / 1000;
    v.mode = 'vfo';
    w.cfg.step = s;
    const up = f - d >= 400;
    v.freq = r5(up ? f - d : f + d);
    step(up ? 1 : -1);
    w.cfg.step = keep;
    return null;
  }

  const onMyChannel = (f) => net.myFreqs.some((m) => Math.abs(m - f) <= (f < 300 ? FM_CHANNEL : UHF_CHANNEL));

  function setupNet() {
    const chrome = document.getElementById('chrome');
    const btn = document.createElement('button');
    btn.className = 'chrome__btn wk-net-btn';
    btn.id = 'win-net';
    btn.type = 'button';
    btn.title = 'Кто в сети';
    btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5m5.6.2a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2M0 13.6C0 11 2.4 9 5.5 9S11 11 11 13.6V14H0zm11.9.4v-.4c0-1.4-.5-2.7-1.4-3.7l.6-.1c2.7 0 4.9 1.8 4.9 4.1v.1z"/></svg><b class="wk-net-count" hidden></b>';
    btn.addEventListener('click', () => openNet(true));
    const gear = document.getElementById('win-settings');
    if (gear) gear.after(btn);
    else chrome?.prepend(btn);

    netPanel = document.createElement('div');
    netPanel.className = 'wk-panel';
    netPanel.hidden = true;
    netPanel.addEventListener('click', (e) => {
      if (e.target === netPanel) openNet(false);
    });
    document.body.append(netPanel);

    const badge = btn.querySelector('.wk-net-count');
    const refreshBadge = () => {
      const n = net.people.size;
      badge.hidden = !net.online || n === 0;
      badge.textContent = n > 99 ? '99+' : String(n);
      btn.classList.toggle('is-offline', !net.online);
    };
    net.listeners.add(refreshBadge);
    net.listeners.add(renderNet);
    refreshBadge();
  }

  function openNet(open) {
    netPanel.hidden = !open;
    clearInterval(netTimer);
    if (open) {
      renderNet();
      netTimer = setInterval(renderNet, 1000); // «говорит» и «в сети N мин» — живые
    }
  }

  function personRow(p, now) {
    const row = el(p.id >= 0 ? 'button' : 'div', 'wk-row wk-person');
    if (p.id >= 0) {
      row.type = 'button';
      row.addEventListener('click', () => {
        const err = onMyChannel(p.freq) ? null : tuneTo(p.freq);
        if (err) {
          netNote(err);
          return;
        }
        shell?.vibrate?.();
        openNet(false);
      });
    }
    const talking = now - (net.heard.get(p.id) ?? 0) < 1200;
    if (talking) row.classList.add('is-talking');
    const text = el('span', 'wk-row__text');
    const name = el('b', 'wk-person__name', p.name || 'Без позывного');
    text.append(name, el('small', null, talking ? 'говорит' : `в сети ${fmtSince(now - p.since)}`));
    const freq = el('span', 'wk-person__freq', fmtFreq(p.freq));
    row.append(el('i', 'wk-person__dot'), text, freq);
    return row;
  }

  // «БУНИН в сети» — плашка сверху, пока рация открыта (из Java, вместе с уведомлением Android).
  // Нажать — перейти на его частоту.
  let joinBox = null;
  window.__walkieJoined = (name, freq) => {
    if (!joinBox) {
      joinBox = el('div', 'wk-joins');
      document.body.append(joinBox);
    }
    const fm = freq > 0 && freq < 300;
    const item = el('button', 'wk-join');
    item.type = 'button';
    item.append(el('b', null, `${fm ? '📻' : '📡'} ${name}`), el('span', null, `${fm ? 'в эфире' : 'в сети'} · ${fmtFreq(freq)}${onMyChannel(freq) ? ' · ваш канал' : ''}`));
    const drop = () => {
      item.classList.add('is-gone');
      setTimeout(() => item.remove(), 250);
    };
    item.addEventListener('click', () => {
      const err = onMyChannel(freq) ? null : tuneTo(freq);
      if (!err) shell?.vibrate?.();
      drop();
    });
    joinBox.append(item);
    while (joinBox.children.length > 3) joinBox.firstChild.remove();
    setTimeout(drop, 4500);
  };

  let netMsg = null;
  function netNote(text) {
    netMsg = { text, until: Date.now() + 2500 };
    renderNet();
  }

  function renderNet() {
    if (!netPanel || netPanel.hidden) return;
    const now = Date.now();
    const sheet = el('div', 'wk-sheet');
    const people = [...net.people.values()].filter((p) => p.id !== net.self)
      .sort((a, b) => a.freq - b.freq || a.name.localeCompare(b.name, 'ru'));
    sheet.append(el('h2', null, net.online ? `Кто в сети · ${people.length}` : 'Кто в сети'));
    if (netMsg && netMsg.until > now) sheet.append(el('p', 'wk-net-warn', netMsg.text));

    if (!net.online) {
      sheet.append(el('p', 'wk-net-note', 'Нет связи с сервером. Подключитесь: MENU → SERVER, или проверьте интернет (на мобильном — через VPN).'));
    } else {
      const me = el('section', 'wk-sec');
      me.append(el('h3', null, 'Вы'));
      me.append(personRow({ id: -1, name: net.myName || 'Без позывного', freq: net.myFreqs[0] ?? 0, since: now }, now));
      me.querySelector('small').textContent = net.myFreqs.length > 1 ? `слушаете ${net.myFreqs.map(fmtFreq).join(' и ')}` : 'это вы';
      if (!net.myFreqs.length) me.querySelector('.wk-person__freq').textContent = '—';
      sheet.append(me);

      const groups = [
        ['На вашем канале', people.filter((p) => onMyChannel(p.freq))],
        ['Рации', people.filter((p) => p.freq >= 300 && !onMyChannel(p.freq))],
        ['FM-станции', people.filter((p) => p.freq < 300 && !onMyChannel(p.freq))],
      ];
      for (const [title, list] of groups) {
        if (!list.length) continue;
        const sec = el('section', 'wk-sec');
        sec.append(el('h3', null, `${title} · ${list.length}`));
        for (const p of list) sec.append(personRow(p, now));
        sheet.append(sec);
      }
      if (!people.length) sheet.append(el('p', 'wk-net-note', 'Кроме вас никого нет. Рация видна в сети, пока она включена.'));
      sheet.append(el('p', 'wk-net-note', 'Видны все включённые рации и станции на этом сервере. Нажмите на человека — рация перейдёт на его частоту. «Говорит» — у тех, чей эфир доходит до вашего канала.'));
    }

    const done = el('button', 'wk-done', 'Готово');
    done.type = 'button';
    done.addEventListener('click', () => openNet(false));
    sheet.append(done);
    const keep = netPanel.querySelector('.wk-sheet')?.scrollTop ?? 0;
    netPanel.replaceChildren(sheet);
    sheet.scrollTop = keep;
  }

  // Долгое нажатие не должно открывать меню «копировать / выделить»
  document.addEventListener('contextmenu', (e) => e.preventDefault());
})();
