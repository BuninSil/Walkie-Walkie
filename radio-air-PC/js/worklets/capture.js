'use strict';

/*
 * Захват звука для эфира. Понижает частоту дискретизации до targetRate,
 * режет поток на куски по chunk сэмплов и отдаёт их основному потоку в Int16.
 * Работает в отдельном аудиопотоке браузера (AudioWorklet).
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetRate, chunk } = options.processorOptions;
    this.step = sampleRate / targetRate; // sampleRate — частота контекста, глобальная в ворклете
    this.t = 0;                          // позиция следующего сэмпла относительно текущего блока
    this.prev = 0;                       // последний сэмпл прошлого блока — для интерполяции
    this.chunk = chunk;
    this.out = new Int16Array(chunk);
    this.n = 0;
    this.peak = 0;
    this.silence = new Float32Array(128);
  }

  process(inputs) {
    // Без источников вход пустой — передаём тишину, чтобы несущая не пропадала
    const input = inputs[0][0] || this.silence;
    const len = input.length;
    let t = this.t;
    while (t <= len - 1) {
      const i = Math.floor(t);
      const a = i < 0 ? this.prev : input[i];
      const b = i + 1 < len ? input[i + 1] : a;
      const s = Math.max(-1, Math.min(1, a + (b - a) * (t - i)));
      const abs = Math.abs(s);
      if (abs > this.peak) this.peak = abs;
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === this.chunk) {
        this.port.postMessage({ pcm: this.out.buffer, peak: this.peak }, [this.out.buffer]);
        this.out = new Int16Array(this.chunk);
        this.n = 0;
        this.peak = 0;
      }
      t += this.step;
    }
    this.t = t - len;
    this.prev = input[len - 1];
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
