'use strict';

/*
 * Горячие клавиши, которые работают из любого окна (в том числе в играх).
 *
 * Основной способ — uiohook-napi: слушает клавиатуру и мышь всей системы, как Discord для
 * «push-to-talk». Нажатия только сравниваются с назначенными клавишами — никуда не пишутся
 * и не отправляются. Клавиши не перехватываются: игра их тоже получает.
 * Благодаря этому работает режим «держу — говорю»: видно и нажатие, и отпускание.
 *
 * Запасной способ, если модуль не загрузился, — globalShortcut Electron:
 * только нажатие, поэтому рация работает в режиме «нажал — говорю, нажал ещё раз — стоп».
 */

const { globalShortcut } = require('electron');

let hook = null;
let KEY = {};
try {
  ({ uIOhook: hook, UiohookKey: KEY } = require('uiohook-napi'));
} catch {
  hook = null;
}

const KEY_NAMES = Object.fromEntries(Object.entries(KEY).map(([name, code]) => [code, name]));
const MODIFIERS = new Set(['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight'].map((n) => KEY[n]));
const PRETTY = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backquote: '`', Escape: 'Esc' };
const MOUSE_NAMES = { 3: 'Колесо (нажатие)', 4: 'Мышь 4', 5: 'Мышь 5' };

// Действия и клавиши по умолчанию
const ACTIONS = ['ptt', 'ab', 'chUp', 'chDown', 'mute', 'view', 'hide'];
const DEFAULTS = {
  ptt: { key: 'F8' },
  hide: { key: 'F8', ctrl: true, shift: true },
};

function label(combo) {
  if (!combo) return '';
  const parts = [];
  if (combo.ctrl) parts.push('Ctrl');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');
  if (combo.meta) parts.push('Win');
  parts.push(combo.mouse ? MOUSE_NAMES[combo.mouse] : PRETTY[combo.key] ?? combo.key);
  return parts.join('+');
}

// Для запасного способа: клавиша в формате Electron
function accelerator(combo) {
  if (!combo || combo.mouse) return null;
  const map = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return' };
  const key = map[combo.key] ?? combo.key;
  if (!/^(F\d{1,2}|[A-Z0-9]|Space|Tab|Up|Down|Left|Right|PageUp|PageDown|Home|End|Insert|Delete|Backspace|Return)$/.test(key)) return null;
  return [combo.ctrl && 'Control', combo.alt && 'Alt', combo.shift && 'Shift', combo.meta && 'Super', key].filter(Boolean).join('+');
}

class Hotkeys {
  // onAction(action, phase) — phase: 'down' | 'up'; onAlt(held) — зажат ли Alt
  constructor({ onAction, onAlt }) {
    this.onAction = onAction;
    this.onAlt = onAlt;
    this.bindings = {};
    this.pttMode = 'hold';
    this.active = false;
    this.pressed = new Set();   // клавиши, которые сейчас зажаты (чтобы не ловить автоповтор)
    this.holding = new Map();   // действие → код клавиши, которой его начали
    this.capture = null;        // ждём клавишу для назначения
    this.started = false;
    this.error = null;
  }

  get hooked() {
    return Boolean(hook) && this.started;
  }

  start() {
    if (!hook || this.started) return;
    try {
      hook.on('keydown', (e) => this.down({ code: e.keycode, e }));
      hook.on('keyup', (e) => this.up({ code: e.keycode, e }));
      hook.on('mousedown', (e) => e.button >= 3 && this.down({ mouse: e.button, e }));
      hook.on('mouseup', (e) => e.button >= 3 && this.up({ mouse: e.button, e }));
      hook.start();
      this.started = true;
    } catch (err) {
      this.error = err.message;
    }
  }

  stop() {
    if (this.started) hook.stop();
    this.started = false;
    globalShortcut.unregisterAll();
  }

  configure({ bindings, pttMode }) {
    this.bindings = bindings;
    this.pttMode = pttMode === 'toggle' ? 'toggle' : 'hold';
    this.refreshFallback();
  }

