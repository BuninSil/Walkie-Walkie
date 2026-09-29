'use strict';

/*
 * Серверная ретрансляция интернет-радио в эфир — целиком в main-процессе, без Web Audio в окне.
 *
 * Зачем: на слабом сервере (1 ядро) браузерный аудио-граф в рендерере давится — эфир заикается,
 * а перегруженное окно ещё и тормозит команды панели/бота. ffmpeg декодирует поток куда дешевле,
 * а дальше — тот же IMA ADPCM и тот же пакет [4][seq][ADPCM], что и у обычной станции. Звук
 * вливается прямо во встроенный AirServer как локальная станция, поэтому рации/приёмники слышат
 * его штатно, а рендереру вообще ничего делать не нужно.
 *
 * Эфир: 16 кГц моно, кадр 640 сэмплов = 40 мс (см. js/live.js LIVE_RATE/LIVE_CHUNK).
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { adpcmEncode, openPacketC } = require('./codec-node');

const RATE = 16000;          // Гц — частота эфира
const CHUNK = 640;           // сэмплов в кадре (40 мс)
const FRAME_BYTES = CHUNK * 2;
const FRAME_MS = 40;
const MAX_BACKLOG = FRAME_BYTES * 200; // ~8 с PCM в запасе — больше не копим (режем хвост)

// Найти рабочий ffmpeg: сперва путь из настроек, потом вшитый ffmpeg-static (если есть),
// потом системный из PATH. Возвращает команду или null, если ffmpeg нигде не нашёлся.
// Кросс-компиляция бинаря под чужую ОС ненадёжна, поэтому ставка на системный/указанный ffmpeg.
function resolveFfmpeg(configured) {
  const tries = [];
  if (configured) tries.push(configured);
  try { const p = require('ffmpeg-static'); if (p) tries.push(p.replace('app.asar', 'app.asar.unpacked')); } catch { /* не вшит — норм */ }
  tries.push(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'); // из PATH
  for (const cmd of tries) {
    try {
      if ((cmd.includes('/') || cmd.includes('\\')) && !fs.existsSync(cmd)) continue;
      const r = spawnSync(cmd, ['-version'], { stdio: 'ignore', timeout: 4000, windowsHide: true });
      if (!r.error && r.status === 0) return cmd;
    } catch { /* пробуем следующий */ }
  }
  return null;
}

// Совместимость: путь к ffmpeg с учётом настройки (для проверки «есть ли вообще ffmpeg»)
function ffmpegPath(configured) {
  return resolveFfmpeg(configured);
}

class StreamRelay {
  // station — ручка локальной станции от AirServer.addLocalStation()
  constructor(station) {
    this.station = station;
    this.ff = null;
    this.timer = null;
    this.buf = Buffer.alloc(0);
    this.seq = 0;
    this.active = false;
    this.url = '';
    this.restartTimer = null;
    this.onState = null; // (state) => void: 'playing' | 'reconnect' | 'stopped' | 'error'
  }

  // ffmpeg — команда/путь к рабочему ffmpeg (см. resolveFfmpeg в main)
  start(url, ffmpeg) {
    if (!ffmpeg) throw new Error('ffmpeg не найден. Установи ffmpeg на сервере (в PATH) или укажи путь.');
    this.stop(true);
    this.url = url;
    this.ffmpeg = ffmpeg;
    this.active = true;
    this._spawn(ffmpeg);
    this._pace();
  }

  _spawn(ff) {
    // -reconnect: сами перецепляемся при обрыве HTTP-потока; звук держит несущую тишиной
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', this.url,
      '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-',
    ];
    let proc;
    try {
      proc = spawn(ff, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      if (this.onState) this.onState('error');
      return;
    }
    this.ff = proc;
    proc.stdout.on('data', (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      if (this.buf.length > MAX_BACKLOG) this.buf = this.buf.subarray(this.buf.length - FRAME_BYTES * 100);
      if (this.onState) this.onState('playing');
    });
    proc.on('error', () => { if (this.active) this._scheduleRestart(); });
    proc.on('close', () => { this.ff = null; if (this.active) this._scheduleRestart(); });
  }

  _scheduleRestart() {
    if (this.restartTimer || !this.active) return;
    if (this.onState) this.onState('reconnect');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.active && this.ffmpeg) this._spawn(this.ffmpeg);
    }, 1500);
  }

  // Ровно 40 мс на кадр по стенным часам — иначе приёмник рвёт из-за неровной подачи
  _pace() {
    let next = Date.now();
    const tick = () => {
      if (!this.active) return;
      let frame;
      if (this.buf.length >= FRAME_BYTES) {
        frame = Buffer.from(this.buf.subarray(0, FRAME_BYTES)); // копия — выровнена под Int16
        this.buf = this.buf.subarray(FRAME_BYTES);
      } else {
        frame = Buffer.alloc(FRAME_BYTES); // тишина: несущая не пропадает при недоборе потока
      }
      const pcm = new Int16Array(frame.buffer, frame.byteOffset, CHUNK);
      const adpcm = adpcmEncode(pcm);
      try { this.station.send(openPacketC(adpcm, this.seq)); } catch { /* сервер закрылся */ }
      this.seq = (this.seq + 1) & 0xff;
      next += FRAME_MS;
      this.timer = setTimeout(tick, Math.max(0, next - Date.now()));
    };
    tick();
  }

  stop(keepActive = false) {
    if (!keepActive) this.active = false;
    clearTimeout(this.timer); this.timer = null;
    clearTimeout(this.restartTimer); this.restartTimer = null;
    if (this.ff) { try { this.ff.kill('SIGKILL'); } catch { /* уже мёртв */ } this.ff = null; }
    this.buf = Buffer.alloc(0);
    if (!keepActive && this.onState) this.onState('stopped');
  }

  get running() { return this.active; }
}

module.exports = { StreamRelay, ffmpegPath };
