// world.js — floors: generation for the five realms, boss arenas and the title scene; baked terrain rendering;
// props / set-pieces; interactables; static lights; weather overlays; collision (resolve / isSolid / los) and a
// coarse nav grid (reachability, corridor carving, flow-field steering).
//
// Perf: per-cell hashes/noise (F.h1/F.h2/F.n1) are precomputed, and all static terrain is baked at generation into
// F.cls (render class) / F.g (glyph) / F.c (rgb) / F.e (emissive), so the per-frame loop is mostly array copies.
// Only grass (wind), water/lava, cracks, sparkles, pools and void cells animate. Wind waves are separable, fog density
// lives on a coarse grid, weather particles are stateless (hash + time) and world-anchored, lights are culled to view.
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M, R = HM.R;
  const { CW, CH, TILT } = HM.cfg;
  const RW = CH / TILT; // world-y units per cell row

  // terrain types (GRASS = the realm's base ground: grass / sugar crust / snow / obsidian / bone field)
  const T = { VOID: 0, GRASS: 1, STONE: 2, WATER: 3, DEEP: 4, THICKET: 5, DIRT: 6, POOL: 7, CRACK: 8, CHASM: 9 };
  // baked render classes
  const C_SKIP = 0, C_GRASS = 1, C_STATIC = 2, C_WATER = 3, C_CRACK = 4, C_SPARK = 5, C_VOID = 6, C_POOL = 7, C_LAVA = 8;
  // solid bits: walls block walking, shots and sight; liquids (water, lava, void) block walking only
  const S_WALL = 1, S_LIQ = 2, S_ALL = 3;
  const isLiquidT = (t) => t === T.WATER || t === T.DEEP || t === T.CHASM;
  // props & interactables carry F_PROP (renderer outlines them against the terrain); capsules/balls opt out of F_FIGURE
  const FP = R.F_PROP || 0, NF = { notFigure: true }, NFB = { notFigure: true, amb: 0.3, dither: 0.5 };

  const G = (s) => R.ramp(s);
  const gi = (c) => R.gi(c);
  const GL = {
    bladeL: G('\\\\(\\'), bladeC: G('|!|l|i'), bladeR: G('//)/'),
    short: G(",.'`;\"'"), fleck: G(".o°'*·"),
    stone: G('0OQ@$8BWM#&%dbpqwmnzaoQ0O8'), stoneDim: G('.,:;-=+o'),
    water: G("~-=~'.-~"), foam: G('~=-~^'),
    thicket: G('#%&@$WM8B'), fog: G(".:'-~°.·"),
    mono: G('$&@WM#Q8B%0O&8$@'), monoFace: G('$&@WM#Q8B%0Odbqpu=#(a&Q$%8wM'),
    asphalt: G(".,_:.-,'._"), sugar: G(".,':.,`'.:"), crust: G("*o%*+o*:"), rotStain: G(";,.~:"), sprinkle: G("-'`,~"),
    cobble: G('oO0@8B&%#Qdbpq'), rot: G('~-=~°.~-'), ginger: G('#%&@8B=H#'), icing: G('~^~-~'),
    snow: G(".'.,.`.'."), drift: G('~-~=~'), iceSheet: G('-=_~-=_-'), cliff: G('#%@M8&WQ'), rock: G('0OQ@8B%&'),
    obsid: G('#%:.`;%#'), obsidDust: G(".:,'.;"), lava: G('~=-^~'), basalt: G('|#H8|IB#'), basaltTop: G('_-=o'), ash: G(".,'`"),
    soil: G('.,:`'), bone: G("=-~'\"=)("), skull: G('0o@O'), obsidW: G('#%&8B'),
    fire: G("'`^\"*+#@"), ember: G(".'*+`"), cane: G('@%&#8O0'), iceFill: G('|:|!|\'|'), snowFall: G(".'*·,"),
    motes: G('.°·o'), runes: G('§¤×÷%&$#'),
    // ---- sparse / light ground families (DESIGN §4b, §10): terrain never uses the dense glyphs figures are built from
    textLt: G('aeocsnuvxzrmwi:;-=aeosnu'), // slate "text" patches: light lowercase letters + strokes
    trail: G(".,'`:-~.,"), bramble: G('|/\\()!lI|\\/|'), brambleTop: G("',`.;\"'"),
    crustLt: G("-_~^'`-."), dust: G(".,'`:."), dotsLt: G(".,'`·"),
    rockLt: G(':;-=/\\^~'), obsSheen: G("-_/'`.,-"), seam: G('_-/\\'), wellStone: G('-_=:;.~'),
    icicle: G('|!|:|'), shardLt: G('/\\^|/\\'), brick: G('_|_=_'),
    canopy: G('%&8@o%&(){}'), canopyEdge: G("()'`,;{}"),
  };
  // 4x4 ordered-dither (Bayer) thresholds. Terrain tone is shown by dot DENSITY with this world-anchored pattern
  // (indexed by world cell), so it is surface-stable and reads as clean light/shadow instead of random noise.
  const BAYER = new Float32Array([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16));
  const bay = (i, j) => BAYER[((j & 3) << 2) | (i & 3)];
  const RAMP_BARK = G(' .:;|!I#H'), RAMP_DOME = G(' .,:o*%@&8'), RAMP_SKULL = G(' .:oO0@'), RAMP_BONE = G(' .:-=+xX#');
  const G_SP = 0, G_DOT = gi('.'), G_PIPE = gi('|'), G_FS = gi('/'), G_BS = gi('\\'), G_CARET = gi('^'), G_COLON = gi(':'), G_BANG = gi('!'),
    G_DASH = gi('-'), G_EQ = gi('='), G_UND = gi('_'), G_O = gi('O'), G_o = gi('o'), G_AT = gi('@'), G_STAR = gi('*'), G_TILDE = gi('~'),
    G_DEG = gi('°'), G_HASH = gi('#'), G_COMMA = gi(','), G_APOS = gi("'"), G_BTICK = gi('`'), G_PLUS = gi('+'), G_MDOT = gi('·'),
    G_LPAR = gi('('), G_RPAR = gi(')'), G_SEMI = gi(';'), G_V = gi('V'), G_v = gi('v'), G_LBR = gi('['), G_RBR = gi(']');
  // water surface dot glyphs (fine, light): picked per cell by a baked hash so the texture has varied dot positions
  const WDOT = new Uint8Array([G_DOT, G_MDOT, G_DOT, G_APOS, G_COMMA, G_MDOT, G_BTICK, G_DOT]);

  // ------------------------------------------------------------------ realms
  const BIOMES = {
    grass: {
      id: 'grass', name: 'The Grasslands', ambient: [0.92, 1.0, 1.05],
      grassLo: [0.09, 0.25, 0.12], grassHi: [0.34, 0.62, 0.32], fleck: [0.86, 0.9, 0.96],
      stone: [0.56, 0.62, 0.80], water: [0.14, 0.22, 0.46], foam: [0.75, 0.85, 1.0], thicket: [0.07, 0.17, 0.10],
      mono: [0.62, 0.66, 0.84], road: [0.25, 0.26, 0.3], lane: [0.6, 0.55, 0.3], bark: [0.36, 0.32, 0.29],
      fog: [0.62, 0.66, 0.72], fogAmount: 0.45, fogDrift: [0.09, -0.03], weather: 'fireflies',
      edgeWall: T.THICKET, edgeLiq: T.WATER, portal: [0.55, 0.9, 1.0], shrine: [1.0, 0.85, 0.55], shrineName: 'Shrine of Glob',
    },
    candy: {
      id: 'candy', name: 'The Candy Necropolis', ambient: [1.04, 0.9, 0.98],
      groundLo: [0.3, 0.12, 0.16], groundHi: [0.8, 0.44, 0.52], fleck: [0.92, 0.85, 0.9],
      sprinkles: [[0.95, 0.72, 0.85], [0.66, 0.86, 0.95], [0.95, 0.88, 0.55], [0.7, 0.95, 0.72]],
      stone: [0.78, 0.62, 0.7], pool: [0.34, 0.06, 0.2], poolHi: [0.85, 0.4, 0.62], thicket: [0.42, 0.22, 0.1],
      icing: [0.92, 0.84, 0.88], mono: [0.72, 0.56, 0.62], bark: [0.32, 0.2, 0.16],
      fog: [0.95, 0.62, 0.78], fogAmount: 0.46, fogDrift: [0.06, -0.02], fogTint: 0.75, fogGlyph: 0.25, fogEmit: 0.06, weather: 'sugar',
      edgeWall: T.THICKET, edgeLiq: T.THICKET, portal: [1.0, 0.55, 0.8], shrine: [1.0, 0.6, 0.8], shrineName: 'Sugar Altar',
    },
    ice: {
      id: 'ice', name: 'The Ice Kingdom', ambient: [0.88, 0.98, 1.15],
      snowLo: [0.4, 0.47, 0.62], snowHi: [0.8, 0.88, 1.02], fleck: [1.0, 1.04, 1.12],
      stone: [0.34, 0.42, 0.58], ice: [0.2, 0.44, 0.64], iceHi: [0.72, 0.92, 1.05], water: [0.04, 0.09, 0.2], foam: [0.78, 0.88, 1.0],
      thicket: [0.46, 0.56, 0.72], mono: [0.58, 0.72, 0.92], bark: [0.48, 0.56, 0.68],
      fog: [0.86, 0.92, 1.0], fogAmount: 0.62, fogDrift: [-0.32, 0.1], fogTint: 0.95, fogGlyph: 0.16, fogEmit: 0.075, weather: 'blizzard',
      edgeWall: T.THICKET, edgeLiq: T.WATER, portal: [0.6, 0.9, 1.1], shrine: [0.6, 0.9, 1.1], shrineName: 'Frost Cairn',
    },
    fire: {
      id: 'fire', name: 'The Fire Kingdom', ambient: [0.95, 0.8, 0.8],
      groundLo: [0.05, 0.04, 0.06], groundHi: [0.2, 0.15, 0.25], sheen: [0.42, 0.28, 0.64],
      crack: [1.25, 0.45, 0.08], lava: [1.5, 0.55, 0.08], crust: [0.2, 0.07, 0.03],
      stone: [0.2, 0.19, 0.21], thicket: [0.16, 0.14, 0.15], basalt: [0.24, 0.22, 0.24], mono: [0.32, 0.28, 0.32], bark: [0.11, 0.09, 0.09],
      fog: [0.45, 0.28, 0.24], fogAmount: 0.3, fogDrift: [0.05, -0.08], fogGlyph: 0.2, weather: 'ash',
      edgeWall: T.THICKET, edgeLiq: T.WATER, portal: [1.2, 0.6, 0.25], shrine: [1.2, 0.6, 0.2], shrineName: 'Ember Idol',
    },
    well: {
      id: 'well', name: "The Lich's Well", ambient: [0.8, 0.96, 0.86],
      soilLo: [0.07, 0.09, 0.08], soilHi: [0.2, 0.23, 0.2], bone: [0.66, 0.64, 0.55], stone: [0.12, 0.12, 0.16],
      crack: [0.3, 1.0, 0.42], witch: [0.35, 1.2, 0.5], thicket: [0.42, 0.41, 0.36], mono: [0.24, 0.24, 0.3], bark: [0.3, 0.3, 0.28],
      fog: [0.42, 0.66, 0.48], fogAmount: 0.38, fogDrift: [0.04, -0.05], fogTint: 0.7, fogGlyph: 0.3, fogEmit: 0.05, weather: 'motes',
      edgeWall: T.CHASM, edgeLiq: T.CHASM, portal: [0.4, 1.1, 0.55], shrine: [0.45, 1.1, 0.55], shrineName: 'Bone Altar',
    },
  };
  for (const id in BIOMES) BIOMES[id].toString = function () { return this.id; }; // so String(floor.biome) === id

  const TMP = [0, 0, 0];
  const lerp3 = (out, a, b, t) => { out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t; return out; };
  const cellK = (F, x, y) => { const i = Math.floor(x / CW), j = Math.floor(y / RW); return i < 0 || j < 0 || i >= F.cols || j >= F.rows ? -1 : j * F.cols + i; };
  const SHX = -1.0, SHY = 0.69; // ground offset of a shadow per unit of caster height (moon top-right)

  // circle samples for collision: 48 directions; bodies use a stride so perimeter spacing stays under ~4.5 units
  // (a cell is 5 wide), so even thin props (sign posts, trunks) can't slip between two rays
  const SC = new Float32Array(48), SS = new Float32Array(48);
  for (let a = 0; a < 48; a++) { SC[a] = Math.cos((a / 48) * Math.PI * 2); SS[a] = Math.sin((a / 48) * Math.PI * 2); }
  const rayStride = (r) => (r < 9 ? 3 : r < 17 ? 2 : 1);

  // ================================================================== props: constructors
  const P = {
    monolith(rng, x, y, o) {
      o = o || {};
      const fallen = o.fallen !== undefined ? o.fallen : rng.chance(0.22);
      const big = o.big ? 1.25 : 1;
      const p = { kind: 'monolith', x, y, w: fallen ? rng.range(70, 120) : rng.range(26, 44) * big, d: fallen ? rng.range(22, 34) : rng.range(18, 30), h: fallen ? rng.range(18, 30) : rng.range(80, 150) * big, broken: rng.chance(0.5), seed: rng.int(0, 1e6) };
      p.rad = Math.max(p.w, p.d) / 2; return p;
    },
    tree(rng, x, y, style) {
      const H = rng.range(70, 128), lean = rng.range(-0.14, 0.14), segs = [];
      const add = (a, b, c, d, e, f, th) => segs.push(a, b, c, d, e, f, th);
      const kx = lean * H * 0.5 + rng.range(-3, 3), tx = lean * H + rng.range(-5, 5);
      add(0, 0, 0, kx, 0, H * 0.5, 4.4); add(kx, 0, H * 0.5, tx, 0, H * 0.84, 3.0); add(tx, 0, H * 0.84, tx + rng.range(-7, 7), 0, H, 1.3);
      const nb = rng.int(3, 6);
      for (let b = 0; b < nb; b++) {
        const f = rng.range(0.38, 0.92), side = b % 2 ? 1 : -1;
        const bx = f < 0.5 ? kx * (f / 0.5) : kx + (tx - kx) * Math.min(1, (f - 0.5) / 0.34), bz = H * f;
        const ang = rng.range(0.2, 1.05), L = rng.range(20, 44) * (1.15 - f * 0.55);
        const ex = bx + side * Math.cos(ang) * L, ez = bz + Math.sin(ang) * L, ey = rng.range(-8, 8);
        add(bx, 0, bz, ex, ey, ez, f < 0.6 ? 1.9 : 1.3);
        for (let q = rng.int(1, 3); q > 0; q--) { const ta = ang + rng.range(-0.8, 0.9), tl = rng.range(6, 15); add(ex, ey, ez, ex + side * Math.cos(ta) * tl, ey + rng.range(-3, 3), ez + Math.sin(ta) * tl, 0.8); }
      }
      return { kind: 'tree', x, y, w: 10, d: 8, h: H, rad: 9, fr: 5, foot: 'circle', segs: new Float32Array(segs), style: style || 'dead', seed: rng.int(0, 1e6) };
    },
    grave(rng, x, y) {
      return { kind: 'grave', x, y, w: rng.range(11, 16), d: 6, h: rng.range(14, 24), variant: rng.int(0, 3), tilt: rng.pick([-1, 0, 0, 0, 1]), candle: rng.chance(0.22), seed: rng.int(0, 1e6), rad: 9 };
    },
    car(rng, x, y) {
      const paint = rng.pick([[0.22, 0.36, 0.38], [0.42, 0.14, 0.12], [0.36, 0.34, 0.2], [0.3, 0.3, 0.34]]);
      return { kind: 'car', x, y, w: rng.range(58, 70), d: rng.range(26, 32), h: 15, cabW: rng.range(28, 36), cabDx: rng.range(-6, 4), cabH: 13, paint, seed: rng.int(0, 1e6), rad: 36 };
    },
    sign(rng, x, y) {
      const text = rng.pick(['EXIT 13', 'OOO 1', 'HWY 9', 'SLOW', 'NO EXIT', 'MERGE', 'REST AREA', 'DETOUR', 'END']);
      return { kind: 'sign', x, y, w: 6, d: 5, h: 46, text, bent: rng.int(-1, 1), holes: rng.int(0, 3), seed: rng.int(0, 1e6), rad: 10, fr: 3, foot: 'circle' };
    },
    gumdrop(rng, x, y) {
      const col = rng.pick([[0.62, 0.12, 0.16], [0.52, 0.2, 0.42], [0.36, 0.48, 0.18], [0.66, 0.36, 0.14], [0.5, 0.42, 0.52]]);
      const rx = rng.range(16, 30);
      return { kind: 'gumdrop', x, y, rx, ry: rx * rng.range(0.6, 0.75), h: rx * rng.range(1.0, 1.35), w: rx * 2, d: rx * 1.4, col, cracked: rng.chance(0.4), seed: rng.int(0, 1e6), rad: rx, foot: 'ellipse' };
    },
    cane(rng, x, y) {
      const broken = rng.chance(0.4);
      return { kind: 'cane', x, y, w: rng.range(20, 28), d: rng.range(14, 18), h: rng.range(80, 140), broken, hook: !broken && rng.chance(0.65), dir: rng.sign(), seed: rng.int(0, 1e6), rad: 16 };
    },
    ginger(rng, x, y) {
      return { kind: 'ginger', x, y, w: rng.range(70, 150), d: 14, h: rng.range(26, 46), seed: rng.int(0, 1e6), rad: 40 };
    },
    lamp(rng, x, y) {
      const r = rng.next();
      return { kind: 'lamp', x, y, w: 5, d: 5, h: 46, state: r < 0.22 ? 0 : r < 0.42 ? 2 : 1, seed: rng.int(0, 1e6), rad: 10, fr: 3, foot: 'circle' };
    },
    spire(rng, x, y, o) {
      o = o || {};
      const n = o.n || rng.int(2, 5), shards = [], scale = o.scale || 1;
      for (let s = 0; s < n; s++) shards.push({ dx: s ? rng.range(-26, 26) : 0, dy: s ? rng.range(-10, 10) : 0, w: rng.range(18, 32) * scale, h: (s ? rng.range(40, 95) : rng.range(90, 160)) * scale, lean: rng.range(-0.16, 0.16) });
      shards.sort((a, b) => a.dy - b.dy);
      return { kind: o.kind || 'spire', x, y, w: 50 * scale, d: 26, h: 150 * scale, shards, seed: rng.int(0, 1e6), rad: 26 * scale, glow: rng.chance(0.35) };
    },
    boulder(rng, x, y) { return { kind: 'boulder', x, y, w: rng.range(18, 34), d: rng.range(14, 22), h: rng.range(10, 20), seed: rng.int(0, 1e6), rad: 16 }; },
    penguin(rng, x, y) { return { kind: 'penguin', x, y, w: 22, d: 14, h: 26, seed: rng.int(0, 1e6), rad: 12 }; },
    basalt(rng, x, y) {
      const n = rng.int(3, 7), cols = [];
      for (let s = 0; s < n; s++) cols.push({ dx: rng.range(-28, 28), dy: rng.range(-12, 12), w: rng.range(13, 20), d: rng.range(10, 14), h: rng.range(24, 105) });
      cols.sort((a, b) => a.dy - b.dy);
      return { kind: 'basalt', x, y, w: 76, d: 38, h: 105, cols, seed: rng.int(0, 1e6), rad: 38 };
    },
    brazier(rng, x, y, fire) { return { kind: 'brazier', x, y, w: 18, d: 12, h: 18, fire: fire || 'green', seed: rng.int(0, 1e6), rad: 14 }; },
    ribs(rng, x, y) {
      const len = rng.range(130, 190);
      return { kind: 'ribs', x, y, w: len, d: rng.range(44, 60), h: rng.range(48, 66), n: Math.round(len / 24), dir: rng.sign(), seed: rng.int(0, 1e6), rad: len / 2, foot: 'none' };
    },
    obelisk(rng, x, y) { return { kind: 'obelisk', x, y, w: rng.range(18, 24), d: rng.range(14, 18), h: rng.range(70, 115), seed: rng.int(0, 1e6), rad: 14 }; },
    skulls(rng, x, y) { const rx = rng.range(10, 18); return { kind: 'skulls', x, y, rx, ry: rx * 0.65, h: rx * 0.9, w: rx * 2, d: rx * 1.3, seed: rng.int(0, 1e6), rad: rx, foot: 'ellipse' }; },
    campfire(rng, x, y) { return { kind: 'campfire', x, y, w: 26, d: 16, h: 0, seed: rng.int(0, 1e6), rad: 18, fr: 9, foot: 'circle' }; },
    well(x, y) { return { kind: 'well', x, y, rx: 135, ry: 78, h: 30, w: 290, d: 170, seed: 7, rad: 140, foot: 'well' }; },
    stall(x, y) { return { kind: 'stall', x, y, w: 66, d: 12, h: 40, seed: 3, rad: 34, foot: 'box', noShadow: true }; },
    gate(x, y, seed) { return { kind: 'gate', x, y, w: 130, d: 14, h: 96, pw: 20, gap: 112, seed, rad: 20, foot: 'gate' }; },
    // ---- prologue set-pieces
    treefort(rng, x, y) {
      // the ruined Tree Fort: a colossal dead trunk, a plank deck and a broken house in the crown, dead limbs above
      const segs = [], add = (a, b, c, d, e, f, th) => segs.push(a, b, c, d, e, f, th);
      for (let b = 0; b < 7; b++) {
        const side = b % 2 ? 1 : -1, z0 = rng.range(205, 250), ang = rng.range(0.25, 1.0), L = rng.range(55, 105);
        const ex = side * Math.cos(ang) * L + 8, ez = z0 + Math.sin(ang) * L, ey = rng.range(-10, 10);
        add(8, 0, z0, ex, ey, ez, 1.9);
        for (let q = rng.int(1, 3); q > 0; q--) { const ta = ang + rng.range(-0.8, 0.9), tl = rng.range(10, 22); add(ex, ey, ez, ex + side * Math.cos(ta) * tl, ey + rng.range(-3, 3), ez + Math.sin(ta) * tl, 0.8); }
      }
      return { kind: 'treefort', x, y, w: 64, d: 44, h: 300, rad: 36, fr: 29, foot: 'circle', segs: new Float32Array(segs), seed: rng.int(0, 1e6) };
    },
    lantern(rng, x, y, side) { return { kind: 'lantern', x, y, w: 5, d: 5, h: 40, side: side || 1, lit: true, seed: rng.int(0, 1e6), rad: 9, fr: 3, foot: 'circle' }; },
    barricade(x, y, w) { return { kind: 'barricade', x, y, w: w || 120, d: 22, h: 46, open: false, seed: 41, rad: (w || 120) / 2, foot: 'barricade', noShadow: true }; },
    pedestal(x, y) { return { kind: 'pedestal', x, y, w: 30, d: 14, h: 34, seed: 17, rad: 16 }; },
    trapplate(x, y) { return { kind: 'trapplate', x, y, w: 34, d: 18, h: 0, seed: 23, rad: 14, foot: 'none', noShadow: true, fired: false }; },
    bmo(x, y) { return { kind: 'bmo', x, y, w: 26, d: 12, h: 30, seed: 5, rad: 12, fr: 7, foot: 'circle' }; },
  };

  // ================================================================== drawing primitives
  // Prism with a bright top face and a front face shaded downward; right side catches the moon. `round` shades as a
  // cylinder. colFn(out, face, u, v, hs, ci, cj, base) → glyph (0 = default, -1 = skip), writes rgb to out.
  function drawBox(x, y, z0, w, d, h, gl, topC, frontC, seed, jag, key, colFn, flags, round) {
    const x0 = x - w / 2, x1 = x + w / 2;
    const front = (y + d / 2) * TILT - z0, back = (y - d / 2) * TILT - z0;
    const ci0 = Math.floor(x0 / CW), ci1 = Math.floor((x1 - 0.01) / CW);
    const span = Math.max(1, ci1 - ci0), gn = gl.length;
    const bc0 = R.ci0, bc1 = R.ci0 + R.cols;
    for (let ci = Math.max(ci0, bc0); ci <= ci1 && ci < bc1; ci++) {
      const u = (ci - ci0) / span;
      const hh = jag ? h * (1 - jag + jag * M.noise2(ci * 0.55 + (seed % 97), 0.5 + (seed % 13))) : h;
      const topF = front - hh, topB = back - hh;
      const cjTop = Math.floor(topB / CH), cjMid = Math.floor(topF / CH), cjBot = Math.floor((front - 0.01) / CH);
      let side = round ? 0.32 + 0.78 * Math.max(0, 1 - Math.abs(u - 0.66) * 1.6) : 0.75 + 0.5 * u;
      if (ci === ci0 && span > 1) side *= 0.7;
      for (let cj = cjTop; cj <= cjBot; cj++) {
        const i = R.idx(ci, cj); if (i < 0) continue;
        const hs = M.hash2(ci * 3 + seed, cj * 5);
        let face, v;
        if (cj <= cjMid && cjMid < cjBot) { face = 0; v = 0.95 - (cj - cjTop) * 0.05 + hs * 0.15 + (cj === cjTop ? 0.1 : 0); if (round) v *= 0.75 + 0.35 * side; }
        else { face = 1; const dv = (cj - cjMid) / Math.max(1, cjBot - cjMid); v = (0.62 - dv * 0.32) * side + hs * 0.12; }
        const base = face ? frontC : topC;
        let g = 0;
        if (colFn) { g = colFn(TMP, face, u, v, hs, ci, cj, base); if (g < 0) continue; }
        else { TMP[0] = base[0] * v; TMP[1] = base[1] * v; TMP[2] = base[2] * v; }
        if (!g) g = gl[(hs * 997) % gn | 0];
        R.setI(i, g, TMP[0], TMP[1], TMP[2], key, (flags || 0) | FP);
      }
    }
  }

  // Tapered crystal / shard (row scan from the base up): / \ edges, ^ tip, dark left face, lit right face, bright ridge.
  function drawSpire(x, y, w, h, lean, dark, lit, key, seed, emis, fill) {
    const base = y * TILT;
    const cjB = Math.floor((base - 0.01) / CH), cjT = Math.floor((base - h) / CH);
    const fl = fill || GL.iceFill;
    for (let cj = cjB; cj >= cjT; cj--) {
      const z = Math.max(0, base - (cj + 0.5) * CH), f = Math.min(1, z / h);
      const half = (w / 2) * Math.pow(1 - f, 0.85), cx = x + lean * z;
      if (half < 0.6 && f > 0.98) break;
      const ciL = Math.floor((cx - half) / CW), ciR = Math.floor((cx + half) / CW);
      for (let ci = ciL; ci <= ciR; ci++) {
        const i = R.idx(ci, cj); if (i < 0) continue;
        const u = ciR > ciL ? (ci - ciL) / (ciR - ciL) : 0.5;
        const hs = M.hash2(ci * 7 + seed, cj * 3);
        let g;
        if (ciL === ciR) g = f > 0.72 ? G_CARET : G_PIPE;
        else if (ci === ciL) g = G_FS; else if (ci === ciR) g = G_BS;
        else g = fl === GL.iceFill ? (u < 0.4 ? (hs < 0.5 ? G_HASH : G_FS) : u > 0.7 ? (hs < 0.6 ? G_PIPE : G_BANG) : gi('I')) : fl[(hs * 97) % fl.length | 0];
        if (hs < 0.06 && ciR - ciL > 1) g = G_DASH; // fracture
        const ridge = Math.abs(u - 0.58) < 0.17;
        let k = u < 0.5 ? 0.18 + u * 0.7 : 0.62 + (u - 0.5) * 0.7;
        if (ridge) k = 1.0;
        k = M.clamp(k + (hs - 0.5) * 0.18 + f * 0.1, 0, 1.15);
        R.setI(i, g, dark[0] + (lit[0] - dark[0]) * k, dark[1] + (lit[1] - dark[1]) * k, dark[2] + (lit[2] - dark[2]) * k, key, FP);
        if (emis && ridge) R.emitI(i, lit[0] * emis, lit[1] * emis, lit[2] * emis);
      }
    }
  }

  // Shaded dome (gumdrop tombs, skull piles): projected half-ellipsoid shaded by the moon direction.
  function drawDome(x, y, rx, ry, h, ramp, col, key, seed, fx) {
    const cx = x, cy = y * TILT - h * 0.42, ex = rx, ey = h * 0.62 + ry * TILT * 0.45;
    const cut = (y + ry * 0.55) * TILT;
    const L = R.L, rl = ramp.length - 1;
    const ci0 = Math.floor((cx - ex) / CW), ci1 = Math.floor((cx + ex) / CW), cj0 = Math.floor((cy - ey) / CH), cj1 = Math.floor(Math.min(cy + ey, cut) / CH);
    for (let cj = cj0; cj <= cj1; cj++) {
      const ny = ((cj + 0.5) * CH - cy) / ey;
      for (let ci = ci0; ci <= ci1; ci++) {
        const nx = ((ci + 0.5) * CW - cx) / ex, d2 = nx * nx + ny * ny; if (d2 > 1) continue;
        const i = R.idx(ci, cj); if (i < 0) continue;
        const nz = Math.sqrt(1 - d2);
        let sh = nx * L[0] + ny * L[1] + nz * L[2]; sh = 0.16 + 0.84 * (sh < 0 ? 0 : sh);
        const hv = M.hash2(ci * 7 + seed, cj * 13);
        let g = ramp[M.clamp(Math.round(sh * rl + (hv - 0.5) * 0.7), 1, rl)];
        const c = 0.28 + 0.9 * sh;
        TMP[0] = col[0] * c; TMP[1] = col[1] * c; TMP[2] = col[2] * c;
        if (fx) { const o = fx(TMP, nx, ny, sh, hv, ci, cj); if (o < 0) continue; if (o) g = o; }
        R.setI(i, g, TMP[0], TMP[1], TMP[2], key, FP);
      }
    }
  }

  // Animated flame column (campfire / braziers / shrine fires). pal: [core, mid, tip]. Returns nothing; emissive.
  function drawFlame(px, py, width, rows, pal, key, t, seed, emitK) {
    const cj0 = Math.floor(py / CH), fr = Math.floor(t * 14);
    for (let r = 0; r < rows; r++) {
      const f = r / rows, half = (width / 2) * (1 - f * 0.75) + (r === 0 ? 1 : 0);
      const sway = Math.sin(t * 6 + r * 1.3 + seed) * f * 3;
      const ci0 = Math.floor((px - half + sway) / CW), ci1 = Math.floor((px + half + sway) / CW);
      for (let ci = ci0; ci <= ci1; ci++) {
        const hv = M.hash3(ci, cj0 - r, fr + seed);
        if (hv < f * 0.55) continue;
        const u = ci1 > ci0 ? Math.abs((ci - ci0) / (ci1 - ci0) - 0.5) * 2 : 0;
        const heat = (1 - f) * (1 - u * 0.6);
        const c = heat > 0.62 ? pal[0] : heat > 0.32 ? pal[1] : pal[2];
        const g = GL.fire[M.clamp(Math.floor(heat * 7 + hv * 1.5), 0, 7)];
        const i = R.idx(ci, cj0 - r);
        if (R.setI(i, g, c[0], c[1], c[2], key, R.F_UNLIT)) R.emitI(i, c[0] * emitK, c[1] * emitK, c[2] * emitK);
      }
    }
  }

  // Sprite with a per-char color callback writing into TMP (returns false to skip the char).
  function drawLines(px, py, lines, colFn, key, flags) {
    const h = lines.length; let w = 0; for (const l of lines) w = Math.max(w, l.length);
    const ci0 = Math.floor(px / CW - w / 2), cj0 = Math.floor(py / CH) - h + 1;
    for (let y = 0; y < h; y++) {
      const l = lines[y];
      for (let x = 0; x < l.length; x++) {
        const ch = l[x]; if (ch === ' ') continue;
        const i = R.idx(ci0 + x, cj0 + y); if (i < 0) continue;
        TMP.e = 0;
        if (colFn(TMP, ch, x, y, w, h) === false) continue;
        if (R.setI(i, R.gi(ch), TMP[0], TMP[1], TMP[2], key, (flags || 0) | FP) && TMP.e) R.emitI(i, TMP[0] * TMP.e, TMP[1] * TMP.e, TMP[2] * TMP.e);
      }
    }
    TMP.e = 0;
  }

  // ================================================================== props: drawing
  const DRAW = {
    monolith(p, B) {
      drawBox(p.x, p.y, 0, p.w, p.d, p.h, GL.monoFace, B.mono, B.mono, p.seed, p.broken ? 0.3 : 0, p.y + p.d / 2, null, 0, false);
    },
    tree(p, B, t) {
      const s = p.segs, key = p.y + 3;
      const c = p.style === 'frozen' ? [0.5, 0.6, 0.74] : p.style === 'charred' ? [0.12, 0.1, 0.1] : p.style === 'candy' ? [0.34, 0.2, 0.16] : B.bark || [0.35, 0.31, 0.28];
      for (let q = 0; q < s.length; q += 7) {
        const ax = p.x + s[q], ay = (p.y + s[q + 1]) * TILT - s[q + 2], bx = p.x + s[q + 3], by = (p.y + s[q + 4]) * TILT - s[q + 5], th = s[q + 6];
        if (th >= 2.5) R.capsule(ax, ay, bx, by, th, th * 0.72, key, key, RAMP_BARK, c[0], c[1], c[2], FP, NFB);
        else {
          const v = th > 1.5 ? 0.9 : th > 1 ? 0.75 : 0.6;
          R.seg(ax, ay, bx, by, null, c[0] * v, c[1] * v, c[2] * v, key + s[q + 4] * 0.01, FP);
          if (th < 1) {
            const fr = p.style === 'frozen' ? [0.85, 0.95, 1.05] : null;
            R.set(bx, by, fr ? G_STAR : (s[q + 5] > s[q + 2] ? G_APOS : G_COMMA), fr ? fr[0] : c[0] * 0.8, fr ? fr[1] : c[1] * 0.8, fr ? fr[2] : c[2] * 0.8, key, FP);
          }
        }
      }
      if (p.style === 'charred') { // ember glints smouldering in the bark
        for (let e = 0; e < 3; e++) {
          const f = 0.15 + e * 0.22, fl = Math.sin(t * (2.3 + e) + p.seed + e * 2);
          if (fl < 0.2) continue;
          R.glowGlyph(p.x + s[3] * f + (e - 1) * 2, p.y * TILT - p.h * f * 0.84, G_DOT, 1.3 * fl, 0.45 * fl, 0.1 * fl, key + 0.5, 0.8);
        }
      }
    },
    grave(p, B, t) {
      const px = p.x, py = p.y * TILT;
      const V = [[' .-. ', ' |+| ', ' |_| '], [' _^_ ', ' |#| ', ' |_| '], ['  +  ', ' -+- ', '  |  '], [' ,-, ', ' |=| ', ' |_| ']][p.variant];
      const rows = Math.max(2, Math.round(p.h / CH));
      const lines = rows >= 3 ? V : [V[0], V[2]];
      const base = B.mono, tilt = p.tilt;
      const L2 = tilt ? lines.map((l, y) => (y === 0 ? (tilt > 0 ? ' ' + l.slice(0, -1) : l.slice(1) + ' ') : l)) : lines;
      drawLines(px, py, L2, (o, ch, x, y, w, h) => {
        const v = (0.85 - (y / h) * 0.35) * (x >= w / 2 ? 1.1 : 0.8) * (0.85 + M.hash2(x + p.seed, y) * 0.3);
        o[0] = base[0] * v * 0.85; o[1] = base[1] * v * 0.85; o[2] = base[2] * v * 0.85;
      }, p.y + 2, 0);
      if (p.candle) {
        const fl = 0.75 + 0.25 * Math.sin(t * 9 + p.seed) * Math.sin(t * 5.3 + p.seed * 0.3);
        const cx = px + p.w * 0.5 + 3;
        R.set(cx, py - 2, G_PIPE, 0.75, 0.7, 0.6, p.y + 2.5, FP);
        R.glowGlyph(cx, py - 10, G_APOS, 1.4 * fl, 0.85 * fl, 0.35 * fl, p.y + 2.6, 0.9);
      }
    },
    car(p, B) {
      const paint = p.paint, seed = p.seed, rust = [0.46, 0.25, 0.13];
      const col = (o, face, u, v, hs, ci, cj) => {
        const n = M.hash2(ci * 5 + seed, cj * 11 + 3);
        const c = n < 0.45 ? rust : paint;
        const k = v * (face ? 0.9 : 1.05);
        o[0] = c[0] * k; o[1] = c[1] * k; o[2] = c[2] * k;
        return 0;
      };
      drawBox(p.x, p.y, 0, p.w, p.d, p.h, GL.cobble, paint, paint, seed, 0.12, p.y + p.d / 2, col, 0, false);
      // cabin: shattered windows on its front face
      drawBox(p.x + p.cabDx, p.y - 2, p.h, p.cabW, p.d - 6, p.cabH, GL.cobble, paint, paint, seed + 1, 0.25, p.y + p.d / 2 + 0.1, (o, face, u, v, hs) => {
        if (face === 1 && u > 0.12 && u < 0.88) { o[0] = 0.24 * v + 0.05; o[1] = 0.3 * v + 0.06; o[2] = 0.36 * v + 0.08; return hs < 0.4 ? G_FS : hs < 0.55 ? G_BS : hs < 0.8 ? G_DOT : G_APOS; }
        return col(o, face, u, v, hs, 0, 0);
      }, 0, false);
      // wheels
      const wy = (p.y + p.d / 2) * TILT - 2;
      for (const s of [-1, 1]) R.set(p.x + s * (p.w / 2 - 9), wy, G_O, 0.16, 0.15, 0.16, p.y + p.d / 2 + 0.2, FP);
    },
    sign(p, B) {
      const key = p.y + 1, base = p.y * TILT;
      const tw = p.text.length * CW + CW * 2, top = base - p.h;
      const x0 = p.x - tw / 2 + p.bent * CW;
      R.seg(p.x - tw / 3, base, p.x - tw / 3 + p.bent * 2, top + CH, G_PIPE, 0.34, 0.33, 0.33, key, FP);
      R.seg(p.x + tw / 3, base, p.x + tw / 3 + p.bent * 2, top + CH, G_PIPE, 0.3, 0.29, 0.29, key, FP);
      const pc = [0.1, 0.27, 0.16];
      for (let r = 0; r < 2; r++) {
        const cj = Math.floor((top + r * CH) / CH);
        for (let ci = Math.floor(x0 / CW); ci <= Math.floor((x0 + tw - 1) / CW); ci++) {
          const hs = M.hash2(ci + p.seed, cj);
          const v = (r ? 0.75 : 1) * (0.75 + hs * 0.4);
          R.setC(ci, cj, r ? G_UND : G_EQ, pc[0] * v, pc[1] * v, pc[2] * v, key + 0.1, FP);
        }
      }
      let txt = p.text;
      if (p.holes) { const a = txt.split(''); for (let hI = 0; hI < p.holes; hI++) { const q = (p.seed >> (hI * 3)) % a.length; if (a[q] !== ' ') a[q] = '°'; } txt = a.join(''); }
      R.text(x0 + CW, top + 2, txt, 0.72, 0.78, 0.7, key + 0.2, FP);
    },
    gumdrop(p, B) {
      const seed = p.seed;
      drawDome(p.x, p.y, p.rx, p.ry, p.h, RAMP_DOME, p.col, p.y + p.ry * 0.5, seed, (o, nx, ny, sh, hv, ci, cj) => {
        if (sh > 0.86 && hv < 0.35) { o[0] = 0.95; o[1] = 0.88; o[2] = 0.9; return G_STAR; } // sugar glint
        if (p.cracked && Math.abs(nx - ny * 0.4 - 0.1 + Math.sin(ny * 6) * 0.08) < 0.07) { o[0] *= 0.25; o[1] *= 0.2; o[2] *= 0.22; return hv < 0.5 ? G_FS : G_PIPE; }
        if (ny > 0.35 && Math.abs(nx) < 0.16) { o[0] *= 0.18; o[1] *= 0.12; o[2] *= 0.14; return G_HASH; } // tomb door
        if (hv < 0.06) { o[0] *= 0.5; o[1] *= 0.42; o[2] *= 0.6; return G_o; } // rot spots
        return 0;
      });
    },
    cane(p, B) {
      const seed = p.seed, red = [0.95, 0.14, 0.16], wht = [1.0, 0.93, 0.9];
      const band = (ci, cj) => ((((ci + cj * 2 + (seed % 5)) % 6) + 6) % 6) < 3;
      const stripe = (o, face, u, v, hs, ci, cj) => {
        const isR = face === 1 && band(ci, cj);
        const c = isR ? red : wht, k = (face === 0 ? 0.95 : v * 1.35) * (hs < 0.06 ? 0.5 : 1);
        o[0] = c[0] * k; o[1] = c[1] * k; o[2] = c[2] * k * (hs < 0.06 ? 1.2 : 1);
        return isR ? G_HASH : G_AT;
      };
      drawBox(p.x, p.y, 0, p.w, p.d, p.h, GL.cane, wht, wht, seed, p.broken ? 0.45 : 0.04, p.y + p.d / 2, stripe, 0, true);
      if (p.hook) { // the crook: a thick striped arc curling over
        const topPy = (p.y + p.d / 2) * TILT - p.h, rH = p.w * 0.9, key = p.y + p.d / 2;
        for (let s = 0; s <= 22; s++) {
          const a = (s / 22) * Math.PI * 1.15;
          const cx = p.x + p.dir * (rH - Math.cos(a) * rH), cy = topPy - Math.sin(a) * rH * 0.9 + (a > Math.PI ? (a - Math.PI) * 14 : 0);
          const c = ((s >> 1) % 2) ? red : wht, sh = 0.75 + 0.35 * Math.sin(a + 0.6);
          for (let th = -1; th <= 1; th++) {
            const nx = -Math.cos(a) * th * 3.2 * p.dir, ny = -Math.sin(a) * th * 3.2 * 0.9;
            R.set(cx + nx, cy + ny, c === red ? G_HASH : G_AT, c[0] * sh, c[1] * sh, c[2] * sh, key, FP);
          }
        }
      }
    },
    ginger(p, B) {
      const seed = p.seed, brown = B.thicket, ic = B.icing;
      const winL = 0.22 + (seed % 5) * 0.08;
      drawBox(p.x, p.y, 0, p.w, p.d, p.h, GL.ginger, brown, brown, seed, 0.55, p.y + p.d / 2, (o, face, u, v, hs, ci, cj) => {
        if (face === 0) { o[0] = ic[0] * v * 0.9; o[1] = ic[1] * v * 0.9; o[2] = ic[2] * v * 0.9; return GL.icing[(hs * 31) % 5 | 0]; }
        const row = cj - Math.floor(((p.y + p.d / 2) * TILT - p.h * 0.75) / CH);
        if (row >= 0 && row <= 1 && ((u > winL && u < winL + 0.1) || (u > winL + 0.4 && u < winL + 0.5))) return -1; // broken windows
        if (hs < 0.05) { o[0] = 0.75; o[1] = 0.2; o[2] = 0.3; return G_o; } // gumdrop button
        const k = v * 1.15; o[0] = brown[0] * k * 1.25; o[1] = brown[1] * k * 1.2; o[2] = brown[2] * k;
        return 0;
      }, 0, false);
    },
    lamp(p, B, t) {
      const base = p.y * TILT, key = p.y + 1;
      R.seg(p.x, base, p.x, base - p.h + 6, G_PIPE, 0.42, 0.34, 0.4, key, FP);
      R.set(p.x - CW, base - p.h + 4, G_UND, 0.4, 0.33, 0.37, key, FP); R.set(p.x + CW, base - p.h + 4, G_UND, 0.4, 0.33, 0.37, key, FP);
      const on = lampLevel(p, t);
      if (on > 0.05) R.glowGlyph(p.x, base - p.h, G_AT, 1.2 * on, 0.75 * on, 0.9 * on, key + 0.1, 0.9);
      else R.set(p.x, base - p.h, G_o, 0.3, 0.25, 0.3, key + 0.1, FP);
    },
    spire(p, B, t) {
      const dark = p.dark || [0.14, 0.28, 0.5], lit = p.lit || [0.85, 1.02, 1.2];
      for (const s of p.shards) drawSpire(p.x + s.dx, p.y + s.dy, s.w, s.h, s.lean, dark, lit, p.y + s.dy + 4, p.seed + s.dx * 13 | 0, p.glow ? 0.12 : 0.04, p.fill);
    },
    shard(p, B, t) { DRAW.spire(p, B, t); },
    bonespike(p, B, t) { DRAW.spire(p, B, t); },
    boulder(p, B) {
      const c = p.col || B.stone;
      drawBox(p.x, p.y, 0, p.w, p.d, p.h, GL.rock, c, c, p.seed, 0.5, p.y + p.d / 2, p.snowcap ? (o, face, u, v, hs, ci, cj, base) => {
        if (face === 0) { o[0] = 0.75 * v; o[1] = 0.82 * v; o[2] = 0.95 * v; return hs < 0.5 ? G_DOT : G_APOS; }
        o[0] = base[0] * v; o[1] = base[1] * v; o[2] = base[2] * v; return 0;
      } : null, 0, true);
    },
    penguin(p, B, t) {
      // a frost-cursed penguin locked in a block of ice; its eyes still follow you
      drawBox(p.x, p.y, 0, p.w, p.d, p.h, GL.iceFill, [0.4, 0.6, 0.8], [0.3, 0.5, 0.72], p.seed, 0.15, p.y + p.d / 2, (o, face, u, v) => { o[0] = 0.25 * v; o[1] = 0.45 * v; o[2] = 0.65 * v; return face ? G_DOT : G_COLON; }, 0, false);
      const blink = Math.sin(t * 0.7 + p.seed) > 0.97 ? 0.2 : 1;
      drawLines(p.x, (p.y + p.d / 2) * TILT - 3, [' .-. ', '(o o)', '/( )\\', ' ^ ^ '], (o, ch, x, y) => {
        if (ch === 'o') { o[0] = 0.5 * blink; o[1] = 0.9 * blink; o[2] = 1.3 * blink; o.e = 0.6; return; }
        if (ch === '^') { o[0] = 0.55; o[1] = 0.4; o[2] = 0.2; return; }
        const w = x === 2 && y >= 2; o[0] = w ? 0.75 : 0.08; o[1] = w ? 0.78 : 0.1; o[2] = w ? 0.85 : 0.16;
      }, p.y + p.d / 2 + 0.1, 0);
    },
    basalt(p, B) {
      const c = B.basalt;
      for (const s of p.cols) drawBox(p.x + s.dx, p.y + s.dy, 0, s.w, s.d, s.h, GL.basalt, c, c, p.seed + (s.dx * 7 | 0), 0, p.y + s.dy + s.d / 2, (o, face, u, v, hs, ci, cj, base) => {
        if (face === 0) { o[0] = base[0] * v * 1.2; o[1] = base[1] * v * 1.15; o[2] = base[2] * v * 1.2; return GL.basaltTop[(hs * 7) % 4 | 0]; }
        const edge = u < 0.08 || u > 0.92;
        const k = v * 1.1; o[0] = base[0] * k; o[1] = base[1] * k; o[2] = base[2] * k;
        return edge ? G_PIPE : 0;
      }, 0, true);
    },
    brazier(p, B, t) {
      const key = p.y + p.d / 2, green = p.fire === 'green';
      drawBox(p.x, p.y, 0, p.w * 0.6, p.d * 0.6, p.h - 6, GL.obsidW, [0.3, 0.3, 0.32], [0.24, 0.24, 0.26], p.seed, 0, key, null, 0, true);
      const topPy = (p.y + p.d * 0.3) * TILT - p.h;
      drawLines(p.x, topPy + CH, ['\\___/'], (o) => { o[0] = 0.4; o[1] = 0.38; o[2] = 0.36; }, key + 0.05, 0);
      const pal = green ? FLAME_GREEN : FLAME_ORANGE;
      drawFlame(p.x, topPy, 15, 4, pal, key + 0.1, t, p.seed % 31, 0.55);
    },
    ribs(p, B) {
      const n = p.n, x0 = p.x - p.w / 2, H = p.h, D = p.d / 2, bone = B.bone || [0.66, 0.64, 0.55];
      for (let r = 0; r < n; r++) {
        const rx = x0 + (r + 0.5) * (p.w / n);
        const taper = 1 - Math.abs(r / (n - 1) - 0.4) * 0.9;
        const hh = H * Math.max(0.35, taper);
        for (const side of [-1, 1]) {
          let px0 = rx, py0 = p.y * TILT - hh, k0 = p.y;
          for (let s = 1; s <= 7; s++) {
            const a = (s / 7) * Math.PI * 0.5;
            const wx = rx + Math.sin(a) * 6 * p.dir, wy = p.y + side * D * Math.sin(a) * taper, wz = hh * Math.cos(a);
            const px1 = wx, py1 = wy * TILT - wz;
            const v = (side > 0 ? 0.95 : 0.6) * (0.8 + 0.2 * Math.cos(a));
            R.seg(px0, py0, px1, py1, null, bone[0] * v, bone[1] * v, bone[2] * v, k0, FP, wy);
            px0 = px1; py0 = py1; k0 = wy;
          }
        }
      }
      // spine
      for (let ci = Math.floor(x0 / CW); ci <= Math.floor((x0 + p.w) / CW); ci++) {
        const u = (ci * CW - x0) / p.w, taper = 1 - Math.abs(u - 0.4) * 0.9;
        const py = p.y * TILT - H * Math.max(0.35, taper) - 2;
        R.setC(ci, Math.floor(py / CH), ci % 2 ? G_o : G_EQ, bone[0] * 0.9, bone[1] * 0.9, bone[2] * 0.9, p.y + 0.5, FP);
      }
      // skull at the head end
      const hx = p.dir > 0 ? x0 + p.w + 8 : x0 - 8;
      R.ball(hx, p.y * TILT - 10, 7, p.y + 1, RAMP_SKULL, bone[0], bone[1], bone[2], FP, NF);
      R.set(hx - 2, p.y * TILT - 12, G_o, 0.05, 0.05, 0.05, p.y + 1.1, FP);
    },
    obelisk(p, B, t) {
      const key = p.y + p.d / 2, c = B.mono;
      drawBox(p.x, p.y, 0, p.w, p.d, p.h, GL.obsidW, c, c, p.seed, 0.06, key, null, 0, false);
      const front = (p.y + p.d / 2) * TILT;
      const pulse = 0.55 + 0.45 * Math.sin(t * 1.6 + p.seed);
      const wc = B.witch || [0.35, 1.2, 0.5];
      for (let z = 12; z < p.h - 14; z += CH * 1.5) {
        const hs = M.hash2(p.seed, z | 0);
        R.glowGlyph(p.x + 1, front - z, GL.runes[(hs * 8) | 0], wc[0] * pulse, wc[1] * pulse, wc[2] * pulse, key + 0.1, 0.5);
      }
    },
    skulls(p, B) {
      const bone = B.bone || [0.66, 0.64, 0.55];
      drawDome(p.x, p.y, p.rx, p.ry, p.h, RAMP_SKULL, bone, p.y + p.ry * 0.5, p.seed, (o, nx, ny, sh, hv) => {
        if (hv < 0.3) { o[0] *= 0.25; o[1] *= 0.25; o[2] *= 0.25; return hv < 0.15 ? G_o : G_DOT; } // eye sockets
        return GL.skull[(hv * 40) % 4 | 0];
      });
    },
    campfire(p, B, t) {
      const px = p.x, py = p.y * TILT, key = p.y + 2;
      // stones ring
      for (let a = 0; a < 10; a++) {
        const ang = (a / 10) * Math.PI * 2, sx = px + Math.cos(ang) * 15, sy = py + Math.sin(ang) * 7;
        const v = Math.sin(ang) > 0 ? 0.62 : 0.42;
        R.set(sx, sy, a % 3 ? G_o : G_O, 0.5 * v, 0.5 * v, 0.55 * v, p.y + Math.sin(ang) * 8, FP);
      }
      // logs, glowing at the core
      const lg = Math.max(0, 0.5 + 0.5 * Math.sin(t * 3.1 + 1));
      R.seg(px - 9, py + 1, px + 9, py - 3, G_EQ, 0.3 + lg * 0.4, 0.16 + lg * 0.1, 0.08, key - 0.5, FP);
      R.seg(px - 8, py - 3, px + 8, py + 2, G_EQ, 0.26 + lg * 0.3, 0.13 + lg * 0.08, 0.07, key - 0.4, FP);
      drawFlame(px, py - 2, 22, 6, FLAME_ORANGE, key, t, 5, 0.7);
      // smoke and embers drifting up (stateless)
      for (let e = 0; e < 7; e++) {
        const ph = (t * 0.45 + e / 7) % 1, rise = ph * 90 + 22;
        const ex = px + Math.sin(t * 1.3 + e * 2.1) * (4 + ph * 14) + (e - 3) * 1.5;
        if (e < 4) { const k = (1 - ph) * 1.3; R.glowGlyph(ex, py - rise * 0.8, ph < 0.5 ? G_APOS : G_DOT, 1.3 * k, 0.5 * k, 0.12 * k, key + 1, 0.8); }
        else { const k = (1 - ph) * 0.35; R.set(ex + ph * 18, py - 30 - rise, ph < 0.4 ? G_TILDE : G_DOT, k, k, k * 1.05, key + 0.5, 0); }
      }
    },
    well(p, B, t) {
      // The Well of Power: a giant cracked ring of black stone; witch-light boils up out of the pit.
      const cx = p.x, cy = p.y, rx = p.rx, ry = p.ry, wc = B.witch;
      const pulse = 0.75 + 0.25 * Math.sin(t * 1.3);
      // pit interior
      R.ellipse(cx, cy, rx - 14, ry - 10, (i, u, ci, cj, ang) => {
        const sw = Math.sin(ang * 3 - t * 1.6 + u * 9) * 0.5 + 0.5;
        const k = (1 - u) * (0.35 + 0.65 * sw) * pulse;
        const g = k > 0.55 ? G_AT : k > 0.35 ? G_o : k > 0.18 ? G_TILDE : G_DOT;
        if (R.setI(i, g, wc[0] * k * 0.8, wc[1] * k * 0.8, wc[2] * k * 0.8, R.KEY_DECAL + 5, R.F_UNLIT | FP)) R.emitI(i, wc[0] * k * 0.35, wc[1] * k * 0.35, wc[2] * k * 0.35);
      });
      // rim: blocks around the ellipse, each a short prism column (front half occludes the pit)
      const N = 44, mono = [0.3, 0.3, 0.36];
      for (let s = 0; s < N; s++) {
        const a = (s / N) * Math.PI * 2, bx = cx + Math.cos(a) * rx, by = cy + Math.sin(a) * ry;
        const broken = M.hash2(s, 99) < 0.18;
        const hh = p.h * (broken ? 0.45 : 0.85 + M.hash2(s, 7) * 0.3);
        drawBox(bx, by, 0, 22, 14, hh, GL.obsidW, mono, mono, s * 31 + 5, broken ? 0.5 : 0.1, by + 7, (o, face, u, v, hs, ci, cj, base) => {
          const glow = Math.sin(a) < 0 ? 0 : 0;
          const k = v * (face ? 0.85 : 1.15);
          o[0] = base[0] * k + glow; o[1] = base[1] * k; o[2] = base[2] * k;
          if (face === 1 && hs < 0.08) { o[0] = wc[0] * 0.5 * pulse; o[1] = wc[1] * 0.5 * pulse; o[2] = wc[2] * 0.5 * pulse; return GL.runes[(hs * 90) % 8 | 0]; }
          return 0;
        }, 0, false);
      }
      // column of rising witch-motes
      for (let m = 0; m < 26; m++) {
        const ph = (t * 0.22 + m / 26) % 1, ang = m * 2.4 + t * 0.3;
        const mx = cx + Math.cos(ang) * (rx * 0.55) * (1 - ph * 0.6), my = cy + Math.sin(ang) * ry * 0.5 * (1 - ph * 0.6);
        const k = (1 - ph) * 1.2;
        R.glowGlyph(mx, my * TILT - ph * 170, ph < 0.3 ? G_o : G_DOT, wc[0] * k, wc[1] * k, wc[2] * k, cy + ry, 0.7);
      }
    },
    stall(p) { /* drawn with the merchant interactable */ },
    gate(p, B, t) {
      // the Dungeon Door's frame: two weathered pillars and a lintel behind the ring; runes wake when it opens
      const F = World.floor, open = F && F.exitOpen, pc = B.portal, mono = B.mono, half = p.gap / 2;
      const runeFn = (o, face, u, v, hs, ci, cj, base) => {
        o[0] = base[0] * v; o[1] = base[1] * v; o[2] = base[2] * v;
        if (face === 1 && Math.abs(u - 0.5) < 0.3 && (cj & 1) && hs < 0.55) {
          const k = open ? 0.8 + 0.3 * Math.sin(t * 3 + cj) : 0.18;
          o[0] = pc[0] * k; o[1] = pc[1] * k; o[2] = pc[2] * k; return GL.runes[(hs * 15) % 8 | 0];
        }
        return 0;
      };
      // two standing stones flank the door; broken tops differ per side
      for (const sx of [-1, 1]) drawBox(p.x + sx * half, p.y, 0, p.pw, p.d, p.h * (sx < 0 ? 1 : 0.86), GL.monoFace, mono, mono, p.seed + sx, 0.12, p.y + p.d / 2, runeFn, 0, false);
      if (open) for (const sx of [-1, 1]) R.emit(p.x + sx * half, (p.y + p.d / 2) * TILT - p.h * 0.5, pc[0] * 0.25, pc[1] * 0.25, pc[2] * 0.25);
    },

    // ---- prologue set-pieces
    treefort(p, B, t) {
      const px = p.x, base = p.y * TILT, key = p.y + 3, bark = [0.5, 0.43, 0.37], wood = [0.7, 0.52, 0.33], moss = [0.3, 0.42, 0.28];
      // roots clawing into the clearing
      for (let r = 0; r < 6; r++) {
        const a = Math.PI * (0.05 + r * 0.18) + (r % 2 ? 0.08 : -0.05), L = 34 + ((p.seed >> r) & 15) * 2;
        const ex = px + Math.cos(a) * L * (r < 3 ? 1 : -1), ey = base + Math.sin(a) * 10 + 2;
        R.capsule(px + (r < 3 ? 12 : -12), base - 6, ex, ey, 7, 2.2, key + 1, key + (Math.sin(a) > 0.5 ? 4 : 0), RAMP_BARK, bark[0] * 0.9, bark[1] * 0.9, bark[2] * 0.9, FP, NFB);
      }
      // the trunk, leaning a touch, tapering into the crown
      R.capsule(px, base - 4, px + 5, base - 130, 29, 23, key, key, RAMP_BARK, bark[0], bark[1], bark[2], FP, NFB);
      R.capsule(px + 5, base - 130, px + 10, base - 215, 23, 15, key - 1, key - 1, RAMP_BARK, bark[0] * 0.95, bark[1] * 0.95, bark[2] * 0.95, FP, NFB);
      // the door at the foot of the trunk: a plank frame round a black hollow
      drawLines(px, base - 2, [' .-"-. ', ' |:.:| ', ' |.:.| ', ' |:::| ', "_|___|_"], (c, ch, x, y) => {
        if (ch === ':' || ch === '.') { c[0] = 0.05; c[1] = 0.04; c[2] = 0.035; return; }
        const v = (x >= 3 ? 1.1 : 0.8) * (y === 0 ? 1.1 : 1); c[0] = wood[0] * v; c[1] = wood[1] * v; c[2] = wood[2] * v;
      }, key + 1.5, 0);
      // ladder up the moonlit side
      R.seg(px + 13, base - 30, px + 15, base - 150, G_PIPE, wood[0] * 0.8, wood[1] * 0.8, wood[2] * 0.8, key + 1, FP);
      R.seg(px + 23, base - 30, px + 25, base - 150, G_PIPE, wood[0] * 0.9, wood[1] * 0.9, wood[2] * 0.9, key + 1, FP);
      for (let z = 34; z < 150; z += CH) R.set(px + 18 + z * 0.016, base - z, ((z / CH) | 0) % 5 === 3 ? G_DOT : G_EQ, wood[0] * 1.05, wood[1] * 1.05, wood[2] * 1.05, key + 1.1, FP);
      // the deck: planks, a broken corner
      drawBox(px + 6, p.y, 150, 236, 84, 9, GL.cobble, wood, wood, p.seed, 0.12, p.y + 40, (o, face, u, v, hs, ci, cj) => {
        if (face === 0 && u > 0.82 && hs < 0.45) return -1; // the corner fell in
        const k = face ? v * 0.7 : v * 0.95; o[0] = wood[0] * k; o[1] = wood[1] * k; o[2] = wood[2] * k;
        return face ? (hs < 0.25 ? G_PIPE : G_UND) : (hs < 0.12 ? G_DOT : G_EQ);
      }, 0, false);
      // the house: plank walls, a lit window, a hole torn through
      const hy = p.y - 6, hz = 159, hw = 150, hd = 46, hh = 70;
      const front = (hy + hd / 2) * TILT - hz;
      drawBox(px - 6, hy, hz, hw, hd, hh, GL.cobble, wood, wood, p.seed + 1, 0.05, p.y + 38, (o, face, u, v, hs, ci, cj) => {
        const row = Math.floor((front - (cj + 0.5) * CH) / CH); // rows above the deck
        if (face === 1 && row >= 3 && row <= 5 && u > 0.6 && u < 0.76) { // the window: a warm, failing glow
          const fl = 0.55 + 0.25 * Math.sin(t * 3.7 + ci) * Math.sin(t * 1.9);
          o[0] = 1.15 * fl; o[1] = 0.68 * fl; o[2] = 0.28 * fl; return row === 4 ? G_PLUS : G_HASH;
        }
        if (face === 1 && row >= 2 && row <= 6 && u > 0.14 && u < 0.3 && hs < 0.8) return -1; // torn-out planks
        const k = face ? v * (u > 0.55 ? 1.5 : 1.05) : v * 0.8;
        o[0] = wood[0] * k; o[1] = wood[1] * k; o[2] = wood[2] * k;
        if (face === 0) { o[0] = moss[0] * v; o[1] = moss[1] * v; o[2] = moss[2] * v; return hs < 0.5 ? G_DOT : G_APOS; }
        return hs < 0.07 ? G_DOT : (ci & 1) ? G_PIPE : G_BANG;
      }, 0, false);
      // a pitched roof, half caved in
      const roofY = front - hh - CH * 2;
      drawLines(px - 6, roofY + CH * 4, ['      __..--""\\        ', '   .-"   /\\    \\.     ', ' .\'  /\\  /  \\ ,  \\    ', '/____/__\\/____\\____\\_ '], (c, ch, x, y) => {
        const v = (y === 3 ? 0.85 : 0.6 + y * 0.08) * (x > 12 ? 1.1 : 0.8); c[0] = 0.3 * v; c[1] = 0.26 * v; c[2] = 0.22 * v;
      }, p.y + 37, 0);
      // dead limbs of the crown
      const s = p.segs;
      for (let q = 0; q < s.length; q += 7) {
        const ax = px + s[q], ay = (p.y + s[q + 1]) * TILT - s[q + 2], bx = px + s[q + 3], by = (p.y + s[q + 4]) * TILT - s[q + 5], th = s[q + 6];
        const v = th > 1.5 ? 0.85 : 0.65;
        R.seg(ax, ay, bx, by, null, bark[0] * v, bark[1] * v, bark[2] * v, p.y + 2 + s[q + 4] * 0.01, FP);
      }
      // a rope and an old tyre swing hang off the deck; a lantern hangs at its corner
      const sw = Math.sin(t * 0.8 + 1) * 2;
      R.seg(px - 86, (p.y + 40) * TILT - 150, px - 86 + sw, base - 52, G_PIPE, 0.4, 0.36, 0.3, p.y + 41, FP);
      R.set(px - 86 + sw, base - 46, G_O, 0.22, 0.2, 0.2, p.y + 41, FP);
      const fl = 0.85 + 0.15 * Math.sin(t * 6.3) * Math.sin(t * 2.9);
      R.seg(px + 104, (p.y + 40) * TILT - 150, px + 104, (p.y + 40) * TILT - 132, G_PIPE, 0.35, 0.3, 0.26, p.y + 41, FP);
      R.glowGlyph(px + 104, (p.y + 40) * TILT - 126, G_o, 1.4 * fl, 0.95 * fl, 0.45 * fl, p.y + 41.5, 0.9);
    },
    lantern(p, B, t) {
      // a lantern on a crooked post: warm, flickering, lighting the path
      const base = p.y * TILT, key = p.y + 1, top = base - p.h, dx = p.side * CW;
      R.seg(p.x, base, p.x, top, G_PIPE, 0.36, 0.3, 0.24, key, FP);
      R.set(p.x + dx, top, G_UND, 0.36, 0.3, 0.24, key, FP);
      const lx = p.x + dx * 2, ly = top + CH;
      R.set(lx, ly - CH * 0.6, G_COLON, 0.3, 0.26, 0.22, key, FP);
      if (p.lit !== false) {
        const fl = 0.82 + 0.18 * Math.sin(t * 7.1 + p.seed) * Math.sin(t * 3.3 + p.seed * 0.3);
        R.set(lx - CW, ly + 2, G_LBR, 0.5, 0.36, 0.2, key + 0.1, FP); R.set(lx + CW, ly + 2, G_RBR, 0.5, 0.36, 0.2, key + 0.1, FP);
        R.glowGlyph(lx, ly + 2, G_o, 1.5 * fl, 1.0 * fl, 0.45 * fl, key + 0.2, 1.0);
      } else {
        R.set(lx - CW, ly + 2, G_LBR, 0.25, 0.22, 0.2, key + 0.1, FP); R.set(lx + CW, ly + 2, G_RBR, 0.25, 0.22, 0.2, key + 0.1, FP);
        R.set(lx, ly + 2, G_o, 0.2, 0.18, 0.16, key + 0.2, FP);
      }
    },
    barricade(p, B, t) {
      const x0 = p.x - p.w / 2, base = p.y * TILT, bone = [0.86, 0.83, 0.72];
      if (p.open) { // shattered: a low scatter of bones, walked over
        for (let n = 0; n < 40; n++) {
          const hx = M.hash2(n, 7), hy = M.hash2(n, 13), hg = M.hash2(n, 29);
          const v = 0.35 + hg * 0.3;
          R.set(x0 + hx * p.w, (p.y + (hy - 0.5) * p.d * 1.6) * TILT, hg < 0.3 ? G_EQ : hg < 0.55 ? G_DASH : hg < 0.75 ? G_o : G_COMMA, bone[0] * v, bone[1] * v, bone[2] * v, R.KEY_DECAL + 2, FP);
        }
        return;
      }
      R.shadowEllipse(p.x, p.y + 4, p.w * 0.55, 16, 0.7);
      // a lashed wall of bones and skulls, spikes jutting out; a crack runs through it (it wants to be smashed)
      const n = Math.round(p.w / CW);
      const rows = ['\\ | / ', ' \\|/  ', '=#X#=O', '(o)=(o', '/_\\_/_'];
      const lines = rows.map((r) => { let s = ''; while (s.length < n) s += r; return s.slice(0, n); });
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
      drawLines(p.x, base + 2, lines, (c, ch, x, y, w, h) => {
        const crack = Math.abs(x - w * 0.55 - (y - 2) * 0.8) < 0.8 && y >= 1;
        if (crack) { const k = 0.35 + 0.35 * pulse; c[0] = 1.0 * k; c[1] = 0.55 * k; c[2] = 0.25 * k; c.e = 0.25 * pulse; return; }
        if (ch === 'o' && y === 3) { c[0] = 0.08; c[1] = 0.06; c[2] = 0.05; return; } // eye sockets
        const v = (y <= 1 ? 0.95 : y === 2 ? 0.85 : 0.72) * (x / w > 0.5 ? 1.08 : 0.88) * (0.85 + M.hash2(x, y + 5) * 0.3);
        c[0] = bone[0] * v; c[1] = bone[1] * v; c[2] = bone[2] * v;
      }, p.y + p.d / 2, 0);
    },
    pedestal(p, B, t) {
      const base = p.y * TILT, stone = [0.5, 0.52, 0.6], pulse = 0.6 + 0.4 * Math.sin(t * 1.7);
      drawLines(p.x, base, ['  _____  ', ' |_=_=_| ', '   | |   ', '   |:|   ', ' __|_|__ '], (c, ch, x, y) => {
        if (ch === '=' || ch === ':') { const k = 0.35 + 0.4 * pulse; c[0] = 0.5 * k; c[1] = 0.75 * k; c[2] = 1.2 * k; c.e = 0.3 * pulse; return; }
        const v = (x >= 4 ? 1.05 : 0.75) * (y === 0 ? 1.1 : 0.9); c[0] = stone[0] * v; c[1] = stone[1] * v; c[2] = stone[2] * v;
      }, p.y + 2, 0);
    },
    trapplate(p, B, t) {
      // a rusted pressure plate half-hidden in the grass; its spikes show once it has sprung
      const base = p.y * TILT;
      drawLines(p.x, base + 4, p.fired ? ['^ ^ ^ ^', '[=====]'] : ['  . .  ', '[_._._]'], (c, ch) => {
        const k = p.fired ? (ch === '^' ? 0.75 : 0.45) : 0.32; c[0] = 0.62 * k; c[1] = 0.42 * k; c[2] = 0.3 * k;
      }, R.KEY_DECAL + 3, 0);
    },
    bmo(p, B, t) {
      // a little game console, cracked, half-buried, its screen still trying
      const base = p.y * TILT, body = [0.32, 0.62, 0.56], blink = Math.sin(t * 2.2 + 1) > 0.9;
      const face = blink ? '[-_-]' : (Math.sin(t * 0.7) > 0 ? '[o_o]' : '[o.o]');
      R.shadowEllipse(p.x, p.y + 3, 16, 7, 0.5);
      drawLines(p.x, base, [' .-----. ', ' |' + face + '| ', ' |  + o| ', " '-----' ", '  |   |  '], (c, ch, x, y) => {
        if (y === 1 && x >= 2 && x <= 6) { const fl = 0.7 + 0.3 * Math.sin(t * 13) * Math.sin(t * 5.1); c[0] = 0.55 * fl; c[1] = 1.0 * fl; c[2] = 0.75 * fl; c.e = 0.35; return; }
        if (ch === 'o' || ch === '+') { c[0] = ch === 'o' ? 0.85 : 0.9; c[1] = ch === 'o' ? 0.25 : 0.8; c[2] = ch === 'o' ? 0.3 : 0.3; return; }
        const v = (x >= 4 ? 1.05 : 0.8) * (y >= 4 ? 0.7 : 1); c[0] = body[0] * v; c[1] = body[1] * v; c[2] = body[2] * v;
      }, p.y + 2, 0);
    },
  };
  const FLAME_ORANGE = [[1.7, 1.3, 0.65], [1.45, 0.62, 0.14], [0.9, 0.24, 0.05]];
  const FLAME_GREEN = [[0.9, 1.7, 1.0], [0.3, 1.25, 0.42], [0.1, 0.55, 0.2]];
  function lampLevel(p, t) {
    if (p.state === 0) return 0;
    if (p.state === 1) return 0.9 + 0.1 * Math.sin(t * 3 + p.seed);
    const s = Math.sin(t * 13 + p.seed) + Math.sin(t * 7.7 + p.seed * 0.7); // failing bulb
    return s > 0.4 ? 0.95 : s > -0.6 ? 0.35 : 0.05;
  }

  // ================================================================== interactables: drawing
  function drawRemnant(o, F, t) {
    const S = SPRITES[o.npc] || SPRITES.billy;
    if (o.used && o._usedAt === undefined) o._usedAt = World.t;
    const ua = o.used ? Math.max(0.28, 1 - (World.t - o._usedAt) / 4) : 1; // after speaking it fades to a faint wisp
    const L = S.lines, h = L.length; let w = 0; for (const l of L) if (l.length > w) w = l.length;
    const bob = Math.sin(t * 1.3 + o.x * 0.01) * 2.5;
    const px = o.x, py = o.y * TILT - 3 + bob;
    const ci0 = Math.floor(px / CW - w / 2), cj0 = Math.floor(py / CH) - h + 1;
    const fr = Math.floor(t * 9), key = o.y + 2, fl = R.F_UNLIT | FP;
    if (S.crown) { // Simon's shadow wears the crown (cast down-left, away from the moon)
      const sx = o.x - 34, sy = o.y + 12, C = [' /\\  /\\  /\\ ', '|  \\/  \\/  |', '|__________|'];
      const k = 0.55 * ua;
      for (let y = 0; y < 3; y++) for (let x = 0; x < C[y].length; x++) {
        const ch = C[y][x]; if (ch === ' ') continue;
        const i = R.idxP(sx + (x - 6) * CW, sy * TILT + (y - 2) * CH); if (i < 0) continue;
        R.shadowI(i, 0.5 * ua);
        R.setI(i, R.gi(ch), 0.14 * k, 0.15 * k, 0.32 * k, R.KEY_DECAL + 1, 0);
      }
    }
    for (let y = 0; y < h; y++) {
      const l = L[y];
      const sw = Math.sin(t * 2.3 + y * 0.7 + o.x * 0.013);
      const off = sw > 0.9 ? 1 : sw < -0.9 ? -1 : 0; // the shimmer: rows slip sideways now and then
      for (let x = 0; x < l.length; x++) {
        const ch = l[x]; if (ch === ' ') continue;
        if (M.hash3(x + ci0, y, fr) < 0.05 + (1 - ua) * 0.35) continue; // flickering dropout
        TMP.e = 0;
        if (S.pal(TMP, ch, x, y, w, h, t) === false) continue;
        const k = (0.78 + 0.22 * Math.sin(t * 3.1 + y * 0.55 + x * 0.21)) * ua * (S.gain || 1);
        const i = R.idx(ci0 + x + off, cj0 + y); if (i < 0) continue;
        if (R.setI(i, R.gi(ch), TMP[0] * k, TMP[1] * k, TMP[2] * k, key, fl)) { const e = (TMP.e || 0.15) * k; R.emitI(i, TMP[0] * e, TMP[1] * e, TMP[2] * e); }
      }
    }
    const c = S.light;
    R.light(o.x, o.y, 30, S.lr || 120, c[0], c[1], c[2], (0.42 + 0.12 * Math.sin(t * 2)) * ua);
    for (let m = 0; m < 8; m++) { // motes drifting up off the remnant
      const ph = (t * 0.35 + m / 8) % 1, a = m * 2.4 + t * 0.4, rr = 10 + (m % 4) * 7;
      const k = (1 - ph) * 0.8 * ua;
      R.glowGlyph(o.x + Math.cos(a) * rr, (o.y + Math.sin(a) * rr * 0.5) * TILT - ph * h * CH * 0.9, ph < 0.3 ? G_MDOT : G_DOT, c[0] * k, c[1] * k, c[2] * k, o.y + 3, 0.6);
    }
    if (!o.used) { // a faint pulse on the ground marks "come and talk"
      const pr = 22 + ((t * 0.6) % 1) * 18, pk = 0.25 * (1 - ((t * 0.6) % 1));
      R.ring(o.x, o.y, pr, 4, (i) => { if (R.key[i] <= R.KEY_GROUND && R.glyph[i]) { const q = i * 3; R.col[q] += c[0] * pk; R.col[q + 1] += c[1] * pk; R.col[q + 2] += c[2] * pk; } });
    }
  }

  const IDRAW = {
    story(o, F, t) { if (!o.hidden) drawRemnant(o, F, t); },
    portal(o, F, t) {
      const B = F.biome, col = B.portal, open = F.exitOpen, x = o.x, y = o.y;
      // stone rim + rune stones
      R.ring(x, y, 36, 9, (i, u, ci, cj, ang) => {
        const h = M.hash2(ci, cj);
        if (open) {
          const sw = 0.5 + 0.5 * Math.sin(ang * 3 - t * 4.5 + u * 3);
          const k = 0.45 + 0.75 * sw;
          const g = sw > 0.82 ? G_AT : sw > 0.6 ? G_O : sw > 0.35 ? G_o : G_STAR;
          if (R.setI(i, g, col[0] * k * 1.2, col[1] * k * 1.2, col[2] * k * 1.2, R.KEY_DECAL + 3, R.F_UNLIT | FP)) R.emitI(i, col[0] * k * 0.45, col[1] * k * 0.45, col[2] * k * 0.45);
        } else {
          const pulse = 0.5 + 0.5 * Math.sin(t * 1.2 + ang * 2);
          const rune = Math.abs(Math.sin(ang * 4)) > 0.96;
          const k = rune ? 0.35 + pulse * 0.35 : 0.28 + h * 0.12;
          R.setI(i, rune ? G_o : h < 0.5 ? G_HASH : G_EQ, (rune ? col[0] : 0.5) * k, (rune ? col[1] : 0.52) * k, (rune ? col[2] : 0.58) * k, R.KEY_DECAL + 3, (rune ? R.F_UNLIT : 0) | FP);
          if (rune) R.emitI(i, col[0] * 0.04 * pulse, col[1] * 0.04 * pulse, col[2] * 0.04 * pulse);
        }
      });
      // center: sealed slab (dormant) or a vortex spiralling down (open)
      R.ellipse(x, y, 29, 29, (i, u, ci, cj, ang) => {
        if (open) {
          const sp = Math.sin(ang * 2 + u * 11 - t * 6) * 0.5 + 0.5;
          const k = (0.25 + 0.9 * sp) * (1 - u * 0.4) + (u < 0.25 ? (0.25 - u) * 4 : 0);
          const g = u < 0.15 ? G_AT : sp > 0.75 ? G_TILDE : sp > 0.4 ? G_DASH : G_DOT;
          if (R.setI(i, g, col[0] * k, col[1] * k, col[2] * k, R.KEY_DECAL + 2, R.F_UNLIT | FP)) R.emitI(i, col[0] * k * 0.22, col[1] * k * 0.22, col[2] * k * 0.22);
        } else {
          const grate = (ci + cj) % 3 === 0 || (ci - cj) % 4 === 0;
          const k = 0.16 + (1 - u) * 0.08;
          R.setI(i, grate ? G_HASH : G_DOT, 0.38 * k * 2, 0.4 * k * 2, 0.46 * k * 2, R.KEY_DECAL + 2, FP);
        }
      });
      if (open) {
        const ot = F._openT !== undefined ? F._openT : 9;
        R.light(x, y, 14, 170 + Math.max(0, 1.5 - ot) * 160, col[0], col[1], col[2], 1.15 + 0.15 * Math.sin(t * 3));
        // a column of light stands over the open door (readable from across the floor)
        const top = y * TILT - 150 - 12 * Math.sin(t * 1.7);
        for (let py = y * TILT - 6; py > top; py -= CH) {
          const f = (y * TILT - py) / 150, k = (1 - f) * (0.8 + 0.2 * Math.sin(t * 6 - py * 0.2));
          for (let dx = -1; dx <= 1; dx++) {
            const kk = k * (dx ? 0.45 : 1);
            R.glowGlyph(x + dx * CW, py, dx ? G_COLON : (f < 0.5 ? G_PIPE : G_BANG), col[0] * kk, col[1] * kk, col[2] * kk, y + 1, 0.7);
          }
        }
        for (let m = 0; m < 14; m++) { // rising motes
          const ph = (t * 0.5 + m / 14) % 1, ang = m * 2.39996 + t * 0.6, rr = 8 + (m % 5) * 5;
          const k = (1 - ph) * 1.1;
          R.glowGlyph(x + Math.cos(ang) * rr, (y + Math.sin(ang) * rr * 0.6) * TILT - ph * 80, ph < 0.25 ? G_o : G_DOT, col[0] * k, col[1] * k, col[2] * k, y + 30, 0.8);
        }
        if (ot < 1.6) { // opening shockwave
          const rr = 40 + ot * 260, k = (1 - ot / 1.6) * 1.2;
          R.ring(x, y, rr, 10, (i, u, ci, cj) => { if (M.hash2(ci, cj) < 0.6 && R.setI(i, G_DOT, col[0] * k, col[1] * k, col[2] * k, R.KEY_DECAL + 4, R.F_UNLIT)) R.emitI(i, col[0] * k * 0.3, col[1] * k * 0.3, col[2] * k * 0.3); });
        }
      } else R.light(x, y, 6, 70, col[0], col[1], col[2], 0.12 + 0.05 * Math.sin(t * 1.2));
    },

    chest(o, F, t) {
      if (o.hidden) return;
      const open = o.used || o.open, px = o.x, py = o.y * TILT, key = o.y + 1;
      const rare = o.rare, wood = rare ? [0.55, 0.38, 0.17] : [0.48, 0.29, 0.14], metal = rare ? [1.05, 0.82, 0.36] : [0.62, 0.62, 0.68];
      R.shadowEllipse(o.x, o.y + 2, 22, 9, 0.65);
      const lines = open ? [' .-------. ', ' |\\     /| ', ' |*o.*.o*| ', ' |_______| '] : ['  _______  ', ' /=======\\ ', ' |==[o]==| ', ' |_______| '];
      if (open && o._openAt === undefined) o._openAt = World.t;
      const glow = open ? Math.max(0, 1 - (World.t - o._openAt) / 6) : 0;
      drawLines(px, py, lines, (c, ch, x, y) => {
        if (!open && (ch === 'o' || ch === '[' || ch === ']')) { const k = (ch === 'o' ? 1.0 : 0.75) * (0.9 + 0.3 * Math.sin(t * 2.5)); c[0] = metal[0] * k * 1.2; c[1] = metal[1] * k * 1.1; c[2] = metal[2] * k * 0.7; c.e = ch === 'o' ? 0.4 : 0; return; }
        if (open && y === 2 && x > 1 && x < 9) { const k = 0.3 + glow * 1.2; c[0] = 1.2 * k; c[1] = 0.9 * k; c[2] = 0.35 * k; c.e = glow * 0.6; return; }
        if (open && y === 1 && x > 1 && x < 9) { c[0] = wood[0] * 0.35; c[1] = wood[1] * 0.35; c[2] = wood[2] * 0.35; return; }
        const isMetal = !open && (ch === '=' || ((ch === '|' || ch === '/' || ch === '\\') && y === 1));
        const b = isMetal ? metal : wood;
        const v = (y <= 1 ? 1.05 : 0.8) * (x >= 6 ? 1.15 : 0.85);
        c[0] = b[0] * v; c[1] = b[1] * v; c[2] = b[2] * v;
      }, key, 0);
      if (!open) {
        if (Math.sin(t * 1.7 + o.x) > 0.93 || rare) R.glowGlyph(px + CW * 3, py - CH * 3, G_STAR, rare ? 1.2 : 0.9, rare ? 1.0 : 0.9, rare ? 0.5 : 0.8, key + 0.1, 0.6);
        if (rare) R.light(o.x, o.y, 10, 70, 1.0, 0.8, 0.4, 0.4);
      } else if (glow > 0) R.light(o.x, o.y, 14, 90, 1.0, 0.75, 0.35, glow);
    },

    shrine(o, F, t) {
      const spent = o.used, B = F.biome, col = B.shrine, px = o.x, py = o.y * TILT, key = o.y;
      R.shadowEllipse(o.x, o.y + 2, 24, 10, 0.55);
      const stone = [0.46, 0.46, 0.52];
      const L = ['    /^\\    ', '   |(o)|   ', '   | = |   ', '   | : |   ', '   | = |   ', '   |   |   ', '  _|___|_  ', ' /_______\\ '];
      drawLines(px, py, L, (c, ch, x, y) => {
        if (ch === 'o' || (ch === '=' && y < 5) || ch === ':') {
          if (spent) { c[0] = 0.16; c[1] = 0.16; c[2] = 0.17; return; }
          const k = (ch === 'o' ? 1.0 : 0.55) * (0.75 + 0.35 * Math.sin(t * 2 - y * 0.8));
          c[0] = col[0] * k; c[1] = col[1] * k; c[2] = col[2] * k; c.e = ch === 'o' ? 0.7 : 0.35; return;
        }
        const v = (spent ? 0.55 : 1) * (0.5 + (x >= 6 ? 0.42 : 0.12) + (y === 0 ? 0.15 : 0)) * (0.85 + M.hash2(x, y + (o.x | 0)) * 0.3);
        c[0] = stone[0] * v; c[1] = stone[1] * v; c[2] = stone[2] * v;
      }, key, 0);
      const top = py - CH * L.length;
      if (!spent) {
        const bob = Math.sin(t * 1.8) * 3;
        R.glowGlyph(px, top - 6 + bob, G_AT, col[0] * 1.3, col[1] * 1.3, col[2] * 1.3, key + 0.2, 1.0);
        for (let m = 0; m < 6; m++) { const a = t * 1.2 + m * 1.047; const k = 0.6 + 0.4 * Math.sin(t * 3 + m); R.glowGlyph(px + Math.cos(a) * 15, top - 4 + bob + Math.sin(a) * 6, G_DOT, col[0] * k, col[1] * k, col[2] * k, key + (Math.sin(a) > 0 ? 0.3 : -0.3), 0.5); }
        R.light(o.x, o.y, 40, 140, col[0], col[1], col[2], 0.6 + 0.12 * Math.sin(t * 2));
      } else {
        const ph = (t * 0.3) % 1; R.set(px + Math.sin(t) * 3, top - ph * 30, ph < 0.5 ? G_TILDE : G_DOT, 0.3 * (1 - ph), 0.3 * (1 - ph), 0.32 * (1 - ph), key + 0.2, 0);
      }
    },

    note(o, F, t) {
      if (o.used) return;
      const bob = Math.sin(t * 2.2 + o.x) * 2.5, px = o.x, py = o.y * TILT - 9 + bob;
      R.shadowEllipse(o.x, o.y + 2, 7, 4, 0.35);
      const k = 0.85 + 0.25 * Math.sin(t * 3);
      drawLines(px, py, ['.-.', '|=|', "'-'"], (c, ch) => { const e = ch === '='; c[0] = (e ? 1.0 : 0.85) * k; c[1] = (e ? 0.85 : 0.8) * k; c[2] = (e ? 0.55 : 0.65) * k; c.e = 0.35; }, o.y + 2, R.F_UNLIT);
      R.light(o.x, o.y, 16, 55, 1.0, 0.85, 0.55, 0.35 + 0.1 * Math.sin(t * 3));
    },

    merchant(o, F, t) {
      // Choose Goose's stall: tattered striped awning on poles, a counter of odd wares, a hanging lantern; the goose bobs.
      const px = o.x, base = (o.y - 22) * TILT, key = o.y - 20;
      const red = [0.68, 0.16, 0.14], cream = [0.85, 0.78, 0.64], wood = [0.42, 0.27, 0.15];
      R.shadowEllipse(o.x, o.y - 20, 48, 14, 0.55);
      const H = 100; // awning height (projected px)
      R.seg(px - 40, base, px - 40, base - H, G_PIPE, wood[0], wood[1], wood[2], key - 6, FP);
      R.seg(px + 40, base, px + 40, base - H, G_PIPE, wood[0] * 1.25, wood[1] * 1.25, wood[2] * 1.25, key - 6, FP);
      drawLines(px, base - H + CH * 2, ['_/\\/\\/\\/\\/\\/\\/\\/\\_', '|/\\/\\/\\/\\/\\/\\/\\/\\|', " ' ' ' ' ' ' ' ' ' "], (c, ch, x, y) => {
        const st = ((x >> 1) + y) % 2 === 0; const b = st ? red : cream; const v = (y === 0 ? 1.05 : 0.82) * (0.8 + x / 36) * (0.9 + M.hash2(x, y + 3) * 0.2);
        c[0] = b[0] * v; c[1] = b[1] * v; c[2] = b[2] * v;
      }, key - 5, 0);
      // Choose Goose, behind the counter: the neck pumps on the beat, the head looks about
      const bob = Math.sin(t * 2.6) > 0.3 ? 1 : 0, look = Math.sin(t * 0.9) > 0 ? 1 : 0;
      const head = look ? ['  __  ', ' (o > ', '  ||  '] : ['  __  ', ' < o) ', '  ||  '];
      const body = ['  ||  ', ' /  \\ ', '(    )', ' \\__/ '];
      const gl = bob ? head.concat(['  ||  '], body) : ['      '].concat(head, body);
      drawLines(px - 4, base - CH, gl, (c, ch, x, y) => {
        if (ch === '>' || ch === '<') { c[0] = 1.05; c[1] = 0.58; c[2] = 0.16; return; }
        if (ch === 'o') { c[0] = 0.04; c[1] = 0.04; c[2] = 0.05; return; }
        const v = 0.85 + (x >= 3 ? 0.15 : 0); c[0] = 0.95 * v; c[1] = 0.94 * v; c[2] = 0.9 * v;
      }, key - 3, 0);
      // little red scarf at the base of the neck
      R.set(px - 4 - 2, base - CH * 5 + (bob ? 0 : CH), G_TILDE, 0.85, 0.16, 0.13, key - 2.9, FP);
      R.set(px - 4 + 3, base - CH * 5 + (bob ? 0 : CH), G_TILDE, 0.75, 0.14, 0.12, key - 2.9, FP);
      // counter of wares
      drawLines(px, base + 3, ['[o*!%=@o$!%]', '|__________|'], (c, ch, x, y) => {
        if (y === 0 && x > 0 && x < 11) { const h = M.hash2(x, 17); const k = 0.75 + 0.3 * Math.sin(t * 2 + x); c[0] = (h < 0.33 ? 1.0 : h < 0.66 ? 0.5 : 0.75) * k; c[1] = (h < 0.33 ? 0.72 : h < 0.66 ? 0.92 : 0.5) * k; c[2] = (h < 0.33 ? 0.3 : h < 0.66 ? 0.55 : 1.0) * k; return; }
        const v = y === 0 ? 1.1 : 0.8; c[0] = wood[0] * v * 1.3; c[1] = wood[1] * v * 1.3; c[2] = wood[2] * v * 1.3;
      }, key, 0);
      // hanging lantern
      const fl = 0.85 + 0.15 * Math.sin(t * 7) * Math.sin(t * 3.3), sw = Math.sin(t * 1.4) * 1.5;
      R.seg(px + 30, base - H + CH * 2, px + 30 + sw, base - H + CH * 4, G_PIPE, 0.3, 0.28, 0.25, key - 4, FP);
      R.glowGlyph(px + 30 + sw, base - H + CH * 5, G_o, 1.35 * fl, 0.95 * fl, 0.45 * fl, key - 4, 0.9);
      R.light(o.x + 30, o.y - 22, 60, 140, 1.0, 0.72, 0.36, 0.8 * fl);
    },
  };

  // ================================================================== story remnants (ghostly NPC sprites, DESIGN §9D)
  // Original homage figures, drawn as shimmering remnants: rows slip sideways now and then, glyphs flicker out, a soft
  // coloured light and rising motes. Bottom-centre anchored on the interactable. pal(out, ch, x, y, w, h, t) → rgb (+ out.e).
  const STORY_NPC = ['billy', 'pepbut', 'simon', 'herald', 'prismo'];
  const STORY_NAME = { billy: "Billy's Ghost", pepbut: 'Peppermint Butler', simon: 'An Echo of Simon', herald: "The Flame King's Herald", prismo: 'Prismo' };
  const SPRITES = {
    billy: { // a huge ghostly hero: headband, a great beard pouring down his chest, fists like boulders
      light: [0.55, 0.75, 1.1], lr: 130, gain: 1.75,
      lines: [
        '         ,----.         ',
        '        / ==== \\        ',
        '       |  o  o  |       ',
        '       |   /\\   |       ',
        '     __ \\ \\||/ / __     ',
        '    /  \\ \\\\||// /  \\    ',
        '   / /\\ \\\\\\||/// /\\ \\   ',
        '  / /  \\ \\\\||// /  \\ \\  ',
        ' (_/    \\ \\||/ /    \\_) ',
        '         \\ \\/ /         ',
        '         |\\  /|         ',
        '         | \\/ |         ',
        '         |    |         ',
        '        /  /\\  \\        ',
        '       /  /  \\  \\       ',
        '      /__/    \\__\\      ',
      ],
      pal(o, ch, x, y, w, h, t) {
        if (ch === 'o' && y === 2) { o[0] = 0.6; o[1] = 1.1; o[2] = 1.4; o.e = 0.6; return; }
        if (ch === '=' && y === 1) { o[0] = 0.9; o[1] = 0.8; o[2] = 0.5; o.e = 0.25; return; }
        const beard = y >= 4 && y <= 11 && x >= 7 && x <= 16;
        const v = beard ? 1.0 : 0.62 + (x > w / 2 ? 0.14 : 0);
        o[0] = 0.62 * v; o[1] = 0.8 * v; o[2] = 1.08 * v; o.e = beard ? 0.3 : 0.18;
      },
    },
    pepbut: { // a small peppermint butler: a candy swirl of a head, a neat little tailcoat
      light: [1.0, 0.55, 0.6], lr: 90, gain: 1.25,
      lines: [
        '   .-"""-.   ',
        '  / \\ | / \\  ',
        ' |-- o o --| ',
        '  \\ / v \\ /  ',
        "   '-._.-'   ",
        '    /|=|\\    ',
        '   / |=| \\   ',
        '     | |     ',
        '    _| |_    ',
      ],
      pal(o, ch, x, y) {
        if (ch === 'o' && y === 2) { o[0] = 1.1; o[1] = 0.25; o[2] = 0.3; o.e = 0.5; return; }
        if (y >= 1 && y <= 3 && (ch === '\\' || ch === '/' || ch === '|' || ch === '-')) { o[0] = 1.0; o[1] = 0.22; o[2] = 0.26; o.e = 0.25; return; } // the swirl
        if (y <= 4) { o[0] = 0.98; o[1] = 0.9; o[2] = 0.92; o.e = 0.22; return; }
        if (ch === '=') { o[0] = 0.9; o[1] = 0.88; o[2] = 0.86; o.e = 0.15; return; }
        o[0] = 0.32; o[1] = 0.3; o[2] = 0.42; o.e = 0.15; // the tailcoat, a ghost of black
      },
    },
    simon: { // a faint man in a long coat, glasses glinting; his shadow on the ground wears a crown
      light: [0.55, 0.68, 0.95], lr: 100, crown: true, gain: 1.9,
      lines: [
        '     ____     ',
        '    /    \\    ',
        '   | o--o |   ',
        '   |   >  |   ',
        '    \\  ~ /    ',
        '   __|  |__   ',
        '  /        \\  ',
        ' / /|    |\\ \\ ',
        ' \\/ |    | \\/ ',
        '    |    |    ',
        '    |    |    ',
        '    | /\\ |    ',
        '    |/  \\|    ',
        '    /    \\    ',
        '   /_    _\\   ',
      ],
      pal(o, ch, x, y) {
        if (y === 2 && (ch === 'o' || ch === '-')) { o[0] = 0.95; o[1] = 1.0; o[2] = 1.1; o.e = 0.45; return; } // the glasses
        const v = 0.72 + (x > 6 ? 0.14 : 0) - y * 0.012;
        o[0] = 0.6 * v; o[1] = 0.7 * v; o[2] = 0.95 * v; o.e = 0.22;
      },
    },
    herald: { // the Flame King's herald: hair of fire, a long horn raised, an ember tabard
      light: [1.2, 0.55, 0.2], lr: 140,
      lines: [
        '      (  )           ',
        '     ( )( )          ',
        '      \\||/           ',
        '     .-""-.          ',
        '     |o  o|          ',
        '     | -- |===--==<) ',
        "     '-..-'          ",
        '    /|####|\\         ',
        '   / |####| \\        ',
        '     |####|          ',
        '     |____|          ',
        '     /    \\          ',
        '    /_/  \\_\\         ',
      ],
      pal(o, ch, x, y, w, h, t) {
        if (y <= 2) { const f = 0.6 + 0.4 * Math.sin(t * 9 + x * 1.7 + y); o[0] = 1.5 * f; o[1] = (0.55 + y * 0.12) * f; o[2] = 0.12 * f; o.e = 0.7; return; } // flame hair
        if (y === 5 && x >= 11) { o[0] = 1.1; o[1] = 0.82; o[2] = 0.3; o.e = 0.35; return; } // the horn
        if (ch === 'o' && y === 4) { o[0] = 1.4; o[1] = 0.9; o[2] = 0.3; o.e = 0.6; return; }
        if (ch === '#') { const f = 0.7 + 0.3 * Math.sin(t * 2.5 + y); o[0] = 0.85 * f; o[1] = 0.28 * f; o[2] = 0.1 * f; o.e = 0.3; return; }
        o[0] = 0.75; o[1] = 0.42; o[2] = 0.3; o.e = 0.2;
      },
    },
    prismo: { // a pickle-ish figure in a cube of light
      light: [0.9, 0.85, 1.25], lr: 150,
      lines: [
        '     ____________  ',
        '    /           /| ',
        '   /___________/ | ',
        '   |           | | ',
        '   |   .--.    | | ',
        '   |  ( oo )   | | ',
        '   |  ( -- )   | | ',
        '   |  (:  :)   | | ',
        '   |  ( :  )   | | ',
        "   |   '--'    | / ",
        '   |___________|/  ',
      ],
      pal(o, ch, x, y, w, h, t) {
        const inside = x > 4 && x < 14 && y > 3 && y < 10;
        if (inside) {
          if (ch === 'o') { o[0] = 0.08; o[1] = 0.12; o[2] = 0.06; return; }
          const v = 0.8 + 0.2 * Math.sin(t * 1.3 + y * 0.6); o[0] = 0.42 * v; o[1] = 0.88 * v; o[2] = 0.32 * v; o.e = 0.25; return; // the pickle
        }
        const k = 0.75 + 0.25 * Math.sin(t * 2.2 - x * 0.4 - y * 0.6); o[0] = 0.95 * k; o[1] = 0.9 * k; o[2] = 1.25 * k; o.e = 0.55; // the cube of light
      },
    },
  };

  // ================================================================== generation
  function newFloor(o, biomeId, w, h) {
    const biome = BIOMES[biomeId];
    const cols = Math.ceil(w / CW), rows = Math.ceil(h / RW), n = cols * rows;
    return {
      biomeId, biome, act: o.act || 1, inAct: o.inAct || 1, isBoss: !!o.isBoss && !o.title, bossId: o.bossId || null, seed: (o.seed >>> 0) || 1,
      ascension: o.ascension || 0, isTitle: !!o.title,
      w, h, cols, rows,
      type: new Uint8Array(n), shade: new Float32Array(n), shadow: new Float32Array(n), solid: new Uint8Array(n), shoreD: new Uint8Array(n),
      h1: new Float32Array(n), h2: new Float32Array(n), n1: new Float32Array(n), aux: new Float32Array(n), aux2: new Float32Array(n),
      cls: new Uint8Array(n), g: new Uint8Array(n), c: new Float32Array(n * 3), e: new Float32Array(n),
      props: [], spawns: [], interactables: [], lights: [], titleSpots: [],
      start: { x: w * 0.5, y: h * 0.8 }, exit: { x: w * 0.5, y: h * 0.2 }, exitOpen: false,
      objective: o.isBoss ? { type: 'boss', remaining: 1, done: false } : { type: 'elite', remaining: 1, done: false },
      ambient: biome.ambient.slice(), nav: null, liqSides: '',
    };
  }

  const Gen = {
    // --- per-cell base fields + realm terrain
    cells(F, rng) {
      const { cols, rows } = F, sx = rng.int(0, 4000), sy = rng.int(0, 4000);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        F.h1[k] = M.hash2(i + sx, j + sy); F.h2[k] = M.hash2(i + 911 + sx, j - 377 + sy); F.n1[k] = M.noise2(i * 0.15, j * 0.4);
      }
    },

    terrain(F, rng, edgeFn) {
      const id = F.biomeId, { w, h, cols, rows } = F, B = F.biome;
      const ox = rng.range(0, 1000), oy = rng.range(0, 1000), ox2 = rng.range(0, 1000), oy2 = rng.range(0, 1000);
      for (let j = 0; j < rows; j++) {
        const y = (j + 0.5) * RW;
        for (let i = 0; i < cols; i++) {
          const k = j * cols + i, x = (i + 0.5) * CW;
          const sn = M.fbm(x * 0.011 + ox + 50, y * 0.011 + oy - 30, 4);
          F.shade[k] = sn;
          let t = edgeFn(x, y, ox, oy);
          if (t === T.GRASS) {
            if (sn > 0.64) t = T.STONE;
            if (id === 'grass') { if (!F.isBoss && M.fbm(x * 0.0045 + ox2, y * 0.0045 + oy2, 3) > 0.72) t = T.WATER; }
            else if (id === 'candy') { if (M.fbm(x * 0.013 + ox2, y * 0.013 + oy2, 3) > 0.69) t = T.POOL; }
            else if (id === 'ice') {
              const ln = M.fbm(x * 0.0035 + ox2, y * 0.0035 + oy2, 3);
              if (ln > 0.6) {
                t = T.POOL;
                if (!F.isBoss && ln > 0.68 && M.fbm(x * 0.02 + ox, y * 0.02 + oy, 2) > 0.66) t = T.WATER;
                else if (Math.abs(M.fbm(x * 0.012 + ox2, y * 0.016 + oy, 3) - 0.5) < 0.012) F.aux2[k] = 1; // ice crack
              }
            } else if (id === 'fire') {
              if (!F.isBoss && M.fbm(x * 0.004 + ox2, y * 0.004 + oy2, 3) > 0.7) t = T.WATER;
              else if (Math.abs(M.fbm(x * 0.0055 + ox, y * 0.0075 + oy2, 4) - 0.5) < 0.0095 && M.fbm(x * 0.003 + oy, y * 0.003 + ox, 2) > 0.42) t = T.CRACK;
            } else if (id === 'well') {
              if (!F.isBoss && M.fbm(x * 0.005 + ox2, y * 0.005 + oy2, 3) > 0.72) t = T.CHASM;
              else if (t === T.STONE && Math.abs(M.fbm(x * 0.02 + ox, y * 0.026 + oy, 3) - 0.5) < 0.02) t = T.CRACK;
            }
          }
          F.type[k] = t;
        }
      }
    },

    // field edge: irregular band of the realm's wall, with liquid sides (shore / lava sea / void)
    fieldEdge(F) {
      const B = F.biome, w = F.w, h = F.h, liq = F.liqSides;
      return (x, y, ox, oy) => {
        let side = 'N', dm = y;
        if (h - y < dm) { dm = h - y; side = 'S'; } if (x < dm) { dm = x; side = 'W'; } if (w - x < dm) { dm = w - x; side = 'E'; }
        if (dm > 260) return T.GRASS;
        const isL = liq.indexOf(side) >= 0;
        const e = dm + (M.fbm(x * 0.006 + ox, y * 0.006 + oy, 3) - 0.5) * 220;
        if (e < (isL ? 120 : 40)) return isL ? B.edgeLiq : B.edgeWall;
        return T.GRASS;
      };
    },

    // set cells within a world ellipse; fn(k, u) decides
    disk(F, x, y, rx, ry, fn) {
      const j0 = Math.max(0, Math.floor((y - ry) / RW)), j1 = Math.min(F.rows - 1, Math.floor((y + ry) / RW));
      const i0 = Math.max(0, Math.floor((x - rx) / CW)), i1 = Math.min(F.cols - 1, Math.floor((x + rx) / CW));
      for (let j = j0; j <= j1; j++) {
        const dy = ((j + 0.5) * RW - y) / ry;
        for (let i = i0; i <= i1; i++) { const dx = ((i + 0.5) * CW - x) / rx, u = dx * dx + dy * dy; if (u <= 1) fn(j * F.cols + i, Math.sqrt(u)); }
      }
    },

    // stamp a polyline band; fn(k, along, across[-1..1])
    path(F, pts, width, fn) {
      let acc = 0; const hw = width / 2;
      for (let s = 0; s + 1 < pts.length; s++) {
        const [ax, ay] = pts[s], [bx, by] = pts[s + 1];
        const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
        const j0 = Math.max(0, Math.floor((Math.min(ay, by) - hw) / RW)), j1 = Math.min(F.rows - 1, Math.floor((Math.max(ay, by) + hw) / RW));
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw) / CW)), i1 = Math.min(F.cols - 1, Math.floor((Math.max(ax, bx) + hw) / CW));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const px = (i + 0.5) * CW - ax, py = (j + 0.5) * RW - ay;
          const tt = (px * dx + py * dy) / (L * L); if (tt < 0 || tt > 1) continue;
          const ac = px * nx + py * ny; if (Math.abs(ac) > hw) continue;
          fn(j * F.cols + i, acc + tt * L, ac / hw);
        }
        acc += L;
      }
    },
    wavyLine(rng, x0, y0, x1, y1, n, amp) {
      const pts = [], dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), nx = -dy / L, ny = dx / L;
      let off = 0;
      for (let s = 0; s <= n; s++) { const t = s / n; off = s === 0 || s === n ? 0 : M.clamp(off + rng.range(-amp, amp), -amp * 1.5, amp * 1.5); pts.push([x0 + dx * t + nx * off, y0 + dy * t + ny * off]); }
      return pts;
    },

    isEdge(F, k) { const t = F.type[k]; return t === T.THICKET || isLiquidT(t); },

    // ---- realm features
    features(F, rng) {
      const id = F.biomeId, w = F.w, h = F.h;
      const horiz = rng.chance(0.5);
      const crossPts = (wob) => horiz ? Gen.wavyLine(rng, -40, rng.range(h * 0.25, h * 0.75), w + 40, rng.range(h * 0.25, h * 0.75), 8, wob) : Gen.wavyLine(rng, rng.range(w * 0.25, w * 0.75), -40, rng.range(w * 0.25, w * 0.75), h + 40, 8, wob);
      if (id === 'grass' && rng.chance(0.7)) {
        // the old highway: broken asphalt with faded lane marks, half-swallowed by grass
        const pts = crossPts(60), bo = rng.range(0, 100);
        F.road = pts;
        Gen.path(F, pts, 62, (k, along, across) => {
          const t = F.type[k]; if (t !== T.GRASS && t !== T.STONE) return;
          if (M.fbm(along * 0.006 + bo, 3.3, 2) < 0.34) return; // buried stretch
          F.type[k] = T.DIRT; F.aux[k] = along; F.aux2[k] = across;
        });
      } else if (id === 'candy') {
        // cobbled streets crossing at a plaza
        const a = Gen.wavyLine(rng, -40, rng.range(h * 0.3, h * 0.7), w + 40, rng.range(h * 0.3, h * 0.7), 6, 30);
        const b = Gen.wavyLine(rng, rng.range(w * 0.3, w * 0.7), -40, rng.range(w * 0.3, w * 0.7), h + 40, 6, 30);
        F.roads = [a, b];
        for (const pts of F.roads) Gen.path(F, pts, rng.range(52, 66), (k, along, across) => { const t = F.type[k]; if (Gen.isEdge(F, k)) return; if (t === T.POOL && Math.abs(across) < 0.6) return; F.type[k] = T.DIRT; F.aux[k] = along; F.aux2[k] = across; });
      } else if (id === 'fire' && rng.chance(0.65)) {
        // a lava river, crossed by cooled-crust causeways
        const pts = crossPts(70); const L = pts.reduce((s, p, q) => s + (q ? Math.hypot(p[0] - pts[q - 1][0], p[1] - pts[q - 1][1]) : 0), 0);
        const b1 = L * rng.range(0.25, 0.4), b2 = L * rng.range(0.6, 0.78);
        Gen.path(F, pts, rng.range(34, 48), (k, along) => {
          if (Gen.isEdge(F, k) && F.type[k] !== T.WATER) return;
          if (Math.abs(along - b1) < 26 || Math.abs(along - b2) < 26) { F.type[k] = T.DIRT; return; }
          F.type[k] = T.WATER;
        });
      } else if (id === 'well' && rng.chance(0.6)) {
        // a rift of void cutting across, bridged by bone
        const pts = crossPts(80); const L = pts.reduce((s, p, q) => s + (q ? Math.hypot(p[0] - pts[q - 1][0], p[1] - pts[q - 1][1]) : 0), 0);
        const b1 = L * rng.range(0.3, 0.45), b2 = L * rng.range(0.6, 0.75);
        Gen.path(F, pts, rng.range(40, 60), (k, along) => {
          if (Math.abs(along - b1) < 22 || Math.abs(along - b2) < 22) { if (F.type[k] === T.CHASM || !Gen.isEdge(F, k)) F.type[k] = T.DIRT; return; }
          if (!Gen.isEdge(F, k) || F.type[k] === T.CHASM) F.type[k] = T.CHASM;
        });
      }
    },

    clearStart(F, r) {
      const s = F.start;
      Gen.disk(F, s.x, s.y, r, r, (k) => { const t = F.type[k]; if (t !== T.STONE && t !== T.DIRT && t !== T.GRASS) { F.type[k] = T.GRASS; F.aux2[k] = 0; } });
    },

    // ---- prop scatter
    typeOK(F, x, y, allow) { const k = cellK(F, x, y); return k >= 0 && ((allow >> F.type[k]) & 1) === 1; },
    spotOK(F, x, y, rad, allow, gap, startR) {
      if (x < 80 || y < 80 || x > F.w - 80 || y > F.h - 80) return false;
      if (!Gen.typeOK(F, x, y, allow) || !Gen.typeOK(F, x - rad, y, allow) || !Gen.typeOK(F, x + rad, y, allow) || !Gen.typeOK(F, x, y - rad * 0.6, allow) || !Gen.typeOK(F, x, y + rad * 0.6, allow)) return false;
      if (M.dist(x, y, F.start.x, F.start.y) < (startR === undefined ? 200 : startR) + rad) return false;
      for (const p of F.props) if (M.dist(x, y, p.x, p.y) < rad + p.rad + gap) return false;
      return true;
    },
    scatter(F, rng, n, make, o) {
      o = o || {};
      const allow = o.allow || ((1 << T.GRASS) | (1 << T.STONE)), gap = o.gap === undefined ? 30 : o.gap;
      let placed = 0;
      for (let tries = 0; tries < n * 40 && placed < n; tries++) {
        const x = o.near ? o.near[0] + rng.range(-o.spread, o.spread) : rng.range(90, F.w - 90);
        const y = o.near ? o.near[1] + rng.range(-o.spread * 0.7, o.spread * 0.7) : rng.range(90, F.h - 90);
        const p = make(rng, x, y);
        if (!Gen.spotOK(F, x, y, p.rad, allow, gap, o.startR)) continue;
        F.props.push(p); placed++;
        if (o.after) o.after(p);
      }
      return placed;
    },

    props(F, rng) {
      const id = F.biomeId, A = (1 << T.GRASS) | (1 << T.STONE), AD = A | (1 << T.DIRT);
      if (id === 'grass') {
        // monoliths, single and in clusters
        Gen.scatter(F, rng, rng.int(7, 10), (r, x, y) => P.monolith(r, x, y), { gap: 70, after: (p) => { if (rng.chance(0.4)) Gen.scatter(F, rng, rng.int(1, 2), (r, x, y) => P.monolith(r, x, y), { near: [p.x, p.y], spread: 110, gap: 8 }); } });
        // dead trees: groves and loners
        Gen.scatter(F, rng, rng.int(4, 6), (r, x, y) => P.tree(r, x, y, 'dead'), { gap: 40, after: (p) => Gen.scatter(F, rng, rng.int(1, 3), (r, x, y) => P.tree(r, x, y, 'dead'), { near: [p.x, p.y], spread: 90, gap: 10 }) });
        // graveyards of the Mushroom War dead
        for (let g = rng.int(1, 2); g > 0; g--) Gen.graveyard(F, rng);
        Gen.scatter(F, rng, rng.int(3, 6), (r, x, y) => P.grave(r, x, y), { gap: 30 });
        // pre-war wreckage along the highway
        if (F.road) Gen.roadside(F, rng, F.road);
      } else if (id === 'candy') {
        Gen.scatter(F, rng, rng.int(5, 7), (r, x, y) => P.cane(r, x, y), { gap: 60, after: (p) => { if (rng.chance(0.35)) Gen.scatter(F, rng, 1, (r, x, y) => P.cane(r, x, y), { near: [p.x, p.y], spread: 80, gap: 10 }); } });
        Gen.scatter(F, rng, rng.int(5, 8), (r, x, y) => P.ginger(r, x, y), { gap: 50 });
        // gumdrop tomb yards
        for (let g = rng.int(2, 3); g > 0; g--) {
          const c = Gen.findOpen(F, rng, 120);
          if (c) Gen.scatter(F, rng, rng.int(4, 7), (r, x, y) => P.gumdrop(r, x, y), { near: c, spread: 140, gap: 14 });
        }
        Gen.scatter(F, rng, rng.int(3, 5), (r, x, y) => P.gumdrop(r, x, y), { gap: 40 });
        Gen.scatter(F, rng, rng.int(2, 4), (r, x, y) => P.tree(r, x, y, 'candy'), { gap: 40 });
        for (const road of F.roads || []) Gen.lampsAlong(F, rng, road);
      } else if (id === 'ice') {
        const IA = A | (1 << T.POOL);
        Gen.scatter(F, rng, rng.int(9, 13), (r, x, y) => P.spire(r, x, y), { gap: 50, allow: IA });
        Gen.scatter(F, rng, rng.int(6, 10), (r, x, y) => Object.assign(P.boulder(r, x, y), { snowcap: true, col: [0.36, 0.44, 0.58] }), { gap: 30, allow: IA });
        Gen.scatter(F, rng, rng.int(4, 7), (r, x, y) => P.tree(r, x, y, 'frozen'), { gap: 40 });
        Gen.scatter(F, rng, rng.int(2, 4), (r, x, y) => P.penguin(r, x, y), { gap: 40, allow: IA });
      } else if (id === 'fire') {
        const FA = A | (1 << T.CRACK);
        Gen.scatter(F, rng, rng.int(8, 11), (r, x, y) => P.basalt(r, x, y), { gap: 50, allow: FA });
        Gen.scatter(F, rng, rng.int(6, 9), (r, x, y) => Object.assign(P.spire(r, x, y, { kind: 'shard', n: rng.int(1, 3), scale: 0.7 }), { dark: [0.04, 0.03, 0.06], lit: [0.4, 0.28, 0.56], fill: GL.obsid, glow: false }), { gap: 40, allow: FA });
        Gen.scatter(F, rng, rng.int(4, 6), (r, x, y) => P.tree(r, x, y, 'charred'), { gap: 40, allow: FA });
        Gen.scatter(F, rng, rng.int(3, 5), (r, x, y) => P.brazier(r, x, y, 'orange'), { gap: 120, allow: FA });
      } else if (id === 'well') {
        Gen.scatter(F, rng, rng.int(6, 8), (r, x, y) => P.brazier(r, x, y, 'green'), { gap: 140 });
        Gen.scatter(F, rng, rng.int(1, 2), (r, x, y) => P.ribs(r, x, y), { gap: 60 });
        Gen.scatter(F, rng, rng.int(5, 7), (r, x, y) => P.obelisk(r, x, y), { gap: 70 });
        Gen.scatter(F, rng, rng.int(6, 9), (r, x, y) => Object.assign(P.spire(r, x, y, { kind: 'bonespike', n: rng.int(2, 4), scale: 0.6 }), { dark: [0.22, 0.21, 0.18], lit: [0.82, 0.8, 0.7], fill: GL.bone, glow: false }), { gap: 40 });
        Gen.scatter(F, rng, rng.int(7, 11), (r, x, y) => P.skulls(r, x, y), { gap: 24 });
      }
      // vista: a few signature set-pieces always frame the arrival point (in view, outside the clear zone)
      const sig = {
        grass: [(r, x, y) => P.monolith(r, x, y, { fallen: false }), (r, x, y) => P.tree(r, x, y, 'dead'), (r, x, y) => P.monolith(r, x, y)],
        candy: [(r, x, y) => P.cane(r, x, y), (r, x, y) => P.gumdrop(r, x, y), (r, x, y) => P.gumdrop(r, x, y)],
        ice: [(r, x, y) => P.spire(r, x, y, { n: r.int(3, 5) }), (r, x, y) => P.spire(r, x, y, { n: r.int(2, 4), scale: 0.8 }), (r, x, y) => P.tree(r, x, y, 'frozen')],
        fire: [(r, x, y) => P.basalt(r, x, y), (r, x, y) => P.basalt(r, x, y), (r, x, y) => P.tree(r, x, y, 'charred')],
        well: [(r, x, y) => P.obelisk(r, x, y), (r, x, y) => Object.assign(P.spire(r, x, y, { kind: 'bonespike', n: r.int(2, 4), scale: 0.6 }), { dark: [0.22, 0.21, 0.18], lit: [0.82, 0.8, 0.7], fill: GL.bone, glow: false }), (r, x, y) => P.skulls(r, x, y)],
      }[id];
      const near = F.props.filter((p) => (p.h >= 60 || p.kind === 'gumdrop' || p.kind === 'basalt') && p.kind !== 'lamp' && Math.abs(p.x - F.start.x) < 500 && Math.abs(p.y - F.start.y) < 360).length;
      for (let v = 0, placed = 0; v < 80 && placed < Math.max(0, 3 - near); v++) {
        const a = rng.range(0, Math.PI * 2), d = rng.range(230, 430);
        const x = F.start.x + Math.cos(a) * d * 1.25, y = F.start.y + Math.sin(a) * d * 0.85;
        const p = sig[placed % sig.length](rng, x, y);
        if (!Gen.spotOK(F, x, y, p.rad, (1 << T.GRASS) | (1 << T.STONE), 40, 170)) continue;
        F.props.push(p); placed++;
      }
      // the last campfire, by the arrival point (fire realm needs none; the Well gets witchfire)
      const s = F.start;
      if (id === 'well') { F.props.push(P.brazier(rng, s.x - 70, s.y - 20, 'green')); F.props.push(P.brazier(rng, s.x + 70, s.y - 20, 'green')); }
      else if (id !== 'fire') F.props.push(P.campfire(rng, s.x - 46, s.y - 34));
    },

    findOpen(F, rng, rad) {
      for (let n = 0; n < 200; n++) { const x = rng.range(200, F.w - 200), y = rng.range(200, F.h - 200); if (Gen.spotOK(F, x, y, rad, (1 << T.GRASS) | (1 << T.STONE), 20)) return [x, y]; }
      return null;
    },
    graveyard(F, rng) { const c = Gen.findOpen(F, rng, 110); if (c) Gen.graveyardAt(F, rng, c); },
    graveyardAt(F, rng, c) {
      const rows = rng.int(2, 3), per = rng.int(3, 5), ang = rng.range(-0.15, 0.15);
      for (let r = 0; r < rows; r++) for (let q = 0; q < per; q++) {
        if (rng.chance(0.18)) continue;
        const lx = (q - (per - 1) / 2) * 34 + rng.range(-5, 5), ly = (r - (rows - 1) / 2) * 30 + rng.range(-4, 4);
        const x = c[0] + lx * Math.cos(ang) - ly * Math.sin(ang), y = c[1] + lx * Math.sin(ang) + ly * Math.cos(ang);
        const p = P.grave(rng, x, y);
        if (Gen.spotOK(F, x, y, 8, (1 << T.GRASS) | (1 << T.STONE), 2)) F.props.push(p);
      }
      const t = P.tree(rng, c[0] + rng.range(-90, 90), c[1] - 70);
      if (Gen.spotOK(F, t.x, t.y, t.rad, (1 << T.GRASS) | (1 << T.STONE), 6)) F.props.push(t);
    },
    roadside(F, rng, pts) {
      const n = pts.length - 1;
      for (let c = rng.int(2, 4); c > 0; c--) {
        const s = rng.int(1, n - 1), t = rng.next(), a = pts[s], b = pts[s + 1];
        const x = a[0] + (b[0] - a[0]) * t + rng.range(-20, 20), y = a[1] + (b[1] - a[1]) * t + rng.range(-10, 10);
        const p = P.car(rng, x, y);
        if (Gen.spotOK(F, x, y, p.rad, (1 << T.GRASS) | (1 << T.STONE) | (1 << T.DIRT), 20)) F.props.push(p);
      }
      for (let c = rng.int(2, 3); c > 0; c--) {
        const s = rng.int(1, n - 1), a = pts[s], b = pts[s + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const side = rng.sign(), x = a[0] + (-(b[1] - a[1]) / L) * 44 * side, y = a[1] + ((b[0] - a[0]) / L) * 44 * side;
        const p = P.sign(rng, x, y);
        if (Gen.spotOK(F, x, y, p.rad, (1 << T.GRASS) | (1 << T.STONE) | (1 << T.DIRT), 10)) F.props.push(p);
      }
    },
    lampsAlong(F, rng, pts) {
      let acc = 0, next = rng.range(60, 140), side = 1;
      for (let s = 0; s + 1 < pts.length; s++) {
        const a = pts[s], b = pts[s + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
        while (next < acc + L) {
          const t = (next - acc) / L, x = a[0] + (b[0] - a[0]) * t + nx * 38 * side, y = a[1] + (b[1] - a[1]) * t + ny * 38 * side;
          const p = P.lamp(rng, x, y);
          if (Gen.spotOK(F, x, y, p.rad, (1 << T.GRASS) | (1 << T.STONE) | (1 << T.DIRT), 10, 120)) F.props.push(p);
          next += rng.range(170, 260); side = -side;
        }
        acc += L;
      }
    },

    // ---- solids
    bakeSolid(F) {
      const n = F.cols * F.rows, S = F.solid;
      for (let k = 0; k < n; k++) { const t = F.type[k]; S[k] = t === T.THICKET ? S_WALL : isLiquidT(t) ? S_LIQ : 0; }
      for (const p of F.props) Gen.propSolid(F, p);
    },
    propSolid(F, p) {
      const set = (x, y) => { const k = cellK(F, x, y); if (k >= 0) F.solid[k] |= S_WALL; };
      const foot = p.foot || 'box';
      if (foot === 'none') {
        if (p.kind === 'ribs') { const x0 = p.x - p.w / 2; for (let r = 0; r < p.n; r++) { const rx = x0 + (r + 0.5) * (p.w / p.n) + 6 * p.dir; set(rx, p.y - p.d / 2 * 0.9); set(rx, p.y + p.d / 2 * 0.9); } set(p.dir > 0 ? x0 + p.w + 8 : x0 - 8, p.y); }
        return;
      }
      if (foot === 'circle') { const r = p.fr || 5; Gen.disk(F, p.x, p.y, Math.max(r, CW * 0.6), Math.max(r, RW * 0.5), (k) => (F.solid[k] |= S_WALL)); return; }
      if (foot === 'ellipse') { Gen.disk(F, p.x, p.y, p.rx * 0.92, p.ry * 0.85, (k) => (F.solid[k] |= S_WALL)); return; }
      if (foot === 'barricade') { if (!p.open) for (let y = p.y - p.d / 2; y <= p.y + p.d / 2 + 0.01; y += RW / 2) for (let x = p.x - p.w / 2; x <= p.x + p.w / 2 + 0.01; x += CW / 2) set(x, y); return; }
      if (foot === 'gate') { for (const sx of [-1, 1]) Gen.disk(F, p.x + sx * p.gap / 2, p.y, p.pw / 2, p.d / 2 + 2, (k) => (F.solid[k] |= S_WALL)); return; }
      if (foot === 'well') { // ring wall + void pit
        Gen.disk(F, p.x, p.y, p.rx + 12, p.ry + 8, (k, u) => { F.solid[k] |= u > 0.82 ? S_WALL : S_LIQ; });
        return;
      }
      const boxes = p.kind === 'basalt' ? p.cols.map((c) => [p.x + c.dx, p.y + c.dy, c.w, c.d]) : p.kind === 'spire' || p.kind === 'shard' || p.kind === 'bonespike' ? p.shards.map((s) => [p.x + s.dx, p.y + s.dy, s.w * 0.85, 10]) : [[p.x, p.y, p.kind === 'brazier' ? p.w * 0.7 : p.w, p.kind === 'brazier' ? p.d * 0.8 : p.d]];
      for (const [bx, by, bw, bd] of boxes) {
        for (let y = by - bd / 2; y <= by + bd / 2 + 0.01; y += RW / 2) for (let x = bx - bw / 2; x <= bx + bw / 2 + 0.01; x += CW / 2) set(Math.min(x, bx + bw / 2 - 0.01), Math.min(y, by + bd / 2 - 0.01));
      }
    },

    // ---- long moon shadows (baked into F.shadow)
    shadowSweep(F, x, y, w, d, h, str, taper) {
      const len = h * 1.25, y1 = y + d / 2, sdx = -0.8, sdy = 0.55;
      for (let s = 0; s < len; s += 3) {
        const fade = 1 - s / len, ww = w * (1 - (taper || 0) * (s / len)), xa = x + sdx * s - ww / 2;
        const a = str * Math.pow(fade, 0.6);
        for (let xx = xa; xx <= xa + ww; xx += CW) {
          for (let dd = -d; dd <= 0; dd += RW) {
            const k = cellK(F, xx, y1 + sdy * s + dd); if (k >= 0 && F.shadow[k] < a) F.shadow[k] = a;
          }
        }
      }
    },
    shadowPoint(F, x, y, z, str, H) {
      const k = cellK(F, x + SHX * z, y + SHY * z); if (k < 0) return;
      const a = str * Math.pow(Math.max(0, 1 - z / (H * 1.5)), 0.5);
      if (F.shadow[k] < a) F.shadow[k] = a;
      const k2 = k + 1; if (k2 < F.shadow.length && F.shadow[k2] < a * 0.6) F.shadow[k2] = a * 0.6;
    },
    shadowSegs(F, p, segs, str) {
      for (let q = 0; q < segs.length; q += 7) {
        const ax = p.x + segs[q], ay = p.y + segs[q + 1], az = segs[q + 2], bx = p.x + segs[q + 3], by = p.y + segs[q + 4], bz = segs[q + 5];
        const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / 3));
        for (let s = 0; s <= n; s++) { const t = s / n; Gen.shadowPoint(F, ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, str * (segs[q + 6] > 2 ? 1 : 0.75), p.h); }
      }
    },
    bakeShadows(F) {
      F.shadow.fill(0);
      for (const p of F.props) {
        if (p.noShadow) continue;
        switch (p.kind) {
          case 'tree': Gen.shadowSegs(F, p, p.segs, 0.7); break;
          case 'spire': case 'shard': case 'bonespike': for (const s of p.shards) Gen.shadowSweep(F, p.x + s.dx, p.y + s.dy, s.w, 8, s.h, 0.8, 1); break;
          case 'basalt': for (const c of p.cols) Gen.shadowSweep(F, p.x + c.dx, p.y + c.dy, c.w, c.d, c.h, 0.85, 0); break;
          case 'gumdrop': case 'skulls': Gen.shadowSweep(F, p.x, p.y, p.w * 0.85, p.d * 0.7, p.h * 0.8, 0.75, 0.7); break;
          case 'grave': Gen.shadowSweep(F, p.x, p.y, p.w, 6, p.h, 0.6, 0.2); break;
          case 'sign': case 'lamp': { const segs = [0, 0, 0, 0, 0, p.h, 1]; if (p.kind === 'sign') segs.push(-20, 0, p.h - 12, 20, 0, p.h - 12, 1, -20, 0, p.h - 4, 20, 0, p.h - 4, 1); Gen.shadowSegs(F, p, segs, 0.55); break; }
          case 'ribs': { const segs = []; const x0 = -p.w / 2; for (let r = 0; r < p.n; r++) { const rx = x0 + (r + 0.5) * (p.w / p.n); segs.push(rx, -p.d / 2, 0, rx, 0, p.h * 0.9, 1, rx, p.d / 2, 0, rx, 0, p.h * 0.9, 1); } segs.push(x0, 0, p.h * 0.6, -x0, 0, p.h * 0.6, 3); Gen.shadowSegs(F, p, segs, 0.6); break; }
          case 'campfire': case 'trapplate': case 'barricade': break;
          case 'treefort':
            Gen.shadowSweep(F, p.x, p.y, 54, 34, 215, 0.85, 0.3);
            Gen.shadowSweep(F, p.x - 130, p.y + 92, 230, 70, 18, 0.7, 0); // the deck and house, cast long by the moon
            Gen.shadowSegs(F, p, p.segs, 0.55); break;
          case 'lantern': Gen.shadowSegs(F, p, [0, 0, 0, 0, 0, p.h, 1], 0.5); break;
          case 'well': Gen.shadowSweep(F, p.x, p.y, p.rx * 1.8, p.ry, p.h, 0.6, 0.1); break;
          case 'brazier': Gen.shadowSweep(F, p.x, p.y, p.w * 0.6, p.d * 0.6, p.h, 0.5, 0.3); break;
          case 'car': Gen.shadowSweep(F, p.x, p.y, p.w, p.d, p.h + p.cabH * 0.6, 0.75, 0.15); break;
          case 'gate': for (const sx of [-1, 1]) Gen.shadowSweep(F, p.x + sx * p.gap / 2, p.y, p.pw, p.d, p.h, 0.8, 0); break;
          default: Gen.shadowSweep(F, p.x, p.y, p.w, p.d, p.h, 0.85, 0);
        }
      }
    },

    // ---- coarse nav grid: walkability (actor-sized clearance), BFS reach from start, carving
    NAV: 16,
    blockedAt(F, x, y, r, mask) {
      if (World._solidAt(F, x, y) & mask) return true;
      const st = rayStride(r);
      for (let a = 0; a < 48; a += st) if (World._solidAt(F, x + SC[a] * r, y + SS[a] * r) & mask) return true;
      if (r > 14) { const h = r * 0.5; for (let a = 0; a < 48; a += 4) if (World._solidAt(F, x + SC[a] * h, y + SS[a] * h) & mask) return true; }
      return false;
    },
    buildNav(F) {
      const gs = Gen.NAV, gw = Math.ceil(F.w / gs), gh = Math.ceil(F.h / gs);
      const nav = F.nav && F.nav.gw === gw ? F.nav : { gs, gw, gh, walk: new Uint8Array(gw * gh), dist: new Int32Array(gw * gh), pd: new Int32Array(gw * gh), q: new Int32Array(gw * gh), pdT: -1, pdCell: -1 };
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) nav.walk[gy * gw + gx] = Gen.blockedAt(F, (gx + 0.5) * gs, (gy + 0.5) * gs, 8.9, S_ALL) ? 0 : 1;
      F.nav = nav; nav._cells = null; nav._clr = null;
      Gen.bfs(F, nav.dist, F.start.x, F.start.y);
      return nav;
    },
    bfs(F, out, x, y) {
      const nav = F.nav, gw = nav.gw, gh = nav.gh, walk = nav.walk, q = nav.q;
      out.fill(-1);
      let s = Gen.nearestWalk(F, x, y); if (s < 0) return -1;
      let qh = 0, qt = 0; q[qt++] = s; out[s] = 0;
      while (qh < qt) {
        const c = q[qh++], cx = c % gw, cy = (c / gw) | 0, d = out[c] + 1;
        if (cx > 0 && walk[c - 1] && out[c - 1] < 0) { out[c - 1] = d; q[qt++] = c - 1; }
        if (cx < gw - 1 && walk[c + 1] && out[c + 1] < 0) { out[c + 1] = d; q[qt++] = c + 1; }
        if (cy > 0 && walk[c - gw] && out[c - gw] < 0) { out[c - gw] = d; q[qt++] = c - gw; }
        if (cy < gh - 1 && walk[c + gw] && out[c + gw] < 0) { out[c + gw] = d; q[qt++] = c + gw; }
      }
      return s;
    },
    nearestWalk(F, x, y) {
      const nav = F.nav, gs = nav.gs, gx = Math.floor(x / gs), gy = Math.floor(y / gs);
      for (let r = 0; r < 12; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cx = gx + dx, cy = gy + dy; if (cx < 0 || cy < 0 || cx >= nav.gw || cy >= nav.gh) continue;
        if (nav.walk[cy * nav.gw + cx]) return cy * nav.gw + cx;
      }
      return -1;
    },
    // Connect big unreachable pockets to the reachable region by carving corridors (bridges over liquid).
    connect(F) {
      for (let iter = 0; iter < 8; iter++) {
        const nav = F.nav, gw = nav.gw, gh = nav.gh, walk = nav.walk, dist = nav.dist;
        // label unreachable components, find the largest
        const lab = new Int32Array(gw * gh).fill(-1), q = nav.q;
        let best = -1, bestN = 0;
        for (let c0 = 0; c0 < gw * gh; c0++) {
          if (!walk[c0] || dist[c0] >= 0 || lab[c0] >= 0) continue;
          let qh = 0, qt = 0; q[qt++] = c0; lab[c0] = c0; let n = 0;
          while (qh < qt) { const c = q[qh++]; n++; const cx = c % gw; for (const nb of [cx > 0 ? c - 1 : -1, cx < gw - 1 ? c + 1 : -1, c - gw, c + gw]) if (nb >= 0 && nb < gw * gh && walk[nb] && dist[nb] < 0 && lab[nb] < 0) { lab[nb] = c0; q[qt++] = nb; } }
          if (n > bestN) { bestN = n; best = c0; }
        }
        if (bestN < 70) return;
        // multi-source BFS from the reachable region over all cells (away from the border) until we touch the pocket
        const par = new Int32Array(gw * gh).fill(-2);
        let qh = 0, qt = 0;
        for (let c = 0; c < gw * gh; c++) if (dist[c] >= 0) { par[c] = -1; q[qt++] = c; }
        let hit = -1;
        while (qh < qt && hit < 0) {
          const c = q[qh++], cx = c % gw, cy = (c / gw) | 0;
          for (const nb of [cx > 3 ? c - 1 : -1, cx < gw - 4 ? c + 1 : -1, cy > 3 ? c - gw : -1, cy < gh - 4 ? c + gw : -1]) {
            if (nb < 0 || par[nb] !== -2) continue;
            par[nb] = c; if (lab[nb] === best) { hit = nb; break; } q[qt++] = nb;
          }
        }
        if (hit < 0) return;
        for (let c = hit; c >= 0 && par[c] !== -1; c = par[c]) Gen.carve(F, (c % gw + 0.5) * nav.gs, (((c / gw) | 0) + 0.5) * nav.gs, 24);
        Gen.bakeSolid(F); Gen.buildNav(F);
      }
    },
    carve(F, x, y, r) {
      Gen.disk(F, x, y, r, r, (k) => { const t = F.type[k]; if (t === T.THICKET) F.type[k] = T.GRASS; else if (isLiquidT(t)) { F.type[k] = T.DIRT; F.aux2[k] = 0; F.aux[k] = 0; } });
      F.props = F.props.filter((p) => p.kind === 'well' || M.dist(x, y, p.x, p.y) > r + p.rad * 0.8);
    },

    // ---- placements
    // reachable nav cells with a walkable 3x3 neighbourhood: [x, y, bfsDist, cellIndex] (base list cached per nav build)
    navCells(F, test) {
      const nav = F.nav;
      if (!nav._cells) {
        const out = nav._cells = [];
        for (let c = 0; c < nav.gw * nav.gh; c++) {
          if (nav.dist[c] < 0) continue;
          const gx = c % nav.gw, gy = (c / nav.gw) | 0;
          if (gx < 2 || gy < 2 || gx >= nav.gw - 2 || gy >= nav.gh - 2) continue;
          let clear = true; for (let dy = -1; dy <= 1 && clear; dy++) for (let dx = -1; dx <= 1; dx++) if (!nav.walk[c + dy * nav.gw + dx]) { clear = false; break; }
          if (clear) out.push([(gx + 0.5) * nav.gs, (gy + 0.5) * nav.gs, nav.dist[c], c]);
        }
      }
      return test ? nav._cells.filter((c) => test(c[0], c[1], c[2], c[3])) : nav._cells.slice();
    },
    clearance(F, x, y, r) { return !Gen.blockedAt(F, x, y, r, S_ALL) && !Gen.blockedAt(F, x, y, r * 0.5, S_ALL); },
    // cached clearance test for a nav cell (radius buckets)
    clearC(F, c, x, y, r) {
      const nav = F.nav, key = r <= 30 ? 0 : r <= 34 ? 1 : r <= 46 ? 2 : 3;
      if (!nav._clr) nav._clr = new Int8Array(nav.gw * nav.gh * 4).fill(-1);
      const q = c * 4 + key; let v = nav._clr[q];
      if (v < 0) { v = nav._clr[q] = Gen.clearance(F, x, y, [30, 34, 46, r][key]) ? 1 : 0; }
      return v === 1;
    },

    placeField(F, rng, want) {
      const s = F.start, act = F.act || 1;
      // exit: geodesically far, pulled toward the intended side, roomy
      const cand = Gen.navCells(F, (x, y, d, c) => x > 160 && y > 160 && x < F.w - 160 && y < F.h - 160 && Gen.clearC(F, c, x, y, 46));
      let best = null, bs = -1e9;
      for (const c of cand) { const sc = c[2] * 16 - 0.55 * M.dist(c[0], c[1], want.x, want.y) + rng.range(0, 60); if (sc > bs) { bs = sc; best = c; } }
      if (!best) { for (const c of Gen.navCells(F)) if (!best || c[2] > best[2]) best = c; }
      if (best) { F.exit = { x: best[0], y: best[1] }; F.exitDist = best[2]; } else { F.exit = { x: s.x, y: s.y - 160 }; F.exitDist = 10; }
      const ex = F.exit, used = [];
      const far = (x, y, list, d) => list.every((p) => M.dist(x, y, p.x, p.y) >= d);
      const open = Gen.navCells(F, (x, y, d, c) => M.dist(x, y, s.x, s.y) > 420 && Gen.clearC(F, c, x, y, 30));
      rng.shuffle(open);
      // elite pack guards the approach to the door
      let el = open.find((c) => { const de = M.dist(c[0], c[1], ex.x, ex.y); return de > 170 && de < 420 && c[2] < F.exitDist; }) || open.find((c) => M.dist(c[0], c[1], ex.x, ex.y) > 150) || open[0];
      if (el) { F.spawns.push({ x: el[0], y: el[1], kind: 'elite', size: 3 + Math.floor(act / 2), tier: 1 }); used.push({ x: el[0], y: el[1] }); }
      // packs, spread out
      const nPacks = Math.min(8, [5, 5, 6, 7, 7][act - 1] + rng.int(0, 1) + (F.ascension >= 3 ? 1 : 0));
      for (let sep = 340; sep >= 160 && F.spawns.length < nPacks + 1; sep -= 45) {
        for (const c of open) {
          if (F.spawns.length >= nPacks + 1) break;
          if (!far(c[0], c[1], used, sep) || M.dist(c[0], c[1], ex.x, ex.y) < 160) continue;
          F.spawns.push({ x: c[0], y: c[1], kind: 'pack', size: rng.int(3, 5) + Math.floor((act - 1) / 2), tier: M.clamp(c[2] / Math.max(1, F.exitDist), 0, 1) });
          used.push({ x: c[0], y: c[1] });
        }
      }
      // the waving snail hides beside something
      const snail = open.find((c) => far(c[0], c[1], used, 170) && F.props.some((p) => p.kind !== 'campfire' && Math.abs(c[0] - p.x) < p.rad + 60 && Math.abs(c[1] - p.y) < p.rad + 60)) || open.find((c) => far(c[0], c[1], used, 150));
      if (snail) { F.spawns.push({ x: snail[0], y: snail[1], kind: 'snail', size: 1, id: 'snail' }); used.push({ x: snail[0], y: snail[1] }); }
      // interactables
      const ia = [{ x: s.x, y: s.y }, { x: ex.x, y: ex.y }];
      const spot = (test, minIa, minSp) => {
        const pool = Gen.navCells(F, (x, y, d) => test(x, y, d));
        rng.shuffle(pool);
        for (let relax = 0; relax < 3; relax++) for (const c of pool) if (far(c[0], c[1], ia, minIa / (1 + relax)) && far(c[0], c[1], used, minSp / (1 + relax)) && Gen.clearC(F, c[3], c[0], c[1], 34)) { ia.push({ x: c[0], y: c[1] }); return c; }
        return pool.find((c) => Gen.clearC(F, c[3], c[0], c[1], 30)) || null;
      };
      const ED = Math.max(1, F.exitDist);
      const pg = new Uint8Array(Math.ceil(F.w / 64) * Math.ceil(F.h / 64)), pgw = Math.ceil(F.w / 64); // props within ~70 of a 64-cell
      for (const p of F.props) { if (p.kind === 'campfire') continue; const r = p.rad + 70; for (let gy = Math.max(0, Math.floor((p.y - r) / 64)); gy <= Math.floor((p.y + r) / 64); gy++) for (let gx = Math.max(0, Math.floor((p.x - r) / 64)); gx <= Math.min(pgw - 1, Math.floor((p.x + r) / 64)); gx++) if (gy * pgw + gx < pg.length) pg[gy * pgw + gx] = 1; }
      const nearProp = (x, y) => pg[Math.floor(y / 64) * pgw + Math.floor(x / 64)] === 1;
      const sh = spot((x, y, d) => d > ED * 0.3 && d < ED * 0.7, 200, 130);
      if (sh) F.interactables.push(World.makeInteractable('shrine', sh[0], sh[1], { r: 40, label: 'Pray at the ' + F.biome.shrineName, name: F.biome.shrineName }));
      const nChests = rng.chance(0.5) ? 2 : 1;
      for (let c = 0; c < nChests; c++) {
        const ch = spot((x, y, d) => d > ED * 0.2 && nearProp(x, y), 260, 110) || spot(() => true, 200, 100);
        if (ch) F.interactables.push(World.makeInteractable('chest', ch[0], ch[1], { r: 34, label: 'Open Chest', rare: rng.chance(0.15 + act * 0.03) }));
      }
      const nt = spot((x, y) => M.dist(x, y, s.x, s.y) > 260, 220, 90);
      if (nt) F.interactables.push(World.makeInteractable('note', nt[0], nt[1], { r: 30, label: 'Read the torn page', act }));
      // a Remnant (story NPC, DESIGN §9D) waits near the arrival point of each act's first floor, off the main line
      if (F.inAct === 1 && !F.isTitle && !F.isPrologue) {
        const npc = STORY_NPC[Math.max(0, Math.min(4, act - 1))];
        const ax = ex.x - s.x, ay = ex.y - s.y, al = Math.hypot(ax, ay) || 1;
        const offLine = (x, y, dMin, dMax) => { const dx = x - s.x, dy = y - s.y, d = Math.hypot(dx, dy); if (d < dMin || d > dMax) return false; const off = Math.abs(dx * ay - dy * ax) / al, along = (dx * ax + dy * ay) / al; return off > 90 && along > -170; };
        const st = spot((x, y) => offLine(x, y, 150, 330) && Gen.clearance(F, x, y, 40), 110, 150) || spot((x, y) => offLine(x, y, 120, 480), 90, 110);
        if (st) {
          const rem = HM.Lore && HM.Lore.remnants && HM.Lore.remnants[npc];
          F.interactables.push(World.makeInteractable('story', st[0], st[1], { npc, label: 'Speak', r: 48, name: (rem && rem.name) || STORY_NAME[npc] }));
        }
      }
      if (F.inAct === 2) {
        const mc = spot((x, y) => { const d = M.dist(x, y, s.x, s.y); return d > 130 && d < 320 && Gen.clearance(F, x, y - 26, 46); }, 100, 220);
        if (mc) { F.interactables.push(World.makeInteractable('merchant', mc[0], mc[1], { r: 48, label: 'Trade with Choose Goose', name: 'Choose Goose' })); F.props.push(P.stall(mc[0], mc[1] - 26)); }
      }
    },

    // ---- final bake: solids, nav, shadows, shore distances, visuals, lights
    finalize(F) {
      if (F.exit) F.props.push(P.gate(F.exit.x, F.exit.y - 34, (F.seed % 997) + 11));
      Gen.bakeSolid(F); Gen.buildNav(F);
      Gen.bakeShadows(F);
      Gen.shoreDist(F); Gen.bakeWet(F);
      Gen.bakeVisuals(F); Gen.bakeGrass(F); Gen.bakeLedges(F);
      Gen.bakeLights(F);
      World._addExit(F);
    },
    // Props standing in the water (stones in the shallows, a drowned tree): they get slow idle ripple rings, and the water
    // hugging their base is baked darker (F.aux on water cells = contact-band strength 0..1), like the dark ring round a hull.
    bakeWet(F) {
      F.wetProps = [];
      if (F.biomeId === 'fire') return;
      const isW = (x, y) => { const k = cellK(F, x, y); return k >= 0 && (F.type[k] === T.WATER || F.type[k] === T.DEEP); };
      for (const p of F.props) {
        if (p.kind === 'gate' || p.kind === 'stall' || p.kind === 'campfire') continue;
        const rx = (p.w || 2 * (p.rad || 10)) / 2 + 8, ry = (p.d || 12) / 2 + 7;
        let wet = 0;
        for (let a = 0; a < 16; a++) { const an = (a / 16) * Math.PI * 2; if (isW(p.x + Math.cos(an) * rx, p.y + Math.sin(an) * ry)) wet++; }
        if (wet < 3) continue;
        p.inWater = true; p._wx = p.x; p._wy = p.y + (p.d || 10) * 0.35;
        F.wetProps.push(p);
        Gen.disk(F, p.x, p.y, rx + 12, ry + 9, (k, u) => { const t = F.type[k]; if (t === T.WATER || t === T.DEEP) F.aux[k] = Math.max(F.aux[k], Math.min(1, (1 - u) * 1.7)); });
      }
    },
    shoreDist(F) {
      const D = F.shoreD, cols = F.cols, rows = F.rows, n = cols * rows; D.fill(255);
      for (let k = 0; k < n; k++) if (!isLiquidT(F.type[k])) D[k] = 0;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { const k = j * cols + i; if (!D[k]) continue; let m = D[k]; if (i > 0) m = Math.min(m, D[k - 1] + 1); if (j > 0) m = Math.min(m, D[k - cols] + 1); D[k] = m; }
      for (let j = rows - 1; j >= 0; j--) for (let i = cols - 1; i >= 0; i--) { const k = j * cols + i; if (!D[k]) continue; let m = D[k]; if (i < cols - 1) m = Math.min(m, D[k + 1] + 1); if (j < rows - 1) m = Math.min(m, D[k + cols] + 1); D[k] = m; }
      for (let k = 0; k < n; k++) if (F.type[k] === T.WATER && D[k] > 6) F.type[k] = T.DEEP;
    },

    // orientation glyph for line-like cells (cracks) from same-type neighbours
    lineGlyph(F, k, i, j, arr, tp) {
      const c = F.cols, ty = arr, at = (dk, ok) => ok && ty[k + dk] === tp ? 1 : 0;
      const L = at(-1, i > 0), Rr = at(1, i < c - 1), U = at(-c, j > 0), D = at(c, j < F.rows - 1);
      const UL = at(-c - 1, i > 0 && j > 0), UR = at(-c + 1, i < c - 1 && j > 0), DL = at(c - 1, i > 0 && j < F.rows - 1), DR = at(c + 1, i < c - 1 && j < F.rows - 1);
      const hz = L + Rr, vt = U + D, d1 = UL + DR, d2 = UR + DL;
      const m = Math.max(hz, vt, d1, d2);
      if (m === 0) return G_DOT;
      if (m === hz) return F.h1[k] < 0.5 ? G_DASH : G_TILDE;
      if (m === vt) return G_PIPE;
      return m === d1 ? G_BS : G_FS;
    },

    // Terrain bake (DESIGN §4b + §10). Ground never uses the dense glyph family figures are drawn with (@#%&8B…): it is
    // low-contrast sparse strokes / dots / light letters, and its tone is an ordered (Bayer) dither anchored to world
    // cells — clean, surface-stable density steps instead of random glyph noise. Walls and props keep their weight.
    bakeVisuals(F) {
      const id = F.biomeId, B = F.biome, n = F.cols * F.rows, cols = F.cols;
      const set = (k, cl, g, r, gg, b, e) => { F.cls[k] = cl; F.g[k] = g; const o = k * 3; F.c[o] = r; F.c[o + 1] = gg; F.c[o + 2] = b; F.e[k] = e || 0; };
      const pick = (gl, h) => gl[(h * 997) % gl.length | 0];
      const c3 = [0, 0, 0];
      let hasWater = false, hasLava = false;
      for (let k = 0; k < n; k++) {
        const tp = F.type[k], h = F.h1[k], h2 = F.h2[k], sh = F.shade[k], n1 = F.n1[k], i = k % cols, j = (k / cols) | 0, bt = bay(i, j);
        F.cls[k] = C_SKIP; F.g[k] = 0;
        if (tp === T.WATER || tp === T.DEEP) { if (id === 'fire') { F.cls[k] = C_LAVA; hasLava = true; } else { F.cls[k] = C_WATER; hasWater = true; } continue; }
        if (tp === T.CHASM) { // the void's lip: a worked-stone rim where the floor ends, the shaft wall dropping away below it
          const nc = (kk) => F.type[kk] !== T.CHASM;
          let du = 0; while (du < 8 && j - du - 1 >= 0 && !nc(k - (du + 1) * cols)) du++; // chasm rows above this one
          const up = j > 0 && du === 0, lf = i > 0 && nc(k - 1), rt = i < cols - 1 && nc(k + 1), dn = j < F.rows - 1 && nc(k + cols);
          const wallL = 2 + ((M.hash2(i, 41) * 6) | 0);
          if (up) set(k, C_VOID, h < 0.6 ? G_UND : G_EQ, 0.5, 0.6, 0.52);
          else if (lf || rt) set(k, C_VOID, h < 0.5 ? G_PIPE : G_COLON, 0.38, 0.46, 0.4);
          else if (dn) set(k, C_VOID, h < 0.5 ? G_DOT : G_COMMA, 0.26, 0.32, 0.28);
          else if (j - du - 1 >= 0 && du < wallL) { const f = du / wallL; set(k, C_VOID, h < 0.55 ? G_PIPE : h < 0.8 ? G_BANG : G_COLON, 0.3 * (1 - 0.6 * f), 0.42 * (1 - 0.6 * f), 0.32 * (1 - 0.6 * f), 1); }
          else set(k, C_VOID, h < 0.5 ? G_DOT : G_COMMA, 0.12, 0.13, 0.12);
          continue;
        }
        if (id === 'grass') {
          if (tp === T.GRASS) {
            const cov = 0.8 + (sh - 0.5) * 0.9 + (n1 - 0.5) * 0.45; // thick and thin swathes, dithered
            if (cov > bt && h >= 0.04) F.cls[k] = C_GRASS;
          } else if (tp === T.STONE) {
            // slate "text" patches (the reference look), but dim and in light letters; edges dissolve in ordered dots
            const edge = M.clamp((sh - 0.64) * 9, 0, 1);
            const tone = 0.18 + 0.62 * edge + (n1 - 0.5) * 0.3;
            if (tone < bt) { if (h2 >= 0.55 && edge < 0.5) set(k, C_STATIC, pick(GL.short, h2), B.grassLo[0] * 1.3, B.grassLo[1] * 1.3, B.grassLo[2] * 1.3); continue; }
            const g = edge < 0.3 ? pick(GL.dust, h) : pick(GL.textLt, h2);
            const v = 0.3 + 0.26 * edge + 0.1 * h; set(k, C_STATIC, g, B.stone[0] * v, B.stone[1] * v, B.stone[2] * v);
          } else if (tp === T.THICKET) {
            // dark forest canopy: rounded clumps of foliage, moonlit on their upper-right; dark gaps between them.
            // (A wall, not ground: reads as a mass, unlike the stroke-texture grass you walk on.)
            const cl = Math.sin(i * 0.62 + n1 * 5.5) * Math.sin(j * 1.15 + sh * 7) + (n1 - 0.5) * 0.6;
            if (cl < -0.35) { if (h < 0.3) set(k, C_STATIC, G_DOT, B.thicket[0] * 0.5, B.thicket[1] * 0.5, B.thicket[2] * 0.5); continue; }
            const lit = Math.max(0, Math.sin(i * 0.62 + n1 * 5.5 + 0.9) * Math.sin(j * 1.15 + sh * 7 - 0.7));
            const v = 0.4 + 0.32 * (cl + 0.35) + lit * 0.6 + h * 0.15;
            set(k, C_STATIC, cl < -0.05 ? pick(GL.canopyEdge, h2) : pick(GL.canopy, h2), B.thicket[0] * v, B.thicket[1] * v * 1.08, B.thicket[2] * v);
          } else if (tp === T.DIRT) {
            const ac = Math.abs(F.aux2[k]), al = F.aux[k];
            if (F.aux2[k] === 2) { // prologue footpath: trodden earth, a few stones, grass creeping in at the margins
              const tone = 0.42 + (n1 - 0.5) * 0.5;
              if (tone < bt) { if (h >= 0.3) F.cls[k] = C_GRASS; continue; }
              const v = 0.55 + 0.35 * h2; set(k, C_STATIC, pick(GL.trail, h2), 0.36 * v, 0.31 * v, 0.24 * v); continue;
            }
            if (ac > 0.82 && h < (ac - 0.82) * 4) { if (h >= 0.06) F.cls[k] = C_GRASS; continue; } // crumbling shoulder
            if (sh > 0.6 && h2 < 0.55) { if (h >= 0.06) F.cls[k] = C_GRASS; continue; } // grass through the cracks
            if (ac < 0.08 && (al % 46) < 22) { set(k, C_STATIC, G_EQ, B.lane[0] * (0.5 + h * 0.3), B.lane[1] * (0.5 + h * 0.3), B.lane[2] * (0.5 + h * 0.3)); continue; }
            if (h2 < 0.04) { set(k, C_STATIC, h < 0.5 ? G_FS : G_BS, B.road[0] * 0.55, B.road[1] * 0.55, B.road[2] * 0.6); continue; }
            if (0.55 + (n1 - 0.5) * 0.4 < bt) continue;
            const v = 0.55 + 0.4 * h2; set(k, C_STATIC, GL.asphalt[(h2 * 53) % GL.asphalt.length | 0], B.road[0] * v, B.road[1] * v, B.road[2] * v);
          }
        } else if (id === 'candy') {
          if (tp === T.GRASS) {
            // dusty sugar crust: sparse, desaturated pink-grey, so the (pink) candy dead read cleanly on top of it
            if (h2 < 0.012) { const sp = B.sprinkles[(h * 4) | 0]; const v = 0.32 + h * 0.25; set(k, h2 < 0.004 ? C_SPARK : C_STATIC, GL.sprinkle[(h * 37) % 5 | 0], sp[0] * v, sp[1] * v, sp[2] * v, h * 6.28); continue; }
            if (sh < 0.42) { // rot stain: sparse, dark, sick
              if (0.3 + (0.42 - sh) * 2 < bt) continue;
              const v = 0.45 + 0.4 * h2; set(k, C_STATIC, GL.rotStain[(h2 * 31) % GL.rotStain.length | 0], 0.22 * v, 0.07 * v, 0.11 * v); continue;
            }
            if (sh > 0.56 && n1 > 0.5) { // crystallised sugar crust: short flat strokes
              if (0.35 + (n1 - 0.5) * 1.2 < bt) continue;
              const v = 0.6 + 0.35 * h2; set(k, C_STATIC, pick(GL.crustLt, h2), 0.62 * v, 0.47 * v, 0.5 * v); continue;
            }
            const tone = 0.3 + (sh - 0.5) * 0.8 + (n1 - 0.5) * 0.3;
            if (tone < bt) continue;
            const v = M.clamp(0.25 + 0.35 * h2 + (sh - 0.5) * 0.6, 0, 0.75);
            c3[0] = 0.34 + 0.36 * v; c3[1] = 0.21 + 0.24 * v; c3[2] = 0.25 + 0.26 * v;
            set(k, C_STATIC, pick(GL.dust, h2), c3[0], c3[1], c3[2]);
          } else if (tp === T.STONE || tp === T.DIRT) {
            // old cobbled streets as a running-bond course of bricks drawn in outline (`____|____|`), crumbled by dither
            const ac = tp === T.DIRT ? Math.abs(F.aux2[k]) : 0;
            if (tp === T.DIRT && ac > 0.86) { const v = 0.4 + h * 0.2; set(k, C_STATIC, G_EQ, B.stone[0] * v, B.stone[1] * v, B.stone[2] * v); continue; } // curb
            const tone = 0.72 + (n1 - 0.5) * 0.7 + (h - 0.5) * 0.25;
            if (tone < bt) { if (h2 < 0.08) set(k, C_STATIC, G_DOT, 0.3, 0.22, 0.25); continue; }
            const joint = ((i + (j & 1) * 3) % 6) === 0;
            const v = (tp === T.DIRT ? 0.42 : 0.36) + 0.16 * h;
            if (joint) set(k, C_STATIC, G_PIPE, B.stone[0] * v * 0.7, B.stone[1] * v * 0.66, B.stone[2] * v * 0.7);
            else set(k, C_STATIC, h2 < 0.06 ? G_DOT : G_UND, B.stone[0] * v, B.stone[1] * v * 0.92, B.stone[2] * v * 0.96);
          } else if (tp === T.POOL) {
            const v = 0.5 + 0.5 * n1;
            if (h2 < 0.1) set(k, C_POOL, h < 0.5 ? G_DEG : G_TILDE, B.poolHi[0] * 0.6, B.poolHi[1] * 0.6, B.poolHi[2] * 0.6, h * 6.28);
            else if (0.55 + (n1 - 0.5) * 0.6 < bt) set(k, C_POOL, 0, 0, 0, 0, h * 6.28);
            else set(k, C_POOL, GL.rot[(h2 * 13) % GL.rot.length | 0], B.pool[0] * v, B.pool[1] * v, B.pool[2] * v, h * 6.28);
          } else if (tp === T.THICKET) {
            if (h < 0.1) continue;
            if (h2 < 0.1) set(k, C_STATIC, GL.icing[(h * 13) % 5 | 0], B.icing[0] * 0.6, B.icing[1] * 0.55, B.icing[2] * 0.58);
            else { const v = 0.5 + 0.5 * h; set(k, C_STATIC, GL.ginger[(h2 * 29) % GL.ginger.length | 0], B.thicket[0] * v, B.thicket[1] * v, B.thicket[2] * v); }
          }
        } else if (id === 'ice') {
          if (tp === T.GRASS || tp === T.DIRT) {
            if (h2 < 0.008) { set(k, C_SPARK, h < 0.5 ? G_STAR : G_MDOT, B.fleck[0] * 0.7, B.fleck[1] * 0.7, B.fleck[2] * 0.7, h * 6.28); continue; }
            // wind ripples: a smooth banded field, so the snow forms long drifting crests instead of salt-and-pepper
            const rp = Math.sin(i * 0.21 + n1 * 7 + j * 0.85 + sh * 9);
            const tone = 0.42 + (sh - 0.5) * 0.7 + rp * 0.22 - (tp === T.DIRT ? 0.2 : 0);
            if (tone < bt) continue;
            const crest = rp > 0.7;
            const v = M.clamp(0.35 + 0.2 * h2 + (sh - 0.5) * 0.6 + (crest ? 0.25 : 0), 0, 0.95) * (tp === T.DIRT ? 0.6 : 1);
            lerp3(c3, B.snowLo, B.snowHi, v);
            set(k, C_STATIC, crest ? (rp > 0.93 ? G_TILDE : G_DASH) : GL.snow[(h2 * 71) % GL.snow.length | 0], c3[0], c3[1], c3[2]);
          } else if (tp === T.POOL) {
            // frozen lake: a sparse dither of flat ice strokes; long glint lines; white cracks (glints sweep at draw time)
            if (F.aux2[k] > 0) { set(k, C_STATIC, Gen.lineGlyph(F, k, i, j, F.aux2, 1), 0.62, 0.78, 0.9); continue; }
            const gl = ((i * 0.6 - j * 1.4 + sh * 30) % 23 + 23) % 23 < 1.1;
            if (gl) { set(k, C_POOL, G_DASH, B.iceHi[0] * 0.75, B.iceHi[1] * 0.75, B.iceHi[2] * 0.75, 1); continue; }
            const tone = 0.32 + (n1 - 0.5) * 0.7 + (sh - 0.5) * 0.3;
            const v = 0.45 + 0.45 * n1;
            if (tone < bt) set(k, C_POOL, 0, B.ice[0] * v, B.ice[1] * v, B.ice[2] * v, 0);
            else set(k, C_POOL, GL.iceSheet[(h2 * 31) % GL.iceSheet.length | 0], B.ice[0] * v, B.ice[1] * v, B.ice[2] * v, 0);
          } else if (tp === T.STONE) {
            const tone = 0.5 + (n1 - 0.5) * 0.6;
            if (tone < bt) continue;
            const v = 0.4 + 0.3 * h; set(k, C_STATIC, pick(GL.rockLt, h2), B.stone[0] * v, B.stone[1] * v, B.stone[2] * v);
          } else if (tp === T.THICKET) {
            if (h < 0.08) continue;
            const v = 0.45 + 0.5 * h; set(k, C_STATIC, pick(GL.shardLt, h2), B.thicket[0] * v, B.thicket[1] * v, B.thicket[2] * v);
          }
        } else if (id === 'fire') {
          if (tp === T.CRACK) { set(k, C_CRACK, Gen.lineGlyph(F, k, i, j, F.type, T.CRACK), B.crack[0], B.crack[1], B.crack[2], 0.55 + 0.25 * h); continue; }
          let heat = 0;
          for (let dx = -2; dx <= 2 && !heat; dx++) for (let dy = -1; dy <= 1; dy++) { const kk = k + dy * cols + dx; if (kk >= 0 && kk < n && (F.type[kk] === T.CRACK || ((F.type[kk] === T.WATER) && Math.abs(dx) + Math.abs(dy) <= 1))) { heat = 1 - (Math.abs(dx) + Math.abs(dy)) * 0.3; break; } }
          if (tp === T.GRASS || tp === T.DIRT) {
            // black glass: mostly dark, with sparse glossy sheen strokes; hot ground glows in dots near the cracks
            const glossy = n1 > 0.58;
            const v = 0.4 + 0.5 * h2;
            lerp3(c3, B.groundLo, B.groundHi, v);
            if (glossy) { const s = Math.min(1, (n1 - 0.58) * 3); c3[0] += (B.sheen[0] - c3[0]) * s * 0.5; c3[1] += (B.sheen[1] - c3[1]) * s * 0.5; c3[2] += (B.sheen[2] - c3[2]) * s * 0.5; }
            if (tp === T.DIRT) { c3[0] = 0.24 * v; c3[1] = 0.22 * v; c3[2] = 0.21 * v; }
            if (heat) { if (heat * 0.9 < bt) continue; c3[0] += 0.4 * heat; c3[1] += 0.1 * heat; set(k, C_STATIC, h2 < 0.5 ? G_DOT : G_COLON, c3[0], c3[1], c3[2], 0); continue; }
            const tone = (glossy ? 0.42 : 0.26) + (h - 0.5) * 0.2;
            if (tone < bt) continue;
            set(k, C_STATIC, tp === T.DIRT ? GL.ash[(h2 * 11) % 4 | 0] : glossy ? pick(GL.obsSheen, h2) : GL.obsidDust[(h2 * 17) % GL.obsidDust.length | 0], c3[0], c3[1], c3[2]);
          } else if (tp === T.STONE) {
            // basalt flags: the seams carry the pattern, the faces stay mostly empty
            const seam = (j % 3 === 0) || ((i + ((j / 3) | 0) * 3) % 6 === 0);
            const v = 0.4 + 0.35 * h;
            if (seam) { if (0.7 < bt && h < 0.5) continue; set(k, C_STATIC, j % 3 === 0 ? G_UND : (h < 0.5 ? G_FS : G_BS), B.stone[0] * 0.6 + heat * 0.3, B.stone[1] * 0.55 + heat * 0.08, B.stone[2] * 0.6); }
            else { if (0.22 + heat * 0.4 < bt) continue; set(k, C_STATIC, h2 < 0.5 ? G_COLON : G_DOT, B.stone[0] * v + heat * 0.4, B.stone[1] * v + heat * 0.1, B.stone[2] * v); }
          } else if (tp === T.THICKET) {
            if (h < 0.08) continue;
            const v = 0.45 + 0.55 * h; set(k, C_STATIC, GL.basalt[(h2 * 29) % GL.basalt.length | 0], B.thicket[0] * v + heat * 0.35, B.thicket[1] * v + heat * 0.1, B.thicket[2] * v);
          }
        } else if (id === 'well') {
          if (tp === T.CRACK) { set(k, C_CRACK, Gen.lineGlyph(F, k, i, j, F.type, T.CRACK), B.crack[0] * 0.8, B.crack[1] * 0.8, B.crack[2] * 0.8, 0.35 + 0.2 * h); continue; }
          if (tp === T.GRASS) {
            if (sh > 0.5 && h2 > 0.35) { // bone field: scattered bone strokes, kept far dimmer than the bone-white dead that walk on it
              const tone = 0.3 + Math.min(1, (sh - 0.5) * 5) * 0.4;
              if (tone < bt) continue;
              if (h2 > 0.97 && sh > 0.55) { const v = 0.32 + h * 0.1; set(k, C_STATIC, G_o, B.bone[0] * v, B.bone[1] * v, B.bone[2] * v * 0.95); continue; }
              const v = 0.2 + 0.2 * h * Math.min(1, (sh - 0.5) * 5); set(k, C_STATIC, GL.bone[(h * 97) % GL.bone.length | 0], B.bone[0] * v * 0.92, B.bone[1] * v, B.bone[2] * v * 0.95); continue;
            }
            if (0.38 + (n1 - 0.5) * 0.5 < bt) continue;
            const v = 0.4 + 0.6 * h2; lerp3(c3, B.soilLo, B.soilHi, v); set(k, C_STATIC, GL.soil[(h2 * 17) % 4 | 0], c3[0], c3[1], c3[2]);
          } else if (tp === T.STONE) {
            if (0.55 + (n1 - 0.5) * 0.5 < bt) continue;
            const v = 0.55 + 0.45 * h, gs = n1 > 0.6 ? (n1 - 0.6) * 0.45 : 0;
            set(k, C_STATIC, pick(GL.wellStone, h2), B.stone[0] * v, B.stone[1] * v + gs, B.stone[2] * v + gs * 0.4);
          } else if (tp === T.DIRT) {
            if (h < 0.15) continue;
            const v = 0.36 + 0.25 * h; set(k, C_STATIC, (i % 3) ? G_EQ : G_DASH, B.bone[0] * v, B.bone[1] * v, B.bone[2] * v);
          } else if (tp === T.THICKET) {
            if (h < 0.1) continue;
            const v = 0.3 + 0.4 * h; set(k, C_STATIC, GL.skull[(h2 * 7) % 4 | 0], B.thicket[0] * v, B.thicket[1] * v, B.thicket[2] * v);
          }
        }
      }
      F.hasWater = hasWater; F.hasLava = hasLava;
    },

    // grass cells: bake the static parts (base brightness in F.e, fleck/tuft glyphs in F.g, fleck brightness in F.c).
    // Brightness is an ordered-dither step over a smooth tone field (clean light/shadow swathes, not per-cell noise).
    bakeGrass(F) {
      const n = F.cols * F.rows, cols = F.cols;
      for (let k = 0; k < n; k++) {
        if (F.cls[k] !== C_GRASS) continue;
        const h = F.h1[k], h2 = F.h2[k], i = k % cols, j = (k / cols) | 0;
        if (h2 < 0.02) { F.g[k] = GL.dotsLt[(h * 97) % GL.dotsLt.length | 0]; F.c[k * 3] = 0.3 + h * 0.35; continue; } // dew / firefly dust
        F.g[k] = h < 0.2 ? GL.short[(h2 * 71) % GL.short.length | 0] : 0;
        const tone = 0.36 + (F.shade[k] - 0.5) * 0.9 + (F.n1[k] - 0.5) * 0.3;
        F.e[k] = tone + (bay(i, j) - 0.5) * 0.22 + (h2 - 0.5) * 0.08;
      }
    },

    // Walls read as raised ground: where a wall meets walkable ground below it, its lowest rows become a dark
    // vertical front face with a bright lip on top; wall cells bordering ground anywhere get a lit rim.
    bakeLedges(F) {
      const cols = F.cols, rows = F.rows, ty = F.type, B = F.biome, wc = B.thicket || [0.3, 0.3, 0.3];
      const FACE = G('|#|H!|I#'), LIP = G('_=-_~');
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const k = j * cols + i; if (ty[k] !== T.THICKET) continue;
        let below = 0; for (let d = 1; d <= 3 && j + d < rows; d++) { const t = ty[k + d * cols]; if (t !== T.THICKET && !isLiquidT(t)) { below = d; break; } }
        const h = F.h1[k], h2 = F.h2[k];
        if (below === 1 || below === 2) {
          const v = below === 1 ? 0.42 + h * 0.2 : 0.55 + h * 0.2;
          F.cls[k] = C_STATIC; F.g[k] = FACE[(h2 * 89) % FACE.length | 0];
          const o = k * 3; F.c[o] = wc[0] * v; F.c[o + 1] = wc[1] * v; F.c[o + 2] = wc[2] * v;
        } else if (below === 3) {
          const v = 1.25 + h * 0.3;
          F.cls[k] = C_STATIC; F.g[k] = LIP[(h2 * 31) % LIP.length | 0];
          const o = k * 3; F.c[o] = wc[0] * v; F.c[o + 1] = wc[1] * v; F.c[o + 2] = wc[2] * v;
        } else if (F.cls[k] === C_STATIC) {
          // lit rim where the wall meets open ground above it or beside it; the plateau itself sits in light shade
          const open = (q) => ty[q] !== T.THICKET && !isLiquidT(ty[q]);
          let rim = (i > 0 && open(k - 1)) || (i < cols - 1 && open(k + 1));
          if (j > 0) for (let d = -2; d <= 2 && !rim; d++) { const a = i + d; if (a >= 0 && a < cols && open(k - cols + d)) rim = true; }
          if (rim) { const o = k * 3; F.c[o] *= 1.45; F.c[o + 1] *= 1.45; F.c[o + 2] *= 1.45; }
          F.shadow[k] = Math.max(F.shadow[k], 0.15);
        }
      }
    },

    bakeLights(F) {
      const L = F.lights, id = F.biomeId;
      for (const p of F.props) {
        if (p.kind === 'campfire') L.push({ x: p.x, y: p.y, z: 18, r: 250, c: [1.0, 0.52, 0.2], i: 1.15, flick: 0.22, ph: p.seed % 7 });
        else if (p.kind === 'brazier') L.push({ x: p.x, y: p.y, z: 26, r: p.fire === 'green' ? 160 : 150, c: p.fire === 'green' ? [0.3, 1.0, 0.45] : [1.0, 0.5, 0.18], i: 0.95, flick: 0.2, ph: p.seed % 7 });
        else if (p.kind === 'lamp') L.push({ x: p.x, y: p.y, z: 40, r: 135, c: [1.0, 0.55, 0.72], i: 1.15, prop: p, lamp: true });
        else if (p.kind === 'grave' && p.candle) L.push({ x: p.x + p.w * 0.5 + 3, y: p.y, z: 8, r: 46, c: [1.0, 0.7, 0.35], i: 0.6, flick: 0.35, ph: p.seed % 7 });
        else if (p.kind === 'spire' && p.glow) L.push({ x: p.x, y: p.y, z: 50, r: 110, c: [0.45, 0.75, 1.0], i: 0.32, flick: 0.05, ph: p.seed % 7 });
        else if (p.kind === 'obelisk') L.push({ x: p.x, y: p.y, z: 30, r: 60, c: [0.3, 1.0, 0.45], i: 0.25, flick: 0.4, ph: p.seed % 7 });
        else if (p.kind === 'well') L.push({ x: p.x, y: p.y, z: 30, r: 340, c: [0.3, 1.0, 0.45], i: 1.0, flick: 0.15, ph: 1 });
        else if (p.kind === 'lantern') L.push({ x: p.x + p.side * 10, y: p.y + 4, z: 30, r: 150, c: [1.0, 0.62, 0.28], i: 0.95, flick: 0.18, ph: p.seed % 7, prop: p });
        else if (p.kind === 'treefort') {
          L.push({ x: p.x + 104, y: p.y + 70, z: 40, r: 190, c: [1.0, 0.6, 0.28], i: 0.8, flick: 0.2, ph: 3 });
          L.push({ x: p.x + 30, y: p.y + 30, z: 20, r: 120, c: [1.0, 0.55, 0.25], i: 0.3, flick: 0.4, ph: 5 });
          // lights are laid in projected space: these sit "behind" the trunk so they wash the deck and house up in the crown
          L.push({ x: p.x + 40, y: p.y - 200, z: 0, r: 170, c: [1.0, 0.62, 0.3], i: 0.55, flick: 0.25, ph: 2 });
          L.push({ x: p.x + 104, y: p.y - 120, z: 0, r: 110, c: [1.0, 0.62, 0.3], i: 0.5, flick: 0.2, ph: 3 });
        }
        else if (p.kind === 'pedestal') L.push({ x: p.x, y: p.y + 6, z: 30, r: 90, c: [0.5, 0.75, 1.2], i: 0.45, flick: 0.1, ph: 2 });
        else if (p.kind === 'bmo') L.push({ x: p.x, y: p.y + 6, z: 16, r: 60, c: [0.45, 1.0, 0.75], i: 0.3, flick: 0.3, ph: 4 });
      }
      if (id === 'fire') { // light anchors along lava cracks and lava shores
        const step = 115;
        for (let y = step / 2; y < F.h; y += step) for (let x = step / 2; x < F.w; x += step) {
          let cnt = 0, lava = 0, sx = 0, sy = 0;
          for (let dy = -48; dy <= 48; dy += 10) for (let dx = -50; dx <= 50; dx += 6) {
            const k = cellK(F, x + dx, y + dy); if (k < 0) continue; const t = F.type[k];
            if (t === T.CRACK) { cnt++; sx += dx; sy += dy; } else if ((t === T.WATER || t === T.DEEP) && F.shoreD[k] <= 2) { lava++; sx += dx; sy += dy; }
          }
          const m = cnt + lava; if (m) { sx /= m; sy /= m; }
          if (cnt >= 7) L.push({ x: x + sx, y: y + sy, z: 6, r: 115, c: [1.0, 0.42, 0.12], i: 0.55, flick: 0.3, ph: (x * 7 + y) % 13, pulse: true });
          else if (lava >= 8) L.push({ x: x + sx, y: y + sy, z: 8, r: 135, c: [1.0, 0.45, 0.12], i: 0.6, flick: 0.25, ph: (x * 3 + y) % 11, pulse: true });
        }
      }
      if (id === 'well') { // witch-glow seeping from the void edges
        const step = 160;
        for (let y = step / 2; y < F.h; y += step) for (let x = step / 2; x < F.w; x += step) {
          const k = cellK(F, x, y); if (k < 0 || F.type[k] !== T.CHASM || F.shoreD[k] > 4) continue;
          L.push({ x, y, z: -10, r: 100, c: [0.25, 0.9, 0.4], i: 0.35, flick: 0.3, ph: (x + y) % 9 });
        }
      }
    },
  };

  // ================================================================== layouts
  const Layout = {
    field(F, rng) {
      const w = F.w, h = F.h;
      const L = rng.pick([{ s: [0.5, 0.86], e: [0.5, 0.12] }, { s: [0.2, 0.84], e: [0.82, 0.16] }, { s: [0.8, 0.84], e: [0.18, 0.16] }, { s: [0.1, 0.5], e: [0.9, 0.45] }, { s: [0.9, 0.5], e: [0.1, 0.55] }, { s: [0.5, 0.14], e: [0.5, 0.88] }]);
      F.start = { x: M.clamp(w * L.s[0] + rng.range(-80, 80), 560, w - 560), y: M.clamp(h * L.s[1] + rng.range(-40, 40), 430, h - 430) };
      const want = { x: w * L.e[0] + rng.range(-150, 150), y: h * L.e[1] + rng.range(-60, 60) };
      const sideOf = (p) => { const d = { N: p.y, S: h - p.y, W: p.x, E: w - p.x }; return Object.keys(d).sort((a, b) => d[a] - d[b])[0]; };
      const free = ['N', 'E', 'S', 'W'].filter((s) => s !== sideOf(F.start) && s !== sideOf(want));
      rng.shuffle(free);
      const id = F.biomeId;
      F.liqSides = id === 'grass' ? (rng.chance(0.75) ? free[0] : '') : id === 'ice' ? (rng.chance(0.6) ? free[0] : '') : id === 'fire' ? free.slice(0, 2).join('') : '';
      Gen.terrain(F, rng, Gen.fieldEdge(F));
      Gen.features(F, rng);
      Gen.clearStart(F, 150);
      Gen.props(F, rng);
      Gen.bakeSolid(F); Gen.buildNav(F); Gen.connect(F);
      Gen.placeField(F, rng, want);
      Gen.finalize(F);
    },

    arena(F, rng) {
      const id = F.biomeId, w = F.w, h = F.h, B = F.biome;
      const cx = w / 2, cy = h * 0.52, RX = 610, RY = 470;
      F.arena = { x: cx, y: cy, rx: RX, ry: RY };
      F.start = { x: cx, y: cy + RY - 115 };
      const wellArena = id === 'well';
      F.exit = { x: cx, y: wellArena ? cy - RY + 245 : cy - RY + 105 };
      const bossY = wellArena ? cy - RY + 310 : cy - RY + 200;
      const ox = rng.range(0, 999), oy = rng.range(0, 999);
      // boundary: an ellipse with a ragged edge; fire has a lava moat inside the basalt
      Gen.terrain(F, rng, (x, y) => {
        const e = ((x - cx) / RX) ** 2 + ((y - cy) / RY) ** 2 + (M.fbm(x * 0.008 + ox, y * 0.008 + oy, 3) - 0.5) * 0.22;
        if (e > 1.0) return id === 'fire' && e < 1.12 ? T.WATER : B.edgeWall;
        if (id === 'grass' && e > 0.93 && y < cy - RY * 0.3) return T.WATER;
        return T.GRASS;
      });
      // floor motif
      const inside = (k) => { const t = F.type[k]; return t !== B.edgeWall && !(id === 'fire' && t === T.WATER) && t !== T.CHASM; };
      if (id === 'grass') {
        const pts = Gen.wavyLine(rng, 0, cy + rng.range(-40, 40), w, cy + rng.range(-40, 40), 6, 20);
        Gen.path(F, pts, 70, (k, along, across) => { if (inside(k) && F.type[k] !== T.WATER) { F.type[k] = T.DIRT; F.aux[k] = along; F.aux2[k] = across; } });
        F.road = pts;
      } else if (id === 'candy') {
        Gen.disk(F, cx, cy, 300, 220, (k, u) => { if (inside(k) && F.type[k] !== T.POOL) F.type[k] = u > 0.95 ? T.DIRT : T.STONE; });
      } else if (id === 'ice') {
        Gen.disk(F, cx, cy, 420, 300, (k, u) => { if (inside(k)) { F.type[k] = T.POOL; F.aux2[k] = 0; } });
      } else if (id === 'fire') {
        for (let a = 0; a < 7; a++) { // cracks radiating from the throne
          const ang = (a / 7) * Math.PI * 2 + rng.range(-0.2, 0.2);
          let x = cx, y = cy;
          for (let s = 0; s < 40; s++) { const nx = x + Math.cos(ang + rng.range(-0.5, 0.5)) * 13, ny = y + Math.sin(ang + rng.range(-0.5, 0.5)) * 10; Gen.path(F, [[x, y], [nx, ny]], 5, (k) => { if (inside(k) && F.type[k] !== T.WATER) F.type[k] = T.CRACK; }); x = nx; y = ny; }
        }
      } else if (id === 'well') { // ritual circle
        Gen.disk(F, cx, cy + 40, 250, 180, (k, u) => { if (!inside(k)) return; if (u > 0.93) F.type[k] = T.CRACK; else if (u < 0.8 && F.type[k] === T.CRACK) F.type[k] = T.STONE; });
        for (let a = 0; a < 5; a++) { const a0 = (a / 5) * Math.PI * 2 - Math.PI / 2, a1 = ((a + 2) / 5) * Math.PI * 2 - Math.PI / 2; Gen.path(F, [[cx + Math.cos(a0) * 240, cy + 40 + Math.sin(a0) * 172], [cx + Math.cos(a1) * 240, cy + 40 + Math.sin(a1) * 172]], 5, (k) => { if (inside(k)) F.type[k] = T.CRACK; }); }
      }
      Gen.clearStart(F, 110);
      Gen.disk(F, cx, bossY, 90, 70, (k) => { const t = F.type[k]; if (t === T.WATER || t === T.CHASM || t === B.edgeWall) F.type[k] = T.GRASS; });
      // ring of set-pieces
      const N = 12;
      for (let s = 0; s < N; s++) {
        const a = (s / N) * Math.PI * 2 + Math.PI / N;
        if (Math.abs(M.angleDiff(a, Math.PI / 2)) < 0.42 || Math.abs(M.angleDiff(a, -Math.PI / 2)) < 0.42) continue;
        const x = cx + Math.cos(a) * (RX - 105), y = cy + Math.sin(a) * (RY - 85);
        const alt = s % 2;
        let p;
        if (id === 'grass') p = alt ? P.monolith(rng, x, y, { fallen: false, big: true }) : P.tree(rng, x, y, 'dead');
        else if (id === 'candy') p = alt ? P.cane(rng, x, y) : P.gumdrop(rng, x, y);
        else if (id === 'ice') p = P.spire(rng, x, y, { n: rng.int(3, 5), scale: alt ? 1.15 : 0.85 });
        else if (id === 'fire') p = alt ? P.basalt(rng, x, y) : P.brazier(rng, x, y, 'orange');
        else p = alt ? P.brazier(rng, x, y, 'green') : Object.assign(P.spire(rng, x, y, { kind: 'bonespike', n: rng.int(2, 4), scale: 0.7 }), { dark: [0.22, 0.21, 0.18], lit: [0.82, 0.8, 0.7], fill: GL.bone, glow: false });
        if (id === 'candy' && p.kind === 'cane') { p.broken = false; p.hook = true; p.dir = Math.cos(a) > 0 ? -1 : 1; }
        F.props.push(p);
      }
      if (id === 'grass') { F.props.push(P.car(rng, cx - 380, cy + rng.range(-20, 30))); F.props.push(P.sign(rng, cx + 330, cy - 70)); }
      if (id === 'candy') { for (const sx of [-1, 1]) F.props.push(P.lamp(rng, cx + sx * 200, cy - 150)); }
      if (wellArena) F.props.push(P.well(cx, cy - RY + 120));
      // boundary markers: a ring of low themed stones just inside the arena edge, so the limit reads at a glance
      const NE = 56;
      for (let s = 0; s < NE; s++) {
        const a = (s / NE) * Math.PI * 2 + rng.range(-0.02, 0.02);
        let x = cx + Math.cos(a) * (RX - 30), y = cy + Math.sin(a) * (RY - 24);
        for (let q = 0; q < 12; q++) { const k = cellK(F, x, y); if (k >= 0 && F.type[k] !== B.edgeWall && !isLiquidT(F.type[k])) break; x -= Math.cos(a) * 8; y -= Math.sin(a) * 8; }
        if (wellArena && y < cy - RY + 260 && Math.abs(x - cx) < 180) continue;
        if (M.dist(x, y, F.start.x, F.start.y) < 70 || M.dist(x, y, cx, bossY) < 120) continue;
        let p;
        if (id === 'grass') p = Object.assign(P.boulder(rng, x, y), { kind: 'boulder', col: [0.5, 0.54, 0.7], h: rng.range(14, 30) });
        else if (id === 'candy') p = s % 3 ? Object.assign(P.gumdrop(rng, x, y), { rx: 11, ry: 7, h: 13, w: 22, d: 14, rad: 11 }) : Object.assign(P.cane(rng, x, y), { w: 14, d: 12, h: rng.range(30, 46), hook: false, broken: true, rad: 9 });
        else if (id === 'ice') p = Object.assign(P.spire(rng, x, y, { n: rng.int(1, 2), scale: 0.38 }), { rad: 12 });
        else if (id === 'fire') p = Object.assign(P.boulder(rng, x, y), { col: [0.22, 0.2, 0.23], h: rng.range(16, 34) });
        else p = Object.assign(P.spire(rng, x, y, { kind: 'bonespike', n: rng.int(1, 2), scale: 0.36 }), { dark: [0.22, 0.21, 0.18], lit: [0.82, 0.8, 0.7], fill: GL.bone, glow: false, rad: 12 });
        p.edge = true; F.props.push(p);
      }
      Gen.bakeSolid(F); Gen.buildNav(F); Gen.connect(F);
      F.spawns.push({ x: cx, y: bossY, kind: 'boss', id: F.bossId, size: 1 });
      F.interactables.push(World.makeInteractable('shrine', cx - 210, F.start.y - 20, { r: 40, label: 'Pray at the ' + B.shrineName, name: B.shrineName }));
      F.interactables.push(World.makeInteractable('chest', cx, cy + 30, { r: 36, label: 'Open the Reliquary', rare: true, hidden: true, reward: true }));
      Gen.finalize(F);
    },

    // The Prologue — "The Tree Fort Clearing" (DESIGN §9A). A small hand-authored night map: a winding valley cut through
    // dark forest that physically gates each beat in order. South-west to north-west, an S-bend:
    //   start by a moonlit pond → lantern-lit footpath → the Tree Fort (sword at its door) → training yard (3 dummies) →
    //   a narrow gap between two standing stones (the Bone Sentinel slams it) → east, then north to a bone barricade
    //   (solid until World.setBarricade(true)) → pack clearing → a trapped corridor west → the Captain's ring of stones →
    //   the page on its pedestal → the Dungeon Door.
    prologue(F, rng) {
      const cols = F.cols;
      F.isPrologue = true; F.inAct = 0; F.act = 1; F.index = 0; F.actName = 'Prologue';
      F.biome = Object.assign({}, F.biome, { name: 'The Tree Fort Clearing', water: [0.13, 0.22, 0.5], foam: [0.8, 0.9, 1.08], fogAmount: 0.3 });
      F.ambient = [0.86, 0.96, 1.08];
      F.objective = { type: 'prologue', remaining: 0, done: false };
      const BT = {
        start: { x: 290, y: 1238 },
        sword: { x: 612, y: 886 },
        dummies: [{ x: 818, y: 914 }, { x: 884, y: 956 }, { x: 950, y: 906 }],
        gap: { x: 905, y: 786, w: 60 },
        sentinel: { x: 908, y: 712 },
        barricade: { x: 1314, y: 540 },
        pack: [{ x: 1262, y: 386 }, { x: 1350, y: 356 }, { x: 1392, y: 420 }],
        trap: { x: 1112, y: 314 },
        captain: { x: 842, y: 270 },
        page: { x: 566, y: 266 },
        door: { x: 352, y: 268 },
        bmo: { x: 228, y: 1196 },
        lanterns: [],
      };
      // forest everywhere; F.shade (stone patches) comes from the usual terrain pass
      Gen.terrain(F, rng, () => T.THICKET);
      const ragged = (k, s) => { const i = k % cols, j = (k / cols) | 0; return (M.fbm(i * 0.085 + s, j * 0.2 + s * 0.7, 2) - 0.5); };
      const clear = (x, y, rx, ry, tp, s) => Gen.disk(F, x, y, rx * 1.14, ry * 1.14, (k, u) => { if (u < 0.88 + ragged(k, s || 3) * 0.42) F.type[k] = tp === undefined ? T.GRASS : tp; });
      const lane = (pts, wd, s) => Gen.path(F, pts, wd * 1.3, (k, along, across) => { if (Math.abs(across) < 0.76 + ragged(k, s || 7) * 0.5) F.type[k] = T.GRASS; });
      // the arrival: a clearing on the shore of a small pond (with one stone standing in it)
      clear(300, 1240, 150, 96, T.GRASS, 1);
      clear(586, 1214, 182, 104, T.GRASS, 2);
      Gen.disk(F, 586, 1214, 150 * 1.1, 76 * 1.1, (k, u) => { if (u < 0.9 + ragged(k, 11) * 0.3) F.type[k] = T.WATER; });
      // the lantern-lit footpath to the Tree Fort
      const trail = [[300, 1236], [338, 1150], [408, 1066], [488, 1002], [572, 956], [612, 902]];
      lane(trail, 96, 4);
      clear(612, 905, 176, 108, T.GRASS, 5);   // the Tree Fort's yard
      clear(880, 926, 150, 96, T.GRASS, 6);    // training yard
      Gen.path(F, [[898, 866], [904, 790], [912, 724]], 60, (k) => { F.type[k] = T.GRASS; }); // the gap: exactly ~60 wide, stones either side
      clear(932, 668, 135, 78, T.GRASS, 9);    // the Sentinel's ground
      lane([[1010, 652], [1150, 640], [1292, 618]], 76, 10);
      clear(1298, 626, 52, 40, T.GRASS, 12);
      lane([[1300, 640], [1312, 540], [1320, 446]], 82, 13); // the barricaded climb north
      clear(1326, 386, 176, 98, T.GRASS, 14);  // pack clearing
      lane([[1196, 352], [1112, 318], [1028, 298]], 74, 15); // trapped corridor
      clear(846, 278, 214, 128, T.GRASS, 16);  // the Captain's ring
      clear(566, 262, 96, 74, T.GRASS, 17);    // the page
      lane([[470, 262], [520, 262]], 100, 18);
      clear(352, 262, 138, 102, T.GRASS, 19);  // the Dungeon Door
      // stone "text" patches only in the clearings; the footpath itself
      for (let k = 0; k < F.type.length; k++) if (F.type[k] === T.GRASS && F.shade[k] > 0.66) F.type[k] = T.STONE;
      Gen.path(F, trail, 30, (k, along, across) => { const t = F.type[k]; if (t === T.GRASS || t === T.STONE) { F.type[k] = T.DIRT; F.aux[k] = along; F.aux2[k] = 2; } });
      Gen.path(F, [[612, 902], [612, 870]], 26, (k, along) => { if (F.type[k] !== T.WATER) { F.type[k] = T.DIRT; F.aux[k] = along; F.aux2[k] = 2; } });
      // keep every beat spot walkable
      const keep = (p, r) => Gen.disk(F, p.x, p.y, r, r * 0.8, (k) => { if (F.type[k] === T.THICKET || F.type[k] === T.WATER) F.type[k] = T.GRASS; });
      for (const p of [BT.start, BT.sword, BT.sentinel, BT.trap, BT.captain, BT.page, BT.door].concat(BT.dummies, BT.pack)) keep(p, 34);
      F.start = { x: BT.start.x, y: BT.start.y };
      F.exit = { x: BT.door.x, y: BT.door.y };
      // ---- set-pieces
      const fort = P.treefort(rng, 612, 822); F.props.push(fort);
      F.props.push(P.bmo(BT.bmo.x, BT.bmo.y));
      { const st = P.monolith(rng, 650, 1212, { fallen: false }); st.h = 64; st.w = 22; st.d = 16; st.rad = 11; F.props.push(st); } // stone in the pond
      // lanterns along the footpath, alternating sides
      { let acc = 0, next = 70, side = 1;
        for (let q = 0; q + 1 < trail.length; q++) {
          const a = trail[q], b = trail[q + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
          while (next < acc + L) {
            const tt = (next - acc) / L, x = a[0] + (b[0] - a[0]) * tt + nx * 42 * side, y = a[1] + (b[1] - a[1]) * tt + ny * 42 * side;
            const lp = P.lantern(rng, x, y, -side); F.props.push(lp); BT.lanterns.push({ x, y });
            next += 96; side = -side;
          }
          acc += L;
        }
        for (const sx of [-1, 1]) { const lp = P.lantern(rng, 612 + sx * 58, 878, -sx); F.props.push(lp); }
      }
      // the gap: two standing stones; the barricade; the page's pedestal; the trap plate
      for (const sx of [-1, 1]) { const m = P.monolith(rng, BT.gap.x + sx * 54, BT.gap.y - 4, { fallen: false }); m.w = 30; m.d = 22; m.h = 118 + sx * 14; m.rad = 15; m.broken = sx > 0; F.props.push(m); }
      F.props.push(P.barricade(BT.barricade.x, BT.barricade.y, 124));
      F.props.push(P.pedestal(BT.page.x, BT.page.y - 30));
      F.props.push(P.trapplate(BT.trap.x, BT.trap.y));
      // the Captain's ring: broken standing stones round the arena (open east and west)
      for (let s2 = 0; s2 < 12; s2++) {
        const a = (s2 / 12) * Math.PI * 2 + 0.26;
        if (Math.abs(Math.cos(a)) > 0.86) continue;
        const x = 846 + Math.cos(a) * 196, y = 278 + Math.sin(a) * 112;
        const m = P.monolith(rng, x, y, { fallen: s2 === 4 }); if (!m.fallen) { m.h = rng.range(50, 96); m.w = rng.range(18, 28); m.d = 16; m.rad = 12; }
        F.props.push(m);
      }
      // a few graves of the war dead in the training yard's corner; boulders by the paths
      for (let g = 0; g < 3; g++) F.props.push(P.grave(rng, 1000 + g * 22, 980 + (g % 2) * 8));
      // dead forest framing the valley: trees rooted in the wall just off the open ground
      const isOpen = (x, y) => { const k = cellK(F, x, y); return k >= 0 && F.type[k] !== T.THICKET; };
      const trees = [];
      for (let n = 0; n < 900 && trees.length < 46; n++) {
        const x = rng.range(60, F.w - 60), y = rng.range(80, F.h - 40);
        if (isOpen(x, y)) continue;
        let near = false; for (let a = 0; a < 8 && !near; a++) { const an = a * 0.785; if (isOpen(x + Math.cos(an) * 46, y + Math.sin(an) * 34)) near = true; }
        if (!near || trees.some((tq) => M.dist(tq.x, tq.y, x, y) < 70) || M.dist(x, y, fort.x, fort.y) < 150) continue;
        const tr = P.tree(rng, x, y, 'dead'); trees.push(tr); F.props.push(tr);
      }
      F.beats = BT;
      F.spawns = [];
      Gen.finalize(F);
      // the barricade blocks the climb until the tutorial smashes it: the region beyond is (correctly) unreachable now
    },

    title(F, rng) {
      // A moonlit shore at the edge of the Grasslands. The UI darkens the top and bottom of the screen and puts the
      // menu in the middle, so the scene is composed for the clear mid band: the sea curls in from the upper left,
      // and a ring of standing stones round the last campfire sits in the right third. The camera then drifts east
      // along the shore past monolith fields, dead groves and a graveyard.
      const w = F.w, h = F.h, cam = { x: 820, y: 1000 }, fire = { x: cam.x + 360, y: cam.y + 30 };
      F.start = { x: cam.x, y: cam.y };
      const ox = rng.range(0, 999);
      const shoreAt = (x) => cam.y - 110 + (cam.x - x) * 0.38 * Math.max(0.2, 1 - Math.max(0, x - 1700) / 1400) + (M.fbm(x * 0.004 + ox, 1.7, 3) - 0.5) * 120 + Math.sin(x * 0.0021) * 40;
      Gen.terrain(F, rng, (x, y) => {
        if (y < shoreAt(x)) return T.WATER;
        const e = Math.min(x, w - x, h - y) + (M.fbm(x * 0.006 + ox, y * 0.006, 3) - 0.5) * 220;
        return e < 40 ? T.THICKET : T.GRASS;
      });
      Gen.disk(F, fire.x, fire.y, 120, 90, (k) => { if (F.type[k] !== T.STONE) F.type[k] = T.GRASS; });
      Gen.disk(F, cam.x, cam.y, 40, 40, (k) => { if (F.type[k] === T.WATER) F.type[k] = T.GRASS; });
      // standing stones round the fire, open toward the viewer
      for (let s = 0; s < 8; s++) {
        const a = (s / 8) * Math.PI * 2 - Math.PI / 2 + rng.range(-0.1, 0.1);
        if (Math.abs(M.angleDiff(a, Math.PI / 2)) < 0.55) continue;
        const p = P.monolith(rng, fire.x + Math.cos(a) * 175, fire.y + Math.sin(a) * 118, { fallen: s === 2 });
        if (!p.fallen) { p.h = rng.range(100, 160); p.w = rng.range(26, 38); }
        p.ring = true; F.props.push(p);
      }
      F.props.push(P.campfire(rng, fire.x, fire.y));
      // two stones standing in the shallows, and an old dead tree leaning over the water
      for (const [x, big] of [[cam.x - 260, true], [cam.x - 120, false]]) { const p = P.monolith(rng, x, shoreAt(x) + 8, { fallen: false, big }); p.ring = true; F.props.push(p); }
      { const t = P.tree(rng, cam.x - 330, shoreAt(cam.x - 330) + 70, 'dead'); t.ring = true; F.props.push(t); }
      // dressing the drifting camera passes
      const far = { gap: 30, startR: -1e9 };
      for (let x0 = 1650; x0 < w - 300; x0 += 600) {
        const c = [x0 + rng.range(0, 260), rng.range(1000, 1300)];
        Gen.scatter(F, rng, rng.int(2, 4), (r, x, y) => P.monolith(r, x, y), Object.assign({ near: c, spread: 200 }, far));
        Gen.scatter(F, rng, rng.int(2, 3), (r, x, y) => P.tree(r, x, y, 'dead'), Object.assign({ near: [c[0] + 290, c[1] - 60], spread: 180 }, far));
      }
      Gen.scatter(F, rng, 3, (r, x, y) => P.tree(r, x, y, 'dead'), Object.assign({ near: [cam.x + 40, cam.y + 260], spread: 160 }, far));
      Gen.graveyardAt(F, rng, [cam.x + 760, cam.y + 230]);
      for (let g = 0; g < 5; g++) { const p = P.grave(rng, cam.x - 230 + g * 34 + rng.range(-6, 6), cam.y + 250 + rng.range(-10, 10)); p.candle = g % 2 === 0; F.props.push(p); }
      F.props.push(Object.assign(P.sign(rng, cam.x + 1280, shoreAt(cam.x + 1280) + 90), { text: 'OOO 1', bent: 1 }));
      F.props = F.props.filter((p) => p.ring || p.kind === 'campfire' || M.dist(p.x, p.y, fire.x, fire.y) > 230);
      F.campfire = fire;
      F.titleSpots = [{ x: fire.x - 58, y: fire.y + 8, facing: 0 }, { x: fire.x + 56, y: fire.y - 6, facing: Math.PI }, { x: fire.x - 18, y: fire.y - 46, facing: Math.PI / 2 }, { x: fire.x + 130, y: fire.y + 60, facing: Math.PI * 0.9 }];
      F.exit = { x: fire.x, y: fire.y - 330 }; // nominal only: the title has no door
      Gen.bakeSolid(F); Gen.buildNav(F);
      Gen.bakeShadows(F); Gen.shoreDist(F); Gen.bakeWet(F); Gen.bakeVisuals(F); Gen.bakeGrass(F); Gen.bakeLedges(F); Gen.bakeLights(F);
      for (const L of F.lights) if (L.r === 250) { L.r = 360; L.i = 1.8; } // the title fire burns brighter
      // the menu veils the backdrop, so the title realm is lit a little harder than the real Grasslands
      F.biome = Object.assign({}, F.biome, { water: [0.2, 0.32, 0.62], foam: [0.95, 1.05, 1.2], fogAmount: 0.4 });
      F.ambient = [1.25, 1.35, 1.45];
    },
  };

  // ================================================================== map edge: themed boundary band, then void
  // Called for every visible cell past the map edge (DESIGN §8). Never samples the map interior beyond the nearest edge
  // cell's terrain type (to pick shore vs wall art). dxo/dyo = cells past the edge; wn = the liquid wave field (0..1).
  //   grass: cliff lip (a rock face drops away on the south side) · candy: a crumbling sugar-brick wall
  //   ice: an ice cliff hung with icicles · fire: a lava moat · well: a void lip with witch-glow seeping up
  //   liquid edges (sea / lava sea / chasm) carry their liquid on and fade it out. Beyond: near-black void, sparse dim motes.
  const VOIDM = { grass: [0.3, 0.36, 0.46], candy: [0.42, 0.3, 0.36], ice: [0.4, 0.48, 0.6], fire: [0.55, 0.22, 0.08], well: [0.2, 0.55, 0.3] };
  function drawBand(F, i, ci, cj, dxo, dyo, wn, t) {
    const FC = F.cols, FR = F.rows, id = F.biomeId, B = F.biome;
    const ei = ci < 0 ? 0 : ci >= FC ? FC - 1 : ci, ej = cj < 0 ? 0 : cj >= FR ? FR - 1 : cj;
    const et = F.type[ej * FC + ei];
    const dx = dxo * CW, dy = dyo * RW, dw = dx > dy ? dx : dy;
    const ns = dy >= dx, south = ns && cj >= FR;
    let hh = Math.imul(ci, 73856093) ^ Math.imul(cj, 19349663); hh = Math.imul(hh ^ (hh >>> 13), 1274126177); hh = ((hh ^ (hh >>> 16)) >>> 0) / 4294967296;
    const bt = BAYER[((cj & 3) << 2) | (ci & 3)];
    let g = 0, r = 0, gg = 0, b = 0, fl = R.F_GROUND, em = 0;
    if (id === 'fire') {
      // lava moat: molten band, cooling to crust specks, then dark
      if (dw < 62) {
        const fade = 1 - dw / 80, n = wn * 0.8 + 0.2 * hh;
        if (n < 0.38) { if (0.3 * fade < bt) g = 0; else { g = G_DOT; r = 0.3 * fade; gg = 0.08 * fade; b = 0.02 * fade; } }
        else { g = n > 0.72 ? G_TILDE : n > 0.55 ? G_EQ : G_DASH; const v = (0.35 + (n - 0.38) * 1.5) * fade; r = 1.5 * v; gg = 0.55 * v; b = 0.08 * v; em = 0.3; }
        fl = R.F_UNLIT;
      } else if (dw < 100 && 0.35 * (1 - (dw - 62) / 38) > bt) { g = hh < 0.5 ? G_DOT : G_COMMA; r = 0.22; gg = 0.07; b = 0.03; }
    } else if (et === T.WATER || et === T.DEEP) {
      // the sea runs on past the edge and sinks into the dark
      const tone = (wn * 1.1 - 0.15) * (1 - dw / 120) * 0.85;
      if (tone > bt) { const wat = B.water || [0.1, 0.2, 0.4], v = 0.3 + 0.7 * tone; g = WDOT[(hh * 8) | 0]; r = wat[0] * v; gg = wat[1] * v; b = wat[2] * v; fl = 0; }
    } else if (et === T.CHASM || id === 'well') {
      if (dw < 11 && et !== T.CHASM) { // the worked-stone lip of the well shaft, moss-green in the witch-light
        g = ns ? (hh < 0.55 ? G_UND : G_EQ) : (hh < 0.5 ? G_PIPE : G_COLON); const v = 0.8 + 0.35 * hh; r = 0.42 * v; gg = 0.52 * v; b = 0.44 * v;
      } else if (south && dw < 70 && et !== T.CHASM && M.hash2(ci, 41) * 59 + 11 > dw) { // the shaft wall drops away below the lip
        const f = (dw - 11) / 59; g = hh < 0.55 ? G_PIPE : hh < 0.8 ? G_BANG : G_COLON; const v = (0.62 - 0.45 * f) * (0.6 + 0.5 * M.hash2(ci, 43)); r = 0.26 * v; gg = 0.42 * v; b = 0.3 * v;
      } else if (dw < 90) { // witch-glow seeping up out of the void
        const tone = 0.5 * (1 - dw / 90) * (0.6 + 0.4 * Math.sin(t * 1.3 + ci * 0.31 + cj * 0.53));
        if (tone > bt) { g = hh < 0.4 ? G_DOT : hh < 0.7 ? G_COMMA : G_APOS; const v = tone * 0.9; r = 0.3 * v; gg = 1.0 * v; b = 0.45 * v; fl = R.F_UNLIT; em = 0.3; }
      }
    } else if (id === 'grass') {
      if (dw < 11) { g = ns ? (hh < 0.6 ? G_UND : G_EQ) : (hh < 0.5 ? G_PIPE : G_COLON); const v = 0.95 + 0.4 * hh; r = 0.34 * v; gg = 0.42 * v; b = 0.36 * v; } // the cliff lip
      else if (south && dw < 96) { // the cliff face drops away below the lip: ragged rock striations sinking into darkness
        const stri = M.hash2(ci, 77), L = 18 + stri * 46 + M.hash2(ci >> 2, 78) * 26;
        if (dw < L) { const f = (dw - 11) / Math.max(1, L - 11); g = f > 0.8 ? (hh < 0.5 ? G_APOS : G_COLON) : hh < 0.62 ? G_PIPE : hh < 0.85 ? G_BANG : G_COLON; const v = (0.9 - 0.62 * f) * (0.6 + 0.6 * M.hash2(ci, 79)); r = 0.32 * v; gg = 0.37 * v; b = 0.38 * v; }
        else if (0.18 * (1 - (dw - L) / 40) > bt) { g = G_DOT; r = 0.08; gg = 0.1; b = 0.1; }
      } else if (!south && dw < 42) { // a ragged overhang: roots and grass tufts dropping off the lip
        const tone = 0.55 * (1 - (dw - 11) / 31);
        if (tone > bt) { g = hh < 0.5 ? G_APOS : G_COMMA; const v = 0.4 + 0.3 * tone; r = 0.12 * v; gg = 0.24 * v; b = 0.14 * v; }
      }
    } else if (id === 'candy') {
      const WH = south ? 64 : 34; // the south face of the wall is seen from the front: taller
      if (dw < WH) { // crumbling sugar-brick wall, icing on its lip
        const tone = 1.1 - (dw / WH) * 0.8 - hh * 0.22;
        if (tone > bt) {
          const joint = (((ci + (cj & 1) * 3) % 6) + 6) % 6 === 0;
          g = dw < 9 ? (hh < 0.6 ? G_TILDE : G_EQ) : joint ? G_PIPE : G_UND;
          const v = (0.5 + 0.45 * tone) * (joint ? 0.72 : 1) * (dw < 9 ? 1.25 : 1); r = 0.86 * v; gg = 0.66 * v; b = 0.72 * v;
        }
      } else if (dw < WH + 46) { // sugar dust trickling into the dark
        const tone = 0.4 * (1 - (dw - WH) / 46);
        if (tone > bt) { g = hh < 0.5 ? G_DOT : hh < 0.8 ? G_APOS : G_COLON; const v = 0.3 + tone; r = 0.5 * v; gg = 0.36 * v; b = 0.42 * v; }
      }
    } else if (id === 'ice') {
      if (dw < 8) { g = ns ? (hh < 0.5 ? G_UND : G_EQ) : G_PIPE; const v = 0.75 + 0.25 * hh; r = 0.6 * v; gg = 0.78 * v; b = 0.98 * v; }
      else if (south) { // an ice cliff hung with icicles
        const L = 16 + M.hash2(ci, 31) * 62;
        if (dw < L) { const f = (dw - 8) / Math.max(1, L - 8); g = f > 0.82 ? G_v : hh < 0.75 ? G_PIPE : G_COLON; const v = (0.85 - f * 0.5) * ((ci % 3) === 0 ? 1.15 : 0.78); r = 0.5 * v; gg = 0.7 * v; b = 0.95 * v; }
        else if (dw < L + 40 && 0.25 * (1 - (dw - L) / 40) > bt) { g = G_DOT; r = 0.3; gg = 0.38; b = 0.5; }
      } else if (dw < 40) { // frost-shattered rim
        const tone = 1 - (dw - 8) / 32;
        if (tone * 0.8 > bt) { g = GL.shardLt[(hh * 6) | 0]; const v = 0.3 + 0.4 * tone; r = 0.5 * v; gg = 0.66 * v; b = 0.9 * v; }
      }
    }
    const glyph = R.glyph, col = R.col, o = i * 3;
    if (!g) {
      // void: very sparse, dim motes drifting slowly upward, fading in from the band
      if (dw < 40) return;
      const vs = (t * 0.8) | 0;
      let hm = Math.imul(ci, 73856093) ^ Math.imul(cj + vs, 19349663); hm = Math.imul(hm ^ (hm >>> 13), 1274126177); hm = ((hm ^ (hm >>> 16)) >>> 0) / 4294967296;
      if (hm > 0.0045) return;
      const vm = VOIDM[id] || VOIDM.grass, v = (0.3 + (hm / 0.0045) * 0.4) * Math.min(1, (dw - 40) / 60 + 0.3);
      g = hm < 0.0012 ? G_o : G_DOT; r = vm[0] * v; gg = vm[1] * v; b = vm[2] * v;
    }
    R.key[i] = R.KEY_GROUND; glyph[i] = g; col[o] = r; col[o + 1] = gg; col[o + 2] = b; R.flag[i] = fl; R.shd[i] = 0;
    if (em) R.emitI(i, r * em, gg * em, b * em);
  }

  // ================================================================== ripples (DESIGN §10)
  const RIP_MAX = 48;
  const RIP_ST = new WeakMap(); // per actor / projectile: last ripple time + last position
  function rippleStateOf(o) { let s = RIP_ST.get(o); if (!s) { s = { t: -9, x: o.x, y: o.y, w: false }; RIP_ST.set(o, s); } return s; }

  HM.Interact = HM.Interact || {};
  HM.Interact.portal = () => HM.Game && HM.Game.descend && HM.Game.descend();

  // ================================================================== World
  const World = (HM.World = {
    T, GL, BIOMES, P, DRAW, IDRAW,
    floor: null,
    t: 0,

    // ------------------------------------------------------------------ generation
    generate(o) {
      o = o || {};
      if (o.prologue) o = Object.assign({ act: 1, inAct: 0, biome: 'grass', seed: 0x7ee }, o, { title: false, isBoss: false });
      const biomeId = o.title || o.prologue ? 'grass' : BIOMES[o.biome] ? o.biome : 'grass';
      const boss = !!o.isBoss && !o.title;
      const F = o.prologue ? newFloor(o, biomeId, 1720, 1420) : newFloor(o, biomeId, o.title ? 4800 : boss ? 1500 : 2400, boss ? 1200 : 1800);
      const rng = new HM.RNG(F.seed);
      Gen.cells(F, rng);
      if (o.prologue) Layout.prologue(F, rng);
      else if (o.title) Layout.title(F, rng); else if (boss) Layout.arena(F, rng); else Layout.field(F, rng);
      if (!o.prologue) World._makeWadeable(F); // the prologue pond gates a tutorial beat, so it stays a wall
      World.floor = F; World._prevOpen = false;
      World._resetRipples();
      return F;
    },

    // ------------------------------------------------------------------ wading
    // Water (not lava, not the void) is walkable: generation still treats it as a barrier (layout, spawns, nav),
    // then plain liquid cells are opened up so actors can wade in. Props standing in water stay solid.
    _makeWadeable(F) {
      if (F.biomeId === 'fire') return;
      const S = F.solid, ty = F.type, n = S.length;
      for (let k = 0; k < n; k++) if (S[k] === S_LIQ && (ty[k] === T.WATER || ty[k] === T.DEEP)) S[k] = 0;
      F.wadeable = true;
    },
    // 0 = dry, 1 = shallows (knee-deep), 2 = deep water (waist-deep)
    wadeAt(x, y) {
      const F = World.floor; if (!F || !F.wadeable) return 0;
      const t = World._typeAt(F, x, y); return t === T.DEEP ? 2 : t === T.WATER ? 1 : 0;
    },
    wadeMul(x, y) { const w = World.wadeAt(x, y); return w === 2 ? 0.62 : w === 1 ? 0.82 : 1; },

    // ------------------------------------------------------------------ liquids & ripples (DESIGN §10)
    // true on (non-lava) water: the Grasslands sea and ponds, open water in the ice
    isWater(x, y) { const F = World.floor; if (!F || F.biomeId === 'fire') return false; const t = World._typeAt(F, x, y); return t === T.WATER || t === T.DEEP; },
    // 'water' | 'lava' | 'void' | null
    liquidAt(x, y) { const F = World.floor; if (!F) return null; const t = World._typeAt(F, x, y); return t === T.WATER || t === T.DEEP ? (F.biomeId === 'fire' ? 'lava' : 'water') : t === T.CHASM ? 'void' : null; },
    // Spawn a ripple ring at a world point if it is on water (lava gets a slow molten ring); no-op elsewhere.
    // opts {strength=0.6, speed=60 (units/s), life=1.6 (s), maxR=90 (units)} → the ripple record or null
    ripple(x, y, o) {
      const F = World.floor; if (!F) return null;
      const tp = World._typeAt(F, x, y); if (tp !== T.WATER && tp !== T.DEEP) return null;
      return World._spawnRipple(F, x, y, o);
    },
    // (no water check: auto ripples are centred between an actor and the water it touches, so the ring reads as theirs)
    _spawnRipple(F, x, y, o) {
      const RP = World._rip; let slot = null, oldest = null;
      for (let n = 0; n < RP.length; n++) { const r = RP[n]; if (!r.on) { slot = r; break; } if (!oldest || r.t0 < oldest.t0) oldest = r; }
      if (!slot) { if (RP.length < RIP_MAX) { slot = {}; RP.push(slot); } else slot = oldest; }
      o = o || {};
      const lava = F.biomeId === 'fire';
      slot.on = true; slot.x = x; slot.y = y; slot.t0 = World.t + (o.delay || 0);
      slot.str = o.strength !== undefined ? o.strength : 0.6;
      slot.spd = o.speed !== undefined ? o.speed : lava ? 20 : 60;
      slot.life = o.life !== undefined ? o.life : lava ? 3.2 : 1.6;
      slot.maxR = o.maxR !== undefined ? o.maxR : 90;
      World._ripN = (World._ripN || 0) + 1;
      return slot;
    },
    _rip: [], _ripN: 0,
    _resetRipples() { for (const r of World._rip) r.on = false; World._ripN = 0; World._pjPrev = []; World._ripAmbT = 0; },
    // auto ripples: actors wading / standing at the shore line, idle rings round stones in the water, projectiles
    // skimming the surface (and splashing down), plus the odd rise ring; lava gets slow molten rings that well up.
    _autoRipples(F, dt) {
      const G = HM.Game, t = World.t;
      if (F.hasWater) {
        const ents = G && G.entities;
        if (ents) for (let n = 0; n < ents.length; n++) {
          const a = ents[n]; if (a.dead || a.hidden || !R.inViewWorld(a.x, a.y, 140)) continue;
          const rr = (a.radius || 8) + 7;
          let wx = 0, wy = 0, hit = false;
          for (let pI = 0; pI < 5 && !hit; pI++) {
            const px = a.x + (pI === 1 ? -rr : pI === 2 ? rr : 0), py = a.y + (pI === 3 ? rr * 0.75 : pI === 4 ? -rr * 0.75 : 0);
            const tp = World._typeAt(F, px, py); if (tp === T.WATER || tp === T.DEEP) { hit = true; wx = (px + a.x) * 0.5; wy = (py + a.y) * 0.5; }
          }
          const st = rippleStateOf(a);
          const moved = Math.abs(a.x - st.x) + Math.abs(a.y - st.y) > 0.4 * (dt * 60);
          st.x = a.x; st.y = a.y;
          if (!hit) continue;
          const wade = World.wadeAt(a.x, a.y), rolling = a.anim && a.anim.state === 'dodge';
          if (wade && !st.w && moved) { World._spawnRipple(F, a.x, a.y, { strength: 1, speed: 120, life: 1.1, maxR: 80 }); HM.FX && HM.FX.splash && HM.FX.splash(a.x, a.y, 1.2); HM.Audio && HM.Audio.play && HM.Audio.play('dodge', { x: a.x, y: a.y, pitch: 0.6, vol: 0.5 }); }
          st.w = !!wade;
          if (wade) { wx = a.x; wy = a.y; }
          const gap = rolling && wade ? 0.08 : wade && moved ? 0.2 : moved ? 0.36 : 1.1;
          if (t - st.t > gap) {
            st.t = t;
            World._spawnRipple(F, wx, wy, rolling && wade ? { strength: 1, speed: 110, life: 1.0, maxR: 70 } : moved ? { strength: wade ? 0.95 : 0.8, speed: wade ? 70 : 55, life: 1.6, maxR: wade ? 84 : 72 } : { strength: 0.62, speed: 30, life: 2.6, maxR: 64 });
            if (wade && moved && HM.FX && HM.FX.splash && (rolling || M.hash2(a.id | 0, (t * 10) | 0) < 0.45)) HM.FX.splash(a.x, a.y, rolling ? 1.1 : 0.45);
          }
        }
        // stones / pillars / trees standing in the water: slow idle rings
        const wet = F.wetProps;
        if (wet) for (let n = 0; n < wet.length; n++) {
          const p = wet[n]; if (!R.inViewWorld(p.x, p.y, 160)) continue;
          if (p._ripNext === undefined) p._ripNext = t + M.hash2(p.seed | 0, 3) * 2;
          if (t >= p._ripNext) { p._ripNext = t + 2.4 + M.hash2(p.seed | 0, (t * 10) | 0) * 1.6; World._spawnRipple(F, p._wx, p._wy, { strength: 0.42, speed: 22, life: 3.4, maxR: Math.min(110, 40 + (p.rad || 16)) }); }
        }
      }
      // projectiles over the liquid: quick splash rings while they skim it, a bigger one where they come down
      const PJ = G && G.projectiles;
      const prev = World._pjPrev || (World._pjPrev = []);
      for (let n = 0; n < prev.length; n++) { const p = prev[n]; if (p.dead) { const st = RIP_ST.get(p); if (st && st.w) World.ripple(p.x, p.y, { strength: 0.95, speed: 140, life: 0.95, maxR: 64 }); } }
      prev.length = 0;
      if (PJ) for (let n = 0; n < PJ.length; n++) {
        const p = PJ[n]; if (p.dead) continue;
        prev.push(p);
        const tp = World._typeAt(F, p.x, p.y), w = (tp === T.WATER || tp === T.DEEP) && (p.z || 0) < 130; // shots fly at chest height: they still stir the surface
        const st = rippleStateOf(p); st.w = w;
        if (w && t - st.t > 0.085 && R.inViewWorld(p.x, p.y, 100)) { st.t = t; World.ripple(p.x, p.y, { strength: 0.7, speed: 120, life: 0.65, maxR: 40 }); }
      }
      // ambient: a rise ring now and then somewhere in view (water); molten rings welling up (lava)
      World._ripAmbT = (World._ripAmbT || 0) - dt;
      if ((F.hasWater || F.hasLava) && World._ripAmbT <= 0) {
        World._ripAmbT = F.hasLava ? 0.3 : 0.9;
        const s = (t * 7) | 0;
        for (let tries = 0; tries < 6; tries++) {
          const x = R.originPx + M.hash2(s, tries * 2 + 1) * R.viewW, y = (R.originPy + M.hash2(s, tries * 2 + 2) * R.viewH) / TILT;
          const tp = World._typeAt(F, x, y); if (tp !== T.WATER && tp !== T.DEEP) continue;
          if (F.hasLava) World.ripple(x, y, { strength: 0.55, speed: 16, life: 3.6, maxR: 46 });
          else World.ripple(x, y, { strength: 0.32, speed: 34, life: 2.0, maxR: 48 });
          break;
        }
      }
    },
    // Bone barricade in the prologue (and any 'barricade' prop): solid until opened; opening shatters it into rubble.
    setBarricade(open) {
      const F = World.floor; if (!F) return false;
      let any = false;
      for (const p of F.props) {
        if (p.kind !== 'barricade' || !!p.open === !!open) continue;
        p.open = !!open; p.openT = World.t; any = true;
        if (open) {
          HM.FX && HM.FX.burst && HM.FX.burst(p.x, p.y, 16, 'bone', 34, { r: p.w * 0.45 });
          HM.FX && HM.FX.burst && HM.FX.burst(p.x, p.y, 6, 'dust', 16, { r: p.w * 0.4 });
          HM.Audio && HM.Audio.play && HM.Audio.play('bone_break', { x: p.x, y: p.y });
        }
      }
      if (any) { Gen.bakeSolid(F); Gen.buildNav(F); F._mapDirty = true; }
      return any;
    },

    _addExit(F) {
      const ex = F.exit; if (!ex) return;
      const last = F.isBoss && F.act === 5;
      F.interactables.push(World.makeInteractable('portal', ex.x, ex.y, { r: 42, label: last ? 'Climb out of the Well' : 'Descend', canInteract: () => F.exitOpen }));
    },

    // Interactable factory: dispatches to HM.Interact[kind](obj, player)
    makeInteractable(kind, x, y, extra) {
      const o = Object.assign({ kind, x, y, r: 34, label: kind, used: false, hidden: false, canInteract: null }, extra || {});
      o.interact = function (p) { const h = HM.Interact[kind]; if (h) h(o, p); };
      return o;
    },

    _typeAt(F, x, y) { const k = cellK(F, x, y); return k < 0 ? T.VOID : F.type[k]; },
    // terrain kind under a world point: 'ground' | 'stone' | 'road' | 'pool' | 'crack' | 'water' | 'wall' | 'void'
    groundAt(x, y) {
      const F = World.floor; if (!F) return 'ground';
      const t = World._typeAt(F, x, y);
      return t === T.GRASS ? 'ground' : t === T.STONE ? 'stone' : t === T.DIRT ? 'road' : t === T.POOL ? 'pool' : t === T.CRACK ? 'crack' : t === T.WATER || t === T.DEEP ? 'water' : t === T.THICKET ? 'wall' : 'void';
    },

    randomOpenPoint(rng, F, nx, ny, minR, maxR) {
      F = F || World.floor; if (!F) return null;
      rng = rng || HM.rng;
      const has = nx !== undefined && nx !== null;
      const reach = F.nav ? F.nav.dist : null;
      for (let n = 0; n < 240; n++) {
        let x, y;
        if (has && maxR && maxR < 1e5) { const a = rng.range(0, Math.PI * 2), d = rng.range(minR || 0, maxR); x = nx + Math.cos(a) * d; y = ny + Math.sin(a) * d; }
        else { x = rng.range(60, F.w - 60); y = rng.range(60, F.h - 60); }
        if (x < 30 || y < 30 || x > F.w - 30 || y > F.h - 30) continue;
        if (Gen.blockedAt(F, x, y, 12, S_ALL)) continue;
        if (has) { const d = M.dist(x, y, nx, ny); if (d < (minR || 0) || d > (maxR || 1e9)) continue; }
        if (reach) { const c = Math.floor(y / F.nav.gs) * F.nav.gw + Math.floor(x / F.nav.gs); if (reach[c] < 0) continue; }
        return [x, y];
      }
      // fallback: nearest walkable reachable spot to the requested centre (never null on a valid floor)
      if (F.nav) { const c = Gen.nearestWalk(F, has ? nx : F.start.x, has ? ny : F.start.y); if (c >= 0) return [(c % F.nav.gw + 0.5) * F.nav.gs, (((c / F.nav.gw) | 0) + 0.5) * F.nav.gs]; }
      return [F.start.x, F.start.y];
    },

    // ------------------------------------------------------------------ collision
    _solidAt(F, x, y) {
      if (x < 0 || y < 0 || x >= F.w || y >= F.h) return S_ALL;
      const i = Math.floor(x / CW), j = Math.floor(y / RW);
      return F.solid[j * F.cols + i];
    },
    isSolidF(F, x, y) { return !!F && World._solidAt(F, x, y) !== 0; },
    isSolid(x, y) { const F = World.floor; return !!F && World._solidAt(F, x, y) !== 0; },
    // walls only (props, cliffs, thickets) — what projectiles and sight should collide with; liquids/void don't block shots
    isWall(x, y) { const F = World.floor; return !!F && (World._solidAt(F, x, y) & S_WALL) !== 0; },

    // Move-with-collision: from actor's current position toward (x,y); sub-stepped (no tunnelling), slides along walls,
    // and pushes an actor that is somehow embedded in a solid back out to the nearest free spot.
    resolve(x, y, r, actor) {
      const F = World.floor; if (!F) return [x, y];
      if (actor && actor.ghost) return [M.clamp(x, 1, F.w - 1), M.clamp(y, 1, F.h - 1)];
      const mask = actor && actor.flying ? S_WALL : S_ALL;
      r = Math.max(2, Math.min(r || 8, 40));
      if (!actor) return Gen.blockedAt(F, x, y, r, mask) ? World._unstick(F, x, y, r, mask) : [x, y];
      let cx = actor.x, cy = actor.y;
      if (Gen.blockedAt(F, cx, cy, r * 0.5, mask)) { const u = World._unstick(F, cx, cy, r, mask); cx = u[0]; cy = u[1]; }
      const dx = x - actor.x, dy = y - actor.y, dist = Math.hypot(dx, dy);
      if (dist < 1e-6) return [cx, cy];
      if (dist > 90) return Gen.blockedAt(F, x, y, r, mask) ? World._unstick(F, x, y, r, mask) : [x, y]; // teleport / blink
      const steps = Math.min(40, Math.max(1, Math.ceil(dist / 4))), sx = dx / steps, sy = dy / steps;
      for (let s = 0; s < steps; s++) {
        const nx = cx + sx, ny = cy + sy;
        if (!Gen.blockedAt(F, nx, ny, r, mask)) { cx = nx; cy = ny; continue; }
        // slide: project the step onto the tangent of the blocking surface
        let px = 0, py = 0;
        for (let a = 0; a < 48; a += 2) if (World._solidAt(F, nx + SC[a] * r, ny + SS[a] * r) & mask) { px += SC[a]; py += SS[a]; }
        const pl = Math.hypot(px, py);
        if (pl > 1e-6) {
          px /= pl; py /= pl; const dn = sx * px + sy * py;
          if (dn > 0) { const tx = sx - px * dn, ty = sy - py * dn; if (!Gen.blockedAt(F, cx + tx, cy + ty, r, mask)) { cx += tx; cy += ty; continue; } }
        }
        if (!Gen.blockedAt(F, nx, cy, r, mask)) { cx = nx; continue; }
        if (!Gen.blockedAt(F, cx, ny, r, mask)) { cy = ny; continue; }
        break;
      }
      return [cx, cy];
    },
    // nearest free spot for a body of radius r (spiral search; cheap centre test first), else the nearest walkable nav cell
    _unstick(F, x, y, r, mask) {
      for (let d = 3; d < 200; d += d < 30 ? 3 : 6) {
        const n = Math.min(24, 6 + (d / 4) | 0);
        for (let a = 0; a < n; a++) {
          const ang = (a / n) * Math.PI * 2 + d * 0.13, px = x + Math.cos(ang) * d, py = y + Math.sin(ang) * d;
          if (World._solidAt(F, px, py) & mask) continue;
          if (!Gen.blockedAt(F, px, py, r, mask)) return [px, py];
        }
      }
      if (F.nav) { const c = Gen.nearestWalk(F, x, y); if (c >= 0) return [(c % F.nav.gw + 0.5) * F.nav.gs, (((c / F.nav.gw) | 0) + 0.5) * F.nav.gs]; }
      return [F.start.x, F.start.y];
    },
    // line of sight: walls block, liquids/void don't
    los(x0, y0, x1, y1) {
      const F = World.floor; if (!F) return true;
      const d = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(d / 4);
      for (let s = 1; s < n; s++) { const t = s / n; if (World._solidAt(F, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t) & S_WALL) return false; }
      return true;
    },
    // straight walkable path for a body of radius r?
    clearPath(x0, y0, x1, y1, r) {
      const F = World.floor; if (!F) return true;
      const d = Math.hypot(x1 - x0, y1 - y0), n = Math.ceil(d / 8);
      for (let s = 1; s <= n; s++) { const t = s / n; if (Gen.blockedAt(F, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r || 6, S_ALL)) return false; }
      return true;
    },
    // Steering helper for AI: unit direction from (x,y) toward (tx,ty) that walks around obstacles.
    // Uses a straight line when clear, otherwise a BFS flow field toward the player (refreshed ~4×/s) or the target.
    steer(x, y, tx, ty, r) {
      const F = World.floor, dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy) || 1;
      if (!F || !F.nav || d < 24 || World.clearPath(x, y, tx, ty, r || 8)) return [dx / d, dy / d];
      const nav = F.nav, gs = nav.gs, gw = nav.gw;
      const tc = Gen.nearestWalk(F, tx, ty); if (tc < 0) return [dx / d, dy / d];
      if (nav.pdCell !== tc || World.t - nav.pdT > 0.25) { Gen.bfs(F, nav.pd, tx, ty); nav.pdCell = tc; nav.pdT = World.t; }
      const c = Math.floor(y / gs) * gw + Math.floor(x / gs), cx = c % gw;
      let best = -1, bv = nav.pd[c] >= 0 ? nav.pd[c] : 1e9;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nb = c + oy * gw + ox; if (cx + ox < 0 || cx + ox >= gw || nb < 0 || nb >= nav.pd.length) continue;
        const v = nav.pd[nb]; if (v < 0) continue;
        if (ox && oy && (!nav.walk[c + ox] || !nav.walk[c + oy * gw])) continue; // no corner cutting
        if (v < bv) { bv = v; best = nb; }
      }
      if (best < 0) return [dx / d, dy / d];
      const bx = (best % gw + 0.5) * gs - x, by = (((best / gw) | 0) + 0.5) * gs - y, bl = Math.hypot(bx, by) || 1;
      return [bx / bl, by / bl];
    },
    _propAt(x, y) { const F = World.floor; if (!F) return null; for (const p of F.props) if (Math.abs(x - p.x) < p.w / 2 && Math.abs(y - p.y) < (p.d || 10) / 2) return p; return null; },

    // ------------------------------------------------------------------ update
    update(dt) {
      World.t += dt;
      const F = World.floor; if (!F) return;
      if (F.exitOpen && !World._prevOpen) { F._openT = 0; for (const o of F.interactables) if (o.reward) o.hidden = false; }
      World._prevOpen = F.exitOpen;
      if (F._openT !== undefined) F._openT += dt;
      if (dt > 0 && (F.hasWater || F.hasLava)) World._autoRipples(F, dt);
      // nobody stays embedded in a prop (spawn scatter, knockback into corners, summons)
      const G = HM.Game; if (!G || !G.entities) return;
      const ents = G.entities;
      for (let n = 0; n < ents.length; n++) {
        const a = ents[n]; if (a.dead || a.ghost || a.anchored) continue;
        const mask = a.flying ? S_WALL : S_ALL, r = Math.max(2, Math.min(a.radius || 8, 40));
        if (Gen.blockedAt(F, a.x, a.y, r * 0.55, mask)) { const u = World._unstick(F, a.x, a.y, r, mask); a.x = u[0]; a.y = u[1]; }
      }
    },

    // ------------------------------------------------------------------ draw
    draw() {
      const F = World.floor; if (!F) return;
      const t = World.t, B = F.biome;
      const cols = R.cols, rows = R.rows, ci0 = R.ci0, cj0 = R.cj0;
      const key = R.KEY_GROUND, FG = R.F_GROUND, UNLIT = R.F_UNLIT;
      // movers bend the grass
      const mv = World._movers || (World._movers = []); mv.length = 0;
      if (F.biomeId === 'grass') { const ents = HM.Game ? HM.Game.entities : []; for (const a of ents) if (!a.dead && R.inViewWorld(a.x, a.y, 60)) mv.push(a.x, a.y * TILT, (a.radius || 8) * 2.6); }
      const glyph = R.glyph, col = R.col, keyb = R.key, flag = R.flag, shd = R.shd;
      const fcls = F.cls, fg = F.g, fc = F.c, fe = F.e, fh1 = F.h1, fh2 = F.h2, fn1 = F.n1, fsh = F.shadow, faux = F.aux, fsd = F.shoreD;
      const FC = F.cols, FR = F.rows;
      // wind = sin(t*1.4 - wx*.011 - wy*.004)*.55 + sin(t*.63 + wx*.027 + wy*.02)*.25 — separable
      const W = World._wind && World._wind.length >= (cols + rows) * 4 ? World._wind : (World._wind = new Float32Array((cols + rows) * 4 + 8));
      for (let x = 0; x < cols; x++) { const wx = (ci0 + x) * CW; const a1 = t * 1.4 - wx * 0.011, a2 = t * 0.63 + wx * 0.027; W[x * 4] = Math.sin(a1); W[x * 4 + 1] = Math.cos(a1); W[x * 4 + 2] = Math.sin(a2); W[x * 4 + 3] = Math.cos(a2); }
      const RO = cols * 4;
      for (let y = 0; y < rows; y++) { const wy = (cj0 + y) * CH; const b1 = wy * 0.004, b2 = wy * 0.02; W[RO + y * 4] = Math.sin(b1); W[RO + y * 4 + 1] = Math.cos(b1); W[RO + y * 4 + 2] = Math.sin(b2); W[RO + y * 4 + 3] = Math.cos(b2); }
      // Liquid wave field (DESIGN §10): four travelling waves, separable per column/row (sin(A+B) = sA·cB + cA·sB), world-anchored.
      //  w1 long low swell with near-horizontal crests · w2 a cross swell · w3 slow break-up · w4 the short moon-glitter dashes
      const WQ = World._wq && World._wq.length >= (cols + rows) * 8 ? World._wq : (World._wq = new Float32Array((cols + rows) * 8 + 16));
      const ls = F.biomeId === 'fire' ? 0.35 : 1, RO8 = cols * 8;
      for (let x = 0; x < cols; x++) {
        const ci = ci0 + x, q = x * 8, a1 = ci * 0.05 - t * 0.85 * ls, a2 = -ci * 0.09 + t * 0.55 * ls, a3 = ci * 0.17 + t * 0.35 * ls, a4 = ci * 0.85 - t * 1.25;
        WQ[q] = Math.sin(a1); WQ[q + 1] = Math.cos(a1); WQ[q + 2] = Math.sin(a2); WQ[q + 3] = Math.cos(a2); WQ[q + 4] = Math.sin(a3); WQ[q + 5] = Math.cos(a3); WQ[q + 6] = Math.sin(a4); WQ[q + 7] = Math.cos(a4);
      }
      for (let y = 0; y < rows; y++) {
        const cj = cj0 + y, q = RO8 + y * 8, b1 = cj * 0.4, b2 = cj * 0.27, b3 = cj * 0.13, b4 = cj * 1.9;
        WQ[q] = Math.sin(b1); WQ[q + 1] = Math.cos(b1); WQ[q + 2] = Math.sin(b2); WQ[q + 3] = Math.cos(b2); WQ[q + 4] = Math.sin(b3); WQ[q + 5] = Math.cos(b3); WQ[q + 6] = Math.sin(b4); WQ[q + 7] = Math.cos(b4);
      }
      // (no moon column here: the renderer's mirror pass owns the moon disc, cloud and shore reflections on water cells)
      const wat = B.water || [0.1, 0.2, 0.4], foam = B.foam || [0.8, 0.9, 1], lava = B.lava || [1.5, 0.55, 0.08], crust = B.crust || [0.2, 0.07, 0.03];
      const gLo = B.grassLo || [0.1, 0.2, 0.1], gHi = B.grassHi || [0.3, 0.5, 0.3], fl = B.fleck || [0.9, 0.9, 0.9];
      const moteS = (t * 3) | 0, poolSweep = t * 0.6, crackT = t * 2.1, iceF = F.biomeId === 'ice';
      for (let y = 0; y < rows; y++) {
        const cj = cj0 + y, rowIn = cj >= 0 && cj < FR;
        const rowK = cj * FC;
        const sb1 = W[RO + y * 4], cb1 = W[RO + y * 4 + 1], sb2 = W[RO + y * 4 + 2], cb2 = W[RO + y * 4 + 3];
        const dyOut = cj < 0 ? -cj : cj >= FR ? cj - FR + 1 : 0;
        const qy = RO8 + y * 8;
        for (let x = 0; x < cols; x++) {
          const ci = ci0 + x;
          // Beyond the map edge (DESIGN §8): never sample the map. A biome-themed boundary band, then near-black void.
          if (!rowIn || ci < 0 || ci >= FC) {
            const q = x * 8, wn = 0.5 + 0.3 * (WQ[q] * WQ[qy + 1] + WQ[q + 1] * WQ[qy]) + 0.2 * (WQ[q + 2] * WQ[qy + 3] + WQ[q + 3] * WQ[qy + 2]);
            drawBand(F, y * cols + x, ci, cj, ci < 0 ? -ci : ci >= FC ? ci - FC + 1 : 0, dyOut, wn, t);
            continue;
          }
          const k = rowK + ci, cl = fcls[k];
          if (cl === C_SKIP) continue;
          const i = y * cols + x, o = i * 3;
          let g, r, gg, b;
          if (cl === C_STATIC) { g = fg[k]; const q = k * 3; r = fc[q]; gg = fc[q + 1]; b = fc[q + 2]; }
          else if (cl === C_GRASS) {
            const h2 = fh2[k], gb = fg[k];
            if (h2 < 0.02) { // pale flecks (dew / firefly dust); the rarest twinkle
              g = gb; const q3 = k * 3; let br = fc[q3];
              if (h2 < 0.005) br += 0.3 * (0.5 + 0.5 * Math.sin(t * 3 + fh1[k] * 50));
              r = fl[0] * br; gg = fl[1] * br; b = fl[2] * br;
            } else {
              const q = x * 4;
              const wave = (W[q] * cb1 - W[q + 1] * sb1) * 0.55 + (W[q + 2] * cb2 + W[q + 3] * sb2) * 0.25;
              if (gb) g = gb; // short tuft: no lean
              else {
                let lean = (h2 - 0.5) * 1.1 + wave * 0.9;
                if (mv.length) {
                  const wx = ci * CW, wy = cj * CH;
                  for (let m = 0; m < mv.length; m += 3) {
                    const dx = wx - mv[m], dy = (wy - mv[m + 1]) / TILT, rr = mv[m + 2];
                    const d2 = dx * dx + dy * dy; if (d2 < rr * rr) lean += (dx < 0 ? -1 : 1) * (1 - Math.sqrt(d2) / rr) * 2.2;
                  }
                }
                g = lean < -0.45 ? GL.bladeL[(h2 * 13) % GL.bladeL.length | 0] : lean > 0.45 ? GL.bladeR[(h2 * 13) % GL.bladeR.length | 0] : GL.bladeC[(h2 * 17) % GL.bladeC.length | 0];
              }
              let v = fe[k] + (wave > 0 ? wave * 0.22 : 0);
              v = v < 0.05 ? 0.05 : v > 0.95 ? 0.95 : v;
              r = gLo[0] + (gHi[0] - gLo[0]) * v; gg = gLo[1] + (gHi[1] - gLo[1]) * v; b = gLo[2] + (gHi[2] - gLo[2]) * v;
            }
          } else if (cl === C_WATER) {
            // Night mirror water (the reels' fishing scene): near-black, a sparse fine dot texture whose density follows a slow
            // world-anchored wave field, a few long thin drifting crest streaks, pulsing shore foam, deep water darker and
            // sparser, a dark contact band around anything standing in it. Ripple rings are laid over it after this pass;
            // the renderer's mirror pass then adds the shore reflections, the moon disc and the clouds (and dims it further).
            const sd = fsd[k], h = fh1[k], q = x * 8;
            const w1 = WQ[q] * WQ[qy + 1] + WQ[q + 1] * WQ[qy], w2 = WQ[q + 2] * WQ[qy + 3] + WQ[q + 3] * WQ[qy + 2], w3 = WQ[q + 4] * WQ[qy + 5] + WQ[q + 5] * WQ[qy + 4];
            const nn = fn1[k];
            const n = 0.5 + 0.26 * w1 + 0.16 * w2 + 0.08 * w3 + (nn - 0.5) * 0.36;
            const deep = sd > 7 ? 0.5 : sd > 3 ? 0.75 : 1, contact = faux[k], bt = BAYER[((cj & 3) << 2) | (ci & 3)];
            g = 0;
            if (sd <= 2) { // shore foam: a lacy line that laps in and out
              const ph = Math.sin(t * 1.5 - sd * 1.9 + ci * 0.07 + nn * 4);
              if (((sd === 1 && ph > -0.45) || (sd === 2 && ph > 0.5)) && 0.5 + 0.5 * ph > bt * 0.8) {
                g = GL.foam[(h * 37 + t * 2) % GL.foam.length | 0]; const v = 0.3 + 0.34 * (0.5 + 0.5 * ph) + (sd === 1 ? 0.08 : 0);
                r = foam[0] * v; gg = foam[1] * v; b = foam[2] * v;
              }
            }
            if (!g) {
              if (contact < 0.3 && w1 > 0.978 - 0.03 * w2 && w3 + (nn - 0.5) * 1.2 > 0.05) { // a long thin crest streak, drifting
                g = w2 > 0.45 ? G_TILDE : G_DASH;
                const v = (0.5 + 0.2 * w2) * (0.6 + 0.4 * deep);
                r = wat[0] * 1.3 * v + foam[0] * 0.22 * v; gg = wat[1] * 1.3 * v + foam[1] * 0.22 * v; b = wat[2] * 1.3 * v + foam[2] * 0.22 * v;
              } else {
                const dens = (0.06 + (n - 0.25) * 0.62 * (0.45 + 0.55 * deep)) * (1 - contact * 0.9); // sparse; deep water sparser still
                if (dens <= bt) continue;
                g = dens > 0.5 && h > 0.6 ? G_COLON : WDOT[(h * 8) | 0];
                const v = (0.34 + 0.7 * dens) * (0.62 + 0.38 * deep);
                r = wat[0] * v; gg = wat[1] * v; b = wat[2] * v;
              }
            }
            // water keeps its colour (no ground dim / desaturation, so the navy survives); prop shadows baked in
            const sk = 1 - fsh[k] * 0.75;
            keyb[i] = key; glyph[i] = g; col[o] = r * sk; col[o + 1] = gg * sk; col[o + 2] = b * sk; flag[i] = 0; shd[i] = 0;
            continue;
          } else if (cl === C_LAVA) {
            // molten rock: dark crust plates with glowing seams; slow swell; edges cool to a crust rim
            const h = fh1[k], sd = fsd[k], q = x * 8;
            const n = 0.5 + 0.26 * (WQ[q] * WQ[qy + 1] + WQ[q + 1] * WQ[qy]) + 0.16 * (WQ[q + 2] * WQ[qy + 3] + WQ[q + 3] * WQ[qy + 2]) + 0.1 * (WQ[q + 4] * WQ[qy + 5] + WQ[q + 5] * WQ[qy + 4]) + (fn1[k] - 0.5) * 0.45;
            const bt = BAYER[((cj & 3) << 2) | (ci & 3)];
            if (sd <= 1) { g = h < 0.5 ? G_UND : G_EQ; r = crust[0] * 1.7; gg = crust[1] * 1.4; b = crust[2]; R.emitI(i, 0.16, 0.045, 0.01); }
            else if (n < 0.36) { if (0.25 + n < bt) { R.emitI(i, 0.04, 0.01, 0); continue; } g = GL.obsid[(h * 7) % 4 | 0]; const v = 0.55 + h * 0.45; r = crust[0] * v; gg = crust[1] * v; b = crust[2] * v; R.emitI(i, 0.05, 0.012, 0); }
            else {
              const v = 0.45 + (n - 0.36) * 1.3;
              g = GL.lava[((n * 9 + h * 4) | 0) % GL.lava.length];
              r = lava[0] * v; gg = lava[1] * v * (0.7 + v * 0.5); b = lava[2] * v;
              if (n > 0.8) { r = 1.7; gg = 1.25; b = 0.55; g = G_TILDE; }
              R.emitI(i, r * 0.3, gg * 0.3, b * 0.3);
            }
            keyb[i] = key; glyph[i] = g; col[o] = r; col[o + 1] = gg; col[o + 2] = b; flag[i] = UNLIT; shd[i] = 0;
            continue;
          } else if (cl === C_CRACK) {
            g = fg[k]; const q = k * 3;
            const p = 0.55 + 0.45 * Math.sin(crackT - ci * 0.07 - cj * 0.13 + fn1[k] * 3);
            const e = fe[k] * p;
            r = fc[q] * (0.5 + p * 0.6); gg = fc[q + 1] * (0.5 + p * 0.6); b = fc[q + 2] * (0.5 + p * 0.6);
            keyb[i] = key; glyph[i] = g; col[o] = r; col[o + 1] = gg; col[o + 2] = b; flag[i] = UNLIT; shd[i] = 0;
            R.emitI(i, r * e, gg * e, b * e);
            continue;
          } else if (cl === C_SPARK) {
            g = fg[k]; const q = k * 3; const s = Math.sin(t * 2.3 + fe[k] * 7);
            const v = s > 0.8 ? 1.4 : 0.55 + s * 0.15;
            r = fc[q] * v; gg = fc[q + 1] * v; b = fc[q + 2] * v;
            if (s > 0.92) R.emitI(i, r * 0.2, gg * 0.2, b * 0.2);
          } else if (cl === C_POOL) {
            g = fg[k]; const q = k * 3;
            r = fc[q]; gg = fc[q + 1]; b = fc[q + 2];
            if (iceF) { // frozen lake: a slow glint sweeps across; rare twinkles
              const s = Math.sin(ci * 0.045 - cj * 0.09 + poolSweep);
              if (s > 0.94) { const v = 1 + (s - 0.94) * 12; r *= v; gg *= v; b *= v; if (g) g = G_EQ; }
              const h2 = fh2[k];
              if (h2 < 0.012 && Math.sin(t * 2.1 + fh1[k] * 60) > 0.86) { g = h2 < 0.005 ? G_STAR : G_PLUS; r = 1.0; gg = 1.05; b = 1.15; R.emitI(i, 0.12, 0.13, 0.16); }
            } else { // candy rot: bubbles swell and pop at fixed vents
              const h2 = fh2[k];
              if (h2 < 0.03) { const ph = (t * 0.45 + fh1[k] * 13) % 1; g = ph < 0.4 ? G_DOT : ph < 0.7 ? G_o : ph < 0.9 ? G_O : G_DEG; const v = 0.6 + ph * 0.6; r = 0.8 * v; gg = 0.35 * v; b = 0.55 * v; }
              else { const s = 0.85 + 0.15 * Math.sin(t * 0.9 + fe[k]); r *= s; gg *= s; b *= s; }
            }
            if (!g) continue;
          } else if (cl === C_VOID) {
            if (fsd[k] <= 1 || fe[k] > 0) { g = fg[k]; const q = k * 3; r = fc[q]; gg = fc[q + 1]; b = fc[q + 2]; } // lip / shaft wall
            else {
              const kk = ((cj + moteS) % FR) * FC + ci;
              const hm = fh2[kk];
              if (hm > 0.014) continue;
              const v = (1 - hm / 0.014) * (fsd[k] < 8 ? 1 : 0.5);
              g = hm < 0.004 ? G_o : G_DOT; r = 0.25 * v; gg = 0.95 * v; b = 0.4 * v;
              keyb[i] = key; glyph[i] = g; col[o] = r; col[o + 1] = gg; col[o + 2] = b; flag[i] = UNLIT; shd[i] = 0;
              R.emitI(i, r * 0.4, gg * 0.4, b * 0.4);
              continue;
            }
          } else continue;
          keyb[i] = key; glyph[i] = g; col[o] = r; col[o + 1] = gg; col[o + 2] = b; flag[i] = FG;
          shd[i] = fsh[k];
        }
      }
      // ripple rings over the liquid (before props, so props and interactables stay on top)
      if (World._ripN) World._drawRipples(F, t);
      // props (culled)
      for (const p of F.props) {
        const m = (p.h || 0) + (p.w || 0) + 80;
        if (!R.inViewWorld(p.x, p.y, m)) continue;
        const fn = DRAW[p.kind]; if (fn) fn(p, B, t);
      }
      // static lights (culled)
      for (const L of F.lights) {
        if (!R.inViewWorld(L.x, L.y, L.r + 40)) continue;
        let k = L.i;
        if (L.lamp) { k *= lampLevel(L.prop, t); if (k < 0.02) continue; }
        else if (L.prop && L.prop.lit === false) continue;
        else if (L.flick) k *= 1 - L.flick * (0.5 + 0.3 * Math.sin(t * 7.3 + L.ph) + 0.2 * Math.sin(t * 13.1 + L.ph * 2));
        if (L.pulse) k *= 0.75 + 0.25 * Math.sin(t * 2.1 - L.x * 0.07 - L.y * 0.1);
        R.light(L.x, L.y, L.z, L.r, L.c[0], L.c[1], L.c[2], k);
      }
      // interactables
      for (const o of F.interactables) {
        if (!R.inViewWorld(o.x, o.y, 160)) continue;
        const fn = IDRAW[o.kind]; if (fn) fn(o, F, t);
      }
    },

    // Concentric ripple rings (World.ripple): elliptical by the ground tilt, lighter than the water, expanding, thinning and
    // fading. Each ring is rasterized as two horizontal spans per row (cheap), and only over liquid terrain cells.
    _drawRipples(F, t) {
      const RP = World._rip, cols = R.cols, rows = R.rows, ci0 = R.ci0, cj0 = R.cj0, FC = F.cols, FR = F.rows, ty = F.type, h1 = F.h1;
      const glyph = R.glyph, col = R.col, keyb = R.key, flag = R.flag, KG = R.KEY_GROUND, FG = R.F_GROUND, UNLIT = R.F_UNLIT;
      const B = F.biome, lavaF = F.biomeId === 'fire';
      const wat = B.water || [0.1, 0.2, 0.4], foam = B.foam || [0.8, 0.9, 1];
      let live = 0;
      for (let n = 0; n < RP.length; n++) {
        const rp = RP[n]; if (!rp.on) continue;
        const age = t - rp.t0;
        if (age > rp.life || age < -1) { rp.on = false; continue; }
        live++;
        if (age < 0 || !R.inViewWorld(rp.x, rp.y, rp.maxR + 30)) continue;
        const f = age / rp.life, a = rp.str * Math.pow(1 - f, 1.25);
        const cx = rp.x, cy = rp.y * TILT, base = Math.min(rp.maxR, rp.spd * age * (1 - 0.3 * f));
        for (let ring = 0; ring < 3; ring++) {
          const rr = base - ring * (6 + rp.maxR * 0.12);
          if (rr < 3) break;
          const aa = a * (ring === 0 ? 1 : ring === 1 ? 0.62 : 0.36);
          if (aa < 0.05) break;
          const th = Math.max(2, 6.5 - f * 4.5);
          const ro0 = rr + th * 0.5 + RW;
          const cjA = Math.max(cj0, Math.floor((cy - ro0 * TILT) / CH)), cjB = Math.min(cj0 + rows - 1, Math.floor((cy + ro0 * TILT) / CH));
          for (let cj = cjA; cj <= cjB; cj++) {
            if (cj < 0 || cj >= FR) continue;
            const dy = ((cj + 0.5) * CH - cy) / TILT, ady = dy < 0 ? -dy : dy;
            const slope = ady / rr > 1 ? 1 : ady / rr;
            const tol = th * 0.5 + RW * 0.5 * slope + CW * 0.5;
            const ro = rr + tol, ri = rr - tol;
            if (ady >= ro) continue;
            const xo = Math.sqrt(ro * ro - dy * dy), xi = ady < ri ? Math.sqrt(ri * ri - dy * dy) : 0;
            const y = cj - cj0, rowK = cj * FC;
            for (let side = -1; side <= 1; side += 2) {
              const xa = side < 0 ? cx - xo : cx + xi, xb = side < 0 ? cx - xi : cx + xo;
              const ciA = Math.max(ci0, Math.max(0, Math.floor(xa / CW))), ciB = Math.min(ci0 + cols - 1, Math.min(FC - 1, Math.floor(xb / CW)));
              for (let ci = ciA; ci <= ciB; ci++) {
                const k = rowK + ci, tt = ty[k]; if (tt !== T.WATER && tt !== T.DEEP) continue;
                const i = y * cols + (ci - ci0); if (keyb[i] > KG) continue;
                if (aa < BAYER[((cj & 3) << 2) | (ci & 3)] * 0.85) continue; // ordered fade-out
                const g = slope > 0.74 ? (h1[k] < 0.5 ? G_DASH : G_TILDE) : slope < 0.3 ? (side < 0 ? G_LPAR : G_RPAR) : ((side < 0) === (dy < 0) ? G_FS : G_BS);
                const o = i * 3;
                keyb[i] = KG; glyph[i] = g;
                if (lavaF) { const v = 0.5 + aa * 0.9; col[o] = 1.6 * v; col[o + 1] = 0.75 * v; col[o + 2] = 0.2 * v; flag[i] = UNLIT; R.emitI(i, 0.35 * v, 0.12 * v, 0.02 * v); }
                else { const v = 0.5 + aa * 0.4; col[o] = (wat[0] * 0.9 + foam[0] * aa * 0.7) * v; col[o + 1] = (wat[1] * 0.9 + foam[1] * aa * 0.7) * v; col[o + 2] = (wat[2] * 0.9 + foam[2] * aa * 0.7) * v; flag[i] = 0; }
              }
            }
          }
        }
      }
      World._ripN = live;
    },

    // ------------------------------------------------------------------ weather / fog (drawn after actors)
    drawOver() {
      const F = World.floor; if (!F) return;
      const B = F.biome, t = World.t;
      World._fog(F, B, t);
      switch (B.weather) {
        case 'fireflies': World._fireflies(F, t); break;
        case 'sugar': World._fall(t, 70, GL.ember, [0.95, 0.72, 0.85], 6, 20, 8, 0.15, false); break;
        case 'blizzard': World._streaks(t, 230); World._fall(t, 90, GL.snowFall, [0.85, 0.92, 1.0], -60, 95, 14, 0.05, false); break;
        case 'ash': World._fall(t, 110, GL.ash, [0.42, 0.4, 0.4], -8, 16, 10, 0, false); World._fall(t, 46, GL.ember, [1.3, 0.5, 0.12], 6, -26, 14, 0.6, true); break;
        case 'motes': World._fall(t, 60, GL.motes, [0.3, 1.0, 0.45], 4, -14, 12, 0.5, true); break;
      }
    },

    _fog(F, B, t) {
      const amt = B.fogAmount || 0; if (amt <= 0) return;
      const cols = R.cols, rows = R.rows, ci0 = R.ci0, cj0 = R.cj0, fc = B.fog, drift = B.fogDrift || [0.09, -0.03];
      // density on a coarse world-anchored grid (every 4 cols x 2 rows), bilinear upsampled
      const SX = 4, SY = 2;
      const gx0 = Math.floor(ci0 / SX), gy0 = Math.floor(cj0 / SY);
      const gw = Math.ceil(cols / SX) + 2, gh = Math.ceil(rows / SY) + 2;
      const grid = World._fogGrid && World._fogGrid.length >= gw * gh ? World._fogGrid : (World._fogGrid = new Float32Array(gw * gh * 2));
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const ci = (gx0 + x) * SX, cj = (gy0 + y) * SY;
        grid[y * gw + x] = M.fbm(ci * 0.028 + t * drift[0], cj * 0.06 + t * drift[1], 3);
      }
      const tint = B.fogTint || 0.55, gk = B.fogGlyph === undefined ? 0.45 : B.fogGlyph, ek = B.fogEmit || 0.035;
      const thr = 1 - amt * 0.75, fr = fc[0] * tint, fg2 = fc[1] * tint, fb = fc[2] * tint;
      const glyph = R.glyph, col = R.col, keyb = R.key, flg = R.flag, FC = F.cols, FR = F.rows, h1 = F.h1;
      const FIG = R.F_FIGURE || 0, tq = Math.floor(t * 2);
      for (let y = 0; y < rows; y++) {
        const cj = cj0 + y; const fy = cj / SY - gy0; const iy = Math.floor(fy), ty = fy - iy;
        for (let x = 0; x < cols; x++) {
          const ci = ci0 + x; const fx = ci / SX - gx0; const ix = Math.floor(fx), tx = fx - ix;
          const g0 = iy * gw + ix;
          const a = grid[g0] + (grid[g0 + 1] - grid[g0]) * tx, b = grid[g0 + gw] + (grid[g0 + gw + 1] - grid[g0 + gw]) * tx;
          let d = ((a + (b - a) * ty) - thr) * 3.2; if (d <= 0) continue; if (d > 1) d = 1;
          const i = y * cols + x, o = i * 3, m = d * ((flg[i] & FIG) ? 0.18 : 0.55); // figures stay readable through fog
          col[o] += (fr - col[o]) * m; col[o + 1] += (fg2 - col[o + 1]) * m; col[o + 2] += (fb - col[o + 2]) * m;
          const hb = (ci >= 0 && cj >= 0 && ci < FC && cj < FR) ? h1[cj * FC + ci] : 0.5; const hh = hb * 7.31 + ((tq + ci * 0.1) | 0) * 0.618; const h = hh - Math.floor(hh);
          if (h < d * gk && keyb[i] < 0) { glyph[i] = GL.fog[(h * 101) % GL.fog.length | 0]; const v = 0.5 + d * 0.4; col[o] = fc[0] * v; col[o + 1] = fc[1] * v; col[o + 2] = fc[2] * v; }
          R.emitI(i, fc[0] * d * ek, fc[1] * d * ek, fc[2] * d * ek * 1.1);
        }
      }
    },

    // world-anchored wrap of a hashed particle into the view (projected px)
    _wrap(v, origin, span) { const m = (v - origin) % span; return origin + (m < 0 ? m + span : m); },
    // weather glyph: drawn over terrain/props, but never over a figure cell (figures must read cleanly)
    _wx(px, py, g, r, gg, b, emis) {
      const i = R.idxP(px, py); if (i < 0 || (R.flag[i] & (R.F_FIGURE || 0))) return;
      if (R.setI(i, g, r, gg, b, R.KEY_TOP - 10, R.F_UNLIT) && emis) R.emitI(i, r * emis, gg * emis, b * emis);
    },

    // falling / rising glyph particles: vx, vy in projected px/s; sway px; emis → glow; tw = twinkle
    _fall(t, n, gl, c, vx, vy, sway, emis, tw) {
      const pad = 40, ox = R.originPx - pad, oy = R.originPy - pad, sw = R.viewW + pad * 2, shh = R.viewH + pad * 2;
      const scale = (R.viewW * R.viewH) / (1166 * 672); // density relative to the default view
      const cnt = Math.min(400, Math.round(n * scale));
      for (let p = 0; p < cnt; p++) {
        const h1 = M.hash2(p, 71), h2 = M.hash2(p, 913), h3 = M.hash2(p, 37);
        const spd = 0.6 + h3 * 0.8;
        const px = World._wrap(h1 * 9000 + vx * spd * t + Math.sin(t * (0.6 + h2) + p) * sway, ox, sw);
        const py = World._wrap(h2 * 9000 + vy * spd * t, oy, shh);
        let k = 0.55 + h3 * 0.6;
        if (tw) k *= 0.6 + 0.4 * Math.sin(t * (2 + h1 * 3) + p);
        World._wx(px, py, gl[(h1 * 53) % gl.length | 0], c[0] * k, c[1] * k, c[2] * k, emis);
      }
    },
    // blizzard: diagonal streaks of driven snow
    _streaks(t, n) {
      const pad = 60, ox = R.originPx - pad, oy = R.originPy - pad, sw = R.viewW + pad * 2, shh = R.viewH + pad * 2;
      const cnt = Math.min(400, Math.round(n * (R.viewW * R.viewH) / (1166 * 672)));
      for (let p = 0; p < cnt; p++) {
        const h1 = M.hash2(p, 5), h2 = M.hash2(p, 55), h3 = M.hash2(p, 555);
        const spd = 0.7 + h3 * 0.9;
        const px = World._wrap(h1 * 9000 - 230 * spd * t, ox, sw), py = World._wrap(h2 * 9000 + 340 * spd * t, oy, shh);
        const len = 10 + h3 * 20, k = 0.55 + h3 * 0.6;
        for (let q = 0; q <= len; q += 5) World._wx(px + q * 0.56, py - q * 0.83, G_FS, 0.8 * k, 0.88 * k, 1.0 * k, 0);
      }
    },
    // fireflies: world-tiled, wandering, slow pulse; a few at a time
    _fireflies(F, t) {
      const TS = 260, x0 = Math.floor((R.originPx - 40) / TS), x1 = Math.floor((R.originPx + R.viewW + 40) / TS);
      const y0 = Math.floor((R.originPy - 40) / TS), y1 = Math.floor((R.originPy + R.viewH + 40) / TS);
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
        for (let q = 0; q < 2; q++) {
          const h1 = M.hash3(tx, ty, q), h2 = M.hash3(tx, ty, q + 7), h3 = M.hash3(tx, ty, q + 19);
          if (h3 < 0.25) continue;
          const px = (tx + h1) * TS + Math.sin(t * (0.3 + h2 * 0.4) + h3 * 20) * 40 + Math.sin(t * 1.3 + h1 * 9) * 6;
          const py = (ty + h2) * TS + Math.cos(t * (0.25 + h1 * 0.35) + h2 * 20) * 26 - 14;
          const ground = (py + 14) / TILT;
          const k = World._solidAt(F, px, ground) & S_LIQ ? 0 : Math.max(0, Math.sin(t * (0.9 + h3) + h1 * 30)) ** 2;
          if (k < 0.08) continue;
          R.glowGlyph(px, py, k > 0.6 ? G_STAR : G_DOT, 0.85 * k * 1.4, 1.05 * k * 1.4, 0.35 * k * 1.4, ground, 0.9);
        }
      }
    },
  });

  // impacts at the water's edge throw a splash ring (hits on anything wading / standing at the shore line)
  if (HM.Events && HM.Events.on) HM.Events.on('damage', (info) => {
    const F = World.floor, a = info && info.target; if (!F || !F.hasWater || !a || info.isDot) return;
    const rr = (a.radius || 8) + 10;
    for (let pI = 0; pI < 5; pI++) {
      const px = a.x + (pI === 1 ? -rr : pI === 2 ? rr : 0), py = a.y + (pI === 3 ? rr * 0.75 : pI === 4 ? -rr * 0.75 : 0);
      const tp = World._typeAt(F, px, py);
      if (tp === T.WATER || tp === T.DEEP) { World._spawnRipple(F, (px + a.x) * 0.5, (py + a.y) * 0.5, { strength: info.crit ? 1 : 0.8, speed: 110, life: 0.9, maxR: 60 }); return; }
    }
  });
})();
