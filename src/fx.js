// fx.js — HM.FX: everything that glows, sparks, bleeds or shakes but isn't terrain or a rig.
//   * pooled glyph particles (typed arrays, no per-frame allocation) with per-preset glyph/colour progression over life
//   * signature effects from the reels: 3-prong Fire Fissure, flame ring, swing crescents, dotted telegraphs,
//     fireball cores + spark trails, shockwave rings, transient lights, ground decals, afterimage ghosts, beams
//   * projectile looks (by p.look) and zone looks (by z.kind), status auras/overlays, directional hit sparks
//   * damage-number motion data (FX.floaters, drawn by UI) and trauma-based screen shake
// All drawing goes into the HM.R cell buffer. Emissive glyphs use F_UNLIT + R.emitI so they feed the bloom pass.
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M, R = HM.R;
  const { CW, CH, TILT } = HM.cfg;
  const TAU = Math.PI * 2, PI = Math.PI;
  const rand = Math.random;
  const rr = (a, b) => a + (b - a) * rand();
  const G = (s) => R.ramp(s);
  const gi = (c) => R.gi(c);
  const hash = M.hash2;
  const clamp = M.clamp;
  const F_UNLIT = R.F_UNLIT, F_GROUND = R.F_GROUND;
  const KEY_DECAL = R.KEY_DECAL;
  // Ground overlays that must stay readable (telegraphs, cracks, shockwaves): above terrain, decals and fog glyphs
  // (fog only replaces cells with key < 0) but below every actor/prop (their keys are world y > 0).
  const KEY_TELE = 0.25;
  const EMPTY = {};
  const setting = (k, d) => (HM.Save && HM.Save.setting ? HM.Save.setting(k, d) : d);
  const gameDt = () => (HM.Game && HM.Game.dt) || 0;

  const GL = {
    o: gi('o'), O: gi('O'), dot: gi('.'), apos: gi("'"), comma: gi(','), star: gi('*'), plus: gi('+'), at: gi('@'), hash: gi('#'),
    colon: gi(':'), tick: gi('`'), caret: gi('^'), dq: gi('"'), dash: gi('-'), bar: gi('|'), slash: gi('/'), bslash: gi('\\'),
    tilde: gi('~'), eq: gi('='), x: gi('x'), X: gi('X'), pct: gi('%'), v: gi('v'), lt: gi('<'), gt: gi('>'), lp: gi('('), rp: gi(')'),
    semi: gi(';'), amp: gi('&'), us: gi('_'),
  };
  const RAMP = {
    crack: G(".:o';,o."), flame: G("^*'\"`+^'"), cloud: G("o.O:.o'."), pool: G("~-=~o.~,"), frost: G("*+'.`:"), sparkle: G("*+.'+."),
    swirl: G("%:x;.:"), bubble: G("oO.o"), soft: G(" .:;+*#@"),
  };

  // ===========================================================================================
  // Particle presets
  //   g: glyph progression over life (first = newborn)   c: colour stops over life (linear, may exceed 1 = hot)
  //   e: emissive gain (0 = lit by scene lights)          gr: gravity (+ falls, - buoyant)   dr: drag 1/s
  //   wd: wind factor   sp: ground speed range   up: initial vz range   lf: life range
  //   gd: ground behaviour 0 slide, 1 stick (rests on ground), 2 bounce then rest.  pick: glyph per particle (by seed)
  //   spin: glyph cycles while airborne   jit: glyph flickers every frame
  // ===========================================================================================
  const PRESET_DEFS = {
    ember:     { g: "@*+'.", c: [[2.4, 1.9, 1.05], [1.75, 0.8, 0.22], [1.05, 0.3, 0.06], [0.4, 0.07, 0.02]], e: 0.85, gr: -55, dr: 1.6, wd: 1, sp: [20, 90], up: [20, 70], lf: [0.5, 1.3], gd: 0 },
    spark:     { g: "*+'.", c: [[2.7, 2.5, 1.9], [2.1, 1.45, 0.5], [1.2, 0.5, 0.1]], e: 1.0, gr: 430, dr: 2.4, wd: 0, sp: [110, 260], up: [30, 140], lf: [0.15, 0.4], gd: 2 },
    blood:     { g: ";,.", c: [[0.8, 0.06, 0.05], [0.55, 0.03, 0.03], [0.3, 0.02, 0.02]], e: 0, gr: 540, dr: 1.2, wd: 0, sp: [40, 140], up: [40, 130], lf: [0.8, 1.5], gd: 1 },
    bone:      { g: "'-~=`-", spin: 1, c: [[0.98, 0.95, 0.85], [0.86, 0.83, 0.73], [0.55, 0.53, 0.47]], e: 0, gr: 540, dr: 0.8, wd: 0, sp: [60, 170], up: [60, 170], lf: [1.2, 2.2], gd: 2 },
    poison:    { g: "oO.o.", c: [[0.75, 1.7, 0.42], [0.42, 1.25, 0.25], [0.14, 0.5, 0.1]], e: 0.6, gr: -25, dr: 2.2, wd: 0.6, sp: [10, 50], up: [10, 40], lf: [0.7, 1.5], gd: 0 },
    ice:       { g: "*+'.", c: [[1.7, 2.0, 2.3], [0.85, 1.25, 1.65], [0.4, 0.6, 0.9]], e: 0.45, gr: 260, dr: 1.8, wd: 0.3, sp: [50, 160], up: [30, 120], lf: [0.4, 0.9], gd: 2 },
    dust:      { g: "o:.'.", c: [[0.6, 0.57, 0.52], [0.45, 0.43, 0.4], [0.24, 0.23, 0.22]], e: 0, gr: -6, dr: 3.5, wd: 0.8, sp: [30, 90], up: [5, 25], lf: [0.35, 0.8], gd: 0 },
    sugar:     { g: "*+.'", c: [[2.1, 1.25, 1.7], [1.45, 0.62, 1.05], [0.6, 0.25, 0.45]], e: 0.5, gr: 150, dr: 2.0, wd: 0.5, sp: [40, 130], up: [30, 110], lf: [0.5, 1.1], gd: 1 },
    smoke:     { g: "%o~:.'", c: [[0.34, 0.32, 0.32], [0.25, 0.24, 0.25], [0.12, 0.12, 0.13]], e: 0, gr: -24, dr: 1.4, wd: 1.4, sp: [8, 30], up: [15, 40], lf: [1.1, 2.2], gd: 0 },
    ash:       { g: ".'`.", c: [[0.5, 0.47, 0.45], [0.33, 0.31, 0.3], [0.15, 0.14, 0.14]], e: 0, gr: 16, dr: 1, wd: 1.6, sp: [5, 25], up: [-5, 15], lf: [1.5, 3], gd: 1 },
    shadow:    { g: "%x+:.", c: [[0.8, 0.38, 1.2], [0.42, 0.16, 0.62], [0.12, 0.03, 0.2]], e: 0.35, gr: -30, dr: 2, wd: 0.4, sp: [20, 80], up: [10, 40], lf: [0.5, 1.1], gd: 0 },
    holy:      { g: "+*'.", c: [[2.5, 2.3, 1.45], [1.65, 1.3, 0.6], [0.7, 0.5, 0.2]], e: 0.9, gr: -45, dr: 1.8, wd: 0.2, sp: [30, 110], up: [30, 90], lf: [0.5, 1.1], gd: 0 },
    gold:      { g: "$*o.", c: [[2.3, 1.8, 0.55], [1.65, 1.1, 0.25], [0.8, 0.5, 0.1]], e: 0.5, gr: 430, dr: 0.8, wd: 0, sp: [40, 120], up: [80, 180], lf: [0.6, 1.1], gd: 2 },
    rot:       { g: "o,.;", c: [[1.25, 0.42, 0.78], [0.86, 0.25, 0.5], [0.4, 0.1, 0.25]], e: 0.25, gr: 300, dr: 1.4, wd: 0.2, sp: [20, 90], up: [10, 90], lf: [0.7, 1.4], gd: 1 },
    witchfire: { g: "@*+'.", c: [[1.5, 2.6, 1.3], [0.5, 1.7, 0.5], [0.15, 0.8, 0.2], [0.04, 0.3, 0.06]], e: 0.9, gr: -60, dr: 1.6, wd: 0.8, sp: [20, 80], up: [20, 70], lf: [0.5, 1.2], gd: 0 },
    lightning: { g: "\\/|-", jit: 1, c: [[2.4, 2.7, 3.2], [1.2, 1.5, 2.5], [0.4, 0.5, 1.2]], e: 1.2, gr: 0, dr: 6, wd: 0, sp: [120, 300], up: [-40, 40], lf: [0.08, 0.22], gd: 0 },
    // internal extras
    flame:     { g: "^*'\"`.", c: [[2.6, 2.1, 1.1], [1.9, 0.9, 0.22], [1.0, 0.28, 0.05]], e: 1.0, gr: -130, dr: 2.5, wd: 0.5, sp: [4, 22], up: [40, 90], lf: [0.22, 0.5], gd: 0 },
    snow:      { g: "*'.", c: [[1.0, 1.15, 1.35], [0.7, 0.85, 1.05], [0.4, 0.5, 0.65]], e: 0.25, gr: 28, dr: 2, wd: 1, sp: [4, 20], up: [-10, 10], lf: [0.6, 1.3], gd: 0 },
    glint:     { g: "+*'.", c: [[2.0, 2.0, 2.2], [1.2, 1.2, 1.4], [0.5, 0.5, 0.6]], e: 0.9, gr: 0, dr: 4, wd: 0, sp: [0, 15], up: [0, 15], lf: [0.2, 0.45], gd: 0 },
  };
  const PRE = [], PRE_ID = {};
  for (const name in PRESET_DEFS) {
    const d = PRESET_DEFS[name], c = d.c, lut = new Float32Array(48), lum = new Float32Array(16);
    for (let s = 0; s < 16; s++) {
      const t = (s / 15) * (c.length - 1), a = Math.floor(t), b = Math.min(c.length - 1, a + 1), f = t - a;
      for (let k = 0; k < 3; k++) lut[s * 3 + k] = c[a][k] + (c[b][k] - c[a][k]) * f;
      lum[s] = lut[s * 3] * 0.3 + lut[s * 3 + 1] * 0.55 + lut[s * 3 + 2] * 0.15;
    }
    const l0 = lum[0] || 1; for (let s = 0; s < 16; s++) lum[s] /= l0;
    PRE_ID[name] = PRE.length;
    PRE.push(Object.assign({ name, glyphs: G(d.g), lut, lum }, d));
  }

  // ===========================================================================================
  // Particle pool (structure of arrays, swap-remove)
  // ===========================================================================================
  const CAP = 2500;
  const px = new Float32Array(CAP), py = new Float32Array(CAP), pz = new Float32Array(CAP);
  const pvx = new Float32Array(CAP), pvy = new Float32Array(CAP), pvz = new Float32Array(CAP);
  const page = new Float32Array(CAP), plife = new Float32Array(CAP), pgr = new Float32Array(CAP), pdr = new Float32Array(CAP);
  const pem = new Float32Array(CAP), ptr = new Float32Array(CAP), ptg = new Float32Array(CAP), ptb = new Float32Array(CAP), pseed = new Float32Array(CAP);
  const ppre = new Uint8Array(CAP), pfl = new Uint8Array(CAP); // fl: 1 custom colour, 2 resting on ground
  let pn = 0;
  const ALL = [px, py, pz, pvx, pvy, pvz, page, plife, pgr, pdr, pem, ptr, ptg, ptb, pseed, ppre, pfl];

  function spawnP(id, x, y, z, vx, vy, vz, life) {
    let i;
    if (pn < CAP) i = pn++;
    else i = (rand() * CAP) | 0; // pool full: recycle a random particle (keeps new effects visible under load)
    const P = PRE[id];
    px[i] = x; py[i] = y; pz[i] = z; pvx[i] = vx; pvy[i] = vy; pvz[i] = vz;
    page[i] = 0; plife[i] = life > 0.01 ? life : 0.01; pgr[i] = P.gr; pdr[i] = P.dr; pem[i] = P.e;
    ptr[i] = ptg[i] = ptb[i] = 1; pseed[i] = rand(); ppre[i] = id; pfl[i] = 0;
    return i;
  }
  function killP(i) {
    const j = --pn; if (i === j) return;
    for (let a = 0; a < ALL.length; a++) ALL[a][i] = ALL[a][j];
  }
  function setColor(i, c) { if (!c) return; ptr[i] = c[0]; ptg[i] = c[1]; ptb[i] = c[2]; pfl[i] |= 1; }

  function updateParticles(dt) {
    if (dt <= 0) return;
    const wx = FX.wind[0], wy = FX.wind[1];
    for (let i = 0; i < pn;) {
      const a = (page[i] += dt);
      if (a >= plife[i]) { killP(i); continue; }
      if (!(pfl[i] & 2)) {
        const P = PRE[ppre[i]];
        const d = Math.exp(-pdr[i] * dt), w = P.wd * (1 - d);
        pvx[i] = pvx[i] * d + wx * w; pvy[i] = pvy[i] * d + wy * w;
        pvz[i] = pvz[i] * (pgr[i] < 0 ? d : 1) - pgr[i] * dt;
        px[i] += pvx[i] * dt; py[i] += pvy[i] * dt; pz[i] += pvz[i] * dt;
        if (pz[i] < 0) {
          const gd = P.gd;
          if (gd === 0) { pz[i] = 0; if (pvz[i] < 0) pvz[i] = 0; }
          else if (gd === 2 && pvz[i] < -60) { pz[i] = 0; pvz[i] = -pvz[i] * 0.33; pvx[i] *= 0.5; pvy[i] *= 0.5; }
          else { pz[i] = 0; pvx[i] = pvy[i] = pvz[i] = 0; pfl[i] |= 2; plife[i] = a + rr(1.2, 2.6) * (P.gd === 1 ? 1.4 : 1); }
        }
      }
      i++;
    }
  }

  function drawParticles() {
    if (!pn) return;
    const x0 = R.originPx - 8, x1 = R.originPx + R.viewW + 8, y0 = R.originPy - 10, y1 = R.originPy + R.viewH + 10;
    const time = R.time;
    for (let i = 0; i < pn; i++) {
      const X = px[i], Y = py[i] * TILT - pz[i];
      if (X < x0 || X > x1 || Y < y0 || Y > y1) continue;
      const P = PRE[ppre[i]];
      const t = page[i] / plife[i];
      const s = (t * 15) | 0;
      const gs = P.glyphs, gl = gs.length;
      const rest = pfl[i] & 2;
      let g;
      if (P.spin) g = rest ? gs[(pseed[i] * gl) | 0] : gs[((pseed[i] * 13 + page[i] * 14) | 0) % gl];
      else if (P.pick) g = gs[(pseed[i] * gl) | 0];
      else if (P.jit) g = gs[((pseed[i] * 7 + time * 30) | 0) % gl];
      else g = gs[Math.min(gl - 1, (t * gl) | 0)];
      let r, gg, b;
      if (pfl[i] & 1) { const l = P.lum[s]; r = ptr[i] * l; gg = ptg[i] * l; b = ptb[i] * l; }
      else { const o = s * 3; r = P.lut[o]; gg = P.lut[o + 1]; b = P.lut[o + 2]; }
      const idx = R.idxP(X, Y);
      const key = rest ? KEY_DECAL + 4 : py[i] + 0.6;
      const e = pem[i];
      if (e > 0) { if (R.setI(idx, g, r, gg, b, key, F_UNLIT)) R.emitI(idx, r * e, gg * e, b * e); }
      else R.setI(idx, g, r, gg, b, key, rest ? F_GROUND : 0);
    }
  }

  // ===========================================================================================
  // Small drawing helpers
  // ===========================================================================================
  // additive glow blob in projected px (no glyph change) — orb halos, fireball cores, kindled glow
  function halo(pcx, pcy, rad, r, g, b) {
    if (rad < 1) return;
    const ci0 = Math.floor((pcx - rad) / CW), ci1 = Math.floor((pcx + rad) / CW);
    const cj0 = Math.floor((pcy - rad) / CH), cj1 = Math.floor((pcy + rad) / CH);
    const inv = 1 / rad;
    for (let cj = cj0; cj <= cj1; cj++) {
      const dy = ((cj + 0.5) * CH - pcy) * inv; const dy2 = dy * dy;
      for (let ci = ci0; ci <= ci1; ci++) {
        const dx = ((ci + 0.5) * CW - pcx) * inv; const q = dx * dx + dy2; if (q >= 1) continue;
        const f = (1 - q) * (1 - q); R.emitI(R.idx(ci, cj), r * f, g * f, b * f);
      }
    }
  }
  // iterate the cells an actor drew this frame (after actors are drawn): key near actor.y, not terrain
  function forActorCells(a, fn) {
    const w = Math.max(22, (a.radius || 9) * 2.6), h = (a.height || 50) * 1.3 + 16 + (a.z || 0);
    const pcx = a.x, pcy = a.y * TILT;
    const cols = R.cols, rows = R.rows;
    const x0 = Math.max(0, Math.floor((pcx - w) / CW) - R.ci0), x1 = Math.min(cols - 1, Math.floor((pcx + w) / CW) - R.ci0);
    const y0 = Math.max(0, Math.floor((pcy - h) / CH) - R.cj0), y1 = Math.min(rows - 1, Math.floor((pcy + 10) / CH) - R.cj0);
    const kr = Math.max(20, (a.radius || 9) * 2.5), klo = a.y - kr, khi = a.y + kr + 3;
    const key = R.key, glyph = R.glyph, flag = R.flag;
    for (let y = y0; y <= y1; y++) {
      let i = y * cols + x0;
      for (let x = x0; x <= x1; x++, i++) {
        const k = key[i]; if (k < klo || k > khi || !glyph[i] || (flag[i] & F_GROUND)) continue;
        fn(i, x + R.ci0, y + R.cj0, k);
      }
    }
  }
  function tintActor(a, tr, tg, tb, amt, emis) {
    const col = R.col;
    forActorCells(a, (i) => {
      const o = i * 3; const lum = col[o] * 0.3 + col[o + 1] * 0.55 + col[o + 2] * 0.15; const l = 0.35 + lum * 1.25;
      col[o] += (tr * l - col[o]) * amt; col[o + 1] += (tg * l - col[o + 1]) * amt; col[o + 2] += (tb * l - col[o + 2]) * amt;
      if (emis) R.emitI(i, tr * emis, tg * emis, tb * emis);
    });
  }
  function compact(arr, keep) { let w = 0; for (let r = 0; r < arr.length; r++) { const o = arr[r]; if (keep(o)) arr[w++] = o; } arr.length = w; }
  function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function safe(fn, ...args) { try { return fn(...args); } catch (e) { console.error('[FX callback]', e); return undefined; } }

  // ===========================================================================================
  // Effect lists
  // ===========================================================================================
  const lights = [], rings = [], flashes = [], blasts = [], swings = [], beams = [], ghosts = [], decals = [], telegraphs = [], fissures = [];
  let trauma = 0, shakeT = 0, lastRealT = 0;

  // ---- floaters (damage numbers) -------------------------------------------------------------
  const NUM_COLORS = {
    phys: [1, 1, 1], fire: [1, 0.6, 0.2], ice: [0.6, 0.88, 1], poison: [0.45, 1, 0.32], shadow: [0.78, 0.5, 1], holy: [1, 0.94, 0.6],
    bleed: [0.95, 0.2, 0.18], heal: [0.42, 1, 0.5], crit: [1, 0.86, 0.24], hurt: [1, 0.32, 0.28],
  };
  function numColor(type) { return NUM_COLORS[type] || (HM.Combat && HM.Combat.TYPE_COLORS && HM.Combat.TYPE_COLORS[type]) || NUM_COLORS.phys; }
  function pushFloater(f) { const F = FX.floaters; if (F.length >= 90) F.splice(0, F.length - 89); F.push(f); return f; }

  // ---- material of a struck target (for the secondary hit burst) -----------------------------
  const matterCache = new WeakMap();
  function matterOf(a) {
    if (a.fxMatter) return a.fxMatter; // actors may declare their own spray material
    const cached = matterCache.get(a); if (cached) return cached;
    const id = ((a.defId || '') + ' ' + ((a.rig && a.rig.id) || '') + ' ' + (a.tags ? a.tags.join(' ') : '')).toLowerCase();
    let m = 'blood';
    if (/bone|thrall|skel|archer|knight|priest|lich|dragon|undead/.test(id)) m = 'bone';
    else if (/husk|bloat|rot|snail/.test(id)) m = 'rot';
    else if (/banana|lemon|candy|gum|sugar/.test(id)) m = 'sugar';
    else if (/penguin|gunter|golem|wisp|ice|frost|snow/.test(id)) m = 'ice';
    else if (/elemental|cinder|magma|brute|flame|fire/.test(id)) m = 'ember';
    else if (/wraith|void|shadow/.test(id)) m = 'shadow';
    else if (/goose|npc/.test(id)) m = 'dust';
    if (a.kind === 'player' && (a.defId === 'fp' || a.heroId === 'fp')) m = 'ember';
    matterCache.set(a, m);
    return m;
  }
  const TYPE_SPARK = { phys: 'spark', fire: 'ember', ice: 'ice', poison: 'poison', shadow: 'shadow', holy: 'holy' };
  const TYPE_LIGHT = { fire: [1, 0.5, 0.15], ice: [0.5, 0.8, 1], poison: [0.4, 1, 0.3], shadow: [0.6, 0.3, 1], holy: [1, 0.9, 0.5] };

  // ---- explosion kinds -----------------------------------------------------------------------
  const EXPL = {
    fire:      { p1: 'ember', p2: 'spark', p3: 'smoke', ring: [1.8, 0.8, 0.22], light: [1, 0.5, 0.15], core: [[2.8, 2.5, 1.7], [2.2, 1.2, 0.35], [1.2, 0.35, 0.06]], decal: 'scorch' },
    poison:    { p1: 'poison', p2: 'poison', p3: 'smoke', ring: [0.6, 1.6, 0.4], light: [0.4, 1, 0.3], core: [[1.6, 2.6, 1.2], [0.6, 1.7, 0.4], [0.2, 0.6, 0.1]], decal: 'rot' },
    rot:       { p1: 'rot', p2: 'rot', p3: 'smoke', ring: [1.3, 0.45, 0.8], light: [0.9, 0.3, 0.6], core: [[2.2, 1.4, 1.8], [1.3, 0.45, 0.8], [0.5, 0.15, 0.3]], decal: 'rot' },
    ice:       { p1: 'ice', p2: 'snow', p3: 'dust', ring: [1.2, 1.6, 2.0], light: [0.55, 0.8, 1], core: [[2.4, 2.6, 2.8], [1.2, 1.6, 2.1], [0.4, 0.6, 0.9]], decal: 'frost' },
    shadow:    { p1: 'shadow', p2: 'shadow', p3: 'smoke', ring: [0.8, 0.4, 1.3], light: [0.55, 0.25, 0.9], core: [[1.6, 1.0, 2.2], [0.7, 0.3, 1.1], [0.2, 0.05, 0.35]], decal: 'scorch' },
    holy:      { p1: 'holy', p2: 'glint', p3: 'dust', ring: [2.0, 1.8, 1.0], light: [1, 0.9, 0.55], core: [[2.8, 2.7, 2.2], [2.0, 1.7, 0.8], [0.9, 0.7, 0.3]], decal: null },
    witchfire: { p1: 'witchfire', p2: 'witchfire', p3: 'smoke', ring: [0.6, 1.9, 0.6], light: [0.35, 1, 0.4], core: [[1.8, 2.8, 1.6], [0.5, 1.8, 0.5], [0.1, 0.6, 0.15]], decal: 'witch' },
    sugar:     { p1: 'sugar', p2: 'sugar', p3: 'dust', ring: [2.0, 1.1, 1.5], light: [1, 0.55, 0.8], core: [[2.8, 2.2, 2.5], [1.9, 0.9, 1.4], [0.7, 0.3, 0.5]], decal: 'rot' },
    bone:      { p1: 'bone', p2: 'dust', p3: 'dust', ring: [1.2, 1.15, 1.0], light: [0.7, 0.68, 0.6], core: [[2.2, 2.1, 1.9], [1.3, 1.25, 1.1], [0.5, 0.48, 0.42]], decal: 'bones' },
    lightning: { p1: 'lightning', p2: 'spark', p3: 'dust', ring: [1.4, 1.7, 2.4], light: [0.6, 0.75, 1.2], core: [[2.8, 3.0, 3.3], [1.5, 1.8, 2.8], [0.5, 0.6, 1.3]], decal: 'scorch' },
    dust:      { p1: 'dust', p2: 'dust', p3: 'dust', ring: [0.7, 0.68, 0.62], light: null, core: null, decal: null },
  };

  // ---- decal definitions -------------------------------------------------------------------
  const DECALS = { // c: albedo, dens: glyph density, shade: ground darkening, emis: faint self-light so marks read in the dark
    scorch: { g: G(".,:;'`"), c: [0.12, 0.08, 0.06], dens: 0.38, shade: 0.85, glow: [1.0, 0.32, 0.05], glowT: 1.8 },
    blood:  { g: G(",.;:'"), c: [0.72, 0.06, 0.05], dens: 0.8, shade: 0.25, emis: 0.08 },
    rot:    { g: G("~o.,:~"), c: [0.78, 0.26, 0.5], dens: 0.72, shade: 0.25, emis: 0.1 },
    frost:  { g: G("*+'.:"), c: [0.75, 0.9, 1.15], dens: 0.5, shade: 0, emis: 0.08 },
    witch:  { g: G(".:+'o"), c: [0.28, 0.95, 0.4], dens: 0.42, shade: 0.45, emis: 0.16, glow: [0.2, 0.9, 0.3], glowT: 2.5 },
    crack:  { g: G(".',`"), c: [0.3, 0.08, 0.05], dens: 1, shade: 0.45, glow: [0.9, 0.22, 0.06], glowT: 1.5, emis: 0.04 },
    bones:  { g: G("'-~=`"), c: [0.92, 0.88, 0.78], dens: 0.24, shade: 0.12, emis: 0.05 },
  };
  const SCR_N = 3000;
  const scrCi = new Int32Array(SCR_N), scrCj = new Int32Array(SCR_N), scrG = new Uint8Array(SCR_N), scrC = new Float32Array(SCR_N * 3), scrS = new Float32Array(SCR_N), scrK = new Float32Array(SCR_N);

  // ===========================================================================================
  // Fissure (DESIGN §5.1) — timings in seconds
  // ===========================================================================================
  const FIS = { race: 0.25, erupt: 0.25, span: 0.2, colLife: 0.42, collapse: 0.2, cool: 1.1, end: 2.0, colStep: 6, orbStep: 40, ptStep: 20 };
  const FIRE_PAL = { hot: [2.1, 1.9, 1.3], yel: [1.9, 1.35, 0.5], org: [1.6, 0.6, 0.14], dim: [0.95, 0.27, 0.09], ember: [0.75, 0.12, 0.04], light: [1, 0.45, 0.13], tint: [0.85, 0.2, 0.3] };
  function palFrom(c) {
    const m = Math.max(c[0], c[1], c[2], 1e-3), n = [c[0] / m, c[1] / m, c[2] / m];
    return {
      hot: mix3(n, [1, 1, 1], 0.6).map((v) => v * 2.6), yel: mix3(n, [1, 1, 1], 0.3).map((v) => v * 2.1), org: n.map((v) => v * 1.7),
      dim: n.map((v) => v * 0.9), ember: n.map((v) => v * 0.6), light: n, tint: n.map((v) => v * 0.85),
    };
  }
  // bend: the prong starts at `bend` of its angular offset and curves out to the full offset (hero look: 0.62).
  // Boss fissures pass explicit angles and bend 1 so the crack stays inside its straight telegraph lane.
  function buildLine(x, y, a0, offs, len, jag, bend) {
    const step = 6, n = Math.max(2, Math.round(len / step));
    const b0 = bend === undefined ? 0.62 : bend, b1 = 1 - b0;
    const pts = new Float32Array((n + 1) * 2), d = new Float32Array(n + 1);
    let cx = x, cy = y, dev = 0, acc = 0;
    pts[0] = cx; pts[1] = cy;
    for (let s = 1; s <= n; s++) {
      const f = s / n;
      dev += (rand() - 0.5) * 0.9 * jag; dev *= 0.78;
      if (rand() < 0.1 * jag) dev += (rand() < 0.5 ? -1 : 1) * rr(0.5, 0.9);
      const a = a0 + offs * (b0 + b1 * f) + dev * 0.55;
      const nx = cx + Math.cos(a) * step, ny = cy + Math.sin(a) * step;
      acc += Math.hypot(nx - cx, ny - cy); cx = nx; cy = ny;
      pts[s * 2] = cx; pts[s * 2 + 1] = cy; d[s] = acc;
    }
    return { pts, d, n, L: acc };
  }
  function sampleLine(line, step) {
    const m = Math.max(1, Math.floor(line.L / step) + 1);
    const out = new Float32Array(m * 3);
    let seg = 0;
    for (let k = 0; k < m; k++) {
      const s = Math.min(line.L, k * step);
      while (seg < line.n - 1 && line.d[seg + 1] < s) seg++;
      const d0 = line.d[seg], d1 = line.d[seg + 1], f = d1 > d0 ? (s - d0) / (d1 - d0) : 0;
      out[k * 3] = line.pts[seg * 2] + (line.pts[seg * 2 + 2] - line.pts[seg * 2]) * f;
      out[k * 3 + 1] = line.pts[seg * 2 + 1] + (line.pts[seg * 2 + 3] - line.pts[seg * 2 + 1]) * f;
      out[k * 3 + 2] = s;
    }
    return out;
  }

  // ===========================================================================================
  // HM.FX
  // ===========================================================================================
  const FX = (HM.FX = {
    floaters: [],
    wind: [10, -2],
    t: 0,
    CAP,
    PRESETS: Object.keys(PRESET_DEFS),
    get count() { return pn; },

    clear() {
      pn = 0;
      for (const l of [lights, rings, flashes, blasts, swings, beams, ghosts, decals, telegraphs, fissures]) l.length = 0;
      FX.floaters = [];
      trauma = 0;
    },

    // ----------------------------------------------------------------------------- update
    update(dt) {
      dt = dt || 0;
      FX.t += dt;
      const realT = HM.Game ? HM.Game.realT : FX.t;
      let rdt = realT - lastRealT; lastRealT = realT; if (!(rdt >= 0 && rdt < 0.25)) rdt = dt;
      // wind per biome with slow gusts
      const F = HM.World && HM.World.floor; const bid = F ? F.biomeId : 'grass';
      const base = bid === 'ice' ? [38, 7] : bid === 'fire' ? [5, -8] : bid === 'well' ? [-7, -3] : bid === 'candy' ? [7, 1] : [11, -2];
      const gust = 0.65 + 0.45 * Math.sin(FX.t * 0.37) + 0.2 * Math.sin(FX.t * 1.3);
      FX.wind[0] = base[0] * gust; FX.wind[1] = base[1] * gust;

      updateParticles(dt);
      for (const L of lights) L.t += dt;
      compact(lights, (L) => L.t < L.dur);
      for (const o of rings) o.t += dt;
      compact(rings, (o) => o.t < o.dur);
      for (const o of flashes) o.t += dt;
      compact(flashes, (o) => o.t < o.dur);
      for (const o of blasts) o.t += dt;
      compact(blasts, (o) => o.t < o.dur);
      for (const o of swings) o.t += dt;
      compact(swings, (o) => o.t < o.dur + o.life);
      for (const o of beams) o.t += dt;
      compact(beams, (o) => o.t < o.dur);
      for (const o of ghosts) if (!o.pending) o.t += dt;
      compact(ghosts, (o) => o.t < o.dur);
      for (const o of decals) o.t += dt;
      compact(decals, (o) => o.t < o.life);
      for (const T of telegraphs) updateTelegraph(T, dt);
      compact(telegraphs, (T) => !T.dead);
      for (const f of fissures) updateFissure(f, dt);
      compact(fissures, (f) => !f.dead);
      updateFloaters(dt);
      // trauma decays in real time so shake settles even through hitstop
      shakeT += rdt; trauma = Math.max(0, trauma - rdt * 1.6);
      if (HM.Audio && HM.Audio.tick) HM.Audio.tick(dt);
    },

    // ----------------------------------------------------------------------------- draw
    // Ground layer (after terrain, before zones/actors): decals, telegraphs, cracks, shockwaves.
    drawGround() {
      drawDecals();
      for (const T of telegraphs) drawTelegraph(T);
      for (const f of fissures) drawFissureGround(f);
      for (const o of rings) drawRing(o);
      drawStatusGround();
    },
    // Over actors/projectiles: ghosts, particles, swings, fire columns, beams, status overlays, flashes, lights.
    draw() {
      for (const g of ghosts) if (g.pending) captureGhost(g); // capture before we add anything over the actors
      for (const g of ghosts) if (!g.pending && g.n) drawGhost(g);
      for (const f of fissures) drawFissureAir(f);
      for (const o of blasts) drawBlast(o);
      drawParticles();
      for (const s of swings) drawSwing(s);
      for (const b of beams) drawBeam(b);
      drawStatusOverlays();
      for (const o of flashes) drawFlash(o);
      for (const L of lights) {
        const k = 1 - L.t / L.dur; if (k <= 0) continue;
        const fl = L.flick ? 1 - L.flick * 0.5 + L.flick * 0.5 * Math.sin(FX.t * 31 + L.x) : 1;
        R.light(L.x, L.y, L.z, L.rad * (0.7 + 0.3 * k), L.r, L.g, L.b, L.i * k * k * fl);
      }
    },

    // ----------------------------------------------------------------------------- particles API
    // burst(x,y,z,preset,n,opts) opts: {dir, spread(half-angle), speed(mult|[a,b]), up(mult|[a,b]), life(mult|[a,b]), r (spawn radius),
    //   zr (z jitter), vx, vy (inherited), color, grav, drag, emis}
    burst(x, y, z, preset, n, o) {
      let id = PRE_ID[preset]; if (id === undefined) id = PRE_ID.spark;
      const P = PRE[id]; o = o || EMPTY;
      n = n === undefined ? 10 : n | 0;
      if (n <= 0) return;
      const sp = o.speed, up = o.up, lf = o.life, hasDir = o.dir !== undefined, spread = o.spread !== undefined ? o.spread : 0.6;
      const r0 = o.r || 0, zr = o.zr || 0, ivx = o.vx || 0, ivy = o.vy || 0;
      for (let k = 0; k < n; k++) {
        const ang = hasDir ? o.dir + (rand() * 2 - 1) * spread : rand() * TAU;
        const v = Array.isArray(sp) ? rr(sp[0], sp[1]) : rr(P.sp[0], P.sp[1]) * (sp === undefined ? 1 : sp);
        const vz = Array.isArray(up) ? rr(up[0], up[1]) : rr(P.up[0], P.up[1]) * (up === undefined ? 1 : up);
        const life = Array.isArray(lf) ? rr(lf[0], lf[1]) : rr(P.lf[0], P.lf[1]) * (lf === undefined ? 1 : lf);
        let sx = x, sy = y;
        if (r0) { const ra = rand() * TAU, rd = Math.sqrt(rand()) * r0; sx += Math.cos(ra) * rd; sy += Math.sin(ra) * rd; }
        const i = spawnP(id, sx, sy, Math.max(0, (z || 0) + (zr ? (rand() * 2 - 1) * zr : 0)), Math.cos(ang) * v + ivx, Math.sin(ang) * v + ivy, vz, life);
        if (o.color) setColor(i, o.color);
        if (o.grav !== undefined) pgr[i] = o.grav;
        if (o.drag !== undefined) pdr[i] = o.drag;
        if (o.emis !== undefined) pem[i] = o.emis;
      }
    },
    // emit({x,y,z,vx,vy,vz,life,preset,color,grav,drag,emis}) → particle slot
    emit(p) {
      if (!p) return -1;
      let id = PRE_ID[p.preset || p.kind || 'ember']; if (id === undefined) id = PRE_ID.ember;
      const P = PRE[id];
      const i = spawnP(id, p.x || 0, p.y || 0, p.z || 0, p.vx || 0, p.vy || 0, p.vz || 0, p.life || rr(P.lf[0], P.lf[1]));
      if (p.color) setColor(i, p.color);
      if (p.grav !== undefined) pgr[i] = p.grav;
      if (p.drag !== undefined) pdr[i] = p.drag;
      if (p.emis !== undefined) pem[i] = p.emis;
      return i;
    },

    // ----------------------------------------------------------------------------- floaters
    number(target, amount, type, crit, isDot) {
      if (!target || !(amount > 0)) return null;
      if (!setting('damageNumbers', true)) return null;
      type = type || 'phys';
      const heal = type === 'heal';
      if (isDot) { // merge rapid DoT ticks per target+type into one updating number
        const F = FX.floaters;
        for (let k = F.length - 1; k >= 0; k--) {
          const f = F[k];
          if (f.target === target && f.type === type && f.kind === 'dot' && FX.t - f.lastT < 0.3 && f.t < f.life * 0.6) {
            f.amount += amount; f.text = String(Math.max(1, Math.round(f.amount))); f.lastT = FX.t; f.bump = 1;
            f.t = Math.min(f.t, 0.12); return f;
          }
        }
      }
      let rgb;
      if (crit) rgb = NUM_COLORS.crit;
      else if (target.kind === 'player' && !heal && (type === 'phys' || type === 'bleed')) rgb = NUM_COLORS.hurt;
      else rgb = numColor(type);
      // stagger numbers that land on the same target at once
      let stack = 0; for (const f of FX.floaters) if (f.target === target && f.t < 0.25) stack++;
      const base = crit ? 1.25 : isDot ? 0.8 : 1; // size is a scale multiplier (UI font px × size)
      const side = stack % 2 ? 1 : -1;
      return pushFloater({
        x: target.x + rr(-5, 5) + side * Math.min(3, stack) * 7, y: target.y, z: (target.height || 40) + (target.z || 0) + 4 + stack * 7,
        text: (heal ? '+' : '') + Math.max(1, Math.round(amount)), rgb, size: base * 0.5, base, scale: 0.5, alpha: 1,
        t: 0, life: crit ? 1.15 : isDot ? 0.8 : 0.9, crit: !!crit, kind: heal ? 'heal' : crit ? 'crit' : isDot ? 'dot' : 'dmg',
        type, target, amount, vx: rr(-16, 16) * (crit ? 1.6 : 1), vz: crit ? 100 : isDot ? 46 : 74, lastT: FX.t, bump: 0,
      });
    },
    text(x, y, z, str, rgb, scale) {
      const base = scale || 1;
      return pushFloater({ x, y, z: z || 0, text: String(str), rgb: rgb || [0.9, 0.9, 0.92], size: base * 0.5, base, scale: 0.5, alpha: 1, t: 0, life: 1.1, crit: false, kind: 'text', type: 'text', target: null, amount: 0, vx: 0, vz: 42, lastT: FX.t, bump: 0 });
    },

    // ----------------------------------------------------------------------------- shake
    shake(amount) { if (amount > 0) trauma = Math.min(1, trauma + amount * 0.055); },
    shakeOffset() {
      const s = setting('shake', 1);
      if (trauma <= 0.002 || !s) return [0, 0];
      const mag = trauma * trauma * 20 * s, a = shakeT;
      return [mag * (Math.sin(a * 37.1) * 0.6 + Math.sin(a * 61.7 + 1.3) * 0.4), mag * 0.8 * (Math.sin(a * 43.3 + 2.1) * 0.6 + Math.sin(a * 71.9 + 0.4) * 0.4)];
    },
    get trauma() { return trauma; },

    // ----------------------------------------------------------------------------- hits & statuses
    hitSpark(target, info) {
      if (!target) return;
      info = info || EMPTY; const spec = info.spec || EMPTY;
      let dir = spec.dir;
      if (dir === undefined && info.source) dir = Math.atan2(target.y - info.source.y, target.x - info.source.x);
      if (dir === undefined) dir = rand() * TAU;
      const type = info.type || 'phys', crit = !!info.crit;
      const z = (target.height || 40) * 0.55 + (target.z || 0);
      const x = target.x - Math.cos(dir) * (target.radius || 8) * 0.4, y = target.y - Math.sin(dir) * (target.radius || 8) * 0.4;
      const amt = info.amount || 6;
      const n = Math.round((4 + Math.min(10, amt / 4)) * (crit ? 1.8 : 1) * (target.isBoss ? 1.3 : 1));
      FX.burst(x, y, z, TYPE_SPARK[type] || 'spark', n, { dir, spread: 0.7, speed: crit ? 1.35 : 1, zr: 6 }); // spray off the far side
      FX.burst(x, y, z, TYPE_SPARK[type] || 'spark', Math.max(1, Math.round(n * 0.35)), { dir: dir + PI, spread: 0.45, speed: 0.7, zr: 4 }); // ricochet back at the striker
      const m = matterOf(target);
      if (info.absorbed && !info.amount) FX.burst(x, y, z, 'glint', 6, { color: [0.6, 0.8, 1.5] });
      else if (m !== 'dust' || rand() < 0.5) FX.burst(x, y, z, m, Math.round(n * (m === 'bone' ? 0.5 : 0.7)), { dir, spread: 0.9, speed: 0.8, zr: 8 });
      const lc = TYPE_LIGHT[type];
      if (lc) FX.light(x, y, z, 55, lc, 0.9, 0.12);
      if (crit) {
        flashes.push({ x, y, z, t: 0, dur: 0.1, size: target.isBoss ? 4 : 3, color: [2.6, 2.5, 2.2] });
        FX.light(x, y, z, 70, [1, 0.95, 0.8], 1.2, 0.1);
      }
    },
    statusAura(a, s, dt) {
      if (!a || !s || !(dt > 0) || a.dead || !R.inViewWorld(a.x, a.y, 120)) return;
      const rate = AURA_RATE[s.id]; if (!rate) return;
      if (s.id === 'haste' && !a.moving) return;
      const st = s.stacks || 1;
      s._fxAcc = (s._fxAcc || 0) + dt * rate * (st > 1 ? Math.min(2.5, 0.7 + 0.3 * st) : 1);
      let guard = 6;
      while (s._fxAcc >= 1 && guard--) { s._fxAcc -= 1; auraEmit(a, s); }
      if (s._fxAcc > 1) s._fxAcc = 0;
    },

    // ----------------------------------------------------------------------------- shapes
    // swing({actor,x,y,z,a0,a1,r0,r1,dur,life,color,glyphs,emissive,width}) — crescent trail (r0 inner / r1 outer radius)
    swing(o) {
      o = o || EMPTY;
      const a = o.actor || null;
      const x = o.x !== undefined ? o.x : a ? a.x : 0, y = o.y !== undefined ? o.y : a ? a.y : 0;
      const r1 = o.r1 !== undefined ? o.r1 : o.r !== undefined ? o.r : 40;
      let r0 = o.r0 !== undefined ? o.r0 : r1 * 0.45;
      if (o.width !== undefined) r0 = Math.max(0, r1 - o.width);
      const S = {
        actor: a, ox: a ? x - a.x : 0, oy: a ? y - a.y : 0, x, y, z: o.z !== undefined ? o.z : a ? (a.height || 50) * 0.42 + (a.z || 0) : 22,
        a0: o.a0 !== undefined ? o.a0 : -1, a1: o.a1 !== undefined ? o.a1 : 1, r0: Math.min(r0, r1 - 2), r1,
        dur: Math.max(0.01, o.dur || 0.1), life: o.life || 0.15, t: 0, color: o.color || [0.88, 0.92, 1.0],
        glyphs: G(o.glyphs || '@%+:.'), emissive: o.emissive !== undefined ? +o.emissive : 0.7,
      };
      swings.push(S); if (swings.length > 24) swings.shift();
      return S;
    },
    // telegraph({shape:'circle'|'ring'|'line'|'cone'|'rect', x,y,r,r0,ang,len,w,half,dur,color,onDone,x1,y1,follow}) → handle {cancel()}
    telegraph(o) {
      o = o || EMPTY;
      const T = {
        shape: o.shape || 'circle', x: o.x || 0, y: o.y || 0, r: o.r || 60, r0: o.r0, ang: o.ang || 0, len: o.len || o.r || 120,
        w: o.w || 26, half: o.half !== undefined ? o.half : 0.5, dur: Math.max(0.05, o.dur || 1), color: o.color || [1, 0.32, 0.12],
        onDone: o.onDone || null, follow: o.follow || null, t: 0, done: false, dead: false, cancelled: false, progress: 0, seed: (rand() * 997) | 0,
        cancel() { T.cancelled = true; T.dead = true; },
      };
      if (o.x1 !== undefined && o.y1 !== undefined) { T.ang = Math.atan2(o.y1 - T.y, o.x1 - T.x); T.len = Math.hypot(o.x1 - T.x, o.y1 - T.y); }
      if (T.shape === 'ring' && T.r0 === undefined) T.r0 = T.r * 0.5;
      telegraphs.push(T);
      return T;
    },
    // fissure({x,y,ang,prongs,spread,len,color,preset,onErupt(points)}) — the 3-prong Fire Fissure from the reels
    fissure(o) {
      o = o || EMPTY;
      const x = o.x || 0, y = o.y || 0, ang = o.ang !== undefined ? o.ang : -PI / 2;
      const angs = Array.isArray(o.angles) && o.angles.length ? o.angles : null; // explicit prong angles (bosses match their telegraphs)
      const n = angs ? angs.length : Math.max(1, o.prongs || 3), spread = o.spread !== undefined ? o.spread : 0.34, len = o.len || 340;
      const f = { x, y, ang, len, t: 0, lines: [], branches: [], erupted: false, dead: false, onErupt: o.onErupt || null, source: o.source || null,
        pal: o.color ? palFrom(o.color) : FIRE_PAL, preset: o.preset || (o.color && o.color[1] > o.color[0] ? 'witchfire' : 'ember') };
      const jag = o.jag !== undefined ? o.jag : angs ? 0.45 : 1, bend = angs ? 1 : 0.62;
      for (let k = 0; k < n; k++) {
        const off = angs ? M.angleDiff(ang, angs[k]) : n === 1 ? 0 : (k / (n - 1) - 0.5) * 2 * spread;
        const ln = buildLine(x, y, ang, off, len * (angs ? 1 : Math.abs(off) > 0.01 ? rr(0.94, 1.04) : 1), jag, bend);
        ln.cols = sampleLine(ln, FIS.colStep); ln.orbs = sampleLine(ln, FIS.orbStep); ln.next = 0;
        ln.h = new Float32Array(ln.cols.length / 3); for (let j = 0; j < ln.h.length; j++) ln.h[j] = rr(12, 26) + (rand() < 0.12 ? 14 : 0);
        f.lines.push(ln);
        // short side forks
        const nb = 2 + ((rand() * 3) | 0);
        for (let b = 0; b < nb; b++) {
          const s = rr(0.2, 0.85) * ln.n | 0, bx = ln.pts[s * 2], by = ln.pts[s * 2 + 1];
          const ba = ang + off + (rand() < 0.5 ? -1 : 1) * rr(0.5, 1.1);
          const br = buildLine(bx, by, ba, 0, rr(14, 38), 1.4); br.d0 = ln.d[s]; br.parent = ln;
          f.branches.push(br);
        }
      }
      fissures.push(f);
      return f;
    },
    explosion(x, y, r, kind) {
      r = r || 40; const K = EXPL[kind] || EXPL.fire;
      const s = 0.8 + r / 70;
      FX.burst(x, y, 6, K.p1, Math.round(10 + r * 0.45), { speed: s, up: 1 + r / 90, r: r * 0.2, zr: 6 });
      FX.burst(x, y, 6, K.p2, Math.round(5 + r * 0.2), { speed: s * 1.1, r: r * 0.15 });
      FX.burst(x, y, 2, K.p3, Math.round(4 + r * 0.12), { speed: 0.6 + r / 120, r: r * 0.5 });
      FX.ring(x, y, r * 0.25, r * 1.15, 0.38, K.ring);
      if (K.core) blasts.push({ x, y, r: r * 0.55, t: 0, dur: 0.22, pal: K.core });
      if (K.light) FX.light(x, y, 12, r * 3 + 40, K.light, 2.2, 0.4);
      if (K.decal) FX.decal(x, y, K.decal, r * 0.8, 9);
      const p = HM.Game && HM.Game.player;
      if (p && !p.dead) { const d = Math.hypot(p.x - x, p.y - y); if (d < 420) FX.shake(Math.min(9, 2 + r / 9) * (1 - d / 480)); }
    },
    // ring(x,y,r0,r1,dur,color,opts{glyph,thick}) — expanding ground shockwave of dotted o/.
    ring(x, y, r0, r1, dur, color, o) {
      const g = (o && o.glyph) ? gi(o.glyph) : GL.o;
      rings.push({ x, y, r0: r0 || 0, r1: r1 || 60, dur: dur || 0.35, t: 0, color: color || [1.8, 0.8, 0.22], g, seed: (rand() * 997) | 0 });
      if (rings.length > 40) rings.shift();
    },
    // light(x,y,z,radius,rgb,intensity,dur) — transient point light (eases out). Returns the light (you may move it).
    light(x, y, z, radius, rgb, intensity, dur) {
      const c = rgb || [1, 0.6, 0.3];
      const L = { x, y, z: z || 0, rad: radius || 80, r: c[0], g: c[1], b: c[2], i: intensity === undefined ? 1 : intensity, t: 0, dur: dur || 0.15, flick: 0 };
      if (lights.length >= 96) lights.shift();
      lights.push(L); return L;
    },
    decal(x, y, kind, r, life) { const d = makeDecal(x, y, kind, r || 22, life || 10); if (d) { decals.push(d); if (decals.length > 140) decals.shift(); } return d; },
    // ghost(actor, dur, {tint}) — afterimage: the actor's glyphs this frame, re-drawn translucent & fading
    ghost(actor, dur, o) {
      if (!actor) return;
      if (ghosts.length >= 28) ghosts.shift();
      ghosts.push({ actor, dur: dur || 0.3, t: 0, pending: true, tint: (o && o.tint) || [0.5, 0.62, 0.95], n: 0 });
    },
    // beam(x0,y0,x1,y1,{w,color,dur,glyphs,z,z1}) — crackling line of glyphs (lich rays, lightning, life drain)
    beam(x0, y0, x1, y1, o) {
      o = o || EMPTY;
      beams.push({ x0, y0, x1, y1, w: o.w || 10, color: o.color || [0.6, 1.4, 0.6], dur: o.dur || 0.3, t: 0, glyphs: G(o.glyphs || '#=*+-'), z: o.z !== undefined ? o.z : 22, z1: o.z1 !== undefined ? o.z1 : (o.z !== undefined ? o.z : 22) });
      if (beams.length > 20) beams.shift();
    },
    // crit-style star flash (public helper)
    flash(x, y, z, size, color, dur) { flashes.push({ x, y, z: z || 0, t: 0, dur: dur || 0.1, size: size || 3, color: color || [2.6, 2.5, 2.2] }); },

    // ----------------------------------------------------------------------------- projectile & zone looks
    drawProjectile(p) {
      if (!p || !R.inViewWorld(p.x, p.y, 80)) return;
      const fn = LOOKS[p.look] || LOOKS.bolt;
      fn(p);
      if (p.light) R.light(p.x, p.y, p.z, p.light[0], p.light[1], p.light[2], p.light[3], 1); // (combat adds it during update, which beginFrame clears)
    },
    drawZone(z) {
      if (!z || !R.inViewWorld(z.x, z.y, (z.r || 40) + 50)) return;
      const a = clamp(z.t / 0.25, 0, 1) * clamp(z.life / 0.5, 0, 1);
      if (a <= 0) return;
      (ZONES[z.kind] || ZONES.generic)(z, a);
    },

    stats() { return { particles: pn, lights: lights.length, decals: decals.length, telegraphs: telegraphs.length, fissures: fissures.length, swings: swings.length, ghosts: ghosts.length, floaters: FX.floaters.length }; },
    // live telegraph handles (read-only: shape, x, y, r, r0, ang, len, w, half, dur, t, progress, done) — bots/harnesses/AI
    telegraphList() { return telegraphs; },
  });

  // ===========================================================================================
  // Floaters update
  // ===========================================================================================
  function updateFloaters(dt) {
    const F = FX.floaters; if (!F.length) return;
    const dv = Math.exp(-3.2 * dt), dx = Math.exp(-4 * dt);
    let w = 0;
    for (let k = 0; k < F.length; k++) {
      const f = F[k];
      f.t += dt;
      if (f.t >= f.life) continue;
      f.z += f.vz * dt; f.vz *= dv; f.x += f.vx * dt; f.vx *= dx;
      const pop = M.easeOutBack(Math.min(1, f.t / 0.16));
      const punch = f.crit ? 0.75 * Math.max(0, 1 - f.t / 0.24) : 0;
      f.bump = Math.max(0, (f.bump || 0) - dt * 5);
      f.scale = 0.45 + 0.55 * pop + punch + f.bump * 0.3;
      f.size = f.base * f.scale;
      const fadeAt = f.life * 0.55;
      f.alpha = f.t < fadeAt ? 1 : Math.max(0, 1 - (f.t - fadeAt) / (f.life - fadeAt));
      F[w++] = f;
    }
    F.length = w;
  }

  // ===========================================================================================
  // Status auras (emission, called from Combat.updateStatuses) + overlays (drawn each frame)
  // ===========================================================================================
  const ICE_GLINT = [1.4, 1.8, 2.3], WARD_GLINT = [0.7, 0.9, 1.8];
  const AURA_RATE = { burn: 22, poison: 9, bleed: 6, chill: 7, freeze: 4, weaken: 6, rot: 6, doom: 6, kindled: 9, haste: 12, shield: 3 };
  function auraEmit(a, s) {
    const r = (a.radius || 8), h = (a.height || 50), z0 = a.z || 0;
    const x = a.x + rr(-r, r) * 0.8, y = a.y + rr(-r, r) * 0.4, z = z0 + h * rr(0.2, 0.85);
    let i;
    switch (s.id) {
      case 'burn':
        i = spawnP(PRE_ID.ember, x, y, z, rr(-12, 12), rr(-8, 8), rr(30, 75), rr(0.4, 0.9));
        if (rand() < 0.2) spawnP(PRE_ID.flame, x, y, z0 + h * rr(0.3, 0.7), 0, 0, rr(40, 80), rr(0.2, 0.4));
        if (rand() < 0.12) spawnP(PRE_ID.smoke, x, y, z0 + h * 0.9, 0, 0, rr(15, 30), rr(0.8, 1.4));
        break;
      case 'poison': spawnP(PRE_ID.poison, x, y, z, rr(-6, 6), rr(-4, 4), rr(14, 36), rr(0.7, 1.2)); break;
      case 'bleed': spawnP(PRE_ID.blood, x, y, z0 + h * rr(0.35, 0.6), rr(-10, 10), rr(-6, 6), rr(-10, 20), rr(1.2, 2)); break;
      case 'chill': spawnP(PRE_ID.snow, x, y, z0 + h * rr(0.5, 1.0), rr(-8, 8), rr(-5, 5), rr(-5, 5), rr(0.6, 1.1)); break;
      case 'freeze': i = spawnP(PRE_ID.glint, x, y, z, 0, 0, rr(0, 10), rr(0.25, 0.45)); setColor(i, ICE_GLINT); break;
      case 'weaken': spawnP(PRE_ID.shadow, x, y, z0 + h * rr(0.3, 0.9), rr(-6, 6), rr(-4, 4), rr(10, 28), rr(0.6, 1.1)); break;
      case 'rot': spawnP(PRE_ID.rot, x, y, z0 + h * rr(0.3, 0.6), rr(-8, 8), rr(-5, 5), rr(0, 20), rr(1.0, 1.8)); break;
      case 'doom': spawnP(PRE_ID.witchfire, x, y, z0 + h * rr(0.5, 1.1), rr(-5, 5), rr(-3, 3), rr(15, 35), rr(0.5, 0.9)); break;
      case 'kindled': spawnP(PRE_ID.ember, x, y, z0 + h * rr(0.35, 0.65), rr(-10, 10), rr(-6, 6), rr(20, 45), rr(0.3, 0.6)); break;
      case 'shield': i = spawnP(PRE_ID.glint, a.x + rr(-r, r) * 1.6, a.y + rr(-r, r) * 0.8, z, 0, 0, rr(5, 15), rr(0.2, 0.4)); setColor(i, WARD_GLINT); break;
      case 'haste': FX.ghost(a, 0.22, { tint: [0.72, 0.78, 1.05] }); break;
      default: break;
    }
  }
  const SKULL = [' ,-. ', '(o.o)', " `U' "];
  function drawStatusGround() {
    const ents = HM.Game && HM.Game.entities; if (!ents) return;
    for (const a of ents) {
      if (a.dead || !a.statuses || !a.statuses.length || !R.inViewWorld(a.x, a.y, 80)) continue;
      const sh = a.hasStatus ? a.hasStatus('shield') : null;
      if (sh) { // rotating dotted ward ring at the feet
        const rad = (a.radius || 8) * 1.9 + 5, n = Math.max(14, (TAU * rad / 4) | 0), rot = FX.t * 1.6;
        const pulse = 0.75 + 0.25 * Math.sin(FX.t * 4);
        for (let k = 0; k < n; k++) {
          const ang = (k / n) * TAU + rot, X = a.x + Math.cos(ang) * rad, Y = a.y + Math.sin(ang) * rad;
          const g = k % 3 === 0 ? GL.o : GL.dot;
          R.glowGlyph(X, Y * TILT, g, 0.45 * pulse, 0.65 * pulse, 1.4 * pulse, KEY_TELE + 0.15, 0.4);
        }
      }
    }
  }
  function drawStatusOverlays() {
    const ents = HM.Game && HM.Game.entities; if (!ents) return;
    const t = FX.t;
    for (const a of ents) {
      if (a.dead || !a.statuses || !a.statuses.length || !R.inViewWorld(a.x, a.y, 80)) continue;
      const h = a.height || 50, r = a.radius || 8, z0 = a.z || 0;
      for (const s of a.statuses) {
        switch (s.id) {
          case 'burn': R.light(a.x, a.y, h * 0.5, 48, 1, 0.45, 0.12, 0.5 + 0.25 * Math.sin(t * 23 + a.id)); break;
          case 'poison': tintActor(a, 0.45, 1.0, 0.35, 0.14, 0); break;
          case 'chill': tintActor(a, 0.6, 0.85, 1.2, 0.3, 0.012); break;
          case 'weaken': tintActor(a, 0.7, 0.4, 1.0, 0.22, 0.01); break;
          case 'freeze': drawIceBlock(a); break;
          case 'stun':
            for (let k = 0; k < 3; k++) {
              const ang = t * 4.2 + (k * TAU) / 3, X = a.x + Math.cos(ang) * (r + 5), Y = a.y + Math.sin(ang) * (r * 0.6 + 3);
              const tw = 0.7 + 0.3 * Math.sin(t * 13 + k * 2);
              R.glowGlyph(X, Y * TILT - (z0 + h + 6), (((t * 8) | 0) + k) % 2 ? GL.star : GL.plus, 2.1 * tw, 1.85 * tw, 0.6 * tw, Y + 3, 0.6);
            }
            break;
          case 'doom': {
            const pulse = 0.65 + 0.35 * Math.sin(t * 5 + a.id), pcx = a.x, pcy = a.y * TILT - (z0 + h + 34); // above the UI name tag
            for (let ln = 0; ln < SKULL.length; ln++) {
              const str = SKULL[ln];
              for (let c = 0; c < str.length; c++) {
                const ch = str.charCodeAt(c); if (ch === 32) continue;
                R.glowGlyph(pcx + (c - (str.length - 1) / 2) * CW, pcy + (ln - SKULL.length + 1) * CH, R.gc(ch), 0.45 * pulse, 1.7 * pulse, 0.55 * pulse, a.y + 12, 0.7);
              }
            }
            R.light(a.x, a.y, h, 50, 0.3, 1, 0.35, 0.45 * pulse);
            tintActor(a, 0.45, 1.0, 0.5, 0.12, 0.01);
            break;
          }
          case 'kindled': {
            const fl = 0.75 + 0.25 * Math.sin(t * 19 + a.id * 3);
            halo(a.x, a.y * TILT - (z0 + h * 0.45), 16, 0.5 * fl, 0.18 * fl, 0.03 * fl);
            R.light(a.x, a.y, h * 0.5, 55, 1, 0.5, 0.15, 0.55 * fl);
            break;
          }
          case 'shield': { // shimmering dome arc in front of the body
            const amt = s.amount > 0 ? 1 : 0.6, w = r * 1.9 + 6, hh = h * 0.95, n = 22;
            for (let k = 0; k <= n; k++) {
              const th = (k / n) * PI, sh = Math.sin(t * 6 + k * 0.9);
              if (sh < 0.2) continue;
              const X = a.x + Math.cos(th) * w, pyy = a.y * TILT - z0 - h * 0.15 - Math.sin(th) * hh;
              const g = k < n / 3 ? GL.rp : k > (2 * n) / 3 ? GL.lp : GL.dash; // right side ')', left side '(', top '-'
              R.glowGlyph(X, pyy, g, 0.4 * sh * amt, 0.6 * sh * amt, 1.3 * sh * amt, a.y + r + 2, 0.35);
            }
            break;
          }
          default: break;
        }
      }
    }
  }
  function drawIceBlock(a) {
    tintActor(a, 0.7, 0.92, 1.25, 0.72, 0.03);
    const r = (a.radius || 8), h = (a.height || 50), z0 = a.z || 0;
    const w = r * 1.5 + 7, bx = a.x, by = a.y * TILT - z0, key = a.y + r + 4;
    const P = [[-w, 2], [-w, -h * 0.82], [-w * 0.35, -h * 1.02], [w * 0.4, -h * 0.98], [w, -h * 0.78], [w, 2], [w * 0.1, 5]];
    const sh = 0.85 + 0.15 * Math.sin(FX.t * 3 + a.id);
    for (let k = 0; k < P.length; k++) {
      const A = P[k], B = P[(k + 1) % P.length];
      R.seg(bx + A[0], by + A[1], bx + B[0], by + B[1], null, 0.75 * sh, 1.0 * sh, 1.35 * sh, key, F_UNLIT);
    }
    R.seg(bx - w * 0.35, by - h * 1.0, bx - w * 0.1, by - h * 0.35, null, 0.45, 0.62, 0.85, key - 0.1, F_UNLIT); // facet
    R.seg(bx + w * 0.4, by - h * 0.95, bx + w * 0.55, by - h * 0.2, null, 0.4, 0.55, 0.8, key - 0.1, F_UNLIT);
    R.light(a.x, a.y, h * 0.5, 40, 0.5, 0.75, 1, 0.35);
  }

  // ===========================================================================================
  // Telegraphs
  // ===========================================================================================
  function updateTelegraph(T, dt) {
    if (T.dead) return;
    T.t += dt;
    if (T.follow && !T.follow.dead && !T.done) { T.x = T.follow.x; T.y = T.follow.y; }
    T.progress = clamp(T.t / T.dur, 0, 1);
    if (!T.done && T.t >= T.dur) { T.done = true; if (T.onDone && !T.cancelled) safe(T.onDone, T); }
    if (T.done && T.t - T.dur > 0.14) T.dead = true;
  }
  // dotted outline: samples a world-space path every ~4.5px, alternating o / .
  function teleDot(x, y, n, b, er, eg, eb, cr, cg, cb) {
    const i = R.idxP(x, y * TILT);
    const g = (n & 1) ? GL.dot : GL.o;
    if (R.setI(i, g, er * b, eg * b, eb * b, KEY_TELE + 0.02, F_UNLIT)) R.emitI(i, cr * 0.22 * b, cg * 0.22 * b, cb * 0.22 * b);
  }
  function teleArc(x, y, rad, a0, a1, b, er, eg, eb, cr, cg, cb) {
    const n = Math.max(6, Math.ceil((Math.abs(a1 - a0) * rad) / 4.5));
    for (let s = 0; s <= n; s++) { const th = a0 + ((a1 - a0) * s) / n; teleDot(x + Math.cos(th) * rad, y + Math.sin(th) * rad, s, b, er, eg, eb, cr, cg, cb); }
  }
  function teleSeg(x0, y0, x1, y1, b, er, eg, eb, cr, cg, cb) {
    const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4.5));
    for (let s = 0; s <= n; s++) teleDot(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n, s, b, er, eg, eb, cr, cg, cb);
  }
  function drawTelegraph(T) {
    if (T.dead) return;
    if (T.shape === 'line' || T.shape === 'rect') { if (!R.inViewWorld(T.x + Math.cos(T.ang) * T.len * 0.5, T.y + Math.sin(T.ang) * T.len * 0.5, T.len * 0.6 + T.w + 20)) return; }
    else if (!R.inViewWorld(T.x, T.y, Math.max(T.r, T.len, 30) + 20)) return;
    const k = T.progress, c = T.color;
    const fin = T.done ? Math.max(0, 1 - (T.t - T.dur) / 0.14) : 0; // detonation flash
    const fadeIn = Math.min(1, T.t / 0.08);
    const cr = c[0], cg = c[1], cb = c[2];
    const er = cr * 0.45 + 0.8, eg = cg * 0.45 + 0.8, eb = cb * 0.45 + 0.8; // outline: whiter dotted ring
    const pulse = 0.8 + 0.2 * Math.sin(T.t * (8 + k * 14));
    const ob = (1.1 + 0.5 * k) * pulse * fadeIn + fin;
    const col = R.col;
    // interior cell. u = 0..1 fill coordinate of the cell (fills where u <= k)
    const cell = (i, ci, cj, u) => {
      if (u <= k || fin > 0) {
        const front = !T.done && u > k - 0.09;
        let g, b;
        if (front) { g = ((ci + cj) & 1) ? GL.O : GL.o; b = 1.15; }
        else if (((ci + 2 * cj) & 3) === 0) { g = GL.o; b = 0.5; }
        else { g = GL.dot; b = 0.36; }
        b = (b * (0.65 + 0.35 * k) + fin * 1.1) * fadeIn;
        if (R.setI(i, g, cr * b, cg * b, cb * b, KEY_TELE, F_UNLIT)) R.emitI(i, cr * 0.09 * b, cg * 0.09 * b, cb * 0.09 * b);
      } else { // not yet filled: tint whatever is there toward the warning colour
        const o = i * 3, m = 0.28 * fadeIn;
        col[o] += (cr * 0.5 - col[o]) * m; col[o + 1] += (cg * 0.5 - col[o + 1]) * m; col[o + 2] += (cb * 0.5 - col[o + 2]) * m;
      }
    };
    if (T.shape === 'circle' || T.shape === 'ring') {
      const rIn = T.shape === 'ring' ? T.r0 / T.r : 0;
      R.ellipse(T.x, T.y, T.r, T.r, (i, u, ci, cj) => { if (u >= rIn) cell(i, ci, cj, rIn > 0 ? (u - rIn) / (1 - rIn) : u); });
      teleArc(T.x, T.y, T.r, 0, TAU, ob, er, eg, eb, cr, cg, cb);
      if (rIn > 0) teleArc(T.x, T.y, T.r0, 0, TAU, ob * 0.8, er, eg, eb, cr, cg, cb);
      R.light(T.x, T.y, 0, T.r * 1.2, cr, cg * 0.8, cb * 0.8, 0.12 + 0.33 * k + fin);
    } else if (T.shape === 'cone') {
      const L = T.len, half = T.half;
      R.ellipse(T.x, T.y, L, L, (i, u, ci, cj, ang) => { if (Math.abs(M.angleDiff(T.ang, ang)) <= half) cell(i, ci, cj, u); });
      teleArc(T.x, T.y, L, T.ang - half, T.ang + half, ob, er, eg, eb, cr, cg, cb);
      teleSeg(T.x, T.y, T.x + Math.cos(T.ang - half) * L, T.y + Math.sin(T.ang - half) * L, ob, er, eg, eb, cr, cg, cb);
      teleSeg(T.x, T.y, T.x + Math.cos(T.ang + half) * L, T.y + Math.sin(T.ang + half) * L, ob, er, eg, eb, cr, cg, cb);
      R.light(T.x + Math.cos(T.ang) * L * 0.5, T.y + Math.sin(T.ang) * L * 0.5, 0, L * 0.8, cr, cg * 0.8, cb * 0.8, 0.1 + 0.3 * k + fin);
    } else { // line / rect
      const ca = Math.cos(T.ang), sa = Math.sin(T.ang), hw = T.w / 2, L = T.len;
      const centered = T.shape === 'rect';
      const ox = centered ? T.x - (ca * L) / 2 : T.x, oy = centered ? T.y - (sa * L) / 2 : T.y;
      const ex = ox + ca * L, ey = oy + sa * L;
      const minx = Math.min(ox, ex) - hw - 4, maxx = Math.max(ox, ex) + hw + 4, miny = Math.min(oy, ey) - hw - 4, maxy = Math.max(oy, ey) + hw + 4;
      const ci0 = Math.floor(minx / CW), ci1 = Math.floor(maxx / CW), cj0 = Math.floor((miny * TILT) / CH), cj1 = Math.floor((maxy * TILT) / CH);
      const orbStep = 14, isLine = T.shape === 'line';
      for (let cj = cj0; cj <= cj1; cj++) {
        const wy = ((cj + 0.5) * CH) / TILT;
        for (let ci = ci0; ci <= ci1; ci++) {
          const i = R.idx(ci, cj); if (i < 0) continue;
          const dx = (ci + 0.5) * CW - ox, dy = wy - oy;
          const along = dx * ca + dy * sa, across = -dx * sa + dy * ca;
          if (along < 0 || along > L || Math.abs(across) > hw) continue;
          const u = centered ? Math.abs(along - L / 2) / (L / 2) : along / L;
          if (isLine && Math.abs(across) < 4.5) { // rows of o orbs marching along the path
            const m = along % orbStep, filled = u <= k || fin > 0;
            if (m < 4.5) {
              const b = (filled ? (u > k - 0.08 && !T.done ? 1.4 : 0.8 + 0.3 * k) : 0.35) * fadeIn + fin;
              if (R.setI(i, filled ? GL.O : GL.o, cr * b, cg * b, cb * b, KEY_TELE + 0.01, F_UNLIT)) R.emitI(i, cr * 0.2 * b, cg * 0.2 * b, cb * 0.2 * b);
              continue;
            }
          }
          cell(i, ci, cj, u);
        }
      }
      const nx = -sa * hw, ny = ca * hw;
      teleSeg(ox + nx, oy + ny, ex + nx, ey + ny, ob, er, eg, eb, cr, cg, cb);
      teleSeg(ox - nx, oy - ny, ex - nx, ey - ny, ob, er, eg, eb, cr, cg, cb);
      teleSeg(ox + nx, oy + ny, ox - nx, oy - ny, ob, er, eg, eb, cr, cg, cb);
      teleSeg(ex + nx, ey + ny, ex - nx, ey - ny, ob, er, eg, eb, cr, cg, cb);
      R.light((ox + ex) / 2, (oy + ey) / 2, 0, L * 0.6 + hw, cr, cg * 0.8, cb * 0.8, 0.1 + 0.28 * k + fin);
    }
  }

  // ===========================================================================================
  // Fissure update/draw
  // ===========================================================================================
  function updateFissure(f, dt) {
    f.t += dt;
    const t = f.t;
    if (!f.erupted && t >= FIS.erupt) {
      f.erupted = true;
      const pts = [];
      for (const ln of f.lines) {
        const s = sampleLine(ln, FIS.ptStep);
        for (let k = 0; k < s.length; k += 3) { const p = [s[k], s[k + 1]]; p.x = s[k]; p.y = s[k + 1]; p.d = s[k + 2]; pts.push(p); }
        for (let k = 0; k < ln.orbs.length; k += 3) if (rand() < 0.8) FX.decal(ln.orbs[k], ln.orbs[k + 1], f.preset === 'witchfire' ? 'witch' : 'scorch', rr(14, 22), rr(4, 6.5));
      }
      f.points = pts;
      if (f.onErupt) safe(f.onErupt, pts, f);
      HM.Audio && HM.Audio.play && HM.Audio.play('fire', { x: f.x + Math.cos(f.ang) * f.len * 0.4, y: f.y + Math.sin(f.ang) * f.len * 0.4, vol: 1.1 });
      const p = HM.Game && HM.Game.player;
      if (p) { const d = Math.hypot(p.x - f.x, p.y - f.y); if (d < 500) FX.shake(6 * (1 - d / 600)); }
    }
    if (dt > 0) {
      for (const ln of f.lines) {
        const L = ln.L || 1, cols = ln.cols;
        // columns collapsing into rising embers + sparks
        while (ln.next < cols.length / 3) {
          const j = ln.next, te = FIS.erupt + FIS.span * (cols[j * 3 + 2] / L);
          if (t < te + FIS.collapse) break;
          ln.next++;
          const x = cols[j * 3], y = cols[j * 3 + 1], hgt = ln.h[j];
          for (let e = 0; e < 2; e++) { const i = spawnP(PRE_ID[f.preset] !== undefined ? PRE_ID[f.preset] : PRE_ID.ember, x + rr(-3, 3), y + rr(-2, 2), hgt * rr(0.3, 1.0), rr(-14, 14), rr(-10, 10), rr(35, 110), rr(0.6, 1.4)); if (f.pal !== FIRE_PAL) setColor(i, f.pal.org); }
          if (rand() < 0.35) { const i = spawnP(PRE_ID.spark, x, y, hgt * 0.6, rr(-60, 60), rr(-40, 40), rr(60, 160), rr(0.2, 0.45)); if (f.pal !== FIRE_PAL) setColor(i, f.pal.hot); }
        }
        // lingering ember drift off the hot cracks
        if (t > 0.45 && t < FIS.cool + 0.3) {
          const rate = 70 * Math.max(0, 1 - (t - 0.45) / 0.95);
          ln.acc = (ln.acc || 0) + rate * dt;
          while (ln.acc >= 1) {
            ln.acc -= 1;
            const j = (rand() * (cols.length / 3)) | 0;
            const i = spawnP(PRE_ID[f.preset] !== undefined ? PRE_ID[f.preset] : PRE_ID.ember, cols[j * 3] + rr(-3, 3), cols[j * 3 + 1] + rr(-2, 2), rr(0, 8), rr(-8, 8), rr(-6, 6), rr(25, 70), rr(0.5, 1.1));
            if (f.pal !== FIRE_PAL) setColor(i, f.pal.org);
          }
        }
      }
    }
    if (t >= FIS.end) f.dead = true;
  }
  // phase colour for cracks
  function crackColor(f, t, out) {
    const P = f.pal;
    let c, b;
    if (t < 0.15) { c = P.dim; b = 1.25; }
    else if (t < 0.32) { const k = (t - 0.15) / 0.17; c = mix3(P.dim, P.org, k); b = 1.25 - 0.05 * k; }
    else if (t < 0.5) { c = P.org; b = 1.2; }
    else if (t < FIS.cool) { const k = (t - 0.5) / (FIS.cool - 0.5); c = mix3(P.org, P.dim, k); b = 1.2 - 0.45 * k; }
    else { const k = (t - FIS.cool) / (FIS.end - FIS.cool); c = mix3(P.dim, P.ember, k); b = 0.75 * (1 - k); }
    out[0] = c[0] * b; out[1] = c[1] * b; out[2] = c[2] * b;
    return out;
  }
  const _cc = [0, 0, 0];
  function drawCrackLine(f, ln, reveal, t, c, dimK, key, thick) {
    const n = ln.n, pts = ln.pts, d = ln.d, L = ln.L;
    const jf = (R.time * 18) | 0;
    const late = t > FIS.cool ? (t - FIS.cool) / (FIS.end - FIS.cool) : 0;
    const beads = t > 0.18 && t < FIS.cool + 0.4;
    for (let s = 0; s <= n; s++) {
      const ds = d[s];
      if (ds > reveal) break;
      if (late > 0 && hash(s * 7 + 3, ln.n) < late * 0.85) continue; // dissolve as it cools
      const x = pts[s * 2], y = pts[s * 2 + 1];
      const hj = hash(s, jf);
      const tip = reveal < L && ds > reveal - 16;
      let g, b = dimK;
      if (tip) { g = ds > reveal - 7 ? GL.star : GL.o; b *= 1.8; }
      else if (beads) g = (s & 1) ? GL.o : GL.dot;
      else g = RAMP.crack[(hj * RAMP.crack.length) | 0];
      if (t < FIS.race) b *= 0.8 + 0.4 * hj; // jitter while racing
      const jx = t < FIS.race && hj > 0.85 ? (hj - 0.92) * 30 : 0;
      const pxx = x + jx, pyy = y * TILT;
      const i = R.idxP(pxx, pyy);
      if (R.setI(i, g, c[0] * b, c[1] * b, c[2] * b, key, F_UNLIT)) R.emitI(i, c[0] * 0.55 * b, c[1] * 0.55 * b, c[2] * 0.55 * b);
      if (thick && s > 0 && (s & 1) === 0) { // widen hot cracks perpendicular to the segment
        const ax = pts[s * 2 - 2], ay = pts[s * 2 - 1], sx = x - ax, sy = y - ay, l = Math.hypot(sx, sy) || 1;
        const ox = (-sy / l) * 3.2, oy = (sx / l) * 3.2;
        const side = hj < 0.5 ? 1 : -1;
        const j2 = R.idxP(x + ox * side, (y + oy * side) * TILT);
        const b2 = b * 0.5;
        if (R.setI(j2, (s & 2) ? GL.apos : GL.comma, c[0] * b2, c[1] * b2, c[2] * b2, key - 0.01, F_UNLIT)) R.emitI(j2, c[0] * 0.3 * b2, c[1] * 0.3 * b2, c[2] * 0.3 * b2);
      }
    }
  }
  function drawFissureGround(f) {
    const t = f.t, L = f.len;
    const cx = f.x + Math.cos(f.ang) * L * 0.5, cy = f.y + Math.sin(f.ang) * L * 0.5;
    if (!R.inViewWorld(cx, cy, L + 60)) return;
    const P = f.pal;
    const reveal01 = t < FIS.race ? M.easeOutCubic(t / FIS.race) : 1;
    const c = crackColor(f, t, _cc);
    const thick = t < FIS.cool + 0.2;
    for (const ln of f.lines) drawCrackLine(f, ln, reveal01 * ln.L + 0.01, t, c, 1, KEY_TELE + 0.05, thick);
    for (const br of f.branches) {
      const rev = reveal01 * br.parent.L - br.d0; if (rev <= 0) continue;
      drawCrackLine(f, br, rev * 1.3, t, c, 0.7, KEY_TELE + 0.04, false);
    }
    // ground light: faint red while racing (reads purple against the moonlit grass), huge orange on eruption
    let li, lc;
    if (t < FIS.race) { li = 0.75 * reveal01; lc = P.tint; }
    else if (t < 0.42) { li = 0.75 + 0.55 * ((t - FIS.race) / 0.17); lc = mix3(P.tint, P.light, (t - FIS.race) / 0.17); }
    else if (t < FIS.cool) { li = 1.3 - 0.85 * ((t - 0.42) / (FIS.cool - 0.42)); lc = P.light; }
    else { li = 0.45 * (1 - (t - FIS.cool) / (FIS.end - FIS.cool)); lc = P.tint; }
    const fl = 0.92 + 0.08 * Math.sin(t * 37);
    R.light(cx, cy, 0, L * 0.75 + 60, lc[0], lc[1], lc[2], li * fl);
  }
  function drawFissureAir(f) {
    const t = f.t; if (t < FIS.erupt - 0.01 || t > FIS.cool + 0.6) return;
    const L0 = f.len, P = f.pal;
    if (!R.inViewWorld(f.x + Math.cos(f.ang) * L0 * 0.5, f.y + Math.sin(f.ang) * L0 * 0.5, L0 + 80)) return;
    const jf = (R.time * 24) | 0;
    for (const ln of f.lines) {
      const L = ln.L || 1, cols = ln.cols, m = cols.length / 3;
      // flame columns
      for (let j = 0; j < m; j++) {
        const te = FIS.erupt + FIS.span * (cols[j * 3 + 2] / L), age = t - te;
        if (age < 0 || age > FIS.colLife) continue;
        const H = ln.h[j];
        let zb = 0, zt;
        if (age < 0.06) zt = H * M.easeOutCubic(age / 0.06);
        else if (age < FIS.collapse) zt = H * (0.88 + 0.12 * Math.sin(age * 60 + j));
        else { const k = (age - FIS.collapse) / (FIS.colLife - FIS.collapse); zb = H * 0.95 * k; zt = H * (1 + 0.6 * k); }
        const x = cols[j * 3], y = cols[j * 3 + 1], key = y + 1.2;
        const thin = age > FIS.collapse ? (age - FIS.collapse) / (FIS.colLife - FIS.collapse) : 0;
        const cool = clamp((age - 0.07) / 0.22, 0, 1); // white-hot core cools to orange as the column collapses
        for (let z = zb; z <= zt; z += 5) {
          const fz = (z - zb) / Math.max(1, zt - zb);
          const hz = hash(j * 31 + ((z / 6) | 0), jf);
          if (thin > 0 && hz < thin * 0.8) continue;
          let g, c;
          const v = Math.min(1, fz + cool * 0.85);
          if (fz < 0.3) g = hz < 0.5 ? GL.at : GL.hash;
          else if (fz < 0.62) g = hz < 0.4 ? GL.hash : GL.star;
          else if (fz < 0.85) g = hz < 0.5 ? GL.star : GL.plus;
          else g = hz < 0.5 ? GL.apos : GL.caret;
          if (v < 0.35) c = mix3(P.hot, P.yel, v / 0.35);
          else if (v < 0.75) c = mix3(P.yel, P.org, (v - 0.35) / 0.4);
          else c = mix3(P.org, P.dim, (v - 0.75) / 0.25);
          const bb = 1 - thin * 0.5;
          const jx = (hz - 0.5) * 4;
          R.glowGlyph(x + jx, y * TILT - z, g, c[0] * bb, c[1] * bb, c[2] * bb, key, 0.3);
          if (fz < 0.5 && hz > 0.8) { // side tongues
            const sd = hz > 0.72 ? CW : -CW;
            R.glowGlyph(x + jx + sd, y * TILT - z - 2, sd > 0 ? GL.rp : GL.lp, P.org[0] * 0.8 * bb, P.org[1] * 0.8 * bb, P.org[2] * 0.8 * bb, key - 0.05, 0.25);
          }
        }
      }
      // halo orbs every ~40px (stay as dim glows while the cracks cool, like the reel)
      const orbs = ln.orbs, mo = orbs.length / 3;
      for (let j = 0; j < mo; j++) {
        const te = FIS.erupt + FIS.span * (orbs[j * 3 + 2] / L), age = t - te;
        if (age < 0) continue;
        const I = age < 0.06 ? age / 0.06 : age < 0.32 ? 1 : Math.max(0, 1 - (age - 0.32) / 0.75) * 0.75;
        if (I <= 0.01) continue;
        const x = orbs[j * 3], y = orbs[j * 3 + 1];
        const fl = 0.85 + 0.15 * Math.sin(t * 29 + j * 1.7);
        halo(x, y * TILT - 8, 22, P.org[0] * 0.42 * I * fl, P.org[1] * 0.4 * I * fl, P.org[2] * 0.4 * I * fl);
        R.light(x, y, 10, 58, P.light[0], P.light[1], P.light[2], 0.8 * I * fl);
      }
    }
  }

  // ===========================================================================================
  // Rings, blasts, flashes, swings, beams
  // ===========================================================================================
  function drawRing(o) {
    const k = o.t / o.dur; if (k >= 1) return;
    const e = M.easeOutCubic(k), rad = o.r0 + (o.r1 - o.r0) * e, a = 1 - k;
    if (!R.inViewWorld(o.x, o.y, rad + 20)) return;
    const c = o.color;
    for (let band = 0; band < 2; band++) {
      const rb = rad * (band ? 0.86 : 1); if (rb < 2) continue;
      const n = Math.max(10, ((TAU * rb) / 3.6) | 0);
      const g = band ? GL.dot : o.g, bb = (band ? 0.55 : 1) * a;
      for (let s = 0; s < n; s++) {
        if (hash(s + o.seed, band) > a + 0.3) continue;
        const ang = (s / n) * TAU;
        const i = R.idxP(o.x + Math.cos(ang) * rb, (o.y + Math.sin(ang) * rb) * TILT);
        if (R.setI(i, g, c[0] * bb, c[1] * bb, c[2] * bb, KEY_TELE + 0.1, F_UNLIT)) R.emitI(i, c[0] * 0.35 * bb, c[1] * 0.35 * bb, c[2] * 0.35 * bb);
      }
    }
  }
  const BLAST_G = G("@#*+o'.");
  function drawBlast(o) {
    const k = o.t / o.dur; if (k >= 1) return;
    const rad = o.r * (0.55 + 0.45 * M.easeOutCubic(Math.min(1, k * 2.5))) * (1 - k * 0.35);
    const pcx = o.x, pcy = o.y * TILT - 10 - k * 14;
    const pal = o.pal, rx = rad, ry = rad * 0.8;
    const ci0 = Math.floor((pcx - rx) / CW), ci1 = Math.floor((pcx + rx) / CW), cj0 = Math.floor((pcy - ry) / CH), cj1 = Math.floor((pcy + ry) / CH);
    const jf = (R.time * 30) | 0;
    for (let cj = cj0; cj <= cj1; cj++) {
      for (let ci = ci0; ci <= ci1; ci++) {
        const dx = ((ci + 0.5) * CW - pcx) / rx, dy = ((cj + 0.5) * CH - pcy) / ry, u = Math.sqrt(dx * dx + dy * dy);
        if (u > 1) continue;
        const h = hash(ci * 5 + jf, cj * 3);
        if (u > 0.6 && h < k * 1.2) continue;
        const v = Math.min(1, u + k * 0.6);
        const c = v < 0.45 ? mix3(pal[0], pal[1], v / 0.45) : mix3(pal[1], pal[2], (v - 0.45) / 0.55);
        const g = BLAST_G[Math.min(BLAST_G.length - 1, (v * BLAST_G.length) | 0)];
        const b = 1 - k * 0.5;
        R.glowGlyph((ci + 0.5) * CW, (cj + 0.5) * CH, g, c[0] * b, c[1] * b, c[2] * b, o.y + 3, 0.8);
      }
    }
  }
  function drawFlash(o) {
    const k = o.t / o.dur; if (k >= 1) return;
    const s = Math.max(1, Math.round(o.size * (1 - k * 0.4))), c = o.color, b = 1 - k;
    const pcx = o.x, pcy = o.y * TILT - o.z, key = o.y + 8;
    R.glowGlyph(pcx, pcy, GL.star, c[0] * b * 1.2, c[1] * b * 1.2, c[2] * b * 1.2, key, 1.2);
    for (let d = 1; d <= s; d++) {
      const f = b * (1 - (d - 1) / (s + 1));
      R.glowGlyph(pcx + d * CW, pcy, GL.dash, c[0] * f, c[1] * f, c[2] * f, key, 0.8);
      R.glowGlyph(pcx - d * CW, pcy, GL.dash, c[0] * f, c[1] * f, c[2] * f, key, 0.8);
      if (d <= Math.ceil(s * 0.6)) {
        R.glowGlyph(pcx, pcy - d * CH, GL.bar, c[0] * f, c[1] * f, c[2] * f, key, 0.8);
        R.glowGlyph(pcx, pcy + d * CH, GL.bar, c[0] * f, c[1] * f, c[2] * f, key, 0.8);
      }
      if (d <= Math.ceil(s * 0.5)) {
        R.glowGlyph(pcx + d * CW, pcy - d * CH, GL.slash, c[0] * f * 0.7, c[1] * f * 0.7, c[2] * f * 0.7, key, 0.6);
        R.glowGlyph(pcx - d * CW, pcy + d * CH, GL.slash, c[0] * f * 0.7, c[1] * f * 0.7, c[2] * f * 0.7, key, 0.6);
        R.glowGlyph(pcx - d * CW, pcy - d * CH, GL.bslash, c[0] * f * 0.7, c[1] * f * 0.7, c[2] * f * 0.7, key, 0.6);
        R.glowGlyph(pcx + d * CW, pcy + d * CH, GL.bslash, c[0] * f * 0.7, c[1] * f * 0.7, c[2] * f * 0.7, key, 0.6);
      }
    }
  }
  function drawSwing(S) {
    const a = S.actor;
    const cx = a ? a.x + S.ox : S.x, cy = a ? a.y + S.oy : S.y;
    if (!R.inViewWorld(cx, cy, S.r1 + 20)) return;
    const t = S.t, head = t >= S.dur ? 1 : M.easeOutCubic(t / S.dur);
    const da = S.a1 - S.a0, nA = Math.max(6, Math.ceil((Math.abs(da) * S.r1) / 3));
    const thickMax = S.r1 - S.r0, gs = S.glyphs, gl = gs.length, c = S.color, em = S.emissive;
    const span = S.life + S.dur * 0.5;
    const whole = t > S.dur ? Math.max(0, 1 - (t - S.dur) / S.life) : 1; // the crescent fades out as one piece
    for (let s = 0; s <= nA; s++) {
      const f = s / nA; if (f > head + 1e-4) break;
      const tf = S.dur * (1 - Math.cbrt(1 - f)); // time the head passed this angle (inverse easeOutCubic)
      const age = t - tf; if (age > span) continue;
      const fa = (1 - (age / span) * (age / span)) * whole;
      if (fa <= 0.03) continue;
      const th = S.a0 + da * f, ct = Math.cos(th), st = Math.sin(th);
      // crescent: thick in the middle of the sweep, thin at both horns
      const thick = thickMax * (0.15 + 0.85 * Math.sin(PI * Math.min(1, f * 0.94 + 0.03))) * (0.45 + 0.55 * fa);
      const hot = Math.max(0, 1 - age / 0.05);
      for (let rad = S.r1; rad >= S.r1 - thick; rad -= 3.8) {
        const q = (S.r1 - rad) / Math.max(1, thick);
        const inten = fa * (1 - q * 0.6);
        if (inten <= 0.05) continue;
        const wx = cx + ct * rad, wy = cy + st * rad;
        let g = gs[Math.min(gl - 1, ((1 - Math.sqrt(inten)) * gl) | 0)];
        const m = 0.45 + 0.8 * inten;
        let r = c[0] * m, gg = c[1] * m, b = c[2] * m;
        if (hot > 0 && q < 0.5) { r += (1.7 - r) * hot * 0.6; gg += (1.7 - gg) * hot * 0.6; b += (1.7 - b) * hot * 0.6; g = gs[0]; }
        const idx = R.idxP(wx, wy * TILT - S.z), key = wy + 1.5;
        if (em > 0) { if (R.setI(idx, g, r, gg, b, key, F_UNLIT)) R.emitI(idx, r * em * inten, gg * em * inten, b * em * inten); }
        else R.setI(idx, g, r, gg, b, key, 0);
      }
    }
  }
  function drawBeam(B) {
    const k = B.t / B.dur; if (k >= 1) return;
    const a = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
    const dx = B.x1 - B.x0, dy = B.y1 - B.y0, len = Math.hypot(dx, dy); if (len < 1) return;
    const p0x = B.x0, p0y = B.y0 * TILT - B.z, p1x = B.x1, p1y = B.y1 * TILT - B.z1;
    const sdx = p1x - p0x, sdy = p1y - p0y, sl = Math.hypot(sdx, sdy) || 1, nx = -sdy / sl, ny = sdx / sl;
    const n = Math.max(2, Math.ceil(sl / 4)), c = B.color, gs = B.glyphs, gl = gs.length;
    const dir = R.dirGlyph(sdx, sdy), jf = (R.time * 28) | 0, w = B.w * (0.5 + 0.5 * a);
    for (let s = 0; s <= n; s++) {
      const f = s / n, X = p0x + sdx * f, Y = p0y + sdy * f, wy = B.y0 + dy * f;
      const h = hash(s, jf);
      const wob = (h - 0.5) * w * 0.35;
      const g = h < 0.45 ? dir : gs[(h * gl) | 0];
      R.glowGlyph(X + nx * wob, Y + ny * wob, g, c[0] * 1.3 * a, c[1] * 1.3 * a, c[2] * 1.3 * a, wy + 2, 0.8);
      if (w > 5 && h > 0.6) { const o = (h > 0.8 ? 1 : -1) * w * 0.5; R.glowGlyph(X + nx * o, Y + ny * o, GL.dot, c[0] * 0.6 * a, c[1] * 0.6 * a, c[2] * 0.6 * a, wy + 1.9, 0.5); }
      if ((s % 16) === 0) R.light(B.x0 + dx * f, B.y0 + dy * f, B.z, 50 + w * 2, Math.min(1, c[0]), Math.min(1, c[1]), Math.min(1, c[2]), 0.8 * a);
    }
  }

  // ===========================================================================================
  // Ghosts (afterimages)
  // ===========================================================================================
  function captureGhost(g) {
    g.pending = false;
    const a = g.actor; if (!a || !R.n) return;
    let n = 0;
    forActorCells(a, (i, ci, cj, k) => {
      if (n >= SCR_N) return;
      scrCi[n] = ci; scrCj[n] = cj; scrG[n] = R.glyph[i]; const o = i * 3;
      scrS[n] = R.col[o] * 0.3 + R.col[o + 1] * 0.55 + R.col[o + 2] * 0.15; scrK[n] = k; n++;
    });
    g.n = n; g.ci = scrCi.slice(0, n); g.cj = scrCj.slice(0, n); g.g = scrG.slice(0, n); g.l = scrS.slice(0, n); g.k = scrK.slice(0, n);
    g.t = 0; g.skip = true; // don't draw over the live actor this frame
  }
  const GHOST_THIN = G(" .:;+=");
  function drawGhost(g) {
    if (g.skip) { g.skip = false; return; }
    const a = 1 - g.t / g.dur; if (a <= 0) return;
    const tr = g.tint[0], tg = g.tint[1], tb = g.tint[2];
    for (let k = 0; k < g.n; k++) {
      const i = R.idx(g.ci[k], g.cj[k]); if (i < 0) continue;
      const h = hash(g.ci[k] * 3, g.cj[k] * 7);
      if (h > a * 1.15) continue;
      const l = Math.min(1.2, g.l[k]);
      const b = (0.25 + l * 0.75) * a * 0.85;
      const glyph = a > 0.55 ? g.g[k] : GHOST_THIN[Math.max(1, Math.min(GHOST_THIN.length - 1, (l * a * 2 * GHOST_THIN.length) | 0))];
      if (R.setI(i, glyph, tr * b, tg * b, tb * b, g.k[k] - 0.7, F_UNLIT)) R.emitI(i, tr * 0.06 * a, tg * 0.06 * a, tb * 0.06 * a);
    }
  }

  // ===========================================================================================
  // Decals
  // ===========================================================================================
  function makeDecal(x, y, kind, r, life) {
    const D = DECALS[kind] || DECALS.scorch;
    const seed = (rand() * 9973) | 0;
    let n = 0;
    const add = (ci, cj, g, cr, cg, cb, sh) => {
      if (n >= SCR_N) return;
      scrCi[n] = ci; scrCj[n] = cj; scrG[n] = g; scrC[n * 3] = cr; scrC[n * 3 + 1] = cg; scrC[n * 3 + 2] = cb; scrS[n] = sh; scrK[n] = hash(ci * 13 + seed, cj * 7); n++;
    };
    const c = D.c, gs = D.g, gl = gs.length;
    if (kind === 'crack') {
      const nl = 3 + ((rand() * 3) | 0);
      for (let l = 0; l < nl; l++) {
        const ln = buildLine(x, y, rand() * TAU, 0, r * rr(0.6, 1.2), 1.6);
        let last = -1;
        for (let s = 0; s <= ln.n; s++) {
          const ci = Math.floor(ln.pts[s * 2] / CW), cj = Math.floor((ln.pts[s * 2 + 1] * TILT) / CH), key = ci * 100003 + cj;
          if (key === last) continue; last = key;
          const v = 0.7 + 0.5 * rand(), u = s / ln.n;
          add(ci, cj, gs[(rand() * gl) | 0], c[0] * v, c[1] * v, c[2] * v, D.shade * (1 - u * 0.6));
        }
      }
    } else {
      const R0 = r * 1.15;
      const ci0 = Math.floor((x - R0) / CW), ci1 = Math.floor((x + R0) / CW), cj0 = Math.floor(((y - R0) * TILT) / CH), cj1 = Math.floor(((y + R0) * TILT) / CH);
      for (let cj = cj0; cj <= cj1; cj++) {
        const wy = ((cj + 0.5) * CH) / TILT;
        for (let ci = ci0; ci <= ci1; ci++) {
          const wx = (ci + 0.5) * CW, u = Math.hypot(wx - x, wy - y) / r;
          const edge = 0.75 + 0.4 * hash(ci * 3 + seed, cj * 5 + 1);
          if (u > edge) continue;
          const h = hash(ci + seed * 7, cj * 11 + seed);
          const dens = D.dens * (1 - u * u * 0.55);
          const v = 0.65 + 0.6 * hash(ci * 17, cj * 3 + seed);
          add(ci, cj, h < dens ? gs[((h / Math.max(1e-3, dens)) * gl) | 0] : 0, c[0] * v, c[1] * v, c[2] * v, D.shade * (1 - u * 0.7));
        }
      }
      if (kind === 'blood' || kind === 'rot') { // satellite droplets
        const nd = 3 + ((rand() * 5) | 0);
        for (let k = 0; k < nd; k++) {
          const ang = rand() * TAU, dd = r * rr(1.05, 2.0), dx = x + Math.cos(ang) * dd, dy = y + Math.sin(ang) * dd;
          add(Math.floor(dx / CW), Math.floor((dy * TILT) / CH), gs[(rand() * gl) | 0], c[0] * 0.9, c[1] * 0.9, c[2] * 0.9, D.shade * 0.4);
          if (rand() < 0.5) add(Math.floor(dx / CW) + (rand() < 0.5 ? 1 : -1), Math.floor((dy * TILT) / CH), GL.dot, c[0] * 0.7, c[1] * 0.7, c[2] * 0.7, 0);
        }
      }
    }
    if (!n) return null;
    return {
      x, y, r, kind, D, t: 0, life,
      n, ci: scrCi.slice(0, n), cj: scrCj.slice(0, n), g: scrG.slice(0, n), c: scrC.slice(0, n * 3), sh: scrS.slice(0, n), h: scrK.slice(0, n),
    };
  }
  function drawDecals() {
    if (!decals.length) return;
    const shd = R.shd;
    for (const d of decals) {
      if (!R.inViewWorld(d.x, d.y, d.r * 2.2 + 20)) continue;
      const fo = d.life * 0.65;
      const a = Math.min(1, d.t / 0.12) * (d.t > fo ? Math.max(0, 1 - (d.t - fo) / (d.life - fo)) : 1);
      if (a <= 0) continue;
      const D = d.D, glowK = D.glowT ? Math.max(0, 1 - d.t / D.glowT) : 0, em = D.emis || 0, gc = D.glow;
      for (let k = 0; k < d.n; k++) {
        if (d.h[k] > a) continue;
        const i = R.idx(d.ci[k], d.cj[k]); if (i < 0) continue;
        const sh = d.sh[k]; if (sh > 0) shd[i] = Math.min(1, shd[i] + sh * a);
        const g = d.g[k]; if (!g) continue;
        const o = k * 3;
        R.setI(i, g, d.c[o], d.c[o + 1], d.c[o + 2], KEY_DECAL + 2, F_GROUND);
        if (em) R.emitI(i, d.c[o] * em * a, d.c[o + 1] * em * a, d.c[o + 2] * em * a);
        if (glowK > 0 && d.h[k] < 0.35 * glowK) { const f = glowK * (0.6 + 0.4 * Math.sin(FX.t * 9 + k)); R.emitI(i, gc[0] * 0.35 * f, gc[1] * 0.35 * f, gc[2] * 0.35 * f); }
      }
    }
  }

  // ===========================================================================================
  // Projectile looks (by p.look)
  // ===========================================================================================
  // FX keeps its own longer, evenly spaced trail per projectile (combat's p.trail is only 10 points)
  const TRAIL_N = 18, TRAIL_STEP = 7;
  function trailDots(p, c, every, g0, g1, k0) {
    let T = p._fxTrail;
    if (!T) { T = p._fxTrail = new Float32Array(TRAIL_N * 3); p._fxTn = 0; p._fxTh = 0; }
    // record a point whenever the projectile has moved TRAIL_STEP since the last one
    const hi = ((p._fxTh - 1 + TRAIL_N) % TRAIL_N) * 3;
    if (!p._fxTn || Math.hypot(p.x - T[hi], p.y - T[hi + 1]) >= TRAIL_STEP) {
      const w = p._fxTh * 3; T[w] = p.x; T[w + 1] = p.y; T[w + 2] = p.z;
      p._fxTh = (p._fxTh + 1) % TRAIL_N; if (p._fxTn < TRAIL_N) p._fxTn++;
    }
    const n = p._fxTn, kk = k0 || 1;
    for (let m = 1; m < n; m++) {
      if (every > 1 && (m % every)) continue;
      const j = ((p._fxTh - 1 - m + TRAIL_N * 2) % TRAIL_N) * 3;
      const f = 1 - m / TRAIL_N, b = f * kk;
      const x = T[j], y = T[j + 1], z = T[j + 2];
      const i = R.idxP(x, y * TILT - z);
      const g = f > 0.55 ? g0 : g1;
      if (R.setI(i, g, c[0] * b, c[1] * b, c[2] * b, y + 0.4, F_UNLIT)) R.emitI(i, c[0] * 0.4 * b, c[1] * 0.4 * b, c[2] * 0.4 * b);
    }
  }
  function emitFrom(p, preset, rate, opts) {
    const dt = gameDt(); if (dt <= 0) return;
    p._fxAcc = (p._fxAcc || 0) + rate * dt;
    let guard = 8;
    while (p._fxAcc >= 1 && guard--) {
      p._fxAcc -= 1;
      const i = spawnP(PRE_ID[preset], p.x + rr(-2, 2), p.y + rr(-2, 2), Math.max(0, p.z + rr(-2, 2)), -p.vx * 0.08 + rr(-15, 15), -p.vy * 0.08 + rr(-15, 15), rr(-5, 25), opts && opts.life ? rr(opts.life[0], opts.life[1]) : rr(0.25, 0.6));
      if (opts && opts.color) setColor(i, opts.color);
    }
    if (p._fxAcc > 1) p._fxAcc = 0;
  }
  function orb(p, core, mid, haloC, rad, glyph) {
    const X = p.x, Y = p.y * TILT - p.z, key = p.y + 2;
    R.glowGlyph(X, Y, glyph || GL.at, core[0], core[1], core[2], key, 1.1);
    R.glowGlyph(X - CW, Y, GL.lp, mid[0], mid[1], mid[2], key - 0.1, 0.6);
    R.glowGlyph(X + CW, Y, GL.rp, mid[0], mid[1], mid[2], key - 0.1, 0.6);
    R.glowGlyph(X, Y - CH * 0.9, GL.us, mid[0] * 0.6, mid[1] * 0.6, mid[2] * 0.6, key - 0.1, 0.4);
    halo(X, Y, rad, haloC[0], haloC[1], haloC[2]);
  }
  const FB = { core: [2.8, 2.5, 1.8], mid: [2.0, 1.0, 0.28], halo: [0.85, 0.36, 0.08], trail: [1.9, 1.3, 0.5] };
  const WF = { core: [1.8, 2.8, 1.6], mid: [0.6, 2.0, 0.6], halo: [0.2, 0.8, 0.25], trail: [0.9, 2.0, 0.8] };
  const LOOKS = {
    fireball(p) {
      const s = p.scale || 1;
      orb(p, FB.core, FB.mid, FB.halo, 15 * s);
      trailDots(p, FB.trail, 1, GL.apos, GL.dot, 1.1);
      emitFrom(p, 'ember', 45 * s);
      if (!p.light) R.light(p.x, p.y, p.z, 85 * s, 1, 0.48, 0.14, 1.25 + 0.15 * Math.sin(FX.t * 31 + p.id));
    },
    witchfire(p) {
      orb(p, WF.core, WF.mid, WF.halo, 14);
      trailDots(p, WF.trail, 1, GL.apos, GL.dot, 1.1);
      emitFrom(p, 'witchfire', 40);
      if (!p.light) R.light(p.x, p.y, p.z, 80, 0.35, 1, 0.4, 1.1);
    },
    ember(p) {
      const X = p.x, Y = p.y * TILT - p.z;
      R.glowGlyph(X, Y, GL.star, 2.4, 1.3, 0.4, p.y + 2, 0.9);
      halo(X, Y, 8, 0.5, 0.2, 0.04);
      trailDots(p, [1.4, 0.6, 0.15], 3, GL.dot, GL.dot, 0.8);
      emitFrom(p, 'ember', 18);
      if (!p.light) R.light(p.x, p.y, p.z, 45, 1, 0.5, 0.15, 0.7);
    },
    arrow(p) {
      const vx = p.vx, vy = p.vy * TILT - (p.vz || 0), l = Math.hypot(vx, vy) || 1, ux = vx / l, uy = vy / l;
      const X = p.x, Y = p.y * TILT - p.z, key = p.y + 2;
      const c = isTinted(p.color) ? p.color : [0.82, 0.74, 0.58];
      R.seg(X - ux * 14, Y - uy * 14, X - ux * 2, Y - uy * 2, null, c[0] * 0.8, c[1] * 0.8, c[2] * 0.8, key, 0);
      const head = Math.abs(ux) > Math.abs(uy) * 1.4 ? (ux > 0 ? GL.gt : GL.lt) : (uy > 0 ? GL.v : GL.caret);
      R.set(X, Y, head, 0.95, 0.95, 1, key + 0.01, 0);
      R.set(X - ux * 16, Y - uy * 16, GL.dq, 0.6, 0.55, 0.5, key - 0.01, 0); // fletching
      trailDots(p, [0.4, 0.42, 0.5], 3, GL.dot, GL.dot, 0.6);
    },
    bolt(p) {
      const c = p.color || [1, 1, 1], X = p.x, Y = p.y * TILT - p.z;
      R.glowGlyph(X, Y, GL.star, c[0] * 1.8, c[1] * 1.8, c[2] * 1.8, p.y + 2, 1);
      halo(X, Y, 10, c[0] * 0.35, c[1] * 0.35, c[2] * 0.35);
      trailDots(p, [c[0] * 1.2, c[1] * 1.2, c[2] * 1.2], 2, GL.plus, GL.dot, 0.9);
      if (!p.light) R.light(p.x, p.y, p.z, 50, Math.min(1, c[0]), Math.min(1, c[1]), Math.min(1, c[2]), 0.7);
    },
    ice(p) {
      const X = p.x, Y = p.y * TILT - p.z, key = p.y + 2;
      const ux = p.vx, uy = p.vy * TILT, l = Math.hypot(ux, uy) || 1;
      R.glowGlyph(X, Y, GL.star, 1.9, 2.3, 2.7, key, 1);
      R.glowGlyph(X - (ux / l) * CW, Y - (uy / l) * CH * 0.6, R.dirGlyph(ux, uy), 1.0, 1.4, 1.9, key - 0.1, 0.6);
      halo(X, Y, 10, 0.25, 0.4, 0.6);
      trailDots(p, [0.9, 1.3, 1.8], 2, GL.apos, GL.dot, 0.9);
      emitFrom(p, 'snow', 20, { life: [0.3, 0.7] });
      if (!p.light) R.light(p.x, p.y, p.z, 55, 0.5, 0.8, 1, 0.7);
    },
    poison(p) {
      const X = p.x, Y = p.y * TILT - p.z, key = p.y + 2, wob = Math.sin(FX.t * 20 + p.id) > 0;
      R.glowGlyph(X, Y, wob ? GL.O : GL.at, 0.9, 2.2, 0.5, key, 1);
      R.glowGlyph(X - CW, Y, GL.o, 0.4, 1.4, 0.3, key - 0.1, 0.5);
      R.glowGlyph(X + CW, Y, GL.o, 0.4, 1.4, 0.3, key - 0.1, 0.5);
      halo(X, Y, 13, 0.18, 0.6, 0.12);
      trailDots(p, [0.4, 1.4, 0.3], 2, GL.o, GL.dot, 0.8);
      emitFrom(p, 'poison', 26);
      if (!p.light) R.light(p.x, p.y, p.z, 60, 0.4, 1, 0.3, 0.8);
    },
    shadow(p) {
      const X = p.x, Y = p.y * TILT - p.z, key = p.y + 2;
      R.glowGlyph(X, Y, GL.at, 1.2, 0.5, 1.7, key, 0.8);
      for (const [ox, oy, g] of SHADOW_RING) R.glowGlyph(X + ox, Y + oy, g, 0.35, 0.1, 0.55, key - 0.1, 0.3);
      R.shadowEllipse(p.x, p.y, 14, 10, 0.35);
      trailDots(p, [0.5, 0.2, 0.8], 2, GL.pct, GL.colon, 0.8);
      emitFrom(p, 'shadow', 28);
      if (!p.light) R.light(p.x, p.y, p.z, 45, 0.5, 0.2, 0.9, 0.5);
    },
    bone(p) {
      const X = p.x, Y = p.y * TILT - p.z, key = p.y + 2;
      const ph = ((FX.t * 16 + p.id) | 0) & 3, e = BONE_ENDS[ph];
      R.set(X, Y, e[2], 0.95, 0.92, 0.82, key, 0);
      R.set(X + e[0], Y + e[1], GL.o, 0.85, 0.82, 0.72, key - 0.1, 0);
      R.set(X - e[0], Y - e[1], GL.apos, 0.85, 0.82, 0.72, key - 0.1, 0);
      R.shadowEllipse(p.x, p.y, 5, 3, 0.4);
      trailDots(p, [0.45, 0.43, 0.4], 3, GL.dot, GL.dot, 0.6);
    },
    sonic(p) {
      const ang = Math.atan2(p.vy, p.vx);
      const c = isTinted(p.color) ? p.color : [1.4, 0.55, 1.6];
      const pul = 0.75 + 0.25 * Math.sin(FX.t * 40 + p.id);
      for (let k = 0; k < 3; k++) {
        const rad = 8 + k * 6, back = k * 7, b = (1 - k * 0.28) * pul;
        for (let s = -4; s <= 4; s++) {
          const th = ang + s * 0.22;
          const wx = p.x - Math.cos(ang) * back + Math.cos(th) * rad * 0.6, wy = p.y - Math.sin(ang) * back + Math.sin(th) * rad * 0.6;
          const tx = -Math.sin(th), ty = Math.cos(th) * TILT;
          R.glowGlyph(wx, wy * TILT - p.z, R.dirGlyph(tx, ty), c[0] * b, c[1] * b, c[2] * b, wy + 2, 0.6);
        }
      }
      if (!p.light) R.light(p.x, p.y, p.z, 60, 0.9, 0.4, 1, 0.6);
    },
    lemon(p) {
      const X = p.x, Y = p.y * TILT - p.z, key = p.y + 2;
      R.glowGlyph(X, Y, GL.O, 2.2, 2.0, 0.45, key, 0.9);
      R.glowGlyph(X - CW, Y, GL.lp, 1.6, 1.5, 0.3, key - 0.1, 0.4);
      R.glowGlyph(X + CW, Y, GL.rp, 1.6, 1.5, 0.3, key - 0.1, 0.4);
      halo(X, Y, 12, 0.5, 0.45, 0.06);
      trailDots(p, [1.4, 1.35, 0.3], 2, GL.apos, GL.dot, 0.8);
      emitFrom(p, 'glint', 14, { color: [1.8, 1.7, 0.4] });
      if (!p.light) R.light(p.x, p.y, p.z, 60, 1, 0.95, 0.35, 0.8);
    },
    sugar(p) {
      const X = p.x, Y = p.y * TILT - p.z, key = p.y + 2;
      const g = ((FX.t * 12 + p.id) | 0) & 1 ? GL.star : GL.x;
      R.glowGlyph(X, Y, g, 2.2, 1.2, 1.7, key, 0.9);
      halo(X, Y, 10, 0.5, 0.2, 0.35);
      trailDots(p, [1.6, 0.7, 1.1], 2, GL.plus, GL.dot, 0.8);
      emitFrom(p, 'sugar', 16);
      if (!p.light) R.light(p.x, p.y, p.z, 50, 1, 0.5, 0.8, 0.6);
    },
    bat(p) {
      const X = p.x, Y = p.y * TILT - p.z, key = p.y + 2, up = ((FX.t * 14 + p.id) | 0) & 1;
      R.set(X, Y, GL.o, 0.45, 0.2, 0.3, key, 0);
      R.set(X - CW, Y - (up ? 2 : -2), up ? GL.caret : GL.v, 0.5, 0.22, 0.35, key, 0);
      R.set(X + CW, Y - (up ? 2 : -2), up ? GL.caret : GL.v, 0.5, 0.22, 0.35, key, 0);
      R.emit(X, Y, 0.35, 0.02, 0.04); // red eyes
      R.shadowEllipse(p.x, p.y, 6, 4, 0.35);
    },
  };
  function isTinted(c) { return !!c && !(c[0] === 1 && c[1] === 1 && c[2] === 1); }
  const BONE_ENDS = [[CW, 0, GL.dash], [CW, CH, GL.bslash], [0, CH, GL.bar], [-CW, CH, GL.slash]];
  const SHADOW_RING = [[-CW, 0, GL.pct], [CW, 0, GL.pct], [0, -CH, GL.colon], [0, CH, GL.colon], [-CW, -CH, GL.dot], [CW, CH, GL.dot]];

  // ===========================================================================================
  // Zone looks (by z.kind) — a = fade 0..1
  // ===========================================================================================
  function zoneEmit(z, preset, rate, zmax, color) {
    const dt = gameDt(); if (dt <= 0) return;
    z._fxAcc = (z._fxAcc || 0) + rate * dt;
    let guard = 10;
    while (z._fxAcc >= 1 && guard--) {
      z._fxAcc -= 1;
      const ang = rand() * TAU, d = Math.sqrt(rand()) * z.r * 0.95;
      const i = spawnP(PRE_ID[preset], z.x + Math.cos(ang) * d, z.y + Math.sin(ang) * d, rand() * (zmax || 4), rr(-6, 6), rr(-4, 4), rr(PRE[PRE_ID[preset]].up[0], PRE[PRE_ID[preset]].up[1]), rr(PRE[PRE_ID[preset]].lf[0], PRE[PRE_ID[preset]].lf[1]));
      if (color) setColor(i, color);
    }
    if (z._fxAcc > 1) z._fxAcc = 0;
  }
  function fireField(z, a, hot, mid, deep, lightC, preset) {
    const t = FX.t, jf = (t * 9) | 0;
    R.ellipse(z.x, z.y, z.r, z.r, (i, u, ci, cj) => {
      const h = hash(ci, cj), h2 = hash(ci + jf * 7, cj - jf);
      const dens = 0.5 * (1 - u * u) * a;
      const e = (1 - u) * 0.12 * a;
      R.emitI(i, deep[0] * e, deep[1] * e, deep[2] * e);
      if (h2 < dens) {
        const f = 0.55 + 0.45 * h;
        const g = RAMP.flame[((h + h2) * RAMP.flame.length) % RAMP.flame.length | 0];
        const c = h2 < dens * 0.35 ? hot : mid;
        if (R.setI(i, g, c[0] * f, c[1] * f, c[2] * f, KEY_TELE + 0.12, F_UNLIT)) R.emitI(i, c[0] * 0.3 * f, c[1] * 0.3 * f, c[2] * 0.3 * f);
        if (h2 < dens * 0.18 && u < 0.85) { // tongue rising above the cell
          const wy = ((cj + 0.5) * CH) / TILT;
          R.glowGlyph((ci + 0.5) * CW, (cj + 0.5) * CH - CH, h > 0.5 ? GL.caret : GL.apos, mid[0] * 0.9, mid[1] * 0.9, mid[2] * 0.9, wy + 1, 0.5);
        }
      }
    });
    R.light(z.x, z.y, 0, z.r * 1.7 + 20, lightC[0], lightC[1], lightC[2], (0.85 + 0.15 * Math.sin(t * 23 + z.id)) * a);
    zoneEmit(z, preset, z.r * 0.5 * a, 6);
  }
  const RING_HOT = [2.4, 1.85, 0.85], RING_ORG = [1.8, 0.72, 0.17], RING_G = G("*+o*'+*o.");
  const ZONES = {
    fire(z, a) { fireField(z, a, [2.5, 2.0, 1.0], [1.8, 0.7, 0.16], [1, 0.3, 0.05], [1, 0.45, 0.12], 'ember'); },
    witchfire(z, a) { fireField(z, a, [1.6, 2.7, 1.4], [0.45, 1.8, 0.45], [0.1, 0.8, 0.2], [0.35, 1, 0.4], 'witchfire'); },
    poison(z, a) {
      const t = FX.t;
      const c = z.color || [0.38, 1.0, 0.26];
      R.ellipse(z.x, z.y, z.r, z.r, (i, u, ci, cj) => {
        const h = hash(ci, cj);
        const ph = h * 6.3 + t * (0.6 + h * 0.8);
        const v = Math.sin(ph) * 0.5 + 0.5;
        const dens = 0.56 * (1 - u * u * 0.8) * a;
        R.emitI(i, c[0] * 0.04 * a * (1 - u), c[1] * 0.07 * a * (1 - u), c[2] * 0.04 * a * (1 - u));
        if (h < dens) {
          const g = RAMP.cloud[((h * 50 + t * 1.3) | 0) % RAMP.cloud.length];
          const b = (0.55 + 0.6 * v) * (1 - u * 0.35);
          if (R.setI(i, g, c[0] * b, c[1] * b, c[2] * b, KEY_TELE + 0.11, F_UNLIT)) R.emitI(i, c[0] * 0.2 * b, c[1] * 0.2 * b, c[2] * 0.2 * b);
        }
      });
      R.light(z.x, z.y, 0, z.r * 1.4, c[0] * 0.6, c[1] * 0.8, c[2] * 0.5, 0.55 * a);
      zoneEmit(z, 'poison', z.r * 0.2 * a, 10);
    },
    rot(z, a) {
      const t = FX.t;
      R.ellipse(z.x, z.y, z.r, z.r * 0.92, (i, u, ci, cj) => {
        const h = hash(ci, cj);
        if (u > 0.82 + 0.18 * h) return;
        const bub = Math.sin(h * 40 + t * 3) > 0.93;
        const g = bub ? GL.O : RAMP.pool[((h * 31 + t * 0.7 + ci * 0.2) | 0) % RAMP.pool.length];
        const b = (0.5 + 0.4 * h) * a * (bub ? 1.6 : 1);
        R.setI(i, g, 0.72 * b, 0.22 * b, 0.46 * b, KEY_TELE + 0.11, 0);
        R.emitI(i, 0.04 * a, 0.01 * a, 0.03 * a);
        R.shd[i] = Math.min(1, R.shd[i] + 0.2 * a);
      });
      R.light(z.x, z.y, 0, z.r * 1.2, 0.8, 0.3, 0.6, 0.35 * a);
      zoneEmit(z, 'rot', z.r * 0.08 * a, 6);
    },
    ice(z, a) {
      const t = FX.t;
      R.ellipse(z.x, z.y, z.r, z.r, (i, u, ci, cj) => {
        const h = hash(ci, cj); if (h > 0.6 * (1 - u * 0.5)) return;
        const tw = Math.sin(h * 70 + t * 4) > 0.75 ? 1.8 : 1;
        const g = RAMP.frost[(h * 97 | 0) % RAMP.frost.length], b = (0.5 + 0.5 * h) * a * tw;
        if (R.setI(i, g, 0.65 * b, 0.85 * b, 1.15 * b, KEY_TELE + 0.11, tw > 1 ? F_UNLIT : 0) && tw > 1) R.emitI(i, 0.1, 0.15, 0.22);
      });
      R.light(z.x, z.y, 0, z.r * 1.3, 0.45, 0.7, 1, 0.4 * a);
      zoneEmit(z, 'snow', z.r * 0.1 * a, 18);
    },
    shadow(z, a) {
      const t = FX.t;
      R.ellipse(z.x, z.y, z.r, z.r, (i, u, ci, cj, ang) => {
        R.shd[i] = Math.min(1, R.shd[i] + 0.75 * (1 - u * u) * a);
        const sw = ((ang / TAU + u * 1.6 - t * 0.35) % 0.25 + 0.25) % 0.25;
        if (sw < 0.07 && hash(ci, cj) < 0.8) {
          const b = (1 - u) * a;
          if (R.setI(i, RAMP.swirl[(hash(cj, ci) * RAMP.swirl.length) | 0], 0.7 * b, 0.3 * b, 1.05 * b, KEY_TELE + 0.11, F_UNLIT)) R.emitI(i, 0.1 * b, 0.03 * b, 0.18 * b);
        }
      });
      zoneEmit(z, 'shadow', z.r * 0.12 * a, 6);
    },
    sugar(z, a) {
      const t = FX.t;
      R.ellipse(z.x, z.y, z.r, z.r, (i, u, ci, cj) => {
        const h = hash(ci, cj); if (h > 0.45 * (1 - u * 0.4)) return;
        const tw = 0.6 + 0.4 * Math.sin(h * 60 + t * 5);
        const g = RAMP.sparkle[(h * 71 | 0) % RAMP.sparkle.length], b = tw * a;
        if (R.setI(i, g, 1.4 * b, 0.6 * b, 1.0 * b, KEY_TELE + 0.11, F_UNLIT)) R.emitI(i, 0.12 * b, 0.05 * b, 0.09 * b);
      });
      R.light(z.x, z.y, 0, z.r * 1.2, 1, 0.5, 0.8, 0.35 * a);
      zoneEmit(z, 'sugar', z.r * 0.08 * a, 8);
    },
    // flickering ring of fire glyphs orbiting the caster; ground inside lit orange (reel: fx_fire_ring_aura)
    flamering(z, a) {
      const t = FX.t, rad = z.r || 70, n = Math.max(32, ((TAU * rad) / 3.4) | 0), jf = (t * 16) | 0, rot = t * 1.6;
      const fl = 0.9 + 0.1 * Math.sin(t * 27 + (z.id || 0));
      // main band: continuous, crisp; outer band: sparse licks that chase around the ring
      for (let band = 0; band < 3; band++) {
        const rb = rad + (band === 2 ? 6 : band ? -3 : 2.5);
        for (let s = 0; s < n; s++) {
          const th = (s / n) * TAU;
          const h = hash(s * 3 + band, jf + s);
          const orbit = 0.5 + 0.5 * Math.sin(th * 4 - rot * 3);
          if (band === 2 && h > 0.18 + 0.4 * orbit) continue;
          if (band === 1 && h > 0.35 + 0.5 * orbit) continue;
          const X = z.x + Math.cos(th) * rb, Y = z.y + Math.sin(th) * rb;
          const hot = !band && h < 0.3 + 0.35 * orbit;
          const c = hot ? RING_HOT : RING_ORG;
          const b = (0.65 + 0.45 * orbit) * a * fl * (band === 2 ? 0.85 : band ? 0.8 : 1);
          const g = band === 2 ? RAMP.flame[((h * 37) | 0) % RAMP.flame.length] : RING_G[((h * 53) | 0) % RING_G.length];
          R.glowGlyph(X, Y * TILT - (band === 2 ? 3 + h * 6 : 0), g, c[0] * b, c[1] * b, c[2] * b, Y + 0.5, 0.45);
        }
      }
      // light sits on the ring (brighter rim than centre), plus a soft fill inside
      for (let k = 0; k < 4; k++) { const th = (k / 4) * TAU + rot * 0.3; R.light(z.x + Math.cos(th) * rad, z.y + Math.sin(th) * rad, 0, rad * 0.85, 1, 0.45, 0.12, 0.45 * a * fl); }
      R.light(z.x, z.y, 0, rad * 1.7, 1, 0.42, 0.1, 0.38 * a * fl);
      // embers rise from the ring line
      const dt = gameDt();
      if (dt > 0) {
        z._fxRing = (z._fxRing || 0) + 30 * a * dt;
        while (z._fxRing >= 1) { z._fxRing -= 1; const th = rand() * TAU; spawnP(PRE_ID.ember, z.x + Math.cos(th) * rad, z.y + Math.sin(th) * rad, rr(0, 6), rr(-8, 8), rr(-6, 6), rr(30, 80), rr(0.4, 0.9)); }
      }
    },
    generic(z, a) {
      const c = z.color || [0.8, 0.8, 0.9], rad = z.r || 40, n = Math.max(16, ((TAU * rad) / 5) | 0);
      for (let s = 0; s < n; s++) {
        const th = (s / n) * TAU + FX.t * 0.5;
        R.glowGlyph(z.x + Math.cos(th) * rad, (z.y + Math.sin(th) * rad) * TILT, s & 1 ? GL.dot : GL.o, c[0] * 0.6 * a, c[1] * 0.6 * a, c[2] * 0.6 * a, KEY_TELE + 0.1, 0.3);
      }
    },
  };
  ZONES.flame = ZONES.fire; ZONES.lava = ZONES.fire; ZONES.frost = ZONES.ice; ZONES.void = ZONES.shadow; ZONES.flameRing = ZONES.flamering; ZONES.ring = ZONES.flamering;

  // ===========================================================================================
  // Event hooks (cosmetic only)
  // ===========================================================================================
  if (HM.Events && HM.Events.on) {
    HM.Events.on('levelup', (e) => {
      const p = (e && e.player) || (HM.Game && HM.Game.player); if (!p) return;
      FX.ring(p.x, p.y, 6, 80, 0.7, [2.0, 1.7, 0.7]);
      FX.ring(p.x, p.y, 4, 50, 0.5, [2.2, 2.0, 1.2], { glyph: '*' });
      FX.burst(p.x, p.y, 6, 'holy', 34, { r: 16, up: 1.7, life: 1.4 });
      FX.burst(p.x, p.y, 30, 'gold', 10, { speed: 0.6 });
      FX.light(p.x, p.y, 20, 160, [1, 0.85, 0.45], 1.8, 0.9);
    });
    HM.Events.on('floorStart', () => { lastRealT = HM.Game ? HM.Game.realT : 0; });
  }
})();
