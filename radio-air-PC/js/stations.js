'use strict';

/*
 * Станции эфира. Звук каждой станции синтезируется на лету.
 * Станция планирует свои события наперёд методом schedule(until), поэтому
 * эфир идёт непрерывно, даже когда на станцию никто не настроен — как в жизни.
 */

class Station {
  constructor(def) {
    this.id = def.id;
    this.freq = def.freq;                // МГц
    this.name = def.name;                // имя в журнале
    this.rds = def.rds ?? null;          // текст RDS; null — станция его не передаёт
    this.lcd = def.lcd ?? '— НЕТ RDS —'; // что показывает дисплей, если RDS нет
    this.power = def.power ?? 1;         // слабую станцию не вытянуть из шума полностью
    this.fading = def.fading ?? 0;       // глубина медленных замираний, 0..1
    this.seekable = def.seekable ?? this.power >= 0.8;
    this.stereo = def.stereo ?? false;
    this.encrypted = false;
  }

  build(ctx) {
    this.ctx = ctx;
    this.output = ctx.createGain();
    return this.output;
  }

  schedule() {}

  // Есть ли сейчас несущая. У встроенных станций — всегда.
  get onAir() {
    return true;
  }

  displayName() {
    return this.name;
  }

  lcdText() {
    return this.rds ?? this.lcd;
  }
}

/* Генеративная музыка: аккорды, бас, барабаны и импровизация по гамме */
class MusicStation extends Station {
  constructor(def) {
    super({ stereo: true, ...def });
    this.style = def.style;       // 'lofi' | 'arp'
    this.tempo = def.tempo;
    this.chords = def.chords;
    this.scale = def.scale;
    this.swing = def.swing ?? 0;
    this.gain = def.gain ?? 1.7;
  }

  build(ctx) {
    super.build(ctx);
    this.bus = ctx.createGain();
    this.bus.gain.value = this.gain;
    this.bus.connect(this.output);
    this.stepDur = 60 / this.tempo / 4;
    this.nextTime = ctx.currentTime + 0.05;
    this.step = 0;
    this.bar = Math.floor(Math.random() * this.chords.length);
    this.lastNote = this.scale[Math.floor(this.scale.length / 2)];
    return this.output;
  }

  schedule(until) {
    while (this.nextTime < until) {
      const swing = this.step % 4 === 2 ? this.swing * this.stepDur : 0;
      this.playStep(this.step, this.nextTime + swing);
      this.nextTime += this.stepDur;
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.bar++;
    }
  }

  playStep(step, t) {
    const { ctx, bus } = this;
    const I = AudioKit.inst;
    const chord = this.chords[this.bar % this.chords.length];
    const beat = this.stepDur * 4;

    if (this.style === 'lofi') {
      if (step === 0) {
        chord.notes.forEach((n, i) => I.keys(ctx, bus, t + i * 0.012, n, 0.55, beat * 3.6));
        I.bass(ctx, bus, t, chord.root, 0.8, beat * 1.4);
      }
      if (step === 8) I.bass(ctx, bus, t, chord.root + (Math.random() < 0.4 ? 7 : 0), 0.6, beat * 1.2);
      if (step === 10 && Math.random() < 0.55) {
        chord.notes.slice(1).forEach((n) => I.keys(ctx, bus, t, n, 0.32, beat * 1.4));
      }
      if (step === 0 || step === 10 || (step === 7 && Math.random() < 0.3)) I.kick(ctx, bus, t, step === 0 ? 0.9 : 0.7);
      if (step === 4 || step === 12) I.snare(ctx, bus, t, 0.55);
      if (step % 2 === 0) I.hat(ctx, bus, t, step % 4 === 0 ? 0.5 : 0.3);
      if (step % 2 === 0 && step !== 0 && Math.random() < 0.2) this.improvise(t, beat * (Math.random() < 0.5 ? 0.5 : 1));
    } else {
      const ARP = [0, 1, 2, 3, 2, 1, 2, 1];
      if (step === 0) I.bass(ctx, bus, t, chord.root, 0.7, beat * 3.5);
      if (step % 2 === 0) {
        const n = chord.notes[ARP[step / 2] % chord.notes.length] + 12;
        I.keys(ctx, bus, t, n, 0.4, beat * 1.2);
      }
      if (step === 4 && Math.random() < 0.5) this.improvise(t, beat * 1.5);
    }
  }

  improvise(t, len) {
    const scale = this.scale;
    let i = scale.indexOf(this.lastNote);
    i = Math.max(0, Math.min(scale.length - 1, i + Math.floor(Math.random() * 5) - 2));
    this.lastNote = scale[i];
    AudioKit.inst.lead(this.ctx, this.bus, t, this.lastNote, 0.5, len);
  }
}

