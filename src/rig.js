// rig.js — procedural skeletal rigs drawn as shaded glyph figures (HM.Rig).
//
// Every character is a small 3D puppet. A pose function builds joints in LOCAL space
// (x = right, y = forward, z = up; world units at scale 1), a figure transform maps them into the world
// (actor x/y/z + smoothed facing + scale) and they are rasterized as shaded glyph capsules, balls, lines
// and cloth triangles straight into the renderer's cell buffer. Depth keys are each part's world y (+ a tiny
// height bias), so whatever is nearer the camera wins and arms/weapons/capes sort themselves.
//
// After a figure is drawn, a halo pass blanks the cells around its silhouette (glyph 0 at a key just below
// the figure) so grass never clutters a character and every figure gets the dark outline of the reference
// reels. Verlet chains drive capes, hair, beards, robes, tatters and the dragon's tail. On death, bony rigs
// break into physical bone debris that settles into a pile; fleshy rigs collapse and dissolve into glyph dust;
// elementals gutter out into embers.
//
// Test helpers: HM.Rig.gallery(group), galleryAnim(state, variant, dur), galleryWalk(speed), galleryKill(),
// galleryFace(angle), galleryStatus(id), galleryClear().
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M, R = HM.R;
  const { CW, CH, TILT } = HM.cfg;
  const PI = Math.PI, TAU = PI * 2;
  const sin = Math.sin, cos = Math.cos, abs = Math.abs, sqrt = Math.sqrt, min = Math.min, max = Math.max, floor = Math.floor;
  const clamp = M.clamp, lerp = M.lerp, hash2 = M.hash2;
  const ease = M.easeOutCubic;
  const len2 = (x, y) => sqrt(x * x + y * y), len3 = (x, y, z) => sqrt(x * x + y * y + z * z);
  const sm = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const seg01 = (u, a, b) => (u <= a ? 0 : u >= b ? 1 : (u - a) / (b - a));
  const LX = R.L[0], LY = R.L[1], LZ = R.L[2];
  const F_UNLIT = R.F_UNLIT;
  // renderer figure flag (bold glyph weight + rim light + terrain outline); absent in older renderers → 0
  const F_FIG = R.F_FIGURE || 0, BOLD = R.F_FIGURE ? R.BOLD || 0 : 0;

  // ======================================================================== glyphs & ramps
  // DEFINITION (DESIGN §4b/§10): every material is a clean 5-level ramp, deep shadow → highlight. Bodies are DENSE glyph
  // masses (# @ % & 8 M W B …) so a figure's texture differs from the sparse stroke/dot glyphs of the ground; tone comes
  // from 5 quantized level colors (TONE × biome shadow / highlight tints) with ordered (Bayer) dither between adjacent
  // levels, anchored to the figure's own origin cell so the pattern rides with the figure and never crawls.
  const G = (s) => R.ramp(s);
  // one core glyph per material (levels 1–3 share it, so color alone carries the gradient — clean, not noisy);
  // the deep-shadow and highlight levels get their own glyph for a crisp terminator and lit edge
  const RP = {
    cloth: G('%###@'), dark: G('&###@'), flesh: G('%000@'), skin: G('%000@'),
    bone: G('&888@'), metal: G('%#HH@'), hair: G('&$$$S'), fire: G('*%#@@'),
    ice: G('+*###'), candy: G('%&&8@'), stone: G('%888$'), snow: G('%000@'),
    shell: G('%&@@@'), wing: G(':;%%&'), void: G('%###@'), coal: G('%###@'), fur: G('%MMMW'),
  };
  const gi = (c) => R.gi(c);
  const GL = {
    dot: gi('.'), o: gi('o'), O: gi('O'), star: gi('*'), plus: gi('+'), eq: gi('='), dash: gi('-'), bar: gi('|'), colon: gi(':'),
    lp: gi('('), rp: gi(')'), q: gi('"'), ap: gi("'"), caret: gi('^'), v: gi('v'), w: gi('w'), at: gi('@'),
    hash: gi('#'), gt: gi('>'), lt: gi('<'), us: gi('_'), comma: gi(','), tilde: gi('~'), pct: gi('%'), eight: gi('8'), H: gi('H'),
  };
  const DUST = G(".,'`:;");
  const BATG = G('vwVWMm^');
  // ---- 5-level tone model
  const NL = 5, NL1 = 4;
  const TONE = [0.34, 0.53, 0.74, 0.95, 1.17];
  // 4x4 ordered dither thresholds in (0,1); index = (dx & 3) | ((dy & 3) << 2) relative to the figure origin cell
  const BAY = new Float32Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16));
  // 8x8 value table anchored to the figure (replaces per-cell hash noise for specks, cracks, flicker, dissolve)
  const HT = new Float32Array(64);
  { let s = 0x2f6b1d3; for (let i = 0; i < 64; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; HT[i] = ((s >>> 8) & 0xffff) / 65536; } }
  // Per-biome figure tones: deep shadows pull toward a color that is darker / opposite to the ground, highlights toward
  // a light that reads against it (moon-blue on grass, cream on dusty pink, deep navy shadows on snow, white-gold on
  // ember light, bone-white on the Well's black soil). shk = shadow-tint weight per level, hlk = highlight weight.
  const BIO = {
    grass: { sh: [0.025, 0.05, 0.085], shk: [0.45, 0.2, 0.03, 0, 0], hl: [0.92, 1.0, 1.1], hlk: 0.22, rim: [0.75, 0.88, 1.05], gainT: 2.1 },
    candy: { sh: [0.09, 0.025, 0.075], shk: [0.62, 0.34, 0.08, 0, 0], hl: [1.06, 1.0, 0.84], hlk: 0.3, rim: [1.0, 0.96, 0.82], gainT: 2.0 },
    ice: { sh: [0.015, 0.04, 0.2], shk: [0.78, 0.55, 0.22, 0.04, 0], hl: [1.0, 1.04, 1.12], hlk: 0.16, rim: [0.7, 0.85, 1.1], gainT: 1.6, so: -0.12 },
    fire: { sh: [0.045, 0.03, 0.035], shk: [0.66, 0.4, 0.1, 0, 0], hl: [1.3, 1.16, 0.86], hlk: 0.32, rim: [1.2, 0.95, 0.6], gainT: 2.2 },
    well: { sh: [0.012, 0.03, 0.025], shk: [0.52, 0.26, 0.05, 0, 0], hl: [0.94, 1.05, 0.95], hlk: 0.24, rim: [0.7, 1.0, 0.78], gainT: 2.3 },
  };
  let BC = BIO.grass; // current biome tones (set per figure draw)
  function biomeId() { const F = HM.Game && HM.Game.floor; const b = F && (F.biomeId || (F.biome && F.biome.id)); return BIO[b] ? b : 'grass'; }
  const lumOf = (c) => c[0] * 0.3 + c[1] * 0.55 + c[2] * 0.15;

  // ======================================================================== raster core (figure-aware)
  // A "figure" is everything one actor draws in a frame. Each written cell is recorded (index, key, part id) so the
  // definition pass can add value breaks afterwards. FIG also carries per-figure color modifiers (hit flash, status
  // tint, elite rim, fade, dissolve, ground clip, biome gain) and the figure's origin cell (dither anchor).
  const TCAP = 1 << 15;
  const TOUCH = new Int32Array(TCAP), TKEY = new Float32Array(TCAP), TPART = new Uint16Array(TCAP);
  const FIG = {
    n: 0, minKey: Infinity, flash: 0, ta: 0, tr: 0, tg: 0, tb: 0, rim: 0, rr: 0, rg: 0, rb: 0, alpha: 1, dis: 0, seed: 0,
    clipPy: Infinity, unlit: 0, pat: 0, p2: null, amb: 0.3, T: 0, halo: 1, oci: 0, ocj: 0, gain: 1, part: 1, hold: 0, dk: 1, sat: 1, mr: 0, so: 0.14,
  };
  function nextPart() { if (!FIG.hold) FIG.part = FIG.part >= 65000 ? 2 : FIG.part + 1; }
  function put(i, g, r, gg, b, k, e) {
    if (FIG.ta > 0) {
      const l = (r * 0.3 + gg * 0.55 + b * 0.15) * 1.15 + 0.06, t = FIG.ta;
      r += (FIG.tr * l - r) * t; gg += (FIG.tg * l - gg) * t; b += (FIG.tb * l - b) * t;
    }
    let fl = (FIG.unlit || e > 0 ? F_UNLIT : 0) | F_FIG;
    if (FIG.flash > 0) { const f = FIG.flash; r += (0.95 + r * 0.6 - r) * f; gg += (0.95 + gg * 0.6 - gg) * f; b += (0.95 + b * 0.6 - b) * f; fl |= F_UNLIT; }
    const al = FIG.alpha;
    if (al < 1) { r *= al; gg *= al; b *= al; }
    R.key[i] = k; R.glyph[i] = BOLD ? (g & 127) | BOLD : g; const o = i * 3; R.col[o] = r; R.col[o + 1] = gg; R.col[o + 2] = b; R.flag[i] = fl;
    if (e > 0) { R.emi[o] += r * e; R.emi[o + 1] += gg * e; R.emi[o + 2] += b * e; }
    const n = FIG.n; if (n < TCAP) { TOUCH[n] = i; TKEY[n] = k; TPART[n] = FIG.part; FIG.n = n + 1; }
    if (k < FIG.minKey) FIG.minKey = k;
  }
  // level colors for one part: LC[k*3..] = base × TONE[k] × gain, deep levels tinted toward the biome shadow color,
  // the top level toward the biome highlight. LC2 is the same for the pattern's secondary color (FIG.p2).
  const LC = new Float32Array(NL * 3), LC2 = new Float32Array(NL * 3);
  function levels(out, r, g, b) {
    const S = BC, gn = FIG.gain, sk = S.shk, sh = S.sh, hl = S.hl, hk = S.hlk, sat = FIG.sat;
    if (sat !== 1) { const l = r * 0.3 + g * 0.55 + b * 0.15; r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat; if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0; }
    for (let k = 0; k < NL; k++) {
      const t = TONE[k] * gn;
      let cr = r * t, cg = g * t, cb = b * t;
      const w = sk[k] * FIG.dk;
      if (w > 0) { // tint toward the biome shadow color, never brightening (a black penguin stays black, not navy-grey)
        const lc = cr * 0.3 + cg * 0.55 + cb * 0.15, ls = sh[0] * 0.3 + sh[1] * 0.55 + sh[2] * 0.15, f = ls > lc ? lc / ls : 1;
        cr += (sh[0] * f - cr) * w; cg += (sh[1] * f - cg) * w; cb += (sh[2] * f - cb) * w;
      }
      if (k === NL1 && hk > 0) { const l = (cr * 0.3 + cg * 0.55 + cb * 0.15); cr += (hl[0] * l - cr) * hk; cg += (hl[1] * l - cg) * hk; cb += (hl[2] * l - cb) * hk; }
      out[k * 3] = cr; out[k * 3 + 1] = cg; out[k * 3 + 2] = cb;
    }
  }
  // shade s (−1..1 Lambert-ish) at cell (ci,cj) → dithered level 0..4
  function lvAt(s, ci, cj) {
    let q = FIG.so + 0.86 * s; q = q < 0 ? 0 : q > 1 ? 1 : q;
    const L = q * NL1; let lv = L | 0;
    if (L - lv > BAY[((ci - FIG.oci) & 3) | (((cj - FIG.ocj) & 3) << 2)]) lv++;
    return lv > NL1 ? NL1 : lv;
  }
  const ht = (ci, cj) => HT[((ci - FIG.oci) & 7) | (((cj - FIG.ocj) & 7) << 3)];

  // Shaded tapered capsule A→B in projected px (keys ka/kb), radii ra/rb. FIG.pat selects a surface pattern.
  const PAT_RIBS = 1, PAT_MINT = 2, PAT_COALS = 3, PAT_FLAME = 4, PAT_SPECK = 5, PAT_VOID = 6, PAT_STRIPE = 7;
  function cap(ax, ay, ka, bx, by, kb, ra, rb, ramp, r, g, b, e) {
    if (ra < 1.9 && rb < 1.9) { line(ax, ay, ka, bx, by, kb, ramp[3], r * 0.95, g * 0.95, b * 0.95, e); return; }
    nextPart();
    const pad = 1.1, cols = R.cols;
    let x0 = floor((min(ax - ra, bx - rb) - pad) / CW), x1 = floor((max(ax + ra, bx + rb) + pad) / CW);
    let y0 = floor((min(ay - ra, by - rb) - pad) / CH), y1 = floor((max(ay + ra, by + rb) + pad) / CH);
    const yTop = y0;
    if (x0 < R.ci0) x0 = R.ci0; if (x1 > R.ci0 + cols - 1) x1 = R.ci0 + cols - 1;
    if (y0 < R.cj0) y0 = R.cj0; if (y1 > R.cj0 + R.rows - 1) y1 = R.cj0 + R.rows - 1;
    if (x0 > x1 || y0 > y1) return;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, inv = l2 > 1e-6 ? 1 / l2 : 0;
    const key = R.key, pat = FIG.pat, rim = FIG.rim, dis = FIG.dis;
    levels(LC, r, g, b);
    const p2 = FIG.p2; if (pat && p2) levels(LC2, p2[0], p2[1], p2[2]);
    const tq = pat === PAT_FLAME ? floor(FIG.T * 14) * 3 : 0;
    for (let cj = y0; cj <= y1; cj++) {
      const py = (cj + 0.5) * CH; if (py > FIG.clipPy) break;
      const row = (cj - R.cj0) * cols - R.ci0;
      for (let ci = x0; ci <= x1; ci++) {
        const px = (ci + 0.5) * CW;
        let t = ((px - ax) * dx + (py - ay) * dy) * inv; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const rr = ra + (rb - ra) * t + pad;
        const ex = px - ax - dx * t, ey = py - ay - dy * t;
        const d2 = ex * ex + ey * ey; if (d2 > rr * rr) continue;
        const i = row + ci;
        const nn = d2 / (rr * rr), nz = sqrt(1 - nn);
        const k = ka + (kb - ka) * t + nz * 0.25;
        if (k < key[i]) continue;
        if (dis > 0 && ht(ci + FIG.seed, cj) < dis) continue;
        const s = (ex * LX + ey * LY) / rr + nz * LZ;
        let lv = lvAt(s, ci, cj);
        let gl = ramp[lv], o3 = lv * 3;
        let cr = LC[o3], cg = LC[o3 + 1], cb = LC[o3 + 2], ee = e;
        if (pat) {
          if (pat === PAT_RIBS) { // rib rows alternate with dark gaps; spine shows through the gaps
            if (((cj - yTop) & 1) === 1) { if (abs(ex) > CW * 0.6) continue; gl = GL.colon; o3 = (lv > 0 ? lv - 1 : 0) * 3; cr = LC[o3] * 0.8; cg = LC[o3 + 1] * 0.8; cb = LC[o3 + 2] * 0.8; } else gl = nn > 0.5 ? (ex < 0 ? GL.lp : GL.rp) : GL.eq;
          } else if (pat === PAT_MINT) { // peppermint swirl sectors
            const sct = ((Math.atan2(ey, ex) + FIG.T * 0.4 + 6 * PI) / (PI / 3)) | 0;
            if (sct & 1) { cr = LC2[o3]; cg = LC2[o3 + 1]; cb = LC2[o3 + 2]; }
          } else if (pat === PAT_STRIPE) { // horizontal bands (suits, robes)
            if (((cj - yTop) % 3) === 2) { cr = LC2[o3]; cg = LC2[o3 + 1]; cb = LC2[o3 + 2]; }
          } else if (pat === PAT_COALS || pat === PAT_VOID) { // glowing cracks / void sparks flicker in a dark body
            const h = ht(ci, cj);
            const fl = 0.5 + 0.5 * sin(FIG.T * (pat === PAT_VOID ? 3 : 5) + h * 40);
            if (h > (pat === PAT_VOID ? 0.8 : 0.66) && fl > 0.25) {
              const q = fl * (pat === PAT_VOID ? 0.9 : 1.2);
              cr = p2[0] * q; cg = p2[1] * q; cb = p2[2] * q; ee += 0.55 * fl;
              gl = h > 0.9 ? GL.star : h > 0.8 ? GL.plus : GL.ap;
            }
          } else if (pat === PAT_FLAME) { // flickering fire: hot core, tip-colored rim, glyph jitter
            const h = HT[((ci - FIG.oci + tq) & 7) | (((cj - FIG.ocj) & 7) << 3)];
            let q = 0.14 + 0.86 * s + (h - 0.5) * 0.5; q = q < 0 ? 0 : q > 1 ? 1 : q;
            const L = (q * NL1 + 0.5) | 0; gl = ramp[L < 1 ? 1 : L];
            const m = 1 - nz * 0.8, kq = (0.55 + q * 0.7) * FIG.gain;
            cr = (r + (p2[0] - r) * m) * kq; cg = (g + (p2[1] - g) * m) * kq; cb = (b + (p2[2] - b) * m) * kq;
            if (q < 0.3) { const w = BC.shk[0] * FIG.dk * 0.8; cr += (BC.sh[0] - cr) * w; cg += (BC.sh[1] - cg) * w; cb += (BC.sh[2] - cb) * w; } // charcoal shadow side
          } else if (pat === PAT_SPECK) {
            const h = ht(ci, cj);
            if (h > 0.8) { cr = LC2[o3]; cg = LC2[o3 + 1]; cb = LC2[o3 + 2]; gl = h > 0.93 ? GL.at : GL.pct; } // dense rot/sugar specks
          }
        }
        if (rim > 0 && nn > 0.5) { const q = rim * (nn - 0.5) * 2; cr += (FIG.rr - cr) * q; cg += (FIG.rg - cg) * q; cb += (FIG.rb - cb) * q; ee += q * 0.7; }
        put(i, gl, cr, cg, cb, k, ee);
      }
    }
  }
  // buffer index of projected px (inline of R.idxP; -1 outside)
  function cidx(px, py) {
    const x = floor(px / CW) - R.ci0, y = floor(py / CH) - R.cj0;
    return x < 0 || y < 0 || x >= R.cols || y >= R.rows ? -1 : y * R.cols + x;
  }
  // Line of glyphs (g = glyph index, 0 = directional - | / \).
  function line(ax, ay, ka, bx, by, kb, g, r, gg, b, e) {
    nextPart();
    const dx = bx - ax, dy = by - ay;
    const n = max(1, Math.ceil(max(abs(dx) / CW, abs(dy) / CH) * 1.5));
    const gl = g || R.dirGlyph(dx, dy);
    const gn = FIG.gain; r *= gn; gg *= gn; b *= gn;
    let last = -1;
    for (let s = 0; s <= n; s++) {
      const t = s / n, px = ax + dx * t, py = ay + dy * t;
      if (py > FIG.clipPy) continue;
      const i = cidx(px, py); if (i < 0 || i === last) continue; last = i;
      const k = ka + (kb - ka) * t; if (k < R.key[i]) continue;
      if (FIG.dis > 0 && ht(floor(px / CW) + FIG.seed, floor(py / CH)) < FIG.dis) continue;
      put(i, gl, r, gg, b, k, e || 0);
    }
  }
  // Blade-style line: cycles material glyphs g0/g1 along the length, g2 at the tip. Brightens toward the edge.
  function bline(ax, ay, ka, bx, by, kb, g0, g1, g2, r, gg, b, e) {
    nextPart();
    const dx = bx - ax, dy = by - ay;
    const n = max(1, Math.ceil(max(abs(dx) / CW, abs(dy) / CH) * 1.5));
    let last = -1, m = 0;
    const tipI = cidx(bx, by);
    for (let s = 0; s <= n; s++) {
      const t = s / n, px = ax + dx * t, py = ay + dy * t;
      if (py > FIG.clipPy) continue;
      const i = cidx(px, py); if (i < 0 || i === last) continue; last = i;
      const k = ka + (kb - ka) * t; if (k < R.key[i]) { m++; continue; }
      const q = 0.8 + 0.42 * t;
      put(i, i === tipI ? g2 : (m & 1 ? g1 : g0), r * q, gg * q, b * q, k, e);
      m++;
    }
  }
  // single glyph (eyes, studs, sparks) — part 0: never casts or receives an internal value break
  function dot(px, py, k, g, r, gg, b, e) {
    if (py > FIG.clipPy) return;
    const i = cidx(px, py); if (i < 0 || k < R.key[i]) return;
    if (FIG.dis > 0 && ht(floor(px / CW) + FIG.seed, floor(py / CH)) < FIG.dis) return;
    const pt = FIG.part; FIG.part = 0; put(i, g, r, gg, b, k, e || 0); FIG.part = pt;
  }
  function cellDot(ci, cj, k, g, c, e) {
    if ((cj + 0.5) * CH > FIG.clipPy) return;
    const i = R.idx(ci, cj); if (i < 0 || k < R.key[i]) return;
    if (FIG.dis > 0 && ht(ci + FIG.seed, cj) < FIG.dis) return;
    const pt = FIG.part; FIG.part = 0; put(i, g, c[0], c[1], c[2], k, e || 0); FIG.part = pt;
  }
  // Filled triangle (projected px) with per-vertex key k, shade s (0..1) and tatter coordinate v (0 top .. 1 hem).
  function tri(x0, y0, k0, s0, v0, x1, y1, k1, s1, v1, x2, y2, k2, s2, v2, ramp, r, g, b, e, tatter) {
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (abs(area) < 0.5) return;
    const ia = 1 / area, cols = R.cols, key = R.key;
    let cx0 = floor(min(x0, x1, x2) / CW), cx1 = floor(max(x0, x1, x2) / CW);
    let cy0 = floor(min(y0, y1, y2) / CH), cy1 = floor(max(y0, y1, y2) / CH);
    if (cx0 < R.ci0) cx0 = R.ci0; if (cx1 > R.ci0 + cols - 1) cx1 = R.ci0 + cols - 1;
    if (cy0 < R.cj0) cy0 = R.cj0; if (cy1 > R.cj0 + R.rows - 1) cy1 = R.cj0 + R.rows - 1;
    if (cx0 > cx1 || cy0 > cy1) return;
    const tol = -0.09, flame = FIG.pat === PAT_FLAME, p2 = FIG.p2;
    levels(LC, r, g, b);
    for (let cj = cy0; cj <= cy1; cj++) {
      const py = (cj + 0.5) * CH; if (py > FIG.clipPy) break;
      const row = (cj - R.cj0) * cols - R.ci0;
      for (let ci = cx0; ci <= cx1; ci++) {
        const px = (ci + 0.5) * CW;
        const w1 = ((px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)) * ia;
        const w2 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) * ia;
        const w0 = 1 - w1 - w2;
        if (w0 < tol || w1 < tol || w2 < tol) continue;
        const i = row + ci;
        const k = k0 * w0 + k1 * w1 + k2 * w2; if (k < key[i]) continue;
        const v = v0 * w0 + v1 * w1 + v2 * w2;
        if (tatter > 0 && v > 0.5 && ht(ci * 3 + FIG.seed, cj * 5 + 1) < (v - 0.5) * tatter) continue;
        if (FIG.dis > 0 && ht(ci + FIG.seed, cj) < FIG.dis) continue;
        const sh = (s0 * w0 + s1 * w1 + s2 * w2) * (((cj & 1) === 0) ? 1 : 0.86);
        const lv = lvAt(sh * 1.1 - 0.12, ci, cj), o3 = lv * 3;
        let cr = LC[o3], cg = LC[o3 + 1], cb = LC[o3 + 2], gl = ramp[lv];
        if (flame) {
          const h = HT[((ci - FIG.oci + floor(FIG.T * 12) * 5) & 7) | (((cj - FIG.ocj) & 7) << 3)];
          const m = clamp(v + (h - 0.5) * 0.3, 0, 1), q = (0.6 + sh * 0.6) * FIG.gain;
          cr = (r + (p2[0] - r) * m) * q; cg = (g + (p2[1] - g) * m) * q; cb = (b + (p2[2] - b) * m) * q;
          gl = ramp[clamp(lv + ((h * 3) | 0) - 1, 1, NL1)];
        }
        put(i, gl, cr, cg, cb, k, e);
      }
    }
  }
  // ---- definition pass (replaces the old blank-cell halo; DESIGN §4b: no borders on terrain)
  // After a figure is drawn: (1) internal value breaks — a part cell whose neighbour belongs to another part of the same
  // figure that is clearly IN FRONT is darkened (an arm over the chest gets a crisp edge); (2) crowd breaks — where two
  // figures touch, the BACK figure's cells along the front figure's silhouette are darkened ~35%. Terrain is never touched.
  let OWN = null, OWNK = null, PRT = null, DKS = null, DKT = null, SERIAL = 1;
  const PBREAK = 3, K_PART = 0.72, K_CROWD = 0.56;
  const DBG = { frameT: -1, crowd: 0, part: 0 };
  function darken(i, k) {
    if (DKS[i] === OWN[i]) return; DKS[i] = OWN[i]; DKT[i] = k === K_CROWD ? 1 : 2;
    const o = i * 3; R.col[o] *= k; R.col[o + 1] *= k; R.col[o + 2] *= k;
    if (k === K_CROWD) DBG.crowd++; else DBG.part++;
  }
  function definition() {
    if (R.time !== DBG.frameT) { DBG.frameT = R.time; DBG.crowd = 0; DBG.part = 0; }
    const n = FIG.n; if (!n) return 0;
    const N = R.n;
    if (!OWN || OWN.length !== N) { OWN = new Int32Array(N); OWNK = new Float32Array(N); PRT = new Uint16Array(N); DKS = new Int32Array(N); DKT = new Uint8Array(N); }
    const me = SERIAL = SERIAL >= 2e9 ? 1 : SERIAL + 1;
    const key = R.key, flag = R.flag, cols = R.cols, rows = R.rows;
    const m = n < TCAP ? n : TCAP;
    for (let q = 0; q < m; q++) { const i = TOUCH[q]; if (key[i] === TKEY[q]) { OWN[i] = me; OWNK[i] = TKEY[q]; PRT[i] = TPART[q]; } }
    const mr = FIG.mr, rc = BC.rim, col = R.col, glyph = R.glyph;
    for (let q = 0; q < m; q++) {
      const i = TOUCH[q];
      if (OWN[i] !== me || OWNK[i] !== TKEY[q] || key[i] !== TKEY[q]) continue; // overwritten / duplicate entry
      const x = i % cols, y = (i / cols) | 0, ki = key[i], pi = PRT[i];
      // moon rim: silhouette cells open to the moon (top / right neighbour not part of any figure) catch the biome's
      // rim light — a lit edge on the figure itself, never a border on the terrain
      if (mr > 0 && !(flag[i] & F_UNLIT) && DKS[i] !== me) {
        const up = y > 0 ? i - cols : -1, rt = x < cols - 1 ? i + 1 : -1;
        const openU = up >= 0 && !((flag[up] & F_FIG) && glyph[up]), openR = rt >= 0 && !((flag[rt] & F_FIG) && glyph[rt]);
        if (openU || openR) {
          const w = mr * (openU && openR ? 1 : 0.7), o = i * 3, l = col[o] * 0.3 + col[o + 1] * 0.55 + col[o + 2] * 0.15, t = 0.55 + l;
          col[o] += (rc[0] * t - col[o]) * w; col[o + 1] += (rc[1] * t - col[o + 1]) * w; col[o + 2] += (rc[2] * t - col[o + 2]) * w;
        }
      }
      for (let d = 0; d < 4; d++) {
        let j;
        if (d === 0) { if (x === 0) continue; j = i - 1; } else if (d === 1) { if (x === cols - 1) continue; j = i + 1; }
        else if (d === 2) { if (y === 0) continue; j = i - cols; } else { if (y === rows - 1) continue; j = i + cols; }
        if (!(flag[j] & F_FIG) || OWNK[j] !== key[j]) continue; // not a rig-figure cell written this frame
        if (OWN[j] === me) { // skip consecutive part ids: chained segments (thigh→shin, upper arm→forearm) join without a seam
          const pj = PRT[j]; if (pi && pj && pj !== pi && pj !== pi + 1 && pj + 1 !== pi && key[j] > ki + PBREAK) darken(i, K_PART);
        }
        else if (key[j] > ki) darken(i, K_CROWD); else darken(j, K_CROWD);
      }
    }
    return me;
  }
  // ---- biome-adaptive gain: keep the figure's lit side clearly brighter than the ground it stands on
  // Perceived ground value = albedo luminance × glyph ink coverage (a white '.' on black reads dark; a pink '@' reads
  // bright), sampled around the feet from the ground snapshot. Figures are dense bold glyphs (coverage ≈ FCOV).
  const COV = new Float32Array(256), FCOV = 0.62;
  (function () {
    const C = R.CHARSET || '';
    for (let i = 1; i < C.length && i < 128; i++) {
      const ch = C[i];
      const v = '#@%&8MWBQ$0NHRDGO'.includes(ch) ? 0.6 : ".,'`:;-~_^\"°·".includes(ch) ? 0.13 : '|/\\()!il1[]{}<>+=*'.includes(ch) ? 0.26 : 0.4;
      COV[i] = v; COV[i | 128] = Math.min(1, v * 1.3);
    }
  })();
  const GS = [-4, 0, 4, 0, -2, 1, 2, 1, 0, 2, -3, -1, 3, -1, 0, -3, -5, 2, 5, 2, -1, 3, 1, 3];
  function groundLum(x, y) {
    const snap = R._hasSnap && R._gCol && R._gCol.length === R.n * 3;
    const src = snap ? R._gCol : R.col, fl = snap ? R._gFlag : R.flag, gl = snap ? R._gGlyph : R.glyph;
    const ci = floor(x / CW) - R.ci0, cj = floor((y * TILT) / CH) - R.cj0, cols = R.cols, rows = R.rows;
    let s = 0, c = 0;
    for (let k = 0; k < GS.length; k += 2) {
      const xx = ci + GS[k], yy = cj + GS[k + 1]; if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
      const i = yy * cols + xx; if (fl[i] & (F_FIG | R.F_PROP)) continue;
      const o = i * 3; s += (src[o] * 0.3 + src[o + 1] * 0.55 + src[o + 2] * 0.15) * COV[gl[i]]; c++;
    }
    return c ? s / c : -1;
  }
  function figureGain(a, rig) {
    const amb = R.ambient, al = amb ? (amb[0] * 0.3 + amb[1] * 0.55 + amb[2] * 0.15) : 1;
    let lg = groundLum(a.x, a.y);
    if (lg < 0) lg = rig.lgLast || 0.1; rig.lgLast = lg;
    lg *= (R.groundDim || 0.64) * al;
    const ref = rig.lumRef || 0.5, lf = ref * TONE[3] * (R.figureLift || 1.2) * al * FCOV;
    FIG.dk = 1;
    if (lf < lg * 0.62) { FIG.dk = 1.25; FIG.mr = 0.06; return 1; } // dark figure on a light ground: deepen, don't brighten
    if (ref < 0.17) { FIG.mr = 0.5; return 1; } // a near-black figure on dark ground stays black: the moon rim carries it
    const want = lg * BC.gainT;
    // rim strength grows as the figure gets closer to the ground's value (dark-on-dark figures get a clear moon edge)
    FIG.mr = 0.12 + 0.4 * clamp(1 - lf / (want * 1.6 + 0.05), 0, 1);
    if (lf >= want) return 1;
    return clamp(want / lf, 1, 1.55);
  }

  // ======================================================================== figure transform
  // X maps local rig space to world: forward = facing, right = (-fy, fx), scale sc, plus actor position.
  const X = { x: 0, y: 0, z: 0, fx: 1, fy: 0, rx: 0, ry: 1, sc: 1 };
  function setX(a, rig) {
    X.x = a.x; X.y = a.y; X.z = a.z || 0;
    const f = rig.face; X.fx = cos(f); X.fy = sin(f); X.rx = -X.fy; X.ry = X.fx; X.sc = rig.sc * rig.pop;
  }
  function W(out, lx, ly, lz) { out[0] = X.x + (X.rx * lx + X.fx * ly) * X.sc; out[1] = X.y + (X.ry * lx + X.fy * ly) * X.sc; out[2] = X.z + lz * X.sc; return out; }
  function P(out, lx, ly, lz) {
    const wy = X.y + (X.ry * lx + X.fy * ly) * X.sc, wz = X.z + lz * X.sc;
    out[0] = X.x + (X.rx * lx + X.fx * ly) * X.sc; out[1] = wy * TILT - wz; out[2] = wy + wz * 0.03; return out;
  }
  // world point → projected
  function PW(out, x, y, z) { out[0] = x; out[1] = y * TILT - z; out[2] = y + z * 0.03; return out; }
  const _ia = [0, 0, 0], _ib = [0, 0, 0];
  function capV(A, B, ra, rb, ramp, c, e, ko) { P(_ia, A[0], A[1], A[2]); P(_ib, B[0], B[1], B[2]); const k = ko || 0; cap(_ia[0], _ia[1], _ia[2] + k, _ib[0], _ib[1], _ib[2] + k, ra * X.sc, rb * X.sc, ramp, c[0], c[1], c[2], e || 0); }
  function ballV(A, rad, ramp, c, e, ko) { P(_ia, A[0], A[1], A[2]); const k = _ia[2] + (ko || 0); cap(_ia[0], _ia[1], k, _ia[0], _ia[1] + 0.01, k, rad * X.sc, rad * X.sc, ramp, c[0], c[1], c[2], e || 0); }
  function lineV(A, B, g, c, e, ko) { P(_ia, A[0], A[1], A[2]); P(_ib, B[0], B[1], B[2]); const k = ko || 0; line(_ia[0], _ia[1], _ia[2] + k, _ib[0], _ib[1], _ib[2] + k, g || 0, c[0], c[1], c[2], e || 0); }
  function dotV(A, g, c, e, ko) { P(_ia, A[0], A[1], A[2]); dot(_ia[0], _ia[1], _ia[2] + (ko || 0), g, c[0], c[1], c[2], e || 0); }

  // ======================================================================== small vector / matrix helpers
  const v3 = () => [0, 0, 0];
  const _p = v3(), _q = v3(), _r = v3(), _s = v3(), _t = v3(); // draw-time scratch points (local space)
  const _col = v3(); // scratch color
  function set3(o, x, y, z) { o[0] = x; o[1] = y; o[2] = z; return o; }
  function copy3(o, a) { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; }
  function lerp3(o, a, b, t) { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; }
  function madd(o, a, d, s) { o[0] = a[0] + d[0] * s; o[1] = a[1] + d[1] * s; o[2] = a[2] + d[2] * s; return o; }
  function norm3(o) { const l = len3(o[0], o[1], o[2]) || 1; o[0] /= l; o[1] /= l; o[2] /= l; return o; }
  function bl3(o, x, y, z, w) { o[0] += (x - o[0]) * w; o[1] += (y - o[1]) * w; o[2] += (z - o[2]) * w; return o; }
  // row-major 3x3
  function mul3(o, A, B) {
    const a0 = A[0], a1 = A[1], a2 = A[2], a3 = A[3], a4 = A[4], a5 = A[5], a6 = A[6], a7 = A[7], a8 = A[8];
    const b0 = B[0], b1 = B[1], b2 = B[2], b3 = B[3], b4 = B[4], b5 = B[5], b6 = B[6], b7 = B[7], b8 = B[8];
    o[0] = a0 * b0 + a1 * b3 + a2 * b6; o[1] = a0 * b1 + a1 * b4 + a2 * b7; o[2] = a0 * b2 + a1 * b5 + a2 * b8;
    o[3] = a3 * b0 + a4 * b3 + a5 * b6; o[4] = a3 * b1 + a4 * b4 + a5 * b7; o[5] = a3 * b2 + a4 * b5 + a5 * b8;
    o[6] = a6 * b0 + a7 * b3 + a8 * b6; o[7] = a6 * b1 + a7 * b4 + a8 * b7; o[8] = a6 * b2 + a7 * b5 + a8 * b8;
    return o;
  }
  function rotX(o, a) { const c = cos(a), s = sin(a); o[0] = 1; o[1] = 0; o[2] = 0; o[3] = 0; o[4] = c; o[5] = s; o[6] = 0; o[7] = -s; o[8] = c; return o; }
  function rotZ(o, a) { const c = cos(a), s = sin(a); o[0] = c; o[1] = -s; o[2] = 0; o[3] = s; o[4] = c; o[5] = 0; o[6] = 0; o[7] = 0; o[8] = 1; return o; }
  function rotY(o, a) { const c = cos(a), s = sin(a); o[0] = c; o[1] = 0; o[2] = s; o[3] = 0; o[4] = 1; o[5] = 0; o[6] = -s; o[7] = 0; o[8] = c; return o; }
  function apply3(o, m, x, y, z) { o[0] = m[0] * x + m[1] * y + m[2] * z; o[1] = m[3] * x + m[4] * y + m[5] * z; o[2] = m[6] * x + m[7] * y + m[8] * z; return o; }
  const _m1 = new Float64Array(9), _m2 = new Float64Array(9), _m3 = new Float64Array(9);
  // two-bone IK: root A, target T, bone lengths l1/l2, pole hint → mid joint Mo, end Eo (reach-clamped)
  function ik(A, T, l1, l2, pole, Mo, Eo) {
    let dx = T[0] - A[0], dy = T[1] - A[1], dz = T[2] - A[2];
    const d = sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
    const dd = clamp(d, abs(l1 - l2) + 0.05, (l1 + l2) * 0.999);
    dx /= d; dy /= d; dz /= d;
    Eo[0] = A[0] + dx * dd; Eo[1] = A[1] + dy * dd; Eo[2] = A[2] + dz * dd;
    const a = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd), h = sqrt(max(0, l1 * l1 - a * a));
    let px = pole[0], py = pole[1], pz = pole[2];
    const pd = px * dx + py * dy + pz * dz; px -= dx * pd; py -= dy * pd; pz -= dz * pd;
    let pl = sqrt(px * px + py * py + pz * pz);
    if (pl < 1e-4) { px = 0; py = 0; pz = 1; pl = 1; }
    Mo[0] = A[0] + dx * a + (px / pl) * h; Mo[1] = A[1] + dy * a + (py / pl) * h; Mo[2] = A[2] + dz * a + (pz / pl) * h;
  }

  // ======================================================================== materials & weapons
  const MAT = {
    iron: ['#%:', [0.62, 0.64, 0.7], 0], steel: ['@%.', [0.86, 0.9, 0.98], 0], bronze: ['&o,', [0.84, 0.56, 0.3], 0],
    silver: ['$s.', [0.92, 0.94, 1.02], 0], gold: ['0o.', [1.0, 0.8, 0.32], 0], moonsteel: ['O*.', [0.72, 0.82, 1.05], 0.2],
    nightglass: ["N/'", [0.5, 0.42, 0.82], 0.15], bloodiron: ['B8:', [0.9, 0.16, 0.2], 0.1], ossite: ['=-.', [0.92, 0.88, 0.76], 0],
    emberstone: ['*+.', [1.0, 0.52, 0.16], 0.6], grass: ['"|;', [0.38, 0.84, 0.38], 0.12], demonblood: ['%&;', [0.82, 0.08, 0.17], 0.2],
    crystal: ['<>^', [0.55, 0.92, 1.05], 0.35], candy: ['@o*', [1.0, 0.52, 0.78], 0.05], glacial: ["*+'", [0.66, 0.9, 1.05], 0.3],
    rust: ['%#:', [0.58, 0.37, 0.24], 0], bone: ['=-.', [0.86, 0.83, 0.72], 0], wood: ['|!:', [0.45, 0.3, 0.17], 0],
    witch: ['*+.', [0.4, 1.0, 0.45], 0.7], void: ['%&.', [0.55, 0.28, 0.82], 0.35], ice: ["*+'", [0.66, 0.9, 1.05], 0.3],
  };
  const LOOKS = new WeakMap();
  function matLook(wp) {
    let L = LOOKS.get(wp);
    if (L && L.m === wp.material && L.gs === wp.glyphs && L.cs === wp.color) return L;
    const im = HM.Items && HM.Items.MATERIALS && HM.Items.MATERIALS[wp.material];
    const fb = MAT[wp.material] || MAT.iron;
    const gs = (wp.glyphs || (im && im.glyphs) || fb[0]) + '   ';
    const c = wp.color || (im && im.color) || fb[1];
    let e = im && im.emissive !== undefined ? im.emissive : fb[2];
    if (e === true) e = 0.5; e = +e || 0;
    L = { m: wp.material, gs: wp.glyphs, cs: wp.color, g0: gi(gs[0]) || GL.hash, g1: gi(gs[1]) || gi(gs[0]) || GL.pct, g2: gi(gs[2]) || GL.dot, c: [c[0], c[1], c[2]], e };
    LOOKS.set(wp, L);
    return L;
  }
  const WLEN = { sword: 29, axe: 28, bass: 40, staff: 66, wand: 13, bow: 17, spear: 64, claws: 7, fists: 0, none: 0 };

  // ======================================================================== verlet cloth / chains
  // A sheet is K columns × N points, pinned at row 0 to per-column anchors (world space). K=1 → rope.
  function sheet(K, N, len, o) {
    o = o || {};
    const n = K * N;
    return {
      K, N, len, init: false,
      x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), ox: new Float32Array(n), oy: new Float32Array(n), oz: new Float32Array(n),
      wid: o.wid || 0, widGrow: o.widGrow || 0, grav: o.grav === undefined ? 1 : o.grav, damp: o.damp || 0.9, back: o.back, front: o.front,
      ground: o.ground === undefined ? 0.6 : o.ground, stiff: o.stiff || 0, iters: o.iters || 3, radial: o.radial || 0, jitter: o.jitter || 0,
      ax: new Float32Array(K), ay: new Float32Array(K), az: new Float32Array(K),
    };
  }
  // anchors must be written into S.ax/ay/az (world). dir = initial hang direction.
  function sheetInit(S, dx, dy, dz) {
    for (let c = 0; c < S.K; c++) for (let j = 0; j < S.N; j++) {
      const i = c * S.N + j;
      S.x[i] = S.ox[i] = S.ax[c] + dx * S.len * j; S.y[i] = S.oy[i] = S.ay[c] + dy * S.len * j; S.z[i] = S.oz[i] = max(S.ground, S.az[c] + dz * S.len * j);
    }
    S.init = true;
  }
  function sheetStep(S, dt, a, sc) {
    if (!S.init) sheetInit(S, 0, 0, -1);
    const K = S.K, N = S.N, len = S.len * sc;
    if (dt > 0) {
      const g = 520 * S.grav * dt * dt, d = S.damp;
      for (let c = 0; c < K; c++) for (let j = 1; j < N; j++) {
        const i = c * N + j;
        const vx = (S.x[i] - S.ox[i]) * d, vy = (S.y[i] - S.oy[i]) * d, vz = (S.z[i] - S.oz[i]) * d;
        S.ox[i] = S.x[i]; S.oy[i] = S.y[i]; S.oz[i] = S.z[i];
        S.x[i] += vx; S.y[i] += vy; S.z[i] += vz - g;
        if (S.jitter) { const jt = S.jitter * dt; S.x[i] += (HM.rng.next() - 0.5) * jt; S.y[i] += (HM.rng.next() - 0.5) * jt; S.z[i] += HM.rng.next() * jt; }
      }
    }
    for (let c = 0; c < K; c++) { const i = c * N; S.x[i] = S.ax[c]; S.y[i] = S.ay[c]; S.z[i] = S.az[c]; }
    const fx = X.fx, fy = X.fy, cx = a.x, cy = a.y;
    for (let it = 0; it < S.iters; it++) {
      for (let c = 0; c < K; c++) for (let j = 1; j < N; j++) {
        const i = c * N + j, p = i - 1;
        let dx = S.x[i] - S.x[p], dy = S.y[i] - S.y[p], dz = S.z[i] - S.z[p];
        const dl = sqrt(dx * dx + dy * dy + dz * dz) || 1e-4, df = (dl - len) / dl;
        if (j === 1) { S.x[i] -= dx * df; S.y[i] -= dy * df; S.z[i] -= dz * df; }
        else { const h = df * 0.5; S.x[i] -= dx * h; S.y[i] -= dy * h; S.z[i] -= dz * h; S.x[p] += dx * h; S.y[p] += dy * h; S.z[p] += dz * h; }
        if (S.stiff && j >= 2) { // bending stiffness: pull toward the straight extension of the previous segment
          const q = p - 1, tx = S.x[p] * 2 - S.x[q], ty = S.y[p] * 2 - S.y[q], tz = S.z[p] * 2 - S.z[q];
          S.x[i] += (tx - S.x[i]) * S.stiff; S.y[i] += (ty - S.y[i]) * S.stiff; S.z[i] += (tz - S.z[i]) * S.stiff;
        }
      }
      if (K > 1 && S.wid) for (let j = 1; j < N; j++) {
        const w = (S.wid + S.widGrow * j) * sc;
        for (let c = 0; c < K - 1; c++) {
          const i = c * N + j, q = i + N;
          const dx = S.x[q] - S.x[i], dy = S.y[q] - S.y[i], dz = S.z[q] - S.z[i];
          const dl = sqrt(dx * dx + dy * dy + dz * dz) || 1e-4, h = ((dl - w) / dl) * 0.5;
          S.x[i] += dx * h; S.y[i] += dy * h; S.z[i] += dz * h; S.x[q] -= dx * h; S.y[q] -= dy * h; S.z[q] -= dz * h;
        }
      }
      for (let c = 0; c < K; c++) for (let j = 1; j < N; j++) {
        const i = c * N + j;
        if (S.back !== undefined) { const f = (S.x[i] - cx) * fx + (S.y[i] - cy) * fy, lim = -S.back * sc; if (f > lim) { S.x[i] -= fx * (f - lim); S.y[i] -= fy * (f - lim); } }
        if (S.front !== undefined) { const f = (S.x[i] - cx) * fx + (S.y[i] - cy) * fy, lim = S.front * sc; if (f < lim) { S.x[i] += fx * (lim - f); S.y[i] += fy * (lim - f); } }
        if (S.radial) { const dx = S.x[i] - cx, dy = S.y[i] - cy, d = sqrt(dx * dx + dy * dy) || 1e-4, rr = S.radial * sc; if (d < rr) { S.x[i] = cx + (dx / d) * rr; S.y[i] = cy + (dy / d) * rr; } }
        if (S.z[i] < S.ground) S.z[i] = S.ground;
      }
    }
  }
  // Draw a sheet as shaded quads (cloth / hair ribbons). col0 = root color, col1 = hem color (optional).
  const _sx = new Float32Array(256), _sy = new Float32Array(256), _sk = new Float32Array(256), _ss = new Float32Array(256);
  function drawSheet(S, ramp, col, col1, e, tatter, shadeK) {
    if (!S.init) return;
    const K = S.K, N = S.N; if (K < 2) return;
    for (let c = 0; c < K; c++) for (let j = 0; j < N; j++) {
      const i = c * N + j;
      _sx[i] = S.x[i]; _sy[i] = S.y[i] * TILT - S.z[i]; _sk[i] = S.y[i] + S.z[i] * 0.03;
      // normal from neighbours → fake two-sided lighting + fold banding
      const a = c > 0 ? i - N : i, b = c < K - 1 ? i + N : i, u = j > 0 ? i - 1 : i, d = j < N - 1 ? i + 1 : i;
      const t1x = S.x[b] - S.x[a], t1y = S.y[b] - S.y[a], t1z = S.z[b] - S.z[a];
      const t2x = S.x[d] - S.x[u], t2y = S.y[d] - S.y[u], t2z = S.z[d] - S.z[u];
      let nx = t1y * t2z - t1z * t2y, ny = t1z * t2x - t1x * t2z, nz = t1x * t2y - t1y * t2x;
      const nl = sqrt(nx * nx + ny * ny + nz * nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const sx = nx, sy = ny * 0.66 - nz * 0.75, sz = ny * 0.75 + nz * 0.66;
      const l = abs(sx * LX + sy * LY + sz * LZ);
      _ss[i] = clamp((0.16 + 0.84 * l) * (c & 1 ? 0.84 : 1) * (shadeK || 1) * (1 - 0.18 * j / (N - 1)), 0, 1);
    }
    nextPart(); FIG.hold++; // the whole sheet is one part (no internal breaks between its own triangles)
    for (let c = 0; c < K - 1; c++) for (let j = 0; j < N - 1; j++) {
      const i = c * N + j, i1 = i + N, i2 = i + 1, i3 = i + N + 1;
      const v0 = j / (N - 1), v1 = (j + 1) / (N - 1);
      let cr = col[0], cg = col[1], cb = col[2];
      if (col1) { const m = (v0 + v1) * 0.5; cr += (col1[0] - cr) * m; cg += (col1[1] - cg) * m; cb += (col1[2] - cb) * m; }
      tri(_sx[i], _sy[i], _sk[i], _ss[i], v0, _sx[i1], _sy[i1], _sk[i1], _ss[i1], v0, _sx[i3], _sy[i3], _sk[i3], _ss[i3], v1, ramp, cr, cg, cb, e, tatter);
      tri(_sx[i], _sy[i], _sk[i], _ss[i], v0, _sx[i3], _sy[i3], _sk[i3], _ss[i3], v1, _sx[i2], _sy[i2], _sk[i2], _ss[i2], v1, ramp, cr, cg, cb, e, tatter);
    }
    FIG.hold--;
  }
  // Draw each column of a sheet as a tapering strip of capsules (tatters, beard strands, tails).
  const _pa = [0, 0, 0], _pb = [0, 0, 0];
  function drawStrands(S, ramp, col, col1, r0, r1, e, sc) {
    if (!S.init) return;
    const N = S.N;
    for (let c = 0; c < S.K; c++) for (let j = 0; j < N - 1; j++) {
      const i = c * N + j, t = j / (N - 1);
      PW(_pa, S.x[i], S.y[i], S.z[i]); PW(_pb, S.x[i + 1], S.y[i + 1], S.z[i + 1]);
      let cr = col[0], cg = col[1], cb = col[2];
      if (col1) { cr += (col1[0] - cr) * t; cg += (col1[1] - cg) * t; cb += (col1[2] - cb) * t; }
      const ra = lerp(r0, r1, t) * sc, rb = lerp(r0, r1, (j + 1) / (N - 1)) * sc;
      cap(_pa[0], _pa[1], _pa[2], _pb[0], _pb[1], _pb[2], ra, rb, ramp, cr, cg, cb, e);
    }
  }

  // ======================================================================== rig state
  const DUR = { attack: 0.4, cast: 0.6, channel: 1.2, dodge: 0.32, hit: 0.24, stun: 1, spawn: 0.9, special: 0.9, idle: 1, dead: 1 };
  const ONESHOT = { attack: 1, cast: 1, dodge: 1, hit: 1, spawn: 1, special: 1 };
  const JOINTS = ['pel', 'ch', 'nk', 'hd', 'sh0', 'sh1', 'el0', 'el1', 'ha0', 'ha1', 'hp0', 'hp1', 'kn0', 'kn1', 'ft0', 'ft1', 'x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'];
  function makeJ() {
    const J = { list: [] };
    for (const n of JOINTS) { J[n] = v3(); J.list.push(J[n]); }
    J.sh = [J.sh0, J.sh1]; J.el = [J.el0, J.el1]; J.ha = [J.ha0, J.ha1]; J.hp = [J.hp0, J.hp1]; J.kn = [J.kn0, J.kn1]; J.ft = [J.ft0, J.ft1];
    // quadruped legs (front L/R from the shoulders, hind L/R from the hips) and the dragon's neck chain
    J.qr = [J.sh0, J.sh1, J.hp0, J.hp1]; J.qk = [J.el0, J.el1, J.kn0, J.kn1]; J.qf = [J.ha0, J.ha1, J.ft0, J.ft1];
    J.neck = [J.x1, J.x2, J.x3, J.x4, J.x5, J.x6]; J.neckAll = [J.ch, J.x1, J.x2, J.x3, J.x4, J.x5, J.x6, J.hd];
    J.wd = [0, 1, 0]; J.bd = [0, 0, 1]; J.up = [0, 0, 1];
    J.G = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]); J.H = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    J.mouth = 0; J.yaw = 0; J.hyaw = 0; J.hpit = 0; J.fall = 0; J.fallDir = 1; J.lift = 0; J.ball = 0; J.rollA = 0; J.glow = 0; J.spread = 0;
    return J;
  }
  // pose scratch (one at a time)
  const Q = {
    pz: 0, px: 0, py: 0, pitch: 0, roll: 0, twist: 0, yaw: 0, hpit: 0, hyaw: 0, mouth: 0, lift: 0, chUp: 0, spineK: 1,
    hand: [v3(), v3()], ft: [v3(), v3()], wd: v3(), bd: v3(), ball: 0, rollA: 0, fall: 0, fallDir: 1, glow: 0, spread: 0, twoHand: 0,
  };

  // body-space offset from a joint, rotated with the whole figure (yaw / fall / roll)
  function bodyPt(o, J, base, x, y, z) { apply3(o, J.G, x, y, z); o[0] += base[0]; o[1] += base[1]; o[2] += base[2]; return o; }
  // head-space offset (adds head pitch & yaw)
  function headPt(o, J, x, y, z) { apply3(o, J.H, x, y, z); o[0] += J.hd[0]; o[1] += J.hd[1]; o[2] += J.hd[2]; return o; }

  // ======================================================================== humanoid pose
  function body(o) {
    return Object.assign({
      hipZ: 35, thigh: 17, shin: 16.5, spine: 20, neck: 4, headR: 8, shW: 7.2, hipW: 3.8, upper: 11, fore: 10.5,
      waistR: 6.2, chestR: 7.4, armR: 2.5, legR: 3, stride: 50, liftH: 6, bob: 1.8, sway: 0.8, armSwing: 7, reach: 15,
    }, o);
  }
  // swing curves for weapon attacks (keyframes [u0,v0,u1,v1,...], ease-out per segment):
  // th = yaw of the hand around the chest (0 fwd, + right), hz = hand height vs chest, tl = blade elevation,
  // rc = reach, st = forward step, cr = crouch, tw = torso twist factor, tx = extra twist, yaw = whole-body spin
  const SW = {
    slash1: { th: [0, 0.5, 0.3, 2.0, 0.5, -1.7, 1, -1.2], hz: [0, -8, 0.3, 4, 0.5, -2, 1, -7], tl: [0, -0.4, 0.3, 0.9, 0.5, 0.0, 1, -0.5], rc: [0, 12, 0.3, 12, 0.5, 19, 1, 15], st: [0, 0, 0.3, -1.5, 0.5, 5, 1, 2], cr: [0, 0, 0.3, 1, 0.5, 3.5, 1, 1], tw: 0.38 },
    slash2: { th: [0, -1.2, 0.3, -1.7, 0.5, 2.0, 1, 1.4], hz: [0, -6, 0.3, 2, 0.5, -1, 1, -6], tl: [0, -0.4, 0.3, 0.5, 0.5, 0.05, 1, -0.4], rc: [0, 14, 0.3, 11, 0.5, 19, 1, 15], st: [0, 2, 0.3, 0, 0.5, 5, 1, 2], cr: [0, 1, 0.3, 1.5, 0.5, 3, 1, 1], tw: 0.38 },
    slash3: { th: [0, 1.3, 0.3, 0.7, 0.5, -0.7, 1, -0.4], hz: [0, -5, 0.3, 20, 0.5, -14, 1, -10], tl: [0, 0, 0.3, 1.5, 0.5, -0.9, 1, -0.7], rc: [0, 14, 0.3, 8, 0.5, 17, 1, 15], st: [0, 2, 0.3, -2, 0.5, 8, 1, 4], cr: [0, 1, 0.3, -1.5, 0.5, 7, 1, 3], tw: 0.3 },
    heavy: { th: [0, 0.5, 0.3, 2.6, 0.5, -2.3, 1, -1.8], hz: [0, -6, 0.3, 3, 0.5, -4, 1, -7], tl: [0, -0.3, 0.3, 0.6, 0.5, -0.1, 1, -0.5], rc: [0, 12, 0.3, 11, 0.5, 21, 1, 16], st: [0, 0, 0.3, -3, 0.5, 8, 1, 3], cr: [0, 0, 0.3, 4, 0.5, 6, 1, 2], tw: 0.5, two: 1 },
    overhead: { th: [0, 0.4, 0.3, 0.15, 0.5, 0.05, 1, 0.1], hz: [0, -6, 0.3, 22, 0.5, -18, 1, -14], tl: [0, -0.3, 0.3, 2.2, 0.5, -1.0, 1, -0.9], rc: [0, 12, 0.3, 4, 0.5, 16, 1, 14], st: [0, 0, 0.3, -2, 0.5, 7, 1, 4], cr: [0, 0, 0.3, -2, 0.5, 9, 1, 5], tw: 0.1, two: 1 },
    thrust: { th: [0, 0.4, 0.3, 0.5, 0.5, 0.0, 1, 0.15], hz: [0, -6, 0.3, -1, 0.5, -1, 1, -5], tl: [0, -0.3, 0.3, 0.0, 0.5, -0.02, 1, -0.3], rc: [0, 12, 0.3, 4, 0.5, 24, 1, 15], st: [0, 0, 0.3, -3, 0.5, 9, 1, 3], cr: [0, 0, 0.3, 2, 0.5, 3, 1, 1], tw: 0.2, tx: [0, 0, 0.3, -0.5, 0.5, 0.45, 1, 0.1] },
    spin: { th: [0, 0.6, 0.3, 1.8, 0.5, 1.35, 1, 1.0], hz: [0, -6, 0.3, -1, 0.5, -2, 1, -6], tl: [0, -0.3, 0.3, 0.2, 0.5, 0.0, 1, -0.4], rc: [0, 12, 0.3, 14, 0.5, 20, 1, 15], st: [0, 0, 0.3, 0, 0.5, 2, 1, 0], cr: [0, 0, 0.3, 3, 0.5, 4, 1, 1], tw: 0.2, yaw: [0, 0, 0.3, -0.3, 0.85, TAU, 1, TAU] },
  };
  SW.claw = SW.slash1; SW.bite = SW.thrust; SW.stretch = SW.thrust;
  function kf(u, k) {
    if (u <= k[0]) return k[1];
    for (let i = 2; i < k.length; i += 2) {
      if (u <= k[i]) { const t = (u - k[i - 2]) / (k[i] - k[i - 2] || 1), e = 1 - (1 - t) * (1 - t) * (1 - t); return k[i - 1] + (k[i + 1] - k[i - 1]) * e; }
    }
    return k[k.length - 1];
  }
  // phases of an action: anticipation (0..0.3), strike (0.3..0.5), recovery (0.5..1)
  const ANT = (u) => ease(seg01(u, 0, 0.3)), STR = (u) => ease(seg01(u, 0.3, 0.5)), REC = (u) => sm(seg01(u, 0.5, 1));

  // weapon kind used for posing
  function wKind(a, rig) { const wp = a.weapon || rig.weapon || rig.def.weapon; return (wp && wp.kind) || 'none'; }

  function poseHuman(a, rig) {
    const d = rig.def, B = rig.B, J = rig.J, T = rig.time, st = rig.st, u = rig.u, w = rig.w, sp = rig.sp, ph = rig.ph, v = rig.v;
    const mx = rig.mvx, my = rig.mvy, kind = wKind(a, rig);
    const gait = d.gait || 'walk';
    // ---------------------------------------------------------------- base: breathing + locomotion
    const br = sin(T * 2.2 + rig.seed);
    Q.pz = B.hipZ + br * 0.3 - B.bob * sp * (1 - abs(sin(ph)));
    Q.px = sin(ph) * B.sway * sp; Q.py = 0;
    Q.chUp = br * 0.45; Q.spineK = 1;
    Q.pitch = (B.hunch || 0) + my * sp * (0.05 + 0.12 * sp) + 0.02;
    Q.roll = mx * sp * 0.07; Q.twist = cos(ph) * 0.16 * sp; Q.yaw = 0;
    Q.hpit = (B.headPitch || 0) - Q.pitch * 0.5; Q.hyaw = 0; Q.mouth = 0; Q.glow = 0; Q.spread = 0; Q.twoHand = 0;
    Q.ball = 0; Q.rollA = 0; Q.fall = 0; Q.fallDir = 1;
    Q.lift = d.float ? d.float + sin(T * 1.7 + rig.seed) * (d.bob || 2.2) : 0;
    const A = (B.stride / TAU) * min(1, sp * 1.35), LH = B.liftH * min(1, sp * 1.6);
    const armZ = -(B.upper + B.fore) * 0.88;
    for (let s = 0; s < 2; s++) {
      const side = s ? 1 : -1, phs = ph + (s ? 0 : PI);
      let f = cos(phs) * A, l = max(0, -sin(phs)) * LH;
      if (gait === 'shamble' && s === 0) { f *= 0.45; l *= 0.12; }
      const ft = Q.ft[s];
      if (gait === 'float') { set3(ft, side * B.hipW * 1.1 + mx * f * 0.3, -2 - sp * 4 + sin(T * 1.7 + s) * 1.2, 1.5 + sp * 3); }
      else set3(ft, side * B.hipW * 1.15 + mx * f, my * f + 0.5, l);
      const sw = -cos(phs) * B.armSwing * sp, h = Q.hand[s];
      set3(h, side * (B.shW + 1.2 + sp * 0.5), 1.2 + sw * my + sp * 2.5, armZ + abs(sw) * 0.15 + sp * 3 + br * 0.2);
      if (gait === 'shamble') { h[1] += 7 + sin(T * 1.3 + s * 2) * 1.5; h[2] += 8; }
    }
    if (gait === 'waddle') Q.roll += sin(ph) * 0.24 * min(1, sp * 2.5) + sin(T * 1.4) * 0.03;
    if (gait === 'shamble') { Q.roll += sin(ph) * 0.12 * sp + sin(T * 0.9 + rig.seed) * 0.05; Q.hpit += 0.25; Q.hyaw = sin(T * 0.7 + rig.seed) * 0.3; }
    if (gait === 'stomp') Q.roll += sin(ph) * 0.1 * sp;
    if (d.idle) d.idle(a, rig, Q, T);
    restWeapon(rig, Q, kind, B, T, sp);
    // ---------------------------------------------------------------- action overlay
    if (st !== 'idle' && w > 0) {
      switch (st) {
        case 'attack': (d.attack || attackHuman)(a, rig, Q, v, u, w, kind); break;
        case 'cast': case 'channel': castHuman(a, rig, Q, st === 'channel' ? 'channel' : v, u, w, kind, a.anim.t || 0); break;
        case 'dodge': (d.dodge || dodgeHuman)(a, rig, Q, v, u, w); break;
        case 'stun': stunPose(rig, Q, T, w); break;
        case 'spawn': spawnHuman(a, rig, Q, u); break;
        case 'special': (d.special || specialHuman)(a, rig, Q, v, u, w, T); break;
        case 'dead': deadHuman(a, rig, Q); break;
        default: break;
      }
    }
    // ---------------------------------------------------------------- additive roar (trigger 'roar' / 'enrage')
    const ra = min(rig.trigAge('roar'), rig.trigAge('enrage'));
    if (ra < 0.9 && st !== 'dead') {
      const k = sm(ra / 0.12) * (1 - sm((ra - 0.6) / 0.3));
      Q.hpit -= 0.45 * k; Q.pitch -= 0.12 * k; Q.mouth = max(Q.mouth, k); Q.chUp += 1.5 * k;
      for (let s = 0; s < 2; s++) { Q.hand[s][0] += (s ? 1 : -1) * 6 * k; Q.hand[s][2] += 6 * k; }
      Q.px += sin(T * 60) * 0.6 * k;
    }
    // ---------------------------------------------------------------- additive hit flinch
    const fl = rig.fl;
    if (fl > 0.01 && st !== 'dead') {
      const e = fl * fl * (rig.def.flinchK || 1);
      Q.px += rig.flx * 4 * e; Q.py += rig.fly * 4 * e;
      Q.pitch += rig.fly * 0.4 * e; Q.roll += rig.flx * 0.3 * e; Q.hpit += rig.fly * 0.45 * e - 0.1 * e;
      Q.hand[0][2] += 3 * e; Q.hand[1][2] += 3 * e; Q.hand[0][0] -= 3 * e; Q.hand[1][0] += 3 * e;
    }
    buildHuman(rig, B);
  }

  function restWeapon(rig, Q, kind, B, T, sp) {
    const h = Q.hand[1], wd = Q.wd;
    switch (kind) {
      case 'sword': case 'claws': case 'wand':
        h[1] += 3; h[2] += 4; set3(wd, 0.32, 0.72, -0.4 + sin(T * 1.9) * 0.04);
        if (rig.def.bigWeapon) { set3(wd, 0.2, 0.55, -0.8); Q.hand[0][0] = 2; Q.hand[0][1] = h[1] + 1; Q.hand[0][2] = h[2] + 3; Q.twoHand = 1; }
        break;
      case 'axe':
        h[1] += 2; h[2] += 3; set3(wd, 0.18, 0.5, -0.8); break;
      case 'bass': // resting over the shoulder
        set3(h, B.shW + 1, 5, -9 + sin(T * 1.6) * 0.5); set3(wd, 0.08, -0.38, 1); break;
      case 'staff': case 'spear':
        set3(h, B.shW + 3, 6 + sp * 2, -8); set3(wd, 0.05, 0.1 + sp * 0.25, 1); break;
      case 'bow':
        set3(Q.hand[0], -B.shW - 2, 3, -12); set3(Q.bd, -0.1, 0.2, 1); set3(wd, 0, 1, 0); break;
      default: set3(wd, 0, 1, -0.3);
    }
  }

  function attackHuman(a, rig, Q, v, u, w, kind) {
    const B = rig.B;
    if (kind === 'bow' || v === 'shoot') { shootPose(rig, Q, u, w, kind, B); return; }
    if (kind === 'none' || kind === 'fists' || kind === 'claws' || v === 'punch' || v === 'slam' || v === 'breath' || v === 'bite' || v === 'stretch') {
      if (v === 'slam') { slamPose(rig, Q, u, w, B); return; }
      if (v === 'breath' || v === 'bite') { lungePose(rig, Q, u, w, B, v === 'breath'); return; }
      if (v === 'claw' || (kind === 'claws' && v !== 'punch' && v !== 'thrust')) { clawPose(rig, Q, u, w, B, v === 'slash2' ? -1 : 1); return; }
      if (v === 'spin' || v === 'heavy' || v === 'overhead' || v === 'slash3') { if (v === 'overhead' || v === 'slash3') { slamPose(rig, Q, u, w, B); return; } }
      else { punchPose(rig, Q, u, w, B, v === 'slash2' ? 0 : 1, v === 'stretch'); return; }
    }
    const S = SW[v] || SW.slash1;
    const th = kf(u, S.th), hz = kf(u, S.hz), tl = kf(u, S.tl), rc = kf(u, S.rc) * (B.reach / 15);
    const big = rig.def.bigWeapon || kind === 'bass' || kind === 'axe' || kind === 'staff' || kind === 'spear';
    const h = Q.hand[1];
    bl3(h, sin(th) * rc + (B.shW * 0.5), cos(th) * rc, hz, w);
    const ct = cos(tl);
    const wx = sin(th) * ct, wy = cos(th) * ct, wz = sin(tl);
    Q.wd[0] += (wx - Q.wd[0]) * w; Q.wd[1] += (wy - Q.wd[1]) * w; Q.wd[2] += (wz - Q.wd[2]) * w;
    Q.twist += (-th * S.tw + (S.tx ? kf(u, S.tx) : 0) - Q.twist) * w;
    Q.py += kf(u, S.st) * w; Q.pz -= kf(u, S.cr) * w; Q.pitch += kf(u, S.cr) * 0.035 * w;
    if (S.yaw) Q.yaw += kf(u, S.yaw) * w;
    if (S.two || (big && v !== 'thrust')) Q.twoHand = w;
    else { // off hand counter-balances
      const lh = Q.hand[0];
      bl3(lh, -B.shW - 4, -4 + 6 * STR(u) * (1 - REC(u)), -8 + 4 * ANT(u), w * 0.85);
    }
    if (kind === 'staff' || kind === 'wand') Q.glow = max(Q.glow, STR(u) * (1 - REC(u)));
  }
  function punchPose(rig, Q, u, w, B, s, stretch) {
    const side = s ? 1 : -1, h = Q.hand[s], o = Q.hand[1 - s];
    const an = ANT(u), sk = STR(u), rc = REC(u);
    const reach = 21 + (stretch ? 8 : 0);
    const y = lerp(lerp(4, -5, an), reach, sk), z = lerp(lerp(-8, -1, an), 0, sk), x = side * lerp(B.shW + 1, 2, sk);
    bl3(h, lerp(x, side * B.shW, rc), lerp(y, 8, rc), lerp(z, -6, rc), w);
    bl3(o, -side * (B.shW + 2), -2, -4, w * 0.7);
    Q.twist += ((side * 0.45 * an - side * 0.45 * sk) * (1 - rc)) * w;
    Q.py += (lerp(-1.5 * an, 5, sk) * (1 - rc)) * w; Q.pitch += 0.12 * sk * (1 - rc) * w;
  }
  function clawPose(rig, Q, u, w, B, dir) {
    const an = ANT(u), sk = STR(u), rc = REC(u);
    for (let s = 0; s < 2; s++) {
      const side = s ? 1 : -1, lag = s === (dir > 0 ? 1 : 0) ? 0 : 0.08;
      const k2 = ease(seg01(u, 0.3 + lag, 0.52 + lag));
      const x = lerp(side * 10, -side * 4, k2) * (1 - rc * 0.5), y = lerp(lerp(4, 2, an), 17, k2), z = lerp(lerp(-6, 10, an), -10, k2);
      bl3(Q.hand[s], x, y, z, w);
    }
    Q.pitch += (0.1 * an + 0.25 * sk) * (1 - rc) * w; Q.py += 5 * sk * (1 - rc) * w; Q.mouth = max(Q.mouth, an * (1 - rc));
  }
  function slamPose(rig, Q, u, w, B) {
    const an = ANT(u), sk = STR(u), rc = REC(u), chestZ = B.hipZ + B.spine;
    for (let s = 0; s < 2; s++) {
      const side = s ? 1 : -1;
      const x = side * lerp(lerp(B.shW, 4, an), 6, sk), y = lerp(lerp(4, 1, an), 15, sk), z = lerp(lerp(-8, 24, an), -chestZ + 10, sk);
      bl3(Q.hand[s], x, lerp(y, 8, rc), lerp(z, -12, rc), w);
    }
    Q.pitch += (-0.2 * an + 0.6 * sk) * (1 - rc) * w; Q.pz += (2 * an - 10 * sk) * (1 - rc) * w; Q.py += 5 * sk * (1 - rc) * w;
    Q.hpit += (-0.3 * an + 0.2 * sk) * (1 - rc) * w; Q.mouth = max(Q.mouth, an * (1 - sk));
    set3(Q.wd, 0, 0.6 + 0.4 * sk, lerp(1, -0.7, sk)); Q.twoHand = w;
  }
  function lungePose(rig, Q, u, w, B, breath) {
    const an = ANT(u), sk = STR(u), rc = REC(u);
    Q.pitch += (-0.25 * an + 0.45 * sk) * (1 - rc) * w; Q.py += (-3 * an + 7 * sk) * (1 - rc) * w;
    Q.hpit += (-0.5 * an + 0.35 * sk) * (1 - rc) * w; Q.mouth = max(Q.mouth, breath ? an * 0.6 + sk * (1 - rc) : an * (1 - sk));
    for (let s = 0; s < 2; s++) bl3(Q.hand[s], (s ? 1 : -1) * (B.shW + 4), -4, -6, w * (1 - rc));
    Q.glow = max(Q.glow, breath ? an * (1 - rc) : 0);
  }
  function shootPose(rig, Q, u, w, kind, B) {
    const an = ANT(u), rel = seg01(u, 0.3, 0.38), rc = REC(u);
    if (kind === 'bow') {
      bl3(Q.hand[0], -2, 17, 3, w);
      set3(Q.bd, -0.15, 0.1, 1);
      const pull = an * (1 - ease(rel));
      bl3(Q.hand[1], lerp(1, 3, pull), lerp(14, -2, pull) - 4 * ease(rel) * (1 - rc), lerp(2, 5, pull), w);
      Q.twist += (0.5 * an * (1 - rc)) * w; rig.draw01 = pull;
    } else {
      // wand / staff / bare-handed throw: point forward
      const k = max(an * 0.6, STR(u)) * (1 - rc);
      bl3(Q.hand[1], 2, lerp(4, 19, k), lerp(-6, 4, k), w);
      Q.wd[0] += (0.05 - Q.wd[0]) * w; Q.wd[1] += (0.95 - Q.wd[1]) * w; Q.wd[2] += (0.1 - Q.wd[2]) * w;
      bl3(Q.hand[0], -B.shW - 3, -3, -8, w * 0.8);
      Q.twist += (-0.3 * an + 0.3 * k) * w; Q.glow = max(Q.glow, k);
    }
  }
  function castHuman(a, rig, Q, v, u, w, kind, tLoop) {
    const B = rig.B, T = rig.time, an = ANT(u), sk = STR(u), rc = REC(u);
    const lev = rig.def.castLift || 0;
    const staff = kind === 'staff' || kind === 'spear';
    switch (v) {
      case 'raise': {
        const k = max(an, sk) * (1 - rc * 0.85);
        for (let s = 0; s < 2; s++) bl3(Q.hand[s], (s ? 1 : -1) * lerp(B.shW + 2, 6, k), lerp(2, 3, k), lerp(-10, 22, k) + sin(T * 31 + s) * 0.5 * k, w);
        Q.hpit -= 0.35 * k * w; Q.pitch -= 0.1 * k * w; Q.lift += lev * k * w; Q.glow = max(Q.glow, k);
        if (staff) set3(Q.wd, 0, 0.1, 1);
        break;
      }
      case 'summon': {
        const k1 = an * (1 - sk), k2 = sk * (1 - rc);
        for (let s = 0; s < 2; s++) { const side = s ? 1 : -1; bl3(Q.hand[s], side * (lerp(B.shW, 19, k1) + 3 * k2), lerp(2, 0, k1) + 8 * k2, lerp(-10, 14, k1) - 14 * k2, w); }
        Q.pz -= 7 * k2 * w; Q.pitch += (0.4 * k2 - 0.15 * k1) * w; Q.hpit += (-0.4 * k1 + 0.3 * k2) * w;
        Q.lift += lev * k1 * w; Q.glow = max(Q.glow, max(k1, k2)); Q.spread = max(Q.spread, k1); Q.mouth = max(Q.mouth, k1 * 0.6);
        break;
      }
      case 'channel': {
        const k = sm(tLoop / 0.25);
        for (let s = 0; s < 2; s++) bl3(Q.hand[s], (s ? 1 : -1) * 4 + sin(T * 40 + s * 2) * 0.6, 15, 2 + cos(T * 37 + s) * 0.6, w * k);
        Q.pitch += 0.1 * k * w; Q.lift += lev * 0.7 * k * w; Q.glow = max(Q.glow, k * (0.7 + 0.3 * sin(T * 9)));
        break;
      }
      default: { // forward
        const push = max(0, sk - rc);
        bl3(Q.hand[1], lerp(lerp(B.shW, B.shW + 1, an), 3, push), lerp(lerp(4, -3, an), 19, push), lerp(-6, 6 * an, 1 - push) + 2 * push, w);
        bl3(Q.hand[0], -B.shW - 2 + 4 * push, 4 + 8 * push, -4 + 2 * push, w * 0.9);
        Q.pitch += (0.16 * push - 0.06 * an) * w; Q.twist += (0.35 * an - 0.25 * push) * w; Q.py += 3 * push * w;
        Q.lift += lev * 0.5 * max(an, push) * w; Q.glow = max(Q.glow, max(an * 0.7, push));
        if (staff) { Q.wd[0] = 0.05; Q.wd[1] = lerp(0.2, 0.75, push); Q.wd[2] = lerp(1, 0.6, push); }
      }
    }
  }
  function dodgeHuman(a, rig, Q, v, u, w) {
    const B = rig.B;
    if (v === 'dash' || v === 'slide') {
      const k = sm(seg01(u, 0, 0.15)) * (1 - sm(seg01(u, 0.75, 1)));
      Q.pitch += 0.55 * k; Q.pz -= 3 * k;
      bl3(Q.ft[0], -B.hipW, -9, 1, k); bl3(Q.ft[1], B.hipW, 10, 2, k);
      for (let s = 0; s < 2; s++) bl3(Q.hand[s], (s ? 1 : -1) * (B.shW + 3), -12, -6, k);
      return;
    }
    if (v === 'bat') return; // drawn as a bat swarm
    // roll: tuck into a ball and tumble 360°
    const k = sm(seg01(u, 0, 0.14)) * (1 - sm(seg01(u, 0.8, 1)));
    Q.ball = k; Q.rollA = TAU * ease(seg01(u, 0.04, 0.92));
    Q.pz -= 14 * k; Q.pitch += 0.9 * k; Q.hpit += 0.5 * k;
    for (let s = 0; s < 2; s++) { bl3(Q.ft[s], (s ? 1 : -1) * 3, 4, 10, k); bl3(Q.hand[s], (s ? 1 : -1) * 5, 9, -12, k); }
  }
  function stunPose(rig, Q, T, w) {
    Q.roll += sin(T * 4.2) * 0.17 * w; Q.pitch += (0.14 + cos(T * 4.2) * 0.1) * w; Q.hpit += 0.35 * w; Q.hyaw += sin(T * 3.1) * 0.35 * w;
    Q.pz -= 2.5 * w;
    for (let s = 0; s < 2; s++) bl3(Q.hand[s], (s ? 1 : -1) * (rig.B.shW + 2), 3, -(rig.B.upper + rig.B.fore) * 0.95, w * 0.8);
  }
  function spawnHuman(a, rig, Q, u) {
    const B = rig.B;
    if (rig.def.bony) { // claw up out of the ground
      const k = ease(seg01(u, 0, 0.85));
      Q.lift -= (B.hipZ + B.spine + B.headR * 2) * (1 - k) * 0.95;
      const reach = 1 - sm(seg01(u, 0.55, 1));
      for (let s = 0; s < 2; s++) bl3(Q.hand[s], (s ? 1 : -1) * 6, 7 + sin(u * 14 + s * 2) * 2, 16 + sin(u * 11 + s) * 3, reach);
      Q.pitch += 0.35 * (1 - k); Q.hpit -= 0.3 * reach;
    } else {
      Q.pz -= 6 * (1 - ease(u)); Q.hpit += 0.3 * (1 - u);
    }
  }
  function specialHuman(a, rig, Q, v, u, w, T) {
    // generic taunt / roar: arms flung out, head back, mouth open
    const k = sm(seg01(u, 0, 0.2)) * (1 - sm(seg01(u, 0.8, 1)));
    for (let s = 0; s < 2; s++) bl3(Q.hand[s], (s ? 1 : -1) * 18, 3, 8 + sin(T * 25 + s) * 2 * k, k * w);
    Q.hpit -= 0.45 * k * w; Q.pitch -= 0.15 * k * w; Q.mouth = max(Q.mouth, k); Q.spread = max(Q.spread, k);
  }
  function deadHuman(a, rig, Q) {
    // collapse: knees buckle, then the body falls like a cut tree (away from the killing blow), with a little bounce
    const B = rig.B, t = rig.deadT / (a.isBoss ? 1.8 : 1); // bosses stagger and topple slowly
    const k1 = ease(clamp(t / 0.35, 0, 1));
    const k2 = clamp((t - 0.08) / 0.5, 0, 1), fall = k2 < 1 ? k2 * k2 : 1;
    const bounce = t > 0.58 ? sin(clamp((t - 0.58) / 0.25, 0, 1) * PI) * 0.12 * (1 - clamp((t - 0.58) / 0.25, 0, 1)) : 0;
    Q.pz = lerp(Q.pz, B.hipZ * 0.55, k1); Q.lift *= 1 - k1;
    Q.fall = (PI / 2 - 0.12) * fall - bounce; Q.fallDir = rig.fallDir;
    for (let s = 0; s < 2; s++) { const side = s ? 1 : -1; bl3(Q.hand[s], side * (B.shW + 8), 4 - 6 * rig.fallDir, -6, k1); bl3(Q.ft[s], side * (B.hipW + 2), 0, 0, k1); }
    Q.hpit += 0.4 * k1; Q.mouth = 0.4 * k1;
  }

  // Build humanoid joints from Q, then apply the global transforms.
  const _tmp = [0, 0, 0], _tmp2 = [0, 0, 0], _pole = [0, 0, 0];
  function buildHuman(rig, B) {
    const J = rig.J;
    set3(J.pel, Q.px, Q.py, Q.pz);
    const sp = sin(Q.pitch), cp = cos(Q.pitch), sr = sin(Q.roll), cr = cos(Q.roll);
    const ux = sr, uy = sp * cr, uz = cp * cr;
    set3(J.up, ux, uy, uz);
    const L = B.spine * Q.spineK;
    set3(J.ch, J.pel[0] + ux * L, J.pel[1] + uy * L, J.pel[2] + uz * L + Q.chUp);
    madd(J.nk, J.ch, J.up, B.neck);
    const hp = Q.pitch + Q.hpit * 0.4;
    const hux = sr, huy = sin(hp) * cr, huz = cos(hp) * cr;
    set3(J.hd, J.nk[0] + hux * B.headR * 0.78, J.nk[1] + huy * B.headR * 0.78 + (B.headFwd || 0), J.nk[2] + huz * B.headR * 0.78);
    const tw = Q.twist, ctw = cos(tw) * B.shW, stw = sin(tw) * B.shW;
    set3(J.sh0, J.ch[0] - ctw, J.ch[1] - stw, J.ch[2] - 1.5);
    set3(J.sh1, J.ch[0] + ctw, J.ch[1] + stw, J.ch[2] - 1.5);
    const htw = -tw * 0.4, chx = cos(htw) * B.hipW, chy = sin(htw) * B.hipW;
    set3(J.hp0, J.pel[0] - chx, J.pel[1] - chy, J.pel[2] - 1);
    set3(J.hp1, J.pel[0] + chx, J.pel[1] + chy, J.pel[2] - 1);
    // weapon dir (normalize) + two-handed grip
    copy3(J.wd, Q.wd); norm3(J.wd); copy3(J.bd, Q.bd); norm3(J.bd);
    if (Q.twoHand > 0) {
      const gx = J.ch[0] + Q.hand[1][0] - J.wd[0] * 6, gy = J.ch[1] + Q.hand[1][1] - J.wd[1] * 6, gz = J.ch[2] + Q.hand[1][2] - J.wd[2] * 6;
      const lh = Q.hand[0];
      lh[0] += (gx - J.ch[0] - lh[0]) * Q.twoHand; lh[1] += (gy - J.ch[1] - lh[1]) * Q.twoHand; lh[2] += (gz - J.ch[2] - lh[2]) * Q.twoHand;
    }
    for (let s = 0; s < 2; s++) {
      const side = s ? 1 : -1;
      set3(_tmp, J.ch[0] + Q.hand[s][0], J.ch[1] + Q.hand[s][1], J.ch[2] + Q.hand[s][2]);
      set3(_pole, side * 0.7, -0.75, -0.5);
      ik(J.sh[s], _tmp, B.upper, B.fore, _pole, J.el[s], J.ha[s]);
      set3(_pole, side * 0.15, 1, 0.1);
      ik(J.hp[s], Q.ft[s], B.thigh, B.shin, _pole, J.kn[s], J.ft[s]);
    }
    finalize(rig, B.hipZ * 0.5);
  }
  // Global transforms: tuck/roll (dodge), yaw (spin), fall (death), lift (float/levitate).
  const _mR = new Float64Array(9), _mB = new Float64Array(9), _m4 = new Float64Array(9);
  function finalize(rig, ballZ) {
    const J = rig.J;
    J.mouth = Q.mouth; J.glow = Q.glow; J.spread = Q.spread; J.lift = Q.lift; J.ball = Q.ball; J.yaw = Q.yaw; J.fall = Q.fall; J.fallDir = Q.fallDir;
    J.hpit = Q.hpit; J.hyaw = Q.hyaw;
    // points: p' = Rx(fall)·Rz(yaw)·[C + Rx(roll)·(p − C)·shrink]   (C = tuck-ball center on the z axis)
    // directions / body offsets use G = Rx(fall)·Rz(yaw)·Rx(roll); head offsets use H = G·Rz(hyaw)·Rx(hpit)
    rotX(_m1, Q.fall * Q.fallDir); rotZ(_m2, Q.yaw); mul3(_mB, _m1, _m2);
    rotX(_mR, Q.rollA); mul3(J.G, _mB, _mR);
    rotZ(_m1, Q.hyaw); rotX(_m2, Q.hpit + Q.pitch * 0.5); mul3(_m4, _m1, _m2); mul3(J.H, J.G, _m4);
    const rolling = Q.ball > 0.001 || Q.rollA !== 0, cz = ballZ, shrink = 1 - 0.5 * Q.ball;
    const list = J.list, floorZ = Q.fall > 0.2 ? 0.8 : -1e9;
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      let x = p[0], y = p[1], z = p[2];
      if (rolling) { apply3(_tmp2, _mR, x * shrink, y * shrink, (z - cz) * shrink); x = _tmp2[0]; y = _tmp2[1]; z = _tmp2[2] + cz; }
      apply3(_tmp2, _mB, x, y, z);
      p[0] = _tmp2[0]; p[1] = _tmp2[1]; p[2] = max(floorZ, _tmp2[2]) + Q.lift;
    }
    apply3(_tmp, J.G, J.wd[0], J.wd[1], J.wd[2]); copy3(J.wd, _tmp);
    apply3(_tmp, J.G, J.bd[0], J.bd[1], J.bd[2]); copy3(J.bd, _tmp);
    apply3(_tmp, J.G, J.up[0], J.up[1], J.up[2]); copy3(J.up, _tmp);
  }

  // ======================================================================== shared part drawing
  function drawLegsFlesh(rig, cT, cS, cF, rT, rS, ramp) {
    const J = rig.J, rp = ramp || RP.cloth;
    for (let s = 0; s < 2; s++) {
      capV(J.hp[s], J.kn[s], rT, rT * 0.9, rp, cT);
      capV(J.kn[s], J.ft[s], rS, rS * 0.85, rp, cS);
      if (cF) { bodyPt(_p, J, J.ft[s], 0, 3, 0.4); capV(J.ft[s], _p, rS * 0.95, rS * 0.85, RP.cloth, cF, 0, 0.2); }
    }
  }
  // Bone limbs are solid bone capsules (dense bone glyphs, 1–2 cells wide) with knobby joints — never thin
  // | / \ strokes, which read exactly like the grass blades they stand in.
  function drawLegsBone(rig, c) {
    const J = rig.J;
    for (let s = 0; s < 2; s++) {
      capV(J.hp[s], J.kn[s], 1.95, 1.6, RP.bone, c); capV(J.kn[s], J.ft[s], 1.75, 1.5, RP.bone, c);
      ballV(J.kn[s], 2.3, RP.bone, c, 0, 0.3);
      bodyPt(_p, J, J.ft[s], 0, 3.5, 0); capV(J.ft[s], _p, 1.9, 1.6, RP.bone, c, 0, 0.2);
    }
    capV(J.hp0, J.hp1, 2.4, 2.4, RP.bone, c);
  }
  function drawArmsCloth(rig, cU, cF, cH, rU, rF, ramp, skip) {
    const J = rig.J, rp = ramp || RP.cloth;
    for (let s = 0; s < 2; s++) {
      if (skip === s || skip === 2) continue; // 2 = both (the arms are drawn elsewhere, e.g. Jake's whirl)
      capV(J.sh[s], J.el[s], rU, rU * 0.92, rp, cU);
      capV(J.el[s], J.ha[s], rF, rF * 0.9, rp, cF);
      if (cH) ballV(J.ha[s], max(1.9, rF * 0.95), RP.skin, cH, 0, 0.3);
    }
  }
  function drawArmsBone(rig, c, skip) {
    const J = rig.J;
    for (let s = 0; s < 2; s++) {
      if (skip === s) continue;
      capV(J.sh[s], J.el[s], 1.7, 1.5, RP.bone, c); capV(J.el[s], J.ha[s], 1.6, 1.45, RP.bone, c);
      ballV(J.el[s], 2.0, RP.bone, c, 0, 0.2); ballV(J.ha[s], 2.1, RP.bone, c, 0, 0.3);
    }
  }
  function drawTorso(rig, c, rW, rC, ramp, e) { const J = rig.J; capV(J.pel, J.ch, rW, rC, ramp || RP.cloth, c, e); }
  function drawRibcage(rig, c) {
    const J = rig.J, B = rig.B;
    lineV(J.pel, J.ch, GL.colon, c);
    madd(_p, J.ch, J.up, -B.spine * 0.62); madd(_q, J.ch, J.up, 0.5);
    const pt = FIG.pat; FIG.pat = PAT_RIBS; capV(_p, _q, B.chestR * 0.82, B.chestR, RP.bone, c); FIG.pat = pt;
    // collarbone
    lineV(J.sh0, J.sh1, GL.eq, c, 0, 0.4);
  }
  function drawSkull(rig, r, c, eyeC, eyeE, jaw) {
    const J = rig.J;
    ballV(J.hd, r, RP.bone, c, 0, 0.6);
    const f = eyes(rig, r * 0.4, r * 0.8, r * 0.1, eyeC || [0.03, 0.03, 0.03], eyeE || 0, eyeE ? GL.o : GL.dot, 2);
    if (f && jaw !== false) cellDot(f.ci, f.cj + 1, f.k, J.mouth > 0.3 ? GL.O : GL.eq, J.mouth > 0.3 ? [0.05, 0.03, 0.03] : [c[0] * 0.75, c[1] * 0.75, c[2] * 0.75], 0);
  }
  // Eyes snapped to cells around the face-center cell so they always read as eye·face·eye and never merge into
  // one dark blob on these tiny heads. Turned heads shift toward the facing side; profiles show one eye; heads
  // facing away show none. Returns the face cell {ci, cj, k} (for mouths) or null.
  const EYE_HIT = { ci: 0, cj: 0, k: 0 };
  function eyes(rig, ox, fwd, oz, c, e, g, ko) {
    const J = rig.J;
    apply3(_pa, J.H, 0, 1, 0);
    const wfx = X.rx * _pa[0] + X.fx * _pa[1], wfy = X.ry * _pa[0] + X.fy * _pa[1];
    if (wfy < -0.3) return null;
    headPt(_p, J, 0, fwd, oz); P(_ib, _p[0], _p[1], _p[2]);
    const fx = _ib[0] / CW, ci = floor(fx), cj = floor(_ib[1] / CH), k = _ib[2] + (ko === undefined ? 2 : ko);
    const wide = ox * X.sc >= 2.4;
    if (abs(wfx) > 0.78) { cellDot(ci + (wfx > 0 ? 1 : -1) * (wide ? 1 : 0), cj, k, g || GL.dot, c, e); }
    else if (wide) { const sh = wfx > 0.3 ? 1 : wfx < -0.3 ? -1 : 0; cellDot(ci - 1 + sh, cj, k, g || GL.dot, c, e); cellDot(ci + 1 + sh, cj, k, g || GL.dot, c, e); }
    else { const c0 = fx - ci < 0.5 ? ci - 1 : ci; cellDot(c0, cj, k, g || GL.dot, c, e); cellDot(c0 + 1, cj, k, g || GL.dot, c, e); }
    EYE_HIT.ci = ci; EYE_HIT.cj = cj; EYE_HIT.k = k; return EYE_HIT;
  }
  function drawWeapon(a, rig, wp, opts) {
    if (!wp || !wp.kind || wp.kind === 'none' || wp.kind === 'fists') return;
    const J = rig.J, kind = wp.kind, L = matLook(wp), h = J.ha1, d = J.wd;
    const big = rig.def.bigWeapon ? 1.5 : 1;
    const len = (WLEN[kind] || 20) * big * (opts && opts.lenK || 1);
    const c = L.c, e = L.e;
    switch (kind) {
      case 'sword': {
        madd(_p, h, d, -4); lineV(_p, h, GL.bar, [0.32, 0.2, 0.12]); dotV(_p, GL.o, [0.6, 0.55, 0.45]);
        madd(_q, h, d, 1.5);
        // crossguard: perpendicular to the blade, roughly horizontal
        let gx = -d[1], gy = d[0]; const gl = len2(gx, gy) || 1; gx = (gx / gl) * 3.2; gy = (gy / gl) * 3.2;
        set3(_r, _q[0] - gx, _q[1] - gy, _q[2]); set3(_s, _q[0] + gx, _q[1] + gy, _q[2]);
        lineV(_r, _s, 0, [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55], 0, 0.5);
        madd(_r, h, d, len);
        P(_ia, _q[0], _q[1], _q[2]); P(_ib, _r[0], _r[1], _r[2]);
        bline(_ia[0], _ia[1], _ia[2] + 0.6, _ib[0], _ib[1], _ib[2] + 0.6, L.g0, L.g1, L.g2, c[0], c[1], c[2], e);
        if (big > 1) { bline(_ia[0] + 2.6, _ia[1] + 1, _ia[2] + 0.5, _ib[0] + 2.6, _ib[1] + 1, _ib[2] + 0.5, L.g1, L.g0, L.g2, c[0] * 0.7, c[1] * 0.7, c[2] * 0.7, e); }
        break;
      }
      case 'axe': {
        madd(_p, h, d, -7); madd(_q, h, d, len);
        lineV(_p, _q, 0, [0.42, 0.28, 0.16]);
        // head: a wedge on one side of the haft
        let ox = d[1], oy = -d[0]; const ol = len2(ox, oy) || 1; ox /= ol; oy /= ol;
        madd(_r, h, d, len - 6); set3(_s, _r[0] + ox * 7, _r[1] + oy * 7, _r[2]); set3(_t, _q[0] + ox * 6, _q[1] + oy * 6, _q[2]);
        capV(_r, _s, 2.6, 2.2, RP.metal, c, e, 0.4); capV(_q, _t, 2.2, 2.8, RP.metal, c, e, 0.4);
        P(_ia, _s[0], _s[1], _s[2]); P(_ib, _t[0], _t[1], _t[2]);
        bline(_ia[0], _ia[1], _ia[2] + 0.8, _ib[0], _ib[1], _ib[2] + 0.8, L.g0, L.g1, L.g2, c[0] * 1.1, c[1] * 1.1, c[2] * 1.1, e);
        break;
      }
      case 'bass': { // Marceline's axe-bass: long neck, axe-shaped body, a steel edge
        const body = (opts && opts.bodyCol) || [0.62, 0.07, 0.1];
        madd(_p, h, d, -12); madd(_q, h, d, len * 0.62);
        lineV(_p, _q, GL.eq, [0.18, 0.1, 0.08], 0, 0.3);
        dotV(_p, GL.lt, [0.6, 0.55, 0.5], 0, 0.5); // tuning pegs at the far end
        let ox = d[1], oy = -d[0]; const ol = len2(ox, oy) || 1; ox /= ol; oy /= ol;
        madd(_r, h, d, len * 0.62); madd(_s, h, d, len);
        capV(_r, _s, 4.6, 3.4, RP.dark, body, 0, 0.3);
        set3(_t, _s[0] + ox * 7, _s[1] + oy * 7, _s[2]); capV(_s, _t, 3.2, 2.2, RP.dark, body, 0, 0.3);
        set3(_t, _r[0] + ox * 6, _r[1] + oy * 6, _r[2]); capV(_r, _t, 3, 2.4, RP.dark, body, 0, 0.3);
        // the axe edge in the weapon's material
        set3(_r, _r[0] + ox * 8.5, _r[1] + oy * 8.5, _r[2]); set3(_t, _s[0] + ox * 9, _s[1] + oy * 9, _s[2]);
        P(_ia, _r[0], _r[1], _r[2]); P(_ib, _t[0], _t[1], _t[2]);
        bline(_ia[0], _ia[1], _ia[2] + 1, _ib[0], _ib[1], _ib[2] + 1, L.g0, L.g1, L.g2, c[0], c[1], c[2], e + 0.05);
        break;
      }
      case 'staff': case 'spear': {
        madd(_p, h, d, -len * 0.5); madd(_q, h, d, len * 0.5);
        lineV(_p, _q, 0, kind === 'staff' ? [0.36, 0.25, 0.16] : [0.4, 0.33, 0.24]);
        if (kind === 'spear') {
          madd(_r, h, d, len * 0.5 + 7);
          P(_ia, _q[0], _q[1], _q[2]); P(_ib, _r[0], _r[1], _r[2]);
          bline(_ia[0], _ia[1], _ia[2] + 0.5, _ib[0], _ib[1], _ib[2] + 0.5, L.g0, L.g1, GL.caret, c[0], c[1], c[2], e);
        } else {
          const ge = 0.6 + J.glow * 1.2 + sin(rig.time * 7) * 0.15;
          const oc = (opts && opts.orb) || c;
          madd(_r, h, d, len * 0.5 + 2.5);
          ballV(_r, 3.2 + J.glow * 1.5, RP.fire, oc, ge, 1);
          // witchfire / crystal flicker above the orb
          for (let k = 0; k < 3; k++) {
            const ft = rig.time * 5 + k * 2.1, ph = ft % 1;
            set3(_s, _r[0] + sin(ft * 3.1 + k) * 2, _r[1] + cos(ft * 2.3) * 1, _r[2] + 3 + ph * 9);
            dotV(_s, ph < 0.3 ? GL.star : ph < 0.6 ? GL.plus : GL.ap, oc, (1 - ph) * ge, 1.2);
          }
          R.light && emitLight(W(_t, _r[0], _r[1], _r[2]), 50 + J.glow * 40, oc, 0.45 + J.glow * 0.5);
        }
        break;
      }
      case 'wand': {
        madd(_q, h, d, len);
        lineV(h, _q, 0, [0.35, 0.22, 0.14]);
        const ge = 0.5 + J.glow * 1.3 + sin(rig.time * 8) * 0.15;
        dotV(_q, L.g0, c, ge, 1); madd(_r, h, d, len + 2.5); dotV(_r, L.g2, c, ge * 0.6, 1);
        if (e > 0.2 || J.glow > 0.2) emitLight(W(_t, _q[0], _q[1], _q[2]), 34 + J.glow * 30, c, 0.3 + J.glow * 0.6);
        break;
      }
      case 'claws': {
        for (let k = -1; k <= 1; k++) {
          set3(_p, h[0] + k * 1.2, h[1], h[2]); madd(_q, _p, d, len); _q[0] += k * 2.2; _q[2] += k * 0.6;
          lineV(_p, _q, 0, c, e, 0.4);
        }
        break;
      }
      case 'bow': drawBow(a, rig, L); break;
      default: break;
    }
  }
  function drawBow(a, rig, L) {
    const J = rig.J, h = J.ha0, b = J.bd, wood = [0.48, 0.33, 0.2];
    // limbs bend back toward the archer; the body's forward is rotated by the figure yaw
    apply3(_t, J.G, 0, -1, 0);
    const bend = 5;
    madd(_p, h, b, 17); madd(_p, _p, _t, bend); madd(_q, h, b, -17); madd(_q, _q, _t, bend);
    madd(_r, h, b, 9); madd(_r, _r, _t, 1.5); madd(_s, h, b, -9); madd(_s, _s, _t, 1.5);
    lineV(h, _r, 0, wood, 0, 0.4); lineV(_r, _p, 0, wood, 0, 0.4); lineV(h, _s, 0, wood, 0, 0.4); lineV(_s, _q, 0, wood, 0, 0.4);
    const pull = rig.st === 'attack' ? (rig.draw01 || 0) : 0, sc = [0.75, 0.72, 0.6];
    if (pull > 0.05) {
      lineV(_p, J.ha1, 0, sc, 0, 0.2); lineV(_q, J.ha1, 0, sc, 0, 0.2);
      apply3(_t, J.G, 0, 1, 0); madd(_r, h, _t, 5);
      lineV(J.ha1, _r, GL.dash, [0.7, 0.62, 0.5], 0, 0.6); dotV(_r, GL.gt, L.c, L.e, 0.8);
    } else lineV(_p, _q, 0, sc, 0, 0.2);
  }
  function drawShield(rig, c) {
    const J = rig.J;
    bodyPt(_p, J, J.ha0, -1.5, 2.5, 1);
    ballV(_p, 5.2, RP.metal, c, 0, 0.8);
    dotV(_p, GL.o, [min(1.2, c[0] * 1.6), min(1.2, c[1] * 1.6), min(1.2, c[2] * 1.6)], 0, 2);
  }
  // soft blob shadow on the ground (inline version of R.shadowEllipse)
  function shadow(x, y, rx, ry, amount) {
    if (amount <= 0.01 || rx < 1) return;
    const cy = y * TILT, ryp = ry * TILT, cols = R.cols, shd = R.shd;
    let x0 = floor((x - rx) / CW) - R.ci0, x1 = floor((x + rx) / CW) - R.ci0, y0 = floor((cy - ryp) / CH) - R.cj0, y1 = floor((cy + ryp) / CH) - R.cj0;
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 >= cols) x1 = cols - 1; if (y1 >= R.rows) y1 = R.rows - 1;
    const irx = 1 / rx, iry = 1 / ryp;
    for (let j = y0; j <= y1; j++) {
      const ey = ((j + R.cj0 + 0.5) * CH - cy) * iry, ey2 = ey * ey;
      if (ey2 >= 1) continue;
      let i = j * cols + x0;
      for (let k = x0; k <= x1; k++, i++) {
        const ex = ((k + R.ci0 + 0.5) * CW - x) * irx, u2 = ex * ex + ey2;
        if (u2 >= 1) continue;
        const v = shd[i] + amount * (1 - u2); shd[i] = v > 1 ? 1 : v;
      }
    }
  }
  function emitLight(wp, rad, c, k) { R.light(wp[0], wp[1], wp[2], rad * X.sc, c[0], c[1], c[2], k); }

  // ======================================================================== defs
  const DEFS = {};
  // the three heroes are drawn a touch larger than the rank-and-file (player ≈ 14–16 rows × 6–8 cols at FIG_SCALE 1.3)
  // so the protagonist reads first in a melee; gameplay radii are unaffected
  const HERO_K = 1.1;
  const BONE = [0.88, 0.85, 0.74];
  const EYE = [0.02, 0.02, 0.03];

  // ---------------------------------------------------------------- heroes
  DEFS.finn = {
    H: 82, sc: HERO_K, death: 'collapse', runSpeed: 120, shadow: [11, 6], sat: 1.3, main: ['hood', 'shirt', 'cape'],
    B: body({ hipZ: 34, thigh: 17, shin: 17, spine: 19, neck: 2.5, headR: 9.8, shW: 7.6, chestR: 8, waistR: 6.6, hipW: 4 }),
    pal: { hood: [0.95, 0.95, 0.98], face: [0.98, 0.76, 0.6], shirt: [0.16, 0.44, 1.0], shorts: [0.1, 0.16, 0.48], skin: [0.95, 0.72, 0.56], shoe: [0.13, 0.1, 0.1], pack: [0.22, 0.62, 0.26], cape: [0.62, 0.05, 0.07], cape2: [0.34, 0.02, 0.04] },
    weapon: { kind: 'sword', material: 'iron' },
    init(rig) { rig.cape = sheet(4, 5, 8, { wid: 6, widGrow: 1.1, back: 5, damp: 0.9, grav: 1 }); },
    sim(a, rig, dt) { capeAnchors(rig, rig.cape, 6.5, 1.3); sheetStep(rig.cape, dt, a, rig.sc * rig.pop); },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      drawSheet(rig.cape, RP.cloth, p.cape, p.cape2, 0, 1.6);
      drawLegsFlesh(rig, p.shorts, p.skin, p.shoe, 3.3, 2.7);
      capV(J.pel, J.pel, 6.4, 6.4, RP.cloth, p.shorts); // hips in shorts
      drawTorso(rig, p.shirt, B.waistR, B.chestR);
      bodyPt(_p, J, J.ch, 0, -B.chestR * 0.9, -6); bodyPt(_q, J, J.ch, 0, -B.chestR * 0.9, 0.5);
      capV(_p, _q, 5, 4.8, RP.cloth, p.pack); // backpack
      drawArmsCloth(rig, p.shirt, p.skin, p.skin, 2.7, 2.3);
      // hood + face + bear ears
      ballV(J.hd, B.headR, RP.cloth, p.hood, 0, 0.3);
      for (let s = -1; s <= 1; s += 2) { headPt(_p, J, s * 5.8, -0.5, 8); ballV(_p, 2.6, RP.cloth, p.hood, 0, 0.2); }
      headPt(_p, J, 0, 4.6, 0.2); ballV(_p, 6.6, RP.skin, p.face, 0, 0.8);
      eyes(rig, 3.2, 9.6, 2.2, EYE, 0, GL.dot, 2.5);
      drawWeapon(a, rig, a.weapon || rig.weapon || this.weapon);
    },
  };
  // anchors along the back of the shoulders for a cape-like sheet
  function capeAnchors(rig, S, back, wK) {
    const J = rig.J, K = S.K;
    for (let c = 0; c < K; c++) {
      const t = K > 1 ? c / (K - 1) : 0.5;
      lerp3(_p, J.sh0, J.sh1, 0.5 + (t - 0.5) * wK);
      bodyPt(_q, J, _p, 0, -back * 0.7, 0.5);
      W(_r, _q[0], _q[1], _q[2]);
      S.ax[c] = _r[0]; S.ay[c] = _r[1]; S.az[c] = _r[2];
    }
    if (!S.init) { apply3(_p, J.G, 0, -0.35, -1); sheetInitWorld(S, _p); }
  }
  function sheetInitWorld(S, dl) { // dl = local direction → world
    const wx = X.rx * dl[0] + X.fx * dl[1], wy = X.ry * dl[0] + X.fy * dl[1];
    const l = len3(wx, wy, dl[2]) || 1;
    sheetInit(S, wx / l * X.sc, wy / l * X.sc, dl[2] / l * X.sc);
  }

  DEFS.marceline = {
    H: 86, sc: HERO_K, death: 'collapse', float: 9, bob: 2.6, gait: 'float', runSpeed: 115, shadow: [10, 6], sat: 1.25, main: ['top', 'hair'],
    // her near-black hair vanishes on the dark floors: lift it to a readable violet there
    // on the snow her pale grey-blue skin matches the ground: a deeper slate there
    bio: { fire: { hair: [0.27, 0.2, 0.46], hair2: [0.44, 0.34, 0.7] }, well: { hair: [0.27, 0.2, 0.46], hair2: [0.44, 0.34, 0.7] }, ice: { skin: [0.46, 0.52, 0.72] } },
    B: body({ hipZ: 36, thigh: 18, shin: 18, spine: 21, neck: 4.5, headR: 7.4, shW: 6.2, chestR: 6.2, waistR: 4.8, legR: 2.4, armSwing: 4 }),
    pal: { skin: [0.62, 0.7, 0.86], hair: [0.15, 0.12, 0.28], hair2: [0.3, 0.26, 0.5], top: [0.6, 0.06, 0.13], pants: [0.22, 0.18, 0.3], boot: [0.45, 0.1, 0.08], bass: [0.7, 0.07, 0.11] },
    weapon: { kind: 'bass', material: 'demonblood' },
    init(rig) { rig.hair = sheet(3, 7, 6.8, { wid: 6, widGrow: 0.5, back: 3, damp: 0.92, grav: 0.85 }); },
    sim(a, rig, dt) {
      const J = rig.J, S = rig.hair;
      for (let c = 0; c < 3; c++) { headPt(_p, J, (c - 1) * 3.6, -4.2, 2); W(_q, _p[0], _p[1], _p[2]); S.ax[c] = _q[0]; S.ay[c] = _q[1]; S.az[c] = _q[2]; }
      if (!S.init) { set3(_p, 0, -0.3, -1); sheetInitWorld(S, _p); }
      sheetStep(S, dt, a, rig.sc * rig.pop);
    },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      drawSheet(rig.hair, RP.hair, p.hair2, p.hair, 0, 0.5, 0.9);
      drawLegsFlesh(rig, p.pants, p.pants, p.boot, 2.6, 2.2);
      drawTorso(rig, p.top, B.waistR, B.chestR);
      drawArmsCloth(rig, p.top, p.skin, p.skin, 2.1, 1.9);
      ballV(J.hd, B.headR, RP.skin, p.skin, 0, 0.3);
      // hair cap over the crown and sides, bangs in front
      headPt(_p, J, 0, -2.2, 1.6); ballV(_p, B.headR * 1.04, RP.hair, p.hair, 0, 0.5);
      headPt(_p, J, 0, 3, 5); ballV(_p, 3.6, RP.hair, p.hair, 0, 0.9);
      eyes(rig, 2.2, 7.2, -0.6, [0.5, 0.02, 0.05], 0.15, GL.dot, 2.5);
      drawWeapon(a, rig, a.weapon || rig.weapon || this.weapon, { bodyCol: p.bass });
    },
  };

  DEFS.fp = {
    H: 84, sc: HERO_K, death: 'ember', runSpeed: 118, shadow: [10, 6], sat: 1.15, main: ['dress', 'skin'],
    // on fire floors her own orange vanishes into the ember light: white-gold core + charcoal-red dress instead
    bio: { fire: { skin: [1.0, 0.8, 0.5], core: [1.3, 1.2, 0.88], dress: [0.5, 0.09, 0.05], hem: [1.2, 1.0, 0.55], tip: [1.0, 0.4, 0.1], crown: [1.2, 1.05, 0.6] } },
    B: body({ hipZ: 35, thigh: 17, shin: 17, spine: 20, neck: 4, headR: 7.4, shW: 6, chestR: 6, waistR: 4.6, legR: 2.3 }),
    // value structure inside her own orange light: hot yellow-orange skin and flame hair over a deep red dress
    pal: { skin: [1.0, 0.62, 0.26], dress: [0.7, 0.13, 0.05], hem: [1.0, 0.75, 0.2], core: [1.1, 0.95, 0.5], tip: [1.0, 0.2, 0.04], crown: [1.0, 0.82, 0.32], gem: [0.5, 1.0, 0.45] },
    weapon: { kind: 'wand', material: 'emberstone' },
    init(rig) { rig.flame = sheet(3, 5, 4.6, { wid: 5, widGrow: -0.6, back: -2, damp: 0.84, grav: -0.75, jitter: 160, ground: 30 }); },
    sim(a, rig, dt) {
      const J = rig.J, S = rig.flame;
      for (let c = 0; c < 3; c++) { headPt(_p, J, (c - 1) * 3.4, -1.5, 4.5); W(_q, _p[0], _p[1], _p[2]); S.ax[c] = _q[0]; S.ay[c] = _q[1]; S.az[c] = _q[2]; }
      if (!S.init) { set3(_p, 0, -0.4, 1); sheetInitWorld(S, _p); }
      sheetStep(S, dt, a, rig.sc * rig.pop);
    },
    light(a, rig) {
      const f = 0.85 + 0.15 * sin(rig.time * 13) * sin(rig.time * 7.3), hot = BC === BIO.fire;
      R.light(a.x, a.y, 40, 115 * rig.sc, 1.0, hot ? 0.62 : 0.45, hot ? 0.3 : 0.12, (hot ? 0.55 : 0.85) * f * FIG.alpha);
    },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B, T = rig.time;
      const fl = 0.8 + 0.2 * sin(T * 11 + rig.seed);
      // dress: a cone from the waist that turns into flame toward the hem
      bodyPt(_p, J, J.pel, 0, 0, -B.hipZ * 0.62);
      FIG.pat = PAT_FLAME; FIG.p2 = p.hem; capV(J.pel, _p, B.waistR, 9.5, RP.fire, p.dress, 0.35 * fl); FIG.pat = 0;
      drawLegsFlesh(rig, p.skin, p.skin, null, 2.3, 2, RP.skin);
      drawTorso(rig, p.dress, B.waistR, B.chestR, RP.cloth, 0.12);
      drawArmsCloth(rig, p.skin, p.skin, p.core, 2, 1.8, RP.skin);
      ballV(J.hd, B.headR, RP.skin, p.skin, 0.28 * fl, 0.3);
      // flame hair (verlet: rises and trails), drawn as flickering flame ribbon + embers
      FIG.pat = PAT_FLAME; FIG.p2 = p.tip;
      drawSheet(rig.flame, RP.fire, p.core, p.tip, 0.7 * fl, 0.9);
      headPt(_p, J, 0, -1.5, 3); ballV(_p, B.headR * 0.95, RP.fire, p.core, 0.6 * fl, 0.4);
      FIG.pat = 0;
      // gem crown
      headPt(_p, J, 0, 3.2, 7.2); dotV(_p, GL.caret, p.crown, 0.4, 2); headPt(_p, J, 0, 4.5, 6); dotV(_p, GL.o, p.gem, 0.9, 2.5);
      eyes(rig, 2.2, 7.1, -0.4, [0.25, 0.05, 0.02], 0, GL.dot, 2.5);
      drawWeapon(a, rig, a.weapon || rig.weapon || this.weapon);
    },
  };

  DEFS.jake = {
    H: 60, death: 'collapse', runSpeed: 100, shadow: [12, 7], flinchK: 1.2, sat: 1.2, main: ['fur'],
    B: body({ hipZ: 20, thigh: 10, shin: 10, spine: 15, neck: 2, headR: 10, shW: 8.5, hipW: 4.5, upper: 10, fore: 9, chestR: 9.5, waistR: 9, armR: 2.8, legR: 3.4, stride: 36, liftH: 5, bob: 2.4 }),
    pal: { fur: [0.95, 0.64, 0.18], jowl: [1.0, 0.76, 0.32], nose: [0.12, 0.07, 0.05], ear: [0.82, 0.5, 0.12] },
    weapon: { kind: 'fists' },
    attack(a, rig, Q, v, u, w, kind) {
      if (v === 'stretch') { stretchPose(a, rig, Q, u, w); return; }
      attackHuman(a, rig, Q, v, u, w, kind);
    },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      drawLegsFlesh(rig, p.fur, p.fur, p.fur, 3.4, 3, RP.fur);
      drawTorso(rig, p.fur, B.waistR, B.chestR, RP.fur);
      // tail
      bodyPt(_p, J, J.pel, 0, -B.waistR, 1); bodyPt(_q, J, J.pel, 0, -B.waistR - 6, 4 + sin(rig.time * 9) * 2);
      capV(_p, _q, 1.8, 1.4, RP.fur, p.fur);
      const stretching = stretchOf(rig) > 0.02 && !a.dead, whirl = !!(a.spinArm && !a.dead);
      if (stretching) drawStretchArm(a, rig);
      if (whirl) drawWhirlArms(a, rig);
      drawArmsCloth(rig, p.fur, p.fur, p.jowl, 2.8, 2.6, RP.fur, whirl ? 2 : stretching ? 1 : -1);
      ballV(J.hd, B.headR, RP.fur, p.fur, 0, 0.3);
      // jowls, nose, droopy ears
      for (let s = -1; s <= 1; s += 2) { headPt(_p, J, s * 3.2, 7, -3.6); ballV(_p, 3.6, RP.fur, p.jowl, 0, 1); headPt(_p, J, s * 8.6, -0.5, 3); ballV(_p, 3, RP.fur, p.ear, 0, 0.1); }
      headPt(_p, J, 0, 9.8, -1.2); dotV(_p, GL.o, p.nose, 0, 3.2);
      eyes(rig, 3.4, 9.2, 2.2, EYE, 0, GL.O, 2.8);
    },
  };
  function stretchPose(a, rig, Q, u, w) {
    // body leans and elongates toward the aim; the arm itself is drawn by drawStretchArm
    rig.stretchAuto = sm(seg01(u, 0.05, 0.4)) * (1 - sm(seg01(u, 0.75, 1))) * w;
    const k = stretchOf(rig);
    Q.pitch += 0.4 * k * w; Q.spineK = 1 + 0.45 * k; Q.py += 4 * k; Q.hpit -= 0.2 * k;
    bl3(Q.hand[0], -10, -4, 4, k * w);
  }
  // Jake's whirlwind (heroes.js sets a.spinArm = {ang, reach}): both arms stretched out, sweeping around at shoulder height
  function drawWhirlArms(a, rig) {
    const J = rig.J, p = rig.pal, S = a.spinArm, reach = S.reach || 54;
    for (let s = 0; s < 2; s++) {
      W(_p, J.sh[s][0], J.sh[s][1], J.sh[s][2]);
      const ang = S.ang + s * PI, hx = a.x + cos(ang) * reach, hy = a.y + sin(ang) * reach, hz = _p[2] * 0.78;
      const mx = (_p[0] + hx) / 2, my = (_p[1] + hy) / 2, mz = max(_p[2], hz) + 3 * X.sc; // a slight rubbery arc
      PW(_ia, _p[0], _p[1], _p[2]); PW(_ib, mx, my, mz);
      cap(_ia[0], _ia[1], _ia[2] + 1, _ib[0], _ib[1], _ib[2] + 1, 2.9 * X.sc, 3 * X.sc, RP.fur, p.fur[0], p.fur[1], p.fur[2], 0);
      PW(_ia, hx, hy, hz);
      cap(_ib[0], _ib[1], _ib[2] + 1, _ia[0], _ia[1], _ia[2] + 1, 3 * X.sc, 3.3 * X.sc, RP.fur, p.fur[0], p.fur[1], p.fur[2], 0);
      cap(_ia[0], _ia[1], _ia[2] + 2, _ia[0], _ia[1] + 0.01, _ia[2] + 2, 5.2 * X.sc, 5.2 * X.sc, RP.fur, p.jowl[0], p.jowl[1], p.jowl[2], 0);
    }
  }
  function stretchOf(rig) { return clamp(rig.stretch > 0 ? rig.stretch : rig.stretchAuto || 0, 0, 1); }
  function drawStretchArm(a, rig) {
    const J = rig.J, p = rig.pal, k = stretchOf(rig);
    let fx, fy, fz, fr;
    if (a.fist && isFinite(a.fist.x)) { fx = a.fist.x; fy = a.fist.y; fz = a.fist.z; fr = a.fist.r || 6; }
    else {
      const ang = a.aim !== undefined ? a.aim : a.facing, reach = 20 + 150 * k;
      fx = a.x + cos(ang) * reach; fy = a.y + sin(ang) * reach; fz = 26 + 40 * sin(k * PI); fr = 4 + 9 * k;
    }
    W(_p, J.sh1[0], J.sh1[1], J.sh1[2]);
    // a rubbery arc: shoulder → raised control point → fist, drawn as capsule segments
    const cx = (_p[0] + fx) / 2, cy = (_p[1] + fy) / 2, cz = max(_p[2], fz) + 18 * k;
    let px0 = _p[0], py0 = _p[1], pz0 = _p[2];
    for (let s = 1; s <= 6; s++) {
      const t = s / 6, it = 1 - t;
      const x = it * it * _p[0] + 2 * it * t * cx + t * t * fx, y = it * it * _p[1] + 2 * it * t * cy + t * t * fy, z = it * it * _p[2] + 2 * it * t * cz + t * t * fz;
      PW(_ia, px0, py0, pz0); PW(_ib, x, y, z);
      cap(_ia[0], _ia[1], _ia[2] + 1, _ib[0], _ib[1], _ib[2] + 1, 3 * X.sc, 3.3 * X.sc, RP.fur, p.fur[0], p.fur[1], p.fur[2], 0);
      px0 = x; py0 = y; pz0 = z;
    }
    PW(_ia, fx, fy, fz); cap(_ia[0], _ia[1], _ia[2] + 2, _ia[0], _ia[1] + 0.01, _ia[2] + 2, fr * X.sc, fr * X.sc, RP.fur, p.jowl[0], p.jowl[1], p.jowl[2], 0);
    shadow(fx, fy, fr * 1.5, fr, clamp(0.8 - fz / 160, 0.2, 0.8));
  }

  // ---------------------------------------------------------------- Act I
  const skelDraw = (o) => function (a, rig) {
    const J = rig.J, p = rig.pal, B = rig.B;
    drawLegsBone(rig, p.bone);
    drawRibcage(rig, p.bone);
    drawArmsBone(rig, p.bone);
    drawSkull(rig, B.headR, p.bone, p.eye, p.eyeE, true);
    if (o && o.extra) o.extra.call(this, a, rig);
    drawWeapon(a, rig, a.weapon || rig.weapon || this.weapon);
  };
  DEFS.thrall = {
    H: 80, bony: true, death: 'bones', runSpeed: 90, shadow: [10, 6], sat: 0.8, main: ['bone'],
    B: body({ hipZ: 35, thigh: 17, shin: 17, spine: 21, neck: 4, headR: 6, shW: 6.4, chestR: 6, waistR: 3 }),
    pal: { bone: BONE, eye: [1.0, 0.35, 0.12], eyeE: 0.6, shield: [0.48, 0.34, 0.24] },
    weapon: { kind: 'sword', material: 'rust' },
    draw: skelDraw({ extra(a, rig) { if (rig.shield !== false) drawShield(rig, rig.pal.shield); } }),
  };
  DEFS.archer = {
    H: 80, bony: true, death: 'bones', runSpeed: 90, shadow: [10, 6], sat: 0.8, main: ['bone'],
    B: body({ hipZ: 35, thigh: 17, shin: 17, spine: 21, neck: 4, headR: 6, shW: 6, chestR: 5.8, waistR: 3 }),
    pal: { bone: [0.84, 0.82, 0.74], eye: [1.0, 0.35, 0.12], eyeE: 0.6, quiver: [0.35, 0.22, 0.14] },
    weapon: { kind: 'bow', material: 'wood' },
    draw: skelDraw({ extra(a, rig) {
      const J = rig.J; bodyPt(_p, J, J.ch, 2.5, -5, -9); bodyPt(_q, J, J.ch, -1.5, -5, 4);
      capV(_p, _q, 2.2, 2.4, RP.cloth, rig.pal.quiver);
      for (let k = 0; k < 3; k++) { bodyPt(_r, J, _q, k - 1, 0, 3.5); dotV(_r, GL.v, [0.75, 0.72, 0.6], 0, 0.3); }
    } }),
  };

  // ---- quadrupeds (hound, cinder) -------------------------------------------------------------
  function poseQuad(a, rig) {
    const d = rig.def, B = rig.B, J = rig.J, T = rig.time, st = rig.st, u = rig.u, w = rig.w, sp = rig.sp, ph = rig.ph, v = rig.v;
    const br = sin(T * 2.6 + rig.seed);
    let bz = B.bodyZ + br * 0.4 - B.bob * sp * abs(cos(ph * 2)), pitch = 0.04 + rig.mvy * sp * 0.05, roll = 0, py = 0;
    let neckF = 0, neckZ = 0, mouth = 0.08 + 0.05 * sin(T * 3), raiseF = 0, glow = 0;
    const sk = STR(u), an = ANT(u), rc = REC(u);
    if (st === 'attack' && w > 0) {
      if (v === 'claw' || v === 'slash1' || v === 'slash2') { raiseF = (an * 0.9 + sk * 0.2) * (1 - rc) * w; py += 6 * sk * (1 - rc) * w; pitch -= 0.25 * an * (1 - sk) * w; mouth = max(mouth, an); }
      else if (v === 'breath') { neckF = (-6 * an + 8 * sk) * (1 - rc) * w; neckZ = (5 * an - 3 * sk) * (1 - rc) * w; mouth = max(mouth, (an * 0.5 + sk) * (1 - rc)); glow = max(an, sk) * (1 - rc); }
      else { // bite / lunge
        neckF = (-5 * an + 12 * sk) * (1 - rc) * w; neckZ = (4 * an - 6 * sk) * (1 - rc) * w; py += (-3 * an + 10 * sk) * (1 - rc) * w;
        pitch += (-0.15 * an + 0.25 * sk) * (1 - rc) * w; mouth = max(mouth, an * (1 - seg01(u, 0.42, 0.5)));
        bz -= 3 * an * (1 - sk) * w;
      }
    } else if (st === 'stun' && w > 0) { roll = sin(T * 4) * 0.18 * w; bz -= 3 * w; neckZ -= 4 * w; }
    else if (st === 'spawn') { bz -= B.bodyZ * (1 - ease(u)); }
    else if (st === 'dodge' && w > 0) { pitch -= 0.15 * w; bz += 3 * sin(u * PI) * w; }
    else if ((st === 'cast' || st === 'special') && w > 0) { neckZ += 6 * sm(u * 4) * (1 - REC(u)) * w; mouth = max(mouth, sm(u * 4) * (1 - REC(u))); glow = sm(u * 4) * (1 - REC(u)); pitch -= 0.15 * w; }
    if (rig.fl > 0.01) { py += rig.fly * 4 * rig.fl; roll += rig.flx * 0.25 * rig.fl; }
    if (st === 'dead') { const k = ease(clamp(rig.deadT / 0.5, 0, 1)); bz = lerp(bz, B.bodyR * 0.9, k); roll = (PI / 2 - 0.2) * k * rig.fallDir; mouth = 0.6 * k; }
    // spine
    const hl = B.len * 0.5;
    set3(J.pel, 0, py - hl * cos(pitch), bz - hl * sin(pitch));
    set3(J.ch, 0, py + hl * cos(pitch), bz + hl * sin(pitch) + raiseF * 6);
    set3(J.nk, 0, J.ch[1] + B.neck * 0.7 + neckF * 0.5, J.ch[2] + B.neck * 0.5 + neckZ * 0.5 + raiseF * 4);
    set3(J.hd, 0, J.nk[1] + B.neck * 0.6 + neckF * 0.5, J.nk[2] + 1 + neckZ * 0.5 + sin(T * 2 + rig.seed) * 0.6);
    // legs: diagonal pairs (trot); 0 = front-left, 1 = front-right, 2 = back-left, 3 = back-right
    const A = (B.stride / TAU) * min(1, sp * 1.35), LH = B.liftH * min(1, sp * 1.6);
    const mx = rig.mvx, my = rig.mvy;
    const roots = J.qr, knees = J.qk, feet = J.qf;
    for (let k = 0; k < 4; k++) {
      const side = k & 1 ? 1 : -1, front = k < 2;
      const base = front ? J.ch : J.pel;
      set3(roots[k], side * B.w, base[1], base[2] - 2);
      const phs = ph + ((k === 0 || k === 3) ? 0 : PI);
      let f = cos(phs) * A, l = max(0, -sin(phs)) * LH;
      set3(_tmp, side * (B.w + 0.5) + mx * f, base[1] + my * f, l);
      if (front && raiseF > 0 && side > 0) { _tmp[1] += 10 * raiseF; _tmp[2] += 14 * raiseF; }
      if (st === 'dead') { _tmp[0] += side * 5; }
      set3(_pole, 0, front ? -1 : 1, 0.2);
      ik(roots[k], _tmp, B.upper, B.lower, _pole, knees[k], feet[k]);
    }
    // tail anchor
    set3(J.x0, 0, J.pel[1] - 3, J.pel[2] + 1);
    Q.mouth = mouth; Q.glow = glow; Q.spread = 0; Q.lift = 0; Q.ball = 0; Q.rollA = 0; Q.yaw = 0; Q.fall = 0; Q.fallDir = 1; Q.hpit = neckZ * -0.03; Q.hyaw = 0; Q.pitch = 0;
    // roll (dead/stun) uses rotY around the body axis
    finalize(rig, 0);
    if (roll) { rotY(_m1, roll); for (const p of J.list) { apply3(_tmp, _m1, p[0], p[1], p[2] - B.bodyR * 0.5); p[0] = _tmp[0]; p[1] = _tmp[1]; p[2] = max(0.5, _tmp[2] + B.bodyR * 0.5); } }
  }
  function drawQuad(a, rig, look) {
    const J = rig.J, p = rig.pal, B = rig.B;
    const pt = FIG.pat; FIG.pat = look.pat || 0; FIG.p2 = look.p2 || null;
    // legs
    const roots = J.qr, knees = J.qk, feet = J.qf;
    for (let k = 0; k < 4; k++) {
      capV(roots[k], knees[k], B.legR * 1.2, B.legR, look.ramp, p.body, look.e || 0);
      if (look.boneLegs) { capV(knees[k], feet[k], 1.6, 1.45, RP.bone, p.bone); } else capV(knees[k], feet[k], B.legR * 0.9, B.legR * 0.7, look.ramp, p.body, look.e || 0);
      bodyPt(_p, J, feet[k], 0, 2.5, 0); lineV(feet[k], _p, GL.v, look.claw || p.bone, 0, 0.2);
    }
    // body: ribbed barrel
    if (look.ribs) { FIG.pat = PAT_RIBS; capV(J.pel, J.ch, B.bodyR * 0.8, B.bodyR, look.ramp, p.body, look.e || 0); FIG.pat = look.pat || 0; lineV(J.pel, J.ch, GL.colon, p.bone, 0, 1); }
    else capV(J.pel, J.ch, B.bodyR * 0.85, B.bodyR, look.ramp, p.body, look.e || 0);
    // neck & head (elongated skull with a hinged jaw)
    capV(J.ch, J.nk, B.bodyR * 0.55, B.bodyR * 0.45, look.ramp, p.body, look.e || 0);
    capV(J.nk, J.hd, B.bodyR * 0.45, B.headR, look.headRamp || look.ramp, p.head || p.body, look.e || 0, 0.3);
    headPt(_p, J, 0, B.headR * 1.6, -0.5 + J.mouth * 1.2); capV(J.hd, _p, B.headR * 0.8, B.headR * 0.45, look.headRamp || look.ramp, p.head || p.body, look.e || 0, 0.5);
    if (J.mouth > 0.2) { headPt(_q, J, 0, B.headR * 1.3, -B.headR * 0.5 - J.mouth * 3.5); lineV(_p, _q, GL.v, p.bone, 0, 0.6); dotV(_q, GL.w, p.bone, 0, 0.7); }
    for (let s = -1; s <= 1; s += 2) { headPt(_r, J, s * B.headR * 0.55, B.headR * 0.4, B.headR * 0.85); dotV(_r, GL.caret, p.head || p.body, look.e || 0, 0.2); } // ears
    eyes(rig, B.headR * 0.45, B.headR * 0.95, B.headR * 0.25, p.eye, p.eyeE, GL.dot, 1.5);
    // tail
    if (rig.tail) drawStrands(rig.tail, look.ramp, p.body, look.tailTip || p.body, 1.6, 0.6, look.e || 0, X.sc);
    FIG.pat = pt;
    if (J.glow > 0.05 && look.glowC) { headPt(_p, J, 0, B.headR * 1.8, 0); dotV(_p, GL.star, look.glowC, J.glow * 1.5, 2); }
  }
  function quadTailSim(a, rig, dt) {
    const J = rig.J, S = rig.tail;
    W(_p, J.x0[0], J.x0[1], J.x0[2]); S.ax[0] = _p[0]; S.ay[0] = _p[1]; S.az[0] = _p[2];
    if (!S.init) { set3(_q, 0, -1, -0.3); sheetInitWorld(S, _q); }
    sheetStep(S, dt, a, rig.sc * rig.pop);
  }
  DEFS.hound = {
    H: 40, kind: 'quad', death: 'collapse', runSpeed: 140, shadow: [16, 7], turn: 10, sat: 0.9, main: ['body', 'head'],
    B: { bodyZ: 24, len: 26, bodyR: 6.5, neck: 9, headR: 4.6, w: 4, upper: 12, lower: 13, legR: 2.2, stride: 54, liftH: 6, bob: 1.6 },
    pal: { body: [0.56, 0.47, 0.44], head: [0.8, 0.77, 0.68], bone: [0.84, 0.8, 0.7], eye: [0.9, 1.0, 0.4], eyeE: 0.8 }, // ashen ghoul flesh (not grass-green)
    pose: poseQuad,
    init(rig) { rig.tail = sheet(1, 5, 4.5, { grav: 0.5, damp: 0.86, stiff: 0.25 }); },
    sim: quadTailSim,
    draw(a, rig) { drawQuad(a, rig, { ramp: RP.flesh, headRamp: RP.bone, ribs: true, boneLegs: true }); },
  };

  DEFS.snail = {
    H: 22, death: 'collapse', runSpeed: 30, shadow: [8, 4], flinchK: 0.5,
    B: { len: 18 },
    pal: { body: [0.72, 0.68, 0.58], shell: [0.58, 0.46, 0.36], shell2: [0.78, 0.66, 0.5], eye: EYE, glow: [0.35, 1.0, 0.4] },
    pose(a, rig) {
      const J = rig.J, T = rig.time, st = rig.st, u = rig.u, w = rig.w;
      const crawl = sin(rig.ph * 2) * 1.2 * rig.sp;
      let lift = 0, wave = 0, laugh = 0;
      if (st === 'special' && rig.v === 'laugh') { laugh = w; lift = 3 * w * abs(sin(T * 18)); }
      else if (st === 'special' || rig.trigAge('wave') < 1.2) { wave = st === 'special' ? w : 1 - sm(rig.trigAge('wave') - 0.8); lift = 4 * wave; }
      if (laugh) wave = 0;
      set3(J.pel, 0, -8 + crawl * 0.3, 2.4); set3(J.ch, 0, 7 + crawl, 2.6 + lift * 0.5);
      set3(J.hd, 0, 9 + crawl, 5 + lift);
      set3(J.x0, 0, -3, 9.5 + sin(T * 1.3) * 0.3); // shell center
      const wv = wave * sin(T * 10) * 4 + laugh * sin(T * 23) * 2.5;
      set3(J.ha0, -2, 9.5 + crawl, 5.5 + lift); set3(J.el0, -3.5 + sin(T * 2) * 0.6, 12 + crawl, 13 + lift);
      set3(J.ha1, 2, 9.5 + crawl, 5.5 + lift); set3(J.el1, 3.5 + wv, 12 + crawl - wave * 1.5, 13 + lift + wave * 3);
      Q.mouth = 0; Q.glow = 0; Q.spread = 0; Q.lift = 0; Q.ball = 0; Q.rollA = 0; Q.yaw = 0; Q.fall = 0; Q.fallDir = 1; Q.hpit = 0; Q.hyaw = 0; Q.pitch = 0;
      if (st === 'dead') { const k = ease(clamp(rig.deadT / 0.5, 0, 1)); J.el0[2] = lerp(J.el0[2], 3, k); J.el1[2] = lerp(J.el1[2], 3, k); }
      finalize(rig, 0);
    },
    draw(a, rig) {
      const J = rig.J, p = rig.pal;
      capV(J.pel, J.ch, 3.2, 3.8, RP.flesh, p.body);
      ballV(J.hd, 3.4, RP.flesh, p.body, 0, 0.2);
      FIG.pat = PAT_SPECK; FIG.p2 = p.shell2; ballV(J.x0, 7.4, RP.shell, p.shell, 0, 0); FIG.pat = 0;
      dotV(J.x0, GL.at, p.shell2, 0, 3); // the spiral
      const glow = a.possessed || rig.possessed || a.greenEyes || rig.greenEyes;
      for (let s = 0; s < 2; s++) {
        lineV(J.ha[s], J.el[s], 0, p.body, 0, 0.3);
        dotV(J.el[s], glow ? GL.O : GL.o, glow ? p.glow : p.eye, glow ? 1.4 : 0, 0.8);
      }
      if (glow) emitLight(W(_t, J.el1[0], J.el1[1], J.el1[2]), 34, p.glow, 0.35);
    },
  };

  // ---------------------------------------------------------------- Act II
  DEFS.husk = {
    H: 76, death: 'collapse', gait: 'shamble', runSpeed: 70, shadow: [10, 6],
    B: body({ hipZ: 33, thigh: 16, shin: 16, spine: 19, neck: 3, headR: 8.2, shW: 6.4, chestR: 6.6, waistR: 5.6, hunch: 0.42, headFwd: 2, stride: 40, armSwing: 3 }),
    // rotted plum body with sick-green rot specks + cream mint swirl: separates from the dusty-pink candy ground
    pal: { candy: [0.78, 0.2, 0.3], mint: [1.0, 0.95, 0.8], rot: [0.55, 0.88, 0.32], body: [0.44, 0.22, 0.32], legs: [0.3, 0.14, 0.2], drip: [0.6, 0.92, 0.35] },
    sat: 1.1, main: ['body', 'candy'],
    weapon: { kind: 'none' },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B, T = rig.time;
      drawLegsFlesh(rig, p.legs, p.legs, p.rot, 2.8, 2.4, RP.candy);
      FIG.pat = PAT_SPECK; FIG.p2 = p.rot; drawTorso(rig, p.body, B.waistR, B.chestR, RP.candy); FIG.pat = 0;
      drawArmsCloth(rig, p.body, p.body, p.rot, 2.2, 2, RP.candy);
      FIG.pat = PAT_MINT; FIG.p2 = p.mint; ballV(J.hd, B.headR, RP.candy, p.candy, 0, 0.4); FIG.pat = 0;
      eyes(rig, 2.6, 7.6, 0.8, EYE, 0, GL.O, 2.5);
      headPt(_p, J, 0, 7.8, -3 - J.mouth); dotV(_p, GL.O, [0.12, 0.02, 0.04], 0, 2.6);
      // sugar-rot drips falling from the body
      for (let k = 0; k < 3; k++) {
        const ph = (T * 0.9 + k * 0.37 + rig.seed) % 1;
        const src = k === 0 ? J.ha0 : k === 1 ? J.ch : J.ha1;
        set3(_p, src[0] + (k - 1) * 1.5, src[1], src[2] * (1 - ph * ph));
        dotV(_p, ph < 0.8 ? GL.ap : GL.comma, p.drip, 0.05, 0.2);
      }
    },
  };
  DEFS.bloater = {
    H: 54, death: 'burst', gait: 'waddle', runSpeed: 55, shadow: [16, 9], flinchK: 0.6,
    B: body({ hipZ: 12, thigh: 6.5, shin: 6, spine: 14, neck: 1, headR: 6, shW: 13, hipW: 6, upper: 6, fore: 6, chestR: 14, waistR: 15, legR: 3.4, armR: 2.6, stride: 26, liftH: 3, bob: 1.2, armSwing: 3 }),
    // a sickly lime gumdrop (candy faction = sick pinks + greens), so it never melts into the pink streets
    pal: { body: [0.5, 0.78, 0.34], swell: [1.0, 0.32, 0.36], sugar: [1.0, 0.95, 0.85], legs: [0.3, 0.42, 0.2], eye: EYE },
    sat: 1.1, main: ['body'],
    special(a, rig, Q, v, u, w, T) { rig.swellAuto = sm(u * 1.4) * w; },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B, T = rig.time;
      if (rig.st !== 'special') rig.swellAuto = 0;
      const sw = clamp(max(rig.swell || 0, rig.swellAuto || 0), 0, 1);
      const throb = 1 + sw * (0.32 + 0.06 * sin(T * (10 + sw * 20))) + 0.025 * sin(T * 2.4);
      drawLegsFlesh(rig, p.legs, p.legs, p.legs, 3.4, 3, RP.candy);
      const q = sw * (0.5 + 0.5 * sin(T * 16)), c = _col;
      c[0] = p.body[0] + (p.swell[0] - p.body[0]) * q; c[1] = p.body[1] + (p.swell[1] - p.body[1]) * q; c[2] = p.body[2] + (p.swell[2] - p.body[2]) * q;
      midBody(_p, J); FIG.pat = PAT_SPECK; FIG.p2 = p.sugar;
      ballV(_p, B.chestR * throb, RP.candy, c, sw * 0.25, 0.2); FIG.pat = 0;
      drawArmsCloth(rig, c, c, c, 2.4, 2.2, RP.candy);
      headPt(_q, J, 0, 2, 3); ballV(_q, B.headR, RP.candy, c, 0, 0.6);
      eyes(rig, 2.2, 5.6, 4, EYE, 0, GL.dot, 2);
      headPt(_q, J, 0, 5.8, 0.5); dotV(_q, sw > 0.4 ? GL.O : GL.o, [0.15, 0.02, 0.06], 0, 2);
    },
  };
  function midBody(o, J) { return lerp3(o, J.pel, J.ch, 0.5); }
  DEFS.banana = {
    H: 90, death: 'collapse', runSpeed: 90, shadow: [10, 6],
    B: body({ hipZ: 34, thigh: 16, shin: 17, spine: 24, neck: 2, headR: 5.6, shW: 8, chestR: 8.4, waistR: 7.4, legR: 1.9, armR: 1.8, upper: 12, fore: 11 }),
    pal: { peel: [0.82, 0.72, 0.24], rot: [0.32, 0.22, 0.08], limb: [0.12, 0.1, 0.08], rag: [0.38, 0.33, 0.28] },
    weapon: { kind: 'spear', material: 'iron' },
    init(rig) { rig.rag = sheet(3, 3, 6, { wid: 5, back: 3, damp: 0.88 }); },
    sim(a, rig, dt) {
      const J = rig.J, S = rig.rag;
      for (let c = 0; c < 3; c++) { bodyPt(_p, J, J.pel, (c - 1) * 4, -3, 2); W(_q, _p[0], _p[1], _p[2]); S.ax[c] = _q[0]; S.ay[c] = _q[1]; S.az[c] = _q[2]; }
      if (!S.init) { set3(_p, 0, -0.2, -1); sheetInitWorld(S, _p); }
      sheetStep(S, dt, a, rig.sc * rig.pop);
    },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      drawLegsFlesh(rig, p.limb, p.limb, p.limb, 1.9, 1.8);
      drawSheet(rig.rag, RP.cloth, p.rag, [p.rag[0] * 0.6, p.rag[1] * 0.6, p.rag[2] * 0.6], 0, 2.2);
      // the banana: a curved body from below the hips to the stem above the head
      bodyPt(_p, J, J.pel, 0, -1.5, -5); bodyPt(_q, J, J.ch, 0, 1.6, 4); bodyPt(_r, J, J.ch, 0, -1.2, 15);
      FIG.pat = PAT_SPECK; FIG.p2 = p.rot;
      capV(_p, _q, 6, B.chestR, RP.flesh, p.peel); capV(_q, _r, B.chestR, 3.4, RP.flesh, p.peel); FIG.pat = 0;
      bodyPt(_s, J, _r, 0, -1.6, 4); lineV(_r, _s, 0, p.rot, 0, 0.3);
      drawArmsCloth(rig, p.limb, p.limb, p.limb, 1.8, 1.7);
      // eyes on the upper body (the "head" is the banana itself)
      set3(J.hd, _q[0], _q[1], _q[2] + 3);
      eyes(rig, 2, 6.4, 1.2, EYE, 0, GL.o, 3);
      drawWeapon(a, rig, a.weapon || rig.weapon || this.weapon);
    },
  };

  // ---------------------------------------------------------------- Act III
  DEFS.penguin = {
    H: 40, death: 'collapse', gait: 'waddle', runSpeed: 80, shadow: [10, 5],
    B: body({ hipZ: 9, thigh: 4.5, shin: 4.5, spine: 17, neck: 1, headR: 7, shW: 8, hipW: 3.4, upper: 6, fore: 6, chestR: 8.4, waistR: 9.2, stride: 22, liftH: 3, bob: 1, armSwing: 3 }),
    pal: { body: [0.1, 0.12, 0.25], belly: [0.9, 0.92, 0.98], beak: [1.0, 0.6, 0.15], eye: [0.4, 0.75, 1.0] }, main: ['body'], // an ink-navy shape on the snow
    attack(a, rig, Q, v, u, w, kind) { if (v === 'bite' || v === 'thrust') { lungePose(rig, Q, u, w, rig.B, false); return; } attackHuman(a, rig, Q, v, u, w, 'fists'); },
    dodge(a, rig, Q, v, u, w) { // belly-slide: flop forward onto the belly, flippers swept back
      const k = sm(seg01(u, 0, 0.18)) * (1 - sm(seg01(u, 0.82, 1)));
      Q.pitch += 1.3 * k; Q.pz -= 4 * k; Q.hpit -= 0.9 * k;
      for (let s = 0; s < 2; s++) { bl3(Q.hand[s], (s ? 1 : -1) * 9, -10, -6, k); bl3(Q.ft[s], (s ? 1 : -1) * 2.5, -14, 2, k); }
    },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      for (let s = 0; s < 2; s++) { bodyPt(_p, J, J.ft[s], 0, 3, 0.3); capV(J.ft[s], _p, 2, 1.6, RP.flesh, p.beak); }
      drawTorso(rig, p.body, B.waistR, B.chestR, RP.dark);
      bodyPt(_p, J, J.pel, 0, 4.4, 2); bodyPt(_q, J, J.ch, 0, 3.8, -1.5); capV(_p, _q, 6.6, 5.6, RP.cloth, p.belly, 0, 0.4);
      drawArmsCloth(rig, p.body, p.body, null, 2.3, 1.9, RP.dark);
      ballV(J.hd, B.headR, RP.dark, p.body, 0, 0.2);
      headPt(_p, J, 0, 6.6, -1); dotV(_p, GL.gt, p.beak, 0.05, 2.4);
      eyes(rig, 2.6, 5.8, 1.6, p.eye, 1.0, GL.o, 2.6);
    },
  };
  DEFS.golem = {
    H: 104, death: 'crumble', gait: 'stomp', runSpeed: 70, shadow: [17, 9], flinchK: 0.45, turn: 8,
    B: body({ hipZ: 38, thigh: 16, shin: 17, spine: 26, neck: 2, headR: 7, shW: 16, hipW: 7, upper: 19, fore: 18, chestR: 15, waistR: 12, armR: 5.5, legR: 6, stride: 50, liftH: 5, bob: 3, armSwing: 6, reach: 20, hunch: 0.18 }),
    pal: { snow: [0.8, 0.9, 1.04], ice: [0.5, 0.76, 1.1], eye: [0.1, 0.2, 0.45] }, main: ['snow'],
    weapon: { kind: 'fists' },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      drawLegsFlesh(rig, p.snow, p.snow, null, 6, 5.5, RP.snow);
      ballV(J.pel, B.waistR, RP.snow, p.snow, 0, 0);
      madd(_p, J.ch, J.up, -3); ballV(_p, B.chestR, RP.snow, p.snow, 0, 0.1);
      for (let s = 0; s < 2; s++) {
        capV(J.sh[s], J.el[s], 5.6, 5, RP.snow, p.snow); capV(J.el[s], J.ha[s], 5, 5.5, RP.snow, p.snow);
        ballV(J.ha[s], 6.6, RP.snow, p.snow, 0, 0.5);
        bodyPt(_q, J, J.sh[s], (s ? 1 : -1) * 2, 0, 6); dotV(_q, GL.caret, p.ice, 0.3, 1.5); // icicle crest
      }
      madd(_p, J.ch, J.up, 2.5); headPt(_q, J, 0, 1, -1.5); ballV(_q, B.headR, RP.snow, p.snow, 0, 1.5);
      eyes(rig, 2.4, 6, 0.4, p.eye, 0, GL.O, 2.6);
      headPt(_q, J, 0, 6.6, -3.2); dotV(_q, GL.w, [0.15, 0.25, 0.45], 0, 2.4);
    },
  };
  DEFS.wisp = {
    H: 44, death: 'ember', runSpeed: 90, shadow: [7, 4], flinchK: 0.6,
    B: { z: 30 },
    pal: { core: [0.75, 0.92, 1.1], shard: [0.6, 0.85, 1.1], halo: [0.3, 0.55, 1.0] },
    pose(a, rig) {
      const J = rig.J, T = rig.time, st = rig.st, u = rig.u, w = rig.w;
      let z = 30 + sin(T * 2.1 + rig.seed) * 3, pulse = 0, spread = 0;
      if (st === 'attack' && w > 0) { pulse = (ANT(u) * 0.8 + STR(u)) * (1 - REC(u)) * w; spread = -0.4 * pulse; }
      if ((st === 'cast' || st === 'channel' || st === 'special') && w > 0) { spread = 0.8 * w; pulse = 0.5 * w; }
      if (st === 'spawn') { z *= ease(u); }
      if (st === 'dead') { z = lerp(z, 4, ease(clamp(rig.deadT / 0.6, 0, 1))); }
      set3(J.hd, 0, 0, z); J.glow = pulse; J.spread = spread;
      if (rig.fl > 0.01) { J.hd[0] += rig.flx * 4 * rig.fl; J.hd[1] += rig.fly * 4 * rig.fl; }
      Q.mouth = 0; Q.glow = pulse; Q.spread = spread; Q.lift = 0; Q.ball = 0; Q.rollA = 0; Q.yaw = 0; Q.fall = 0; Q.fallDir = 1; Q.hpit = 0; Q.hyaw = 0; Q.pitch = 0;
      finalize(rig, 0); J.glow = pulse; J.spread = spread;
      copy3(J.ha1, J.hd);
    },
    light(a, rig) { R.light(a.x, a.y, rig.J.hd[2], 70 * rig.sc, 0.35, 0.6, 1.0, (0.55 + rig.J.glow * 0.6) * FIG.alpha); },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, T = rig.time;
      const r = 6.5 * (1 + J.glow * 0.3);
      ballV(J.hd, r, RP.ice, p.core, 0.55 + J.glow * 0.6, 0);
      dotV(J.hd, GL.at, [1.2, 1.25, 1.3], 0.9, 3);
      const n = 6, rad = 13 * (1 + J.spread);
      for (let k = 0; k < n; k++) {
        const ang = T * 2.2 + (k * TAU) / n, tilt = sin(T * 1.3 + k) * 4;
        set3(_p, J.hd[0] + cos(ang) * rad, J.hd[1] + sin(ang) * rad * 0.8, J.hd[2] + tilt + sin(ang) * 3);
        dotV(_p, k & 1 ? GL.lt : GL.star, p.shard, 0.8, sin(ang) * 3);
      }
      for (let k = 0; k < 4; k++) { // falling frost motes
        const ph = (T * 0.7 + k * 0.25 + rig.seed) % 1;
        set3(_p, J.hd[0] + sin(k * 3.1 + T) * 6, J.hd[1] + cos(k * 1.7) * 3, J.hd[2] * (1 - ph));
        dotV(_p, GL.dot, p.shard, 0.4 * (1 - ph), -1);
      }
    },
  };

  // ---------------------------------------------------------------- Act IV
  DEFS.elemental = {
    H: 88, death: 'ember', runSpeed: 95, shadow: [10, 6], gait: 'float', float: 3,
    B: body({ hipZ: 36, thigh: 16, shin: 16, spine: 22, neck: 3, headR: 6.8, shW: 7.4, chestR: 7.6, waistR: 5, armR: 2.6 }),
    pal: { core: [1.0, 0.85, 0.4], tip: [0.9, 0.12, 0.02], body: [1.0, 0.5, 0.12] },
    weapon: { kind: 'none' },
    light(a, rig) { const f = 0.8 + 0.2 * sin(rig.time * 12) * sin(rig.time * 5.3 + 1); R.light(a.x, a.y, 40, 110 * rig.sc, 1.0, 0.42, 0.1, 0.9 * f * FIG.alpha); },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B, T = rig.time;
      const fl = 0.8 + 0.2 * sin(T * 11 + rig.seed);
      FIG.pat = PAT_FLAME; FIG.p2 = p.tip;
      // legless: the torso tapers into a flickering flame tail
      set3(_p, J.pel[0] + sin(T * 5) * 2, J.pel[1] - 3, 1);
      capV(J.pel, _p, B.waistR, 1.5, RP.fire, p.body, 0.55 * fl);
      drawTorso(rig, p.body, B.waistR, B.chestR, RP.fire, 0.6 * fl);
      drawArmsCloth(rig, p.body, p.core, p.core, 2.4, 2.2, RP.fire);
      ballV(J.hd, B.headR, RP.fire, p.core, 0.8 * fl, 0.3);
      for (let k = 0; k < 4; k++) { // licking crown flames
        const ph = (T * 2.4 + k * 0.27) % 1;
        headPt(_q, J, (k - 1.5) * 2.4, -1, B.headR * 0.8 + ph * 9);
        dotV(_q, ph < 0.4 ? GL.caret : GL.ap, ph < 0.5 ? p.core : p.tip, 1.2 * (1 - ph), 0.2);
      }
      FIG.pat = 0;
      eyes(rig, 2.2, 6.2, 0.4, [1.4, 1.3, 1.0], 1.3, GL.o, 2);
    },
  };
  DEFS.cinder = {
    H: 40, kind: 'quad', death: 'ember', runSpeed: 150, shadow: [16, 7], turn: 11,
    B: { bodyZ: 22, len: 24, bodyR: 7, neck: 8, headR: 5, w: 4.4, upper: 11, lower: 12, legR: 2.6, stride: 54, liftH: 6, bob: 1.5 },
    pal: { body: [0.28, 0.16, 0.11], head: [0.32, 0.18, 0.12], bone: [0.95, 0.5, 0.2], eye: [1.4, 0.9, 0.3], eyeE: 1.2, ember: [1.0, 0.45, 0.1] }, main: ['body'],
    pose: poseQuad,
    init(rig) { rig.tail = sheet(1, 5, 4.4, { grav: -0.2, damp: 0.86, stiff: 0.2 }); },
    sim: quadTailSim,
    light(a, rig) { R.light(a.x, a.y, 24, 70 * rig.sc, 1.0, 0.4, 0.1, (0.55 + 0.15 * sin(rig.time * 9)) * FIG.alpha); },
    draw(a, rig) { drawQuad(a, rig, { ramp: RP.coal, pat: PAT_COALS, p2: rig.pal.ember, claw: rig.pal.ember, tailTip: [1, 0.5, 0.15], glowC: [1.2, 0.6, 0.2] }); },
  };
  DEFS.brute = {
    H: 112, death: 'ember', gait: 'stomp', runSpeed: 75, shadow: [18, 9], flinchK: 0.4, turn: 7,
    B: body({ hipZ: 40, thigh: 18, shin: 18, spine: 30, neck: 1, headR: 6.5, shW: 16, hipW: 7, upper: 22, fore: 22, chestR: 14, waistR: 10, armR: 6, legR: 6, stride: 54, liftH: 5, bob: 3, armSwing: 8, reach: 22, hunch: 0.55, headPitch: -0.3, headFwd: 5 }),
    pal: { body: [0.25, 0.17, 0.15], crack: [1.0, 0.42, 0.08], eye: [1.4, 0.8, 0.2] }, main: ['body'],
    weapon: { kind: 'fists' },
    light(a, rig) { R.light(a.x, a.y, 50, 120 * rig.sc, 1.0, 0.38, 0.08, (0.55 + 0.12 * sin(rig.time * 6)) * FIG.alpha); },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      FIG.pat = PAT_COALS; FIG.p2 = p.crack;
      drawLegsFlesh(rig, p.body, p.body, p.body, 6.4, 5.6, RP.stone);
      drawTorso(rig, p.body, B.waistR, B.chestR, RP.stone);
      for (let s = 0; s < 2; s++) { capV(J.sh[s], J.el[s], 6.4, 5.6, RP.stone, p.body); capV(J.el[s], J.ha[s], 5.6, 6, RP.stone, p.body); ballV(J.ha[s], 7.6, RP.stone, p.body, 0, 0.5); ballV(J.sh[s], 7.2, RP.stone, p.body, 0, 0.6); }
      ballV(J.hd, B.headR, RP.stone, p.body, 0, 0.4);
      FIG.pat = 0;
      eyes(rig, 2.4, 5.6, 0.4, p.eye, 1.4, GL.o, 2);
      if (J.mouth > 0.2) { headPt(_p, J, 0, 5.6, -3); dotV(_p, GL.O, p.crack, 1.2, 2); }
    },
  };

  // ---------------------------------------------------------------- Act V
  DEFS.knight = {
    H: 94, bony: true, bigWeapon: true, death: 'bones', runSpeed: 85, shadow: [12, 7], flinchK: 0.6, sat: 0.85, main: ['bone', 'metal'],
    B: body({ hipZ: 38, thigh: 18, shin: 18, spine: 23, neck: 4, headR: 6.6, shW: 7.6, chestR: 7, waistR: 3.4, reach: 17 }),
    pal: { bone: BONE, metal: [0.42, 0.45, 0.52], banner: [0.26, 0.08, 0.3], banner2: [0.12, 0.04, 0.14], eye: [0.4, 1.0, 0.45], eyeE: 0.9, emblem: [0.4, 1.0, 0.45] },
    weapon: { kind: 'sword', material: 'steel' },
    init(rig) { rig.cape = sheet(3, 6, 8, { wid: 7, widGrow: 0.9, back: 5.5, damp: 0.9 }); },
    sim(a, rig, dt) { capeAnchors(rig, rig.cape, 6.5, 0.9); sheetStep(rig.cape, dt, a, rig.sc * rig.pop); },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      drawSheet(rig.cape, RP.cloth, p.banner, p.banner2, 0, 2.6);
      drawLegsBone(rig, p.bone);
      for (let s = 0; s < 2; s++) capV(J.kn[s], J.kn[s], 2.6, 2.6, RP.metal, p.metal); // knee cops
      drawRibcage(rig, p.bone);
      madd(_p, J.ch, J.up, -7); madd(_q, J.ch, J.up, 0.5);
      bodyPt(_p, J, _p, 0, 1.8, 0); bodyPt(_q, J, _q, 0, 1.8, 0);
      capV(_p, _q, 5.6, 6.6, RP.metal, p.metal, 0, 0.6); // breastplate
      for (let s = 0; s < 2; s++) ballV(J.sh[s], 4, RP.metal, p.metal, 0, 0.7); // pauldrons
      drawArmsBone(rig, p.bone);
      if (rig.shield) drawShield(rig, p.metal);
      drawSkull(rig, B.headR, p.bone, p.eye, p.eyeE, false);
      headPt(_p, J, 0, -0.8, 1.2); ballV(_p, B.headR * 1.05, RP.metal, p.metal, 0, 0.2); // helm (open face)
      headPt(_p, J, 0, 0, B.headR + 2); dotV(_p, GL.caret, p.metal, 0, 1.5);
      eyes(rig, 2.3, B.headR * 1.05, 0.3, p.eye, p.eyeE, GL.dot, 3);
      drawWeapon(a, rig, a.weapon || rig.weapon || this.weapon);
    },
  };
  DEFS.priest = {
    H: 90, bony: true, death: 'bones', runSpeed: 75, shadow: [11, 6], castLift: 4,
    B: body({ hipZ: 35, thigh: 17, shin: 17, spine: 22, neck: 3, headR: 6, shW: 6.4, chestR: 6.4, waistR: 6, armR: 2.6, hunch: 0.15 }),
    pal: { bone: [0.84, 0.8, 0.7], robe: [0.3, 0.29, 0.24], robe2: [0.42, 0.48, 0.34], eye: [0.4, 1.0, 0.45], eyeE: 1.0, fire: [0.4, 1.0, 0.45] }, main: ['bone', 'robe'],
    weapon: { kind: 'staff', material: 'witch' },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      // robe cone covers the legs; feet peek out
      set3(_p, J.pel[0], J.pel[1] - 1, 0.8);
      FIG.pat = PAT_STRIPE; FIG.p2 = p.robe2;
      capV(J.pel, _p, B.waistR, 11, RP.cloth, p.robe); FIG.pat = 0;
      drawTorso(rig, p.robe, B.waistR, B.chestR, RP.cloth);
      drawArmsCloth(rig, p.robe, p.robe, null, 3, 2.8);
      for (let s = 0; s < 2; s++) dotV(J.ha[s], GL.w, p.bone, 0, 0.5);
      drawSkull(rig, B.headR, p.bone, p.eye, p.eyeE, true);
      headPt(_p, J, 0, -2, 1.5); ballV(_p, B.headR * 1.25, RP.cloth, p.robe, 0, 0.1); // hood
      eyes(rig, 2.2, B.headR * 0.85, 0.5, p.eye, p.eyeE, GL.dot, 3.2);
      drawWeapon(a, rig, a.weapon || rig.weapon || this.weapon, { orb: p.fire });
    },
  };
  DEFS.wraith = {
    H: 92, death: 'void', gait: 'float', float: 14, bob: 3.5, runSpeed: 95, shadow: [10, 5],
    B: body({ hipZ: 32, thigh: 14, shin: 14, spine: 22, neck: 3, headR: 6.6, shW: 6.8, chestR: 6.8, waistR: 4.6, upper: 13, fore: 13, armR: 2, hunch: 0.25 }),
    pal: { body: [0.22, 0.1, 0.32], tat: [0.3, 0.12, 0.42], tat2: [0.1, 0.04, 0.16], eye: [0.95, 0.75, 1.3], spark: [0.7, 0.35, 1.1] }, main: ['body', 'tat'],
    weapon: { kind: 'claws', material: 'void' },
    init(rig) { rig.tat = sheet(5, 5, 7, { grav: 0.7, damp: 0.9, radial: 3 }); },
    sim(a, rig, dt) {
      const J = rig.J, S = rig.tat;
      for (let c = 0; c < 5; c++) { const ang = (c / 5) * TAU + 0.3; bodyPt(_p, J, J.pel, cos(ang) * 4.5, sin(ang) * 3.5, -2); W(_q, _p[0], _p[1], _p[2]); S.ax[c] = _q[0]; S.ay[c] = _q[1]; S.az[c] = _q[2]; }
      if (!S.init) { set3(_p, 0, -0.3, -1); sheetInitWorld(S, _p); }
      sheetStep(S, dt, a, rig.sc * rig.pop);
    },
    light(a, rig) { R.light(a.x, a.y, 40, 70 * rig.sc, 0.45, 0.2, 0.8, 0.35 * FIG.alpha); },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      FIG.pat = PAT_VOID; FIG.p2 = p.spark;
      drawStrands(rig.tat, RP.void, p.tat, p.tat2, 2.6, 0.8, 0, X.sc);
      drawTorso(rig, p.body, B.waistR, B.chestR, RP.void);
      drawArmsCloth(rig, p.body, p.body, null, 2.2, 1.8, RP.void);
      ballV(J.hd, B.headR, RP.void, p.body, 0, 0.3);
      headPt(_p, J, 0, -1.5, 1.6); ballV(_p, B.headR * 1.15, RP.void, p.tat, 0, 0.1); // cowl
      FIG.pat = 0;
      eyes(rig, 2.2, B.headR * 0.95, 0.2, p.eye, 1.4, GL.o, 3.4);
      drawWeapon(a, rig, a.weapon || rig.weapon || this.weapon);
    },
  };

  // ---------------------------------------------------------------- bosses
  DEFS.lemongrab = {
    H: 118, death: 'collapse', runSpeed: 90, shadow: [11, 6], turn: 22,
    B: body({ hipZ: 48, thigh: 24, shin: 24, spine: 28, neck: 5, headR: 8.4, shW: 6.6, hipW: 3.4, upper: 15, fore: 14, chestR: 6.2, waistR: 5, armR: 2, legR: 2.3, stride: 64, armSwing: 10 }),
    pal: { lemon: [0.98, 0.86, 0.28], suit: [0.36, 0.37, 0.4], suit2: [0.22, 0.22, 0.25], skin: [0.95, 0.84, 0.3], shoe: [0.08, 0.08, 0.09] },
    idle(a, rig, Q, T) { // twitchy: occasional head jerks and flailing fingers
      const j = hash2(floor(T * 3 + rig.seed * 10), 7);
      if (j > 0.82) { Q.hyaw += (j - 0.9) * 2; Q.hpit += 0.1; }
      Q.hand[0][0] -= abs(sin(T * 3.3)) * 2; Q.hand[1][0] += abs(sin(T * 2.7 + 1)) * 2;
    },
    special(a, rig, Q, v, u, w, T) { // SHRIEK: head thrown back, arms flung wide, whole body vibrating
      const k = sm(seg01(u, 0, 0.15)) * (1 - sm(seg01(u, 0.85, 1)));
      const vib = sin(T * 70) * k;
      for (let s = 0; s < 2; s++) bl3(Q.hand[s], (s ? 1 : -1) * (22 + vib * 2), 4, 14 + vib * 3, k * w);
      Q.hpit -= 0.6 * k * w; Q.pitch -= 0.18 * k * w; Q.px += vib * 1.2; Q.mouth = max(Q.mouth, k); Q.spread = k;
    },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      drawLegsFlesh(rig, p.suit, p.suit, p.shoe, 2.6, 2.3);
      FIG.pat = PAT_STRIPE; FIG.p2 = p.suit2; drawTorso(rig, p.suit, B.waistR, B.chestR); FIG.pat = 0;
      drawArmsCloth(rig, p.suit, p.suit, p.skin, 2.2, 2);
      // lemon head: tall ellipsoid with pointed ends
      headPt(_p, J, 0, 0, -B.headR * 0.4); headPt(_q, J, 0, 0, B.headR * 0.9);
      capV(_p, _q, B.headR, B.headR * 0.8, RP.flesh, p.lemon, 0, 0.4);
      headPt(_r, J, 0, 0, B.headR * 1.9); lineV(_q, _r, GL.caret, p.lemon, 0, 0.6);
      eyes(rig, 2.6, B.headR * 0.85, 1.6, EYE, 0, GL.dot, 2.5);
      if (J.mouth > 0.25) { headPt(_p, J, 0, B.headR * 0.9, -2.5); ballV(_p, 1.4 + J.mouth * 2.4, RP.dark, [0.08, 0.02, 0.02], 0, 2.6); }
      else { headPt(_p, J, 0, B.headR * 0.9, -2.2); dotV(_p, GL.dash, [0.2, 0.12, 0.04], 0, 2.5); }
    },
  };
  DEFS.iceKing = {
    H: 98, death: 'collapse', runSpeed: 80, shadow: [12, 7], castLift: 14,
    B: body({ hipZ: 36, thigh: 17, shin: 17, spine: 23, neck: 3, headR: 8.4, shW: 7.6, chestR: 7.8, waistR: 7, armR: 2.6 }),
    pal: { skin: [0.45, 0.62, 0.92], beard: [0.92, 0.95, 1.0], robe: [0.12, 0.17, 0.42], robe2: [0.2, 0.28, 0.6], crown: [1.0, 0.8, 0.3], gem: [1.0, 0.12, 0.15] },
    init(rig) { rig.beard = sheet(3, 6, 6.2, { wid: 4.5, widGrow: 0.6, front: 4.5, damp: 0.9, grav: 0.9 }); },
    sim(a, rig, dt) {
      const J = rig.J, S = rig.beard;
      for (let c = 0; c < 3; c++) { headPt(_p, J, (c - 1) * 3.4, 5.8, -3.6); W(_q, _p[0], _p[1], _p[2]); S.ax[c] = _q[0]; S.ay[c] = _q[1]; S.az[c] = _q[2]; }
      if (!S.init) { set3(_p, 0, 0.35, -1); sheetInitWorld(S, _p); }
      sheetStep(S, dt, a, rig.sc * rig.pop);
    },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      set3(_p, J.pel[0], J.pel[1], 0.8);
      FIG.pat = PAT_STRIPE; FIG.p2 = p.robe2; capV(J.pel, _p, B.waistR, 12.5, RP.cloth, p.robe); FIG.pat = 0;
      drawTorso(rig, p.robe, B.waistR, B.chestR);
      drawArmsCloth(rig, p.robe, p.skin, p.skin, 2.8, 2.4);
      ballV(J.hd, B.headR, RP.skin, p.skin, 0, 0.3);
      headPt(_p, J, 0, B.headR * 0.95, 0); headPt(_q, J, 0, B.headR * 1.5, -1.5); capV(_p, _q, 2.2, 1.6, RP.skin, p.skin, 0, 1.4); // long nose
      eyes(rig, 2.6, B.headR * 0.82, 1.4, EYE, 0, GL.o, 2.4);
      drawSheet(rig.beard, RP.hair, p.beard, [0.75, 0.82, 0.95], 0.05, 0.8, 1.1);
      // crown: gold band + three spikes with red gems
      headPt(_p, J, 0, 0, B.headR * 0.75); ballV(_p, B.headR * 0.68, RP.metal, p.crown, 0.1, 0.8);
      for (let k = -1; k <= 1; k++) {
        headPt(_q, J, k * 3.6, 1.5, B.headR * 1.25 + (k === 0 ? 1.5 : 0)); dotV(_q, GL.caret, p.crown, 0.2, 2.2);
        headPt(_q, J, k * 3.6, 2.5, B.headR * 0.75); dotV(_q, GL.o, p.gem, 0.8, 2.6);
      }
      if (J.glow > 0.1) for (let s = 0; s < 2; s++) { dotV(J.ha[s], GL.star, [0.7, 0.92, 1.2], J.glow * 1.5, 1); emitLight(W(_t, J.ha[s][0], J.ha[s][1], J.ha[s][2]), 50, [0.4, 0.7, 1.0], J.glow * 0.5); }
    },
  };
  DEFS.flameKing = {
    H: 138, death: 'ember', gait: 'stomp', runSpeed: 75, shadow: [18, 10], flinchK: 0.35, turn: 7,
    B: body({ hipZ: 52, thigh: 24, shin: 25, spine: 34, neck: 4, headR: 10.5, shW: 14, hipW: 6.5, upper: 20, fore: 19, chestR: 14, waistR: 12, armR: 4.6, legR: 5.4, stride: 66, reach: 20 }),
    pal: { armor: [0.22, 0.1, 0.07], skin: [1.0, 0.45, 0.15], core: [1.0, 0.88, 0.45], tip: [0.95, 0.15, 0.03], crown: [1.0, 0.75, 0.25], crack: [1.0, 0.45, 0.1] },
    init(rig) { rig.beard = sheet(3, 5, 6, { wid: 6, widGrow: -0.4, front: 6, damp: 0.84, grav: -0.25, jitter: 120 }); rig.flame = sheet(3, 4, 5, { wid: 6, widGrow: -1, damp: 0.84, grav: -0.8, jitter: 140, ground: 40 }); },
    sim(a, rig, dt) {
      const J = rig.J;
      for (let c = 0; c < 3; c++) { headPt(_p, J, (c - 1) * 4, 8, -5); W(_q, _p[0], _p[1], _p[2]); rig.beard.ax[c] = _q[0]; rig.beard.ay[c] = _q[1]; rig.beard.az[c] = _q[2]; }
      for (let c = 0; c < 3; c++) { headPt(_p, J, (c - 1) * 4.5, 0, 9); W(_q, _p[0], _p[1], _p[2]); rig.flame.ax[c] = _q[0]; rig.flame.ay[c] = _q[1]; rig.flame.az[c] = _q[2]; }
      if (!rig.beard.init) { set3(_p, 0, 0.5, -1); sheetInitWorld(rig.beard, _p); set3(_p, 0, 0, 1); sheetInitWorld(rig.flame, _p); }
      sheetStep(rig.beard, dt, a, rig.sc * rig.pop); sheetStep(rig.flame, dt, a, rig.sc * rig.pop);
    },
    light(a, rig) { const f = 0.85 + 0.15 * sin(rig.time * 9) * sin(rig.time * 4.1); R.light(a.x, a.y, 80, 190 * rig.sc, 1.0, 0.45, 0.12, 1.0 * f * FIG.alpha); },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B, T = rig.time, fl = 0.8 + 0.2 * sin(T * 10);
      FIG.pat = PAT_COALS; FIG.p2 = p.crack;
      drawLegsFlesh(rig, p.armor, p.armor, p.armor, 5.6, 5, RP.metal);
      drawTorso(rig, p.armor, B.waistR, B.chestR, RP.metal);
      for (let s = 0; s < 2; s++) ballV(J.sh[s], 7, RP.metal, p.armor, 0, 0.6);
      drawArmsCloth(rig, p.armor, p.armor, p.skin, 4.6, 4, RP.metal);
      FIG.pat = 0;
      ballV(J.hd, B.headR, RP.skin, p.skin, 0.35 * fl, 0.3);
      eyes(rig, 3.4, B.headR * 0.85, 1.6, [1.4, 1.3, 0.9], 1.4, GL.o, 2.4);
      FIG.pat = PAT_FLAME; FIG.p2 = p.tip;
      drawSheet(rig.beard, RP.fire, p.core, p.tip, 0.8 * fl, 0.6);
      drawSheet(rig.flame, RP.fire, p.core, p.tip, 0.9 * fl, 0.7);
      FIG.pat = 0;
      for (let k = -2; k <= 2; k++) { headPt(_q, J, k * 3.4, 1, B.headR * 0.95 + (k === 0 ? 2 : abs(k) === 1 ? 1 : 0)); dotV(_q, GL.caret, p.crown, 0.4, 2); }
      for (let s = 0; s < 2; s++) if (J.glow > 0.1) { dotV(J.ha[s], GL.at, p.core, J.glow * 1.6, 1.2); }
    },
  };
  DEFS.lich = {
    H: 176, bony: true, death: 'bones', deathFx: 'void', pileLen: 30, float: 12, weaponLenK: 1.45, bob: 3.5, gait: 'float', runSpeed: 70, shadow: [16, 9], flinchK: 0.3, turn: 6, castLift: 10,
    B: body({ hipZ: 74, thigh: 36, shin: 36, spine: 46, neck: 7, headR: 10, shW: 13, hipW: 5, upper: 30, fore: 28, chestR: 11, waistR: 7, armR: 2.4, reach: 26, hunch: 0.12, stride: 80, armSwing: 4 }),
    pal: { bone: [0.84, 0.8, 0.68], robe: [0.12, 0.12, 0.1], robe2: [0.2, 0.26, 0.16], horn: [0.6, 0.54, 0.4], eye: [0.45, 1.3, 0.5], green: [0.4, 1.0, 0.45] }, main: ['bone', 'robe'], sat: 0.9,
    weapon: { kind: 'staff', material: 'witch' },
    init(rig) { rig.tat = sheet(8, 6, 15, { grav: 0.8, damp: 0.9, radial: 9 }); },
    sim(a, rig, dt) {
      const J = rig.J, S = rig.tat;
      for (let c = 0; c < 8; c++) { const ang = (c / 8) * TAU, src = c & 1 ? J.pel : J.ch; bodyPt(_p, J, src, cos(ang) * (c & 1 ? 8 : 11), sin(ang) * (c & 1 ? 6 : 7), c & 1 ? 0 : -6); W(_q, _p[0], _p[1], _p[2]); S.ax[c] = _q[0]; S.ay[c] = _q[1]; S.az[c] = _q[2]; }
      if (!S.init) { set3(_p, 0, -0.2, -1); sheetInitWorld(S, _p); }
      sheetStep(S, dt, a, rig.sc * rig.pop);
    },
    light(a, rig) { R.light(a.x, a.y, rig.J.hd[2] * rig.sc, 120 * rig.sc, 0.35, 1.0, 0.4, (0.35 + 0.4 * rig.J.glow) * FIG.alpha); },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, B = rig.B;
      drawStrands(rig.tat, RP.cloth, p.robe2, p.robe, 4.2, 1.4, 0, X.sc);
      // robe body: a long dark cone; bony legs hidden beneath
      set3(_p, J.pel[0], J.pel[1] - 2, max(1, J.pel[2] - B.hipZ * 0.9));
      capV(J.pel, _p, B.waistR + 2, 15, RP.cloth, p.robe);
      drawRibcage(rig, p.bone);
      capV(J.pel, J.ch, B.waistR, B.chestR * 0.7, RP.cloth, p.robe, 0, -0.5);
      for (let s = 0; s < 2; s++) { ballV(J.sh[s], 6, RP.cloth, p.robe, 0, 0.3); }
      drawArmsBone(rig, p.bone);
      for (let s = 0; s < 2; s++) { // long bony fingers
        for (let k = -1; k <= 1; k++) { bodyPt(_q, J, J.ha[s], k * 1.5, 3.5, -2); lineV(J.ha[s], _q, 0, p.bone, 0, 0.4); }
      }
      drawSkull(rig, B.headR, p.bone, p.eye, 1.6, true);
      // ram horns: a tight coil on each temple, sweeping back then down and forward
      for (let s = -1; s <= 1; s += 2) {
        headPt(_p, J, s * B.headR * 0.62, 0.5, B.headR * 0.55);
        for (let k = 1; k <= 6; k++) {
          const t = k / 6, ang = 0.4 + t * 4.6, rad = B.headR * 0.62 * (1 - t * 0.55);
          headPt(_q, J, s * (B.headR * (0.78 + t * 0.32)), -sin(ang) * rad - 1, B.headR * 0.1 + cos(ang) * rad);
          capV(_p, _q, 2.9 - t * 1.4, 2.7 - t * 1.4, RP.bone, p.horn, 0, 0.2);
          copy3(_p, _q);
        }
      }
      eyes(rig, B.headR * 0.38, B.headR * 0.82, B.headR * 0.08, p.eye, 1.8, GL.O, 3);
      emitLight(W(_t, J.hd[0], J.hd[1], J.hd[2]), 40, p.green, 0.4);
      drawWeapon(a, rig, a.weapon || rig.weapon || this.weapon, { orb: p.green, lenK: this.weaponLenK });
    },
  };

  // ---- the Bone Dragon ------------------------------------------------------------------------
  DEFS.boneDragon = {
    H: 150, sc: 1.75, kind: 'dragon', bony: true, death: 'dragon', runSpeed: 80, shadow: [60, 30], flinchK: 0.15, turn: 3.2,
    B: { bodyZ: 52, len: 64, bodyR: 17, w: 15, upper: 30, lower: 30, legR: 4.5, stride: 110, liftH: 12, bob: 3, neckLen: 92, headR: 11, tail: 12 },
    pal: { bone: [0.86, 0.8, 0.68], bone2: [0.6, 0.52, 0.42], membrane: [0.42, 0.16, 0.12], membrane2: [0.2, 0.06, 0.05], eye: [1.4, 0.55, 0.15], fire: [1.0, 0.55, 0.15] },
    init(rig) { rig.tail = sheet(1, 11, 7.5, { grav: 0.7, damp: 0.86, stiff: 0.12, iters: 4 }); },
    pose: poseDragon,
    sim(a, rig, dt) {
      const J = rig.J, S = rig.tail;
      W(_p, J.x0[0], J.x0[1], J.x0[2]); S.ax[0] = _p[0]; S.ay[0] = _p[1]; S.az[0] = _p[2];
      if (!S.init) { set3(_q, 0, -1, -0.15); sheetInitWorld(S, _q); }
      // lateral sway force on the tail
      const sw = sin(rig.time * 1.3 + rig.ph * 0.5) * (0.5 + rig.sp * 0.8);
      if (dt > 0) for (let j = 2; j < S.N; j++) { const k = sw * j * 0.09; S.x[j] += X.rx * k; S.y[j] += X.ry * k; }
      sheetStep(S, dt, a, rig.sc * rig.pop);
    },
    light(a, rig) { const J = rig.J; if (J.glow > 0.05) emitLight(W(_t, J.x7[0], J.x7[1], J.x7[2]), 120, rig.pal.fire, J.glow * 1.1 * FIG.alpha); },
    draw: drawDragon,
  };
  // Dragon local joints: pel (hips), ch (shoulders), hd (skull), x7 (mouth), x0 (tail root), sh/el/ha = front legs,
  // hp/kn/ft = hind legs, x1..x6 = neck vertebrae. Wings are posed in rig.wing (left/right spars).
  function poseDragon(a, rig) {
    const B = rig.B, J = rig.J, T = rig.time, st = rig.st, u = rig.u, w = rig.w, sp = rig.sp, ph = rig.ph, v = rig.v;
    const an = ANT(u), sk = STR(u), rc = REC(u);
    let bz = B.bodyZ + sin(T * 1.2 + rig.seed) * 1.2 - B.bob * sp * abs(cos(ph * 2)), pitch = 0.05, py = 0;
    let headF = 0, headZ = 0, mouth = 0.1 + 0.05 * sin(T * 1.7), glow = 0, wing = 0.42 + 0.06 * sin(T * 1.1) - 0.2 * sp, flap = 0.04 * sin(T * 1.1 + 1), frontLift = 0, yaw = 0;
    const act = (st === 'attack' || st === 'cast' || st === 'special') && w > 0;
    if (act) {
      const vv = st === 'attack' ? v : (v === 'gust' ? 'gust' : 'rear');
      if (vv === 'breath') { headF = (-14 * an + 26 * sk) * (1 - rc * 0.8); headZ = (22 * an - 12 * sk) * (1 - rc); mouth = max(mouth, an * 0.6 + sk); glow = max(an * 0.8, sk) * (1 - rc * 0.6); wing = max(wing, 0.35 * an); pitch -= 0.15 * an * (1 - sk); }
      else if (vv === 'bite') { headF = (-12 * an + 34 * sk) * (1 - rc); headZ = (10 * an - 26 * sk) * (1 - rc); mouth = max(mouth, an * (1 - seg01(u, 0.4, 0.47))); py += 12 * sk * (1 - rc); pitch += 0.12 * sk * (1 - rc); }
      else if (vv === 'slam' || vv === 'rear') {
        const up = vv === 'rear' ? sm(seg01(u, 0, 0.35)) * (1 - sm(seg01(u, 0.8, 1))) : an * (1 - sk);
        pitch -= 0.55 * up; frontLift = up; bz += 10 * up; headZ += 20 * up; headF -= 8 * up; wing = max(wing, 0.95 * up);
        if (vv === 'slam') { pitch += 0.12 * sk * (1 - rc); headZ -= 10 * sk * (1 - rc); mouth = max(mouth, up); }
        else { mouth = max(mouth, up); flap = sin(T * 6) * up * 0.3; }
      } else if (vv === 'gust') { wing = max(wing, 0.5 + 0.5 * an); flap = (sin(u * PI * 3) * 0.9) * (1 - rc); bz += 8 * sk * (1 - rc); }
      else if (vv === 'claw') { frontLift = an * (1 - sk) * 0.6; py += 10 * sk * (1 - rc); mouth = max(mouth, an); }
      else if (vv === 'spin') { yaw = kf(u, [0, 0, 0.3, -0.4, 0.6, 1.2, 1, 0]); }
      else { headF = (-8 * an + 20 * sk) * (1 - rc); mouth = max(mouth, an); }
    }
    if (st === 'stun' && w > 0) { headZ -= 18 * w; mouth = 0.5; pitch += 0.1; }
    if (rig.fl > 0.01) { headF -= 6 * rig.fl; headZ += 4 * rig.fl; }
    const ra = min(rig.trigAge('roar'), rig.trigAge('enrage'));
    if (ra < 1.2 && st !== 'dead') { const k = sm(ra / 0.15) * (1 - sm((ra - 0.8) / 0.4)); headZ += 14 * k; headF -= 6 * k; mouth = max(mouth, k); wing = max(wing, 0.85 * k); flap = max(flap, 0.25 * k * sin(T * 9)); }
    if (st === 'spawn') { bz -= B.bodyZ * 1.3 * (1 - ease(u)); wing = 0.9 * u; }
    // pitch < 0 rears the front up
    const hl = B.len * 0.5, cp = cos(pitch), spn = sin(pitch);
    set3(J.pel, 0, py - hl * cp, bz + hl * spn);
    set3(J.ch, 0, py + hl * cp, bz - hl * spn + 4 + frontLift * 26);
    // neck: a quadratic curve from the chest to the head target, sampled into vertebrae x1..x6
    const nb = J.ch, hx = 0, hy = nb[1] + 34 + headF, hz = nb[2] + 74 + headZ + sin(T * 1.5 + rig.seed) * 2.5;
    set3(J.hd, hx + sin(T * 0.8) * 3, hy, hz);
    const cx = 0, cy = nb[1] + 10 + headF * 0.3, cz = hz + 6;
    const vs = J.neck;
    for (let k = 0; k < 6; k++) { const t = (k + 1) / 7, it = 1 - t; set3(vs[k], it * it * nb[0] + 2 * it * t * cx + t * t * J.hd[0], it * it * nb[1] + 2 * it * t * cy + t * t * J.hd[1], it * it * (nb[2] + 6) + 2 * it * t * cz + t * t * J.hd[2]); }
    set3(J.x7, J.hd[0], J.hd[1] + B.headR * 2.2, J.hd[2] - 3 - mouth * 4); // mouth point
    set3(J.x0, 0, J.pel[1] - 8, J.pel[2] + 2); // tail root
    // legs (front: sh/el/ha; hind: hp/kn/ft)
    const A = (B.stride / TAU) * min(1, sp * 1.35), LH = B.liftH * min(1, sp * 1.6), mx = rig.mvx, my = rig.mvy;
    const roots = J.qr, knees = J.qk, feet = J.qf;
    for (let k = 0; k < 4; k++) {
      const side = k & 1 ? 1 : -1, front = k < 2, base = front ? J.ch : J.pel;
      set3(roots[k], side * B.w, base[1], base[2] - 6);
      const phs = ph + ((k === 0 || k === 3) ? 0 : PI);
      const f = cos(phs) * A, l = max(0, -sin(phs)) * LH;
      set3(_tmp, side * (B.w + 6) + mx * f, base[1] + my * f + (front ? 6 : -4), l);
      if (front && frontLift > 0) { _tmp[1] += 18 * frontLift; _tmp[2] += 40 * frontLift; }
      if (front && v === 'claw' && st === 'attack' && side > 0) { _tmp[1] += 30 * sk * (1 - rc); _tmp[2] += 10 * an * (1 - sk); }
      set3(_pole, side * 0.3, front ? -1 : 1, 0.3);
      ik(roots[k], _tmp, B.upper, B.lower, _pole, knees[k], feet[k]);
    }
    rig.wingOpen = wing; rig.flap = flap;
    Q.mouth = mouth; Q.glow = glow; Q.spread = wing; Q.lift = 0; Q.ball = 0; Q.rollA = 0; Q.yaw = yaw; Q.fall = 0; Q.fallDir = 1; Q.hpit = -headZ * 0.004 + headF * 0.004; Q.hyaw = sin(T * 0.8) * 0.08; Q.pitch = 0;
    finalize(rig, 0);
  }
  function drawDragon(a, rig) {
    const J = rig.J, p = rig.pal, B = rig.B, T = rig.time;
    const bone = p.bone, bone2 = p.bone2;
    // tail: vertebra chain
    const S = rig.tail;
    if (S.init) for (let j = 0; j < S.N - 1; j++) {
      PW(_ia, S.x[j], S.y[j], S.z[j]); PW(_ib, S.x[j + 1], S.y[j + 1], S.z[j + 1]);
      const r0 = (4.2 - j * 0.36) * X.sc, r1 = r0 - 0.36 * X.sc;
      cap(_ia[0], _ia[1], _ia[2], _ib[0], _ib[1], _ib[2], max(1, r0), max(0.8, r1), RP.bone, bone[0], bone[1], bone[2], 0);
      if (j & 1) { PW(_ia, S.x[j], S.y[j], S.z[j] + 6 * X.sc); dot(_ia[0], _ia[1], _ia[2] + 0.5, GL.caret, bone2[0], bone2[1], bone2[2], 0); }
    }
    // legs
    const roots = J.qr, knees = J.qk, feet = J.qf;
    for (let k = 0; k < 4; k++) {
      capV(roots[k], knees[k], B.legR * 1.3, B.legR, RP.bone, bone);
      capV(knees[k], feet[k], B.legR, B.legR * 0.8, RP.bone, bone);
      for (let c = -1; c <= 1; c++) { bodyPt(_p, J, feet[k], c * 3, 7, 0); lineV(feet[k], _p, 0, bone2, 0, 0.3); }
    }
    // ribcage body + spine
    FIG.pat = PAT_RIBS; capV(J.pel, J.ch, B.bodyR * 0.85, B.bodyR, RP.bone, bone); FIG.pat = 0;
    lineV(J.pel, J.ch, GL.hash, bone2, 0, 2);
    for (let k = 0; k <= 4; k++) { lerp3(_p, J.pel, J.ch, k / 4); _p[2] += B.bodyR + 2; dotV(_p, GL.caret, bone, 0, 1); }
    capV(J.hp0, J.hp1, 6, 6, RP.bone, bone); // pelvis
    // neck vertebrae
    const vs = J.neckAll;
    for (let k = 0; k < vs.length - 1; k++) { const r0 = 7 - k * 0.5; capV(vs[k], vs[k + 1], r0, r0 - 0.5, RP.bone, bone); if (k > 0) { set3(_p, vs[k][0], vs[k][1], vs[k][2] + r0 + 2); dotV(_p, GL.caret, bone2, 0, 1); } }
    // skull: cranium + long snout + hinged jaw + horns + ember eyes
    ballV(J.hd, B.headR, RP.bone, bone, 0, 0.6);
    headPt(_p, J, 0, B.headR * 2.4, -2); capV(J.hd, _p, B.headR * 0.8, B.headR * 0.45, RP.bone, bone, 0, 0.8);
    headPt(_q, J, 0, B.headR * 0.4, -B.headR * 0.55); headPt(_r, J, 0, B.headR * 2.2, -B.headR * 0.6 - J.mouth * 12);
    capV(_q, _r, B.headR * 0.45, B.headR * 0.32, RP.bone, bone2, 0, 0.7);
    if (J.mouth > 0.3) { for (let k = 0; k < 4; k++) { lerp3(_s, _p, _r, 0.2 + k * 0.2); dotV(_s, GL.v, bone, 0, 1.4); } }
    for (let s = -1; s <= 1; s += 2) {
      headPt(_p, J, s * B.headR * 0.5, -B.headR * 0.2, B.headR * 0.7); headPt(_q, J, s * B.headR * 1.1, -B.headR * 1.8, B.headR * 1.5);
      capV(_p, _q, 2.6, 1.2, RP.bone, bone2, 0, 0.3);
      headPt(_r, J, s * B.headR * 0.42, B.headR * 0.8, B.headR * 0.25); dotV(_r, GL.O, p.eye, 1.6, 3);
    }
    if (J.glow > 0.05) { // throat fire
      dotV(J.x7, GL.at, [1.4, 1.0, 0.5], J.glow * 2, 3);
      for (let k = 0; k < 3; k++) { headPt(_s, J, sin(T * 20 + k) * 2, B.headR * (1.2 + k * 0.4), -B.headR * 0.5 - J.mouth * 5); dotV(_s, GL.star, p.fire, J.glow * 1.6, 2); }
    }
    // wings: humerus → wrist → 3 finger spars, tattered membrane between them
    const open = clamp(rig.wingOpen || 0, 0, 1), flap = rig.flap || 0, mem = p.membrane, mem2 = p.membrane2;
    const sp = lerp(0.25, 1, open);
    for (let s = -1; s <= 1; s += 2) {
      bodyPt(_p, J, J.ch, s * 10, -4, 10); // wing root
      bodyPt(_q, J, J.ch, s * lerp(22, 62, sp), lerp(-10, 6, sp), lerp(40, 70, sp) + flap * 40); // wrist
      bodyPt(_r, J, J.pel, s * 13, -4, 8); // trailing root (hugs the flank)
      // finger tips (local) → TP[k*6 .. +2] projected, TP[k*6+3 .. +5] local
      for (let k = 0; k < 3; k++) {
        const o = k * 7, F = FINGERS;
        const tx = s * lerp(F[o], F[o + 1], sp), ty = lerp(F[o + 2], F[o + 3], sp), tz = lerp(F[o + 4], F[o + 5], sp) + flap * F[o + 6];
        bodyPt(_s, J, J.ch, tx, ty, tz); P(_ia, _s[0], _s[1], _s[2]);
        TP[k * 6] = _ia[0]; TP[k * 6 + 1] = _ia[1]; TP[k * 6 + 2] = _ia[2]; TP[k * 6 + 3] = _s[0]; TP[k * 6 + 4] = _s[1]; TP[k * 6 + 5] = _s[2];
      }
      P(_ia, _p[0], _p[1], _p[2]); const r0x = _ia[0], r0y = _ia[1], r0k = _ia[2];
      P(_ia, _q[0], _q[1], _q[2]); const wx = _ia[0], wy = _ia[1], wk = _ia[2];
      P(_ia, _r[0], _r[1], _r[2]); const trx = _ia[0], try_ = _ia[1], trk = _ia[2];
      const shd = 0.5 + 0.3 * sp * (s > 0 ? 1 : 0.8);
      // tattered membrane: wrist → finger tip → next finger (or the trailing root)
      for (let k = 0; k < 3; k++) {
        const nx = k < 2 ? TP[(k + 1) * 6] : trx, ny = k < 2 ? TP[(k + 1) * 6 + 1] : try_, nk = (k < 2 ? TP[(k + 1) * 6 + 2] : trk) - 1;
        tri(wx, wy, wk - 1, shd, 0, TP[k * 6], TP[k * 6 + 1], TP[k * 6 + 2] - 1, shd * 0.8, 1, nx, ny, nk, shd * 0.72, 1, RP.wing, mem[0], mem[1], mem[2], 0, 0.75);
      }
      tri(r0x, r0y, r0k - 1, shd, 0, wx, wy, wk - 1, shd, 0.3, trx, try_, trk - 1, shd * 0.7, 0.6, RP.wing, mem2[0], mem2[1], mem2[2], 0, 1.0);
      // bone spars on top
      capV(_p, _q, 3.4, 2.6, RP.bone, bone, 0, 1.5);
      for (let k = 0; k < 3; k++) { set3(_s, TP[k * 6 + 3], TP[k * 6 + 4], TP[k * 6 + 5]); lineV(_q, _s, 0, bone, 0, 1.6); dotV(_s, GL.v, bone2, 0, 1.7); }
      dotV(_q, GL.o, bone, 0, 2);
    }
  }
  const TP = new Float64Array(18);
  // wing finger tips: [x folded, x open, y folded, y open, z folded, z open, flap lift] × 3
  const FINGERS = [30, 150, -50, -20, 20, 60, 70, 28, 128, -60, -75, 14, 26, 55, 24, 90, -62, -100, 10, 6, 35];

  // ---- Choose Goose ----------------------------------------------------------------------------
  DEFS.goose = {
    H: 46, death: 'collapse', gait: 'waddle', runSpeed: 70, shadow: [10, 5],
    B: body({ hipZ: 11, thigh: 6, shin: 6, spine: 4, neck: 0, headR: 4.6, shW: 6, hipW: 3, upper: 6, fore: 5, chestR: 9.5, waistR: 9, stride: 24, liftH: 3, bob: 1 }),
    pal: { body: [0.86, 0.86, 0.8], beak: [1.0, 0.6, 0.15], cap: [0.62, 0.12, 0.12], bag: [0.45, 0.3, 0.16], strap: [0.3, 0.2, 0.1] },
    idle(a, rig, Q, T) {
      const honk = rig.trigAge('honk') < 0.6 || (rig.st === 'special' && rig.w > 0) ? 1 : 0;
      rig.neckPump = sin(T * 2.4 + rig.seed) * 0.5 + 0.5; rig.honk = honk ? 1 : max(0, (rig.honk || 0) - 0.05);
    },
    draw(a, rig) {
      const J = rig.J, p = rig.pal, T = rig.time;
      for (let s = 0; s < 2; s++) { lineV(J.hp[s], J.ft[s], 0, p.beak); bodyPt(_p, J, J.ft[s], 0, 3, 0); capV(J.ft[s], _p, 1.9, 1.6, RP.flesh, p.beak, 0, 0.2); }
      // body: plump teardrop with a tail point
      bodyPt(_p, J, J.pel, 0, -9, 4); bodyPt(_q, J, J.pel, 0, 4, 5);
      capV(_p, _q, 5, 9.5, RP.cloth, p.body, 0, 0);
      bodyPt(_r, J, J.pel, 0, -14, 9); lineV(_p, _r, GL.caret, p.body, 0, 0.2);
      // satchel on the right side with a strap
      bodyPt(_r, J, J.pel, 9, -1, 4); ballV(_r, 4, RP.cloth, p.bag, 0, 0.5);
      bodyPt(_s, J, J.pel, -6, 4, 13); lineV(_r, _s, 0, p.strap, 0, 0.8);
      // neck S-curve with pump + honk stretch
      const pump = rig.neckPump || 0, honk = rig.honk || 0;
      bodyPt(_r, J, J.pel, 0, 6, 9); bodyPt(_s, J, J.pel, 0, 9 + pump * 1.5 + honk * 4, 22 + pump * 2 + honk * 4);
      capV(_r, _s, 3.6, 2.8, RP.cloth, p.body);
      bodyPt(_t, J, J.pel, 0, 8 + pump + honk * 6, 33 + pump * 2 + honk * 3);
      capV(_s, _t, 2.8, 2.6, RP.cloth, p.body);
      copy3(J.hd, _t);
      ballV(_t, 4.6, RP.cloth, p.body, 0, 0.3);
      bodyPt(_r, J, _t, 0, 6 + honk, -0.5 - honk * 0.5); capV(_t, _r, 2, 1.4, RP.flesh, p.beak, 0, 1);
      if (honk > 0.3) { bodyPt(_s, J, _t, 0, 5.5, -2.6); dotV(_s, GL.v, p.beak, 0, 1.2); }
      bodyPt(_r, J, _t, 2.6, 2.4, 1.2); dotV(_r, GL.dot, EYE, 0, 2); bodyPt(_r, J, _t, -2.6, 2.4, 1.2); dotV(_r, GL.dot, EYE, 0, 2);
      // little cap with a brim
      bodyPt(_r, J, _t, 0, -0.5, 4); ballV(_r, 3, RP.cloth, p.cap, 0, 0.6);
      bodyPt(_s, J, _r, 0, 4.5, -1); lineV(_r, _s, GL.dash, p.cap, 0, 0.8);
      void T;
    },
  };

  // ======================================================================== death: debris & dust
  // piece kinds: 0 bone segment, 1 skull, 2 rib chunk, 3 glyph shard, 4 disc, 5 mote (rising, fading), 6 chunk (snow/rock)
  function piece(x, y, z, kind, len, r, col, g, e) {
    return { x, y, z, vx: 0, vy: 0, vz: 0, ang: HM.rng.next() * TAU, va: 0, tilt: (HM.rng.next() - 0.5) * 1.2, vt: 0, kind, len: len || 0, r: r || 1.5, c: col, g: g || 0, e: e || 0, rest: false, t: 0, life: 0 };
  }
  function kick(pc, dirx, diry, power, up) {
    const ang = Math.atan2(diry, dirx) + (HM.rng.next() - 0.5) * 2.2, sp = power * (0.35 + HM.rng.next() * 0.75);
    pc.vx = cos(ang) * sp; pc.vy = sin(ang) * sp; pc.vz = up * (0.5 + HM.rng.next() * 0.8);
    pc.va = (HM.rng.next() - 0.5) * 18; pc.vt = (HM.rng.next() - 0.5) * 14;
  }
  const _w1 = [0, 0, 0], _w2 = [0, 0, 0];
  function boneFrom(rig, A, B, col, kind, r) {
    W(_w1, A[0], A[1], A[2]); W(_w2, B[0], B[1], B[2]);
    const len = len3(_w2[0] - _w1[0], _w2[1] - _w1[1], _w2[2] - _w1[2]);
    const pc = piece((_w1[0] + _w2[0]) / 2, (_w1[1] + _w2[1]) / 2, (_w1[2] + _w2[2]) / 2, kind || 0, len, r || 1.5, col);
    pc.ang = Math.atan2(_w2[1] - _w1[1], _w2[0] - _w1[0]);
    return pc;
  }
  function spawnBones(a, rig, dx, dy) {
    const J = rig.J, p = rig.pal, out = [], c = p.bone || BONE, sc = X.sc, def = rig.def;
    const big = def.kind === 'dragon';
    const pw = big ? 120 : 58, up = big ? 170 : 130;
    const push = (pc) => { kick(pc, dx, dy, pw, up); out.push(pc); return pc; };
    if (big) {
      const vs = [J.ch, J.x1, J.x2, J.x3, J.x4, J.x5, J.x6, J.hd];
      for (let k = 0; k < vs.length - 1; k++) push(boneFrom(rig, vs[k], vs[k + 1], c, 0, 3));
      const roots = J.qr, knees = J.qk, feet = J.qf;
      for (let k = 0; k < 4; k++) { push(boneFrom(rig, roots[k], knees[k], c, 0, 3.5)); push(boneFrom(rig, knees[k], feet[k], c, 0, 3)); }
      for (let k = 0; k < 6; k++) { lerp3(_p, J.pel, J.ch, k / 5); W(_w1, _p[0], _p[1], _p[2]); push(piece(_w1[0], _w1[1], _w1[2], 2, 26 * sc, 3, c)); }
      W(_w1, J.hd[0], J.hd[1], J.hd[2]); const sk = push(piece(_w1[0], _w1[1], _w1[2], 1, 0, B_SK(rig) * sc, c)); sk.eye = p.eye;
      for (let s = -1; s <= 1; s += 2) for (let k = 0; k < 4; k++) { bodyPt(_p, J, J.ch, s * (30 + k * 28), -10 - k * 12, 40 + k * 4); W(_w1, _p[0], _p[1], _p[2]); push(piece(_w1[0], _w1[1], _w1[2], 0, 40 * sc, 2, c)); }
      const S = rig.tail; if (S && S.init) for (let j = 0; j < S.N; j += 2) push(piece(S.x[j], S.y[j], S.z[j], 3, 0, 2, c, GL.o));
      for (let k = 0; k < 24; k++) { W(_w1, (HM.rng.next() - 0.5) * 40, (HM.rng.next() - 0.5) * 60, 30 + HM.rng.next() * 30); push(piece(_w1[0], _w1[1], _w1[2], 3, 0, 1, c, [GL.ap, GL.dash, GL.tilde, GL.eq][k & 3])); }
      return out;
    }
    for (let s = 0; s < 2; s++) {
      push(boneFrom(rig, J.hp[s], J.kn[s], c)); push(boneFrom(rig, J.kn[s], J.ft[s], c));
      push(boneFrom(rig, J.sh[s], J.el[s], c)); push(boneFrom(rig, J.el[s], J.ha[s], c));
    }
    W(_w1, J.ch[0], J.ch[1], J.ch[2] - 5); push(piece(_w1[0], _w1[1], _w1[2], 2, 10 * sc, 2.6, c));
    W(_w1, J.pel[0], J.pel[1], J.pel[2]); push(piece(_w1[0], _w1[1], _w1[2], 2, 7 * sc, 2, c));
    W(_w1, J.hd[0], J.hd[1], J.hd[2]); const sk = push(piece(_w1[0], _w1[1], _w1[2], 1, 0, rig.B.headR * sc, c)); sk.eye = null;
    sk.vz *= 1.25;
    for (let k = 0; k < 8; k++) { W(_w1, (HM.rng.next() - 0.5) * 8, (HM.rng.next() - 0.5) * 8, 20 + HM.rng.next() * 40); push(piece(_w1[0], _w1[1], _w1[2], 3, 0, 1, c, [GL.ap, GL.dash, GL.tilde, GL.eq][k & 3])); }
    // weapon & shield
    const wp = a.weapon || rig.weapon || def.weapon;
    if (wp && wp.kind && wp.kind !== 'none' && wp.kind !== 'fists') {
      const L = matLook(wp), len = (WLEN[wp.kind] || 20) * (def.bigWeapon ? 1.5 : 1);
      madd(_p, J.ha1, J.wd, len); const pc = push(boneFrom(rig, J.ha1, _p, L.c, 0, 1.4)); pc.g = L.g0; pc.e = L.e; pc.blade = L;
    }
    if (def === DEFS.thrall) { W(_w1, J.ha0[0], J.ha0[1], J.ha0[2]); push(piece(_w1[0], _w1[1], _w1[2], 4, 0, 5 * sc, p.shield)); }
    if (def === DEFS.knight) { W(_w1, J.ch[0], J.ch[1], J.ch[2]); push(piece(_w1[0], _w1[1], _w1[2], 4, 0, 5.5 * sc, p.metal)); }
    return out;
  }
  const B_SK = (rig) => rig.B.headR || 10;
  function spawnChunks(a, rig, dx, dy, col, n, e) {
    const out = [];
    for (let k = 0; k < n; k++) {
      W(_w1, (HM.rng.next() - 0.5) * 16, (HM.rng.next() - 0.5) * 12, rig.def.H * (0.15 + HM.rng.next() * 0.7));
      const pc = piece(_w1[0], _w1[1], _w1[2], 6, 0, (2.5 + HM.rng.next() * 4) * X.sc, col, 0, e || 0);
      kick(pc, dx, dy, 70, 110); out.push(pc);
    }
    return out;
  }
  function spawnMotes(rig, n, col, e, glyphs) {
    const J = rig.J, out = [];
    for (let k = 0; k < n; k++) {
      const src = J.list[(HM.rng.next() * 16) | 0];
      W(_w1, src[0] + (HM.rng.next() - 0.5) * 6, src[1] + (HM.rng.next() - 0.5) * 6, src[2]);
      const pc = piece(_w1[0], _w1[1], max(1, _w1[2]), 5, 0, 1, col, glyphs[(HM.rng.next() * glyphs.length) | 0], e || 0);
      pc.vx = (HM.rng.next() - 0.5) * 24; pc.vy = (HM.rng.next() - 0.5) * 18; pc.vz = 14 + HM.rng.next() * 30; pc.life = 0.8 + HM.rng.next() * 1.2;
      out.push(pc);
    }
    return out;
  }
  function updateDebris(a, rig, dt) {
    const D = rig.debris; if (!D || dt <= 0) return;
    const solid = HM.World && HM.World.isSolid;
    for (let k = D.length - 1; k >= 0; k--) {
      const pc = D[k]; pc.t += dt;
      if (pc.kind === 5) { // mote: rises & fades
        pc.x += pc.vx * dt; pc.y += pc.vy * dt; pc.z += pc.vz * dt; pc.vx *= 0.97; pc.vy *= 0.97;
        if (pc.t > pc.life) D.splice(k, 1);
        continue;
      }
      if (pc.rest) continue;
      pc.vz -= 560 * dt;
      const nx = pc.x + pc.vx * dt, ny = pc.y + pc.vy * dt;
      if (solid && solid(nx, ny)) { pc.vx *= -0.4; pc.vy *= -0.4; } else { pc.x = nx; pc.y = ny; }
      pc.z += pc.vz * dt; pc.ang += pc.va * dt; pc.tilt += pc.vt * dt;
      const floor0 = pc.kind === 1 ? pc.r * 0.8 : pc.kind === 6 ? pc.r * 0.6 : 0.8;
      if (pc.z <= floor0) {
        pc.z = floor0;
        if (pc.vz < -40) { pc.vz = -pc.vz * 0.3; pc.vx *= 0.42; pc.vy *= 0.42; pc.va *= 0.5; pc.vt *= 0.4; if (pc.vz > 60 && HM.rng.next() < 0.25 && HM.FX && HM.FX.burst) HM.FX.burst(pc.x, pc.y, 1, 'dust', 2); }
        else { pc.vz = 0; pc.vx *= 0.8; pc.vy *= 0.8; pc.va *= 0.8; pc.tilt *= 0.8; if (abs(pc.vx) + abs(pc.vy) < 4) { pc.rest = true; pc.tilt = 0; } }
      }
    }
  }
  function drawDebris(a, rig) {
    const D = rig.debris; if (!D) return;
    const fade = rig.pileFade;
    for (const pc of D) {
      const c = pc.c;
      let al = fade;
      if (pc.kind === 5) al *= 1 - pc.t / pc.life;
      if (al <= 0.01) continue;
      const cr = c[0] * al, cg = c[1] * al, cb = c[2] * al;
      switch (pc.kind) {
        case 0: case 2: {
          const hl = pc.len * 0.5 * cos(pc.tilt), hz = pc.len * 0.5 * sin(pc.tilt);
          const ex = cos(pc.ang) * hl, ey = sin(pc.ang) * hl;
          PW(_ia, pc.x - ex, pc.y - ey, max(0.5, pc.z - hz)); PW(_ib, pc.x + ex, pc.y + ey, max(0.5, pc.z + hz));
          if (pc.kind === 2) { const pt = FIG.pat; FIG.pat = PAT_RIBS; cap(_ia[0], _ia[1], _ia[2], _ib[0], _ib[1], _ib[2], pc.r * 1.6, pc.r * 1.6, RP.bone, cr, cg, cb, 0); FIG.pat = pt; }
          else if (pc.blade) bline(_ia[0], _ia[1], _ia[2], _ib[0], _ib[1], _ib[2], pc.blade.g0, pc.blade.g1, pc.blade.g2, cr, cg, cb, pc.e * al);
          else { line(_ia[0], _ia[1], _ia[2], _ib[0], _ib[1], _ib[2], 0, cr, cg, cb, pc.e * al); if (pc.len > 9) { dot(_ia[0], _ia[1], _ia[2] + 0.1, GL.o, cr, cg, cb, 0); dot(_ib[0], _ib[1], _ib[2] + 0.1, GL.o, cr, cg, cb, 0); } }
          break;
        }
        case 1: { // skull
          PW(_ia, pc.x, pc.y, pc.z);
          cap(_ia[0], _ia[1], _ia[2], _ia[0], _ia[1] + 0.01, _ia[2], pc.r, pc.r, RP.bone, cr, cg, cb, 0);
          const ex = cos(pc.ang), ey = sin(pc.ang);
          if (ey > -0.3) {
            for (let s = -1; s <= 1; s += 2) { PW(_ib, pc.x + ex * pc.r * 0.7 - ey * s * pc.r * 0.4, pc.y + ey * pc.r * 0.7 + ex * s * pc.r * 0.4, pc.z + pc.r * 0.15); const e = pc.eye ? 1.2 * al * (1 - min(1, rig.deadT / 6)) : 0; dot(_ib[0], _ib[1], _ib[2] + 3, pc.eye ? GL.O : GL.dot, pc.eye ? pc.eye[0] * al : 0.03, pc.eye ? pc.eye[1] * al : 0.03, pc.eye ? pc.eye[2] * al : 0.03, e); }
          }
          break;
        }
        case 3: PW(_ia, pc.x, pc.y, pc.z); dot(_ia[0], _ia[1], _ia[2], pc.g, cr, cg, cb, pc.e * al); break;
        case 4: PW(_ia, pc.x, pc.y, pc.z + 1); cap(_ia[0], _ia[1], _ia[2], _ia[0], _ia[1] + 0.01, _ia[2], pc.r, pc.r * (0.4 + 0.6 * abs(cos(pc.tilt))), RP.metal, cr, cg, cb, 0); dot(_ia[0], _ia[1], _ia[2] + 1, GL.o, cr * 1.4, cg * 1.4, cb * 1.4, 0); break;
        case 5: PW(_ia, pc.x, pc.y, pc.z); dot(_ia[0], _ia[1], _ia[2] + 4, pc.g, cr, cg, cb, pc.e * al); break;
        case 6: PW(_ia, pc.x, pc.y, pc.z); cap(_ia[0], _ia[1], _ia[2], _ia[0], _ia[1] + 0.01, _ia[2], pc.r, pc.r, RP.snow, cr, cg, cb, pc.e * al); break;
        default: break;
      }
    }
  }
  function deathFX(a, kind) {
    const FX = HM.FX; if (!FX || !FX.burst) return;
    const x = a.x, y = a.y, z = 20;
    try {
      if (kind === 'bones') { FX.burst(x, y, z, 'bone', 14); FX.burst(x, y, 4, 'dust', 10); }
      else if (kind === 'dragon') { FX.burst(x, y, 40, 'bone', 40); FX.burst(x, y, 6, 'dust', 40); FX.shake && FX.shake(10); }
      else if (kind === 'ember') { FX.burst(x, y, z, 'ember', 22); FX.burst(x, y, z, 'ash', 10); }
      else if (kind === 'void') { FX.burst(x, y, z, 'shadow', 22); FX.burst(x, y, z, 'witchfire', 8); }
      else if (kind === 'burst') { FX.burst(x, y, 16, 'rot', 26); FX.burst(x, y, 16, 'sugar', 16); }
      else if (kind === 'crumble') { FX.burst(x, y, z, 'ice', 18); FX.burst(x, y, 6, 'dust', 12); }
      else FX.burst(x, y, 10, 'dust', 8);
    } catch (e) { /* FX module mid-edit: cosmetic only */ }
  }

  // ======================================================================== bat-swarm dodge (Marceline)
  function drawBats(a, rig) {
    const T = rig.time, u = rig.u, n = 7;
    const out = sm(seg01(u, 0, 0.25)) * (1 - sm(seg01(u, 0.75, 1)));
    const cx = a.x, cy = a.y, cz = 34 * rig.sc + (a.z || 0);
    for (let k = 0; k < n; k++) {
      const ang = k * 2.4 + T * 7 + rig.seed, rad = (6 + 16 * out) * (0.6 + 0.4 * sin(k * 1.7 + T * 3));
      PW(_ia, cx + cos(ang) * rad, cy + sin(ang) * rad * 0.8, cz + sin(T * 11 + k) * 6 * out);
      const g = BATG[((T * 14 + k) | 0) % 4];
      dot(_ia[0], _ia[1], _ia[2] + 2, g, 0.32, 0.12, 0.4, 0.15);
    }
    FIG.dis = max(FIG.dis, out * 0.97);
  }

  // ======================================================================== Rig API
  function guessId(a) {
    if (a.defId && DEFS[a.defId]) return a.defId;
    if (a.kind === 'player') return DEFS[a.heroId] ? a.heroId : 'finn';
    return 'thrall';
  }
  // Global figure scale (HM.cfg.FIG_SCALE): the grid got finer, so every figure is drawn bigger to keep forms readable.
  function figK(a) { const c = HM.cfg; return a && (a.isBoss || a.isDecoy) ? c.BOSS_FIG_SCALE || 1 : c.FIG_SCALE || 1; }
  function hasStatus(a, id) { const s = a.statuses; if (!s) return null; for (let i = 0; i < s.length; i++) if (s[i].id === id) return s[i]; return null; }
  const STATUS_TINT = {
    freeze: [0.72, 0.92, 1.15, 0.62], chill: [0.6, 0.82, 1.1, 0.25], poison: [0.45, 1.0, 0.35, 0.22], burn: [1.0, 0.5, 0.12, 0.22],
    rot: [0.9, 0.35, 0.55, 0.2], doom: [0.35, 1.0, 0.45, 0.2], weaken: [0.7, 0.45, 0.95, 0.15],
  };

  // Palette = def colors, then the def's per-biome overrides (def.bio[biome]: hue families that separate from that
  // ground), then the caller's colors. Elites get Enemies' affix tint re-applied on top of a biome override.
  function rigPalette(a, def, cols) {
    const bp = def.bio && def.bio[biomeId()];
    const pal = Object.assign({}, def.pal, bp || {});
    if (cols) for (const k in cols) {
      const c = cols[k];
      if (bp && bp[k] && a && a.isElite && Array.isArray(c)) { const e = a.eliteColor || [1, 1, 1], b = bp[k]; pal[k] = [b[0] * 0.78 + e[0] * 0.264, b[1] * 0.78 + e[1] * 0.264, b[2] * 0.78 + e[2] * 0.264]; }
      else pal[k] = Array.isArray(c) ? c.slice() : c;
    }
    return pal;
  }
  // luminance of a figure's bulk (def.main keys, else the median palette color) — drives the biome contrast gain
  function palLum(def, pal) {
    const ks = def.main || Object.keys(pal), ls = [];
    for (const k of ks) { const c = pal[k]; if (Array.isArray(c) && c.length >= 3) ls.push(lumOf(c)); }
    if (!ls.length) return 0.5;
    if (def.main) return ls.reduce((s, v) => s + v, 0) / ls.length;
    ls.sort((x, y) => x - y); return ls[ls.length >> 1];
  }

  const Rig = (HM.Rig = {
    defs: DEFS,
    ROSTER: ['finn', 'marceline', 'fp', 'jake', 'thrall', 'archer', 'hound', 'snail', 'husk', 'bloater', 'banana', 'penguin', 'golem', 'wisp', 'elemental', 'cinder', 'brute', 'knight', 'priest', 'wraith', 'boneDragon', 'lemongrab', 'iceKing', 'flameKing', 'lich', 'goose'],
    MATERIALS: MAT,

    create(a, rigId, opts) {
      opts = opts || {};
      const id = DEFS[rigId] ? rigId : guessId(a);
      const def = DEFS[id];
      const rig = {
        id, def, scale: typeof opts.scale === 'number' ? opts.scale : 1, sc: 1, pop: 1,
        B: def.B, pal: rigPalette(a, def, opts.colors), weapon: opts.weapon || null,
        time: 0, ph: 0, sp: 0, mvx: 0, mvy: 1, face: a.facing || 0, lastX: a.x, lastY: a.y, seed: ((a.id || 1) * 0.6180339) % 1 * TAU,
        st: 'idle', u: 0, w: 0, v: '', J: makeJ(), posed: false, enter: true,
        fl: 0, flx: 0, fly: -1, lastFlash: 0, trig: {}, stretch: 0, swell: 0, stretchAuto: 0, swellAuto: 0,
        tip: [a.x, a.y, 30], dead: false, deadT: 0, debris: null, pileFade: 1, fallDir: 1, deathKind: def.death || 'collapse',
        trigAge(n) { const t = this.trig[n]; return t === undefined ? 1e9 : this.time - t; },
      };
      // controllers may drive rig.stretch (Jake) and rig.swell (bloater) directly, 0..1
      a.rig = rig;
      if (!a.anim) a.anim = { state: 'idle', t: 0, speed01: 0 };
      if (def.init) def.init(rig, a);
      rig.sc = rig.scale * (def.sc || 1) * figK(a);
      rig.lumRef = palLum(def, rig.pal);
      if (!opts.keepHeight) a.height = Math.round(def.H * rig.sc);
      return rig;
    },

    setAnim(a, state, o) {
      const an = a.anim || (a.anim = { state: 'idle', t: 0, speed01: 0 });
      if (a.dead && state !== 'dead') return;
      an.state = state; an.t = 0; an.dur = (o && o.dur) || DUR[state] || 0.3; an.variant = (o && o.variant) || null;
      if (a.rig) a.rig.enter = true;
    },
    phase(a) { const an = a.anim; if (!an) return 0; return clamp((an.t || 0) / (an.dur || DUR[an.state] || 0.3), 0, 1); },
    trigger(a, name) {
      const rig = a.rig; if (!rig || !rig.def) return;
      rig.trig[name] = rig.time;
      if (name === 'hit' || name === 'flinch') startFlinch(a, rig, 1);
      if (name === 'burst' && rig.def.death === 'burst') rig.swell = 1;
    },
    weaponTip(a) {
      const rig = a.rig;
      if (!rig || !rig.def || !rig.posed) return [a.x + cos(a.aim || 0) * 22, a.y + sin(a.aim || 0) * 22, 30 + (a.z || 0)];
      return [rig.tip[0], rig.tip[1], rig.tip[2]];
    },
    // world position of a named joint: 'head' 'chest' 'pelvis' 'handL' 'handR' 'mouth' 'tip' 'footL' 'footR'
    joint(a, name) {
      const rig = a.rig; if (!rig || !rig.def || !rig.posed) return [a.x, a.y, (a.height || 60) * 0.6];
      const J = rig.J; setX(a, rig);
      const j = { head: J.hd, chest: J.ch, pelvis: J.pel, handL: J.ha0, handR: J.ha1, footL: J.ft0, footR: J.ft1, mouth: rig.def.kind === 'dragon' ? J.x7 : J.hd }[name];
      if (name === 'tip') return Rig.weaponTip(a);
      return j ? W([0, 0, 0], j[0], j[1], j[2]) : [a.x, a.y, 30];
    },
    height(a) { return a.rig ? a.rig.def.H * a.rig.sc : a.height || 60; },

    update(a, dt) {
      if (a.rig === false) return; // Combat convention: actor opted out of rigs
      if (!a.rig || typeof a.rig !== 'object' || !a.rig.def) Rig.create(a, a.rig && a.rig.id ? a.rig.id : guessId(a));
      const rig = a.rig, def = rig.def;
      const an = a.anim || (a.anim = { state: 'idle', t: 0, speed01: 0 });
      dt = dt > 0.05 ? 0.05 : dt > 0 ? dt : 0;
      an.t = (an.t || 0) + dt;
      rig.sc = (typeof rig.scale === 'number' && rig.scale > 0 ? rig.scale : 1) * (def.sc || 1) * figK(a);
      const frozen = !a.dead && !!hasStatus(a, 'freeze');
      rig.frozen = frozen;
      const tdt = frozen ? 0 : dt;
      rig.time += tdt;
      // ---- locomotion tracking
      const mdx = a.x - rig.lastX, mdy = a.y - rig.lastY; rig.lastX = a.x; rig.lastY = a.y;
      const md = len2(mdx, mdy);
      const fx = cos(rig.face), fy = sin(rig.face);
      if (md > 140) { rig.teleport = true; }
      let spd = dt > 0 ? md / dt : 0;
      if (an.state === 'dodge' || a.dead || md > 140) spd = 0;
      const tgt = clamp(spd / (def.runSpeed || 110), 0, 1);
      if (tdt > 0) rig.sp = M.damp(rig.sp, tgt, 10, tdt);
      an.speed01 = rig.sp;
      if (md > 0.01 && md <= 140 && an.state !== 'dodge' && tdt > 0) {
        const stride = (rig.B.stride || 50) * rig.sc;
        rig.ph = (rig.ph + (md * TAU) / stride) % (TAU * 1000);
        const lx = (-fy * mdx + fx * mdy) / md, ly = (fx * mdx + fy * mdy) / md;
        rig.mvx = M.damp(rig.mvx, lx, 14, tdt); rig.mvy = M.damp(rig.mvy, ly, 14, tdt);
      }
      // ---- facing (attacks/casts face the aim)
      let tf = a.facing || 0;
      const st0 = an.state;
      if ((st0 === 'attack' || st0 === 'cast' || st0 === 'channel') && typeof a.aim === 'number') tf = a.aim;
      if (rig.enter) { rig.enter = false; onEnter(a, rig, st0, tf); }
      if (!a.dead && tdt > 0) rig.face += M.angleDiff(rig.face, tf) * (1 - Math.exp(-(def.turn || 18) * dt));
      // ---- hit flinch: detect a fresh hit flash
      const fT = a.flashT || 0;
      if (fT > rig.lastFlash + 0.02 && !a.dead) startFlinch(a, rig, 0.85);
      rig.lastFlash = fT;
      if (tdt > 0) rig.fl = max(0, rig.fl - tdt * 4.2);
      // ---- effective state
      let st = st0;
      if (a.dead) st = 'dead';
      else if (a._stunned && !frozen && st0 !== 'dodge') st = 'stun';
      const dur = an.dur || DUR[st0] || 0.3;
      let u = clamp(an.t / dur, 0, 1), w = 1;
      if (st === 'stun') { if (st0 === 'stun') w = min(1, an.t / 0.1); else u = 0; }
      else if (st === 'channel') w = sm(an.t / 0.12);
      else if (ONESHOT[st]) { w = 1 - sm((an.t - dur) / 0.14); if (w <= 0) { st = 'idle'; w = 0; } }
      // safety net: never stick in a one-shot pose forever
      if (ONESHOT[st0] && an.t > dur + 1.5 && !a.dead) { an.state = 'idle'; an.t = 0; }
      if ((st0 === 'hit' || st0 === 'spawn') && an.t > dur + 0.02 && !a.dead) { an.state = 'idle'; an.t = 0; }
      rig.st = st; rig.u = u; rig.w = w; rig.v = an.variant || '';
      rig.pop = st === 'spawn' && !def.bony && def.kind !== 'dragon' ? max(0.05, M.easeOutBack(u)) : 1;
      // ---- pose + secondary motion (skip far off-screen actors)
      const inView = !rig.posed || R.inViewWorld(a.x, a.y, 260 + def.H * rig.sc * 1.5);
      if (inView) {
        setX(a, rig);
        (def.pose || poseHuman)(a, rig);
        rig.posed = true;
        if (def.sim && !(a.dead && rig.deathKind === 'bones')) {
          if (rig.teleport) { for (const k of ['cape', 'hair', 'flame', 'beard', 'tat', 'rag', 'tail']) if (rig[k]) rig[k].init = false; }
          def.sim(a, rig, tdt > 0.034 ? 0.034 : tdt);
        }
        rig.teleport = false;
        // weapon tip (world)
        const J = rig.J, wp = a.weapon || rig.weapon || def.weapon;
        if (def.kind === 'dragon') W(rig.tip, J.x7[0], J.x7[1], J.x7[2]);
        else if (wp && WLEN[wp.kind]) { const len = WLEN[wp.kind] * (def.bigWeapon ? 1.5 : 1) * (def.weaponLenK || 1) * (wp.kind === 'staff' || wp.kind === 'spear' ? 0.5 : 1); madd(_tmp, wp.kind === 'bow' ? J.ha0 : J.ha1, wp.kind === 'bow' ? J.bd : J.wd, wp.kind === 'bow' ? 0 : len); W(rig.tip, _tmp[0], _tmp[1], _tmp[2]); }
        else W(rig.tip, J.ha1[0], J.ha1[1], J.ha1[2]);
      } else rig.teleport = true;
      // ---- death
      if (a.dead) updateDeath(a, rig, dt);
    },

    onDeath(a, info) {
      if (a.rig === false) return;
      if (!a.rig || typeof a.rig !== 'object' || !a.rig.def) Rig.create(a, guessId(a));
      const rig = a.rig; if (rig.dead) return;
      rig.dead = true; rig.deadT = 0;
      const an = a.anim || (a.anim = {}); an.state = 'dead'; an.t = 0; an.dur = 1;
      // direction of the killing blow → fall / scatter away from it
      let dx = 0, dy = 0;
      const sp = info && info.spec;
      if (sp && typeof sp.dir === 'number') { dx = cos(sp.dir); dy = sin(sp.dir); }
      else if (info && info.source && info.source.x !== undefined) { const l = len2(a.x - info.source.x, a.y - info.source.y) || 1; dx = (a.x - info.source.x) / l; dy = (a.y - info.source.y) / l; }
      else if (a.kx || a.ky) { const l = len2(a.kx, a.ky) || 1; dx = a.kx / l; dy = a.ky / l; }
      else { dx = -cos(rig.face); dy = -sin(rig.face); }
      rig.fallDir = dx * cos(rig.face) + dy * sin(rig.face) >= 0 ? 1 : -1;
      let kind = rig.deathKind;
      rig.pileFade = 1;
      if (!rig.posed) { setX(a, rig); (rig.def.pose || poseHuman)(a, rig); rig.posed = true; }
      setX(a, rig);
      if (kind === 'bones' || kind === 'dragon') { rig.debris = spawnBones(a, rig, dx, dy); HM.Audio && HM.Audio.play && HM.Audio.play('bone_break', { x: a.x, y: a.y }); }
      else if (kind === 'crumble') { rig.debris = spawnChunks(a, rig, dx, dy, rig.pal.snow || [0.85, 0.9, 1], 14); }
      else if (kind === 'burst') { rig.debris = spawnChunks(a, rig, dx, dy, rig.pal.body || [0.8, 0.3, 0.5], 12, 0); }
      else rig.debris = [];
      rig.deathLen = rig.def.pileLen || (kind === 'bones' ? 20 : kind === 'dragon' ? 34 : kind === 'crumble' ? 12 : kind === 'burst' ? 9 : a.isBoss ? 6.5 : kind === 'ember' || kind === 'void' ? 3 : 3.6);
      deathFX(a, kind);
      if (rig.def.deathFx) deathFX(a, rig.def.deathFx);
      if (a.isBoss && HM.FX && HM.FX.shake) { try { HM.FX.shake(kind === 'dragon' ? 12 : 7); } catch (e) { /* cosmetic */ } }
    },

    draw(a) {
      if (a.rig === false) return;
      if (!a.rig || typeof a.rig !== 'object' || !a.rig.def) Rig.create(a, a.rig && a.rig.id ? a.rig.id : guessId(a));
      const rig = a.rig, def = rig.def;
      if (!rig.posed) Rig.update(a, 0);
      setX(a, rig);
      const sc = X.sc, T = rig.time;
      // ---- figure state
      FIG.n = 0; FIG.minKey = Infinity; FIG.pat = 0; FIG.p2 = null; FIG.T = T; FIG.seed = (a.id || 0) * 13; FIG.part = 1; FIG.hold = 0;
      // dither anchor = the figure's own origin cell (the pattern rides with the figure); biome tones + contrast gain
      FIG.oci = floor(a.x / CW); FIG.ocj = floor((a.y * TILT - (a.z || 0)) / CH);
      BC = BIO[biomeId()]; FIG.dk = 1; FIG.mr = 0; FIG.sat = def.sat || 1; FIG.so = 0.14 + (BC.so || 0); // so: shading offset (ice: broader navy shadow side) FIG.gain = a.dead ? 1 : figureGain(a, rig);
      FIG.flash = a.flashT > 0 && !a.dead ? clamp(a.flashT / 0.06, 0, 1) : 0;
      FIG.alpha = 1; FIG.dis = 0; FIG.unlit = 0; FIG.clipPy = Infinity; FIG.ta = 0; FIG.rim = 0;
      // status tints (strongest wins)
      if (a.statuses && a.statuses.length) {
        let best = 0;
        for (const s of a.statuses) {
          const t = STATUS_TINT[s.id]; if (!t) continue;
          let k = t[3]; if (s.id === 'burn') k *= 0.7 + 0.6 * abs(sin(T * 17)); if (s.id === 'poison') k *= 0.8 + 0.4 * sin(T * 4);
          if (k > best) { best = k; FIG.tr = t[0]; FIG.tg = t[1]; FIG.tb = t[2]; FIG.ta = k; }
        }
        const kin = hasStatus(a, 'kindled') || hasStatus(a, 'shield');
        if (kin) { const c = kin.id === 'kindled' ? [1, 0.5, 0.15] : [0.6, 0.75, 1.1]; FIG.rim = 0.45 + 0.2 * sin(T * 6); FIG.rr = c[0]; FIG.rg = c[1]; FIG.rb = c[2]; }
      }
      if (a.isElite && !a.dead) { const c = a.rimColor || a.eliteColor || [1.0, 0.55, 0.2]; FIG.rim = 0.55 + 0.3 * sin(T * 4.5 + rig.seed); FIG.rr = c[0]; FIG.rg = c[1]; FIG.rb = c[2]; }
      if ((a.z || 0) < -0.5 || (rig.st === 'spawn' && def.bony)) FIG.clipPy = a.y * TILT + 3;
      // ---- death states
      let showBody = true;
      if (a.dead) {
        const k = rig.deathKind, t = rig.deadT;
        if (k === 'bones' || k === 'dragon') { showBody = t < 0.04; rig.pileFade = 1 - clamp((t - (rig.deathLen - 2)) / 2, 0, 1); }
        else if (k === 'burst') { showBody = t < 0.12; rig.pileFade = 1 - clamp((t - (rig.deathLen - 2)) / 2, 0, 1); FIG.flash = t < 0.12 ? 1 : 0; }
        else if (k === 'crumble') { showBody = t < 0.05; rig.pileFade = 1 - clamp((t - (rig.deathLen - 2)) / 2, 0, 1); }
        else if (a.kind !== 'player') {
          const d0 = a.isBoss ? 2.2 : 0.9, d1 = a.isBoss ? 5.8 : k === 'ember' || k === 'void' ? 2.6 : 3.2;
          FIG.dis = clamp((t - d0) / (d1 - d0), 0, 1);
          if (k === 'ember' || k === 'void') FIG.alpha = 1 - 0.5 * FIG.dis;
          if (FIG.dis >= 1) showBody = false;
        }
      }
      // ---- shadow (moon top-right → falls down-left)
      const z0 = (a.z || 0) + (rig.J.lift || 0) * sc;
      const sh = def.shadow || [10, 6], fade = 1 - clamp(z0 / 120, 0, 0.7);
      if (showBody && FIG.dis < 0.9) shadow(a.x - 3 * sc, a.y + 2.5 * sc, sh[0] * sc * (a.dead ? 1.3 : 1), sh[1] * sc, 0.62 * fade * (1 - FIG.dis));
      // ---- body
      if (showBody) {
        if (rig.st === 'dodge' && rig.v === 'bat' && !a.dead) drawBats(a, rig);
        def.draw.call(def, a, rig); FIG.pat = 0;
        if (rig.st === 'stun' && !a.dead) drawStars(a, rig);
        if (def.light && !a.dead && !a.noRigLight && !a.lightOverride && !(a.def && a.def.light)) def.light(a, rig);
      }
      FIG.flash = 0; FIG.ta = 0; FIG.rim = 0; FIG.dis = 0; FIG.alpha = 1;
      if (rig.debris && rig.debris.length) drawDebris(a, rig);
      a._figSerial = definition();
      FIG.clipPy = Infinity;
    },

    // ------------------------------------------------------------------ test helpers
    // definition-pass internals for tools/tests/definition.js (cell owner serials; a._figSerial = an actor's serial)
    _debug() { return { own: OWN, ownk: OWNK, dks: DKS, dkt: DKT, prt: PRT, crowdBreaks: DBG.crowd, partBreaks: DBG.part }; },
    _gallery: [],
    // gallery(filter, ox, oy, spacing, cols): filter = group name ('heroes' 'enemies' 'bosses' 'dragon'), a rig id, or an array of ids
    gallery(filter, ox, oy, spacing, ncols) {
      const G = HM.Game; if (!G) return [];
      Rig.galleryClear();
      const p = G.player, cx = (p ? p.x : G.cam.x) + (ox || 0), cy = (p ? p.y : G.cam.y) + (oy || 0);
      const groups = {
        heroes: ['finn', 'marceline', 'fp', 'jake', 'goose', 'snail'],
        enemies: ['thrall', 'archer', 'hound', 'snail', 'husk', 'bloater', 'banana', 'penguin', 'golem', 'wisp', 'elemental', 'cinder', 'brute', 'knight', 'priest', 'wraith'],
        bosses: ['lemongrab', 'iceKing', 'flameKing', 'lich'],
        dragon: ['boneDragon'],
      };
      let ids = Array.isArray(filter) ? filter : typeof filter === 'string' && groups[filter] ? groups[filter] : typeof filter === 'string' && DEFS[filter] ? [filter] : Rig.ROSTER.filter((id) => id !== 'boneDragon');
      const cols = ncols || (filter === 'bosses' ? 4 : ids.length <= 6 ? ids.length : 6);
      const dx = (filter === 'bosses' ? 120 : 82) * (spacing || 1), dy = (filter === 'bosses' ? 200 : 128) * (spacing || 1);
      const rows = Math.ceil(ids.length / cols);
      ids.forEach((id, k) => {
        const c = k % cols, r = (k / cols) | 0;
        const x = cx + (c - (cols - 1) / 2) * dx, y = cy + (r - (rows - 1) / 2) * dy + (filter === 'dragon' ? 40 : 30);
        const g = new HM.Actor({ kind: 'npc', team: 2, name: id, defId: 'gallery_' + id, x, y, facing: PI / 2, aim: PI / 2, hp: 100, maxHp: 100, radius: 6, noCollide: true, anchored: true, xpValue: 0 });
        g._gal = true; g._home = [x, y];
        g.update = function (dt) {
          this.vx = 0; this.vy = 0;
          if (this._walk && !this.dead) { this._wa = (this._wa || 0) + dt * this._walk / 26; this.vx = -sin(this._wa) * this._walk; this.vy = cos(this._wa) * this._walk; this.facing = Math.atan2(this.vy, this.vx); this.aim = this.facing; }
          HM.Combat.baseUpdate(this, dt);
          if (this._loop && !this.dead && this.anim.t > (this.anim.dur || 0.4) + 0.45) Rig.setAnim(this, this._loop.state, this._loop.o);
        };
        Rig.create(g, id, id === 'snail' ? {} : {});
        if (id === 'snail' && k % 2) g.possessed = true;
        G.spawn(g); Rig._gallery.push(g);
      });
      return Rig._gallery;
    },
    galleryAnim(state, variant, dur) {
      for (const g of Rig._gallery) { if (g.dead) continue; g._loop = state === 'idle' ? null : { state, o: { variant, dur: dur || DUR[state] || 0.5 } }; Rig.setAnim(g, state, { variant, dur: dur || DUR[state] || 0.5 }); }
    },
    // per-actor: galleryEach((g, k) => ...) for staged multi-pose shots
    galleryEach(fn) { Rig._gallery.forEach(fn); },
    galleryWalk(speed) { for (const g of Rig._gallery) g._walk = speed === undefined ? 90 : speed; },
    galleryFace(angle, step) { Rig._gallery.forEach((g, k) => { const a = angle + k * (step || 0); g.facing = a; g.aim = a; if (g.rig) g.rig.face = a; }); },
    galleryKill() { for (const g of Rig._gallery) if (!g.dead) { g.dead = true; g.hp = 0; Rig.onDeath(g, { source: HM.Game && HM.Game.player }); } },
    galleryStatus(id, dur) { for (const g of Rig._gallery) HM.Combat.applyStatus(g, id, { dur: dur || 30, dps: 0 }); },
    galleryElite() { for (const g of Rig._gallery) g.isElite = true; },
    galleryClear() { for (const g of Rig._gallery) g.removeMe = true; Rig._gallery = []; },
  });

  function onEnter(a, rig, st, tf) {
    if ((st === 'attack' || st === 'cast' || st === 'channel') && (rig.def.turn || 18) >= 10) rig.face = tf;
    if (st === 'hit') startFlinch(a, rig, 1);
    if (st === 'spawn' && rig.def.bony) {
      const FX = HM.FX;
      if (FX) { try { FX.burst && FX.burst(a.x, a.y, 2, 'dust', 12); FX.decal && FX.decal(a.x, a.y, 'crack', 16 * rig.sc, 5); } catch (e) { /* cosmetic */ } }
    }
  }
  function startFlinch(a, rig, k) {
    rig.fl = max(rig.fl, k);
    const kx = a.kx || 0, ky = a.ky || 0, l = len2(kx, ky);
    if (l > 1) { const fx = cos(rig.face), fy = sin(rig.face); rig.flx = (-fy * kx + fx * ky) / l; rig.fly = (fx * kx + fy * ky) / l; }
    else { rig.flx = 0; rig.fly = -1; }
  }
  function updateDeath(a, rig, dt) {
    if (!rig.dead) Rig.onDeath(a, null);
    rig.deadT += dt;
    if (rig.debris) {
      updateDebris(a, rig, dt);
      // fleshy dissolve sheds glyph dust (embers for elementals, void sparks for wraiths)
      const k = rig.deathKind;
      if (k !== 'bones' && k !== 'dragon' && k !== 'crumble' && k !== 'burst' && a.kind !== 'player' && rig.debris.length < 40) {
        const d0 = a.isBoss ? 2.2 : 0.9, d1 = a.isBoss ? 5.8 : 3.0;
        if (rig.deadT > d0 && rig.deadT < d1 && rig.posed) {
          setX(a, rig);
          const n = HM.rng.next() < dt * (a.isBoss ? 40 : 18) ? 1 : 0;
          if (n) {
            const col = k === 'ember' ? [1.0, 0.5, 0.12] : k === 'void' ? [0.6, 0.3, 0.9] : (rig.pal.body || rig.pal.skin || rig.pal.fur || [0.6, 0.6, 0.6]);
            rig.debris.push(...spawnMotes(rig, 2, col, k === 'ember' || k === 'void' ? 0.8 : 0.1, DUST));
          }
        }
      }
    }
    if (a.kind !== 'player' && rig.deadT > (rig.deathLen || 4)) a.removeMe = true;
  }
  function drawStars(a, rig) {
    const T = rig.time, J = rig.J;
    for (let k = 0; k < 3; k++) {
      const ang = T * 4 + (k * TAU) / 3;
      set3(_p, J.hd[0] + cos(ang) * 7, J.hd[1] + sin(ang) * 5, J.hd[2] + (rig.B.headR || 6) + 4 + sin(ang * 2) * 1);
      dotV(_p, k === 0 ? GL.star : GL.plus, [1.2, 1.1, 0.5], 0.6, 3);
    }
  }
})();
