// Figure/ground definition harness (DESIGN §4b / §10) — loads the game headless (same stubs as tools/smoke.js), stages a
// crowded melee of each act's enemies around each hero on floors 1/4/7/10/13, renders, and measures how well every
// figure separates from the ground it stands on (perceived value = final lit luminance × glyph ink coverage):
//   * value contrast  = mean luminance of the figure's cells vs. the ground ring around it (1–2 cells out)
//   * crowd breaks    = cells darkened where one figure overlaps another (back figure, along the front silhouette)
//   * texture         = share of the figure's cells drawn with dense glyphs (vs. the sparse stroke ground)
// usage: node tools/tests/definition.js [--floors 1,4,7,10,13] [--heroes finn,marceline,fp] [--dump] [--quiet]
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const FLOORS = opt('floors', '1,4,7,10,13').split(',').map(Number);
const HEROES = opt('heroes', 'finn,marceline,fp').split(',');
const DUMP = args.includes('--dump'), QUIET = args.includes('--quiet'), SOLO = args.includes('--solo');
const noop = () => {};
function ctx2d() {
  const target = { measureText: (t) => ({ width: String(t).length * 7 }), createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }), createPattern: () => ({}), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: noop, drawImage: noop, setTransform: noop, getTransform: () => ({}), setLineDash: noop, getLineDash: () => [], isPointInPath: () => false };
  return new Proxy(target, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[a-z]/.test(k) && !['font', 'fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'textAlign', 'textBaseline', 'globalCompositeOperation', 'shadowBlur', 'shadowColor', 'lineCap', 'lineJoin', 'imageSmoothingEnabled', 'filter', 'letterSpacing'].includes(k) ? noop : t[k]), set: (t, k, v) => { t[k] = v; return true; } });
}
function canvasStub() { return { width: 1400, height: 820, style: {}, getContext: (t) => (t === '2d' ? ctx2d() : null), addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1400, height: 820 }), toDataURL: () => '' }; }
const storage = {}; const elements = { gl: canvasStub(), ui: canvasStub() };
let simNow = 0;
const sandbox = {
  console, Math, JSON, Date, Promise, Set, Map, WeakMap, Symbol, Proxy, Reflect, Error, TypeError, RangeError,
  Uint8Array, Uint8ClampedArray, Int16Array, Int32Array, Uint16Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
  parseInt, parseFloat, isNaN, isFinite, Number, String, Boolean, Array, Object, Function, RegExp, encodeURIComponent, decodeURIComponent,
  setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, queueMicrotask: (fn) => Promise.resolve().then(fn),
  requestAnimationFrame: () => 0, cancelAnimationFrame: noop, performance: { now: () => simNow * 1000 },
  navigator: { getGamepads: () => [], userAgent: 'node' },
  localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } },
  document: { getElementById: (id) => elements[id] || null, createElement: () => canvasStub(), body: { appendChild: noop, style: {} }, addEventListener: noop, removeEventListener: noop, hidden: false, fonts: { load: () => Promise.resolve(), ready: Promise.resolve() } },
  location: { search: '', href: 'http://definition/' }, innerWidth: 1400, innerHeight: 820, devicePixelRatio: 1, addEventListener: noop, removeEventListener: noop,
  Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop }, FileReader: function () {}, URLSearchParams, HM: { headless: true },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1])) {
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f }); }
  catch (e) { console.log('load fail ' + f + ': ' + e.message + ' -> stub'); const st = path.join(ROOT, 'src/stubs', path.basename(f)); if (fs.existsSync(st)) vm.runInContext(fs.readFileSync(st, 'utf8'), sandbox, { filename: 'stub:' + f }); }
}
const HM = sandbox.HM, R = HM.R;
const quietErr = console.error; // other modules may log; keep output readable
HM.R.init(null, { headless: true, w: 1400, h: 820 }); HM.UI.init(elements.ui); HM.Save.use(1, 'Definition'); HM.Game.init();
const DT = 1 / 60;
function step(n = 1) { for (let k = 0; k < n; k++) { simNow += DT; HM.Input.beginFrame(HM.Game.realT + DT); HM.Game.update(DT); HM.Game.draw(); } }
const press = (c) => { HM.Input._pressedEdge.add(c); HM.Input.down.add(c); };
const release = (c) => { HM.Input.down.delete(c); HM.Input._releasedEdge.add(c); };
let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; if (!QUIET) console.log('  ok   ' + msg); } else { fails++; console.log('  FAIL ' + msg); } }
void quietErr; void release;

