// bosses.js — the five boss fights of Ooo (HM.Bosses).
//
// Shared framework (class Boss):
//   dormant → intro (banner, roar, boss music, slowmo, camera pull) → fight → phase gates at 66% / 33% → death.
//   * Pattern scheduler: weighted pick among patterns valid for the current phase / range / cooldown, never the same
//     pattern twice in a row. Patterns are generator functions; `yield s` waits s seconds of game time.
//   * Phase speed: b.spd = ×1.0 / ×1.25 / ×1.55 (Lich ×1.6 in phase 3). Waits use b.w(s) = s/spd, telegraphs use
//     b.tw(s) (never below TELE_MIN) — players get comfortable, then the hits come faster.
//   * Phase gates clamp damage at the threshold (a burst can't skip a phase), then a short invulnerable transition:
//     roar, flash, knockback shockwave (no damage), arena effect (def.onPhase).
//   * Telegraph → strike timing lives HERE (boss timers), never in FX callbacks, so damage stays fair whatever FX does.
//     Big hits are announced with HM.FX.telegraph; if FX is still a first-pass stub we draw our own dotted telegraphs.
//   * Boss-specific hazards (marching fire-orb lines, sonic / lava / Well rings, ice-spike & bone-wall lines, beams,
//     flame pillars, acid puddles, the closing ring of fire, frost floor, blizzard) are Combat zones with update/draw.
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M, R = HM.R, C = HM.Combat;
  const { CW, CH, TILT } = HM.cfg;
  const TAU = Math.PI * 2;

  const PHASE_SPEED = [1, 1.25, 1.55];
  const PHASE_AT = [0.66, 0.33];
  const TELE_MIN = 0.42;     // no telegraph is ever shorter than this
  const FRAME = 1e-4;        // `yield FRAME` → resume next frame

  // ------------------------------------------------------------------ small guarded helpers
  const fx = (name) => (HM.FX && typeof HM.FX[name] === 'function' ? HM.FX[name] : null);
  // First-pass FX stubs take no parameters; a real implementation names its arguments.
  const fxReal = (name) => { const f = fx(name); return !!(f && f.length > 0); };
  function callFx(name, ...a) { const f = fx(name); if (!f) return undefined; try { return f.apply(HM.FX, a); } catch (e) { console.error('[bosses] FX.' + name, e); return undefined; } }
  function sfx(name, o) { try { if (HM.Audio && HM.Audio.play) HM.Audio.play(name, o); } catch (e) { /* audio is optional */ } }
  function ui(name, ...a) { try { if (HM.UI && typeof HM.UI[name] === 'function') HM.UI[name](...a); } catch (e) { console.error('[bosses] UI.' + name, e); } }
  const bark = (a, text, dur) => { if (text) ui('bark', a, text, dur || 2.6); };
  const toast = (text, color, dur) => ui('toast', text, color || [0.9, 0.85, 0.75], dur || 3);
  const player = () => { const p = HM.Game && HM.Game.player; return p && !p.dead ? p : null; };
  const pick = (arr) => (arr && arr.length ? arr[Math.floor(HM.rng.next() * arr.length)] : null);
  const rnd = (a, b) => a + (b - a) * HM.rng.next();
  const solid = (x, y) => !!(HM.World && HM.World.isSolid && HM.World.isSolid(x, y));
  function shakeAt(x, y, n) { const p = player(); const d = p ? M.dist(x, y, p.x, p.y) : 0; callFx('shake', n * M.clamp(1.15 - d / 700, 0.2, 1)); }

  // ------------------------------------------------------------------ palette & glyphs
  const COL = {
    danger: [1, 0.22, 0.12], fire: [1, 0.48, 0.12], fireHot: [1.4, 1.05, 0.55], ember: [1, 0.35, 0.08],
    ice: [0.6, 0.85, 1], iceHot: [0.95, 1, 1.1], acid: [0.85, 0.95, 0.22], sonic: [1, 0.95, 0.6],
    witch: [0.32, 1, 0.42], witchHot: [0.75, 1.15, 0.7], bone: [0.86, 0.84, 0.74], dust: [0.7, 0.68, 0.6],
  };
  const g = (c) => R.gi(c);
  const GI = {
    dot: g('.'), comma: g(','), apos: g("'"), tick: g('`'), colon: g(':'), semi: g(';'), quote: g('"'), o: g('o'), O: g('O'),
    zero: g('0'), at: g('@'), hash: g('#'), star: g('*'), plus: g('+'), minus: g('-'), eq: g('='), tilde: g('~'),
    caret: g('^'), pipe: g('|'), bang: g('!'), lp: g('('), rp: g(')'), slash: g('/'), bslash: g('\\'), x: g('x'),
    deg: g('°'), mid: g('·'), sect: g('§'), cur: g('¤'), times: g('×'), div: g('÷'), I: g('I'), pct: g('%'), amp: g('&'),
  };
  const RAMP = { fire: R.ramp(" .'`^\"*+#@"), ice: R.ramp(" .'`:+*#%@"), bone: R.RAMPS.bone, witch: R.ramp(" .:o*O0@"), acid: R.ramp(" .,:oO0@") };
  const RUNES = [GI.sect, GI.cur, GI.times, GI.div, GI.plus, GI.x];
  // stable per-sample hashes (no per-cell hashing in hot loops)
  const HS = new Float32Array(512), HS2 = new Float32Array(512);
  for (let i = 0; i < 512; i++) { HS[i] = M.hash2(i, 911); HS2[i] = M.hash2(i * 7 + 3, 77); }
  const ih = (ci, cj) => ((((ci * 73856093) ^ (cj * 19349663)) >>> 0) & 1023) / 1024;  // cheap integer cell hash

  const _c = [0, 0, 0];
  function heatCol(h, out) { // 0..1 → dark red → orange → yellow-white (linear, >1 for bloom)
    out = out || _c;
    if (h < 0.5) { const k = h * 2; out[0] = 0.5 + 0.65 * k; out[1] = 0.07 + 0.36 * k; out[2] = 0.02 + 0.04 * k; }
    else { const k = (h - 0.5) * 2; out[0] = 1.15 + 0.35 * k; out[1] = 0.43 + 0.72 * k; out[2] = 0.06 + 0.55 * k; }
    return out;
  }
  function witchCol(h, out) {
    out = out || _c;
    out[0] = 0.08 + 0.6 * h * h; out[1] = 0.35 + 0.85 * h; out[2] = 0.12 + 0.5 * h * h;
    return out;
  }

  // emissive glyph (unlit, bloom), depth tested
  function put(px, py, gi, r, gg, b, key, emitK) {
    const i = R.idxP(px, py); if (i < 0) return false;
    if (!R.setI(i, gi, r, gg, b, key, R.F_UNLIT)) return false;
    if (emitK) R.emitI(i, r * emitK, gg * emitK, b * emitK);
    return true;
  }
  // soft emissive halo around a projected point (no glyph change)
  function halo(px, py, rad, col, k) {
    if (k <= 0.01) return;
    const ci0 = Math.floor((px - rad) / CW), ci1 = Math.floor((px + rad) / CW);
    const cj0 = Math.floor((py - rad) / CH), cj1 = Math.floor((py + rad) / CH);
    const inv = 1 / (rad * rad);
    for (let cj = cj0; cj <= cj1; cj++) {
      const dy = (cj + 0.5) * CH - py;
      for (let ci = ci0; ci <= ci1; ci++) {
        const dx = (ci + 0.5) * CW - px; const q = (dx * dx + dy * dy) * inv; if (q >= 1) continue;
        const i = R.idx(ci, cj); if (i < 0) continue;
        const f = (1 - q) * (1 - q) * k; R.emitI(i, col[0] * f, col[1] * f, col[2] * f);
      }
    }
  }

  // ------------------------------------------------------------------ damage helper
  // Damage every actor hostile to the monsters that passes `test`, at most once per `once` set.
  // Returns how many were actually hit (evasions don't count, but do consume `once` — you dodged that one).
  // Damage tags name the pattern that caused a hit ('pat:<name>') so balance harnesses can attribute damage taken;
  // CUR_PAT is set while a pattern step / timer / hazard update runs.
  let CUR_PAT = null;
  const patOf = (owner) => CUR_PAT || (owner && owner.main && owner.main.name) || 'bg';
  function hurt(owner, test, spec, once, cx, cy) {
    let n = 0;
    const list = C.actors();
    for (let k = 0; k < list.length; k++) {
      const a = list[k];
      if (!C.hostile(a, 1) || (once && once.has(a.id)) || !test(a)) continue;
      if (once) once.add(a.id);
      const s = Object.assign({ source: owner, canCrit: false }, typeof spec === 'function' ? spec(a) : spec);
      if (!s.tags) s.tags = ['boss', 'pat:' + patOf(owner)];
      if (s.dir === undefined) s.dir = M.angle(cx === undefined ? owner.x : cx, cy === undefined ? owner.y : cy, a.x, a.y);
      const r = C.damage(a, s);
      if (r && !r.evaded) n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ hazards = zones with custom update/draw
  const noDraw = () => {};
  function hazard(owner, o) {
    const z = C.zone(Object.assign({ team: 1, life: 5, tick: 1e9, kind: 'bossfx', tags: ['boss'], source: owner, owner }, o));
    if (!z.draw && z.kind === 'bossfx') z.draw = noDraw;
    z.pat = patOf(owner);
    if (z.update) { const up = z.update; z.update = (zz, dt) => { const prev = CUR_PAT; CUR_PAT = zz.pat; try { up(zz, dt); } finally { CUR_PAT = prev; } }; }
    if (z.onTick) { const ot = z.onTick; z.onTick = (zz, inside) => { const prev = CUR_PAT; CUR_PAT = zz.pat; try { ot(zz, inside); } finally { CUR_PAT = prev; } }; }
    if (owner && owner.hz) owner.hz.push(z);
    return z;
  }
  const fadeOf = (z, tail) => (z.dying ? M.clamp(z.life / 0.3, 0, 1) : M.clamp(z.life / (tail || 0.3), 0, 1));

  // ---- fallback telegraph (only when HM.FX.telegraph is a stub): dotted rims of `o .`, filling from the origin
  function fallbackTele(owner, o) {
    const z = hazard(owner, { x: o.x, y: o.y, r: o.r || o.len || 40, life: (o.dur || 0.6) + 0.1, tele: o, draw: drawTele });
    return { cancel() { z.dead = true; }, zone: z };
  }
  function drawTele(z) {
    const o = z.tele, dur = Math.max(0.05, o.dur || 0.6);
    const p = M.clamp(z.t / dur, 0, 1), c = o.color || COL.danger;
    const fade = z.dying ? M.clamp(z.life / 0.3, 0, 1) : 1;
    const pulse = 0.72 + 0.28 * Math.sin(z.t * 20);
    const key = R.KEY_DECAL + 3, sh = o.shape || 'circle';
    const lit = (i, gi, k) => { k *= fade * (0.5 + 0.5 * p); if (R.setI(i, gi, c[0] * k, c[1] * k, c[2] * k, key, R.F_UNLIT)) R.emitI(i, c[0] * k * 0.22, c[1] * k * 0.22, c[2] * k * 0.22); };
    if (sh === 'circle' || sh === 'ring') {
      const r = o.r || 40, rim = 1 - Math.min(0.45, (CW * 1.4) / r);
      R.ellipse(o.x, o.y, r, r, (i, u, ci, cj) => {
        if (u >= rim) lit(i, (ci + cj) & 1 ? GI.o : GI.dot, 0.9 * pulse);
        else if (sh === 'circle' && u <= p) { const front = p - u < 0.12; if (front) lit(i, GI.o, 0.95); else if (!((ci * 3 + cj) & 3)) lit(i, GI.dot, 0.42); }
      });
    } else if (sh === 'cone') {
      const r = o.r || o.len || 120, half = o.half || 0.5, ang = o.ang || 0;
      R.ellipse(o.x, o.y, r, r, (i, u, ci, cj, a) => {
        const da = Math.abs(M.angleDiff(ang, a)); if (da > half) return;
        const rim = u > 1 - (CW * 1.3) / r || (half - da) * u * r < CW * 1.1;
        if (rim) lit(i, (ci + cj) & 1 ? GI.o : GI.dot, 0.85 * pulse);
        else if (u <= p) { const front = p - u < 0.1; if (front) lit(i, GI.o, 0.95); else if (!((ci * 3 + cj) & 3)) lit(i, GI.dot, 0.4); }
      });
    } else { // line starts at (x, y); rect is centred on it (same as HM.FX)
      const len = o.len || 200, w = o.w || 24, ang = o.ang || 0;
      const ca = Math.cos(ang), sa = Math.sin(ang), nx = -sa, ny = ca;
      const ox = sh === 'rect' ? o.x - ca * len / 2 : o.x, oy = sh === 'rect' ? o.y - sa * len / 2 : o.y;
      const steps = Math.ceil(len / 4), wl = Math.max(1, Math.round(w / 6));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, along = t * len;
        for (let l = -wl; l <= wl; l++) {
          const off = (l / wl) * w * 0.5, x = ox + ca * along + nx * off, y = oy + sa * along + ny * off;
          const i = R.idxP(x, y * TILT); if (i < 0) continue;
          if (Math.abs(l) === wl) { if (s % 2 === 0) lit(i, (s >> 1) & 1 ? GI.dot : GI.o, 0.85 * pulse); }
          else if (t <= p) { if (p - t < 0.05) lit(i, GI.o, 0.95); else if (((s + l + 99) % 3) === 0) lit(i, GI.dot, 0.4); }
        }
      }
    }
  }

  // ---- fallback one-shot visuals (only used while the matching HM.FX function is a stub)
  function blast(owner, x, y, r, style) {
    if (fxReal('explosion')) { callFx('explosion', x, y, r, style === 'witch' ? 'witchfire' : style === 'acid' ? 'poison' : style || 'fire'); return; }
    hazard(owner, { x, y, r, life: 0.5, style: style || 'fire', update: null, draw: drawBlast });
  }
  function drawBlast(z) {
    const k = z.t / 0.5, rr = z.r * (0.25 + 0.95 * M.easeOutCubic(k)), fade = 1 - k;
    const n = Math.max(16, Math.ceil((TAU * rr) / 5));
    for (let s = 0; s < n; s++) {
      const a = (s / n) * TAU, x = z.x + Math.cos(a) * rr, y = z.y + Math.sin(a) * rr;
      const h = HS[s & 511];
      const c = z.style === 'ice' ? COL.iceHot : z.style === 'witch' ? witchCol(0.6 + 0.4 * h) : z.style === 'acid' ? COL.acid : heatCol(0.4 + 0.6 * h * fade);
      put(x, y * TILT - h * 10 * fade, h < 0.4 ? GI.star : h < 0.7 ? GI.apos : GI.dot, c[0] * fade, c[1] * fade, c[2] * fade, y, 0.5);
    }
    const lc = z.style === 'ice' ? COL.ice : z.style === 'witch' ? COL.witch : COL.fire;
    if (fade > 0.05) R.light(z.x, z.y, 10, z.r * 3, lc[0], lc[1], lc[2], 1.8 * fade);
    if (k < 0.35) halo(z.x, z.y * TILT - 8, z.r * 0.9, lc, 0.6 * (1 - k / 0.35));
  }
  function ringFx(owner, x, y, r0, r1, dur, col) {
    if (fxReal('ring')) { callFx('ring', x, y, r0, r1, dur, col); return; }
    wave(owner, { x, y, r0, r1, speed: (r1 - r0) / Math.max(0.1, dur), band: 14, style: 'flash', col });
  }
  function flashLight(owner, x, y, z, rad, col, k, dur) {
    if (fxReal('light')) { callFx('light', x, y, z, rad, col, k, dur); return; }
    hazard(owner, { x, y, r: rad, life: dur, draw: (h) => { const f = h.life / dur; R.light(x, y, z, rad, col[0], col[1], col[2], k * f * f); } });
  }

  // Overlapping ground zones must not stack: a target takes at most one tick per zone kind per T.zoneTick seconds
  // (shared with enemies.js fire zones through a._zoneTk).
  function zoneTickOk(a, key) {
    const t = HM.Game ? HM.Game.t : 0, m = a._zoneTk || (a._zoneTk = {});
    const last = m[key]; if (last !== undefined && t - last < Bosses.tuning.zoneTick && t >= last) return false;
    m[key] = t; return true;
  }
  // ---- elemental ground zones (fire / ice / witchfire). FX draws them by kind when it is real; else we do.
  function elemZone(owner, x, y, r, life, dps, kind, extra) {
    const type = kind === 'witchfire' ? 'shadow' : kind === 'ice' ? 'ice' : 'fire';
    const z = hazard(owner, Object.assign({
      x, y, r, life, kind, tick: 0.5, tags: ['boss', kind],
      draw: fxReal('drawZone') ? null : drawElemZone,
      onTick(zz, inside) {
        if (zz.dying) return;
        for (const a of inside) {
          if (!zoneTickOk(a, kind)) continue;
          C.damage(a, { amount: dps * 0.5, type, source: owner, canCrit: false, isDot: true, numColor: type, tags: ['zone', 'boss', 'pat:' + zz.pat],
            status: kind === 'fire' ? [{ id: 'burn', dur: 1.6, dps: dps * 0.25 }] : kind === 'ice' ? [{ id: 'chill', dur: 1.2 }] : null });
        }
      },
    }, extra || {}));
    return z;
  }
  function drawElemZone(z) {
    const fade = M.clamp(Math.min(z.t / 0.3, z.life / 0.5), 0, 1);
    const t = z.t, kind = z.kind, key = R.KEY_DECAL + 2;
    R.ellipse(z.x, z.y, z.r, z.r, (i, u, ci, cj) => {
      const h = ih(ci, cj); if (h > 0.62 - 0.25 * u) return;
      const fl = 0.5 + 0.5 * Math.sin(t * (4 + h * 7) + h * 40);
      let c, gi;
      if (kind === 'ice') { c = COL.ice; gi = fl > 0.7 ? GI.star : h < 0.2 ? GI.plus : GI.apos; }
      else if (kind === 'witchfire') { c = witchCol(0.3 + 0.7 * fl * (1 - u)); gi = fl > 0.75 ? GI.O : fl > 0.4 ? GI.o : GI.dot; }
      else { c = heatCol((0.25 + 0.75 * fl) * (1 - u * 0.6)); gi = fl > 0.8 ? GI.caret : fl > 0.5 ? GI.star : fl > 0.25 ? GI.apos : GI.dot; }
      const k = fade * (0.55 + 0.45 * fl);
      if (R.setI(i, gi, c[0] * k, c[1] * k, c[2] * k, key, R.F_UNLIT)) R.emitI(i, c[0] * k * 0.3, c[1] * k * 0.3, c[2] * k * 0.3);
    });
    const lc = kind === 'ice' ? COL.ice : kind === 'witchfire' ? COL.witch : COL.fire;
    R.light(z.x, z.y, 8, z.r * 2.4, lc[0], lc[1], lc[2], (kind === 'ice' ? 0.35 : 0.8) * fade * (0.85 + 0.15 * Math.sin(t * 11)));
  }

  // ---- acid lemon-juice puddle (Lemongrab): bubbling, sour, ticking poison
  function acidPuddle(owner, x, y, r, life, harmless) {
    return hazard(owner, {
      x, y, r, life, kind: 'acid', tick: 0.45, draw: drawAcid,
      onTick(z, inside) { if (harmless || z.dying || z.t < 0.2) return; for (const a of inside) if (zoneTickOk(a, 'acid')) C.damage(a, { amount: owner.D(0.16), type: 'poison', source: owner, canCrit: false, isDot: true, numColor: 'poison', tags: ['zone'] }); },
    });
  }
  function drawAcid(z) {
    const grow = M.clamp(z.t / 0.25, 0, 1), fade = M.clamp(z.life / 0.6, 0, 1) * (z.dying ? M.clamp(z.life / 0.3, 0, 1) : 1);
    const rr = z.r * (0.5 + 0.5 * M.easeOutBack(grow)), t = z.t, key = R.KEY_DECAL + 2;
    R.ellipse(z.x, z.y, rr, rr, (i, u, ci, cj) => {
      const h = ih(ci, cj);
      const bub = Math.sin(t * (2.5 + h * 3) + h * 30);
      let gi, k;
      if (u > 0.82) { gi = h < 0.5 ? GI.o : GI.dot; k = 0.75; }
      else if (bub > 0.82) { gi = bub > 0.95 ? GI.O : GI.o; k = 1; }
      else if (h < 0.45) { gi = h < 0.15 ? GI.comma : GI.dot; k = 0.45; }
      else return;
      k *= fade;
      const r0 = COL.acid[0] * k, g0 = COL.acid[1] * k, b0 = COL.acid[2] * k;
      if (R.setI(i, gi, r0, g0, b0, key, R.F_UNLIT)) R.emitI(i, r0 * 0.18, g0 * 0.2, b0 * 0.1);
    });
    R.light(z.x, z.y, 6, z.r * 2, 0.8, 0.95, 0.25, 0.35 * fade);
  }

  // ---- expanding ring (sonic shriek, lava wave, Well pulse, wing gust). Hits each actor once as the band passes;
  //      gaps [{a, h}] are safe openings. Dodge-roll i-frames pass straight through.
  const WSTYLE = {
    sonic: { col: [1, 0.95, 0.62], emit: 0.5, light: [1, 0.9, 0.5] },
    lava:  { col: null, emit: 0.65, light: [1, 0.42, 0.1] },
    witch: { col: null, emit: 0.7, light: [0.3, 1, 0.45] },
    gust:  { col: [0.72, 0.72, 0.66], emit: 0.06, light: null },
    flash: { col: null, emit: 0.5, light: null },
  };
  function wave(owner, o) {
    const r0 = o.r0 || 20, r1 = o.r1 || 500, sp = o.speed || 240;
    return hazard(owner, {
      x: o.x, y: o.y, r: r0, rr: r0, r1, speed: sp, band: o.band || 22, gaps: o.gaps || null, style: o.style || 'sonic',
      col: o.col || null, spec: o.dmg || null, once: new Set(), life: (r1 - r0) / sp + 0.25, update: updWave, draw: drawWave,
    });
  }
  function inGap(gaps, a) { if (!gaps) return false; for (let i = 0; i < gaps.length; i++) if (Math.abs(M.angleDiff(gaps[i].a, a)) < gaps[i].h) return true; return false; }
  function updWave(z, dt) {
    z.rr = Math.min(z.r1, z.rr + z.speed * dt); z.r = z.rr;
    if (z.rr >= z.r1 && !z.ending) { z.ending = true; z.life = Math.min(z.life, 0.22); }
    if (!z.spec || z.dying || z.ending) return;
    hurt(z.owner, (a) => {
      const d = M.dist(z.x, z.y, a.x, a.y);
      if (Math.abs(d - z.rr) > z.band * 0.5 + a.radius * 0.6) return false;
      return !inGap(z.gaps, M.angle(z.x, z.y, a.x, a.y));
    }, z.spec, z.once, z.x, z.y);
  }
  function drawWave(z) {
    const st = WSTYLE[z.style] || WSTYLE.sonic;
    const fade = (z.ending || z.dying) ? M.clamp(z.life / 0.22, 0, 1) : Math.min(1, z.t / 0.06 + 0.3);
    const rr = z.rr, n = Math.max(24, Math.ceil((TAU * rr) / 4)), tf = (z.t * 30) | 0;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU;
      if (z.gaps && inGap(z.gaps, a)) continue;
      const ca = Math.cos(a), sa = Math.sin(a);
      const x = z.x + ca * rr, y = z.y + sa * rr;
      if (!R.inViewWorld(x, y, 24)) continue;
      const h = HS[(k * 7 + tf) & 511], px = x, py = y * TILT;
      if (z.style === 'sonic') {
        const gi = Math.abs(ca) > 0.6 ? (ca > 0 ? GI.rp : GI.lp) : h < 0.5 ? GI.tilde : GI.minus;
        const c = st.col, kk = fade * (0.8 + 0.4 * h);
        put(px, py, gi, c[0] * kk, c[1] * kk, c[2] * kk, R.KEY_DECAL + 5, st.emit);
        const ix = z.x + ca * (rr - z.band * 0.45), iy = z.y + sa * (rr - z.band * 0.45);
        if (k & 1) put(ix, iy * TILT, h < 0.5 ? GI.o : GI.dot, c[0] * kk * 0.55, c[1] * kk * 0.55, c[2] * kk * 0.5, R.KEY_DECAL + 4, 0.25);
      } else if (z.style === 'lava') {
        const c = heatCol(0.55 + 0.45 * h), kk = fade;
        put(px, py, h < 0.3 ? GI.at : h < 0.65 ? GI.hash : GI.star, c[0] * kk, c[1] * kk, c[2] * kk, R.KEY_DECAL + 5, st.emit);
        const ix = z.x + ca * (rr - z.band * 0.5), iy = z.y + sa * (rr - z.band * 0.5);
        const c2 = heatCol(0.3 + 0.3 * h); put(ix, iy * TILT, h < 0.5 ? GI.caret : GI.apos, c2[0] * kk, c2[1] * kk, c2[2] * kk, R.KEY_DECAL + 4, 0.35);
        if (h > 0.55) { const c3 = heatCol(0.45 * h); put(px, py - CH, h > 0.8 ? GI.apos : GI.caret, c3[0] * kk, c3[1] * kk, c3[2] * kk, y + 0.2, 0.4); }
      } else if (z.style === 'witch') {
        const c = witchCol(0.55 + 0.45 * h), kk = fade;
        put(px, py, h < 0.3 ? GI.zero : h < 0.7 ? GI.O : GI.o, c[0] * kk, c[1] * kk, c[2] * kk, R.KEY_DECAL + 5, st.emit);
        const ix = z.x + ca * (rr - z.band * 0.5), iy = z.y + sa * (rr - z.band * 0.5);
        if (k & 1) { const c2 = witchCol(0.3 * h); put(ix, iy * TILT, GI.dot, c2[0] * kk, c2[1] * kk, c2[2] * kk, R.KEY_DECAL + 4, 0.3); }
        if (h > 0.7) { const c3 = witchCol(0.5); put(px, py - CH, GI.apos, c3[0] * kk, c3[1] * kk, c3[2] * kk, y + 0.2, 0.4); }
      } else if (z.style === 'gust') {
        if (k % 2) continue;
        const kk = fade * (0.6 + 0.4 * h), c = st.col;
        put(px, py, h < 0.5 ? GI.tilde : h < 0.8 ? GI.minus : GI.apos, c[0] * kk, c[1] * kk, c[2] * kk, R.KEY_DECAL + 5, 0.05);
      } else { // flash
        const c = z.col || COL.sonic, kk = fade * (0.6 + 0.4 * h);
        if (k % 2 === 0) put(px, py, h < 0.5 ? GI.o : GI.dot, c[0] * kk, c[1] * kk, c[2] * kk, R.KEY_DECAL + 5, 0.4);
      }
    }
    if (st.light && fade > 0.05) {
      const L = st.light, m = rr > 250 ? 10 : 6;
      for (let k = 0; k < m; k++) {
        const a = (k / m) * TAU + 0.3;
        if (z.gaps && inGap(z.gaps, a)) continue;
        R.light(z.x + Math.cos(a) * rr, z.y + Math.sin(a) * rr, 8, 90, L[0], L[1], L[2], 0.7 * fade);
      }
    }
  }

  // glowing orb of glyphs: '@' core, '0O' ring, 'o*' rim — ~5x3 cells at rad 11
  function orbBody(px, py, rad, key, witch, flick) {
    const ci0 = Math.floor((px - rad) / CW), ci1 = Math.floor((px + rad) / CW);
    const cj0 = Math.floor((py - rad) / CH), cj1 = Math.floor((py + rad) / CH);
    for (let cj = cj0; cj <= cj1; cj++) {
      const dy = ((cj + 0.5) * CH - py) / rad;
      for (let ci = ci0; ci <= ci1; ci++) {
        const dx = ((ci + 0.5) * CW - px) / rad, d = Math.sqrt(dx * dx + dy * dy * 0.75);
        if (d > 1.05) continue;
        const i = R.idx(ci, cj); if (i < 0) continue;
        const heat = (1 - d * 0.8) * flick;
        const c = witch ? witchCol(0.35 + 0.65 * heat) : heatCol(0.4 + 0.6 * heat);
        const gi = d < 0.3 ? GI.at : d < 0.62 ? (((ci + cj) & 1) ? GI.zero : GI.O) : d < 0.85 ? GI.o : ((ci + cj) & 1 ? GI.star : GI.apos);
        if (R.setI(i, gi, c[0], c[1], c[2], key, R.F_UNLIT)) R.emitI(i, c[0] * 0.45 * heat, c[1] * 0.45 * heat, c[2] * 0.45 * heat);
      }
    }
  }

  // ---- marching line of fire orbs (Bone Dragon; ref boss_dragon_phase3_fireline). A row spawns ~340u behind the
  //      player's side, warms up in place (the telegraph), then marches across the arena. One gap to slip through,
  //      and the orbs are small enough to roll through.
  function orbLine(owner, o) {
    const p = owner.tgt(), A = owner.arena;
    const dx = Math.cos(o.dir), dy = Math.sin(o.dir), nx = -dy, ny = dx;
    const back = o.back || 340;
    const sx = p.x - dx * back, sy = p.y - dy * back;
    const c = (A.x - sx) * nx + (A.y - sy) * ny;          // arena centre along the row
    const span = Math.max(A.rx, A.ry) + 90, spacing = o.spacing || 46;
    const gapC = o.gapOff !== undefined ? o.gapOff : rnd(70, 170) * (HM.rng.next() < 0.5 ? -1 : 1);
    const gapHalf = (o.gapW || 1.6) * spacing;
    const orbs = [];
    for (let s = c - span; s <= c + span; s += spacing) {
      if (Math.abs(s - gapC) < gapHalf) continue;
      orbs.push({ x: sx + nx * s, y: sy + ny * s, ph: HM.rng.next() * TAU, alive: true, s });
    }
    const travel = back + Math.max(A.rx, A.ry) + 260;
    sfx('fireball', { x: sx, y: sy, vol: 0.8 });
    return hazard(owner, {
      x: sx, y: sy, r: span, orbs, dx, dy, speed: o.speed || 100, warm: o.warm || 1, col: o.col || COL.fire, spacing,
      once: new Set(), life: (o.warm || 1) + travel / (o.speed || 100), spec: o.dmg || { amount: owner.D(0.95), type: 'fire', knock: 160, status: [{ id: 'burn', dur: 2.5, dps: owner.D(0.07) }] },
      update: updOrbs, draw: drawOrbs, witch: !!o.witch, emberT: 0,
    });
  }
  function updOrbs(z, dt) {
    const marching = z.t > z.warm;
    if (marching) { const s = z.speed * dt; for (const ob of z.orbs) { ob.x += z.dx * s; ob.y += z.dy * s; } }
    if (z.dying || !marching) return;
    const F = HM.Game && HM.Game.floor;
    for (const ob of z.orbs) {
      if (!ob.alive) continue;
      if (F && (ob.x < -60 || ob.y < -60 || ob.x > F.w + 60 || ob.y > F.h + 60)) { ob.alive = false; continue; }
      const once = ob.once || (ob.once = new Set());
      const n = hurt(z.owner, (a) => M.dist(ob.x, ob.y, a.x, a.y) <= 12 + a.radius, z.spec, once, ob.x, ob.y);
      if (n) { ob.alive = false; callFx('burst', ob.x, ob.y, 16, z.witch ? 'witchfire' : 'ember', 14); sfx('hit_fire', { x: ob.x, y: ob.y }); }
    }
    z.emberT -= dt;
    if (z.emberT <= 0 && z.orbs.length) { z.emberT = 0.07; const ob = z.orbs[(Math.random() * z.orbs.length) | 0]; if (ob.alive && R.inViewWorld(ob.x, ob.y, 0)) callFx('burst', ob.x, ob.y, 18, z.witch ? 'witchfire' : 'ember', 2); }
  }
  function drawOrbs(z) {
    const warmK = M.clamp(z.t / z.warm, 0, 1), fade = fadeOf(z, 0.5);
    const t = z.t, orbs = z.orbs, col = z.col;
    let prev = null;
    for (let i = 0; i < orbs.length; i++) {
      const ob = orbs[i];
      if (!ob.alive) { prev = null; continue; }
      if (!R.inViewWorld(ob.x, ob.y, 40)) { prev = null; continue; }
      const zz = 15 + Math.sin(t * 4 + ob.ph) * 3, px = ob.x, py = ob.y * TILT - zz;
      const s = (0.35 + 0.65 * M.easeOutBack(warmK)) * fade;
      const flick = 0.85 + 0.15 * Math.sin(t * 17 + ob.ph * 5);
      if (warmK < 1) { // warming: an ember knot that swells — the line-of-orbs telegraph
        const c = z.witch ? witchCol(0.5) : heatCol(0.45);
        put(px, py, warmK < 0.5 ? GI.star : GI.o, c[0], c[1], c[2], ob.y + 1, 0.6);
        halo(px, py, 12 + 10 * warmK, col, 0.35 * warmK);
      } else {
        orbBody(px, py, 11 * s, ob.y + 1, z.witch, flick);
        halo(px, py, 26 * s, col, 0.95 * s * flick);
      }
      R.light(ob.x, ob.y, zz, 78, col[0], col[1], col[2], 0.8 * s * flick);
      // crackling fire-line between neighbours
      if (prev && Math.abs(ob.s - prev.s) < z.spacing * 1.5 && warmK > 0.3) {
        const jx = (HS[(i * 13 + ((t * 24) | 0)) & 511] - 0.5) * 10, jy = (HS2[(i * 5 + ((t * 24) | 0)) & 511] - 0.5) * 8;
        const mx = (px + prev.px) / 2 + jx, my = (py + prev.py) / 2 + jy;
        const lc = z.witch ? witchCol(0.55) : heatCol(0.55);
        const k = 0.7 * fade;
        R.seg(prev.px, prev.py, mx, my, null, lc[0] * k, lc[1] * k, lc[2] * k, ob.y, R.F_UNLIT);
        R.seg(mx, my, px, py, null, lc[0] * k, lc[1] * k, lc[2] * k, ob.y, R.F_UNLIT);
      }
      ob.px = px; ob.py = py; prev = ob;
    }
  }

  // ---- falling meteor with a dotted landing ring
  function meteor(owner, x, y, o) {
    o = o || {};
    const r = o.r || 46, dur = o.dur || owner.tw(1.1), col = o.col || COL.fire;
    owner.tele({ shape: 'circle', x, y, r, dur, color: o.teleCol || [1, 0.4, 0.12] });
    hazard(owner, { x, y, r, life: dur + 0.02, dur, fall: Math.min(0.5, dur * 0.6), ox: o.ox !== undefined ? o.ox : 150, oz: 400, col, witch: !!o.witch, draw: drawMeteor });
    owner.later(dur, () => {
      hurt(owner, (a) => M.dist(x, y, a.x, a.y) <= r + a.radius * 0.6, { amount: owner.D(o.dmg || 1.3), type: o.type || 'fire', knock: 260, hitstop: 0.07, shake: 7, status: o.status || [{ id: 'burn', dur: 2.5, dps: owner.D(0.08) }] }, null, x, y);
      blast(owner, x, y, r * 1.05, o.witch ? 'witch' : 'fire');
      callFx('decal', x, y, o.witch ? 'witch' : 'scorch', r, 8);
      flashLight(owner, x, y, 20, r * 3.4, col, 2.2, 0.45);
      callFx('burst', x, y, 6, o.witch ? 'witchfire' : 'ember', 18);
      shakeAt(x, y, 5); sfx('explode', { x, y });
      if (o.zone) elemZone(owner, x, y, r * 0.65, o.zone, owner.D(0.35), o.witch ? 'witchfire' : 'fire');
    });
  }
  function drawMeteor(z) {
    const t0 = z.dur - z.fall; if (z.t < t0) return;
    const k = M.clamp((z.t - t0) / z.fall, 0, 1), e = k * k;
    for (let s = 6; s >= 0; s--) { // trail first, head last
      const ee = Math.max(0, e - s * 0.045);
      const x = z.x + z.ox * (1 - ee), zz = z.oz * (1 - ee), px = x, py = z.y * TILT - zz;
      if (s === 0) {
        orbBody(px, py, 12, z.y + 2, z.witch, 1.1);
        halo(px, py, 30, z.col, 0.75);
        R.light(x, z.y, zz, 120, z.col[0], z.col[1], z.col[2], 1.4);
      } else {
        const c = z.witch ? witchCol(1 - s / 7) : heatCol(1 - s / 7);
        put(px + (HS[(s * 31 + ((z.t * 30) | 0)) & 511] - 0.5) * 6, py, s < 3 ? GI.star : s < 5 ? GI.apos : GI.dot, c[0], c[1], c[2], z.y + 1, 0.6);
      }
    }
  }

  // ---- erupting spike sets (Ice King ice columns, Lich bone walls)
  function spikeSet(owner, pts, o) {
    const spikes = pts.map((pt) => ({ x: pt[0], y: pt[1], t0: pt[2], h: rnd(o.hMin || 28, o.hMax || 48), lean: rnd(-4, 4), up: false }));
    const last = spikes.reduce((m, s) => Math.max(m, s.t0), 0);
    return hazard(owner, { x: pts.length ? pts[0][0] : owner.x, y: pts.length ? pts[0][1] : owner.y, r: 30, spikes, o, once: new Set(), contactT: 0.5,
      life: last + (o.hold || 0.7) + (o.persist || 0) + 0.35, update: updSpikes, draw: drawSpikes });
  }
  function spikeLine(owner, o) {
    const n = Math.max(1, Math.floor(o.len / o.step)), ca = Math.cos(o.ang), sa = Math.sin(o.ang);
    const pts = [];
    for (let i = 1; i <= n; i++) {
      const d = i * o.step;
      if (o.gapFrom !== undefined && d > o.gapFrom && d < o.gapTo) continue;
      const j = rnd(-4, 4);
      pts.push([o.x + ca * d - sa * j, o.y + sa * d + ca * j, o.warn + i * o.delay]);
    }
    owner.tele({ shape: 'line', x: o.x, y: o.y, ang: o.ang, len: o.len, w: o.r * 2, dur: o.warn, color: o.color });
    return spikeSet(owner, pts, o);
  }
  function updSpikes(z, dt) {
    if (z.dying) return;
    const o = z.o; let erupted = 0;
    for (const s of z.spikes) {
      if (s.up || z.t < s.t0) continue;
      s.up = true; erupted++;
      if (o.spec) hurt(z.owner, (a) => M.dist(s.x, s.y, a.x, a.y) <= o.r + a.radius, o.spec, z.once, s.x, s.y);
      if (HM.rng.next() < 0.35) callFx('burst', s.x, s.y, 12, o.style === 'bone' ? 'bone' : 'ice', 4);
    }
    if (erupted) { z.sfxT = (z.sfxT || 0) - erupted; if (z.sfxT <= 0) { z.sfxT = 5; sfx(o.style === 'bone' ? 'bone_break' : 'ice', { x: z.spikes[0].x, y: z.spikes[0].y, vol: 0.7 }); } }
    // persistent bone walls bite whatever walks into them
    if (o.persist && o.contact) {
      z.contactT -= dt; if (z.contactT > 0) return; z.contactT = 0.4;
      const up = z.spikes.filter((s) => s.up && z.t - s.t0 < (o.hold || 0.7) + o.persist);
      if (!up.length) return;
      hurt(z.owner, (a) => up.some((s) => M.dist(s.x, s.y, a.x, a.y) <= o.r * 0.8 + a.radius), (a) => {
        let best = up[0], bd = 1e9; for (const s of up) { const d = M.dist(s.x, s.y, a.x, a.y); if (d < bd) { bd = d; best = s; } }
        return { amount: z.owner.D(o.contact), type: 'phys', knock: 280, dir: M.angle(best.x, best.y, a.x, a.y), hitstop: 0.03, shake: 3 };
      }, null);
    }
  }
  function drawSpikes(z) {
    const o = z.o, ice = o.style !== 'bone', life0 = (o.hold || 0.7) + (o.persist || 0);
    let lights = 0;
    for (const s of z.spikes) {
      if (!s.up) continue;
      const age = z.t - s.t0;
      let k = Math.min(1, age / 0.07);
      if (age > life0) k *= Math.max(0, 1 - (age - life0) / 0.25);
      if (z.dying) k *= M.clamp(z.life / 0.3, 0, 1);
      if (k <= 0.03 || !R.inViewWorld(s.x, s.y, 80)) continue;
      const h = s.h * (age < 0.07 ? M.easeOutBack(k) : k), bx = s.x, by = s.y * TILT;
      if (ice) {
        R.capsule(bx, by, bx + s.lean, by - h, 4.6, 0.9, s.y, s.y + 0.3, RAMP.ice, 0.72, 0.9, 1.05, R.F_UNLIT);
        R.capsule(bx - 5, by + 1, bx - 9, by - h * 0.42, 2.4, 0.6, s.y - 0.1, s.y, RAMP.ice, 0.55, 0.78, 1, R.F_UNLIT);
        R.capsule(bx + 5, by + 1, bx + 8, by - h * 0.36, 2.4, 0.6, s.y - 0.1, s.y, RAMP.ice, 0.55, 0.78, 1, R.F_UNLIT);
        R.glowGlyph(bx + s.lean, by - h, GI.star, 1.25, 1.35, 1.45, s.y + 0.5, 0.9);
        halo(bx, by - h * 0.5, 16, COL.ice, 0.3 * k);
        if ((lights++ & 3) === 0) R.light(s.x, s.y, h * 0.5, 70, 0.55, 0.8, 1, 0.55 * k);
      } else {
        R.capsule(bx, by, bx + s.lean, by - h, 3.6, 1.2, s.y, s.y + 0.3, RAMP.bone, COL.bone[0], COL.bone[1], COL.bone[2], 0);
        R.capsule(bx - 3, by, bx - 8, by - h * 0.55, 2.2, 0.8, s.y - 0.1, s.y, RAMP.bone, 0.75, 0.72, 0.64, 0);
        R.set(bx + s.lean, by - h, GI.caret, 0.95, 0.93, 0.85, s.y + 0.5, 0);
        R.shadowEllipse(s.x - 4, s.y + 3, 9, 5, 0.5 * k);
        if ((lights++ & 3) === 0) R.light(s.x, s.y, 10, 60, 0.3, 0.9, 0.4, 0.35 * k); // witchfire glints between the bones
      }
    }
  }

  // ---- beams (Ice King crown beam sweep; Lich soul-drain tracking beam)
  const BSTYLE = { ice: { core: [1.1, 1.2, 1.35], col: [0.55, 0.82, 1.1], light: [0.55, 0.8, 1] }, witch: { core: [0.8, 1.35, 0.8], col: [0.25, 1, 0.4], light: [0.3, 1, 0.45] } };
  function beam(owner, o) { return hazard(owner, { x: owner.x, y: owner.y, r: o.len, o, ang: o.ang0, once: new Set(), tickT: 0, life: o.dur, update: updBeam, draw: drawBeam, ex: owner.x, ey: owner.y }); }
  function updBeam(z, dt) {
    const b = z.owner, o = z.o;
    if (o.sweep) z.ang = o.ang0 + o.sweep * M.clamp(z.t / o.dur, 0, 1);
    else if (o.track) { const p = player(); if (p) { const want = M.angle(b.x, b.y, p.x, p.y); z.ang += M.clamp(M.angleDiff(z.ang, want), -o.turn * dt, o.turn * dt); } }
    if (!b.dead) { b.facing = z.ang; b.aim = z.ang; }
    const off = o.off || 0;
    z.x = b.x + Math.cos(z.ang) * off; z.y = b.y + Math.sin(z.ang) * off;
    z.ex = z.x + Math.cos(z.ang) * o.len; z.ey = z.y + Math.sin(z.ang) * o.len;
    if (z.dying || b.dead) return;
    z.tickT -= dt; if (z.tickT <= 0) { z.tickT = o.tick || 0.25; z.once.clear(); }
    const n = hurt(b, (a) => M.distToSeg(a.x, a.y, z.x, z.y, z.ex, z.ey) <= o.w * 0.5 + a.radius * 0.7, o.spec, z.once, z.x, z.y);
    if (n && o.drain && b.drainHeal) b.drainHeal(o.spec.amount * o.drain * n);
    z.sparkT = (z.sparkT || 0) - dt;
    if (z.sparkT <= 0) { z.sparkT = 0.06; callFx('burst', z.ex, z.ey, 10, o.style === 'witch' ? 'witchfire' : 'ice', 2); }
  }
  function drawBeam(z) {
    const o = z.o, st = BSTYLE[o.style] || BSTYLE.ice, b = z.owner;
    const fade = z.dying ? M.clamp(z.life / 0.3, 0, 1) : Math.min(1, z.t / 0.08) * Math.min(1, z.life / 0.15);
    const oz = o.z || b.height * 0.8, ez = 10;
    const px0 = z.x, py0 = z.y * TILT - oz, px1 = z.ex, py1 = z.ey * TILT - ez;
    const len = Math.hypot(px1 - px0, py1 - py0) || 1, steps = Math.ceil(len / 3);
    const nx = -(py1 - py0) / len, ny = (px1 - px0) / len, wpx = o.w * 0.5, tf = (z.t * 40) | 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, px = px0 + (px1 - px0) * t, py = py0 + (py1 - py0) * t;
      const wy = z.y + (z.ey - z.y) * t;
      const fl = HS[(s * 13 + tf) & 511], k = fade * (0.85 + 0.3 * fl);
      put(px, py, fl < 0.5 ? GI.eq : GI.hash, st.core[0] * k, st.core[1] * k, st.core[2] * k, wy + 2, 0.9);
      if (s % 2 === 0) {
        const w = wpx * (0.5 + 0.5 * fl);
        put(px + nx * w, py + ny * w, fl < 0.3 ? GI.dot : GI.minus, st.col[0] * k * 0.8, st.col[1] * k * 0.8, st.col[2] * k * 0.8, wy + 1.5, 0.45);
        put(px - nx * w, py - ny * w, fl > 0.7 ? GI.dot : GI.minus, st.col[0] * k * 0.8, st.col[1] * k * 0.8, st.col[2] * k * 0.8, wy + 1.5, 0.45);
      }
    }
    halo(px0, py0, 20, st.col, 0.8 * fade); halo(px1, py1, 26, st.col, 0.7 * fade);
    const L = st.light;
    R.light(z.x, z.y, oz, 110, L[0], L[1], L[2], 1.2 * fade);
    R.light((z.x + z.ex) / 2, (z.y + z.ey) / 2, 20, 120, L[0], L[1], L[2], 0.8 * fade);
    R.light(z.ex, z.ey, 10, 110, L[0], L[1], L[2], 1.3 * fade);
  }

  // ---- flame pillar (Flame King)
  function pillar(owner, x, y, o) {
    o = o || {};
    const r = o.r || 34, warn = o.warn || owner.tw(0.9), life = o.life || 1.3;
    owner.tele({ shape: 'circle', x, y, r, dur: warn, color: COL.fire });
    return hazard(owner, { x, y, r, life: warn + life, warn, plife: life, once: new Set(), tickT: 0.3, update: updPillar, draw: drawPillar, ph: HM.rng.next() * 9 });
  }
  function updPillar(z, dt) {
    if (z.dying || z.t < z.warn) return;
    const b = z.owner;
    if (!z.up) {
      z.up = true;
      hurt(b, (a) => M.dist(z.x, z.y, a.x, a.y) <= z.r + a.radius * 0.6, { amount: b.D(1.2), type: 'fire', knock: 200, hitstop: 0.06, shake: 6, status: [{ id: 'burn', dur: 2.5, dps: b.D(0.08) }] }, z.once, z.x, z.y);
      callFx('burst', z.x, z.y, 8, 'ember', 16); sfx('fire', { x: z.x, y: z.y }); shakeAt(z.x, z.y, 3);
      return;
    }
    if (z.life < 0.25) return;
    z.tickT -= dt; if (z.tickT > 0) return; z.tickT = 0.3;
    hurt(b, (a) => M.dist(z.x, z.y, a.x, a.y) <= z.r * 0.85 + a.radius * 0.5, { amount: b.D(0.25), type: 'fire', isDot: true, numColor: 'fire' }, null, z.x, z.y);
  }
  function drawPillar(z) {
    if (z.t < z.warn) { // gathering heat under the ring
      const k = z.t / z.warn; halo(z.x, z.y * TILT, z.r * (0.6 + 0.6 * k), COL.fire, 0.35 * k);
      R.light(z.x, z.y, 4, z.r * 2.5, 1, 0.4, 0.1, 0.6 * k); return;
    }
    const age = z.t - z.warn, grow = Math.min(1, age / 0.12), fade = Math.min(1, z.life / 0.35) * (z.dying ? M.clamp(z.life / 0.3, 0, 1) : 1);
    const H = 120 * M.easeOutBack(grow) * (0.4 + 0.6 * fade), bx = z.x, by = z.y * TILT, t = z.t;
    const rows = Math.ceil(H / CH);
    for (let rI = 0; rI <= rows; rI++) {
      const u = rI / Math.max(1, rows), py = by - rI * CH;
      const wob = Math.sin(t * 9 + rI * 0.7 + z.ph) * 3;
      const half = z.r * (0.62 - 0.38 * u) * (0.9 + 0.2 * Math.sin(t * 13 + rI));
      const n = Math.max(1, Math.ceil((half * 2) / CW));
      for (let c = 0; c <= n; c++) {
        const v = (c / n) * 2 - 1, px = bx + wob + v * half;
        const heat = (1 - Math.abs(v)) * (1 - u * 0.55) * fade;
        const fl = HS[(rI * 17 + c * 5 + ((t * 25) | 0)) & 511];
        if (heat < 0.12 && fl < 0.5) continue;
        const col = heatCol(Math.min(1, heat * 1.15 + fl * 0.15));
        const gi = RAMP.fire[Math.max(1, Math.min(RAMP.fire.length - 1, Math.round(heat * 9 + fl * 1.5)))];
        put(px, py, gi, col[0], col[1], col[2], z.y + 0.5, 0.65);
      }
    }
    halo(bx, by - H * 0.45, z.r * 1.4, COL.fire, 0.55 * fade);
    R.light(z.x, z.y, H * 0.5, 160, 1, 0.45, 0.1, 1.7 * fade * (0.85 + 0.15 * Math.sin(t * 15)));
  }

  // ---- fissure (Flame King). FX.fissure draws it when real (we pass explicit prong `angles`); otherwise our own
  //      cracks → sequential flame columns → embers → fading scars.
  function fissure(owner, x, y, ang, prongs, spread, len, onErupt) {
    const angles = [];
    for (let k = 0; k < prongs; k++) angles.push(ang + (prongs === 1 ? 0 : spread * ((k / (prongs - 1)) * 2 - 1)));
    const lines = angles.map((a, k) => {
      const pts = [[x, y]]; const ca = Math.cos(a), sa = Math.sin(a); let j = 0;
      for (let d = 14; d <= len; d += 14) { j = M.clamp(j + rnd(-5, 5), -9, 9); pts.push([x + ca * d - sa * j, y + sa * d + ca * j]); }
      return { a, pts, seed: k };
    });
    let erupted = false;
    const doErupt = (pts) => { erupted = true; onErupt(pts); };
    if (fxReal('fissure')) callFx('fissure', { x, y, ang, prongs, spread, len, angles, color: COL.fire, onErupt: (pts) => doErupt(pts) });
    else hazard(owner, { x, y, r: len, lines, len, life: 2.1, draw: drawFissure });
    // our own damage points, used when FX gives us none in time
    owner.later(0.32, () => {
      if (erupted) return;
      const pts = [];
      for (const L of lines) for (let i = 3; i < L.pts.length; i += 3) pts.push(L.pts[i]);
      doErupt(pts);
    });
    return lines;
  }
  function drawFissure(z) {
    const t = z.t;
    for (const L of z.lines) {
      const n = L.pts.length;
      const reach = M.clamp(t / 0.25, 0, 1) * (n - 1);
      const glow = t < 0.25 ? 0.5 : t < 0.5 ? 0.5 + (t - 0.25) * 3.2 : Math.max(0, 1.3 - (t - 0.5) * 0.75);
      for (let i = 1; i <= reach; i++) {
        const a = L.pts[i - 1], b = L.pts[i];
        const c = heatCol(M.clamp(glow * 0.75, 0, 1)), k = Math.min(1, glow);
        R.seg(a[0], a[1] * TILT, b[0], b[1] * TILT, null, c[0] * k, c[1] * k, c[2] * k, R.KEY_DECAL + 4, R.F_UNLIT);
        if (k > 0.3) R.emit(b[0], b[1] * TILT, c[0] * 0.25 * k, c[1] * 0.25 * k, c[2] * 0.25 * k);
      }
      // flame columns erupt in sequence along the crack (0.25–0.9 s)
      if (t > 0.25 && t < 1.05) {
        for (let i = 3; i < n; i += 3) {
          const te = 0.25 + (i / n) * 0.25; if (t < te) continue;
          const age = t - te, k = age < 0.1 ? age / 0.1 : Math.max(0, 1 - (age - 0.1) / 0.55);
          if (k <= 0.02) continue;
          const p = L.pts[i], px = p[0], py = p[1] * TILT, h = 54 * k;
          for (let rI = 0; rI * CH < h; rI++) {
            const u = (rI * CH) / Math.max(1, h), c = heatCol(1 - u * 0.7);
            const fl = HS[(i * 11 + rI * 7 + ((t * 25) | 0)) & 511];
            put(px + (fl - 0.5) * 5, py - rI * CH, u < 0.3 ? GI.at : u < 0.6 ? GI.hash : fl < 0.5 ? GI.star : GI.apos, c[0] * k, c[1] * k, c[2] * k, p[1] + 0.5, 0.7);
          }
          halo(px, py - h * 0.4, 20, COL.fire, 0.5 * k);
          if (i % 6 === 3) R.light(p[0], p[1], 20, 100, 1, 0.45, 0.12, 1.3 * k);
        }
      }
    }
  }

  // ---- closing ring of fire (Flame King phase 3): the arena shrinks; standing outside it burns and shoves you in
  // (elliptical, matching the arena; shrinks to half size over 22 s, then holds)
  function closingRing(owner) {
    const A = owner.arena;
    return hazard(owner, { x: A.x, y: A.y, r: A.r, k: 1, rx0: A.rx + 30, ry0: A.ry + 30, rx: A.rx + 30, ry: A.ry + 30, shrink: 22, persist: true, life: 1e9, tickT: 1.2, update: updFireRing, draw: drawFireRing });
  }
  function updFireRing(z, dt) {
    if (z.dying) return;
    const k = M.lerp(1, 0.5, M.smooth(M.clamp(z.t / z.shrink, 0, 1)));
    z.rx = Math.max(250, z.rx0 * k); z.ry = Math.max(190, z.ry0 * k); z.r = Math.min(z.rx, z.ry);
    z.tickT -= dt; if (z.tickT > 0) return; z.tickT = 0.5;
    const b = z.owner, edge = 1 - 12 / z.r;
    hurt(b, (a) => arenaU(z, a.x, a.y) > edge, (a) => ({ amount: b.D(0.45), type: 'fire', knock: 300, dir: M.angle(a.x, a.y, z.x, z.y), hitstop: 0.02, shake: 3, status: [{ id: 'burn', dur: 2, dps: b.D(0.1) }] }), null);
  }
  function drawFireRing(z) {
    const n = Math.ceil((TAU * Math.max(z.rx, z.ry)) / 4.5), t = z.t, tf = (t * 20) | 0;
    const fade = z.dying ? M.clamp(z.life / 0.3, 0, 1) : Math.min(1, t / 0.8);
    let lights = 0;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU, x = z.x + Math.cos(a) * z.rx, y = z.y + Math.sin(a) * z.ry;
      if (!R.inViewWorld(x, y, 40)) continue;
      const h = HS[(k * 3 + tf) & 511], px = x, py = y * TILT;
      const fh = 1 + ((0.5 + 0.5 * Math.sin(t * 7 + k * 0.9) * HS2[k & 511] + h * 0.4) * 4) | 0;
      for (let l = 0; l < fh; l++) {
        const heat = (1 - l / (fh + 0.5)) * fade, c = heatCol(heat);
        put(px + (l ? (h - 0.5) * 4 : 0), py - l * CH * 0.9, l === 0 ? (h < 0.5 ? GI.hash : GI.at) : RAMP.fire[Math.max(1, Math.round(heat * 8))], c[0], c[1], c[2], l === 0 ? R.KEY_DECAL + 5 : y + 0.3, 0.6);
      }
      if ((k % 9) === 0 && lights < 14) { lights++; R.light(x, y, 20, 120, 1, 0.42, 0.1, 1.1 * fade); }
    }
  }

  // ---- frost floor (Ice King phase 3): the ground inside the arena freezes over (tints terrain cells only)
  function frostFloor(owner) { return hazard(owner, { x: owner.arena.x, y: owner.arena.y, r: owner.arena.r, persist: true, life: 1e9, ox: owner.x, oy: owner.y, draw: drawFrost }); }
  function drawFrost(z) {
    const rad = (Math.max(z.owner.arena.rx, z.owner.arena.ry) + 120) * M.clamp(z.t / 2.4, 0, 1) * (z.dying ? M.clamp(z.life / 0.3, 0, 1) : 1);
    if (rad < 4) return;
    const cols = R.cols, rows = R.rows, key = R.key, col = R.col, glyph = R.glyph, KG = R.KEY_GROUND, r2 = rad * rad;
    const tw = z.t * 2;
    for (let y = 0; y < rows; y++) {
      const cj = R.cj0 + y, dy = ((cj + 0.5) * CH) / TILT - z.oy; if (dy * dy > r2) continue;
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x; if (key[i] !== KG || !glyph[i]) continue;
        const ci = R.ci0 + x, dx = (ci + 0.5) * CW - z.ox, d2 = dx * dx + dy * dy; if (d2 > r2) continue;
        const edge = Math.min(1, (r2 - d2) / (r2 * 0.12 + 1));
        const o = i * 3, l = (col[o] * 0.3 + col[o + 1] * 0.55 + col[o + 2] * 0.15);
        const k = 0.75 * edge;
        col[o] = M.lerp(col[o], 0.35 + l * 0.9, k); col[o + 1] = M.lerp(col[o + 1], 0.48 + l * 0.95, k); col[o + 2] = M.lerp(col[o + 2], 0.62 + l, k);
        const h = ih(ci, cj);
        if (h < 0.22 * edge) glyph[i] = h < 0.05 ? GI.star : h < 0.12 ? GI.plus : GI.apos;
        if (h > 0.985) R.emitI(i, 0.1 * (0.5 + 0.5 * Math.sin(tw + h * 90)), 0.13, 0.18);
      }
    }
  }

  // ---- blizzard weather: wind-driven snow in front of everything + a pale haze (Ice King)
  function snowstorm(owner, life) { return hazard(owner, { life, draw: drawSnow }); }
  function drawSnow(z) {
    const k = Math.min(1, z.t / 0.8) * Math.min(1, z.life / 1.0) * (z.dying ? M.clamp(z.life / 0.3, 0, 1) : 1);
    if (k <= 0.01) return;
    const vw = R.viewW + 60, vh = R.viewH + 20, ox = R.originPx - 30, oy = R.originPy - 10, t = z.t;
    const n = (300 * k) | 0;
    for (let s = 0; s < n; s++) {
      const h1 = HS[s & 511], h2 = HS2[s & 511], sp = 0.55 + h2;
      const px = ox + ((h1 * 9137 + t * 230 * sp) % vw), py = oy + ((h2 * 7411 + t * 95 * sp) % vh);
      const b = (0.45 + 0.55 * h2) * k;
      R.set(px, py, sp > 1.25 ? GI.minus : h1 < 0.3 ? GI.apos : h1 < 0.5 ? GI.comma : GI.dot, 0.8 * b, 0.88 * b, 1 * b, R.KEY_TOP - 5, R.F_UNLIT);
    }
    const e = 0.02 * k, emi = R.emi, N = R.n * 3;
    for (let i = 0; i < N; i += 3) { emi[i] += e * 0.75; emi[i + 1] += e * 0.85; emi[i + 2] += e; }
  }

  // ---- green fire everywhere (Lich phase 3): candle-flames across the arena (cosmetic; real hazards spawn separately)
  function greenField(owner) {
    const A = owner.arena, pts = [];
    for (let k = 0; k < 60; k++) { const a = rnd(0, TAU), d = Math.sqrt(HM.rng.next()) * 0.98; const x = A.x + Math.cos(a) * A.rx * d, y = A.y + Math.sin(a) * A.ry * d; if (!solid(x, y)) pts.push([x, y, HM.rng.next()]); }
    return hazard(owner, { x: A.x, y: A.y, r: A.r, pts, persist: true, life: 1e9, draw: drawGreenField });
  }
  function drawGreenField(z) {
    const t = z.t, fade = Math.min(1, t / 1.5) * (z.dying ? M.clamp(z.life / 0.3, 0, 1) : 1);
    let lights = 0;
    for (let k = 0; k < z.pts.length; k++) {
      const p = z.pts[k]; if (!R.inViewWorld(p[0], p[1], 30)) continue;
      const fl = 0.5 + 0.5 * Math.sin(t * (5 + p[2] * 4) + k), px = p[0], py = p[1] * TILT;
      const hh = 2 + ((fl * 2.5) | 0);
      for (let l = 0; l < hh; l++) {
        const c = witchCol((1 - l / hh) * (0.6 + 0.4 * fl)), kk = fade;
        put(px + (l ? (HS[(k * 9 + l + ((t * 12) | 0)) & 511] - 0.5) * 4 : 0), py - l * CH * 0.85, l === 0 ? GI.o : l === hh - 1 ? GI.apos : GI.star, c[0] * kk, c[1] * kk, c[2] * kk, p[1] + 0.2, 0.7);
      }
      if ((k & 3) === 0 && lights < 10) { lights++; R.light(p[0], p[1], 12, 75, 0.3, 1, 0.45, 0.8 * fade * (0.8 + 0.2 * fl)); }
    }
  }

  // ---- doom sigil (Lich): a rotating ring of runes over the dotted telegraph
  function sigil(owner, x, y, r, dur) { return hazard(owner, { x, y, r, life: dur + 0.15, dur, draw: drawSigil }); }
  function drawSigil(z) {
    const k = M.clamp(z.t / z.dur, 0, 1), fade = z.dying ? M.clamp(z.life / 0.3, 0, 1) : 1, n = 14;
    for (let s = 0; s < n; s++) {
      const a = (s / n) * TAU + z.t * 1.6 * (s & 1 ? 1 : -1) * 0.5, rr = z.r * (0.62 + 0.08 * Math.sin(z.t * 6 + s));
      const c = witchCol(0.5 + 0.5 * k), kk = fade * (0.5 + 0.5 * k);
      put(z.x + Math.cos(a) * rr, (z.y + Math.sin(a) * rr) * TILT, RUNES[s % RUNES.length], c[0] * kk, c[1] * kk, c[2] * kk, R.KEY_DECAL + 6, 0.6);
    }
    put(z.x, z.y * TILT, GI.O, 0.5 * fade, 1.2 * fade, 0.6 * fade, R.KEY_DECAL + 6, 0.8 * k);
    R.light(z.x, z.y, 6, z.r * 2, 0.3, 1, 0.45, 0.8 * k * fade);
  }

  // ---- dragon fire breath: a channelled cone that sweeps toward the hero, hitting in ticks and leaving fire behind
  function breath(owner, o) { return hazard(owner, Object.assign({ x: owner.x, y: owner.y, r: o.range, life: o.dur, once: new Set(), tickT: 0, zoneT: 0.12, ang: owner.facing, update: updBreath, draw: drawBreath }, o)); }
  function updBreath(z, dt) {
    const b = z.owner; if (b.dead) return;
    const p = player();
    if (p) { const want = M.angle(b.x, b.y, p.x, p.y); b.facing += M.clamp(M.angleDiff(b.facing, want), -z.turn * dt, z.turn * dt); }
    b.aim = b.facing; z.ang = b.facing;
    const m = b.mouth(); z.x = m[0]; z.y = m[1]; z.oz = m[2] || z.oz;
    if (z.holdT && b.anim.state === 'attack' && b.anim.t > z.holdT && z.life > 0.15) b.anim.t = z.holdT;   // jaw stays open while it burns
    if (z.dying) return;
    z.tickT -= dt;
    if (z.tickT <= 0) {
      z.tickT = 0.25; z.once.clear();
      hurt(b, (a) => {
        const d = M.dist(z.x, z.y, a.x, a.y); if (d > z.range + a.radius) return false;
        return d < a.radius + 6 || Math.abs(M.angleDiff(z.ang, M.angle(z.x, z.y, a.x, a.y))) <= z.half + Math.asin(Math.min(1, a.radius / Math.max(d, 1)));
      }, { amount: b.D(0.32), type: 'fire', knock: 40, hitstop: 0.02, shake: 2, status: [{ id: 'burn', dur: 2, dps: b.D(0.08) }] }, z.once, z.x, z.y);
    }
    z.zoneT -= dt;
    if (z.zoneT <= 0) {
      z.zoneT = z.zoneEvery;
      const d = rnd(70, z.range * 0.95), a = z.ang + rnd(-z.half, z.half) * 0.8;
      const x = z.x + Math.cos(a) * d, y = z.y + Math.sin(a) * d;
      if (!solid(x, y)) elemZone(b, x, y, rnd(20, 28), z.zoneLife, b.D(0.4), 'fire');
    }
    z.sfxT = (z.sfxT || 0) - dt; if (z.sfxT <= 0) { z.sfxT = 0.45; sfx('fire', { x: z.x, y: z.y, vol: 0.8 }); }
  }
  function drawBreath(z) {
    const t = z.t, n = 110, oz = z.oz || 34, ca = Math.cos(z.ang), sa = Math.sin(z.ang);
    const fade = Math.min(1, t / 0.12) * Math.min(1, z.life / 0.2) * (z.dying ? M.clamp(z.life / 0.3, 0, 1) : 1);
    for (let k = 0; k < n; k++) {
      const h1 = HS[k], h2 = HS2[k];
      const u = (t * 2.1 * (0.8 + 0.4 * h2) + h1) % 1;
      const along = 8 + u * z.range, off = (h2 - 0.5) * 2 * z.half * Math.min(1, 0.25 + u * 1.1);
      const a = z.ang + off;
      const x = z.x + Math.cos(a) * along, y = z.y + Math.sin(a) * along;
      const zz = oz * (1 - u) + 4 + Math.sin(k + t * 9) * 3 * u;
      const heat = (1 - u) * fade, c = heatCol(Math.min(1, heat * 1.1 + 0.08));
      const gi = RAMP.fire[Math.max(1, Math.min(9, Math.round(heat * 9 + (h1 - 0.5) * 2)))];
      put(x, y * TILT - zz, gi, c[0] * (0.6 + 0.4 * fade), c[1] * (0.6 + 0.4 * fade), c[2], y + 1, 0.6);
    }
    const fl = 0.85 + 0.15 * Math.sin(t * 19);
    for (const d of [50, 140, 230]) R.light(z.x + ca * d, z.y + sa * d, 12, 130, 1, 0.42, 0.1, 1.3 * fade * fl);
    halo(z.x, z.y * TILT - oz, 22, COL.fire, 0.8 * fade);
  }

  // ---- lobbed lemon (arcing projectile that leaves an acid puddle where its dotted ring was)
  function lob(owner, tx, ty, flight, onLand) {
    const sz = 60, gr = 900, vz = (0.5 * gr * flight * flight - sz) / flight;
    return C.projectile({ x: owner.x, y: owner.y, z: sz, vx: (tx - owner.x) / flight, vy: (ty - owner.y) / flight, vz, gravity: gr,
      r: 6, team: 1, life: flight + 0.6, look: 'lemon', color: COL.acid, damage: null, pierce: 999, ghost: true, source: owner,
      onGround: () => { try { onLand(); } catch (e) { console.error(e); } } });
  }
  function bolt(owner, x, y, z, ang, o) {
    const sp = o.speed || 240, p = player();
    return C.projectile({ x, y, z, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: o.r || 7, team: 1, life: o.life || 2.6,
      look: o.look || 'bolt', color: o.color || [1, 1, 1], source: owner, light: o.light || null,
      damage: { amount: owner.D(o.dmg || 1), type: o.type || 'phys', knock: o.knock || 70, status: o.status || null, canCrit: false, hitstop: 0.04 },
      homing: o.homing && p ? { target: p, turn: o.homing } : null,
      onExpire: (pr) => callFx('burst', pr.x, pr.y, pr.z, o.burst || 'spark', 6) });
  }

  // ---- summons (via HM.Enemies.spawn, guarded)
  function spawnMinion(b, id, x, y, o) {
    const E = HM.Enemies; if (!E || typeof E.spawn !== 'function') return null;
    const defs = E.defs;
    if (defs && Object.keys(defs).length && !defs[id]) { if (o.fallback && defs[o.fallback]) id = o.fallback; else return null; }
    const T = Bosses.tuning;
    const opts = { summoned: true, summoner: b, noDrops: true, rise: !!o.rise, dmgMul: o.dmgMul || T.addDmg, hpMul: o.hpMul || T.addHp };
    if (o.name) opts.name = o.name;
    if (o.tint) opts.tint = o.tint;
    let m = null;
    try { m = E.spawn(id, x, y, opts); } catch (e) { console.error('[bosses] summon ' + id, e); return null; }
    if (!m) return null;
    const G = HM.Game; if (G && G.entities && G.entities.indexOf(m) < 0) G.spawn(m);
    if (!m.summoned) { m.xpValue = Math.round((m.xpValue || 4) * 0.25); m.goldDrop = [0, 0]; }   // Enemies already does this for `summoned`
    m.summoner = b; m.summoned = true; m.noDrops = true;
    // a summon knows exactly where the hero is and never wanders home
    m.aggro = Math.max(m.aggro || 0, 900); m.leash = 1e9;
    const p = player(); if (p && typeof m.alert === 'function') safe(() => m.alert(p, true));
    if (o.name) { m.name = o.name; if (m.displayName !== undefined) m.displayName = o.name; if (m.baseName !== undefined) m.baseName = o.name; }
    if (o.tint) { // lemon-tint the rig palette (a copy per actor)
      m.tint = o.tint;
      const pal = m.rig && m.rig.pal;
      if (pal) for (const k in pal) if (Array.isArray(pal[k]) && pal[k].length === 3) pal[k] = M.mixRgb(pal[k], o.tint, 0.45);
    }
    b.minions.push(m);
    return m;
  }
  function summon(b, ids, n, o) {
    o = o || {};
    n = Math.min(n, (o.cap || 5) - b.aliveMinions());
    let made = 0;
    for (let k = 0; k < n; k++) {
      let x = b.x, y = b.y, ok = false;
      for (let tries = 0; tries < 12 && !ok; tries++) {
        const a = b.facing + rnd(-2.2, 2.2), d = b.radius + rnd(45, 115);
        x = b.x + Math.cos(a) * d; y = b.y + Math.sin(a) * d; ok = !solid(x, y);
      }
      if (!ok) continue;
      const id = Array.isArray(ids) ? ids[k % ids.length] : ids;
      b.tele({ shape: 'circle', x, y, r: 22, dur: 0.7, color: o.color || b.def.color });
      callFx('burst', x, y, 4, 'dust', 6);
      b.later(0.7, () => { const m = spawnMinion(b, id, x, y, o); if (m) { callFx('burst', x, y, 14, o.burst || 'bone', 14); sfx(o.sfx || 'bone_break', { x, y }); } });
      made++;
    }
    return made;
  }

  // random open point inside the arena (optionally near a point)
  // The arena is an ellipse (World sets floor.arena = {x, y, rx, ry}; a plain {r} works too).
  // arenaU < 1 inside, 1 on the rim.
  const arenaU = (A, x, y) => Math.sqrt(((x - A.x) / A.rx) ** 2 + ((y - A.y) / A.ry) ** 2);
  function arenaPoint(b, nx, ny, minR, maxR) {
    const A = b.arena;
    for (let k = 0; k < 24; k++) {
      let x, y;
      if (nx !== undefined) { const a = rnd(0, TAU), d = rnd(minR || 0, maxR || 200); x = nx + Math.cos(a) * d; y = ny + Math.sin(a) * d; }
      else { const a = rnd(0, TAU), d = Math.sqrt(HM.rng.next()) * 0.85; x = A.x + Math.cos(a) * A.rx * d; y = A.y + Math.sin(a) * A.ry * d; }
      if (arenaU(A, x, y) > 0.95 || solid(x, y)) continue;
      return [x, y];
    }
    return [nx !== undefined ? nx : A.x, ny !== undefined ? ny : A.y];
  }
  function arenaFor(floor, x, y) {
    const a = floor && floor.arena;
    if (a && (a.rx || a.r)) { const rx = a.rx || a.r, ry = a.ry || a.r; return { x: a.x, y: a.y, rx, ry, r: Math.min(rx, ry) }; }
    if (floor && floor.w && floor.h) { const r = Math.max(260, Math.min(floor.w, floor.h) * 0.5 - 110); return { x: floor.w * 0.5, y: floor.h * 0.52, rx: r, ry: r, r }; }
    return { x, y: y + 150, rx: 480, ry: 480, r: 480 };
  }

  // ======================================================================================================== BossKin
  // Shared machinery for bosses and their decoys: timers, telegraphs, hazards, poses.
  class BossKin extends HM.Actor {
    constructor(o) {
      super(o);
      this.timers = []; this.hz = []; this.teles = []; this._gen = 0;
      this.spd = 1; this.holdPose = false; this.lockFacing = false;
      this.lastP = { x: this.x, y: this.y + 120, vx: 0, vy: 0, radius: 8, dead: false };
      this.stats.critChance = 0;
    }
    w(s) { return s / this.spd; }
    tw(s) { return Math.max(TELE_MIN, s / this.spd); }
    later(s, fn) { this.timers.push({ t: s, fn, pat: patOf(this) }); }
    tgt() { const p = player(); if (p) { const L = this.lastP; L.x = p.x; L.y = p.y; L.vx = p.vx || 0; L.vy = p.vy || 0; return p; } return this.lastP; }
    pos() { return { x: this.x, y: this.y }; }
    // world mouth [x, y, z] along `ang` (default: facing). Reach and height come from the rig's jaw joint when it has
    // one (the dragon's jaw sits ~100u ahead, ~110u up); the direction is ours, since the rig turns with some lag.
    mouth(ang) {
      ang = ang === undefined ? this.facing : ang;
      let d = (this.def && this.def.mouth) || this.radius + 10, z = this.height * 0.7;
      if (HM.Rig && HM.Rig.joint && this.rig && this.rig.posed) {
        const j = safe(() => HM.Rig.joint(this, 'mouth'));
        if (j && isFinite(j[0]) && isFinite(j[2])) { d = Math.max(this.radius, Math.hypot(j[0] - this.x, j[1] - this.y)); z = j[2]; }
      }
      return [this.x + Math.cos(ang) * d, this.y + Math.sin(ang) * d, z];
    }
    lunge(ang, dist) { this.kx += Math.cos(ang) * dist * 9; this.ky += Math.sin(ang) * dist * 9; }
    pose(state, variant, dur) {
      const Rg = HM.Rig;
      if (Rg && Rg.setAnim) { try { Rg.setAnim(this, state, { dur: dur || 0.4, variant }); return; } catch (e) { console.error('[bosses] setAnim', e); } }
      this.anim.state = state; this.anim.t = 0; this.anim.dur = dur || 0.4; this.anim.variant = variant;
    }
    // strike pose: rig convention puts the hit at ~33% of the anim, so the hit lands right as `wind` elapses
    strike(variant, wind, state) { this.pose(state || 'attack', variant, wind / 0.34); }
    tele(o) {
      let h = null; const f = fx('telegraph');
      if (f) { try { h = f.call(HM.FX, Object.assign({}, o)); } catch (e) { console.error('[bosses] FX.telegraph', e); h = null; } }
      if (!h || typeof h.cancel !== 'function') h = fallbackTele(this, o);
      this.teles.push(h); if (this.teles.length > 80) this.teles.splice(0, 40);
      return h;
    }
    runTimers(dt) {
      if (!this.timers.length) return;
      const list = this.timers, gen = this._gen; this.timers = [];
      for (let i = 0; i < list.length; i++) {
        const tm = list[i];
        if (this._gen !== gen) break;      // cancelled from inside a callback
        tm.t -= dt;
        if (tm.t <= 0) { const prev = CUR_PAT; CUR_PAT = tm.pat; try { tm.fn(); } catch (e) { console.error('[bosses] timer', e); } CUR_PAT = prev; } else this.timers.push(tm);
      }
    }
    // Abort everything in flight. Hazards fade (no more damage); persistent arena effects survive unless `all`.
    cancelAll(all) {
      this._gen++;
      this.timers = [];
      for (const h of this.teles) { try { if (h && h.cancel) h.cancel(); } catch (e) { /* ignore */ } }
      this.teles = [];
      for (const z of this.hz) if (!z.dead && !z.dying && (all || !z.persist)) { z.dying = true; z.life = Math.min(z.life, 0.3); }
      this.hz = this.hz.filter((z) => !z.dead && !z.dying);
      this.holdPose = false; this.lockFacing = false;
    }
    turnTo(a, rate, dt) { this.facing += M.clamp(M.angleDiff(this.facing, a), -rate * dt, rate * dt); }
    poseUpkeep() {
      const an = this.anim;
      if (an && !this.holdPose && an.state !== 'idle' && an.state !== 'dead' && an.dur && an.t >= an.dur) this.pose('idle', null, 0.4);
    }
    drawBody() {
      if (HM.Rig && HM.Rig.draw && this.rig) {
        try { HM.Rig.draw(this); return; } catch (e) { if (!this._rigErr) { this._rigErr = true; console.error('[bosses] Rig.draw ' + (this.rig && this.rig.id), e); } }
      }
      const p = R.proj(this.x, this.y, this.height * 0.4); const c = (this.def && this.def.color) || [0.8, 0.8, 0.8];
      R.ball(p[0], p[1], this.radius * 0.8, this.y, R.RAMPS.solid, c[0], c[1], c[2], 0);
    }
  }

  // =========================================================================================================== Boss
  class Boss extends BossKin {
    constructor(def, x, y, floor) {
      super({ kind: 'boss', team: 1, defId: def.id, x, y });
      const L = (HM.Lore && HM.Lore.bossIntro) ? safe(() => HM.Lore.bossIntro(def.id)) : null;
      const lore = L && L.name && L.name !== def.id ? L : null;
      this.def = def; this.isBoss = true; this.phase = 1; this.phaseCount = 3;
      this.displayName = (lore && lore.name) || def.displayName; this.title = (lore && lore.title) || def.title; this.introLine = (lore && lore.line) || '';
      this.name = this.displayName;
      const fi = (floor && floor.index) || def.act * 3;
      const asc = (HM.Game && HM.Game.run && HM.Game.run.ascension) || (floor && floor.ascension) || 0;
      const T = Bosses.tuning;
      this.floorIndex = fi; this.ascension = asc;
      this.maxHp = this.hp = Math.round(def.hp * Math.pow(fi / (def.act * 3), 1.2) * (1 + 0.22 * asc) * T.hpMul);
      // damage grows per floor more gently than it used to (+14%/floor outran hero HP growth; late bosses deal mostly
      // fire/shadow, which armor does not soak) — see tools/tests/boss_balance.js
      this.dmgUnit = def.dmg * (1 + T.floorDmg * (fi - 3)) * (1 + 0.1 * asc) * T.dmgMul;
      this.speedAsc = 1 + 0.03 * asc;
      this.radius = def.radius; this.height = def.height; this.mass = def.mass; this.speed = def.speed;
      this.stats.armor = def.armor || 0; Object.assign(this.stats.res, def.res || {});
      this.xpValue = Math.round(def.xp * (1 + 0.1 * asc)); this.goldDrop = def.gold.slice();
      if (def.weapon) this.weapon = Object.assign({}, def.weapon);
      this.arena = arenaFor(floor, x, y);
      this.home = { x, y };
      this.facing = Math.PI / 2; this.aim = this.facing;
      this.state = 'dormant'; this.stateT = 0; this.invuln = true; this.engaged = false;
      this.hideBar = true; this.introT = 1;   // UI keeps the boss bar hidden until the intro reveal
      this.main = null; this.bg = []; this.minions = []; this.decoys = []; this.pcd = {}; this.lastPattern = null;
      this.restT = 0.8; this.forced = null; this.moveMode = null; this.moveMul = 1;
      this.strafeDir = 1; this.strafeT = 2; this.pendingPhase = 0; this.barkT = 9; this.data = {};
      this.log = { patterns: {}, phases: [{ phase: 1, t: 0 }], intro: -1 };
      this.introDur = def.introDur || 2.1;
      if (HM.Rig && HM.Rig.create) { try { HM.Rig.create(this, def.rig, JSON.parse(JSON.stringify(def.rigOpts || {}))); } catch (e) { console.error('[bosses] Rig.create ' + def.rig, e); } }
      this._spawnedT = 0; this._checked = false;
    }
    D(mult) { return this.dmgUnit * mult; }
    aliveMinions() { this.minions = this.minions.filter((m) => m && !m.dead && !m.removeMe); return this.minions.length; }
    bgTask(name, gen) { this.bg.push({ name, gen, wait: 0, done: false }); }
    setSpeed() {
      const ps = (this.def.phaseSpeed || PHASE_SPEED)[this.phase - 1] || 1;
      this.spd = ps * this.speedAsc; this.stats.atkSpeed = this.spd; this.stats.castSpeed = this.spd;
    }
    drainHeal(amount) {
      const cap = this.maxHp * (this.phase === 1 ? 1 : PHASE_AT[this.phase - 2]);
      const h = Math.min(amount, cap - this.hp);
      if (h > 0.5) { this.hp += h; callFx('number', this, h, 'heal', false, false); }
    }

    // ---------------------------------------------------------------- update
    update(dt) {
      if (this.dead) { C.baseUpdate(this, dt); return; }
      if (!this._checked) this._dedupe();
      this.stateT += dt;
      this.runTimers(dt);
      const p = player();
      if (p) this.tgt();
      const def = this.def;
      if (def.hover) this.z = def.hover + Math.sin(this.t * 1.8) * 2.5;
      switch (this.state) {
        case 'dormant':
          this.vx = this.vy = 0;
          if (p && M.dist(this.x, this.y, p.x, p.y) < def.aggro) this.startIntro();
          break;
        case 'intro':
          this.vx = this.vy = 0;
          if (p) this.turnTo(M.angle(this.x, this.y, p.x, p.y), 3, dt);
          this.camPull(dt);
          if (this.stateT >= this.introDur) this.beginFight();
          break;
        case 'transition':
          this.vx = this.vy = 0;
          if (this.stateT >= this.transDur) this.endTransition();
          break;
        case 'fight':
          this.fight(dt, p);
          break;
      }
      if (def.tick && this.state !== 'dormant') { try { def.tick(this, dt, p); } catch (e) { console.error('[bosses] tick ' + def.id, e); } }
      if (this.hz.length > 120) this.hz = this.hz.filter((z) => !z.dead);
      this.poseUpkeep();
      C.baseUpdate(this, dt);
    }
    // Bosses.spawn adds us to Game.entities; if the caller also Game.spawn()s us, drop the duplicate.
    _dedupe() {
      this._checked = true;
      const E = HM.Game && HM.Game.entities; if (!E) return;
      const a = E.indexOf(this), b = E.lastIndexOf(this);
      if (a !== b && b > a) E.splice(b, 1);
    }

    fight(dt, p) {
      if (this.pendingPhase) { this.startTransition(this.pendingPhase); return; }
      for (const k in this.pcd) this.pcd[k] -= dt;
      if (!p) { this.vx = this.vy = 0; return; }
      const stunned = this._stunned;
      if (!stunned) {
        for (const t of this.bg) this.step(t, dt);
        if (this.bg.length && this.bg.some((t) => t.done)) this.bg = this.bg.filter((t) => !t.done);
        if (this.main) {
          this.step(this.main, dt);
          if (this.main.done) {
            const pt = this.def.patterns[this.main.name];
            this.restT = ((pt && pt.rest !== undefined) ? pt.rest : this.def.rest) / this.spd;
            this.main = null; this.moveMode = null; this.holdPose = false; this.lockFacing = false; this.moveMul = 1;
          }
        } else { this.restT -= dt; if (this.restT <= 0) this.startPattern(p); }
        // idle chatter between patterns
        this.barkT -= dt;
        if (this.barkT <= 0) { this.barkT = rnd(10, 16); if (!this.main || HM.rng.next() < 0.3) bark(this, this.idleLine(), 2.8); }
      }
      this.locomote(dt, p);
    }
    idleLine() {
      const own = this.def.lines && this.def.lines.idle;
      const lore = HM.Lore && HM.Lore.barks && HM.Lore.barks[this.def.id];
      const pool = [].concat(own || [], Array.isArray(lore) ? lore : []);
      return pick(pool);
    }

    step(task, dt) {
      task.wait -= dt;
      let guard = 0;
      while (task.wait <= 0 && !task.done) {
        let r;
        const prev = CUR_PAT; CUR_PAT = task.name;
        try { r = task.gen.next(); } catch (e) { CUR_PAT = prev; console.error('[bosses] pattern ' + this.def.id + '.' + task.name, e); task.done = true; break; }
        CUR_PAT = prev;
        if (r.done) { task.done = true; break; }
        task.wait += Math.max(0, +r.value || 0);
        if (++guard > 48) { task.wait = Math.max(task.wait, 0.016); break; }
      }
    }

    pickPattern(p) {
      const d = M.dist(this.x, this.y, p.x, p.y), pats = this.def.patterns, ph = this.phase;
      const opts = [];
      for (const name in pats) {
        const pt = pats[name];
        if (pt.phases && pt.phases.indexOf(ph) < 0) continue;
        if ((this.pcd[name] || 0) > 0) continue;
        if (pt.minR !== undefined && d < pt.minR) continue;
        if (pt.maxR !== undefined && d > pt.maxR) continue;
        if (pt.cond && !pt.cond(this, p, d)) continue;
        const w = typeof pt.weight === 'function' ? pt.weight(this, p, d) : Array.isArray(pt.weight) ? pt.weight[ph - 1] : (pt.weight || 1);
        if (w > 0) opts.push({ name, w });
      }
      if (!opts.length) return null;
      const pool = opts.length > 1 ? opts.filter((o) => o.name !== this.lastPattern) : opts;   // no immediate repeats
      return this.rng().weighted(pool, (o) => o.w).name;
    }
    rng() { return this._rng || (this._rng = new HM.RNG((M.hashStr(this.def.id) ^ ((this.floorIndex * 7919) >>> 0) ^ ((HM.rng.next() * 1e9) >>> 0)) >>> 0)); }

    startPattern(p, name) {
      name = name || (this.forced && this.def.patterns[this.forced] ? this.forced : this.pickPattern(p));
      this.forced = null;
      if (!name) { this.restT = 0.25; return; }
      const pt = this.def.patterns[name];
      this.lastPattern = name; this.patternName = name;
      this.pcd[name] = (pt.cd || 0) / this.spd;
      this.moveMode = pt.move || 'hold'; this.lockFacing = false; this.holdPose = false;
      this.main = { name, gen: pt.run(this, p), wait: 0, done: false };
      this.log.patterns[name] = (this.log.patterns[name] || 0) + 1;
      this.step(this.main, 0);
    }
    abortMain() {
      if (this.main) { try { this.main.gen.return(); } catch (e) { /* ignore */ } this.main = null; }
      this.moveMode = null; this.holdPose = false; this.lockFacing = false; this.moveMul = 1;
    }

    locomote(dt, p) {
      const def = this.def;
      const d = M.dist(this.x, this.y, p.x, p.y), a = M.angle(this.x, this.y, p.x, p.y);
      const mode = this.moveMode || def.move || 'chase';
      if (mode !== 'custom') {
        const sp = this.speed * this.speedAsc * (1 + 0.1 * (this.phase - 1)) * this.moveMul;
        let vx = 0, vy = 0;
        if (mode === 'chase') {
          if (d > def.range) { vx = Math.cos(a) * sp; vy = Math.sin(a) * sp; }
        } else if (mode === 'kite') {
          const want = def.range, radial = d > want + 50 ? 1 : d < want - 70 ? -1 : 0;
          this.strafeT -= dt; if (this.strafeT <= 0) { this.strafeDir *= -1; this.strafeT = rnd(2, 4); }
          vx = (Math.cos(a) * radial - Math.sin(a) * this.strafeDir * 0.65) * sp;
          vy = (Math.sin(a) * radial + Math.cos(a) * this.strafeDir * 0.65) * sp;
        }
        // leash to the arena
        const A = this.arena;
        if (arenaU(A, this.x, this.y) > 0.88) { const back = M.angle(this.x, this.y, A.x, A.y); vx += Math.cos(back) * sp; vy += Math.sin(back) * sp; }
        this.vx = vx; this.vy = vy;
      }
      if (!this.lockFacing) this.turnTo(a, def.turn || 4, dt);
      this.aim = this.facing;
    }

    // ---------------------------------------------------------------- intro / phases / death
    startIntro() {
      if (this.state !== 'dormant') return;
      const def = this.def;
      this.state = 'intro'; this.stateT = 0; this.engaged = true; this.introT = 0; this.log.intro = HM.Game ? HM.Game.t : 0;
      ui('banner', this.displayName, this.title, 3.5, { kicker: 'ACT ' + (['I', 'II', 'III', 'IV', 'V'][def.act - 1] || def.act) + '  ·  BOSS', color: def.color });
      sfx('bossRoar', { x: this.x, y: this.y, vol: 1 });
      try { if (HM.Audio && HM.Audio.music) HM.Audio.music('boss'); } catch (e) { /* optional */ }
      if (HM.Game && HM.Game.slowmo) HM.Game.slowmo(1.1, 0.35);
      this.pose('special', 'roar', 1.8);
      if (HM.Rig && HM.Rig.trigger) safe(() => HM.Rig.trigger(this, 'roar'));
      callFx('shake', 9);
      ringFx(this, this.x, this.y, this.radius, 340, 0.9, def.color);
      callFx('burst', this.x, this.y, 20, def.burst, 30);
      bark(this, pick(def.lines.intro), 3.2);
      if (this.introLine) this.later(1.6, () => toast(this.introLine, [0.82, 0.78, 0.7], 4));
      HM.Events.emit('bossIntro', { boss: this });
    }
    beginFight() { this.state = 'fight'; this.stateT = 0; this.invuln = false; this.restT = 0.35; this.engaged = true; this.setSpeed(); }
    // Pull the camera toward the boss during the intro (Game re-damps toward the hero every frame, so this blends).
    camPull(dt) {
      const G = HM.Game, p = player(); if (!G || !G.cam || !p) return;
      const scale = (G.slowT > 0 ? G.slowScale : 1) * (G.timeScale || 1) || 1;
      const real = dt / scale;
      const k = M.clamp(this.stateT / 0.35, 0, 1) * (1 - M.clamp((this.stateT - (this.introDur - 0.5)) / 0.5, 0, 1));
      const f = (1 - Math.exp(-14 * real)) * k;
      const tx = M.lerp(p.x, this.x, 0.75), ty = M.lerp(p.y, this.y, 0.75) - 20;
      G.cam.x += (tx - G.cam.x) * f; G.cam.y += (ty - G.cam.y) * f;
    }
    onDamaged(info) {
      if (this.state !== 'fight' || this.pendingPhase) { info.amount = 0; return; }
      if (this.phase >= this.phaseCount) return;
      const thr = this.maxHp * PHASE_AT[this.phase - 1];
      if (this.hp - info.amount <= thr) { info.amount = Math.max(0, this.hp - thr); this.pendingPhase = this.phase + 1; }
    }
    onBeforeDeath() {
      if (this.phase < this.phaseCount) { if (!this.pendingPhase) this.pendingPhase = this.phase + 1; return false; }  // a phase is never skipped
      return true;
    }
    startTransition(ph) {
      const def = this.def;
      this.pendingPhase = 0;
      this.abortMain(); this.cancelAll(false); this.bg = [];
      this.phase = ph; this.setSpeed();
      this.log.phases.push({ phase: ph, t: HM.Game ? HM.Game.t : 0 });
      this.state = 'transition'; this.stateT = 0; this.invuln = true; this.transDur = ph === 3 ? 2.3 : 1.9;
      this.vx = this.vy = 0;
      this.pose('special', ph === 3 ? 'enrage' : 'roar', 1.6);
      if (HM.Rig && HM.Rig.trigger) safe(() => HM.Rig.trigger(this, ph === 3 ? 'enrage' : 'roar'));
      sfx('bossRoar', { x: this.x, y: this.y, vol: 1 });
      callFx('shake', 10); R.flash(def.color[0], def.color[1], def.color[2], 0.22);
      ringFx(this, this.x, this.y, this.radius, 300, 0.7, def.color);
      callFx('burst', this.x, this.y, 30, def.burst, 40);
      flashLight(this, this.x, this.y, 30, 320, def.color, 2, 0.8);
      if (HM.Game && HM.Game.slowmo) HM.Game.slowmo(0.45, 0.4);
      // shockwave: shove the hero back (a phase change is never a damage check)
      const p = player();
      if (p) { const d = M.dist(this.x, this.y, p.x, p.y); if (d < 280) { const a = M.angle(this.x, this.y, p.x, p.y), k = 180 + 520 * (1 - d / 280); p.kx += Math.cos(a) * k; p.ky += Math.sin(a) * k; } }
      const L = def.lines;
      bark(this, pick(ph === 2 ? L.p2 : L.p3), 3);
      if (def.phaseToast) toast(def.phaseToast[ph - 2], def.toastColor || def.color, 3.2);
      if (def.onPhase) { try { def.onPhase(this, ph); } catch (e) { console.error('[bosses] onPhase ' + def.id, e); } }
      HM.Events.emit('bossPhase', { boss: this, phase: ph });
    }
    endTransition() { this.state = 'fight'; this.stateT = 0; this.invuln = false; this.restT = 0.45; }

    onDeath(info) {
      const def = this.def, G = HM.Game;
      this.state = 'dead';
      this.abortMain(); this.bg = []; this.cancelAll(true);
      if (G && G.projectiles) for (const pr of G.projectiles) if (pr.source === this && !pr.dead) { pr.dead = true; callFx('burst', pr.x, pr.y, pr.z || 10, def.burst, 4); }
      // the binding breaks: summons and copies collapse one after another
      const kin = this.minions.concat(this.decoys).filter((m) => m && !m.dead);
      kin.forEach((m, i) => { if (G && G.after) G.after(0.25 + i * 0.12, () => { if (!m.dead) { callFx('burst', m.x, m.y, 14, def.burst, 10); C.kill(m, { source: null }); } }); });
      if (G && G.slowmo) G.slowmo(def.id === 'lich' ? 2.6 : 1.7, def.id === 'lich' ? 0.2 : 0.25);
      R.flash(1, 1, 1, 0.45);
      callFx('shake', 16);
      sfx('death_big', { x: this.x, y: this.y, vol: 1 });
      blast(this, this.x, this.y, this.radius * 3, def.blast || 'fire');
      callFx('burst', this.x, this.y, this.height * 0.5, def.burst, 70);
      ringFx(this, this.x, this.y, this.radius, 420, 1.1, def.color);
      flashLight(this, this.x, this.y, 40, 380, def.color, 2.6, 2.2);
      bark(this, pick(def.lines.death), 3.2);
      if (def.onDeath) { try { def.onDeath(this, info); } catch (e) { console.error('[bosses] onDeath ' + def.id, e); } }
      if (G && G.after) {
        G.after(0.5, () => { ui('banner', this.displayName, def.deathSub, 4, { kicker: 'VANQUISHED', color: [0.92, 0.86, 0.72] }); callFx('burst', this.x, this.y, 30, def.burst, 40); });
        G.after(1.2, () => {
          try {
            if (HM.Audio && HM.Audio.music) HM.Audio.music(null);
            if (HM.Audio && HM.Audio.ambient && G.floor) HM.Audio.ambient(G.floor.biomeId, false);
          } catch (e) { /* optional */ }
        });
      }
      HM.Events.emit('bossDeath', { boss: this });
    }

    // ---------------------------------------------------------------- draw
    draw() {
      const def = this.def, L = def.light;
      if (L && (!L.phase || this.phase >= L.phase)) {
        const fl = def.flicker ? 0.82 + 0.18 * Math.sin(this.t * 13) * Math.sin(this.t * 7.3 + 1) : 1;
        const k = L.k * fl * (this.phase === 3 && !L.phase ? 1.3 : 1) * (this.dead ? Math.max(0, 1 - this.deathT / 1.5) : 1);
        if (k > 0.01) R.light(this.x, this.y, L.z, L.r, L.c[0], L.c[1], L.c[2], k);
      }
      this.drawBody();
      if (this.dead) return;
      if (this.state === 'intro' || this.state === 'transition') this.drawWard();
      if (this.phase === 3 || def.aura === 'always') this.drawAura();
    }
    // invulnerability ward: a ring of glyphs at the feet while the boss roars
    drawWard() {
      const c = this.def.color, n = 26, rr = this.radius + 14, t = this.t;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * TAU + t * 2.2, x = this.x + Math.cos(a) * rr, y = this.y + Math.sin(a) * rr;
        const f = 0.5 + 0.5 * Math.sin(t * 9 + k);
        put(x, y * TILT, k & 1 ? GI.deg : GI.mid, c[0] * f, c[1] * f, c[2] * f, y + 0.1, 0.5);
      }
    }
    // enraged aura: motes rising off the body (deterministic, no allocation)
    drawAura() {
      const st = this.def.auraStyle || 'fire', t = this.t, n = 22;
      for (let k = 0; k < n; k++) {
        const h1 = HS[(k + this.id * 13) & 511], h2 = HS2[(k + this.id * 7) & 511];
        const u = (t * (0.55 + 0.5 * h2) + h1) % 1;
        const x = this.x + (h2 - 0.5) * this.radius * 2.4 + Math.sin(t * 2 + k) * 4;
        const zz = 6 + u * this.height * 1.25, y = this.y + (h1 - 0.5) * this.radius;
        const heat = 1 - u;
        const c = st === 'witch' ? witchCol(heat) : st === 'ice' ? [0.7 + 0.3 * heat, 0.85 + 0.2 * heat, 1.1] : heatCol(heat);
        put(x, y * TILT - zz - this.z, u < 0.3 ? GI.star : u < 0.65 ? GI.apos : GI.dot, c[0], c[1], c[2], y + 2, 0.5);
      }
    }
  }
  function safe(fn) { try { return fn(); } catch (e) { console.error('[bosses]', e); return null; } }

  // ========================================================================================================= Decoy
  // Lemongrab's phase-3 copies: weaker, flickering (the tell), shriek and spit like him, pop into juice.
  class Decoy extends BossKin {
    constructor(boss, x, y) {
      super({ kind: 'enemy', team: 1, defId: 'lemongrabDecoy', name: boss.displayName, x, y });
      this.boss = boss; this.def = boss.def; this.isDecoy = true;
      this.radius = 13; this.height = boss.height; this.mass = 6; this.speed = 92;
      this.maxHp = this.hp = Math.max(60, Math.round(boss.maxHp * 0.06));
      this.xpValue = 8; this.goldDrop = [0, 2];
      this.stats.res = Object.assign({}, boss.stats.res);
      this.facing = boss.facing; this.actT = rnd(1.4, 2.6); this.spd = boss.spd; this.arena = boss.arena;
      this.strafeDir = HM.rng.next() < 0.5 ? -1 : 1;
      if (HM.Rig && HM.Rig.create) {
        const ro = JSON.parse(JSON.stringify(boss.def.rigOpts || {}));
        const pal = (HM.Rig.defs && HM.Rig.defs[boss.def.rig] && HM.Rig.defs[boss.def.rig].pal) || ro.colors || {};
        ro.colors = {};   // copies are a shade sicklier: greener, duller
        for (const k in pal) if (Array.isArray(pal[k])) ro.colors[k] = pal[k].map((v, i) => v * (i === 1 ? 0.95 : 0.78));
        safe(() => HM.Rig.create(this, boss.def.rig, ro));
      }
    }
    D(m) { return this.boss.D(m) * 0.6; }
    aliveMinions() { return 0; }
    update(dt) {
      if (this.dead) { C.baseUpdate(this, dt); return; }
      this.runTimers(dt);
      const p = player();
      if (p) {
        const t = this.tgt(), d = M.dist(this.x, this.y, t.x, t.y), a = M.angle(this.x, this.y, t.x, t.y);
        if (!this.busy) {
          const radial = d > 140 ? 1 : d < 80 ? -1 : 0;
          this.vx = (Math.cos(a) * radial - Math.sin(a) * this.strafeDir * 0.6) * this.speed;
          this.vy = (Math.sin(a) * radial + Math.cos(a) * this.strafeDir * 0.6) * this.speed;
          this.turnTo(a, 6, dt);
        } else { this.vx = this.vy = 0; }
        this.actT -= dt;
        if (this.actT <= 0 && !this.busy) { this.actT = rnd(3.8, 5.6); this.act(t); }
      } else { this.vx = this.vy = 0; }
      this.poseUpkeep();
      C.baseUpdate(this, dt);
    }
    act(t) {
      this.busy = true;
      if (HM.rng.next() < 0.55) {
        const wind = 0.85;
        this.pose('special', 'shriek', wind + 0.5);
        if (HM.rng.next() < 0.5) bark(this, pick(['Unacceptable!', 'UNACCEPTABLE?', 'Un... acceptable...']), 1.2);
        this.tele({ shape: 'circle', x: this.x, y: this.y, r: 50, dur: wind, color: COL.sonic });
        this.later(wind, () => {
          wave(this, { x: this.x, y: this.y, r0: 16, r1: 340, speed: 210, band: 18, style: 'sonic', dmg: { amount: this.D(1), type: 'phys', knock: 160 } });
          sfx('shriek', { x: this.x, y: this.y, vol: 0.6, pitch: 1.2 }); this.busy = false;
        });
      } else {
        const x = t.x + rnd(-40, 40), y = t.y + rnd(-40, 40), flight = 0.85;
        this.pose('cast', 'forward', 0.6);
        this.tele({ shape: 'circle', x, y, r: 36, dur: flight, color: COL.acid });
        lob(this, x, y, flight, () => acidPuddle(this, x, y, 36, 4.5));
        this.later(0.5, () => { this.busy = false; });
      }
    }
    onDeath() {
      this.cancelAll(false);
      callFx('burst', this.x, this.y, 30, 'sugar', 26);
      blast(this, this.x, this.y, 40, 'acid');
      acidPuddle(this, this.x, this.y, 34, 4, this.boss.dead);
      if (HM.rng.next() < 0.6) bark(this, pick(['...not... the real one...', '...acceptable...?', 'Pop.']), 1.6);
    }
    draw() {
      if (!this.dead && HS[((this.t * 22) | 0) & 511] < 0.07) return;   // the tell: copies flicker out for a frame
      this.drawBody();
    }
  }

  // ===================================================================================================== patterns
  const DR = {}, LG = {}, IK = {}, FK = {}, LI = {};

  // ---------------------------------------------------------------- THE BONE DRAGON (Act I)
  DR.bite = function* (b) {
    const n = 1 + b.phase;
    for (let i = 0; i < n; i++) {
      const p = b.tgt();
      b.lockFacing = true;
      b.facing += M.clamp(M.angleDiff(b.facing, M.angle(b.x, b.y, p.x, p.y)), -1, 1);
      const wind = Math.max(0.24, b.w(0.36));
      b.tele({ shape: 'cone', x: b.x, y: b.y, ang: b.facing, half: 0.5, r: 165, dur: wind, color: COL.danger });
      b.strike(i % 2 ? 'claw' : 'bite', wind);
      yield wind;
      b.lunge(b.facing, 26);
      C.hitArc(b.x, b.y, b.facing, 0.5, 165, 1, { amount: b.D(1), type: 'phys', source: b, canCrit: false, knock: 200, hitstop: 0.06, shake: 6, status: [{ id: 'bleed', dur: 2, dps: b.D(0.05) }] });
      const m = b.mouth(); callFx('burst', m[0], m[1], 26, 'bone', 5); sfx('swing_heavy', { x: b.x, y: b.y });
      yield i === n - 1 ? b.w(0.55) : b.w(0.24);
    }
  };
  DR.tail = function* (b) {
    b.lockFacing = true;
    const back = b.facing + Math.PI, wind = b.tw(0.7);
    b.tele({ shape: 'cone', x: b.x, y: b.y, ang: back, half: 1.15, r: 170, dur: wind, color: COL.danger });
    b.strike('spin', wind);
    yield wind;
    C.hitArc(b.x, b.y, back, 1.15, 170, 1, { amount: b.D(1.2), type: 'phys', source: b, canCrit: false, knock: 460, hitstop: 0.07, shake: 8 });
    for (let k = -2; k <= 2; k++) { const a = back + k * 0.45; callFx('burst', b.x + Math.cos(a) * 120, b.y + Math.sin(a) * 120, 4, 'dust', 4); }
    sfx('swing_heavy', { x: b.x, y: b.y }); shakeAt(b.x, b.y, 4);
    yield b.w(0.6);
  };
  DR.breath = function* (b) {
    b.lockFacing = true;
    const p = b.tgt(); b.facing = M.angle(b.x, b.y, p.x, p.y);
    const range = 280, half = 0.42, wind = b.tw(0.95), m = b.mouth();
    b.tele({ shape: 'cone', x: m[0], y: m[1], ang: b.facing, half, r: range, dur: wind, color: COL.fire });
    const pd = wind / 0.3;                       // anticipation (rear back, inhale) = the telegraph
    b.pose('attack', 'breath', pd); b.holdPose = true;
    sfx('fire', { x: b.x, y: b.y });
    yield wind;
    const dur = 1.8;
    breath(b, { range, half, dur, turn: 0.45 * b.spd, zoneEvery: b.phase >= 3 ? 0.13 : 0.19, zoneLife: 3 + b.phase, oz: m[2] || 40, holdT: pd * 0.42 });
    yield dur;
    b.holdPose = false;
    yield b.w(0.7);
  };
  DR.gust = function* (b) {
    const r = 190, wind = b.tw(0.85);
    b.tele({ shape: 'circle', x: b.x, y: b.y, r, dur: wind, color: [0.95, 0.85, 0.65] });
    b.pose('cast', 'gust', wind + 0.45);
    yield wind;
    wave(b, { x: b.x, y: b.y, r0: b.radius, r1: r + 40, speed: 620, band: 32, style: 'gust', dmg: { amount: b.D(0.6), type: 'phys', knock: 640, hitstop: 0.05, shake: 6 } });
    for (let k = 0; k < 10; k++) { const a = (k / 10) * TAU; callFx('burst', b.x + Math.cos(a) * 60, b.y + Math.sin(a) * 60, 6, 'dust', 4); }
    sfx('swing_heavy', { x: b.x, y: b.y, pitch: 0.6 }); shakeAt(b.x, b.y, 6);
    yield b.w(0.45);
    if (b.phase >= 2) { // follow-up: meteors where the hero was thrown
      for (let k = 0; k < 3; k++) { const p = b.tgt(); const q = k ? arenaPoint(b, p.x, p.y, 50, 140) : [p.x + (p.vx || 0) * 0.5, p.y + (p.vy || 0) * 0.5]; meteor(b, q[0], q[1], { r: 44, dur: b.tw(1.05) }); yield b.w(0.15); }
    }
    yield b.w(0.5);
  };
  DR.orbs = function* (b) {
    b.pose('cast', 'rear', b.w(1.2));
    const p = b.tgt(), base = M.angle(b.x, b.y, p.x, p.y);
    orbLine(b, { dir: base, speed: 95 + 10 * b.phase, warm: b.tw(1) });
    if (b.phase >= 2) { yield b.w(1.3); orbLine(b, { dir: base + (HM.rng.next() < 0.5 ? 1 : -1) * Math.PI / 2, speed: 100, warm: b.tw(1) }); }
    yield b.w(1.2);
  };
  DR.meteors = function* (b) {
    b.pose('cast', 'rear', b.w(0.9));
    sfx('bossRoar', { x: b.x, y: b.y, vol: 0.45, pitch: 1.3 });
    yield b.w(0.35);
    const n = [5, 7, 9][b.phase - 1];
    for (let i = 0; i < n; i++) {
      const p = b.tgt();
      const q = i % 3 === 0 ? [p.x + (p.vx || 0) * 0.35, p.y + (p.vy || 0) * 0.35] : arenaPoint(b, p.x, p.y, 90, 230);
      meteor(b, q[0], q[1], { r: 46, dur: b.tw(1.15), dmg: 1.25, zone: b.phase >= 2 ? 3 : 0 });
      yield b.w(0.17);
    }
    yield b.w(0.8);
  };
  DR.thralls = function* (b) {
    b.pose('cast', 'summon', b.w(1.1));
    sfx('bone_break', { x: b.x, y: b.y });
    summon(b, b.phase >= 3 ? ['thrall', 'archer'] : 'thrall', b.phase >= 3 ? 3 : 2, { cap: 4, fallback: 'thrall', color: COL.bone, rise: true });
    yield b.w(1.3);
  };
  // phase 3: the field never stops burning — a new line of orbs every few seconds
  DR.endless = function* (b) {
    yield 2.2;
    for (let k = 0; ; k++) {
      const p = b.tgt(), base = M.angle(b.x, b.y, p.x, p.y);
      orbLine(b, { dir: k % 2 ? base + (HM.rng.next() < 0.5 ? 1 : -1) * Math.PI / 2 : base, speed: 92, warm: 1.0, gapOff: rnd(-160, 160) });
      yield 6.2;
    }
  };

  // ---------------------------------------------------------------- THE EARL OF LEMONGRAB (Act II)
  LG.shriek = function* (b) {
    const wind = b.tw(0.8);
    b.pose('special', 'shriek', wind + 0.4 + b.phase * b.w(1.1));
    bark(b, pick(b.def.lines.shriek), 1.3);
    b.tele({ shape: 'circle', x: b.x, y: b.y, r: 64, dur: wind, color: COL.sonic });
    yield wind;
    for (let i = 0; i < b.phase; i++) {
      sfx('shriek', { x: b.x, y: b.y });
      const gaps = i % 2 ? [{ a: rnd(0, TAU), h: 0.34 }] : null;
      wave(b, { x: b.x, y: b.y, r0: b.radius + 6, r1: 520, speed: 240 + 25 * b.phase, band: 20, style: 'sonic', gaps, dmg: { amount: b.D(1.1), type: 'phys', knock: 220, hitstop: 0.05 } });
      shakeAt(b.x, b.y, 4);
      yield b.w(1.1);
    }
    yield b.w(0.3);
  };
  LG.juice = function* (b) {
    const n = [3, 4, 5][b.phase - 1];
    b.pose('cast', 'forward', b.w(0.45) + n * b.w(0.16));
    if (HM.rng.next() < 0.5) bark(b, pick(b.def.lines.juice), 1.8);
    yield b.w(0.35);
    for (let i = 0; i < n; i++) {
      const p = b.tgt();
      const q = i === 0 ? arenaPoint(b, p.x + (p.vx || 0) * 0.4, p.y + (p.vy || 0) * 0.4, 0, 1) : arenaPoint(b, p.x, p.y, 70, 200);
      const flight = Math.max(0.65, 0.9 / Math.sqrt(b.spd));
      b.tele({ shape: 'circle', x: q[0], y: q[1], r: 42, dur: flight, color: COL.acid });
      lob(b, q[0], q[1], flight, () => {
        hurt(b, (a) => M.dist(q[0], q[1], a.x, a.y) <= 42 + a.radius * 0.5, { amount: b.D(0.6), type: 'poison', knock: 90 }, null, q[0], q[1]);
        acidPuddle(b, q[0], q[1], 42, 5 + b.phase);
        callFx('burst', q[0], q[1], 6, 'poison', 12); sfx('poison', { x: q[0], y: q[1] });
      });
      sfx('swing', { x: b.x, y: b.y, pitch: 1.3 });
      yield b.w(0.16);
    }
    yield b.w(0.5);
  };
  LG.lackeys = function* (b) {
    b.pose('cast', 'summon', b.w(1));
    bark(b, pick(b.def.lines.lackeys), 2);
    summon(b, 'husk', b.phase >= 2 ? 3 : 2, { cap: 5, name: 'Lemon Lackey', tint: [1, 0.9, 0.35], color: COL.acid, burst: 'sugar', sfx: 'zombie' });
    yield b.w(1.2);
  };
  LG.charge = function* (b) {
    for (let i = 0; i < b.phase; i++) {
      const p = b.tgt();
      const ang = M.angle(b.x, b.y, p.x, p.y), len = Math.min(460, M.dist(b.x, b.y, p.x, p.y) + 150);
      b.lockFacing = true; b.facing = ang;
      const wind = b.tw(0.75);
      b.tele({ shape: 'rect', x: b.x + Math.cos(ang) * len / 2, y: b.y + Math.sin(ang) * len / 2, ang, len, w: 42, dur: wind, color: COL.danger });
      b.pose('cast', 'forward', wind);
      if (i === 0) bark(b, pick(b.def.lines.charge), 1.6);
      yield wind;
      const sp = 560, once = new Set(), sx = b.x, sy = b.y;
      b.pose('attack', 'spin', len / sp + 0.15); b.holdPose = true;
      b.moveMode = 'custom'; b.vx = Math.cos(ang) * sp; b.vy = Math.sin(ang) * sp;
      sfx('swing_heavy', { x: b.x, y: b.y });
      let lastD = -1, stuck = 0, tt = 0;
      while (true) {
        C.hitCircle(b.x, b.y, b.radius + 14, 1, { amount: b.D(1.3), type: 'phys', source: b, canCrit: false, knock: 340, dir: ang, hitstop: 0.07, shake: 7 }, { once });
        const d = M.dist(sx, sy, b.x, b.y);
        if (d >= len || tt > len / sp + 0.4) break;
        stuck = d - lastD < 1 ? stuck + 1 : 0; lastD = d;
        if (stuck > 3) break;
        if (HM.rng.next() < 0.35) callFx('ghost', b, 0.22);
        if (HM.rng.next() < 0.5) callFx('burst', b.x, b.y, 2, 'dust', 2);
        yield FRAME; tt += 1 / 60;
      }
      b.vx = b.vy = 0; b.moveMode = 'hold'; b.holdPose = false;
      b.pose('stun', null, b.w(0.6));   // stumble: the punish window
      callFx('burst', b.x, b.y, 4, 'dust', 10); shakeAt(b.x, b.y, 3);
      yield b.w(0.6);
    }
  };
  LG.tantrum = function* (b) {
    bark(b, pick(b.def.lines.tantrum), 1.6);
    for (let i = 0; i < 3; i++) {
      const wind = b.tw(0.55), r = 95;
      b.tele({ shape: 'circle', x: b.x, y: b.y, r, dur: wind, color: COL.danger });
      b.strike('slam', wind);
      yield wind;
      hurt(b, (a) => M.dist(b.x, b.y, a.x, a.y) <= r + a.radius * 0.5, { amount: b.D(1), type: 'phys', knock: 300, hitstop: 0.06, shake: 6 });
      wave(b, { x: b.x, y: b.y, r0: 20, r1: r + 20, speed: 500, band: 16, style: 'gust' });
      if (b.phase >= 3) acidPuddle(b, b.x + rnd(-30, 30), b.y + rnd(-20, 20), 30, 4);
      sfx('explode', { x: b.x, y: b.y, vol: 0.6, pitch: 1.4 }); shakeAt(b.x, b.y, 5);
      yield b.w(0.22);
    }
    yield b.w(0.5);
  };
  function spawnDecoys(b, n) {
    const G = HM.Game; if (!G) return;
    for (let k = 0; k < n; k++) {
      const a = b.facing + (k % 2 ? 1 : -1) * 1.7 + rnd(-0.5, 0.5);
      let x = b.x + Math.cos(a) * 85, y = b.y + Math.sin(a) * 85;
      if (solid(x, y)) { x = b.x + rnd(-20, 20); y = b.y + rnd(-20, 20); }
      const d = new Decoy(b, x, y); G.spawn(d); b.decoys.push(d);
      callFx('burst', x, y, 30, 'sugar', 26); blast(b, x, y, 36, 'acid');
    }
    // the shell game: the real Earl swaps places with one of his copies
    const live = b.decoys.filter((d) => !d.dead);
    if (live.length && HM.rng.next() < 0.75) {
      const d = pick(live); const tx = b.x, ty = b.y;
      b.x = d.x; b.y = d.y; d.x = tx; d.y = ty;
      callFx('burst', b.x, b.y, 30, 'sugar', 18);
    }
    sfx('sonic', { x: b.x, y: b.y });
  }

  // ---------------------------------------------------------------- THE ICE KING (Act III)
  IK.bolts = function* (b) {
    const volleys = b.phase >= 2 ? 2 : 1;
    for (let v = 0; v < volleys; v++) {
      const p = b.tgt(), base = M.angle(b.x, b.y, p.x, p.y);
      const n = [5, 7, 9][b.phase - 1], spread = 0.95 + 0.12 * b.phase, stepA = spread / (n - 1);
      const wind = b.tw(0.5), off = v % 2 ? stepA * 0.5 : 0;
      b.pose('cast', 'forward', wind + 0.2);
      if (v === 0 && HM.rng.next() < 0.35) bark(b, pick(b.def.lines.bolts), 1.5);
      for (let k = 0; k < n; k++) b.tele({ shape: 'line', x: b.x, y: b.y, ang: base - spread / 2 + k * stepA + off, len: 200, w: 10, dur: wind, color: COL.ice });
      yield wind;
      for (let k = 0; k < n; k++) bolt(b, b.x, b.y, 46, base - spread / 2 + k * stepA + off, { look: 'ice', speed: 250, dmg: 0.65, type: 'ice', status: [{ id: 'chill', dur: 1.6 }], color: COL.ice, burst: 'ice', light: [55, 0.55, 0.8, 1] });
      sfx('ice', { x: b.x, y: b.y });
      yield b.w(0.45);
    }
    yield b.w(0.3);
  };
  IK.spikes = function* (b) {
    const waves = b.phase >= 2 ? 2 : 1;
    for (let v = 0; v < waves; v++) {
      const p = b.tgt(), base = M.angle(b.x, b.y, p.x, p.y);
      const offs = b.phase >= 3 ? (v ? [-0.5, -0.17, 0.17, 0.5] : [-0.66, -0.33, 0, 0.33, 0.66]) : v ? [-0.2, 0.2] : [-0.42, 0, 0.42];
      const wind = b.tw(0.85);
      b.pose('cast', 'raise', wind + 0.2);
      sfx('ice', { x: b.x, y: b.y, pitch: 0.7 });
      for (const o of offs) spikeLine(b, { x: b.x, y: b.y, ang: base + o, len: 430, step: 26, delay: 0.028, warn: wind, r: 18, style: 'ice', color: COL.ice, hold: 0.75, hMin: 30, hMax: 52, spec: { amount: b.D(1.0), type: 'ice', knock: 150, hitstop: 0.06, shake: 5, status: [{ id: 'chill', dur: 2 }] } });
      yield wind + b.w(0.55);
    }
    yield b.w(0.4);
  };
  IK.penguins = function* (b) {
    b.pose('cast', 'summon', b.w(1));
    sfx('wenk', { x: b.x, y: b.y });
    bark(b, pick(b.def.lines.penguins), 2);
    summon(b, 'penguin', b.phase >= 3 ? 4 : 3, { cap: 6, color: COL.ice, burst: 'ice', sfx: 'wenk' });
    yield b.w(1.2);
  };
  IK.blizzard = function* (b) {
    const p = b.tgt(), r = 135, wind = b.tw(1);
    b.pose('channel', 'channel', wind + 0.6);
    bark(b, pick(b.def.lines.blizzard), 2);
    b.tele({ shape: 'circle', x: p.x, y: p.y, r, dur: wind, color: COL.ice });
    yield wind;
    const life = 6 + b.phase;
    elemZone(b, p.x, p.y, r, life, b.D(0.2), 'ice', {
      update(z, dt) { const q = player(); if (q && !z.dying) { const a = M.angle(z.x, z.y, q.x, q.y), d = M.dist(z.x, z.y, q.x, q.y); if (d > 6) { z.x += Math.cos(a) * 36 * dt; z.y += Math.sin(a) * 36 * dt; } } },
    });
    snowstorm(b, life + 1.5);
    sfx('ice', { x: p.x, y: p.y, pitch: 0.5 });
    yield b.w(0.8);
  };
  IK.beam = function* (b) {
    const sweeps = b.phase >= 3 ? 2 : 1;
    const p = b.tgt(), a0 = M.angle(b.x, b.y, p.x, p.y), dir = HM.rng.next() < 0.5 ? -1 : 1, sweep = 1.9 * dir;
    let start = a0 - sweep / 2;
    b.lockFacing = true;
    for (let s = 0; s < sweeps; s++) {
      const sw = s ? -sweep : sweep, wind = s ? b.tw(0.5) : b.tw(0.9);
      b.facing = start;
      b.tele({ shape: 'line', x: b.x, y: b.y, ang: start, len: 520, w: 22, dur: wind, color: COL.ice });
      b.pose('cast', 'raise', wind);
      if (s === 0) { sfx('ice', { x: b.x, y: b.y, pitch: 1.4 }); if (HM.rng.next() < 0.5) bark(b, pick(b.def.lines.beam), 1.6); }
      yield wind;
      const dur = b.w(1.8);
      b.pose('channel', 'forward', dur); b.holdPose = true;
      beam(b, { ang0: start, sweep: sw, dur, len: 520, w: 18, style: 'ice', off: 8, z: b.height * 0.95, tick: 0.25, spec: { amount: b.D(0.4), type: 'ice', knock: 60, hitstop: 0.02, shake: 2, status: [{ id: 'chill', dur: 1.5 }] } });
      yield dur;
      b.holdPose = false;
      start = start + sw;
    }
    yield b.w(0.6);
  };
  // phase 3: the frozen floor bites anyone who stands still
  IK.frostPatches = function* (b) {
    yield 1.6;
    for (;;) {
      const p = b.tgt(), x = p.x, y = p.y, r = 54, warn = Math.max(0.95, 1.2 / Math.sqrt(b.spd));
      b.tele({ shape: 'circle', x, y, r, dur: warn, color: COL.ice });
      const pts = [];
      for (let k = 0; k < 7; k++) { const a = (k / 7) * TAU + rnd(-0.2, 0.2), d = k ? rnd(14, r * 0.85) : 0; pts.push([x + Math.cos(a) * d, y + Math.sin(a) * d, warn + k * 0.02]); }
      spikeSet(b, pts, { r: 16, style: 'ice', hold: 0.6, hMin: 26, hMax: 44, spec: { amount: b.D(1), type: 'ice', knock: 120, hitstop: 0.05, shake: 4, status: [{ id: 'chill', dur: 1.6 }] } });
      yield 3.3;
    }
  };
  IK.mutter = function* (b) {
    yield 2.6;
    const lines = b.def.lines.betty.slice(); let i = 0;
    for (;;) { bark(b, lines[i++ % lines.length], 3.6); yield rnd(7.5, 11); }
  };

  // ---------------------------------------------------------------- THE FLAME KING (Act IV)
  FK.slam = function* (b) {
    const p = b.tgt(); b.lockFacing = true; b.facing = M.angle(b.x, b.y, p.x, p.y);
    const cx = b.x + Math.cos(b.facing) * 72, cy = b.y + Math.sin(b.facing) * 72, r = 100, wind = b.tw(0.75);
    b.tele({ shape: 'circle', x: cx, y: cy, r, dur: wind, color: COL.fire });
    b.strike('overhead', wind);
    yield wind;
    hurt(b, (a) => M.dist(cx, cy, a.x, a.y) <= r + a.radius * 0.5, { amount: b.D(1.5), type: 'fire', knock: 320, hitstop: 0.08, shake: 9, status: [{ id: 'burn', dur: 3, dps: b.D(0.08) }] }, null, cx, cy);
    blast(b, cx, cy, r, 'fire'); callFx('decal', cx, cy, 'scorch', r, 10);
    elemZone(b, cx, cy, 46, 3.5, b.D(0.4), 'fire');
    sfx('explode', { x: cx, y: cy }); shakeAt(cx, cy, 8);
    yield b.w(0.65);
  };
  FK.fissure = function* (b) {
    const reps = b.phase >= 2 ? 2 : 1;
    for (let rI = 0; rI < reps; rI++) {
      const p = b.tgt(), ang = M.angle(b.x, b.y, p.x, p.y);
      b.lockFacing = true; b.facing = ang;
      const prongs = [3, 5, 5][b.phase - 1], spread = [0.5, 0.75, 0.9][b.phase - 1], len = 340 + 40 * b.phase, wind = b.tw(0.75);
      b.strike('slam', wind);
      if (rI === 0 && HM.rng.next() < 0.4) bark(b, pick(b.def.lines.fissure), 1.6);
      for (let k = 0; k < prongs; k++) {
        const a = ang + (prongs === 1 ? 0 : spread * ((k / (prongs - 1)) * 2 - 1));
        b.tele({ shape: 'line', x: b.x, y: b.y, ang: a, len, w: 44, dur: wind, color: COL.fire });
      }
      yield wind;
      const once = new Set(), ox = b.x, oy = b.y;
      fissure(b, ox, oy, ang, prongs, spread, len, (pts) => {
        for (const q of pts || []) {
          const x = Array.isArray(q) ? q[0] : q.x, y = Array.isArray(q) ? q[1] : q.y;
          if (x === undefined) continue;
          hurt(b, (a) => M.dist(x, y, a.x, a.y) <= 16 + a.radius * 0.5, { amount: b.D(1.3), type: 'fire', knock: 220, hitstop: 0.07, shake: 7, status: [{ id: 'burn', dur: 3, dps: b.D(0.09) }] }, once, x, y);
        }
      });
      sfx('explode', { x: b.x, y: b.y }); shakeAt(b.x, b.y, 7);
      yield b.w(0.95);
    }
    yield b.w(0.3);
  };
  FK.meteorRain = function* (b) {
    b.pose('cast', 'raise', b.w(1));
    if (HM.rng.next() < 0.5) bark(b, pick(b.def.lines.meteors), 1.8);
    sfx('fire', { x: b.x, y: b.y, pitch: 0.6 });
    yield b.w(0.35);
    const n = [8, 11, 14][b.phase - 1];
    for (let i = 0; i < n; i++) {
      const p = b.tgt();
      const q = i % 3 === 0 ? [p.x + (p.vx || 0) * 0.4, p.y + (p.vy || 0) * 0.4] : i % 3 === 1 ? arenaPoint(b, p.x, p.y, 100, 260) : arenaPoint(b);
      meteor(b, q[0], q[1], { r: 52, dur: b.tw(1.25), dmg: 1.3, zone: 3 });
      yield b.w(0.17);
    }
    yield b.w(0.7);
  };
  FK.lavaWaves = function* (b) {
    const wind = b.tw(0.85);
    b.tele({ shape: 'circle', x: b.x, y: b.y, r: 70, dur: wind, color: COL.fire });
    b.strike('slam', wind);
    yield wind;
    const n = [2, 3, 3][b.phase - 1];
    let g0 = rnd(0, TAU);
    for (let i = 0; i < n; i++) {
      g0 += rnd(-0.35, 0.35);
      const gaps = [{ a: g0, h: 0.24 }, { a: g0 + Math.PI + rnd(-0.6, 0.6), h: 0.24 }];
      wave(b, { x: b.x, y: b.y, r0: b.radius + 6, r1: 640, speed: 190 + 20 * b.phase, band: 24, style: 'lava', gaps, dmg: { amount: b.D(0.95), type: 'fire', knock: 200, hitstop: 0.05, shake: 5, status: [{ id: 'burn', dur: 2.5, dps: b.D(0.08) }] } });
      sfx('explode', { x: b.x, y: b.y, vol: 0.7, pitch: 0.7 }); shakeAt(b.x, b.y, 5);
      if (i < n - 1) { b.pose('attack', 'slam', b.w(0.6)); yield b.w(1.0); }
    }
    yield b.w(0.6);
  };
  FK.pillars = function* (b) {
    b.pose('cast', 'forward', b.w(1));
    const n = [4, 5, 6][b.phase - 1], p0 = b.tgt(), a0 = rnd(0, TAU);
    for (let i = 0; i < n; i++) {
      const p = b.tgt();
      const q = i === 0 ? [p.x + (p.vx || 0) * 0.3, p.y + (p.vy || 0) * 0.3] : arenaPoint(b, p0.x + Math.cos(a0 + i * 1.3) * rnd(80, 170), p0.y + Math.sin(a0 + i * 1.3) * rnd(80, 170), 0, 30);
      pillar(b, q[0], q[1], { r: 34, warn: b.tw(0.95), life: 1.4 });
      yield b.w(0.12);
    }
    yield b.w(0.8);
  };
  FK.hounds = function* (b) {
    b.pose('cast', 'summon', b.w(1));
    bark(b, pick(b.def.lines.hounds), 1.8);
    summon(b, 'cinder', b.phase >= 3 ? 3 : 2, { cap: 4, color: COL.fire, burst: 'ember', sfx: 'fire' });
    yield b.w(1.2);
  };

  // ---------------------------------------------------------------- THE LICH (Act V)
  LI.witchfire = function* (b) {
    const p = b.tgt(), base = M.angle(b.x, b.y, p.x, p.y), n = [3, 5, 7][b.phase - 1], spread = 0.35 + 0.12 * n;
    const wind = b.tw(0.5);
    b.pose('cast', 'forward', wind + 0.25);
    b.tele({ shape: 'cone', x: b.x, y: b.y, ang: base, half: spread / 2, r: 120, dur: wind, color: COL.witch });
    yield wind;
    for (let k = 0; k < n; k++) {
      const a = base - spread / 2 + (n === 1 ? 0.5 : k / (n - 1)) * spread;
      bolt(b, b.x, b.y, 60, a, { look: 'witchfire', speed: 205, dmg: 0.85, type: 'shadow', color: COL.witch, homing: 1.05 + 0.15 * b.phase, life: 3.2, burst: 'witchfire', light: [70, 0.3, 1, 0.45] });
    }
    sfx('fireball', { x: b.x, y: b.y, pitch: 0.7 });
    yield b.w(0.9);
  };
  LI.doom = function* (b) {
    const wind = b.tw(1.1), r = 64, marks = b.phase >= 3 ? 2 : 1;
    b.pose('cast', 'raise', wind + 0.2);
    bark(b, pick(b.def.lines.doom), 1.8);
    for (let k = 0; k < marks; k++) {
      const p = b.tgt();
      const x = k ? p.x + (p.vx || 0) * 0.9 : p.x, y = k ? p.y + (p.vy || 0) * 0.9 : p.y;
      b.tele({ shape: 'circle', x, y, r, dur: wind, color: COL.witch });
      sigil(b, x, y, r, wind);
      b.later(wind, () => {
        hurt(b, (a) => M.dist(x, y, a.x, a.y) <= r + a.radius * 0.5, { amount: b.D(0.5), type: 'shadow', hitstop: 0.05, shake: 5, status: [{ id: 'doom', dur: 6, dps: b.D(0.12) }] }, null, x, y);
        blast(b, x, y, r, 'witch'); callFx('burst', x, y, 10, 'witchfire', 18); callFx('decal', x, y, 'witch', r, 6);
        sfx('lich_laugh', { x: b.x, y: b.y, vol: 0.6 });
      });
      if (k === 0 && marks > 1) yield b.w(0.35);
    }
    yield wind + b.w(0.4);
  };
  LI.walls = function* (b) {
    const p = b.tgt(), a = rnd(0, TAU), ca = Math.cos(a), sa = Math.sin(a), wind = b.tw(0.9);
    b.pose('cast', 'raise', wind + 0.2);
    sfx('bone_break', { x: b.x, y: b.y, pitch: 0.6 });
    const off = 85, half = 170, walls = [];
    // a corridor of bone around the hero...
    walls.push({ x: p.x - ca * half - sa * off, y: p.y - sa * half + ca * off, ang: a });
    walls.push({ x: p.x - ca * half + sa * off, y: p.y - sa * half - ca * off, ang: a });
    // ...then cross-walls with a gap in the middle (always a way out)
    if (b.phase >= 2) walls.push({ x: p.x + ca * 150 - sa * half, y: p.y + sa * 150 + ca * half, ang: a - Math.PI / 2, gap: true });
    if (b.phase >= 3) walls.push({ x: p.x - ca * 150 + sa * half, y: p.y - sa * 150 - ca * half, ang: a + Math.PI / 2, gap: true });
    for (const w of walls) {
      spikeLine(b, { x: w.x, y: w.y, ang: w.ang, len: half * 2, step: 21, delay: 0.018, warn: wind, r: 15, style: 'bone', color: COL.witch, hold: 0.6, persist: 4.5, contact: 0.3, hMin: 26, hMax: 40,
        gapFrom: w.gap ? half - 45 : undefined, gapTo: w.gap ? half + 45 : undefined,
        spec: { amount: b.D(1), type: 'phys', knock: 200, hitstop: 0.06, shake: 5 } });
    }
    yield wind + b.w(0.6);
  };
  LI.thralls = function* (b) {
    b.pose('cast', 'summon', b.w(1.1));
    bark(b, pick(b.def.lines.thralls), 2);
    summon(b, 'knight', 2, { cap: 3, name: 'Thrall-Knight', color: COL.witch, burst: 'witchfire', sfx: 'bone_break', rise: true });
    yield b.w(1.3);
  };
  LI.drain = function* (b) {
    const p = b.tgt(), a = M.angle(b.x, b.y, p.x, p.y), wind = b.tw(0.85);
    b.lockFacing = true; b.facing = a;
    b.tele({ shape: 'line', x: b.x, y: b.y, ang: a, len: 480, w: 24, dur: wind, color: COL.witch });
    b.pose('cast', 'forward', wind);
    if (HM.rng.next() < 0.6) bark(b, pick(b.def.lines.drain), 1.8);
    yield wind;
    const dur = 2.4;
    b.pose('channel', 'forward', dur); b.holdPose = true;
    beam(b, { ang0: a, track: true, turn: 0.42 * b.spd, dur, len: 480, w: 20, style: 'witch', off: 10, z: b.height * 0.7, tick: 0.2, drain: 2, spec: { amount: b.D(0.2), type: 'shadow', knock: 30, hitstop: 0.01, shake: 1.5 } });
    sfx('lich_laugh', { x: b.x, y: b.y, vol: 0.5, pitch: 0.8 });
    yield dur;
    b.holdPose = false;
    yield b.w(0.6);
  };
  LI.pulse = function* (b) {
    const wind = Math.max(0.8, b.tw(1.0));   // a get-out-of-the-circle move: melee needs the time to leave
    b.pose('cast', 'channel', wind + 0.3);
    b.tele({ shape: 'circle', x: b.x, y: b.y, r: 90, dur: wind, color: COL.witch });
    if (HM.rng.next() < 0.5) bark(b, pick(b.def.lines.pulse), 1.8);
    flashLight(b, b.x, b.y, 30, 260, COL.witch, 1.4, wind);
    yield wind;
    const n = [2, 2, 3][b.phase - 1];
    let g0 = rnd(0, TAU);
    for (let i = 0; i < n; i++) {
      g0 += rnd(-0.5, 0.5);
      wave(b, { x: b.x, y: b.y, r0: b.radius + 6, r1: 720, speed: 200, band: 22, style: 'witch', gaps: [{ a: g0, h: [0.38, 0.32, 0.28][b.phase - 1] }], dmg: { amount: b.D(0.8), type: 'shadow', knock: 230, hitstop: 0.05, shake: 6 } });
      sfx('sonic', { x: b.x, y: b.y, pitch: 0.5 }); shakeAt(b.x, b.y, 5); R.flash(0.2, 0.9, 0.35, 0.08);
      if (i < n - 1) yield Math.max(1.05, b.w(1.45));   // never faster than a dodge roll recharges
    }
    yield b.w(0.6);
  };
  // phase 3: green fire breaks out across the arena (telegraphed), capped so the floor never fills up
  LI.greenFire = function* (b) {
    yield 1.4;
    for (;;) {
      const live = b.hz.filter((z) => !z.dead && !z.dying && z.kind === 'witchfire').length;
      const n = Math.min(3, 12 - live);
      for (let k = 0; k < n; k++) {
        const p = b.tgt();
        const q = k === 0 ? arenaPoint(b, p.x, p.y, 40, 110) : arenaPoint(b);
        b.tele({ shape: 'circle', x: q[0], y: q[1], r: 38, dur: 0.95, color: COL.witch });
        b.later(0.95, () => { elemZone(b, q[0], q[1], 36, 6, b.D(0.45), 'witchfire'); callFx('burst', q[0], q[1], 6, 'witchfire', 10); });
      }
      yield 2.6;
    }
  };

  // ===================================================================================================== boss defs
  const defs = {
    boneDragon: {
      id: 'boneDragon', act: 1, displayName: 'The Bone Dragon', title: 'Wyrm of the Ossuary Road',
      rig: 'boneDragon', rigOpts: { scale: 1 },
      hp: 1700, dmg: 11, armor: 15, res: { fire: 0.25, poison: 0.2, holy: -0.25 },
      radius: 30, height: 160, mass: 60, speed: 62, turn: 2.2, range: 125, aggro: 410, mouth: 100,
      xp: 160, gold: [60, 90], color: [1, 0.5, 0.15], burst: 'bone', blast: 'fire', move: 'chase', rest: 0.85, auraStyle: 'fire',
      light: { r: 150, c: [1, 0.45, 0.12], k: 0.7, z: 50, phase: 3 }, flicker: true,   // the marrow only burns in phase 3
      phaseToast: ['Bone thralls claw their way out of the barrow-earth.', "The dragon's marrow catches fire. The field begins to burn."],
      deathSub: 'Its marrow cools. The old road sleeps.',
      lines: { intro: [], p2: [], p3: [], death: [], idle: [] },
      patterns: {
        bite:    { weight: [4, 3, 3], maxR: 200, run: DR.bite },
        tail:    { weight: (b, p) => (Math.abs(M.angleDiff(b.facing, M.angle(b.x, b.y, p.x, p.y))) > 1.9 ? 9 : 1.2), maxR: 190, cd: 3, run: DR.tail },
        breath:  { weight: [3, 3, 3], maxR: 320, cd: 6, run: DR.breath },
        gust:    { weight: [1.5, 2, 2], maxR: 200, cd: 7, run: DR.gust },
        orbs:    { weight: [1.5, 2, 1], cd: 12, run: DR.orbs },
        meteors: { weight: [2, 2.5, 3], cd: 7, run: DR.meteors },
        thralls: { phases: [2, 3], weight: [2, 1.5], cd: 18, cond: (b) => b.aliveMinions() < 3, run: DR.thralls },
      },
      onPhase(b, ph) {
        if (ph === 2) summon(b, 'thrall', 3, { cap: 4, color: COL.bone, rise: true });
        if (ph === 3) b.bgTask('endless', DR.endless(b));
      },
      tick(b, dt) {
        if (b.phase < 3) return;
        b.data.emberT = (b.data.emberT || 0) - dt;
        if (b.data.emberT <= 0) { b.data.emberT = 0.09; callFx('burst', b.x + rnd(-b.radius, b.radius), b.y + rnd(-10, 10), rnd(20, b.height), 'ember', 2); }
      },
    },

    lemongrab: {
      id: 'lemongrab', act: 2, displayName: 'Earl of Lemongrab', title: 'Sovereign of the Sour Court',
      rig: 'lemongrab', rigOpts: { scale: 1 },
      hp: 2500, dmg: 10, armor: 8, res: { poison: 0.5 },
      radius: 14, height: 118, mass: 30, speed: 92, turn: 6, range: 80, aggro: 380,
      xp: 220, gold: [90, 130], color: [1, 0.92, 0.3], burst: 'sugar', blast: 'acid', move: 'chase', rest: 0.7, auraStyle: 'fire',
      light: { r: 85, c: [1, 0.9, 0.35], k: 0.35, z: 60 },
      phaseToast: ['The Earl is SOUR. The Earl is SOURER.', 'There are more of him now. Only one of them is real.'],
      toastColor: [1, 0.92, 0.35],
      deathSub: '...acceptable.',
      lines: {
        intro: ['WHO let a sugar-thief into MY castle?!', 'You track rot on my floors. UNACCEPTABLE.'],
        idle: ['Everything here is mine. The rot is mine. The silence is MINE.', 'I counted the bricks. You moved one.', 'Sour is the only honest flavor!', 'Bow! Lower! LOWER than that!'],
        shriek: ['UNACCEPTABLE!', 'UNACCEPTABLE!!', 'UN-AC-CEPT-ABLE!'],
        juice: ['Juice for the disobedient!', 'Drink it. It stings. GOOD.'],
        lackeys: ['Lackeys! Remove this... THING!', 'Seize them, my sour little lambs!'],
        charge: ['OUT! OUT OUT OUT!', 'I will remove you MYSELF!'],
        tantrum: ['NO! NO! NO!', 'I am the EARL!'],
        p2: ['You have made me sour. SOURER!', 'Dungeon! Dungeon forever and a day!'],
        p3: ['There should be more of me. There should ALWAYS be more of me!'],
        death: ['This is... deeply... unaccep—'],
      },
      patterns: {
        shriek:  { weight: [3, 3, 3], cd: 4, run: LG.shriek },
        juice:   { weight: [3, 3, 2.5], cd: 5, run: LG.juice },
        lackeys: { weight: [2, 1.5, 1.5], cd: 16, cond: (b) => b.aliveMinions() < 4, run: LG.lackeys },
        charge:  { weight: [2.5, 3, 3], minR: 110, cd: 4, run: LG.charge },
        tantrum: { phases: [2, 3], weight: [2, 2], maxR: 160, cd: 6, run: LG.tantrum },
      },
      onPhase(b, ph) {
        if (ph === 2) summon(b, 'husk', 2, { cap: 5, name: 'Lemon Lackey', tint: [1, 0.9, 0.35], color: COL.acid, burst: 'sugar', sfx: 'zombie' });
        if (ph === 3) { b.later(0.9, () => spawnDecoys(b, 2)); b.data.decoyT = 22; }
      },
      tick(b, dt) {
        if (b.phase < 3 || b.state !== 'fight') return;
        b.data.decoyT -= dt;
        if (b.data.decoyT <= 0) {
          b.data.decoyT = 22;
          const live = b.decoys.filter((d) => !d.dead).length;
          if (live < 2) { spawnDecoys(b, 2 - live); bark(b, 'More of me! MORE!', 1.8); }
        }
      },
      onDeath(b) { for (let k = 0; k < 6; k++) acidPuddle(b, b.x + rnd(-60, 60), b.y + rnd(-45, 45), rnd(24, 36), 3, true); callFx('burst', b.x, b.y, 40, 'sugar', 50); },
    },

    iceKing: {
      id: 'iceKing', act: 3, displayName: 'The Ice King', title: 'What the Crown Kept',
      rig: 'iceKing', rigOpts: { scale: 1.1 },
      hp: 3100, dmg: 10, armor: 6, res: { ice: 0.6, fire: -0.25 },
      radius: 14, height: 108, mass: 25, speed: 80, turn: 6, range: 200, aggro: 420, hover: 7,
      xp: 280, gold: [120, 170], color: [0.6, 0.85, 1], burst: 'ice', blast: 'ice', move: 'kite', rest: 0.8, auraStyle: 'ice',
      light: { r: 120, c: [0.55, 0.8, 1], k: 0.5, z: 70 },
      phaseToast: ['Penguins wake in the drifts. The King will not be alone.', 'The floor freezes over. The King is talking to someone who is not there.'],
      deathSub: 'The crown falls silent.',
      lines: {
        intro: ['Oh! A guest! Nobody visits anymore. Will you stay? Stay forever?', 'Shh. The crown is talking. It says you look cold.'],
        idle: ['I used to know a song about this.', 'Everything is quieter frozen. Better. Quieter.', 'Gunter, stop staring.'],
        bolts: ['Freeze, freeze, FREEZE!', 'Hold still, I am making you beautiful!'],
        penguins: ['Gunter! Wake the little ones!', 'Come, my flightless soldiers!'],
        blizzard: ['Snow on everything! Snow on everyone!', 'Let the sky come down!'],
        beam: ['Crown! Show them!', 'Look into the light. It is so cold.'],
        p2: ['No, no, NO. You cannot leave. Nobody leaves.'],
        p3: ['Betty? ...No. No, you are not her.'],
        betty: [
          'Betty? Betty, is that you under the snow?',
          'I wrote your name in the frost on every wall. Every wall, Betty.',
          'The crown says you were never real. The crown lies. Doesn\'t it?',
          'Don\'t look at me, Betty. Not like this. Not with these hands.',
          'I kept the glasses. Whose glasses? Mine. ...Mine?',
          'Somebody hum it. I lost the tune. I lost the—',
          'A thousand years, Betty. I counted every one. I think I counted.',
        ],
        death: ['Warm... it is so warm... Betty, I remembered your—'],
      },
      patterns: {
        bolts:    { weight: [4, 3, 3], cd: 2.5, run: IK.bolts },
        spikes:   { weight: [3, 3, 3], cd: 5, run: IK.spikes },
        penguins: { weight: [2, 2, 1.5], cd: 16, cond: (b) => b.aliveMinions() < 4, run: IK.penguins },
        blizzard: { weight: [1.5, 2, 2], cd: 14, run: IK.blizzard },
        beam:     { weight: [1.5, 2.5, 3], cd: 8, run: IK.beam },
      },
      onPhase(b, ph) {
        if (ph === 2) summon(b, 'penguin', 3, { cap: 6, color: COL.ice, burst: 'ice', sfx: 'wenk' });
        if (ph === 3) { frostFloor(b); b.bgTask('frost', IK.frostPatches(b)); b.bgTask('mutter', IK.mutter(b)); }
      },
      tick(b, dt) {
        if (b.phase < 3) return;
        b.data.frostT = (b.data.frostT || 0) - dt;
        if (b.data.frostT <= 0) { b.data.frostT = 0.15; callFx('burst', b.x + rnd(-14, 14), b.y + rnd(-8, 8), rnd(30, b.height), 'ice', 1); }
      },
      onDeath(b) { callFx('burst', b.x, b.y, b.height, 'ice', 60); sfx('shatter', { x: b.x, y: b.y }); },
    },

    flameKing: {
      id: 'flameKing', act: 4, displayName: 'The Flame King', title: 'Lord of Black Glass',
      rig: 'flameKing', rigOpts: { scale: 1 },
      hp: 4400, dmg: 11, armor: 20, res: { fire: 0.35, ice: -0.25 },
      radius: 22, height: 138, mass: 60, speed: 64, turn: 3, range: 140, aggro: 430,
      xp: 340, gold: [150, 220], color: [1, 0.5, 0.12], burst: 'ember', blast: 'fire', move: 'chase', rest: 0.75, auraStyle: 'fire', aura: 'always',
      light: { r: 260, c: [1, 0.42, 0.1], k: 0.35, z: 40, phase: 3 }, flicker: true,   // the rig already lights him; phase 3 he burns hotter
      phaseToast: ['Cinder hounds pour out of the cracks in the glass.', 'A ring of fire closes on the arena. There is no outside anymore.'],
      deathSub: 'The black glass cools.',
      lines: {
        intro: ['You walk on the ashes of my kingdom. Kneel in them.', 'I burned it all to keep the cold out. You are only more kindling.'],
        idle: ['Glass remembers fire. So will you.', 'Everything burns. Everything.'],
        fissure: ['The earth splits for its king!', 'Open, ground!'],
        meteors: ['Let the sky fall burning!', 'RAIN!'],
        hounds: ['My hounds! Feed!', 'Go. Bring me something warm.'],
        p2: ['Hotter! Let nothing cold survive!'],
        p3: ['If I must burn the world to the bedrock, SO BE IT!'],
        death: ['The fire... is... going out...'],
      },
      patterns: {
        slam:       { weight: [3, 3, 3], maxR: 170, cd: 3, run: FK.slam },
        fissure:    { weight: [3, 3, 3], cd: 5, run: FK.fissure },
        meteorRain: { weight: [2, 2.5, 3], cd: 9, run: FK.meteorRain },
        lavaWaves:  { weight: [2, 2.5, 2.5], cd: 7, run: FK.lavaWaves },
        pillars:    { weight: [2.5, 2.5, 2.5], cd: 6, run: FK.pillars },
        hounds:     { weight: [1.5, 1.5, 1], cd: 16, cond: (b) => b.aliveMinions() < 3, run: FK.hounds },
      },
      onPhase(b, ph) {
        if (ph === 2) summon(b, 'cinder', 2, { cap: 4, color: COL.fire, burst: 'ember', sfx: 'fire' });
        if (ph === 3) closingRing(b);
      },
      tick(b, dt) {
        b.data.emberT = (b.data.emberT || 0) - dt;
        if (b.data.emberT <= 0) { b.data.emberT = b.phase === 3 ? 0.05 : 0.12; callFx('burst', b.x + rnd(-b.radius, b.radius), b.y + rnd(-8, 8), rnd(30, b.height), 'ember', 1); }
      },
      onDeath(b) { for (let k = 0; k < 5; k++) HM.Game && HM.Game.after && HM.Game.after(0.1 + k * 0.12, () => blast(b, b.x + rnd(-50, 50), b.y + rnd(-35, 35), 60, 'fire')); },
    },

    lich: {
      id: 'lich', act: 5, displayName: 'The Lich', title: 'Last Breath of the Old World',
      rig: 'lich', rigOpts: { scale: 1 },
      hp: 5400, dmg: 11, armor: 18, res: { shadow: 0.5, poison: 0.3, ice: 0.2, holy: -0.3 },
      radius: 16, height: 176, mass: 50, speed: 70, turn: 4, range: 250, aggro: 450,
      xp: 600, gold: [250, 350], color: [0.35, 1, 0.45], burst: 'witchfire', blast: 'witch', move: 'kite', rest: 0.75, auraStyle: 'witch',
      phaseSpeed: [1, 1.25, 1.6],
      light: { r: 200, c: [0.3, 1, 0.45], k: 0.45, z: 60, phase: 3 }, flicker: true,
      phaseToast: ['Thrall-knights kneel out of the bone fields.', 'The Well gives the Lich everything it has left. The world goes dark and green.'],
      toastColor: [0.45, 1, 0.55],
      deathSub: 'The Well runs dry. Ooo draws breath.',
      lines: {
        intro: ['ALL THINGS END. I AM ONLY THE HOUR THEY END IN.', 'THE WELL IS DRUNK. COME. DROWN IN WHAT REMAINS.'],
        idle: ['YOUR KIND BURNED THE WORLD ONCE. I AM WHAT THE FIRE LEFT.', 'STRUGGLE. THE STARS STRUGGLED TOO.', 'THERE IS NO SHAME IN ENDING.'],
        doom: ['BE UNMADE.', 'YOUR TIME IS SPENT.'],
        thralls: ['RISE. SERVE THE QUIET.', 'KNEEL, AND STAND AGAIN FOR ME.'],
        drain: ['GIVE IT TO ME. ALL OF IT.', 'YOUR WARMTH. I WILL TAKE IT.'],
        pulse: ['THE WELL REMEMBERS.', 'FEEL IT. THE BOTTOM OF EVERYTHING.'],
        p2: ['YOU DELAY THE INEVITABLE. HOW... ALIVE OF YOU.'],
        p3: ['THEN LET EVERYTHING BURN GREEN.'],
        death: ['EVEN... THE END... MUST... END...'],
      },
      patterns: {
        witchfire: { weight: [4, 3, 3], cd: 2.5, run: LI.witchfire },
        doom:      { weight: [2, 2, 2], cd: 9, run: LI.doom },
        walls:     { weight: [2.5, 2.5, 2.5], cd: 6, run: LI.walls },
        thralls:   { weight: [1.5, 1.5, 1], cd: 18, cond: (b) => b.aliveMinions() < 2, run: LI.thralls },
        drain:     { weight: [2, 2.5, 2.5], cd: 8, run: LI.drain },
        pulse:     { weight: [2, 2, 2.5], cd: 8, run: LI.pulse },
      },
      onPhase(b, ph) {
        if (ph === 2) summon(b, 'knight', 2, { cap: 3, name: 'Thrall-Knight', color: COL.witch, burst: 'witchfire', rise: true });
        if (ph === 3) { greenField(b); b.bgTask('greenFire', LI.greenFire(b)); sfx('lich_laugh', { x: b.x, y: b.y, vol: 1 }); }
      },
      tick(b, dt) {
        // phase 3: the arena darkens toward a sick green (new arrays only — R.ambient may alias the biome palette)
        const want = b.phase >= 3 ? 1 : 0;
        b.data.dark = M.approach(b.data.dark || 0, want, dt * 0.6);
        if (b.data.dark > 0) {
          const F = HM.Game && HM.Game.floor, base = (F && F.ambient) || [1, 1, 1], d = b.data.dark * 0.62;
          HM.R.ambient = [M.lerp(base[0], 0.3, d), M.lerp(base[1], 0.44, d), M.lerp(base[2], 0.34, d)];
        }
        b.data.moteT = (b.data.moteT || 0) - dt;
        if (b.data.moteT <= 0) { b.data.moteT = b.phase === 3 ? 0.08 : 0.2; callFx('burst', b.x + rnd(-16, 16), b.y + rnd(-8, 8), rnd(30, b.height), 'witchfire', 1); }
      },
      onDeath(b) {
        const G = HM.Game; if (!G || !G.after) return;
        // a long unravelling: green detonations walk outward, then one white flash and the light comes back
        for (let k = 0; k < 6; k++) {
          G.after(0.07 + k * 0.09, () => {
            const a = rnd(0, TAU), d = 20 + k * 22;
            blast(b, b.x + Math.cos(a) * d, b.y + Math.sin(a) * d, 50 + k * 8, 'witch');
            callFx('burst', b.x, b.y, rnd(20, 90), 'witchfire', 20); callFx('shake', 6);
            R.flash(0.25, 1, 0.4, 0.18); sfx('explode', { x: b.x, y: b.y, pitch: 0.6 + k * 0.08 });
          });
        }
        G.after(0.66, () => {
          R.flash(1, 1, 1, 0.85); callFx('shake', 14);
          const F = G.floor; HM.R.ambient = ((F && F.ambient) || [1, 1, 1]).slice();
          callFx('burst', b.x, b.y, 40, 'holy', 60);
        });
      },
    },
  };

  // a hit on a dormant boss (it is warded until the intro) wakes it
  HM.Events.on('evade', (e) => { const t = e && e.target; if (t instanceof Boss && t.state === 'dormant' && e.source && e.source.team === 0) t.startIntro(); });

  // ======================================================================================================== API
  const Bosses = (HM.Bosses = {
    defs, Boss, Decoy, PHASE_SPEED, PHASE_AT, TELE_MIN,
    // hpMul/dmgMul: global knobs. floorDmg: dmgUnit growth per floor past 3. addDmg/addHp: summoned minions are a
    // nuisance, not the main threat (they would otherwise be full floor-scaled monsters). zoneTick: one boss/monster
    // ground-zone tick per kind per target per this many seconds, however many puddles overlap.
    tuning: { hpMul: 1, dmgMul: 1, floorDmg: 0.11, addDmg: 0.55, addHp: 0.7, zoneTick: 0.42 },
    ids: Object.keys(defs),

    // Create a boss and add it to Game.entities (don't Game.spawn() it again — a duplicate is dropped anyway).
    spawn(id, x, y, floor) {
      const def = defs[id] || defs.boneDragon;
      floor = floor || (HM.Game && HM.Game.floor) || null;
      const b = new Boss(def, x, y, floor);
      if (HM.Game && HM.Game.entities && HM.Game.entities.indexOf(b) < 0) HM.Game.spawn(b);
      return b;
    },
    // The living boss (optionally of a given id).
    active(id) {
      const E = (HM.Game && HM.Game.entities) || [];
      for (const a of E) if (a instanceof Boss && !a.dead && (!id || a.defId === id)) return a;
      return null;
    },
    patterns(id) { return defs[id] ? Object.keys(defs[id].patterns) : []; },
    // Debug / staging: skip the intro and make `pattern` the next attack. opts.phase jumps to that phase first.
    force(id, pattern, opts) {
      const b = Bosses.active(id) || Bosses.active(); if (!b) return false;
      opts = opts || {};
      if (b.state === 'dormant' || b.state === 'intro') { b.engaged = true; b.introT = 0; b.beginFight(); }
      if (opts.phase && opts.phase > b.phase) {
        for (let ph = b.phase + 1; ph <= opts.phase; ph++) { b.hp = Math.min(b.hp, b.maxHp * PHASE_AT[ph - 2]); b.startTransition(ph); b.endTransition(); }
      }
      b.abortMain();
      if (pattern && b.def.patterns[pattern]) { b.forced = pattern; b.restT = 0; }
      if (opts.hp !== undefined) b.hp = Math.max(1, Math.min(b.hp, b.maxHp * opts.hp));
      return true;
    },
    // Screenshot helper: put the hero `dist` below the boss, then force a pattern (see force()).
    stage(pattern, opts) {
      opts = opts || {};
      const b = Bosses.active(opts.id), p = HM.Game && HM.Game.player; if (!b) return false;
      if (p) { p.x = b.x + (opts.dx || 0); p.y = b.y + (opts.dist || 190); p.vx = p.vy = 0; if (HM.Game.cam) { HM.Game.cam.x = (p.x + b.x) / 2; HM.Game.cam.y = (p.y + b.y) / 2; } }
      const ok = Bosses.force(b.defId, pattern, opts);
      if (HM.Game) { HM.Game.slowT = 0; if (p && opts.dist !== undefined) { p.x = b.x + (opts.dx || 0); p.y = b.y + opts.dist; p.kx = p.ky = 0; } }
      return ok;
    },
  });
})();
