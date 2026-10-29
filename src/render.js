// render.js — the ASCII renderer.
// A CPU cell buffer (world-anchored glyph grid) is rasterized every frame, lit, then composited by a
// WebGL2 shader that draws glyphs from a font atlas with a blurred glow pass (bloom), tone-mapping,
// vignette and grain. The grid scrolls smoothly via a sub-cell shader offset.
//
// Coordinate spaces:
//   world      (x, y) ground plane + z height
//   projected  px = x, py = y*TILT - z            (unit = world px)
//   cell       ci = floor(px/CW), cj = floor(py/CH) (world-anchored; never shimmer)
//   screen     CSS px on the canvas
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const HM = (globalThis.window || globalThis).HM;
  const { CW, CH, TILT } = HM.cfg;

  // Glyph set: index 0 is space. ASCII printable + a few extras.
  const CHARSET = ' ' + Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join('') + '·°•×÷¦§¤';
  const LUT = new Int16Array(65536);
  for (let i = 0; i < CHARSET.length; i++) LUT[CHARSET.charCodeAt(i)] = i;

  // Flags. F_FIGURE marks characters/monsters: drawn in a BOLD glyph weight, rim-lit, and the renderer cuts a dark
  // outline into the terrain around them so forms separate cleanly from the busy background.
  const F_UNLIT = 1, F_GROUND = 2, F_NOSHADOW = 4, F_FIGURE = 8, F_PROP = 16; // F_PROP: outline + rim, regular weight (props, interactables, loot)
  const BOLD = 128; // glyph index offset of the bold atlas set

  const R = (HM.R = {
    CHARSET, F_UNLIT, F_GROUND, F_NOSHADOW, F_FIGURE, F_PROP, BOLD,
    KEY_GROUND: -1e8,  // terrain layer depth key
    KEY_DECAL: -1e7,   // ground decals (telegraphs, scorch, blood) — above terrain, below actors
    KEY_TOP: 1e9,      // always on top
    headless: false,
    gl: null, canvas: null,
    dpr: 1, cssW: 1280, cssH: 720,
    gw: 10, gh: 16,              // device px per cell
    zoomX: 1, zoomY: 1,          // css px per projected px
    viewW: 1280, viewH: 720,     // projected px visible
    cols: 0, rows: 0, n: 0,      // buffer dims (visible + margin)
    ci0: 0, cj0: 0,              // world cell index of buffer (0,0)
    camPx: 0, camPy: 0,          // projected camera center
    originPx: 0, originPy: 0,    // projected px of screen top-left
    glyphSize: 'medium',
    ambient: [1, 1, 1],
    shadowStrength: 0.7,
    lightTint: 1.8,              // how strongly lights recolor glyphs by their brightness
    glowK: 0.55, hazeK: 0.05,
    // figure/ground separation
    groundDim: 0.64,             // terrain albedo multiplier (background recedes)
    groundDesat: 0.32,           // terrain desaturation toward luminance
    figureLift: 1.22,            // figure albedo multiplier
    rimK: 1.35,                  // brightness boost on figure silhouette edge cells
    outline: true,               // thin soft shadow on terrain touching figures
    outlineDark: 0.42,           // brightness of terrain cells touching a figure (1 = no outline)
    exposure: 1.55, vignette: 0.95,
    flashC: [0, 0, 0, 0], hurt: 0,
    time: 0,
    lights: [],
    // water as a night mirror (the reference's "fishing" reels): reflections of figures/props/fire about the
    // shoreline, an ASCII moon disc and drifting cloud reflections, all wobbling with the waves.
    reflect: true,
    waterDim: 0.5,               // base water glyph brightness under the mirror pass
    waterTest: null,             // (ci, cj) => bool; defaults to HM.World.isWater at the cell centre
    stats: { lights: 0 },

    gi: (ch) => LUT[ch.charCodeAt(0)] || 0,  // char -> glyph index
    gc: (code) => LUT[code] || 0,            // char code -> glyph index
    ramp(str) { const a = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) a[i] = LUT[str.charCodeAt(i)]; return a; },

    // ---------------------------------------------------------------- setup
    init(canvas, opts) {
      opts = opts || {};
      R.headless = !!opts.headless || !canvas;
      R.canvas = canvas || null;
      if (!R.headless) {
        R.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: !!opts.preserve });
        if (!R.gl) { R.headless = true; R.glError = 'WebGL2 not available'; }
      }
      R.resize(opts.w, opts.h);
      if (!R.headless) R._initGL();
    },

    setGlyphSize(size) { R.glyphSize = size; R.resize(); },

    resize(w, h) {
      const win = globalThis.window;
      R.cssW = w || (win && win.innerWidth) || 1280;
      R.cssH = h || (win && win.innerHeight) || 720;
      R.dpr = Math.min(2, (win && win.devicePixelRatio) || 1);
      const target = { small: 112, medium: HM.cfg.TARGET_ROWS, large: 74 }[R.glyphSize] || HM.cfg.TARGET_ROWS;
      R.gh = Math.max(8, Math.round((R.cssH * R.dpr) / target));
      R.gw = Math.max(5, Math.round((R.gh * CW) / CH));
      R.zoomX = R.gw / (CW * R.dpr);
      R.zoomY = R.gh / (CH * R.dpr);
      R.viewW = R.cssW / R.zoomX;
      R.viewH = R.cssH / R.zoomY;
      const cols = Math.ceil(R.viewW / CW) + 2, rows = Math.ceil(R.viewH / CH) + 2;
      if (cols !== R.cols || rows !== R.rows) R._alloc(cols, rows);
      if (R.canvas) {
        R.canvas.width = Math.round(R.cssW * R.dpr); R.canvas.height = Math.round(R.cssH * R.dpr);
        R.canvas.style.width = R.cssW + 'px'; R.canvas.style.height = R.cssH + 'px';
      }
      if (R.gl) R._buildAtlas();
      HM.Events && HM.Events.emit('resize', { w: R.cssW, h: R.cssH });
    },

    _alloc(cols, rows) {
      R.cols = cols; R.rows = rows; const n = (R.n = cols * rows);
      R.glyph = new Uint8Array(n);
      R.col = new Float32Array(n * 3);
      R.emi = new Float32Array(n * 3);
      R.key = new Float32Array(n);
      R.flag = new Uint8Array(n);
      R.shd = new Float32Array(n);
      R.lgt = new Float32Array(n * 3);
      R.out = new Float32Array(n * 4);
      R.glow = new Float32Array(n * 4);
      R._tmp = new Float32Array(n * 3);
      R._tmp2 = new Float32Array(n * 3);
      R._texDirty = true;
    },

    // ---------------------------------------------------------------- frame
    beginFrame(camX, camY, dt) {
      R.time += dt || 0;
      R.camPx = camX; R.camPy = camY * TILT;
      R.originPx = R.camPx - R.viewW / 2; R.originPy = R.camPy - R.viewH / 2;
      R.ci0 = Math.floor(R.originPx / CW); R.cj0 = Math.floor(R.originPy / CH);
      R.glyph.fill(0); R.col.fill(0); R.emi.fill(0); R.key.fill(-Infinity); R.flag.fill(0); R.shd.fill(0); R.lgt.fill(0);
      R.lights.length = 0;
    },

    // index of world cell (ci,cj) in the buffer, or -1
    idx(ci, cj) {
      const x = ci - R.ci0, y = cj - R.cj0;
      if (x < 0 || y < 0 || x >= R.cols || y >= R.rows) return -1;
      return y * R.cols + x;
    },
    // projected px -> buffer index
    idxP(px, py) { return R.idx(Math.floor(px / CW), Math.floor(py / CH)); },
    // world -> projected
    proj(x, y, z) { return [x, y * TILT - (z || 0)]; },
    // cell center (projected px)
    cellPx(ci) { return (ci + 0.5) * CW; },
    cellPy(cj) { return (cj + 0.5) * CH; },
    // projected -> screen css
    toScreen(px, py) { return [(px - R.originPx) * R.zoomX, (py - R.originPy) * R.zoomY]; },
    worldToScreen(x, y, z) { return [(x - R.originPx) * R.zoomX, (y * TILT - (z || 0) - R.originPy) * R.zoomY]; },
    screenToWorld(sx, sy) { const px = sx / R.zoomX + R.originPx, py = sy / R.zoomY + R.originPy; return [px, py / TILT]; },
    inView(px, py, m) { m = m || 0; return px > R.originPx - m && px < R.originPx + R.viewW + m && py > R.originPy - m && py < R.originPy + R.viewH + m; },
    inViewWorld(x, y, m) { return R.inView(x, y * TILT, m); },

    // ---------------------------------------------------------------- primitives
    // Write one cell with depth test (key >= existing wins).
    setI(i, g, r, gg, b, key, flags) {
      if (i < 0 || key < R.key[i]) return false;
      R.key[i] = key; R.glyph[i] = (flags & F_FIGURE) && g ? (g & 127) | BOLD : g; const k = i * 3; R.col[k] = r; R.col[k + 1] = gg; R.col[k + 2] = b; R.flag[i] = flags || 0;
      return true;
    },
    setC(ci, cj, g, r, gg, b, key, flags) { return R.setI(R.idx(ci, cj), g, r, gg, b, key, flags); },
    set(px, py, g, r, gg, b, key, flags) { return R.setI(R.idxP(px, py), g, r, gg, b, key, flags); },
    // Additive emissive light on a cell (adds to glyph color AND glow). Ignores depth.
    emitI(i, r, g, b) { if (i < 0) return; const k = i * 3; R.emi[k] += r; R.emi[k + 1] += g; R.emi[k + 2] += b; },
    emit(px, py, r, g, b) { R.emitI(R.idxP(px, py), r, g, b); },
    // Glyph that glows: sets glyph + color (unlit) and adds emissive. Depth tested.
    glowGlyph(px, py, g, r, gg, b, key, emitK) {
      const i = R.idxP(px, py);
      if (R.setI(i, g, r, gg, b, key, F_UNLIT)) { const e = emitK === undefined ? 0.5 : emitK; R.emitI(i, r * e, gg * e, b * e); return true; }
      return false;
    },
    // Darken ground (ambient occlusion). amount 0..1
    shadowI(i, a) { if (i >= 0) R.shd[i] = Math.min(1, R.shd[i] + a); },

    // Text written into cells (left aligned at px,py). Spaces are transparent.
    text(px, py, str, r, g, b, key, flags) {
      let ci = Math.floor(px / CW); const cj = Math.floor(py / CH);
      for (let n = 0; n < str.length; n++, ci++) { const c = str.charCodeAt(n); if (c !== 32) R.setC(ci, cj, LUT[c], r, g, b, key, flags); }
    },
    textCenter(px, py, str, r, g, b, key, flags) { R.text(px - (str.length * CW) / 2, py, str, r, g, b, key, flags); },
    // Multi-line ASCII sprite centered at (px,py) bottom-center anchor. colorFn(ch,x,y)->[r,g,b] or fixed rgb array.
    sprite(px, py, lines, color, key, flags) {
      const h = lines.length; let w = 0; for (const l of lines) w = Math.max(w, l.length);
      const ci0 = Math.floor(px / CW - w / 2), cj0 = Math.floor(py / CH) - h + 1;
      for (let y = 0; y < h; y++) {
        const l = lines[y];
        for (let x = 0; x < l.length; x++) {
          const c = l.charCodeAt(x); if (c === 32) continue;
          const rgb = typeof color === 'function' ? color(l[x], x, y) : color;
          if (rgb) R.setC(ci0 + x, cj0 + y, LUT[c], rgb[0], rgb[1], rgb[2], key, flags);
        }
      }
    },

    // Directional glyph for a line in screen space
    dirGlyph(dx, dy) {
      const a = Math.abs(Math.atan2(dy * (CW / CH) * 1.6, dx)); // compensate cell aspect
      const deg = (a * 180) / Math.PI;
      if (deg < 22 || deg > 158) return DIR_H;
      if (deg > 68 && deg < 112) return DIR_V;
      return (dx * dy > 0) ? DIR_BS : DIR_FS;
    },
    // Line in projected px through cells. g = glyph index or null for directional.
    seg(ax, ay, bx, by, g, r, gg, b, key, flags, keyB) {
      const dx = bx - ax, dy = by - ay;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx) / CW, Math.abs(dy) / CH) * 1.5));
      const gl = g === null || g === undefined ? R.dirGlyph(dx, dy) : g;
      const kb = keyB === undefined ? key : keyB;
      let last = -2;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps; const i = R.idxP(ax + dx * t, ay + dy * t);
        if (i === last) continue; last = i;
        R.setI(i, gl, r, gg, b, key + (kb - key) * t, flags);
      }
    },

    // Shaded tapered capsule from A to B (projected px), radii ra/rb, depth keys ka/kb.
    // ramp: Uint8Array glyph ramp dark->bright. Produces 3D-ish shading. Returns cells drawn.
    capsule(ax, ay, bx, by, ra, rb, ka, kb, ramp, r, g, b, flags, opts) {
      const maxR = Math.max(ra, rb);
      if (!(opts && opts.notFigure)) flags = (flags || 0) | F_FIGURE; // capsules/balls are figure parts by default
      if (maxR < CW * 0.42) { // too thin to rasterize as area: draw as a shaded line
        const sh = 0.75; const gl = opts && opts.thinGlyph !== undefined ? opts.thinGlyph : null;
        R.seg(ax, ay, bx, by, gl, r * sh, g * sh, b * sh, ka, flags, kb);
        return 1;
      }
      const lx = L[0], ly = L[1], lz = L[2];
      const ambientShade = opts && opts.amb !== undefined ? opts.amb : 0.18;
      const dither = opts && opts.dither !== undefined ? opts.dither : 0.6;
      const rlen = ramp.length - 1;
      const pad = 1.0;
      const minx = Math.min(ax - ra, bx - rb) - pad, maxx = Math.max(ax + ra, bx + rb) + pad;
      const miny = Math.min(ay - ra, by - rb) - pad, maxy = Math.max(ay + ra, by + rb) + pad;
      const ci0 = Math.floor(minx / CW), ci1 = Math.floor(maxx / CW), cj0 = Math.floor(miny / CH), cj1 = Math.floor(maxy / CH);
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-6;
      let count = 0;
      for (let cj = cj0; cj <= cj1; cj++) {
        const py = (cj + 0.5) * CH;
        for (let ci = ci0; ci <= ci1; ci++) {
          const px = (ci + 0.5) * CW;
          let t = ((px - ax) * dx + (py - ay) * dy) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
          const cx = ax + dx * t, cy = ay + dy * t;
          const rr = ra + (rb - ra) * t;
          const ex = px - cx, ey = py - cy;
          const d = Math.sqrt(ex * ex + ey * ey);
          if (d > rr + 1.1) continue;
          const i = R.idx(ci, cj); if (i < 0) continue;
          let nx = ex / (rr + 1.1), ny = ey / (rr + 1.1);
          let nn = nx * nx + ny * ny; if (nn > 1) nn = 1;
          const nz = Math.sqrt(1 - nn);
          let sh = nx * lx + ny * ly + nz * lz; if (sh < 0) sh = 0;
          sh = ambientShade + (1 - ambientShade) * sh;
          const k = ka + (kb - ka) * t + nz * 0.25;
          if (k < R.key[i]) continue;
          const hv = HM.M.hash2(ci * 7 + 3, cj * 13 + 1) - 0.5;
          let gi = Math.round(sh * rlen + hv * dither); gi = gi < 1 ? 1 : gi > rlen ? rlen : gi;
          const c = 0.32 + 0.9 * sh;
          R.key[i] = k; R.glyph[i] = (flags & F_FIGURE) ? (ramp[gi] & 127) | BOLD : ramp[gi]; const o = i * 3; R.col[o] = r * c; R.col[o + 1] = g * c; R.col[o + 2] = b * c; R.flag[i] = flags || 0;
          count++;
        }
      }
      return count;
    },
    // Shaded sphere (radius in projected px).
    ball(cx, cy, rad, key, ramp, r, g, b, flags, opts) { return R.capsule(cx, cy, cx, cy + 0.001, rad, rad, key, key, ramp, r, g, b, flags, opts); },

    // Iterate cells in a ground ellipse centered on world (x,y): rx world units wide, ry world units deep.
    // fn(i, u, ci, cj, ang) where u = normalized radius [0,1]
    ellipse(x, y, rx, ry, fn) {
      const cx = x, cy = y * TILT, ryp = ry * TILT;
      const ci0 = Math.floor((cx - rx) / CW), ci1 = Math.floor((cx + rx) / CW);
      const cj0 = Math.floor((cy - ryp) / CH), cj1 = Math.floor((cy + ryp) / CH);
      for (let cj = cj0; cj <= cj1; cj++) {
        const ey = ((cj + 0.5) * CH - cy) / ryp;
        for (let ci = ci0; ci <= ci1; ci++) {
          const ex = ((ci + 0.5) * CW - cx) / rx;
          const u2 = ex * ex + ey * ey; if (u2 > 1) continue;
          const i = R.idx(ci, cj); if (i < 0) continue;
          fn(i, Math.sqrt(u2), ci, cj, Math.atan2(ey, ex));
        }
      }
    },
    // Iterate cells on a ground ring (radius rad world units, thickness th world units).
    ring(x, y, rad, th, fn) {
      const outer = rad + th / 2, inner = Math.max(0, rad - th / 2);
      R.ellipse(x, y, outer, outer, (i, u, ci, cj, ang) => { const d = u * outer; if (d >= inner) fn(i, (d - inner) / Math.max(1e-6, outer - inner), ci, cj, ang); });
    },
    // Soft blob shadow on ground
    shadowEllipse(x, y, rx, ry, amount) {
      R.ellipse(x, y, rx, ry, (i, u) => { R.shd[i] = Math.min(1, R.shd[i] + amount * (1 - u * u)); });
    },

    // Point light in world coords. radius in world units. Color can exceed 1.
    light(x, y, z, radius, r, g, b, intensity) {
      if (!R.inViewWorld(x, y, radius + 50)) return;
      const k = intensity === undefined ? 1 : intensity;
      R.lights.push(x, y * TILT, radius, r * k, g * k, b * k);
    },
    flash(r, g, b, a) { R.flashC[0] = r; R.flashC[1] = g; R.flashC[2] = b; R.flashC[3] = Math.max(R.flashC[3], a); },

    // ---------------------------------------------------------------- composite
    endFrame(dt) {
      const n = R.n, cols = R.cols, rows = R.rows;
      const col = R.col, emi = R.emi, lgt = R.lgt, shd = R.shd, flag = R.flag, out = R.out, glow = R.glow;
      R._reflect();
      R._separate();
      // 1. accumulate point lights
      const Ls = R.lights; R.stats.lights = Ls.length / 6;
      for (let li = 0; li < Ls.length; li += 6) {
        const lx = Ls[li], ly = Ls[li + 1], rad = Ls[li + 2], lr = Ls[li + 3], lg = Ls[li + 4], lb = Ls[li + 5];
        const radY = rad * TILT;
        const x0 = Math.max(0, Math.floor((lx - rad) / CW) - R.ci0), x1 = Math.min(cols - 1, Math.floor((lx + rad) / CW) - R.ci0);
        const y0 = Math.max(0, Math.floor((ly - radY) / CH) - R.cj0), y1 = Math.min(rows - 1, Math.floor((ly + radY) / CH) - R.cj0);
        const inv = 1 / (rad * rad);
        for (let y = y0; y <= y1; y++) {
          const dy = ((y + R.cj0 + 0.5) * CH - ly) / TILT; const dy2 = dy * dy;
          let i = y * cols + x0;
          for (let x = x0; x <= x1; x++, i++) {
            const dx = (x + R.ci0 + 0.5) * CW - lx;
            const q = (dx * dx + dy2) * inv; if (q >= 1) continue;
            const f = (1 - q) * (1 - q);
            const o = i * 3; lgt[o] += lr * f; lgt[o + 1] += lg * f; lgt[o + 2] += lb * f;
          }
        }
      }
      // 2. resolve color
      const ar = R.ambient[0], ag = R.ambient[1], ab = R.ambient[2];
      const ss = R.shadowStrength, tint = R.lightTint, gk = R.glowK, hk = R.hazeK;
      for (let i = 0; i < n; i++) {
        const o = i * 3, q = i * 4;
        let r = col[o], g = col[o + 1], b = col[o + 2];
        const fl = flag[i];
        if (fl & F_GROUND) { const l = r * 0.3 + g * 0.55 + b * 0.15, dk = R.groundDim, ds = R.groundDesat; r = (r + (l - r) * ds) * dk; g = (g + (l - g) * ds) * dk; b = (b + (l - b) * ds) * dk; }
        const Lr = lgt[o], Lg = lgt[o + 1], Lb = lgt[o + 2];
        if (!(fl & F_UNLIT)) {
          const s = 1 - shd[i] * ((fl & F_GROUND) ? ss : ss * 0.45);
          const lum = r * 0.3 + g * 0.55 + b * 0.15;
          const t = lum * tint + (R.glyph[i] ? 0.015 : 0);
          r = r * ar * s + Lr * t; g = g * ag * s + Lg * t; b = b * ab * s + Lb * t;
        }
        out[q] = r + emi[o]; out[q + 1] = g + emi[o + 1]; out[q + 2] = b + emi[o + 2]; out[q + 3] = 1;
        glow[q] = emi[o] * gk + Lr * hk; glow[q + 1] = emi[o + 1] * gk + Lg * hk; glow[q + 2] = emi[o + 2] * gk + Lb * hk; glow[q + 3] = 1;
      }
      R._blurGlow();
      // decay flash
      R.flashC[3] = Math.max(0, R.flashC[3] - (dt || 0.016) * 4);
      if (!R.headless && !R.skipGPU) R._draw();
    },

    // Figure/ground separation, kept subtle: (1) figure cells on the silhouette edge get a rim boost, interior a lift;
    // (2) a THIN soft shadow: terrain directly touching a figure (4-neighbours) is darkened, not erased.
    // Hard black halos written by rigs (blank cells next to a figure) are refilled from the ground snapshot
    // (R.snapshotGround, taken right after World.draw) so outlines never become thick black borders.
    // ---------------------------------------------------------------- water mirror
    _waterMask() {
      const n = R.n, cols = R.cols, rows = R.rows;
      const W = HM.World; const F = W && W.floor;
      const test = R.waterTest || (W && W.isWater ? (ci, cj) => W.isWater((ci + 0.5) * CW, ((cj + 0.5) * CH) / TILT) : null);
      if (!test) return null;
      const key = R.ci0 + ',' + R.cj0 + ',' + cols + ',' + rows;
      if (R._wm && R._wm.length === n && R._wmKey === key && R._wmFloor === F) return R._wm;
      const m = R._wm && R._wm.length === n ? R._wm : (R._wm = new Uint8Array(n));
      let any = 0;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { const v = test(R.ci0 + x, R.cj0 + y) ? 1 : 0; m[y * cols + x] = v; any |= v; }
      R._wmKey = key; R._wmFloor = F; R._wmAny = any;
      // deepest open water in view (chamfer distance to shore, rows units) -> where the moon reflection sits
      R._moonT = null;
      if (any) {
        const d = R._wd && R._wd.length === n ? R._wd : (R._wd = new Float32Array(n));
        const ax = CW / CH, BIG = 1e4;
        for (let i = 0; i < n; i++) d[i] = m[i] ? BIG : 0;
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { const i = y * cols + x; if (!d[i]) continue; let v = d[i]; if (x > 0) v = Math.min(v, d[i - 1] + ax); if (y > 0) v = Math.min(v, d[i - cols] + 1); d[i] = v; }
        let best = -1, bv = 0;
        for (let y = rows - 1; y >= 0; y--) for (let x = cols - 1; x >= 0; x--) {
          const i = y * cols + x; if (!d[i]) continue; let v = d[i];
          if (x < cols - 1) v = Math.min(v, d[i + 1] + ax); if (y < rows - 1) v = Math.min(v, d[i + cols] + 1); d[i] = v;
          const score = Math.min(v, BIG / 2) + y * 0.04 - Math.abs(x - cols * 0.6) * 0.01; if (score > bv) { bv = score; best = i; }
        }
        if (best >= 0 && d[best] >= 4.5 && d[best] < BIG / 2) R._moonT = [best % cols, Math.floor(best / cols), Math.min(d[best] * 0.85, rows * 0.1)];
      }
      return m;
    },
    _reflect() {
      if (!R.reflect) return;
      const wm = R._waterMask(); if (!wm || !R._wmAny) return;
      const cols = R.cols, rows = R.rows, glyph = R.glyph, col = R.col, emi = R.emi, key = R.key, flag = R.flag;
      const t = R.time, M = HM.M;
      // moon disc (screen-anchored), radius in rows; cells are CH/CW taller than wide
      // moon glides toward the deepest visible water (world-anchored target, smoothed)
      const mt = R._moonT; let mry = 0, mcx = 0, mcy = 0;
      if (mt) {
        const tx = R.ci0 + mt[0], ty = R.cj0 + mt[1];
        if (!R._moon || R._moonFloor !== R._wmFloor) { R._moon = [tx, ty, mt[2]]; R._moonFloor = R._wmFloor; }
        const k = 1 - Math.exp(-2.5 * 0.016); R._moon[0] += (tx - R._moon[0]) * k; R._moon[1] += (ty - R._moon[1]) * k; R._moon[2] += (mt[2] - R._moon[2]) * k;
        mcx = R._moon[0] - R.ci0; mcy = R._moon[1] - R.cj0; mry = R._moon[2];
      }
      const mrx = mry * (CH / CW);
      // cloud field on a coarse grid with slow drift + slight parallax
      const SX = 4, SY = 2, gw = Math.ceil(cols / SX) + 2, gh = Math.ceil(rows / SY) + 2;
      const cg = R._cloudG && R._cloudG.length >= gw * gh ? R._cloudG : (R._cloudG = new Float32Array(gw * gh * 2));
      const px0 = R.originPx * 0.18 / CW, py0 = R.originPy * 0.18 / CH;
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) cg[y * gw + x] = M.fbm((x * SX + px0) * 0.045 + t * 0.018, (y * SY + py0) * 0.11, 3);
      for (let x = 0; x < cols; x++) {
        let shore = -1;
        for (let y = 0; y < rows; y++) {
          const i = y * cols + x;
          if (!wm[i]) { shore = y; continue; }
          if (key[i] > -1e6) continue; // something stands/draws on this water cell (wading figure, particle)
          const wob = Math.sin(t * 1.9 + y * 0.85) * 0.75 + Math.sin(t * 0.8 + y * 0.27 + x * 0.02) * 0.5;
          const broken = Math.sin(t * 2.4 + y * 1.7 + x * 0.09) > 0.9; // ripple breaks in the image
          const o = i * 3;
          // 1) reflections of what stands on the shore above (mirror about the shoreline)
          const dist = y - shore;
          if (shore >= 0 && dist <= 34 && !broken) {
            const ys = shore - dist + 1, xs = x + Math.round(wob * Math.min(1, dist / 5));
            if (ys >= 0 && xs >= 0 && xs < cols) {
              const j = ys * cols + xs, q = j * 3;
              const em = emi[q] + emi[q + 1] + emi[q + 2];
              if (glyph[j] && ((flag[j] & (F_FIGURE | F_PROP)) || em > 0.12)) {
                const fade = (1 - dist / 36) * 0.62;
                glyph[i] = MIRROR[glyph[j] & 127];
                col[o] = col[q] * fade; col[o + 1] = col[q + 1] * fade; col[o + 2] = col[q + 2] * fade + 0.012;
                if (em > 0) { emi[o] += emi[q] * fade * 0.8; emi[o + 1] += emi[q + 1] * fade * 0.8; emi[o + 2] += emi[q + 2] * fade * 0.8; }
                flag[i] = F_UNLIT; key[i] = R.KEY_GROUND + 1;
                continue;
              }
            }
          }
          // 2) sky: moon disc
          const mdx = (x + wob - mcx) / mrx, mdy = (y - mcy) / mry, mr2 = mdx * mdx + mdy * mdy;
          let sky = 0, g = 0, cr = 0, cgc = 0, cb = 0;
          if (mry > 2 && mr2 < 1 && !broken) {
            const limb = 0.55 + 0.45 * Math.sqrt(1 - mr2);
            const mare = M.fbm(mdx * 2.1 + 7.3, mdy * 2.1 - 3.1, 3);         // dark seas
            const crat = M.hash2(Math.floor((mdx + 1) * 9), Math.floor((mdy + 1) * 6)) < 0.12 ? 0.7 : 1; // pocks
            let b = limb * (mare > 0.55 ? 0.55 : 1) * crat;
            b *= 0.85 + 0.15 * Math.sin(t * 0.7 + y * 0.6); // shimmer
            const gi = Math.min(MOON.length - 1, Math.max(1, Math.round(b * (MOON.length - 1) + (M.hash2(x, y) - 0.5) * 1.2)));
            g = MOON[gi]; sky = b; cr = 0.78 * b; cgc = 0.8 * b; cb = 0.88 * b;
            emi[o] += 0.02 * b; emi[o + 1] += 0.02 * b; emi[o + 2] += 0.025 * b;
          }
          // 3) sky: drifting clouds (in front of the moon)
          const fx = x / SX, fy = y / SY, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, g0 = iy * gw + ix;
          const ca = cg[g0] + (cg[g0 + 1] - cg[g0]) * tx, cbb = cg[g0 + gw] + (cg[g0 + gw + 1] - cg[g0 + gw]) * tx;
          let cd = (ca + (cbb - ca) * ty - 0.5) * 3.6;
          if (cd > 0 && !broken) {
            cd = Math.min(1, cd);
            if (cd > 0.25 || !g) {
              const hv = M.hash2(x * 3 + Math.floor(t * 1.5), y);
              if (hv < 0.35 + cd * 0.6) { g = CLOUD[Math.min(CLOUD.length - 1, Math.floor(cd * CLOUD.length))]; const v = 0.34 + cd * 0.36; cr = v; cgc = v * 1.03; cb = v * 1.15; sky = 1; }
            }
          }
          if (sky) { glyph[i] = g; col[o] = cr; col[o + 1] = cgc; col[o + 2] = cb; flag[i] = F_UNLIT; }
          else { const k = R.waterDim; col[o] *= k; col[o + 1] *= k; col[o + 2] *= k; } // near-black mirror water: let reflections carry it
        }
      }
    },

    snapshotGround() {
      const n = R.n;
      if (!R._gGlyph || R._gGlyph.length !== n) { R._gGlyph = new Uint8Array(n); R._gCol = new Float32Array(n * 3); R._gFlag = new Uint8Array(n); }
      R._gGlyph.set(R.glyph); R._gCol.set(R.col); R._gFlag.set(R.flag); R._hasSnap = true;
    },
    _separate() {
      const cols = R.cols, rows = R.rows, n = R.n, flag = R.flag, key = R.key, glyph = R.glyph, col = R.col;
      if (!R._figMask || R._figMask.length !== n) R._figMask = new Uint8Array(n);
      const m = R._figMask;
      let any = false;
      for (let i = 0; i < n; i++) { const f = (flag[i] & (F_FIGURE | F_PROP)) && glyph[i] ? ((flag[i] & F_FIGURE) ? 1 : 2) : 0; m[i] = f; if (f) any = true; }
      if (!any) { R._hasSnap = false; return; }
      const lift = R.figureLift, rim = R.rimK, dark = R.outlineDark, snap = R._hasSnap;
      const gG = R._gGlyph, gC = R._gCol, gF = R._gFlag;
      for (let y = 0; y < rows; y++) {
        const row = y * cols;
        for (let x = 0; x < cols; x++) {
          const i = row + x, mi = m[i];
          const l = x > 0 ? m[i - 1] : 0, r = x < cols - 1 ? m[i + 1] : 0, u = y > 0 ? m[i - cols] : 0, d = y < rows - 1 ? m[i + cols] : 0;
          if (mi) {
            const edge = !l || !r || !u || !d;
            const k = mi === 1 ? (edge ? rim : lift) : (edge ? 1.12 : 1), o = i * 3;
            col[o] *= k; col[o + 1] *= k; col[o + 2] *= k;
            continue;
          }
          const o = i * 3;
          // refill rig-written blank halo cells (within 2 cells of a figure) from the ground layer
          if (snap && glyph[i] === 0 && key[i] > -1e6 && gG[i]) {
            const near2 = l || r || u || d || (x > 1 && m[i - 2]) || (x < cols - 2 && m[i + 2]) ||
              (y > 0 && x > 0 && m[i - cols - 1]) || (y > 0 && x < cols - 1 && m[i - cols + 1]) || (y < rows - 1 && x > 0 && m[i + cols - 1]) || (y < rows - 1 && x < cols - 1 && m[i + cols + 1]);
            if (near2) { glyph[i] = gG[i]; col[o] = gC[o]; col[o + 1] = gC[o + 1]; col[o + 2] = gC[o + 2]; flag[i] = gF[i]; key[i] = R.KEY_GROUND; }
          }
          if (!R.outline || key[i] > -1e6 || !glyph[i]) continue;
          // thin soft shadow: only cells directly left/right/above/below a figure
          if (l === 1 || r === 1 || u === 1 || d === 1) { col[o] *= dark; col[o + 1] *= dark; col[o + 2] *= dark; }
          else if (l || r || u || d) { col[o] *= 0.7; col[o + 1] *= 0.7; col[o + 2] *= 0.7; }
        }
      }
      R._hasSnap = false;
    },

    // separable box blur (2 passes x2) on glow RGBA buffer
    _blurGlow() {
      const cols = R.cols, rows = R.rows, src = R.glow;
      const tmp = R._tmp; // RGB
      const rad = 2, w = 1 / (rad * 2 + 1);
      for (let pass = 0; pass < 2; pass++) {
        // horizontal: src(RGBA) -> tmp(RGB)
        for (let y = 0; y < rows; y++) {
          const row = y * cols;
          for (let x = 0; x < cols; x++) {
            let r = 0, g = 0, b = 0;
            for (let k = -rad; k <= rad; k++) { let xx = x + k; xx = xx < 0 ? 0 : xx >= cols ? cols - 1 : xx; const q = (row + xx) * 4; r += src[q]; g += src[q + 1]; b += src[q + 2]; }
            const o = (row + x) * 3; tmp[o] = r * w; tmp[o + 1] = g * w; tmp[o + 2] = b * w;
          }
        }
        // vertical: tmp -> src (cells are taller than wide, so use rad-1 vertically)
        const rv = rad - 1, wv = 1 / (rv * 2 + 1);
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            let r = 0, g = 0, b = 0;
            for (let k = -rv; k <= rv; k++) { let yy = y + k; yy = yy < 0 ? 0 : yy >= rows ? rows - 1 : yy; const o = (yy * cols + x) * 3; r += tmp[o]; g += tmp[o + 1]; b += tmp[o + 2]; }
            const q = (y * cols + x) * 4; src[q] = r * wv; src[q + 1] = g * wv; src[q + 2] = b * wv;
          }
        }
      }
    },

    // ---------------------------------------------------------------- WebGL
    _initGL() {
      const gl = R.gl;
      const vs = `#version 300 es
      in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;
      const fs = `#version 300 es
      precision highp float;
      uniform sampler2D uAtlas; uniform sampler2D uGlyph; uniform sampler2D uColor; uniform sampler2D uGlow;
      uniform vec2 uRes; uniform vec2 uCell; uniform vec2 uOffset; uniform vec2 uGrid; uniform float uAtlasCols;
      uniform vec4 uFlash; uniform float uHurt; uniform float uTime; uniform float uExposure; uniform float uVig;
      out vec4 o;
      void main(){
        vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) + uOffset;
        vec2 cf = p / uCell;
        ivec2 cell = ivec2(floor(cf));
        vec3 glow = texture(uGlow, cf / uGrid).rgb;
        vec3 col = vec3(0.0);
        if (cell.x >= 0 && cell.y >= 0 && cell.x < int(uGrid.x) && cell.y < int(uGrid.y)) {
          float gi = floor(texelFetch(uGlyph, cell, 0).r * 255.0 + 0.5);
          if (gi > 0.5) {
            vec3 fg = texelFetch(uColor, cell, 0).rgb;
            vec2 local = p - vec2(cell) * uCell;
            vec2 a = vec2(mod(gi, uAtlasCols), floor(gi / uAtlasCols)) * uCell + local;
            float m = texelFetch(uAtlas, ivec2(a), 0).a;
            col = fg * m;
          }
        }
        vec3 c = col + glow;
        c = vec3(1.0) - exp(-c * uExposure);
        vec2 uv = gl_FragCoord.xy / uRes; vec2 d = uv - 0.5;
        c *= clamp(1.0 - dot(d, d) * uVig, 0.0, 1.0);
        float edge = smoothstep(0.18, 0.78, length(d * vec2(1.0, 1.25)));
        c = mix(c, vec3(0.45, 0.0, 0.02), clamp(uHurt, 0.0, 1.0) * edge * 0.75);
        c += uFlash.rgb * uFlash.a;
        float n = fract(sin(dot(gl_FragCoord.xy + fract(uTime) * 97.0, vec2(12.9898, 78.233))) * 43758.5453);
        c += (n - 0.5) * 0.016;
        o = vec4(c, 1.0);
      }`;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      R.prog = prog; gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      R.u = {};
      for (const name of ['uAtlas', 'uGlyph', 'uColor', 'uGlow', 'uRes', 'uCell', 'uOffset', 'uGrid', 'uAtlasCols', 'uFlash', 'uHurt', 'uTime', 'uExposure', 'uVig']) R.u[name] = gl.getUniformLocation(prog, name);
      const mk = (filter) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
      R.tAtlas = mk(gl.NEAREST); R.tGlyph = mk(gl.NEAREST); R.tColor = mk(gl.NEAREST); R.tGlow = mk(gl.LINEAR);
      R._buildAtlas();
      R._texDirty = true;
    },

    _buildAtlas() {
      const gl = R.gl; if (!gl || !R.tAtlas) return;
      if (R._atlasFor === R.gw + 'x' + R.gh) return;
      R._atlasFor = R.gw + 'x' + R.gh;
      const ac = 16, ar = 16; // 256 slots: [0,128) regular, [128,256) bold
      const cv = document.createElement('canvas'); cv.width = ac * R.gw; cv.height = ar * R.gh;
      const ctx = cv.getContext('2d');
      const fam = 'Menlo, "SF Mono", Consolas, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
      for (const weight of ['', 'bold ']) {
        let fpx = R.gh * 0.98;
        ctx.font = `${weight}${fpx}px ${fam}`;
        const mw = ctx.measureText('M').width; if (mw > R.gw * 1.04) fpx *= (R.gw * 1.04) / mw;
        ctx.font = `${weight}${fpx}px ${fam}`;
        const base = weight ? BOLD : 0;
        for (let c = 1; c < CHARSET.length; c++) {
          const i = base + c;
          const x = (i % ac) * R.gw, y = Math.floor(i / ac) * R.gh;
          ctx.save(); ctx.beginPath(); ctx.rect(x, y, R.gw, R.gh); ctx.clip();
          ctx.fillText(CHARSET[c], x + R.gw / 2, y + R.gh / 2 + R.gh * 0.04);
          if (weight) ctx.fillText(CHARSET[c], x + R.gw / 2 + Math.max(0.5, R.gw * 0.06), y + R.gh / 2 + R.gh * 0.04); // extra-heavy
          ctx.restore();
        }
      }
      R.atlasCols = ac;
      gl.bindTexture(gl.TEXTURE_2D, R.tAtlas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      R.atlasCanvas = cv;
    },

    _draw() {
      const gl = R.gl;
      gl.viewport(0, 0, R.canvas.width, R.canvas.height);
      gl.useProgram(R.prog);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const realloc = R._texDirty; R._texDirty = false;
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, R.tGlyph);
      if (realloc) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, R.cols, R.rows, 0, gl.RED, gl.UNSIGNED_BYTE, R.glyph);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, R.cols, R.rows, gl.RED, gl.UNSIGNED_BYTE, R.glyph);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, R.tColor);
      if (realloc) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, R.cols, R.rows, 0, gl.RGBA, gl.FLOAT, R.out);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, R.cols, R.rows, gl.RGBA, gl.FLOAT, R.out);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, R.tGlow);
      if (realloc) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, R.cols, R.rows, 0, gl.RGBA, gl.FLOAT, R.glow);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, R.cols, R.rows, gl.RGBA, gl.FLOAT, R.glow);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.tAtlas);
      const u = R.u;
      gl.uniform1i(u.uAtlas, 0); gl.uniform1i(u.uGlyph, 1); gl.uniform1i(u.uColor, 2); gl.uniform1i(u.uGlow, 3);
      gl.uniform2f(u.uRes, R.canvas.width, R.canvas.height);
      gl.uniform2f(u.uCell, R.gw, R.gh);
      const offX = (R.originPx - R.ci0 * CW) * R.zoomX * R.dpr, offY = (R.originPy - R.cj0 * CH) * R.zoomY * R.dpr;
      gl.uniform2f(u.uOffset, offX, offY);
      gl.uniform2f(u.uGrid, R.cols, R.rows);
      gl.uniform1f(u.uAtlasCols, R.atlasCols);
      gl.uniform4f(u.uFlash, R.flashC[0], R.flashC[1], R.flashC[2], R.flashC[3]);
      gl.uniform1f(u.uHurt, R.hurt);
      gl.uniform1f(u.uTime, R.time);
      gl.uniform1f(u.uExposure, R.exposure);
      gl.uniform1f(u.uVig, R.vignette);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
  });

  // Light direction for shading (x right, y down-screen, z toward viewer) — moon at top-right
  const L = (() => { const v = [0.5, -0.6, 0.62]; const l = Math.hypot(...v); return v.map((a) => a / l); })();
  R.L = L;
  // vertical-flip glyph map for reflections, and ramps for the moon / clouds
  const MIRROR = new Uint8Array(128); for (let i = 0; i < 128; i++) MIRROR[i] = i;
  for (const [a, b] of [['/', '\\'], ['^', 'v'], ["'", ','], ['`', ','], ['M', 'W'], ['A', 'V'], ['u', 'n'], ['b', 'p'], ['d', 'q'], ['"', ','], ['_', '-'], ['Y', 'v'], ['m', 'w'], ['T', '|'], ['7', 'L'], ['J', 'r'], ['!', 'i']]) {
    const ia = LUT[a.charCodeAt(0)], ib = LUT[b.charCodeAt(0)]; MIRROR[ia] = ib; if (b !== '-' && b !== '|' && a !== '!') MIRROR[ib] = ia;
  }
  const MOON = (() => { const r = new Uint8Array(10); ' .:-=+*#%@'.split('').forEach((c, i) => (r[i] = LUT[c.charCodeAt(0)])); return r; })();
  const CLOUD = (() => { const r = new Uint8Array(6); '.,:;~='.split('').forEach((c, i) => (r[i] = LUT[c.charCodeAt(0)])); return r; })();
  const DIR_H = LUT['-'.charCodeAt(0)], DIR_V = LUT['|'.charCodeAt(0)], DIR_BS = LUT['\\'.charCodeAt(0)], DIR_FS = LUT['/'.charCodeAt(0)];

  // Standard glyph ramps (dark -> bright)
  R.RAMPS = {
    solid: R.ramp(" .,:;=+*#%@"),
    soft: R.ramp(" .,:;ox%#"),
    dense: R.ramp(" .:-=+*#%@"),
    stone: R.ramp(" .,:;+=oO0Q8$@#WM"),
    bone: R.ramp(" .:;+=xX$&#"),
    cloth: R.ramp(" .,:;ox%&#"),
    metal: R.ramp(" .:-=+*#%@"),
    flesh: R.ramp(" .,:;=oO0@"),
    hair: R.ramp(" .'\"`;|/\\("),
    fire: R.ramp(" .'`^\"*+#@"),
    ice: R.ramp(" .'`:+*#%@"),
    candy: R.ramp(" .,:o*%@&8"),
    shadow: R.ramp(" .:;=%#"),
  };
})();