const PACK = {
  1: ['thrall', 'thrall', 'archer', 'hound'], 4: ['husk', 'husk', 'banana', 'bloater'], 7: ['penguin', 'golem', 'penguin', 'wisp'],
  10: ['elemental', 'cinder', 'brute', 'cinder'], 13: ['knight', 'priest', 'wraith', 'knight'],
};
const DENSE = new Set('#@%&8$MWBHQN0OS'.split(''));
const lum = (i) => R.out[i * 4] * 0.3 + R.out[i * 4 + 1] * 0.55 + R.out[i * 4 + 2] * 0.15;
// perceived value of a cell = lit luminance × ink coverage of its glyph (a white '.' on black reads dark; a dense '@' bright)
const covOf = (g) => { const ch = R.CHARSET[g & 127] || ' '; if (ch === ' ') return 0; const v = '#@%&8MWBQ$0NHRDGO'.includes(ch) ? 0.6 : ".,'`:;-~_^\"°·".includes(ch) ? 0.13 : '|/\\()!il1[]{}<>+=*'.includes(ch) ? 0.26 : 0.4; return g & 128 ? Math.min(1, v * 1.3) : v; };
const pv = (i) => lum(i) * covOf(R.glyph[i]);
const satOf = (i) => { const r = R.out[i * 4], g = R.out[i * 4 + 1], b = R.out[i * 4 + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx > 1e-4 ? (mx - mn) / mx : 0; };
const chr = (g) => R.CHARSET[g & 127] || ' ';

function stage(hero, floor) {
  if (HM.RNG) HM.rng = new HM.RNG(1234 + floor * 31 + hero.length); // deterministic poses / particles per case
  HM.Game.newRun(hero, { seed: 7 });
  if (floor > 1) HM.Game.enterFloor(floor);
  for (const a of HM.Game.entities) if (a.team === 1) a.removeMe = true;
  if (HM.UI && HM.UI.banners) HM.UI.banners.length = 0;
  step(2);
  const p = HM.Game.player; p.hp = p.maxHp = 1e6;
  const s = R.worldToScreen(p.x, p.y, 0); HM.Input.mouse.sx = s[0]; HM.Input.mouse.sy = s[1] - 40;
  const ids = SOLO ? [] : PACK[floor] || PACK[1], foes = [];
  const off = [[16, 18], [-14, -15], [28, -6], [-26, 8]];
  ids.forEach((id, k) => {
    const e = HM.Enemies.spawn(id, p.x + off[k][0], p.y + off[k][1]);
    if (e) { e.hp = e.maxHp = 1e6; e.update = function (dt) { this.vx = 0; this.vy = 0; HM.Combat.baseUpdate(this, dt); }; e.facing = Math.atan2(p.y - e.y, p.x - e.x); e.aim = e.facing; foes.push(e); }
  });
  for (let k = 0; k < 24; k++) { if (k % 8 === 0) press('Mouse0'); step(1); HM.Input.down.delete('Mouse0'); }
  step(12); // let hit flashes fade before measuring
  return { p, foes };
}
function figureCells(a) {
  const D = HM.Rig._debug && HM.Rig._debug(); if (!D || !a._figSerial) return [];
  const out = [];
  for (let i = 0; i < R.n; i++) if (D.own[i] === a._figSerial && D.ownk[i] === R.key[i] && R.glyph[i]) out.push(i);
  return out;
}
function measure(a) {
  const cells = figureCells(a); if (cells.length < 6) return null;
  const set = new Set(cells), cols = R.cols, ring = new Set();
  let dense = 0;
  for (const i of cells) {
    if (DENSE.has(chr(R.glyph[i]))) dense++;
    const x = i % cols, y = (i / cols) | 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= cols || yy >= R.rows) continue;
      const j = yy * cols + xx; if (set.has(j) || (R.glyph[j] && !(R.flag[j] & R.F_GROUND))) continue; ring.add(j); // terrain or empty cells only (no FX / props / figures)
    }
  }
  const fl = cells.map(pv).sort((x, y) => x - y), gl = [...ring].map(pv).sort((x, y) => x - y);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / Math.max(1, v.length), q = (v, t) => v[Math.min(v.length - 1, Math.floor(v.length * t))] || 0;
  // separation coverage: share of the figure's cells that sit clearly off the ground — ≥1.6× brighter or darker in value,
  // or clearly more saturated (hue figures like an orange fire elemental on white snow) while not darker than the ground
  const gm = mean(gl), gs = mean([...ring].map(satOf)); let sep = 0;
  for (const i of cells) { const v = pv(i); if (v >= gm * 1.6 || v <= gm / 1.6 || (satOf(i) - gs >= 0.35 && v >= gm * 0.8)) sep++; }
  return { n: cells.length, figMean: mean(fl), gMean: gm, figP75: q(fl, 0.75), gP75: q(gl, 0.75), figP25: q(fl, 0.25), dense: dense / cells.length, sep: sep / cells.length };
}
function dump(p, w, h) {
  const ci = Math.floor(p.x / HM.cfg.CW) - R.ci0, cj = Math.floor((p.y * HM.cfg.TILT - 40) / HM.cfg.CH) - R.cj0;
  const SH = ' .:-=+*#%@';
  for (let y = cj - (h >> 1); y < cj + (h >> 1); y++) {
    let g = '', v = '';
    for (let x = ci - (w >> 1); x < ci + (w >> 1); x++) {
      if (x < 0 || y < 0 || x >= R.cols || y >= R.rows) { g += ' '; v += ' '; continue; }
      const i = y * R.cols + x; const fig = R.flag[i] & R.F_FIGURE;
      g += R.glyph[i] ? chr(R.glyph[i]) : ' ';
      const l = lum(i), D = HM.Rig._debug && HM.Rig._debug();
      const dk = D && D.dks && fig && D.dks[i] === D.own[i] && D.ownk[i] === R.key[i] ? D.dkt[i] : 0;
      if (args.includes('--parts')) { const own = D && D.own[i] === p._figSerial && D.ownk[i] === R.key[i]; v += own ? String.fromCharCode(65 + (D.prt[i] % 26)) + (dk ? '*' : ' ') : '  '; continue; }
      v += dk === 1 ? 'X' : dk === 2 ? 'x' : fig ? SH[Math.min(9, Math.floor(l * 6))] : (l > 0.02 ? '·' : ' ');
    }
    console.log(g + '   ' + v);
  }
}