const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '=': '-...-', '/': '-..-.', '?': '..--..', '.': '.-.-.-',
};

/* Телеграфный маяк: передаёт текст азбукой Морзе по кругу */
class MorseStation extends Station {
  constructor(def) {
    super({ lcd: 'CW · ТЕЛЕГРАФ', ...def });
    this.text = def.text;
    this.wpm = def.wpm ?? 14;    // слов в минуту
    this.tone = def.tone ?? 640; // Гц
    this.pause = def.pause ?? 4; // пауза между повторами, с
  }

  build(ctx) {
    super.build(ctx);
    this.unit = 1.2 / this.wpm; // длительность точки
    const osc = ctx.createOscillator();
    osc.frequency.value = this.tone;
    this.key = ctx.createGain();
    this.key.gain.value = 0;
    osc.connect(this.key).connect(this.output);
    osc.start();
    this.nextTime = ctx.currentTime + 0.3;
    this.pos = 0;
    return this.output;
  }

  schedule(until) {
    const u = this.unit;
    while (this.nextTime < until) {
      const ch = this.text[this.pos];
      this.pos = (this.pos + 1) % this.text.length;
      if (ch === ' ') {
        this.nextTime += 4 * u; // после знака уже есть 3 точки паузы, между словами нужно 7
      } else if (MORSE[ch]) {
        let t = this.nextTime;
        for (const el of MORSE[ch]) {
          const len = el === '.' ? u : 3 * u;
          this.keyDown(t, len);
          t += len + u;
        }
        this.nextTime = t + 2 * u;
      }
      if (this.pos === 0) this.nextTime += this.pause;
    }
  }

  keyDown(t, len) {
    const g = this.key.gain;
    const ramp = 0.005; // без щелчков на фронтах
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(0.2, t + ramp);
    g.setValueAtTime(0.2, t + len - ramp);
    g.linearRampToValueAtTime(0, t + len);
  }

}

/* Жужжалка — дань уважения УВБ-76: короткий гудок примерно раз в две секунды */
class BuzzerStation extends Station {
  constructor(def) {
    super({ lcd: '— НЕТ ДАННЫХ —', ...def });
  }

  build(ctx) {
    super.build(ctx);
    const lp = AudioKit.filter(ctx, 'lowpass', 1400, 2);
    for (const [freq, type, gain] of [[118, 'sawtooth', 0.25], [119.3, 'square', 0.12]]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(lp);
      osc.start();
    }
    this.key = ctx.createGain();
    this.key.gain.value = 0;
    lp.connect(this.key).connect(this.output);
    this.nextTime = ctx.currentTime + 0.2;
    return this.output;
  }

  schedule(until) {
    const g = this.key.gain;
    while (this.nextTime < until) {
      const t = this.nextTime;
      const len = 1.05 + Math.random() * 0.1;
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(0.8, t + 0.02);
      g.setValueAtTime(0.8, t + len - 0.03);
      g.linearRampToValueAtTime(0, t + len);
      this.nextTime += 2.4;
    }
  }
}

const FSK_TONES = [1150, 1400, 1650, 1900, 2150];

/*
 * Шифрованный канал. Без ключа слышен только цифровой треск,
 * с правильным ключом — то, что на самом деле передаётся.
 */
class CipherStation extends Station {
  constructor(def) {
    super(def);
    this.encrypted = true;
    this.keyValue = def.key;
    this.clearName = def.clearName;
    this.melody = def.melody;  // [midi | null, доли]
    this.bassLine = def.bass;  // по ноте на такт
    this.tempo = def.tempo;
    this.decrypted = false;
  }

  build(ctx) {
    super.build(ctx);
    this.cipherBus = ctx.createGain();
    this.clearBus = ctx.createGain();
    this.cipherBus.connect(this.output);
    this.clearBus.connect(this.output);

    // Шифротекст: FSK-посылки и шумовые пакеты
    this.fsk = ctx.createOscillator();
    this.fsk.type = 'square';
    this.fskGain = ctx.createGain();
    this.fskGain.gain.value = 0;
    this.fsk.connect(AudioKit.filter(ctx, 'bandpass', 1700, 1.1)).connect(this.fskGain).connect(this.cipherBus);
    this.fsk.start();

    this.burstGain = ctx.createGain();
    this.burstGain.gain.value = 0;
    AudioKit.loop(ctx, AudioKit.sharedNoise(ctx))
      .connect(AudioKit.filter(ctx, 'bandpass', 2400, 0.6))
      .connect(this.burstGain)
      .connect(this.cipherBus);

    this.frame = 0.028;
    this.nextFrame = ctx.currentTime + 0.1;
    this.burstLeft = 0;
    this.gapLeft = 0;

    // Открытый сигнал
    this.beat = 60 / this.tempo;
    this.nextNote = ctx.currentTime + 0.1;
    this.noteIdx = 0;
    this.beatPos = 0;

    this.setDecrypted(this.decrypted, true);
    return this.output;
  }

