// audio.js — HM.Audio: 100% procedural WebAudio (no files).
//   graph:  voices ─▶ sfxBus ─────────────────────────────┐
//           beds   ─▶ ambBus ─┐                            ├─▶ master ─▶ compressor ─▶ out
//           music  ─▶ musBus ─┴─▶ worldLP (pause muffle) ─▶ duck (hitstop) ┘
//           everything may also send to a generated-IR reverb.
//   play(name,{x,y,vol,pitch}) synthesizes each SFX from noise bursts, filtered sweeps, FM bells and plucks, with random
//   variation, per-name rate limiting, a voice cap, stereo pan + distance attenuation from the player/camera.
//   ambient(biome|'title', isBoss) crossfades evolving beds; music('boss') runs a sequenced dark loop that intensifies per
//   boss phase; tick(dt) (called by FX.update) schedules beds/music, the low-HP heartbeat and hitstop ducking.
// Every entry point is a safe no-op when there is no AudioContext (Node smoke test, very old browsers).
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const HM = (globalThis.window || globalThis).HM;
  const W = globalThis.window || globalThis;
  const AC = W.AudioContext || W.webkitAudioContext || null;
  const rand = Math.random;
  const rr = (a, b) => a + (b - a) * rand();
  const pick = (arr) => arr[(rand() * arr.length) | 0];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const MIN = 0.0001;

  let ctx = null, master = null, comp = null, sfxBus = null, ambBus = null, musBus = null, worldLP = null, duck = null, verb = null, verbIn = null;
  let whiteBuf = null, pinkBuf = null, brownBuf = null;
  const vol = { master: 0.8, sfx: 0.9, music: 0.55 };
  const voices = [];          // {out, end, name, prio}
  const garbage = [];         // {node, at} nodes to disconnect later
  const lastPlay = {};        // name -> ctx time
  let want = { amb: null, boss: false, music: null };
  let bed = null, oldBeds = [];
  let mus = null;
  let hbNext = 0, interval = null, lastSched = 0, lastStatePause = false, bossGoneT = 0, lastTick = 0, duckOn = false;
  const shaperCache = {};

  // ===========================================================================================
  // low-level helpers (all times absolute, ctx.currentTime based)
  // ===========================================================================================
  function mkNoise(kind) {
    const len = Math.floor(ctx.sampleRate * 2), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = rand() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
      else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    }
    return b;
  }
  function mkVerb() {
    const sr = ctx.sampleRate, len = Math.floor(sr * 2.6), b = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (rand() * 2 - 1) * Math.pow(1 - i / len, 2.8) * (i < sr * 0.012 ? i / (sr * 0.012) : 1); }
    const cv = ctx.createConvolver(); cv.buffer = b; return cv;
  }
  function gain(v) { const g = ctx.createGain(); g.gain.value = v === undefined ? 1 : v; return g; }
  function filt(type, f, Q) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (Q !== undefined) b.Q.value = Q; return b; }
  function shaper(k) {
    const key = k | 0;
    if (!shaperCache[key]) { const n = 1024, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x)); } shaperCache[key] = c; }
    const s = ctx.createWaveShaper(); s.curve = shaperCache[key]; s.oversample = '2x'; return s;
  }
  // percussive envelope on a gain param: 0 → peak in a, exp decay over d
  function envAD(param, t, a, d, peak) {
    param.cancelScheduledValues(t); param.setValueAtTime(MIN, t);
    param.linearRampToValueAtTime(Math.max(MIN, peak), t + Math.max(0.001, a));
    param.exponentialRampToValueAtTime(MIN, t + a + Math.max(0.01, d));
  }
  // oscillator with exp pitch sweep + AD envelope → dest
  function tone(t, type, f0, f1, dur, peak, dest, a, opts) {
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(Math.max(1, f0), t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur * (opts && opts.sweep ? opts.sweep : 1));
    if (opts && opts.detune) o.detune.value = opts.detune;
    const g = gain(0); envAD(g.gain, t, a === undefined ? 0.004 : a, dur, peak);
    let tail = g;
    if (opts && opts.lp) { const f = filt('lowpass', opts.lp, opts.q || 0.7); g.connect(f); tail = f; }
    o.connect(g); tail.connect(dest);
    o.start(t); o.stop(t + (a || 0.004) + dur + 0.05);
    return o;
  }
  // filtered noise burst with cutoff sweep f0→f1
  function nz(t, dur, peak, ftype, f0, f1, Q, dest, a, buf) {
    const s = ctx.createBufferSource(); s.buffer = buf || whiteBuf; s.loop = true;
    const f = filt(ftype, f0, Q === undefined ? 0.8 : Q);
    if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = gain(0); envAD(g.gain, t, a === undefined ? 0.003 : a, dur, peak);
    s.connect(f).connect(g).connect(dest);
    s.start(t, rand() * 1.5); s.stop(t + (a || 0.003) + dur + 0.05);
    return f;
  }
  // FM bell: inharmonic modulator, decaying index
  function bell(t, f, dur, peak, dest, ratio) {
    const c = ctx.createOscillator(), m = ctx.createOscillator(), mg = gain(0), g = gain(0);
    c.type = 'sine'; m.type = 'sine'; c.frequency.value = f; m.frequency.value = f * (ratio || 1.41);
    mg.gain.setValueAtTime(f * 2.2, t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + dur * 0.6);
    m.connect(mg).connect(c.frequency); c.connect(g).connect(dest);
    envAD(g.gain, t, 0.002, dur, peak);
    c.start(t); m.start(t); c.stop(t + dur + 0.05); m.stop(t + dur + 0.05);
  }
  // soft pluck (music box / harp-ish)
  function pluck(t, f, dur, peak, dest, bright) {
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), lp = filt('lowpass', f * (bright || 4), 0.5), g = gain(0);
    o1.type = 'triangle'; o2.type = 'sine'; o1.frequency.value = f; o2.frequency.value = f * 2.003;
    lp.frequency.setValueAtTime(f * (bright || 4), t); lp.frequency.exponentialRampToValueAtTime(Math.max(80, f * 1.1), t + dur);
    const g2 = gain(0.35); o2.connect(g2).connect(lp); o1.connect(lp); lp.connect(g).connect(dest);
    envAD(g.gain, t, 0.003, dur, peak);
    o1.start(t); o2.start(t); o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }
  function lfo(param, freq, depth, type) {
    const o = ctx.createOscillator(), g = gain(depth); o.type = type || 'sine'; o.frequency.value = freq; o.connect(g).connect(param); o.start(); return o;
  }
  function loopSrc(buf) { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(ctx.currentTime, rand() * 1.8); return s; }
  function oscN(type, f, detune) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; if (detune) o.detune.value = detune; o.start(); return o; }
  function send(node, amt) { if (verbIn && amt > 0) { const g = gain(amt); node.connect(g); g.connect(verbIn); return g; } return null; }
  function crackle(t, dur, n, peak, dest) { for (let k = 0; k < n; k++) nz(t + rand() * dur, rr(0.004, 0.014), peak * rr(0.3, 1), 'highpass', rr(1500, 4000), 0, 0.7, dest, 0.001); }

  // ===========================================================================================
  // SFX library. Each builder: (t, out, P) → duration (s). P = pitch multiplier.
  // ===========================================================================================
  const SFX = {
    hit(t, o, P) {
      nz(t, 0.08, 0.7, 'bandpass', 1900 * P, 650 * P, 1.1, o);
      tone(t, 'sine', 160 * P, 52, 0.12, 0.85, o);
      tone(t, 'square', 2300 * P, 1100 * P, 0.012, 0.08, o);
      return 0.16;
    },
    crit(t, o, P) {
      SFX.hit(t, o, P * 0.9);
      bell(t + 0.005, 1450 * P, 0.38, 0.28, o, 2.76);
      nz(t, 0.14, 0.35, 'highpass', 4200, 2500, 0.7, o);
      tone(t, 'sine', 90, 38, 0.22, 0.6, o);
      return 0.42;
    },
    hit_fire(t, o, P) {
      nz(t, 0.24, 0.65, 'lowpass', 3200 * P, 450, 0.9, o, 0.006);
      tone(t, 'sine', 130 * P, 55, 0.14, 0.7, o);
      crackle(t + 0.02, 0.18, 4, 0.35, o);
      return 0.3;
    },
    hit_ice(t, o, P) {
      bell(t, 2300 * P, 0.26, 0.3, o, 2.4); bell(t + 0.012, 3450 * P, 0.2, 0.18, o, 1.9);
      nz(t, 0.07, 0.45, 'highpass', 5200, 3000, 0.7, o);
      tone(t, 'sine', 140 * P, 60, 0.09, 0.5, o);
      return 0.3;
    },
    hit_poison(t, o, P) {
      nz(t, 0.17, 0.75, 'bandpass', 1100 * P, 260, 4, o, 0.01);
      tone(t, 'sine', 420 * P, 170, 0.12, 0.35, o);
      tone(t + 0.05, 'sine', 300 * P, 520 * P, 0.06, 0.18, o);
      return 0.24;
    },
    hit_shadow(t, o, P) {
      const lp = filt('lowpass', 700, 2); lp.connect(o);
      tone(t, 'sawtooth', 92 * P, 58, 0.3, 0.45, lp, 0.01); tone(t, 'sawtooth', 97 * P, 61, 0.3, 0.4, lp, 0.01);
      nz(t, 0.24, 0.6, 'lowpass', 500, 180, 1, o, 0.02);
      return 0.36;
    },
    hit_holy(t, o, P) {
      bell(t, 880 * P, 0.45, 0.25, o, 2); bell(t + 0.01, 1320 * P, 0.4, 0.18, o, 2);
      nz(t, 0.2, 0.25, 'highpass', 6500, 5000, 0.7, o, 0.01);
      tone(t, 'sine', 150 * P, 70, 0.1, 0.5, o);
      return 0.5;
    },
    shatter(t, o, P) {
      for (let k = 0; k < 7; k++) bell(t + rand() * 0.07, rr(2000, 5200) * P, rr(0.15, 0.35), rr(0.12, 0.24), o, rr(1.3, 3.1));
      nz(t, 0.4, 0.55, 'highpass', 3200, 6000, 0.7, o);
      tone(t, 'sine', 180, 60, 0.12, 0.4, o);
      return 0.5;
    },
    swing(t, o, P) { nz(t, 0.15, 0.5, 'bandpass', 650 * P, 2700 * P, 1.6, o, 0.035); return 0.22; },
    swing_heavy(t, o, P) {
      nz(t, 0.3, 0.7, 'bandpass', 280 * P, 1500 * P, 1.3, o, 0.07);
      tone(t + 0.03, 'sine', 85 * P, 48, 0.22, 0.32, o, 0.04);
      return 0.4;
    },
    dodge(t, o, P) {
      nz(t, 0.22, 0.45, 'lowpass', 1500 * P, 380, 0.9, o, 0.04);
      nz(t, 0.12, 0.18, 'bandpass', 2600 * P, 1600, 2, o, 0.02);
      return 0.3;
    },
    step(t, o, P) { nz(t, 0.045, 0.32, 'lowpass', rr(420, 650) * P, 200, 1, o, 0.002); return 0.08; },
    fire(t, o, P) {
      nz(t, 0.6, 0.8, 'lowpass', 1900 * P, 520, 0.8, o, 0.04);
      nz(t, 0.75, 0.6, 'lowpass', 220, 90, 1, o, 0.05, brownBuf);
      crackle(t + 0.05, 0.55, 9, 0.3, o);
      return 0.85;
    },
    fireball(t, o, P) {
      nz(t, 0.35, 0.6, 'bandpass', 420 * P, 1900 * P, 2, o, 0.02);
      tone(t, 'sine', 210 * P, 85, 0.25, 0.5, o);
      crackle(t + 0.03, 0.25, 4, 0.25, o);
      return 0.42;
    },
    explode(t, o, P) {
      const sh = shaper(18); sh.connect(o);
      tone(t, 'sine', 95 * P, 28, 0.85, 1.0, sh);
      nz(t, 0.9, 0.9, 'lowpass', 2600 * P, 180, 0.8, sh, 0.004);
      nz(t, 1.3, 0.7, 'lowpass', 160, 60, 1, o, 0.02, brownBuf);
      crackle(t + 0.06, 0.6, 8, 0.25, o);
      return 1.4;
    },
    ice(t, o, P) {
      for (let k = 0; k < 4; k++) bell(t + k * rr(0.02, 0.05), rr(1800, 4300) * P, rr(0.3, 0.55), 0.16, o, rr(1.5, 2.9));
      nz(t, 0.35, 0.22, 'highpass', 7000, 4000, 0.7, o, 0.03);
      return 0.6;
    },
    poison(t, o, P) {
      for (let k = 0; k < 4; k++) { const f = rr(280, 620) * P; tone(t + k * rr(0.04, 0.07), 'sine', f, f * 1.9, 0.06, 0.3, o, 0.003, { sweep: 0.8 }); }
      nz(t, 0.24, 0.3, 'bandpass', 700, 300, 3, o, 0.02);
      return 0.4;
    },
    bone_break(t, o, P) {
      for (let k = 0; k < 3; k++) { const tt = t + k * rr(0.025, 0.045); nz(tt, 0.03, 0.75, 'bandpass', rr(2000, 3200) * P, 1200, 3, o, 0.001); tone(tt, 'square', rr(700, 1000) * P, 260, 0.035, 0.12, o, 0.001); }
      tone(t, 'sine', 120 * P, 60, 0.1, 0.4, o);
      return 0.25;
    },
    death(t, o, P) {
      tone(t, 'sawtooth', 230 * P, 66, 0.5, 0.28, o, 0.01, { lp: 900 });
      nz(t + 0.05, 0.3, 0.5, 'lowpass', 600, 150, 1, o, 0.01);
      tone(t + 0.05, 'sine', 75, 38, 0.32, 0.6, o);
      return 0.6;
    },
    death_big(t, o, P) {
      const lp = filt('lowpass', 1200, 1.5); lp.frequency.setValueAtTime(1600, t); lp.frequency.exponentialRampToValueAtTime(150, t + 1.8); lp.connect(o);
      tone(t, 'sawtooth', 112 * P, 34, 1.7, 0.4, lp, 0.02); tone(t, 'sawtooth', 117 * P, 33, 1.7, 0.35, lp, 0.02);
      SFX.explode(t + 0.05, o, P * 0.8);
      send(lp, 0.6);
      return 2.0;
    },
    pickup(t, o, P) { pluck(t, 660 * P, 0.18, 0.4, o, 6); pluck(t + 0.065, 990 * P, 0.25, 0.35, o, 6); return 0.35; },
    gold(t, o, P) { bell(t, rr(2500, 2700) * P, 0.16, 0.22, o, 1.5); bell(t + rr(0.03, 0.06), rr(3300, 3500) * P, 0.14, 0.16, o, 1.5); return 0.24; },
    levelup(t, o, P) {
      const notes = [57, 60, 64, 69, 72];
      notes.forEach((m, k) => bell(t + k * 0.075, mtof(m + 12) * P, 0.9, 0.2, o, 2));
      tone(t, 'sine', mtof(45), mtof(45), 1.0, 0.18, o, 0.08); tone(t, 'sine', mtof(52), mtof(52), 1.0, 0.1, o, 0.1);
      nz(t + 0.2, 0.7, 0.12, 'highpass', 7000, 9000, 0.7, o, 0.2);
      return 1.3;
    },
    portal(t, o, P) {
      tone(t, 'sine', 110 * P, 440 * P, 1.2, 0.35, o, 0.3);
      const f = nz(t, 1.3, 0.35, 'bandpass', 300, 3200, 6, o, 0.4); void f;
      bell(t + 1.0, 880 * P, 1.2, 0.2, o, 1.5);
      return 2.2;
    },
    boon(t, o, P) {
      [76, 81, 88].forEach((m, k) => bell(t + k * 0.04, mtof(m) * P, 1.1, 0.16, o, 2));
      nz(t, 0.9, 0.12, 'highpass', 6500, 8000, 0.7, o, 0.25);
      tone(t, 'sine', mtof(52), mtof(52), 1.2, 0.12, o, 0.2);
      return 1.3;
    },
    ui_move(t, o, P) { tone(t, 'square', 1750 * P, 1750 * P, 0.018, 0.06, o, 0.001, { lp: 4000 }); return 0.05; },
    ui_select(t, o, P) { tone(t, 'triangle', 660 * P, 660 * P, 0.06, 0.22, o); tone(t + 0.055, 'triangle', 990 * P, 990 * P, 0.1, 0.2, o); return 0.2; },
    ui_back(t, o, P) { tone(t, 'triangle', 660 * P, 660 * P, 0.06, 0.2, o); tone(t + 0.055, 'triangle', 440 * P, 440 * P, 0.1, 0.18, o); return 0.2; },
    ui_error(t, o, P) { tone(t, 'square', 140 * P, 130, 0.08, 0.15, o, 0.002, { lp: 1200 }); tone(t + 0.11, 'square', 140 * P, 120, 0.1, 0.15, o, 0.002, { lp: 1200 }); return 0.25; },
    bossRoar(t, o, P) {
      const sh = shaper(30), lp = filt('lowpass', 300, 3), g = gain(1);
      lp.frequency.setValueAtTime(260, t); lp.frequency.linearRampToValueAtTime(1300, t + 0.35); lp.frequency.exponentialRampToValueAtTime(220, t + 1.9);
      sh.connect(lp).connect(g).connect(o);
      const trem = ctx.createOscillator(), tg = gain(0.35); trem.frequency.value = 11; trem.connect(tg).connect(g.gain); trem.start(t); trem.stop(t + 2.1);
      for (const [f, d] of [[55, 0], [58.5, 7], [82, -5], [41, 0]]) tone(t, 'sawtooth', f * P * 1.3, f * P * 0.85, 1.9, 0.35, sh, 0.12, { detune: d });
      nz(t, 1.7, 0.5, 'lowpass', 900, 250, 1, o, 0.1);
      nz(t, 1.9, 0.6, 'lowpass', 140, 60, 1, o, 0.15, brownBuf);
      send(g, 0.7);
      return 2.2;
    },
    zombie(t, o, P) {
      const bp = filt('bandpass', 450, 5); bp.frequency.setValueAtTime(380, t); bp.frequency.linearRampToValueAtTime(950, t + 0.35); bp.frequency.linearRampToValueAtTime(480, t + 0.85); bp.connect(o);
      const osc = tone(t, 'sawtooth', 112 * P, 88 * P, 0.85, 0.6, bp, 0.12);
      const v = ctx.createOscillator(), vg = gain(6); v.frequency.value = 5.5; v.connect(vg).connect(osc.frequency); v.start(t); v.stop(t + 1);
      nz(t, 0.7, 0.12, 'bandpass', 1400, 900, 2, o, 0.1);
      return 1.0;
    },
    wenk(t, o, P) {
      const bp = filt('bandpass', 1250 * P, 2.5); bp.connect(o);
      const osc = ctx.createOscillator(), g = gain(0); osc.type = 'square';
      osc.frequency.setValueAtTime(620 * P, t); osc.frequency.linearRampToValueAtTime(930 * P, t + 0.05); osc.frequency.exponentialRampToValueAtTime(500 * P, t + 0.17);
      envAD(g.gain, t, 0.01, 0.17, 0.5); osc.connect(g).connect(bp); osc.start(t); osc.stop(t + 0.25);
      return 0.25;
    },
    lich_laugh(t, o, P) {
      const g = gain(1); g.connect(o); send(g, 0.9);
      for (let k = 0; k < 5; k++) {
        const tt = t + k * 0.17, f = (175 - k * 9) * P;
        const bp = filt('bandpass', 720, 3.5), bp2 = filt('bandpass', 1150, 5); bp.connect(g); bp2.connect(g);
        const osc = tone(tt, 'sawtooth', f, f * 0.82, 0.13, 0.55 - k * 0.06, bp, 0.012); osc.connect(bp2);
        nz(tt, 0.1, 0.12, 'bandpass', 2400, 1500, 2, g, 0.01);
      }
      tone(t, 'sine', 55, 40, 1.1, 0.25, g, 0.2);
      return 1.6;
    },
    shriek(t, o, P) {
      const bp = filt('bandpass', 2400 * P, 2); bp.connect(o);
      const osc = ctx.createOscillator(), g = gain(0); osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(1250 * P, t); osc.frequency.linearRampToValueAtTime(2150 * P, t + 0.12); osc.frequency.exponentialRampToValueAtTime(1500 * P, t + 0.55);
      const v = ctx.createOscillator(), vg = gain(60); v.frequency.value = 17; v.connect(vg).connect(osc.frequency); v.start(t); v.stop(t + 0.65);
      envAD(g.gain, t, 0.03, 0.52, 0.4); osc.connect(g).connect(bp); osc.start(t); osc.stop(t + 0.65);
      nz(t, 0.45, 0.18, 'highpass', 5000, 3000, 0.7, o, 0.03);
      send(bp, 0.4);
      return 0.7;
    },
    sonic(t, o, P) {
      const sh = shaper(55), lp = filt('lowpass', 3200, 1.5); lp.frequency.setValueAtTime(3400, t); lp.frequency.exponentialRampToValueAtTime(420, t + 0.7);
      sh.connect(lp).connect(o); send(lp, 0.4);
      for (const f of [82.4, 123.5, 164.8]) tone(t, 'sawtooth', f * P, f * P * 0.98, 0.7, 0.22, sh, 0.005);
      tone(t, 'sine', 55 * P, 41, 0.6, 0.6, o);
      return 0.85;
    },
    bat(t, o, P) {
      const bp = filt('bandpass', 2200 * P, 2), g = gain(0); bp.connect(g).connect(o);
      const s = ctx.createBufferSource(); s.buffer = whiteBuf; s.loop = true; s.connect(bp); s.start(t, rand()); s.stop(t + 0.35);
      envAD(g.gain, t, 0.02, 0.28, 0.4);
      const fl = ctx.createOscillator(), fg = gain(0.35); fl.type = 'square'; fl.frequency.value = 26; fl.connect(fg).connect(g.gain); fl.start(t); fl.stop(t + 0.35);
      tone(t + 0.03, 'sine', 4300 * P, 5300 * P, 0.04, 0.08, o); tone(t + 0.13, 'sine', 4600 * P, 5600 * P, 0.04, 0.06, o);
      return 0.4;
    },
    jake_stretch(t, o, P) {
      const osc = ctx.createOscillator(), g = gain(0); osc.type = 'sine';
      osc.frequency.setValueAtTime(170 * P, t); osc.frequency.exponentialRampToValueAtTime(540 * P, t + 0.2); osc.frequency.exponentialRampToValueAtTime(230 * P, t + 0.48);
      const v = ctx.createOscillator(), vg = gain(18); v.frequency.value = 7; v.connect(vg).connect(osc.frequency); v.start(t); v.stop(t + 0.55);
      envAD(g.gain, t, 0.02, 0.48, 0.5); osc.connect(g).connect(o); osc.start(t); osc.stop(t + 0.55);
      tone(t, 'triangle', 340 * P, 1000 * P, 0.25, 0.12, o, 0.02);
      return 0.6;
    },
    potion(t, o, P) {
      for (let k = 0; k < 3; k++) tone(t + k * 0.09, 'sine', rr(240, 300) * P, 170 * P, 0.07, 0.4, o, 0.005, { lp: 900 });
      bell(t + 0.3, 1320 * P, 0.6, 0.12, o, 2); nz(t + 0.28, 0.4, 0.08, 'highpass', 7000, 9000, 0.7, o, 0.1);
      return 0.9;
    },
    chest(t, o, P) {
      tone(t, 'sawtooth', 140 * P, 230 * P, 0.32, 0.18, o, 0.05, { lp: 900, q: 6 });
      tone(t + 0.3, 'sine', 120 * P, 55, 0.18, 0.55, o); nz(t + 0.3, 0.12, 0.35, 'lowpass', 500, 200, 1, o);
      bell(t + 0.42, 1760 * P, 0.5, 0.12, o, 2); bell(t + 0.48, 2350 * P, 0.4, 0.08, o, 2);
      return 0.95;
    },
    shrine(t, o, P) {
      const g = gain(1); g.connect(o); send(g, 0.8);
      for (const m of [57, 60, 64, 69]) { const f = mtof(m) * P; const osc = ctx.createOscillator(), og = gain(0); osc.type = 'sine'; osc.frequency.value = f; og.gain.setValueAtTime(MIN, t); og.gain.linearRampToValueAtTime(0.09, t + 0.45); og.gain.exponentialRampToValueAtTime(MIN, t + 2.0); osc.connect(og).connect(g); osc.start(t); osc.stop(t + 2.1); }
      nz(t + 0.2, 1.4, 0.07, 'highpass', 6000, 9000, 0.7, g, 0.4);
      return 2.2;
    },
    note(t, o, P) {
      nz(t, 0.1, 0.28, 'bandpass', 3200, 2200, 1, o, 0.01); nz(t + 0.09, 0.12, 0.22, 'bandpass', 2800, 1800, 1, o, 0.01);
      bell(t + 0.12, 880 * P, 0.8, 0.12, o, 2); send(o, 0.3);
      return 1.0;
    },
    door(t, o, P) {
      nz(t, 0.8, 0.6, 'lowpass', 320 * P, 140, 2, o, 0.1, brownBuf);
      nz(t, 0.7, 0.15, 'bandpass', 900, 600, 4, o, 0.15);
      tone(t + 0.7, 'sine', 62 * P, 38, 0.4, 0.7, o);
      return 1.2;
    },
    heartbeat(t, o, P) {
      tone(t, 'sine', 62 * P, 40, 0.11, 1.0, o, 0.004, { lp: 220 });
      tone(t + 0.17, 'sine', 56 * P, 38, 0.13, 0.7, o, 0.004, { lp: 200 });
      return 0.35;
    },
  };
  // per-name base volume, min interval (s), priority (1 = may steal a voice)
  const META = {
    hit: [0.55, 0.03], crit: [0.75, 0.04], hit_fire: [0.5, 0.035], hit_ice: [0.5, 0.035], hit_poison: [0.45, 0.04], hit_shadow: [0.55, 0.04], hit_holy: [0.5, 0.04],
    shatter: [0.7, 0.06], swing: [0.45, 0.03], swing_heavy: [0.6, 0.05], dodge: [0.5, 0.06], step: [0.16, 0.07], fire: [0.7, 0.08], fireball: [0.55, 0.04],
    explode: [0.85, 0.05, 1], ice: [0.55, 0.05], poison: [0.45, 0.05], bone_break: [0.6, 0.04], death: [0.5, 0.04], death_big: [0.9, 0.2, 1],
    pickup: [0.5, 0.05, 1], gold: [0.35, 0.04], levelup: [0.75, 0.3, 1], portal: [0.7, 0.4, 1], boon: [0.7, 0.2, 1],
    ui_move: [0.35, 0.03, 1], ui_select: [0.5, 0.04, 1], ui_back: [0.5, 0.04, 1], ui_error: [0.5, 0.08, 1],
    bossRoar: [1.0, 0.6, 1], zombie: [0.4, 0.25], wenk: [0.4, 0.12], lich_laugh: [0.9, 0.8, 1], shriek: [0.5, 0.2], sonic: [0.7, 0.08],
    bat: [0.4, 0.05], jake_stretch: [0.7, 0.1, 1], potion: [0.6, 0.1, 1], chest: [0.7, 0.2, 1], shrine: [0.7, 0.3, 1], note: [0.6, 0.2, 1], door: [0.8, 0.3, 1],
    heartbeat: [0.7, 0.25, 1],
  };
  const VOICE_CAP = 30;

  function listener() {
    const G = HM.Game; if (!G) return null;
    const p = G.player; if (p && !p.dead) return p;
    return G.cam || null;
  }
  function cleanup(now) {
    for (let k = voices.length - 1; k >= 0; k--) { const v = voices[k]; if (v.end < now) { try { v.out.disconnect(); } catch (e) { /* already gone */ } voices.splice(k, 1); } }
    for (let k = garbage.length - 1; k >= 0; k--) { const g = garbage[k]; if (g.at < now) { try { g.node.disconnect(); } catch (e) { /* ignore */ } garbage.splice(k, 1); } }
  }

  // ===========================================================================================
  // Ambient beds — each returns {gain, nodes[], sched(now, horizon), level}
  // ===========================================================================================
  const A_MINOR_PENTA = [69, 72, 74, 76, 79, 81, 84];
  function newBed(id, level) { const b = { id, level, gain: gain(0), nodes: [], t0: ctx.currentTime }; b.gain.connect(ambBus); return b; }
  function keep(b, ...n) { for (const x of n) b.nodes.push(x); }
  function windLayer(b, buf, f, q, lv, rate, depth) {
    const s = loopSrc(buf), bp = filt('bandpass', f, q), g = gain(lv);
    s.connect(bp).connect(g).connect(b.gain);
    keep(b, s, lfo(bp.frequency, rate, depth), lfo(g.gain, rate * 1.37, lv * 0.6));
    return g;
  }
  function droneLayer(b, freqs, type, lp, lv) {
    const f = filt('lowpass', lp, 0.7), g = gain(lv); f.connect(g).connect(b.gain);
    for (const [fr, det] of freqs) keep(b, (() => { const o = oscN(type, fr, det); o.connect(f); return o; })());
    keep(b, lfo(g.gain, 0.045, lv * 0.45));
    return g;
  }
  const BEDS = {
    grass(b) {
      windLayer(b, pinkBuf, 480, 0.6, 0.2, 0.06, 260);
      droneLayer(b, [[55, 0], [82.5, 4], [110, -3]], 'triangle', 240, 0.05);
      b.nChime = ctx.currentTime + 1.5; b.nCrick = ctx.currentTime + 0.8;
      b.sched = (now, h) => {
        while (b.nChime < h) { const t = b.nChime; const m = pick(A_MINOR_PENTA) + (rand() < 0.3 ? 12 : 0); const g = gain(1); g.connect(b.gain); send(g, 0.9); bell(t, mtof(m), rr(1.6, 2.6), rr(0.02, 0.04), g, rand() < 0.5 ? 3.5 : 2.01); if (rand() < 0.4) bell(t + rr(0.15, 0.4), mtof(pick(A_MINOR_PENTA)), 2, 0.02, g, 3.5); garbage.push({ node: g, at: t + 3.5 }); b.nChime += rr(2.5, 7.5); }
        while (b.nCrick < h) { const t = b.nCrick; const n = 3 + ((rand() * 6) | 0), f = rr(4200, 5200); for (let k = 0; k < n; k++) tone(t + k * 0.055, 'sine', f, f * 0.97, 0.03, 0.012, b.gain, 0.004); b.nCrick += rr(0.9, 4); }
      };
    },
    candy(b) {
      windLayer(b, pinkBuf, 380, 0.5, 0.07, 0.05, 150);
      droneLayer(b, [[98, 0], [146.8, 9]], 'sine', 300, 0.035);
      // detuned music box with tape-warble: E harmonic minor fragments
      const tune = [76, 79, 83, 84, 83, 79, 75, 76, 71, 72, 75, 79, 78, 75, 71, 0];
      b.step = 0; b.nNote = ctx.currentTime + 0.6; b.warble = 0;
      b.sched = (now, h) => {
        while (b.nNote < h) {
          const t = b.nNote, m = tune[b.step % tune.length]; b.step++;
          if (m && rand() > 0.12) {
            const det = Math.sin(t * 0.7) * 22 + rr(-8, 8); // slow warp
            const f = mtof(m) * Math.pow(2, det / 1200);
            const g = gain(1); g.connect(b.gain); send(g, 0.7); garbage.push({ node: g, at: t + 2.5 });
            bell(t, f, 1.4, 0.03, g, 3.0); bell(t + 0.004, f * 1.007, 1.2, 0.02, g, 4.0);
          }
          b.nNote += 0.46 * (b.step % 16 === 0 ? 3 : 1) + rr(-0.02, 0.03);
        }
      };
    },
    ice(b) {
      const g1 = windLayer(b, whiteBuf, 520, 7, 0.06, 0.13, 260), g2 = windLayer(b, whiteBuf, 900, 9, 0.04, 0.08, 380); void g1; void g2;
      windLayer(b, pinkBuf, 300, 0.7, 0.12, 0.05, 120);
      b.nWh = ctx.currentTime + 2; b.nCr = ctx.currentTime + 3;
      b.sched = (now, h) => {
        while (b.nWh < h) { // a lonely whistle swell
          const t = b.nWh, f = rr(900, 1500), o = ctx.createOscillator(), g = gain(0); o.type = 'sine';
          o.frequency.setValueAtTime(f, t); o.frequency.linearRampToValueAtTime(f * rr(0.85, 1.15), t + 3);
          g.gain.setValueAtTime(MIN, t); g.gain.linearRampToValueAtTime(0.012, t + 1.4); g.gain.linearRampToValueAtTime(MIN, t + 3.2);
          o.connect(g).connect(b.gain); o.start(t); o.stop(t + 3.3); garbage.push({ node: g, at: t + 3.5 });
          b.nWh += rr(5, 11);
        }
        while (b.nCr < h) { nz(b.nCr, 0.05, 0.05, 'bandpass', rr(1500, 3000), 800, 6, b.gain, 0.002); b.nCr += rr(2, 6); }
      };
    },
    fire(b) {
      const s = loopSrc(brownBuf), lp = filt('lowpass', 150, 0.8), g = gain(0.35); s.connect(lp).connect(g).connect(b.gain); keep(b, s, lfo(g.gain, 0.07, 0.12));
      droneLayer(b, [[41.2, 0], [61.7, 6]], 'sawtooth', 110, 0.04);
      b.nCk = ctx.currentTime + 0.2;
      b.sched = (now, h) => { while (b.nCk < h) { nz(b.nCk, rr(0.004, 0.02), rr(0.02, 0.08), 'highpass', rr(1200, 4500), 0, 0.7, b.gain, 0.001); b.nCk += rand() < 0.2 ? rr(0.02, 0.06) : rr(0.08, 0.4); } };
    },
    well(b) {
      // choir-like pad: detuned saws through 'ah' formants, slow minor chord drift
      const fA = filt('bandpass', 700, 5), fB = filt('bandpass', 1150, 7), pg = gain(0.05);
      fA.connect(pg); fB.connect(pg); pg.connect(b.gain); send(pg, 0.6);
      b.voices = [];
      for (let k = 0; k < 4; k++) { const o1 = oscN('sawtooth', 110, -7), o2 = oscN('sawtooth', 110, 7); o1.connect(fA); o2.connect(fA); o1.connect(fB); keep(b, o1, o2); b.voices.push([o1, o2]); }
      keep(b, lfo(pg.gain, 0.06, 0.02));
      const s = loopSrc(whiteBuf), wb = filt('bandpass', 3200, 3), wg = gain(0.012); s.connect(wb).connect(wg).connect(b.gain); keep(b, s, lfo(wg.gain, 0.11, 0.01)); // whispers
      const chords = [[50, 53, 57, 62], [46, 50, 53, 58], [43, 46, 50, 55], [45, 49, 52, 57]];
      b.ci = 0; b.nCh = ctx.currentTime; b.nPulse = ctx.currentTime + 1;
      b.sched = (now, h) => {
        while (b.nCh < h) { const c = chords[b.ci++ % chords.length]; b.voices.forEach((v, k) => { const f = mtof(c[k]); v[0].frequency.setTargetAtTime(f, b.nCh, 1.2); v[1].frequency.setTargetAtTime(f, b.nCh, 1.4); }); b.nCh += 7; }
        while (b.nPulse < h) { tone(b.nPulse, 'sine', 48, 34, 0.5, 0.18, b.gain, 0.01); tone(b.nPulse + 0.28, 'sine', 44, 32, 0.45, 0.1, b.gain, 0.01); b.nPulse += 2.4; }
      };
    },
    title(b) {
      droneLayer(b, [[mtof(38), 0], [mtof(45), 5]], 'sine', 400, 0.05);
      windLayer(b, pinkBuf, 420, 0.6, 0.06, 0.05, 200);
      // sparse melancholic minor arpeggio (original): i – VI – iv – V in D minor
      const prog = [[50, 53, 57, 62], [46, 50, 53, 58], [43, 46, 50, 55], [45, 49, 52, 57]];
      const pat = [0, 2, 1, 3, 2, 1, 0, -1];
      b.bar = 0; b.st = 0; b.nArp = ctx.currentTime + 0.8;
      b.sched = (now, h) => {
        while (b.nArp < h) {
          const t = b.nArp, ch = prog[b.bar % prog.length], idx = pat[b.st];
          if (idx >= 0 && !(b.st > 4 && rand() < 0.25)) {
            const m = ch[idx] + 12 + (b.bar % 8 >= 4 && b.st === 3 ? 12 : 0);
            const g = gain(1); g.connect(b.gain); send(g, 0.85); garbage.push({ node: g, at: t + 3 });
            pluck(t, mtof(m), 1.8, 0.07, g, 3);
            if (b.st === 0) tone(t, 'sine', mtof(ch[0] - 12), mtof(ch[0] - 12), 3.0, 0.05, g, 0.3);
          }
          b.nArp += 0.4 + (b.st === 7 ? 0.25 : 0);
          if (++b.st >= pat.length) { b.st = 0; b.bar++; }
        }
      };
    },
  };
  BEDS.boss = BEDS.well;
  // accepts a biome id, a biome palette object (Game passes floor.biome) or a loose name
  function bedId(id) {
    if (id && typeof id === 'object') {
      if (typeof id.id === 'string') id = id.id;
      else {
        const B = HM.World && HM.World.BIOMES; let k = null;
        if (B) for (const n in B) if (B[n] === id) { k = n; break; }
        id = k || (HM.Game && HM.Game.floor && HM.Game.floor.biomeId) || id.name || 'grass';
      }
    }
    id = String(id || 'grass');
    if (BEDS[id]) return id;
    const l = id.toLowerCase();
    return /candy|sugar|necro/.test(l) ? 'candy' : /ice|frost|snow/.test(l) ? 'ice' : /fire|flame|lava/.test(l) ? 'fire' : /well|lich|void/.test(l) ? 'well' : /title|menu/.test(l) ? 'title' : 'grass';
  }
  function startBed(id, isBoss) {
    const fn = BEDS[id] || BEDS.grass;
    const b = newBed(id, isBoss ? 0.55 : 1);
    try { fn(b); } catch (e) { console.error('[audio bed]', e); }
    if (isBoss) { b.nBoom = ctx.currentTime + 1; const s0 = b.sched; b.sched = (now, h) => { if (s0) s0(now, h); while (b.nBoom < h) { tone(b.nBoom, 'sine', 50, 30, 0.9, 0.22, b.gain, 0.02); b.nBoom += 3.2; } }; }
    b.gain.gain.setValueAtTime(MIN, ctx.currentTime); b.gain.gain.linearRampToValueAtTime(b.level, ctx.currentTime + 2.5);
    return b;
  }
  function stopBed(b, fade) {
    if (!b) return;
    const t = ctx.currentTime, f = fade === undefined ? 2.5 : fade;
    b.gain.gain.cancelScheduledValues(t); b.gain.gain.setValueAtTime(Math.max(MIN, b.gain.gain.value), t); b.gain.gain.linearRampToValueAtTime(MIN, t + f);
    for (const n of b.nodes) { try { n.stop(t + f + 0.05); } catch (e) { /* not a source */ } }
    b.sched = null;
    garbage.push({ node: b.gain, at: t + f + 0.2 });
  }

  // ===========================================================================================
  // Music: 'boss' sequenced loop (intensity = boss phase), 'victory' and 'dead' stingers
  // ===========================================================================================
  const OST_A = [0, 0, 3, 0, 1, 0, -2, -5], OST_B = [0, 0, 3, 5, 3, 1, 0, -2];
  function bossPhase() {
    const G = HM.Game; if (!G || !G.bossesAlive) return 1;
    const b = G.bossesAlive()[0]; return b ? clamp(b.phase || 1, 1, 3) : 1;
  }
  function startMusic(id) {
    const m = { id, gain: gain(0), step: 0, bar: 0, nextT: ctx.currentTime + 0.1, phase: 1, dur16: 60 / 96 / 4 };
    m.gain.connect(musBus);
    m.bus = gain(1); m.bus.connect(m.gain); m.lp = filt('lowpass', 900, 4); m.lp.connect(m.bus);
    m.gain.gain.setValueAtTime(MIN, ctx.currentTime); m.gain.gain.linearRampToValueAtTime(id === 'boss' ? 0.9 : 0.8, ctx.currentTime + (id === 'boss' ? 1.2 : 0.3));
    if (id === 'victory') {
      const t = ctx.currentTime + 0.2; send(m.bus, 0.8);
      [62, 66, 69, 74, 78].forEach((n, k) => bell(t + k * 0.32, mtof(n), 2.4, 0.12, m.bus, 2));
      [50, 57, 62].forEach((n) => tone(t, 'sine', mtof(n), mtof(n), 4.5, 0.06, m.bus, 0.8));
      pluck(t + 2.2, mtof(69), 2.5, 0.08, m.bus); pluck(t + 2.6, mtof(65), 2.5, 0.07, m.bus); pluck(t + 3.0, mtof(62), 3.5, 0.08, m.bus);
      m.oneShot = t + 7;
    } else if (id === 'dead') {
      const t = ctx.currentTime + 0.3; send(m.bus, 0.9);
      [57, 53, 50, 45].forEach((n, k) => pluck(t + k * 0.7, mtof(n), 2.6, 0.12, m.bus, 2.5));
      tone(t, 'sawtooth', mtof(26), mtof(26), 5, 0.05, m.bus, 1.2, { lp: 200 });
      tone(t, 'sine', mtof(38), mtof(37), 5, 0.08, m.bus, 1.0);
      m.oneShot = t + 6;
    }
    return m;
  }
  function stopMusic(m, fade) {
    if (!m) return;
    const t = ctx.currentTime, f = fade === undefined ? 1.5 : fade;
    m.gain.gain.cancelScheduledValues(t); m.gain.gain.setValueAtTime(Math.max(MIN, m.gain.gain.value), t); m.gain.gain.linearRampToValueAtTime(MIN, t + f);
    m.dead = true; garbage.push({ node: m.gain, at: t + f + 0.3 });
  }
  function kick(t, o, v) { tone(t, 'sine', 140, 42, 0.26, 0.9 * v, o, 0.002); tone(t, 'square', 900, 300, 0.01, 0.1 * v, o, 0.001); }
  function tom(t, o, v) { tone(t, 'sine', 98, 62, 0.3, 0.55 * v, o, 0.003); nz(t, 0.08, 0.2 * v, 'lowpass', 900, 300, 1, o); }
  function snare(t, o, v) { nz(t, 0.16, 0.45 * v, 'bandpass', 1900, 1200, 0.9, o, 0.002); tone(t, 'triangle', 210, 160, 0.08, 0.3 * v, o); }
  function hat(t, o, v) { nz(t, 0.035, 0.14 * v, 'highpass', 7500, 6000, 0.7, o, 0.001); }
  function scheduleBoss(m, h) {
    while (m.nextT < h) {
      const t = m.nextT, s = m.step % 16;
      if (s === 0) { m.phase = bossPhase(); m.lp.frequency.setTargetAtTime(m.phase === 1 ? 700 : m.phase === 2 ? 1300 : 2200, t, 0.4); }
      const ph = m.phase, o = m.bus;
      // drums
      const K = ph === 1 ? [0, 8] : ph === 2 ? [0, 6, 8, 11] : [0, 3, 6, 8, 10, 11, 14];
      if (K.includes(s)) kick(t, o, s === 0 ? 1 : 0.8);
      if (ph === 1 && s === 12) tom(t, o, 0.9);
      if (ph >= 2 && (s === 4 || s === 12)) snare(t, o, 1);
      if (ph === 3 && (s === 15 || s === 7) && rand() < 0.6) snare(t, o, 0.35);
      if (ph >= 2 && (ph === 3 || s % 2 === 0)) hat(t, o, s % 4 === 2 ? 1 : 0.55);
      if (ph >= 2 && s === 14 && m.bar % 2 === 1) tom(t, o, 0.7);
      // ostinato (8ths), phrygian-dark in D
      if (s % 2 === 0) {
        const pat = (m.bar % 4 === 3) ? OST_B : OST_A, n = 38 + pat[s / 2];
        tone(t, 'sawtooth', mtof(n), mtof(n), 0.26, 0.24, m.lp, 0.004);
        tone(t, 'sawtooth', mtof(n) * 1.004, mtof(n) * 1.004, 0.24, 0.12, m.lp, 0.004);
        if (ph >= 2) tone(t + (ph === 3 ? 0.0 : 0.02), 'square', mtof(n + 24), mtof(n + 24), 0.09, ph === 3 ? 0.06 : 0.04, m.lp, 0.002);
        if (ph === 3) tone(t + m.dur16, 'square', mtof(n + 24), mtof(n + 24), 0.07, 0.04, m.lp, 0.002);
      }
      // choir stabs
      if (s === 0 && ph >= 2) {
        const chord = m.bar % 4 === 2 ? [51, 55, 58] : [50, 53, 57];
        if (ph === 3) chord.push(56); // tritone dread
        const g = gain(1); g.connect(m.bus); send(g, 0.6); garbage.push({ node: g, at: t + 2 });
        const fA = filt('bandpass', 750, 4); fA.connect(g);
        for (const c of chord) tone(t, 'sawtooth', mtof(c + 12), mtof(c + 12), ph === 3 ? 0.7 : 1.1, 0.07, fA, 0.06);
      }
      m.dur16 = 60 / (ph === 1 ? 96 : ph === 2 ? 108 : 124) / 4;
      m.nextT += m.dur16;
      if (++m.step % 16 === 0) m.bar++;
    }
  }

  // ===========================================================================================
  // scheduler (called from tick, and from a coarse interval so menus keep their music)
  // ===========================================================================================
  function schedule() {
    if (!ctx) return;
    const now = ctx.currentTime; lastSched = now;
    const h = now + 0.25;
    if (bed && bed.sched) {
      // after a long stall (tab hidden), skip missed events instead of bursting them
      for (const k of ['nChime', 'nCrick', 'nNote', 'nWh', 'nCr', 'nCk', 'nCh', 'nPulse', 'nArp', 'nBoom']) if (bed[k] !== undefined && bed[k] < now - 0.5) bed[k] = now + 0.05;
      try { bed.sched(now, h); } catch (e) { console.error('[audio bed]', e); bed.sched = null; }
    }
    if (mus && !mus.dead) {
      if (mus.id === 'boss') { if (mus.nextT < now - 0.3) mus.nextT = now + 0.05; scheduleBoss(mus, h); }
      else if (mus.oneShot && now > mus.oneShot) { stopMusic(mus, 0.5); mus = null; }
    }
    cleanup(now);
  }

  // ===========================================================================================
  // HM.Audio
  // ===========================================================================================
  const Audio = (HM.Audio = {
    get enabled() { return !!ctx; },
    get ctx() { return ctx; },
    names: Object.keys(SFX),
    voices() { return voices.length; },

    init() {
      if (ctx) { if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {}); return true; }
      if (!AC) return false;
      try {
        ctx = new AC();
        comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.22;
        master = gain(vol.master); master.connect(comp); comp.connect(ctx.destination);
        sfxBus = gain(vol.sfx); sfxBus.connect(master);
        duck = gain(1); duck.connect(master);
        worldLP = filt('lowpass', 20000, 0.5); worldLP.connect(duck);
        ambBus = gain(vol.music * 0.9 + 0.05); ambBus.connect(worldLP);
        musBus = gain(vol.music); musBus.connect(worldLP);
        whiteBuf = mkNoise('white'); pinkBuf = mkNoise('pink'); brownBuf = mkNoise('brown');
        verb = mkVerb(); verbIn = gain(0.5); const vOut = gain(0.55); verbIn.connect(verb); verb.connect(vOut); vOut.connect(master);
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
        if (W.setInterval) interval = W.setInterval(() => { if (ctx && ctx.currentTime - lastSched > 0.12) schedule(); }, 90);
        if (want.amb) { const a = want.amb; want.amb = null; Audio.ambient(a, want.boss); }
        if (want.music) { const m = want.music; want.music = null; Audio.music(m); }
        return true;
      } catch (e) { console.error('[audio] init failed', e); ctx = null; return false; }
    },

    // play(name, {x, y, vol, pitch})
    play(name, o) {
      if (!ctx) return null;
      const fn = SFX[name]; if (!fn) return null;
      const meta = META[name] || [0.5, 0.03];
      const now = ctx.currentTime;
      if (lastPlay[name] !== undefined && now - lastPlay[name] < Math.max(0.03, meta[1])) return null;
      let v = meta[0] * (o && o.vol !== undefined ? o.vol : 1), pan = 0;
      if (o && o.x !== undefined && o.y !== undefined) {
        const L = listener();
        if (L) {
          const dx = o.x - L.x, dy = o.y - L.y, d = Math.hypot(dx, dy);
          if (d > 1150) return null;
          v *= 1 / (1 + (d / 360) * (d / 360));
          pan = clamp(dx / 430, -0.85, 0.85);
        }
      }
      if (v < 0.01) return null;
      if (voices.length >= VOICE_CAP) {
        cleanup(now);
        if (voices.length >= VOICE_CAP) {
          if (!meta[2]) return null;
          const old = voices.shift(); // steal the oldest voice
          try { old.out.gain.cancelScheduledValues(now); old.out.gain.setTargetAtTime(MIN, now, 0.01); garbage.push({ node: old.out, at: now + 0.1 }); } catch (e) { /* ignore */ }
        }
      }
      lastPlay[name] = now;
      const P = (o && o.pitch ? o.pitch : 1) * (1 + (rand() - 0.5) * 0.08);
      const out = gain(v);
      let tail = out;
      if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; out.connect(p); tail = p; }
      tail.connect(sfxBus);
      let dur = 0.5;
      try { dur = fn(now + 0.004, out, P) || 0.5; } catch (e) { console.error('[audio sfx ' + name + ']', e); }
      voices.push({ out, end: now + dur + 0.3, name, prio: meta[2] || 0 });
      if (tail !== out) garbage.push({ node: tail, at: now + dur + 0.35 });
      return out;
    },

    // ambient(biomeId | 'title', isBoss) — crossfades to a new evolving bed
    ambient(id, isBoss) {
      id = bedId(id); isBoss = !!isBoss;
      if (!ctx) { want.amb = id; want.boss = isBoss; return; }
      if (bed && bed.id === id && bed.boss === isBoss) return;
      stopBed(bed, 2.5);
      bed = startBed(id, isBoss); bed.boss = isBoss;
      if (id === 'title' && mus) { stopMusic(mus, 1.2); mus = null; }
    },

    // music('boss' | 'victory' | 'dead' | null)
    music(id) {
      if (!ctx) { want.music = id || null; return; }
      if (mus && !mus.dead && mus.id === id) return;
      if (mus) { stopMusic(mus, id ? 0.8 : 1.6); mus = null; }
      if (id && id !== 'none') mus = startMusic(id);
      bossGoneT = 0;
    },

    setVolumes(v) {
      if (!v) return;
      if (v.master !== undefined) vol.master = clamp(+v.master || 0, 0, 1);
      if (v.sfx !== undefined) vol.sfx = clamp(+v.sfx || 0, 0, 1);
      if (v.music !== undefined) vol.music = clamp(+v.music || 0, 0, 1);
      if (!ctx) return;
      const t = ctx.currentTime;
      master.gain.setTargetAtTime(vol.master, t, 0.05);
      sfxBus.gain.setTargetAtTime(vol.sfx, t, 0.05);
      musBus.gain.setTargetAtTime(vol.music, t, 0.05);
      ambBus.gain.setTargetAtTime(vol.music * 0.9 + (vol.music > 0 ? 0.05 : 0), t, 0.05);
    },

    stopAll() {
      if (!ctx) { want.amb = null; want.music = null; return; }
      const t = ctx.currentTime;
      for (const v of voices) { try { v.out.gain.cancelScheduledValues(t); v.out.gain.setTargetAtTime(MIN, t, 0.015); garbage.push({ node: v.out, at: t + 0.2 }); } catch (e) { /* ignore */ } }
      voices.length = 0;
      stopBed(bed, 0.1); bed = null;
      if (mus) { stopMusic(mus, 0.1); mus = null; }
    },

    // per-frame housekeeping (called by FX.update): scheduling, heartbeat, hitstop ducking, boss-music auto stop
    tick() {
      if (!ctx) return;
      schedule();
      const G = HM.Game, now = ctx.currentTime;
      if (!G) return;
      // duck the world under hitstop impacts
      const ducked = G.hitstopT > 0;
      if (ducked !== duckOn) { duckOn = ducked; duck.gain.cancelScheduledValues(now); duck.gain.setTargetAtTime(ducked ? 0.5 : 1, now, ducked ? 0.008 : 0.12); }
      // low-HP heartbeat
      const p = G.player;
      if (G.state === 'play' && p && !p.dead && p.hp01 < 0.3) {
        if (now >= hbNext) {
          const hp = Math.max(0, p.hp01);
          Audio.play('heartbeat', { vol: 0.65 + (0.3 - hp) * 1.4 });
          hbNext = now + 0.55 + hp * 1.35;
        }
      } else hbNext = Math.max(hbNext, now);
      // boss music outlives its boss by a few seconds, then fades
      const tickDt = clamp(now - lastTick, 0, 0.1); lastTick = now;
      if (mus && mus.id === 'boss' && G.state === 'play') {
        if (G.bossesAlive && G.bossesAlive().length === 0) { bossGoneT += tickDt; if (bossGoneT > 3) { stopMusic(mus, 3); mus = null; } }
        else bossGoneT = 0;
      }
    },
  });

  // ===========================================================================================
  // event hooks: menus muffle the world, death/victory stingers, kill sounds
  // ===========================================================================================
  if (HM.Events && HM.Events.on) {
    const MUFFLED = { pause: 1, inventory: 1, options: 1, boon: 1, shop: 1, codex: 1, heirlooms: 1, note: 1 };
    HM.Events.on('state', (e) => {
      if (!ctx || !e) return;
      const t = ctx.currentTime, s = e.state;
      const muffle = !!(MUFFLED[s] && HM.Game && HM.Game.run);
      if (muffle !== lastStatePause) { worldLP.frequency.setTargetAtTime(muffle ? 650 : 20000, t, muffle ? 0.08 : 0.25); lastStatePause = muffle; }
      if (s === 'dead') Audio.music('dead');
      else if (s === 'victory') Audio.music('victory');
      else if (s === 'title' && mus) { stopMusic(mus, 1.5); mus = null; }
    });
    HM.Events.on('kill', (e) => {
      const a = e && e.target; if (!a || !ctx) return;
      const id = ((a.defId || '') + ' ' + ((a.rig && a.rig.id) || '')).toLowerCase();
      const pos = { x: a.x, y: a.y };
      if (a.isBoss || a.kind === 'player') Audio.play('death_big', pos);
      else if (/bone|thrall|skel|archer|knight|priest|lich|dragon/.test(id)) Audio.play('bone_break', pos);
      else Audio.play('death', pos);
    });
  }
})();