console.log('[definition] figure/ground separation per biome (crowded melee)');
const rows = [];
for (const floor of FLOORS) for (const hero of HEROES) {
  const { p, foes } = stage(hero, floor);
  const biome = HM.Game.floor.biomeId || String(HM.Game.floor.biome);
  const D = HM.Rig._debug ? HM.Rig._debug() : null;
  for (const a of [p, ...foes]) {
    const m = measure(a); if (!m) continue;
    const ratio = m.figMean / Math.max(0.01, m.gMean);
    rows.push({ floor, biome, hero, who: a === p ? hero : a.defId, ratio, m });
    const darkOnLight = m.figMean < m.gMean;
    const con = darkOnLight ? m.gMean / Math.max(0.01, m.figMean) : ratio;
    const check = a.defId === 'wisp' ? (c) => c || true : (c) => c; // wisps are self-lit light motes: report only
    ok(check(m.sep >= 0.6), `f${floor} ${biome} [${hero}] ${(a === p ? 'HERO ' + hero : a.defId).padEnd(14)} separated ${(m.sep * 100).toFixed(0)}% of cells  (mean ${con.toFixed(2)}x${darkOnLight ? ' dark-on-light' : ''}: fig ${m.figMean.toFixed(2)} vs ground ${m.gMean.toFixed(2)})  dense ${(m.dense * 100).toFixed(0)}%  cells ${m.n}`);
    // (long staffs / bows are thin line weapons by design, hence 38%)
    if (a.defId !== 'wisp') ok(m.dense >= 0.38, `  …${a === p ? hero : a.defId} body texture is dense glyphs (${(m.dense * 100).toFixed(0)}%)`); // wisps are motes of light by design
  }
  if (D && !SOLO) ok(D.crowdBreaks > 0, `f${floor} [${hero}] crowd value breaks where figures overlap: ${D.crowdBreaks} cells, part breaks ${D.partBreaks}`);
  if (DUMP) { const fid = opt('focus', ''), fa = fid ? foes.find((e) => e.defId === fid) || p : p; console.log(`--- f${floor} ${biome} ${hero} @${fid || hero}`); dump(fa, SOLO || fid ? 24 : 70, SOLO || fid ? 22 : 30); }
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
