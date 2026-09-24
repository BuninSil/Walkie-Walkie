'use strict';

/*
 * Внешний вид рации на телефоне: темы, корпус, кнопки, экран, фон, неон, шрифты.
 * Рация (widget.js/widget.css) не меняется: цвета уходят в её CSS-переменные, остальное —
 * атрибутами на <html> для look.css. Настройки — в localStorage, картинки — в IndexedDB.
 * Снаружи: window.WalkieLook.open() — редактор, .haptics — вибрация кнопок.
 */
(() => {
  const KEY = 'walkie.android.look2';
  const OLD_KEY = 'walkie.android.look'; // настройки первой версии (корпус, экран, надписи, вибрация)
  const root = document.documentElement;

  /* ───────── Что можно выбрать ───────── */

  const DEFAULTS = {
    skin: 'classic', finish: 'matte', body: '#26272b', keys: '#2e2f35', keyShape: 'soft',
    label: '#ecebe6', accent: '#ff9a3c', antenna: true, knob: '#ff9a3c',
    lcdStyle: 'classic', lcd: '#c6d6b2', lcd2: '#8ad4ff', ink: 'auto', pattern: 'none', lcdTint: 55, lcdImage: false,
    bg: 'dark', bgColor: '#101114', bgImage: false, bgDim: 35,
    neon: false, neonColor: '#00e5ff', neon2: '#ff2bd6', glow: 1, pulse: false,
    ledTx: '#ff3b2f', ledRx: '#37f06f',
    fontLcd: 'default', fontKeys: 'default',
    haptics: true,
  };

  const SKINS = {
    classic: 'Классика', touch: 'Сенсорная', neon: 'Неон', retro: 'Ретро', rugged: 'Военная', minimal: 'Минимал',
  };
  const FINISHES = { matte: 'Матовый', gloss: 'Глянец', metal: 'Металл', carbon: 'Карбон', rubber: 'Резина', camo: 'Камуфляж' };
  const KEY_SHAPES = { soft: 'Мягкие', round: 'Круглые', pill: 'Капсулы', square: 'Квадратные' };
  const LCD_STYLES = {
    classic: 'Классика', dark: 'Тёмный', oled: 'OLED', crt: 'ЭЛТ', glass: 'Стекло', gradient: 'Градиент',
  };
  const PATTERNS = { none: 'Нет', grid: 'Сетка', dots: 'Точки', scan: 'Строки', hex: 'Соты' };

  const COLORS = {
    body: ['#26272b', '#111114', '#4b5234', '#25324d', '#d86b1c', '#7d2226', '#a38b5e', '#e3e4e6', '#2d6a4f', '#5b2a86', '#c2185b', '#0f766e', '#1d4ed8', '#ffd23c'],
    keys: ['#2e2f35', '#16171b', '#3b4129', '#2c3850', '#4a4234', '#5a1f22', '#e3e4e6', '#1e3a5f', '#3d2b56', '#0b0b12'],
    label: ['#ecebe6', '#ffffff', '#b9b6ae', '#151515', '#ffd23c', '#4cd2ff', '#6ee06e', '#ff9ad5'],
    accent: ['#ff9a3c', '#ffd23c', '#4cd2ff', '#6ee06e', '#ff5a4c', '#b86bff', '#ff2bd6', '#ffffff'],
    lcd: ['#c6d6b2', '#ffcf7a', '#b8e3f5', '#eef0ea', '#ffb0a6', '#d5b8ff', '#9bffc8', '#00e5ff', '#ff2bd6', '#39ff14', '#ffb000'],
    neon: ['#00e5ff', '#ff2bd6', '#39ff14', '#ffb000', '#ff3b2f', '#b86bff', '#ffffff', '#2b6bff'],
    bg: ['#101114', '#000000', '#1b2230', '#241a2f', '#10231c', '#2a1a12', '#f2efe9'],
    led: ['#ff3b2f', '#37f06f', '#00e5ff', '#ff2bd6', '#ffb000', '#ffffff', '#b86bff'],
  };

  const BACKGROUNDS = {
    dark: { name: 'Тёмный', css: 'radial-gradient(ellipse at 50% 35%, #23252a 0%, #0d0e10 70%)' },
    graphite: { name: 'Графит', css: 'linear-gradient(160deg, #2b2d33, #121316)' },
    night: { name: 'Ночной город', css: 'radial-gradient(ellipse at 50% 110%, #ff2bd6 0%, #5b1a8f 30%, #120b2e 65%, #05040d 100%)' },
    sunset: { name: 'Закат', css: 'linear-gradient(180deg, #1b1035 0%, #6d1b5a 45%, #ff6a3d 80%, #ffc15e 100%)' },
    ocean: { name: 'Океан', css: 'linear-gradient(180deg, #021526 0%, #03346e 55%, #1f6fa6 100%)' },
    forest: { name: 'Лес', css: 'linear-gradient(180deg, #0b1a12 0%, #173d2a 60%, #2f6b45 100%)' },
    space: {
      name: 'Космос',
      css: 'radial-gradient(1px 1px at 20% 30%, #fff, transparent), radial-gradient(1px 1px at 70% 20%, #fff, transparent), radial-gradient(1.5px 1.5px at 40% 70%, #cde, transparent), radial-gradient(1px 1px at 85% 60%, #fff, transparent), radial-gradient(1px 1px at 10% 85%, #fff, transparent), radial-gradient(ellipse at 70% 80%, #2b1a55 0%, transparent 60%), #05050c',
    },
    synth: {
      name: 'Синтвейв',
      css: 'linear-gradient(transparent 60%, rgba(255, 43, 214, 0.35) 60.5%, transparent 61%) 0 0 / 100% 28px, linear-gradient(90deg, rgba(255, 43, 214, 0.25) 1px, transparent 1px) 0 0 / 28px 100%, linear-gradient(180deg, #0d0221 0%, #2d0b4e 55%, #ff2bd6 140%)',
    },
    carbon: { name: 'Карбон', css: 'repeating-linear-gradient(45deg, #151518 0 4px, #1d1d21 4px 8px)' },
    camo: {
      name: 'Камуфляж',
      css: 'radial-gradient(60px 40px at 20% 20%, #3b4129 60%, transparent 62%) 0 0 / 180px 180px, radial-gradient(70px 50px at 70% 60%, #1f2416 60%, transparent 62%) 0 0 / 200px 200px, radial-gradient(50px 36px at 40% 80%, #5a5f3c 60%, transparent 62%) 0 0 / 160px 160px, #2c3120',
    },
    color: { name: 'Свой цвет', css: null },
    image: { name: 'Своя картинка', css: null },
  };

  // Шрифты: семейство, масштаб крупных строк экрана, масштаб мелких
  const FONTS = {
    default: { name: 'Стандарт', family: null, fs: 1, small: 1, sample: 'Аа 12' },
    mono: { name: 'Моно', family: "'WK Mono', monospace", fs: 1, small: 1, sample: 'Аа 12' },
    techno: { name: 'Техно', family: "'WK Techno', sans-serif", fs: 1.02, small: 1.05, sample: 'Аа 12' },
    heavy: { name: 'Жирный', family: "'WK Heavy', sans-serif", fs: 0.96, small: 1, sample: 'Аа 12' },
    round: { name: 'Округлый', family: "'WK Round', sans-serif", fs: 0.94, small: 1, sample: 'Аа 12' },
    pixel: { name: 'Пиксель', family: "'WK Pixel', monospace", fs: 0.66, small: 0.8, sample: 'Аа 12' },
    seg7: { name: 'Сегменты', family: "'WK Seg7', 'WK Mono', monospace", fs: 0.92, small: 1, sample: '88.8' },
    seg14: { name: 'Сегменты 14', family: "'WK Seg14', 'WK Mono', monospace", fs: 0.8, small: 0.95, sample: 'AB 12' },
    terminal: { name: 'Терминал', family: "'WK Terminal', 'WK Mono', monospace", fs: 1.25, small: 1.25, sample: 'Aa 12' },
    space: { name: 'Космос', family: "'WK Space', 'WK Techno', sans-serif", fs: 0.86, small: 0.95, sample: 'Aa 12' },
    serif: { name: 'С засечками', family: 'serif', fs: 1, small: 1, sample: 'Аа 12' },
    condensed: { name: 'Узкий', family: "'sans-serif-condensed', sans-serif", fs: 1.05, small: 1.05, sample: 'Аа 12' },
    hand: { name: 'Рукописный', family: 'cursive', fs: 1.05, small: 1.1, sample: 'Аа 12' },
    casual: { name: 'Комикс', family: "'casual', 'Comic Sans MS', cursive", fs: 0.95, small: 1, sample: 'Аа 12' },
  };

  // Темы — готовые наборы всего сразу
  const THEMES = {
    classic: { name: 'Классика UV-K5', sw: 'linear-gradient(135deg, #26272b 50%, #c6d6b2 50%)', set: {} },
    cyber: {
      name: 'Киберпанк', sw: 'linear-gradient(135deg, #ff2bd6, #00e5ff)',
      set: { skin: 'neon', body: '#0b0b12', keys: '#0b0b12', label: '#e8f7ff', accent: '#ff2bd6', lcdStyle: 'dark', lcd: '#00e5ff', pattern: 'scan', bg: 'night', neon: true, neonColor: '#ff2bd6', neon2: '#00e5ff', glow: 1.2, pulse: true, fontLcd: 'techno', fontKeys: 'techno', ledRx: '#00e5ff', ledTx: '#ff2bd6', knob: '#ff2bd6' },
    },
    glass: {
      name: 'Сенсорная Glass', sw: 'linear-gradient(135deg, #1d4ed8, #b8e3f5)',
      set: { skin: 'touch', finish: 'gloss', body: '#1e2a44', keys: '#2c3850', label: '#ffffff', accent: '#4cd2ff', lcdStyle: 'glass', lcd: '#b8e3f5', bg: 'ocean', fontLcd: 'round', fontKeys: 'round', knob: '#4cd2ff' },
    },
    retro: {
      name: 'Ретро 80-х', sw: 'linear-gradient(135deg, #d8cfb8 50%, #ffb000 50%)',
      set: { skin: 'retro', finish: 'matte', body: '#d8cfb8', keys: '#4a4234', label: '#f5eedc', accent: '#ff6a00', lcdStyle: 'classic', lcd: '#ffcf7a', pattern: 'dots', bg: 'sunset', fontLcd: 'seg14', fontKeys: 'mono', knob: '#ff6a00', antenna: true },
    },
    army: {
      name: 'Военная', sw: 'linear-gradient(135deg, #4b5234 50%, #ffcf7a 50%)',
      set: { skin: 'rugged', finish: 'rubber', body: '#4b5234', keys: '#3b4129', label: '#e6e2cf', accent: '#ffd23c', lcdStyle: 'classic', lcd: '#ffcf7a', pattern: 'grid', bg: 'camo', fontLcd: 'heavy', fontKeys: 'heavy', knob: '#ffd23c' },
    },
    matrix: {
      name: 'Матрица', sw: 'linear-gradient(135deg, #000 50%, #39ff14 50%)',
      set: { skin: 'neon', body: '#050805', keys: '#060a06', label: '#9bff8a', accent: '#39ff14', lcdStyle: 'oled', lcd: '#39ff14', pattern: 'scan', bg: 'color', bgColor: '#000000', neon: true, neonColor: '#39ff14', neon2: '#39ff14', glow: 0.9, fontLcd: 'terminal', fontKeys: 'mono', ledRx: '#39ff14', knob: '#39ff14' },
    },
    arctic: {
      name: 'Арктика', sw: 'linear-gradient(135deg, #e3e4e6 50%, #4cd2ff 50%)',
      set: { skin: 'minimal', finish: 'gloss', body: '#e3e4e6', keys: '#2c3850', label: '#ffffff', accent: '#1d9bf0', lcdStyle: 'classic', lcd: '#b8e3f5', bg: 'graphite', fontLcd: 'default', knob: '#1d9bf0' },
    },
    sunset: {
      name: 'Закат', sw: 'linear-gradient(135deg, #ff6a3d, #b86bff)',
      set: { skin: 'touch', finish: 'gloss', body: '#d86b1c', keys: '#3d2b56', label: '#fff4e8', accent: '#ffd23c', lcdStyle: 'gradient', lcd: '#ffcf7a', lcd2: '#ff9ad5', bg: 'sunset', neon: true, neonColor: '#ff9a3c', neon2: '#b86bff', glow: 0.7, fontLcd: 'round', fontKeys: 'round', knob: '#ffd23c' },
    },
    synth: {
      name: 'Синтвейв', sw: 'linear-gradient(135deg, #2d0b4e, #ff2bd6)',
      set: { skin: 'neon', body: '#120720', keys: '#1a0b2e', label: '#ffe6fb', accent: '#00e5ff', lcdStyle: 'crt', lcd: '#ff2bd6', bg: 'synth', neon: true, neonColor: '#b86bff', neon2: '#ff2bd6', glow: 1.3, pulse: true, fontLcd: 'space', fontKeys: 'space', ledRx: '#00e5ff', ledTx: '#ff2bd6', knob: '#00e5ff' },
    },
    stealth: {
      name: 'Стелс', sw: 'linear-gradient(135deg, #111114 50%, #eef0ea 50%)',
      set: { skin: 'minimal', finish: 'carbon', body: '#141417', keys: '#1c1c20', label: '#d7d7d7', accent: '#b9b6ae', lcdStyle: 'oled', lcd: '#eef0ea', bg: 'carbon', fontLcd: 'mono', fontKeys: 'default', knob: '#eef0ea', antenna: false },
    },
    amber: {
      name: 'Ламповый', sw: 'linear-gradient(135deg, #2a1a12 50%, #ffb000 50%)',
      set: { skin: 'retro', finish: 'metal', body: '#5a3a22', keys: '#2a1a12', label: '#ffd9a0', accent: '#ffb000', lcdStyle: 'crt', lcd: '#ffb000', bg: 'color', bgColor: '#140c06', fontLcd: 'terminal', fontKeys: 'mono', knob: '#ffb000', ledRx: '#ffb000' },
    },
    toxic: {
      name: 'Токсик', sw: 'linear-gradient(135deg, #ffd23c, #39ff14)',
      set: { skin: 'rugged', finish: 'camo', body: '#3a3f1a', keys: '#1f2410', label: '#e8ff9c', accent: '#39ff14', lcdStyle: 'dark', lcd: '#c8ff00', pattern: 'hex', bg: 'forest', neon: true, neonColor: '#c8ff00', neon2: '#39ff14', glow: 0.8, fontLcd: 'seg7', fontKeys: 'heavy', knob: '#c8ff00' },
    },
  };

  /* ───────── Хранение ───────── */

  function load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY));
    } catch {
      /* пусто */
    }
    if (!saved) {
      // Переносим то, что выбрали в первой версии настроек
      saved = {};
      try {
        const old = JSON.parse(localStorage.getItem(OLD_KEY)) || {};
        const bodies = { olive: '#4b5234', navy: '#25324d', orange: '#d86b1c', red: '#7d2226', sand: '#a38b5e' };
        const lcds = { amber: '#ffcf7a', ice: '#b8e3f5', white: '#eef0ea', red: '#ffb0a6' };
        const accents = { yellow: '#ffd23c', cyan: '#4cd2ff', green: '#6ee06e', red: '#ff5a4c' };
        if (bodies[old.body]) saved.body = bodies[old.body];
        if (lcds[old.screen]) saved.lcd = lcds[old.screen];
        if (accents[old.accent]) saved.accent = accents[old.accent];
        if (old.haptics === false) saved.haptics = false;
      } catch {
        /* нет старых — по умолчанию */
      }
    }
    return { ...DEFAULTS, ...saved };
  }

  let look = load();

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(look));
    } catch {
      /* не запомним — не страшно */
    }
  }

  // Картинки (фон, экран) — в IndexedDB: в localStorage им тесно
  const images = {};
  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('walkie-look', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('images');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function imageGet(name) {
    try {
      const d = await db();
      return await new Promise((resolve) => {
        const r = d.transaction('images').objectStore('images').get(name);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }
  async function imageSet(name, value) {
    try {
      const d = await db();
      await new Promise((resolve) => {
        const tx = d.transaction('images', 'readwrite');
        if (value) tx.objectStore('images').put(value, name);
        else tx.objectStore('images').delete(name);
        tx.oncomplete = resolve;
        tx.onerror = resolve;
      });
    } catch {
      /* не сохранили — картинка будет до перезапуска */
    }
  }

  // Картинку из галереи ужимаем до 1280 px — быстро рисуется и мало весит
  function pickImage(maxSide) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, maxSide / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * k);
          c.height = Math.round(img.height * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = () => resolve(null);
        img.src = url;
      };
      input.click();
    });
  }

  /* ───────── Цвета ───────── */

  const hex = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const toHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
  // k > 0 — светлее, k < 0 — темнее
  const shade = (h, k) => toHex(hex(h).map((v) => (k >= 0 ? v + (255 - v) * k : v * (1 + k))));
  const mix = (a, b, k) => {
    const x = hex(a);
    const y = hex(b);
    return toHex(x.map((v, i) => v + (y[i] - v) * k));
  };
  const lum = (h) => {
    const [r, g, b] = hex(h).map((v) => v / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const rgba = (h, a) => `rgba(${hex(h).join(', ')}, ${a})`;

  /* ───────── Применение ───────── */

  const style = document.createElement('style');
  const bgLayer = document.createElement('div');
  bgLayer.id = 'wk-bg';

  function apply() {
    const v = {};
    const bodyLight = lum(look.body) > 0.55;
    v['--plastic-hi'] = shade(look.body, 0.07);
    v['--plastic-lo'] = shade(look.body, -0.45);
    v['--edge'] = shade(look.body, -0.75);
    v['--key-hi'] = shade(look.keys, 0.06);
    v['--key-lo'] = shade(look.keys, -0.35);
    v['--key-side-hi'] = shade(look.keys, 0.18);
    v['--key-side-lo'] = shade(look.keys, -0.12);
    v['--label'] = look.label;
    v['--label-alt'] = look.accent;
    v['--led-tx'] = look.ledTx;
    v['--led-rx'] = look.ledRx;

    // Экран: светлые стили — тёмные буквы на подсветке; тёмные — светящиеся буквы на чёрном
    const darkLcd = ['dark', 'oled', 'crt'].includes(look.lcdStyle);
    if (darkLcd) {
      const base = look.lcdStyle === 'oled' ? '#000000' : mix('#050706', look.lcd, 0.06);
      v['--lcd-lit'] = base;
      v['--lcd-lit-lo'] = look.lcdStyle === 'oled' ? '#000000' : shade(base, -0.4);
      v['--lcd-dim'] = shade(base, -0.3);
      v['--lcd-dim-lo'] = '#000000';
      v['--lcd-off'] = '#050505';
      const ink = look.ink === 'auto' ? look.lcd : look.ink;
      v['--ink'] = ink;
      v['--ink-soft'] = rgba(ink, 0.65);
      v['--ink-ghost'] = rgba(ink, 0.14);
    } else {
      v['--lcd-lit'] = look.lcd;
      v['--lcd-lit-lo'] = shade(look.lcd, -0.13);
      v['--lcd-dim'] = mix(shade(look.lcd, -0.3), '#808080', 0.25);
      v['--lcd-dim-lo'] = mix(shade(look.lcd, -0.38), '#707070', 0.25);
      const ink = look.ink === 'auto' ? (lum(look.lcd) > 0.45 ? '#152013' : '#f2f2f2') : look.ink;
      v['--ink'] = ink;
      v['--ink-soft'] = rgba(ink, 0.55);
      v['--ink-ghost'] = rgba(ink, 0.1);
    }
    v['--wk-lcd2'] = look.lcd2;
    v['--wk-lcd-tint'] = String(look.lcdTint);

    v['--wk-neon'] = look.neonColor;
    v['--wk-neon2'] = look.neon2;
    v['--wk-glow'] = String(look.glow);

    const lf = FONTS[look.fontLcd] || FONTS.default;
    const kf = FONTS[look.fontKeys] || FONTS.default;
    if (lf.family) v['--lcd-font'] = lf.family;
    v['--wk-fs'] = String(lf.fs);
    v['--wk-fs-small'] = String(lf.small);
    if (kf.family) v['--wk-key-font'] = kf.family;

    const bg = BACKGROUNDS[look.bg] || BACKGROUNDS.dark;
    if (look.bg === 'color') v['--wk-bg'] = look.bgColor;
    else if (look.bg === 'image') v['--wk-bg'] = '#000';
    else v['--wk-bg'] = bg.css;
    v['--wk-bg-dim'] = String(look.bg === 'image' ? look.bgDim / 100 : 0);

    let css = `html:root { ${Object.entries(v).map(([k, x]) => `${k}: ${x};`).join(' ')} }`;
    css += ` .knob__mark { background: ${look.knob} !important; }`;
    if (bodyLight) css += ' .brand { color: #3b3a36 !important; }';
    if (images.lcd && look.lcdImage) css += ` html:root { --wk-lcd-image: url("${images.lcd}"); }`;
    style.textContent = css;

    const d = root.dataset;
    d.skin = look.skin;
    d.finish = look.finish;
    d.keys = look.keyShape;
    d.lcd = look.lcdStyle;
    d.pattern = look.pattern;
    d.antenna = look.antenna ? 'on' : 'off';
    toggleAttr('neon', look.neon || look.skin === 'neon');
    toggleAttr('pulse', look.pulse);
    toggleAttr('lcdImage', Boolean(look.lcdImage && images.lcd));
    bgLayer.style.backgroundImage = look.bg === 'image' && images.bg ? `url("${images.bg}")` : 'none';
    bgLayer.style.display = look.bg === 'image' ? '' : 'none';
    save();
  }

  function toggleAttr(name, on) {
    if (on) root.dataset[name] = '';
    else delete root.dataset[name];
  }

  function set(change) {
    look = { ...look, ...change };
    apply();
    render();
  }

  function applyTheme(id) {
    const keepHaptics = look.haptics;
    look = { ...DEFAULTS, ...THEMES[id].set, haptics: keepHaptics, lcdImage: false, bgImage: false };
    apply();
    render();
  }

  function reset() {
    look = { ...DEFAULTS, haptics: look.haptics };
    delete images.bg;
    delete images.lcd;
    imageSet('bg', null);
    imageSet('lcd', null);
    apply();
    render();
  }

  /* ───────── Редактор ───────── */

  const TABS = [
    ['themes', 'Темы'], ['body', 'Корпус'], ['keys', 'Кнопки'], ['screen', 'Экран'],
    ['bg', 'Фон'], ['neon', 'Неон'], ['fonts', 'Шрифты'],
  ];
  let tab = 'themes';
  let panel = null;
  let body = null;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function option(label, pressed, onClick, sw, extra) {
    const b = el('button', `lk__opt${extra ? ` ${extra}` : ''}`);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(Boolean(pressed)));
    if (sw !== undefined) {
      const i = el('i');
      i.style.setProperty('--sw', sw);
      b.append(i);
    }
    b.append(el('span', null, label));
    b.addEventListener('click', onClick);
    return b;
  }

  function choices(title, map, key) {
    const frag = document.createDocumentFragment();
    frag.append(el('h3', null, title));
    const grid = el('div', 'lk__grid');
    for (const [id, name] of Object.entries(map)) grid.append(option(name, look[key] === id, () => set({ [key]: id })));
    frag.append(grid);
    return frag;
  }

  function colors(title, key, palette) {
    const frag = document.createDocumentFragment();
    frag.append(el('h3', null, title));
    const grid = el('div', 'lk__grid lk__grid--colors');
    for (const c of palette) grid.append(option('', look[key].toLowerCase() === c, () => set({ [key]: c }), c, 'lk__opt--color'));
    // Свой цвет — системная палитра Android
    const custom = option('', !palette.includes(look[key].toLowerCase()), () => {}, '', 'lk__opt--color lk__custom');
    const input = el('input');
    input.type = 'color';
    input.value = look[key];
    input.addEventListener('input', () => set({ [key]: input.value }));
    custom.append(input);
    grid.append(custom);
    frag.append(grid);
    return frag;
  }

  function slider(label, key, min, max, step) {
    const row = el('label', 'lk__row');
    row.append(el('span', null, label));
    const r = el('input');
    r.type = 'range';
    r.min = String(min);
    r.max = String(max);
    r.step = String(step);
    r.value = String(look[key]);
    r.addEventListener('input', () => {
      look = { ...look, [key]: Number(r.value) };
      apply();
    });
    row.append(r);
    return row;
  }

  function toggle(label, key, invert) {
    const row = el('div', 'lk__row');
    row.append(el('span', null, label));
    const on = invert ? !look[key] : look[key];
    const b = el('button', 'wk-switch');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(Boolean(on)));
    b.append(el('span'));
    b.addEventListener('click', () => set({ [key]: invert ? on : !on }));
    row.append(b);
    return row;
  }

  function fonts(title, key) {
    const frag = document.createDocumentFragment();
    frag.append(el('h3', null, title));
    const grid = el('div', 'lk__grid');
    for (const [id, f] of Object.entries(FONTS)) {
      const b = option(f.name, look[key] === id, () => set({ [key]: id }));
      const sample = el('b', null, f.sample);
      if (f.family) sample.style.fontFamily = f.family;
      b.prepend(sample);
      grid.append(b);
    }
    frag.append(grid);
    return frag;
  }

  function imageButtons(name, onKey, maxSide) {
    const row = el('div', 'lk__row');
    const pick = el('button', 'lk__btn lk__btn--accent', images[name] ? 'Другая картинка' : 'Выбрать из галереи');
    pick.type = 'button';
    pick.addEventListener('click', async () => {
      const data = await pickImage(maxSide);
      if (!data) return;
      images[name] = data;
      await imageSet(name, data);
      set(onKey);
    });
    row.append(pick);
    if (images[name]) {
      const del = el('button', 'lk__btn lk__btn--danger', 'Убрать');
      del.type = 'button';
      del.addEventListener('click', async () => {
        delete images[name];
        await imageSet(name, null);
        set(name === 'bg' ? { bg: 'dark' } : { lcdImage: false });
      });
      row.append(del);
    }
    return row;
  }

  function renderTab() {
    const f = document.createDocumentFragment();
    switch (tab) {
      case 'themes': {
        f.append(el('h3', null, 'Готовые темы'));
        const grid = el('div', 'lk__grid');
        for (const [id, t] of Object.entries(THEMES)) {
          grid.append(option(t.name, false, () => applyTheme(id), t.sw, 'lk__opt--theme'));
        }
        f.append(grid);
        f.append(el('p', 'lk__note', 'Тема меняет всё сразу — дальше можно подстроить любую мелочь на других вкладках.'));
        break;
      }
      case 'body':
        f.append(choices('Форма корпуса', SKINS, 'skin'));
        f.append(choices('Фактура', FINISHES, 'finish'));
        f.append(colors('Цвет корпуса', 'body', COLORS.body));
        f.append(colors('Ручка громкости', 'knob', COLORS.accent));
        f.append(toggle('Антенна', 'antenna'));
        f.append(colors('Светодиод: передача', 'ledTx', COLORS.led));
        f.append(colors('Светодиод: приём', 'ledRx', COLORS.led));
        break;
      case 'keys':
        f.append(choices('Форма кнопок', KEY_SHAPES, 'keyShape'));
        f.append(colors('Цвет кнопок', 'keys', COLORS.keys));
        f.append(colors('Цифры и надписи', 'label', COLORS.label));
        f.append(colors('Надписи F-функций', 'accent', COLORS.accent));
        f.append(toggle('Вибрация кнопок', 'haptics'));
        break;
      case 'screen':
        f.append(choices('Стиль экрана', LCD_STYLES, 'lcdStyle'));
        f.append(colors(['dark', 'oled', 'crt'].includes(look.lcdStyle) ? 'Цвет свечения' : 'Подсветка', 'lcd', COLORS.lcd));
        if (look.lcdStyle === 'gradient') f.append(colors('Второй цвет градиента', 'lcd2', COLORS.lcd));
        f.append(choices('Узор', PATTERNS, 'pattern'));
        f.append(el('h3', null, 'Картинка на экране'));
        f.append(imageButtons('lcd', { lcdImage: true }, 640));
        if (images.lcd) {
          f.append(toggle('Показывать картинку', 'lcdImage'));
          f.append(slider('Подсветка поверх', 'lcdTint', 15, 90, 5));
        }
        break;
      case 'bg': {
        f.append(el('h3', null, 'Фон за рацией'));
        const grid = el('div', 'lk__grid');
        for (const [id, b] of Object.entries(BACKGROUNDS)) {
          if (id === 'image' && !images.bg) continue;
          const sw = id === 'color' ? look.bgColor : id === 'image' ? `center / cover url("${images.bg}")` : b.css;
          grid.append(option(b.name, look.bg === id, () => set({ bg: id }), sw));
        }
        f.append(grid);
        if (look.bg === 'color') f.append(colors('Цвет фона', 'bgColor', COLORS.bg));
        f.append(el('h3', null, 'Своя картинка'));
        f.append(imageButtons('bg', { bg: 'image' }, 1280));
        if (look.bg === 'image') f.append(slider('Затемнение', 'bgDim', 0, 80, 5));
        break;
      }
      case 'neon':
        f.append(toggle('Неон', 'neon'));
        f.append(toggle('Пульсация', 'pulse'));
        f.append(slider('Яркость свечения', 'glow', 0.3, 2, 0.1));
        f.append(colors('Цвет неона: корпус и кнопки', 'neonColor', COLORS.neon));
        f.append(colors('Цвет неона: экран', 'neon2', COLORS.neon));
        f.append(el('p', 'lk__note', 'Для полного неона выберите форму корпуса «Неон» и тёмный стиль экрана — или тему «Киберпанк».'));
        break;
      case 'fonts':
        f.append(fonts('Шрифт экрана', 'fontLcd'));
        f.append(fonts('Шрифт кнопок', 'fontKeys'));
        break;
      default:
        break;
    }
    return f;
  }

  function render() {
    if (!panel || panel.hidden) return;
    for (const b of panel.querySelectorAll('.lk__tabs button')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
    const scroll = body.scrollTop;
    body.replaceChildren(renderTab());
    body.scrollTop = scroll;
  }

  function build() {
    panel = el('div', 'lk');
    panel.hidden = true;
    // Верх прозрачный — рацию видно, пока выбираете
    const preview = el('div', 'lk__preview');
    preview.addEventListener('click', () => open(false));
    const sheet = el('div', 'lk__sheet');
    const head = el('div', 'lk__head');
    head.append(el('h2', null, 'Внешний вид'));
    const resetBtn = el('button', 'lk__btn lk__btn--danger', 'Сбросить');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', () => {
      if (confirm('Вернуть рации вид по умолчанию? Свои картинки тоже удалятся.')) reset();
    });
    const done = el('button', 'lk__btn lk__btn--accent', 'Готово');
    done.type = 'button';
    done.addEventListener('click', () => open(false));
    head.append(resetBtn, done);
    const tabs = el('div', 'lk__tabs');
    for (const [id, name] of TABS) {
      const b = el('button', null, name);
      b.type = 'button';
      b.dataset.tab = id;
      b.addEventListener('click', () => {
        tab = id;
        body.scrollTop = 0;
        render();
      });
      tabs.append(b);
    }
    body = el('div', 'lk__body');
    sheet.append(head, tabs, body);
    panel.append(preview, sheet);
    document.body.append(panel);
  }

  function open(show = true) {
    if (!panel) build();
    panel.hidden = !show;
    if (show) render();
  }

  /* ───────── Старт ───────── */

  document.head.append(style);
  apply(); // цвета — сразу, до первой отрисовки рации
  document.addEventListener('DOMContentLoaded', async () => {
    document.body.prepend(bgLayer);
    images.bg = await imageGet('bg');
    images.lcd = await imageGet('lcd');
    apply();
  });

  window.WalkieLook = {
    open,
    reset,
    get haptics() {
      return look.haptics !== false;
    },
  };
})();
