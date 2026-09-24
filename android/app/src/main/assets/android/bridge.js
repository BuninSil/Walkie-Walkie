'use strict';

/*
 * Адаптер ПК-рации под Android. Грузится первым, до скриптов рации; сами скрипты — без правок.
 *
 * 1. window.radioDesktop — то же, что на ПК даёт preload.js (оболочка Electron). С ним рация
 *    работает как ПК-приложение: пункты меню SERVER, AUTO, HOST, TOP и подключение при запуске.
 *    Чего у телефона нет (свой сервер, горячие клавиши, полоска поверх игр), отвечает «нет».
 * 2. WebSocket — через Java (AirSocket): сервер эфира видит телефон как ПК-рацию.
 * 3. Экран: рация на весь экран телефона, экранная клавиатура для ввода текста.
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
    onHotkey: () => {},

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

  document.addEventListener('DOMContentLoaded', () => {
    fit();
    // На ПК страница открыта с app:// и «своего» сервера у неё нет; здесь адрес страницы https://,
    // и link.js принял бы его за сервер. Сервер не выбран — пусть рация так и показывает
    const link = window.radioWidget?.link;
    if (link && !link.ws) link.url = null;
    // Ввод текста (позывной, адрес, ключ): рация фокусирует скрытое поле — открываем клавиатуру
    const input = document.getElementById('text-entry');
    input?.addEventListener('focus', () => shell?.showKeyboard());
    // Закрыли клавиатуру посреди ввода — тап по экрану рации открывает её снова
    document.getElementById('lcd')?.addEventListener('pointerdown', () => {
      if (document.activeElement === input) shell?.showKeyboard();
    });
  });

  // Долгое нажатие не должно открывать меню «копировать / выделить»
  document.addEventListener('contextmenu', (e) => e.preventDefault());
})();
