'use strict';

/*
 * Сдвиг высоты голоса без изменения скорости (voice.js). Две «головки» читают из кольцевого буфера
 * с плавно меняющейся задержкой и перекрёстно затухают — классический pitch shifter на линиях
 * задержки. ratio < 1 — ниже (грубее), > 1 — выше.
 */
class VoicePitch extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.5, maxValue: 2, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.size = 8192;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.phase = 0;
    this.window = Math.round(sampleRate * 0.045); // ~45 мс — для речи без «дребезга»
  }

  read(delay) {
    let pos = this.w - delay;
    while (pos < 0) pos += this.size;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buf[i % this.size];
    const b = this.buf[(i + 1) % this.size];
    return a + (b - a) * f;
  }

  process(inputs, outputs, params) {
    const input = inputs[0][0];
    const output = outputs[0][0];
    if (!output) return true;
    const ratio = params.ratio[0];
    const W = this.window;
    const step = (1 - ratio) / W;
    for (let n = 0; n < output.length; n++) {
      this.buf[this.w] = input ? input[n] : 0;
      if (ratio === 1) {
        output[n] = this.buf[this.w];
      } else {
        this.phase += step;
        this.phase -= Math.floor(this.phase);
        const p2 = (this.phase + 0.5) % 1;
        const g1 = Math.sin(Math.PI * this.phase) ** 2;
        const g2 = 1 - g1;
        output[n] = this.read(this.phase * W + 1) * g1 + this.read(p2 * W + 1) * g2;
      }
      this.w = (this.w + 1) % this.size;
    }
    return true;
  }
}

registerProcessor('voice-pitch', VoicePitch);
