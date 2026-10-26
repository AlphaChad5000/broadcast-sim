// Stadium sound and the radio voice, all synthesized: crowd bed from
// filtered noise that swells on big moments, the whistle, pads popping,
// the thump of a kick. The announcer is the browser's speech synthesis
// reading the call (src/football/call.js) at the moments the clip marks.

export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.voice = true;
    this.lastSaid = -1;
  }

  start() {
    if (this.ctx) return;
    const ac = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = ac.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ac.destination);
    // crowd: two bands of noise, one murmur, one roar
    const noise = ac.createBuffer(1, ac.sampleRate * 4, ac.sampleRate);
    const d = noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 6 + (Math.random() * 2 - 1) * 0.15; }
    const src = ac.createBufferSource();
    src.buffer = noise; src.loop = true;
    const murmur = ac.createBiquadFilter(); murmur.type = 'bandpass'; murmur.frequency.value = 420; murmur.Q.value = 0.6;
    const roar = ac.createBiquadFilter(); roar.type = 'bandpass'; roar.frequency.value = 1100; roar.Q.value = 0.5;
    this.murmurGain = ac.createGain(); this.murmurGain.gain.value = 0.18;
    this.roarGain = ac.createGain(); this.roarGain.gain.value = 0.0;
    src.connect(murmur).connect(this.murmurGain).connect(this.master);
    src.connect(roar).connect(this.roarGain).connect(this.master);
    src.start();
    this.enabled = true;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.1);
    if (!on) window.speechSynthesis?.cancel();
  }

  // excitement 0..1: the roar rides on it
  crowd(level) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.roarGain.gain.setTargetAtTime(Math.min(0.9, level * 0.85), t, level > this.lastLevel ? 0.15 : 1.2);
    this.murmurGain.gain.setTargetAtTime(0.16 + level * 0.12, t, 0.5);
    this.lastLevel = level;
  }

  whistle() {
    if (!this.ctx || !this.enabled) return;
    const ac = this.ctx, t = ac.currentTime;
    const o = ac.createOscillator(), o2 = ac.createOscillator(), g = ac.createGain(), trem = ac.createOscillator(), tg = ac.createGain();
    o.frequency.value = 2900; o2.frequency.value = 3180;
    trem.frequency.value = 38; tg.gain.value = 0.35;
    trem.connect(tg).connect(g.gain);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.03);
    g.gain.setValueAtTime(0.05, t + 0.45);
    g.gain.linearRampToValueAtTime(0, t + 0.55);
    o.connect(g); o2.connect(g); g.connect(this.master);
    for (const x of [o, o2, trem]) { x.start(t); x.stop(t + 0.6); }
  }

  thud(strength = 1) {
    if (!this.ctx || !this.enabled) return;
    const ac = this.ctx, t = ac.currentTime;
    const buf = ac.createBuffer(1, ac.sampleRate * 0.25, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 4);
    const s = ac.createBufferSource(); s.buffer = buf;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
    const g = ac.createGain(); g.gain.value = 0.5 * strength;
    s.connect(f).connect(g).connect(this.master);
    s.start(t);
  }

  kick() {
    if (!this.ctx || !this.enabled) return;
    const ac = this.ctx, t = ac.currentTime;
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.12);
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.2);
    this.thud(0.6);
  }

  say(text, urgent) {
    if (!this.voice || !this.enabled || !window.speechSynthesis) return;
    const sy = window.speechSynthesis;
    // stay with the picture: drop a backlog rather than fall behind
    if (urgent || sy.pending) sy.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = urgent ? 1.22 : 1.12;
    u.pitch = urgent ? 1.08 : 0.98;
    u.volume = 1;
    const voices = sy.getVoices();
    const pick = voices.find(v => /en-US/i.test(v.lang) && /Guy|Davis|Andrew|Christopher|Daniel|Male|David/i.test(v.name)) || voices.find(v => /en-US/i.test(v.lang)) || voices[0];
    if (pick) u.voice = pick;
    sy.speak(u);
  }
}