  setActive(on) {
    this.active = on;
    if (!on) this.releaseAll();
    this.refreshFallback();
  }

  // Следующее нажатие — новая клавиша для действия. Esc — отмена.
  captureNext(timeoutMs = 8000) {
    if (!this.hooked) return Promise.resolve({ error: 'Слежение за клавиатурой недоступно' });
    this.cancelCapture();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.capture = null;
        resolve({ cancelled: true });
      }, timeoutMs);
      this.capture = (combo) => {
        clearTimeout(timer);
        this.capture = null;
        resolve(combo ? { combo } : { cancelled: true });
      };
    });
  }

  cancelCapture() {
    this.capture?.(null);
  }

  // ───────── Слежение через uiohook ─────────

  matches(combo, { code, mouse, e }) {
    if (!combo) return false;
    if (combo.mouse ? combo.mouse !== mouse : KEY[combo.key] !== code) return false;
    return Boolean(combo.ctrl) === Boolean(e.ctrlKey) && Boolean(combo.alt) === Boolean(e.altKey) &&
      Boolean(combo.shift) === Boolean(e.shiftKey) && Boolean(combo.meta) === Boolean(e.metaKey);
  }

  down(ev) {
    const id = ev.mouse ? `m${ev.mouse}` : ev.code;
    if (ev.code === KEY.Alt || ev.code === KEY.AltRight) this.onAlt?.(true);
    if (this.pressed.has(id)) return; // автоповтор зажатой клавиши
    this.pressed.add(id);

    if (this.capture) {
      if (ev.code === KEY.Escape) this.capture(null);
      else if (ev.mouse || !MODIFIERS.has(ev.code)) {
        const { e } = ev;
        this.capture({
          ...(ev.mouse ? { mouse: ev.mouse } : { key: KEY_NAMES[ev.code] }),
          ctrl: e.ctrlKey || undefined, alt: e.altKey || undefined, shift: e.shiftKey || undefined, meta: e.metaKey || undefined,
        });
      }
      return;
    }
    if (!this.active) return;
    for (const action of ACTIONS) {
      if (!this.matches(this.bindings[action], ev)) continue;
      this.holding.set(action, id);
      if (action === 'ptt') this.onAction(this.pttMode === 'hold' ? 'ptt-down' : 'ptt-toggle');
      else this.onAction(action);
    }
  }

  up(ev) {
    const id = ev.mouse ? `m${ev.mouse}` : ev.code;
    if (ev.code === KEY.Alt || ev.code === KEY.AltRight) this.onAlt?.(false);
    this.pressed.delete(id);
    // Отпустили основную клавишу — даже если модификатор отпустили раньше
    for (const [action, heldId] of this.holding) {
      if (heldId !== id) continue;
      this.holding.delete(action);
      if (action === 'ptt' && this.pttMode === 'hold') this.onAction('ptt-up');
    }
  }

  releaseAll() {
    if (this.holding.has('ptt') && this.pttMode === 'hold') this.onAction('ptt-up');
    this.holding.clear();
  }

  // ───────── Запасной способ: globalShortcut ─────────

  refreshFallback() {
    globalShortcut.unregisterAll();
    if (this.hooked || !this.active) return;
    for (const action of ACTIONS) {
      const acc = accelerator(this.bindings[action]);
      if (!acc) continue;
      globalShortcut.register(acc, () => this.onAction(action === 'ptt' ? 'ptt-toggle' : action));
    }
  }

  // Для отладки: нажатие без настоящей клавиатуры
  simulate(action, phase) {
    const combo = this.bindings[action];
    if (!combo) return false;
    const e = { ctrlKey: combo.ctrl, altKey: combo.alt, shiftKey: combo.shift, metaKey: combo.meta };
    const ev = combo.mouse ? { mouse: combo.mouse, e } : { code: KEY[combo.key], e };
    if (phase === 'up') this.up(ev);
    else this.down(ev);
    return true;
  }
}

module.exports = { Hotkeys, ACTIONS, DEFAULTS, label };