  setDecrypted(on, immediate = false) {
    this.decrypted = on;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const tc = immediate ? 0.001 : 0.15;
    this.cipherBus.gain.setTargetAtTime(on ? 0 : 1, t, tc);
    this.clearBus.gain.setTargetAtTime(on ? 2.2 : 0, t, tc);
  }

  schedule(until) {
    while (this.nextFrame < until) {
      if (this.burstLeft === 0 && this.gapLeft === 0) {
        this.burstLeft = 30 + Math.floor(Math.random() * 60);
        this.gapLeft = 6 + Math.floor(Math.random() * 20);
      }
      const t = this.nextFrame;
      if (this.burstLeft > 0) {
        this.burstLeft--;
        this.fsk.frequency.setValueAtTime(FSK_TONES[Math.floor(Math.random() * FSK_TONES.length)], t);
        this.fskGain.gain.setValueAtTime(0.07 + Math.random() * 0.06, t);
        this.burstGain.gain.setValueAtTime(Math.random() < 0.35 ? 0.25 : 0.04, t);
      } else {
        this.gapLeft--;
        this.fskGain.gain.setValueAtTime(0, t);
        this.burstGain.gain.setValueAtTime(0, t);
      }
      this.nextFrame += this.frame;
    }

    const I = AudioKit.inst;
    while (this.nextNote < until) {
      const t = this.nextNote;
      const [midi, beats] = this.melody[this.noteIdx];
      if (this.beatPos % 4 === 0) {
        const root = this.bassLine[(this.beatPos / 4) % this.bassLine.length];
        I.bass(this.ctx, this.clearBus, t, root, 0.5, this.beat * 3.5);
      }
      if (midi != null) I.musicBox(this.ctx, this.clearBus, t, midi, 0.7);
      this.nextNote += beats * this.beat;
      this.beatPos += beats;
      this.noteIdx = (this.noteIdx + 1) % this.melody.length;
      if (this.noteIdx === 0) this.beatPos = 0;
    }
  }

  displayName() {
    return this.decrypted ? this.clearName : 'Шифрованный канал';
  }

  lcdText() {
    return this.decrypted ? `КАНАЛ ОТКРЫТ · ${this.clearName.toUpperCase()}` : 'ЗАШИФРОВАНО · НУЖЕН КЛЮЧ';
  }
}

const chord = (root, ...notes) => ({ root, notes });

const SECRET_THEME = [
  [69, 0.5], [74, 0.5], [77, 1], [76, 1], [74, 1],
  [72, 1], [69, 1], [70, 1], [69, 1],
  [67, 0.5], [70, 0.5], [74, 1], [72, 1], [70, 1],
  [69, 3], [null, 1],
  [69, 0.5], [74, 0.5], [77, 1], [79, 1], [81, 1],
  [82, 1], [81, 1], [79, 1], [77, 1],
  [76, 1], [73, 1], [76, 1], [69, 1],
  [74, 3], [null, 1],
];

function createStations() {
  return [
    new MusicStation({
      id: 'lampovaya', freq: 90.70, name: 'Ламповая волна', rds: 'ЛАМПОВАЯ ВОЛНА',
      style: 'lofi', tempo: 78, swing: 0.28,
      chords: [chord(41, 53, 57, 60, 64), chord(40, 52, 55, 59, 62), chord(38, 50, 53, 57, 60), chord(36, 48, 52, 55, 59)],
      scale: [67, 69, 72, 74, 76, 79, 81],
    }),
    new MorseStation({
      id: 'beacon', freq: 94.15, name: 'Телеграфный маяк',
      text: 'CQ CQ CQ DE R4DIO R4DIO = KEY 4271 = K',
    }),
    new BuzzerStation({ id: 'buzzer', freq: 99.35, name: 'Жужжалка' }),
    new CipherStation({
      id: 'secret', freq: 103.60, name: 'Шифрованный канал', clearName: 'Шкатулка',
      key: '4271', tempo: 84, melody: SECRET_THEME, bass: [38, 41, 43, 45, 38, 46, 45, 38],
    }),
    new MusicStation({
      id: 'far', freq: 106.85, name: 'Дальняя волна', rds: 'ДАЛЬНЯЯ ВОЛНА',
      power: 0.5, fading: 1, style: 'arp', tempo: 72, gain: 2.6,
      chords: [chord(45, 57, 60, 64), chord(41, 53, 57, 60), chord(36, 55, 60, 64), chord(43, 55, 59, 62)],
      scale: [69, 72, 74, 76, 79, 81],
    }),
  ];
}
