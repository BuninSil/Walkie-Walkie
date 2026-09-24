'use strict';

/*
 * Проверка рации для Android прямо на ПК, без телефона: отдаёт www/ с http://localhost —
 * тот же адрес, что у страницы внутри приложения (сервер эфира пускает именно его).
 * Порт 80 обязателен: с другим портом Origin станет http://localhost:NNNN и сервер откажет.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const WWW = path.resolve(__dirname, '..', 'www');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(WWW, rel);
  if (!file.startsWith(WWW + path.sep)) return res.writeHead(404).end();
  fs.readFile(file, (err, body) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  });
}).listen(80, 'localhost', () => console.log('Рация для Android: http://localhost  (Ctrl+C — остановить)'))
  .on('error', (e) => {
    console.error(`Не открыть порт 80: ${e.message}. Закройте то, что его занимает (Skype, IIS, другой сервер).`);
    process.exit(1);
  });
