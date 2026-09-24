'use strict';

/*
 * Мост рации для Android. Грузится до widget.js.
 * radioMobile включает в меню пункты SERVER и AUTO: сервер эфира выбирают сами,
 * как в приложении для ПК (своего сервера — пункт HOST — на телефоне нет).
 */
window.radioMobile = { platform: 'android' };

/*
 * Связь с сервером эфира — через Java (NativeSocketPlugin), а не через WebSocket из WebView.
 * WebView подписывает соединение «Origin: http://localhost», и серверы эфира, которые пускают
 * только свою страницу, его отклоняют. Из Java соединение идёт так же, как у рации на ПК.
 * Здесь — замена WebSocket ровно в том объёме, в котором её использует link.js.
 */
(() => {
  const BrowserSocket = window.WebSocket;
  let plugin = null;
  const sockets = new Map();
  let nextId = 1;

  function native() {
    if (plugin) return plugin;
    const cap = window.Capacitor;
    if (!cap?.isNativePlatform?.() || !cap.isPluginAvailable?.('NativeSocket')) return null;
    plugin = cap.registerPlugin('NativeSocket');
    plugin.addListener('socket', (e) => sockets.get(e.id)?.event(e));
    return plugin;
  }

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

  class NativeSocket {
    constructor(url) {
      this.id = nextId++;
      this.url = url;
      this.binaryType = 'arraybuffer';
      this.readyState = NativeSocket.CONNECTING;
      this.bufferedAmount = 0; // как у WebSocket: байты, ещё не ушедшие в сеть (по данным Java)
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      sockets.set(this.id, this);
      plugin.connect({ id: this.id, url }).catch(() => this.event({ type: 'close', code: 1006, reason: 'ОШИБКА АДРЕСА' }));
    }

    event(e) {
      if (e.type === 'open') {
        this.readyState = NativeSocket.OPEN;
        this.onopen?.({ type: 'open' });
      } else if (e.type === 'text') {
        this.onmessage?.({ type: 'message', data: e.data });
      } else if (e.type === 'binary') {
        this.onmessage?.({ type: 'message', data: fromBase64(e.data) });
      } else if (e.type === 'close' && this.readyState !== NativeSocket.CLOSED) {
        this.readyState = NativeSocket.CLOSED;
        sockets.delete(this.id);
        this.onclose?.({ type: 'close', code: e.code ?? 1006, reason: e.reason ?? '' });
      }
    }

    send(data) {
      if (this.readyState !== NativeSocket.OPEN) return;
      const msg = { id: this.id };
      if (typeof data === 'string') msg.text = data;
      else msg.binary = toBase64(data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      plugin.send(msg).then((r) => { this.bufferedAmount = r?.queued ?? 0; }, () => {});
    }

    close() {
      if (this.readyState === NativeSocket.CLOSED || this.readyState === NativeSocket.CLOSING) return;
      this.readyState = NativeSocket.CLOSING;
      plugin.close({ id: this.id }).catch(() => this.event({ type: 'close', code: 1000 }));
    }
  }
  Object.assign(NativeSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  // В приложении — через Java; при проверке в обычном браузере (npm run preview) — как было
  window.WebSocket = function WebSocket(url, protocols) {
    return native() ? new NativeSocket(url) : new BrowserSocket(url, protocols);
  };
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
})();

(() => {
  // Рация сделана под 300 px шириной — на экране телефона увеличиваем её целиком
  function fit() {
    const rig = document.getElementById('rig');
    if (!rig) return;
    rig.style.zoom = '1';
    const w = rig.offsetWidth + 20;
    const h = rig.offsetHeight;
    const zoom = Math.min(window.innerWidth / w, window.innerHeight / h);
    rig.style.zoom = String(Math.max(0.5, zoom));
  }

  window.addEventListener('resize', fit);
  document.addEventListener('DOMContentLoaded', () => {
    // Поле ввода текста — прозрачное поверх экрана рации: Android открывает клавиатуру только для
    // поля на экране, а тап по экрану во время ввода открывает её снова, если её закрыли
    const input = document.getElementById('text-entry');
    document.getElementById('lcd')?.append(input);
    fit();
  });

  // Долгое нажатие не должно открывать меню «копировать / выделить» и лупу
  document.addEventListener('contextmenu', (e) => e.preventDefault());
})();
