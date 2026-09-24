'use strict';

/*
 * Собирает www/ для Android из той же рации, что и приложение для ПК (../radio-walkie/web),
 * плюс мобильная прослойка из mobile/. Код рации не копируется руками — берётся как есть,
 * поэтому рации на ПК и на телефоне всегда одинаковые и говорят на одном протоколе.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.resolve(ROOT, '../radio-walkie/web');
const MOBILE = path.join(ROOT, 'mobile');
const OUT = path.join(ROOT, 'www');

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(WEB, OUT, { recursive: true, filter: (src) => !path.basename(src).startsWith('.') });
for (const name of fs.readdirSync(MOBILE)) fs.copyFileSync(path.join(MOBILE, name), path.join(OUT, name));

// Страница рации → index.html: мобильные стили и мост до скриптов рации
let html = fs.readFileSync(path.join(OUT, 'widget.html'), 'utf8');
const replace = (from, to) => {
  if (!html.includes(from)) throw new Error(`В widget.html не найдено: ${from}`);
  html = html.replace(from, to);
};
replace('<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">');
replace('<link rel="stylesheet" href="css/widget.css">',
  '<link rel="stylesheet" href="css/widget.css">\n  <link rel="stylesheet" href="mobile.css">');
replace('<script src="js/audio-kit.js"></script>',
  '<script src="mobile.js"></script>\n  <script src="js/audio-kit.js"></script>');
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.rmSync(path.join(OUT, 'widget.html'));

console.log(`www/ собран из ${path.relative(ROOT, WEB)}`);
