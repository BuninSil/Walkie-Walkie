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
          this.onopen?.({ type: 'open', target: this });
        } else if (e.type === 'text') {
          this.onmessage?.({ type: 'message', data: e.data, target: this });
        } else if (e.type === 'binary') {
          this.onmessage?.({ type: 'message', data: fromBase64(e.data), target: this });
        } else if (e.type === 'close') {
          if (this.readyState === AirWebSocket.CLOSED) return;
          this.readyState = AirWebSocket.CLOSED;
          sockets.delete(this.id);
          this.onclose?.({ type: 'close', code: e.code ?? 1006, target: this });
        }
      }

      send(data) {
        if (this.readyState !== AirWebSocket.OPEN) return;
        let queued;
        if (typeof data === 'string') {
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
    const zoom = Math.min(window.innerWidth / (rig.offsetWidth + 16), window.innerHeight / rig.offsetHeight);
    rig.style.zoom = String(Math.max(0.5, zoom));
  }
  window.addEventListener('resize', fit); // и под открытую клавиатуру: экран рации остаётся виден

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

  document.addEventListener('DOMContentLoaded', () => {
    fit();
    setupTorch();
    setupTextEntry();
    setupLook();
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

  // Долгое нажатие не должно открывать меню «копировать / выделить»
  document.addEventListener('contextmenu', (e) => e.preventDefault());
})();
