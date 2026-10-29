// world.js — floor generation, terrain rendering (grass / stone / water / thicket), monoliths, fog, collision.
// FIRST PASS (by lead): grass biome only, establishes the look. World agent extends to all biomes/props.
(function () {
  'use strict';
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M, R = HM.R;
  const { CW, CH, TILT } = HM.cfg;

  // terrain types
  const T = { VOID: 0, GRASS: 1, STONE: 2, WATER: 3, DEEP: 4, THICKET: 5, DIRT: 6 };

  const G = (s) => R.ramp(s);
  const GL = {
    bladeL: G('\\\\(\\'), bladeC: G('|!|l|i'), bladeR: G('//)/'),
    short: G(",.'`;\"'"),
    fleck: G(".o°'*·"),
    stone: G('0OQ@$8BWM#&%dbpqwmnzaoQ0O8'),
    stoneDim: G(".,:;-=+o"),
    water: G("~-=~'.-~"),
    foam: G("~=-~^"),
    thicket: G('#%&@$WM8B'),
    fog: G(".:'-~°.·"),
    mono: G('$&@WM#Q8B%0O&8$@'),
  };

  const BIOMES = {
    grass: {
      name: 'The Grasslands',
      ambient: [0.92, 1.0, 1.05],
      grassLo: [0.09, 0.25, 0.12], grassHi: [0.34, 0.62, 0.32],
      stone: [0.56, 0.62, 0.80], water: [0.14, 0.22, 0.46], foam: [0.75, 0.85, 1.0],
      thicket: [0.07, 0.17, 0.10], fleck: [0.86, 0.9, 0.96], mono: [0.62, 0.66, 0.84],
      fog: [0.62, 0.66, 0.72], fogAmount: 0.45,
    },
  };

  HM.Interact.portal = () => HM.Game.descend();

  const World = (HM.World = {
    T, GL, BIOMES,
    floor: null,
    t: 0,

    // ------------------------------------------------------------------ generation
    generate(o) {
      const biome = BIOMES[o.biome] || BIOMES.grass;
      const rng = new HM.RNG(o.seed || 1);
      const w = o.isBoss ? 1500 : 2400, h = o.isBoss ? 1200 : 1800;
      const cols = Math.ceil(w / CW), rows = Math.ceil((h * TILT) / CH);
      const F = {
        biomeId: o.biome || 'grass', biome, act: o.act, inAct: o.inAct, isBoss: !!o.isBoss, bossId: o.bossId, seed: o.seed,
        w, h, cols, rows,
        type: new Uint8Array(cols * rows), shade: new Float32Array(cols * rows), shadow: new Float32Array(cols * rows),
        solid: new Uint8Array(cols * rows), shoreD: new Uint8Array(cols * rows),
        h1: new Float32Array(cols * rows), h2: new Float32Array(cols * rows), n1: new Float32Array(cols * rows), // per-cell stable hashes/noise (perf)
        props: [], spawns: [], interactables: [],
        start: { x: w * 0.5, y: h * 0.75 }, exit: { x: w * 0.5, y: h * 0.2 },
        exitOpen: false, objective: o.isBoss ? { type: 'boss', remaining: 1, done: false } : { type: 'elite', remaining: 1, done: false },
        ambient: biome.ambient,
      };
      const ox = rng.range(0, 1000), oy = rng.range(0, 1000);
      // base terrain
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i;
          const x = i * CW, y = (j * CH) / TILT;
          // distance to map edge, irregular
          const edge = Math.min(x, w - x, y, h - y) + (M.fbm(x * 0.006 + ox, y * 0.006 + oy, 3) - 0.5) * 220;
          const sn = M.fbm(x * 0.011 + ox + 50, y * 0.011 + oy - 30, 4);
          let t = T.GRASS;
          if (edge < 40) t = (x > w * 0.5 && y < h * 0.45) || o.title ? T.WATER : T.THICKET;
          else if (sn > 0.64) t = T.STONE;
          F.type[k] = t;
          F.shade[k] = sn;
          F.h1[k] = M.hash2(i, j); F.h2[k] = M.hash2(i + 911, j - 377);
          F.n1[k] = M.noise2(i * 0.15, j * 0.4);
        }
      }
      // shore distance (for foam) — cheap 2-pass chamfer from water cells
      const D = F.shoreD; D.fill(255);
      for (let k = 0; k < cols * rows; k++) if (F.type[k] !== T.WATER) D[k] = 0;
      for (let pass = 0; pass < 2; pass++) {
        for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
          const k = j * cols + i; if (!D[k]) continue;
          let m = D[k];
          if (pass === 0) { if (i > 0) m = Math.min(m, D[k - 1] + 1); if (j > 0) m = Math.min(m, D[k - cols] + 1); }
          else { if (i < cols - 1) m = Math.min(m, D[k + 1] + 1); if (j < rows - 1) m = Math.min(m, D[k + cols] + 1); }
          D[k] = m;
        }
        if (pass === 0) continue;
      }
      for (let j = rows - 1; j >= 0; j--) for (let i = cols - 1; i >= 0; i--) { const k = j * cols + i; if (!D[k]) continue; let m = D[k]; if (i < cols - 1) m = Math.min(m, D[k + 1] + 1); if (j < rows - 1) m = Math.min(m, D[k + cols] + 1); D[k] = m; }
      for (let k = 0; k < cols * rows; k++) if (F.type[k] === T.WATER && D[k] > 6) F.type[k] = T.DEEP;
      // monoliths
      const nPillars = o.isBoss ? 6 : 18;
      for (let n = 0; n < nPillars * 4 && F.props.length < nPillars; n++) {
        const x = rng.range(120, w - 120), y = rng.range(120, h - 120);
        if (World._typeAt(F, x, y) !== T.GRASS && World._typeAt(F, x, y) !== T.STONE) continue;
        if (M.dist(x, y, F.start.x, F.start.y) < 140) continue;
        if (F.props.some((p) => M.dist(x, y, p.x, p.y) < 160)) continue;
        const cluster = rng.chance(0.35) ? rng.int(2, 3) : 1;
        for (let c = 0; c < cluster; c++) {
          const px = x + (c ? rng.range(-90, 90) : 0), py = y + (c ? rng.range(-60, 60) : 0);
          const fallen = rng.chance(0.25);
          F.props.push({ kind: 'monolith', x: px, y: py, w: fallen ? rng.range(70, 120) : rng.range(26, 44), d: fallen ? rng.range(22, 34) : rng.range(18, 30), h: fallen ? rng.range(18, 30) : rng.range(70, 150), seed: rng.int(0, 1e6), broken: rng.chance(0.5) });
        }
      }
      // static shadows + solidity from props
      for (const p of F.props) World._bakeProp(F, p);
      for (let k = 0; k < cols * rows; k++) { const t = F.type[k]; if (t === T.WATER || t === T.DEEP || t === T.THICKET) F.solid[k] = 1; }
      // spawns (simple)
      for (let n = 0; n < 7; n++) { const pt = World.randomOpenPoint(rng, F, F.start.x, F.start.y, 380, 2000, F); if (pt) F.spawns.push({ x: pt[0], y: pt[1], kind: n === 0 ? 'elite' : 'pack', size: rng.int(3, 6) }); }
      if (o.isBoss) { F.spawns = [{ x: w * 0.5, y: h * 0.35, kind: 'boss', id: o.bossId }]; }
      World.floor = F;
      World._addExit(F);
      return F;
    },

    _addExit(F) {
      const ex = F.exit;
      F.interactables.push(World.makeInteractable('portal', ex.x, ex.y, { r: 40, label: 'Descend', canInteract: () => F.exitOpen }));
    },

    // Interactable factory: dispatches to HM.Interact[kind](obj, player)
    makeInteractable(kind, x, y, extra) {
      const o = Object.assign({ kind, x, y, r: 34, label: kind, used: false, hidden: false, canInteract: null }, extra || {});
      o.interact = function (p) { const h = HM.Interact[kind]; if (h) h(o, p); };
      return o;
    },

    _typeAt(F, x, y) { const i = Math.floor(x / CW), j = Math.floor((y * TILT) / CH); if (i < 0 || j < 0 || i >= F.cols || j >= F.rows) return T.VOID; return F.type[j * F.cols + i]; },

    _bakeProp(F, p) {
      // footprint solid + long shadow toward bottom-left (moon top-right)
      const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2, y0 = p.y - p.d / 2, y1 = p.y + p.d / 2;
      for (let y = y0; y <= y1; y += CH / TILT / 2) for (let x = x0; x <= x1; x += CW / 2) {
        const i = Math.floor(x / CW), j = Math.floor((y * TILT) / CH); if (i >= 0 && j >= 0 && i < F.cols && j < F.rows) F.solid[j * F.cols + i] = 1;
      }
      const len = p.h * 1.25;
      const sdx = -0.8, sdy = 0.55; // shadow direction (world)
      for (let s = 0; s < len; s += 3) {
        const fade = 1 - s / len;
        for (let x = x0; x <= x1; x += CW) {
          const sx = x + sdx * s, sy = y1 + sdy * s;
          for (let dd = -p.d; dd <= 0; dd += CH / TILT) {
            const i = Math.floor(sx / CW), j = Math.floor(((sy + dd) * TILT) / CH);
            if (i < 0 || j < 0 || i >= F.cols || j >= F.rows) continue;
            const k = j * F.cols + i; F.shadow[k] = Math.max(F.shadow[k], 0.85 * Math.pow(fade, 0.6));
          }
        }
      }
    },

    randomOpenPoint(rng, F, nx, ny, minR, maxR) {
      F = F || World.floor;
      for (let n = 0; n < 200; n++) {
        const x = rng.range(60, F.w - 60), y = rng.range(60, F.h - 60);
        if (World.isSolidF(F, x, y)) continue;
        if (nx !== undefined) { const d = M.dist(x, y, nx, ny); if (d < (minR || 0) || d > (maxR || 1e9)) continue; }
        return [x, y];
      }
      return null;
    },

    // ------------------------------------------------------------------ collision
    isSolidF(F, x, y) {
      if (!F) return false;
      if (x < 0 || y < 0 || x >= F.w || y >= F.h) return true;
      const i = Math.floor(x / CW), j = Math.floor((y * TILT) / CH);
      return F.solid[j * F.cols + i] === 1;
    },
    isSolid(x, y) { return World.isSolidF(World.floor, x, y); },
    resolve(x, y, r, actor) {
      const F = World.floor; if (!F) return [x, y];
      if (actor && actor.ghost) return [M.clamp(x, 0, F.w), M.clamp(y, 0, F.h)];
      // sample 8 directions around the circle; push out of solids
      let px = x, py = y;
      for (let it = 0; it < 3; it++) {
        let pushX = 0, pushY = 0, hit = false;
        for (let a = 0; a < 8; a++) {
          const ang = (a / 8) * Math.PI * 2; const cx = Math.cos(ang), cy = Math.sin(ang);
          if (World.isSolidF(F, px + cx * r, py + cy * r)) { pushX -= cx; pushY -= cy; hit = true; }
        }
        if (!hit) break;
        const l = Math.hypot(pushX, pushY) || 1; px += (pushX / l) * 1.5; py += (pushY / l) * 1.5;
      }
      if (World.isSolidF(F, px, py)) return [actor ? actor.x : x, actor ? actor.y : y];
      return [px, py];
    },
    los(x0, y0, x1, y1) {
      const d = M.dist(x0, y0, x1, y1); const n = Math.ceil(d / 8);
      for (let s = 1; s < n; s++) { const t = s / n; const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t; const i = Math.floor(x / CW), j = Math.floor((y * TILT) / CH); const F = World.floor; if (F && F.props && World._propAt(x, y)) return false; }
      return true;
    },
    _propAt(x, y) { const F = World.floor; for (const p of F.props) if (Math.abs(x - p.x) < p.w / 2 && Math.abs(y - p.y) < p.d / 2) return p; return null; },

    // ------------------------------------------------------------------ update/draw
    update(dt) { World.t += dt; },

    draw() {
      const F = World.floor; if (!F) return;
      const t = World.t, B = F.biome;
      const cols = R.cols, rows = R.rows, ci0 = R.ci0, cj0 = R.cj0;
      const key = R.KEY_GROUND;
      // interactors for grass bending
      const movers = [];
      const ents = HM.Game ? HM.Game.entities : [];
      for (const a of ents) if (!a.dead && R.inViewWorld(a.x, a.y, 60)) movers.push(a.x, a.y * TILT, a.radius * 2.6);
      const glyph = R.glyph, col = R.col, keyb = R.key, flag = R.flag, shd = R.shd;
      // wind = sin(t*1.4 - wx*.011 - wy*.004)*.55 + sin(t*.63 + wx*.027 + wy*.02)*.25, made separable (perf)
      const W = World._wind && World._wind.length >= (cols + rows) * 4 ? World._wind : (World._wind = new Float32Array((cols + rows) * 4 + 8));
      for (let x = 0; x < cols; x++) { const wx = (ci0 + x) * CW; const a1 = t * 1.4 - wx * 0.011, a2 = t * 0.63 + wx * 0.027; W[x * 4] = Math.sin(a1); W[x * 4 + 1] = Math.cos(a1); W[x * 4 + 2] = Math.sin(a2); W[x * 4 + 3] = Math.cos(a2); }
      const RO = cols * 4;
      for (let y = 0; y < rows; y++) { const wy = (cj0 + y) * CH; const b1 = wy * 0.004, b2 = wy * 0.02; W[RO + y * 4] = Math.sin(b1); W[RO + y * 4 + 1] = Math.cos(b1); W[RO + y * 4 + 2] = Math.sin(b2); W[RO + y * 4 + 3] = Math.cos(b2); }
      for (let y = 0; y < rows; y++) {
        const cj = cj0 + y;
        const sb1 = W[RO + y * 4], cb1 = W[RO + y * 4 + 1], sb2 = W[RO + y * 4 + 2], cb2 = W[RO + y * 4 + 3];
        for (let x = 0; x < cols; x++) {
          const ci = ci0 + x; const i = y * cols + x;
          if (ci < 0 || cj < 0 || ci >= F.cols || cj >= F.rows) continue;
          const k = cj * F.cols + ci;
          const tp = F.type[k];
          const h = F.h1[k], h2 = F.h2[k];
          let g = 0, r = 0, gg = 0, b = 0;
          if (tp === T.GRASS) {
            if (h < 0.06) { continue; }
            const wx = ci * CW, wy = cj * CH;
            // rolling wind waves
            const q = x * 4;
            const wave = (W[q] * cb1 - W[q + 1] * sb1) * 0.55 + (W[q + 2] * cb2 + W[q + 3] * sb2) * 0.25;
            let lean = (h2 - 0.5) * 1.1 + wave * 0.9;
            // bend away from movers
            for (let m = 0; m < movers.length; m += 3) {
              const dx = wx - movers[m], dy = (wy - movers[m + 1]) / TILT; const rr = movers[m + 2];
              const d2 = dx * dx + dy * dy; if (d2 < rr * rr) { const f = 1 - Math.sqrt(d2) / rr; lean += Math.sign(dx || 1) * f * 2.2; }
            }
            if (h2 < 0.035) { // pale flecks (dew / firefly dust)
              g = GL.fleck[(h * 97) % GL.fleck.length | 0];
              const br = 0.45 + h * 0.6 + (h2 < 0.008 ? 0.4 * (0.5 + 0.5 * Math.sin(t * 3 + h * 50)) : 0);
              r = B.fleck[0] * br; gg = B.fleck[1] * br; b = B.fleck[2] * br;
            } else {
              if (h < 0.22) g = GL.short[(h2 * 71) % GL.short.length | 0];
              else if (lean < -0.45) g = GL.bladeL[(h2 * 13) % GL.bladeL.length | 0];
              else if (lean > 0.45) g = GL.bladeR[(h2 * 13) % GL.bladeR.length | 0];
              else g = GL.bladeC[(h2 * 17) % GL.bladeC.length | 0];
              const patch = F.shade[k];
              let v = 0.25 + 0.75 * h2 * 0.8 + (patch - 0.5) * 0.6 + Math.max(0, wave) * 0.28;
              v = M.clamp(v, 0, 1.2);
              r = M.lerp(B.grassLo[0], B.grassHi[0], v); gg = M.lerp(B.grassLo[1], B.grassHi[1], v); b = M.lerp(B.grassLo[2], B.grassHi[2], v);
            }
          } else if (tp === T.STONE) {
            const edge = M.clamp((F.shade[k] - 0.64) * 10, 0, 1);
            if (h < 0.1 + (1 - edge) * 0.45) { // sparse edge: grass bleeding in
              if (h2 < 0.5) continue;
              g = GL.short[(h2 * 7) % GL.short.length | 0]; r = B.grassLo[0] * 1.4; gg = B.grassLo[1] * 1.4; b = B.grassLo[2] * 1.4;
            } else {
              g = edge < 0.35 ? GL.stoneDim[(h * 31) % GL.stoneDim.length | 0] : GL.stone[(h2 * 997) % GL.stone.length | 0];
              const v = 0.42 + 0.45 * h * edge + 0.15 * F.n1[k];
              r = B.stone[0] * v; gg = B.stone[1] * v; b = B.stone[2] * v;
            }
          } else if (tp === T.WATER || tp === T.DEEP) {
            const sd = F.shoreD[k];
            const n = M.noise2(ci * 0.12 + t * 0.6, cj * 0.35 - t * 0.2);
            if (sd <= 2 && (Math.sin(t * 1.8 + sd * 1.6 + ci * 0.05) > 0.2 || h < 0.3)) {
              g = GL.foam[(h * 37 + t * 2) % GL.foam.length | 0]; const v = 0.55 + 0.45 * n; r = B.foam[0] * v; gg = B.foam[1] * v; b = B.foam[2] * v;
            } else {
              if (n < 0.38 && h > 0.25) continue;
              g = GL.water[((n * 11 + h * 5) | 0) % GL.water.length];
              const v = (tp === T.DEEP ? 0.5 : 0.8) * (0.5 + n * 0.9);
              r = B.water[0] * v; gg = B.water[1] * v; b = B.water[2] * v;
              if (h2 < 0.01) { r = gg = b = 0.6; g = R.gi('.'); }
            }
          } else if (tp === T.THICKET) {
            if (h < 0.15) continue;
            g = GL.thicket[(h2 * 29) % GL.thicket.length | 0]; const v = 0.4 + h * 0.6; r = B.thicket[0] * v; gg = B.thicket[1] * v; b = B.thicket[2] * v;
          } else continue;
          keyb[i] = key; glyph[i] = g; const o = i * 3; col[o] = r; col[o + 1] = gg; col[o + 2] = b; flag[i] = R.F_GROUND;
          shd[i] = F.shadow[k];
        }
      }
      // props
      for (const p of F.props) if (R.inViewWorld(p.x, p.y, p.h + p.w + 60)) World.drawProp(p, B);
      // exit portal (placeholder visual; FX agent may restyle)
      if (F.exit) World.drawPortal(F);
    },

    drawProp(p, B) {
      if (p.kind !== 'monolith') return;
      const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2;
      const front = (p.y + p.d / 2) * TILT, back = (p.y - p.d / 2) * TILT;
      const key = p.y + p.d / 2;
      const ci0 = Math.floor(x0 / CW), ci1 = Math.floor(x1 / CW);
      for (let ci = ci0; ci <= ci1; ci++) {
        const u = (ci - ci0) / Math.max(1, ci1 - ci0);
        // broken / jagged top
        const hh = p.h * (p.broken ? 0.75 + 0.25 * M.noise2(ci * 0.5 + p.seed, 0.5) : 1);
        const topFront = front - hh, topBack = back - hh;
        const cjTop = Math.floor(topBack / CH), cjMid = Math.floor(topFront / CH), cjBot = Math.floor(front / CH);
        for (let cj = cjTop; cj <= cjBot; cj++) {
          const i = R.idx(ci, cj); if (i < 0) continue;
          const h = M.hash2(ci * 3 + p.seed, cj * 5);
          let v, g;
          if (cj <= cjMid) { v = 0.95 - (cj - cjTop) * 0.05 + h * 0.15; g = GL.mono[(h * 113) % GL.mono.length | 0]; }
          else {
            const dv = (cj - cjMid) / Math.max(1, cjBot - cjMid);
            v = (0.62 - dv * 0.32) * (0.75 + 0.5 * u) + h * 0.12; // right side catches moonlight
            g = h < 0.08 ? R.gi(':') : GL.mono[(h * 997) % GL.mono.length | 0];
          }
          R.setI(i, g, B.mono[0] * v, B.mono[1] * v, B.mono[2] * v, key, 0);
        }
      }
    },

    drawPortal(F) {
      const ex = F.exit; const t = World.t; const open = F.exitOpen;
      const col = open ? [0.55, 0.9, 1.0] : [0.25, 0.3, 0.4];
      R.ring(ex.x, ex.y, 30, 6, (i, u, ci, cj, ang) => {
        const h = M.hash2(ci, cj); const flick = open ? 0.6 + 0.4 * Math.sin(t * 5 + ang * 3 + h * 6) : 0.5;
        if (R.setI(i, R.gi(open ? 'o' : '.'), col[0] * flick, col[1] * flick, col[2] * flick, R.KEY_DECAL, R.F_UNLIT) && open) R.emitI(i, 0.05, 0.12, 0.16);
      });
      if (open) R.light(ex.x, ex.y, 10, 110, 0.4, 0.75, 1.0, 0.9);
    },

    drawOver() {
      const F = World.floor; if (!F) return;
      const B = F.biome; const amt = B.fogAmount || 0; if (amt <= 0) return;
      const t = World.t; const cols = R.cols, rows = R.rows, ci0 = R.ci0, cj0 = R.cj0;
      const fc = B.fog;
      // fog density on a coarse world-anchored grid (every 4 cols x 2 rows), bilinear upsampled
      const SX = 4, SY = 2;
      const gx0 = Math.floor(ci0 / SX), gy0 = Math.floor(cj0 / SY);
      const gw = Math.ceil(cols / SX) + 2, gh = Math.ceil(rows / SY) + 2;
      const grid = World._fogGrid && World._fogGrid.length >= gw * gh ? World._fogGrid : (World._fogGrid = new Float32Array(gw * gh * 2));
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const ci = (gx0 + x) * SX, cj = (gy0 + y) * SY;
        grid[y * gw + x] = M.fbm(ci * 0.028 + t * 0.09, cj * 0.06 - t * 0.03, 3);
      }
      const thr = 1 - amt * 0.75;
      for (let y = 0; y < rows; y++) {
        const cj = cj0 + y; const fy = cj / SY - gy0; const iy = Math.floor(fy), ty = fy - iy;
        for (let x = 0; x < cols; x++) {
          const ci = ci0 + x; const fx = ci / SX - gx0; const ix = Math.floor(fx), tx = fx - ix;
          const g0 = iy * gw + ix;
          const a = grid[g0] + (grid[g0 + 1] - grid[g0]) * tx, b = grid[g0 + gw] + (grid[g0 + gw + 1] - grid[g0 + gw]) * tx;
          let d = ((a + (b - a) * ty) - thr) * 3.2; if (d <= 0) continue; d = Math.min(d, 1);
          const i = y * cols + x, o = i * 3;
          R.col[o] = M.lerp(R.col[o], fc[0] * 0.55, d * 0.55); R.col[o + 1] = M.lerp(R.col[o + 1], fc[1] * 0.55, d * 0.55); R.col[o + 2] = M.lerp(R.col[o + 2], fc[2] * 0.55, d * 0.55);
          const hb = (ci >= 0 && cj >= 0 && ci < F.cols && cj < F.rows) ? F.h1[cj * F.cols + ci] : 0.5; const hh = hb * 7.31 + Math.floor(t * 2 + ci * 0.1) * 0.618; const h = hh - Math.floor(hh);
          if (h < d * 0.45 && R.key[i] < 0) { R.glyph[i] = GL.fog[(h * 101) % GL.fog.length | 0]; R.col[o] = fc[0] * (0.5 + d * 0.4); R.col[o + 1] = fc[1] * (0.5 + d * 0.4); R.col[o + 2] = fc[2] * (0.5 + d * 0.4); }
          R.emitI(i, fc[0] * d * 0.035, fc[1] * d * 0.035, fc[2] * d * 0.04);
        }
      }
    },
  });
})();
