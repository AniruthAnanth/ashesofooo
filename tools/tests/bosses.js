#!/usr/bin/env node
// Boss fight harness: loads the game headless (same sandbox as tools/smoke.js), then for each boss floor runs a
// scripted bot against the boss for N seconds. Reports phase timings, patterns used, damage taken, errors, ms/frame.
// usage: node bosstest.js [--seconds 60] [--floors 3,6,9,12,15] [--bot fight|idle|dodge] [--dmg 6] [--hero finn]
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.env.ROOT || require('path').resolve(__dirname, '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const SECONDS = parseFloat(opt('seconds', '60'));
const FLOORS = opt('floors', '3,6,9,12,15').split(',').map(Number);
const BOT = opt('bot', 'fight');
const DMG = parseFloat(opt('dmg', '6'));   // player damage multiplier so phases happen inside the window
const HERO = opt('hero', 'finn');
const QUIET = args.includes('--quiet');
const opt2 = opt;

// ---- sandbox (copied from tools/smoke.js) ----
// ---------------------------------------------------------------- stubs
const noop = () => {};
function ctx2d() {
  const target = {
    measureText: (t) => ({ width: String(t).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({}), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop, drawImage: noop, setTransform: noop, getTransform: () => ({}), setLineDash: noop, getLineDash: () => [],
    isPointInPath: () => false, canvas: null,
  };
  return new Proxy(target, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[a-z]/.test(k) && !['font', 'fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'textAlign', 'textBaseline', 'globalCompositeOperation', 'shadowBlur', 'shadowColor', 'lineCap', 'lineJoin', 'imageSmoothingEnabled', 'filter', 'letterSpacing'].includes(k) ? noop : t[k]), set: (t, k, v) => { t[k] = v; return true; } });
}
function canvasStub() { const c = { width: 1400, height: 820, style: {}, getContext: (t) => (t === '2d' ? ctx2d() : null), addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1400, height: 820 }), toDataURL: () => '' }; return c; }
const storage = {};
const elements = { gl: canvasStub(), ui: canvasStub() };
const documentStub = {
  getElementById: (id) => elements[id] || null,
  createElement: (t) => (t === 'canvas' ? canvasStub() : { style: {}, click: noop, remove: noop, appendChild: noop, addEventListener: noop, setAttribute: noop }),
  body: { appendChild: noop, style: {} }, addEventListener: noop, removeEventListener: noop, hidden: false,
  fonts: { load: () => Promise.resolve(), ready: Promise.resolve() },
};
const sandbox = {
  console, Math, JSON, Date, Promise, Set, Map, WeakMap, Symbol, Proxy, Reflect, Error, TypeError, RangeError,
  Uint8Array, Uint8ClampedArray, Int16Array, Int32Array, Uint16Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
  parseInt, parseFloat, isNaN, isFinite, Number, String, Boolean, Array, Object, Function, RegExp, encodeURIComponent, decodeURIComponent, escape, unescape,
  setTimeout: (fn) => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, queueMicrotask: (fn) => Promise.resolve().then(fn),
  requestAnimationFrame: () => 0, cancelAnimationFrame: noop,
  performance: { now: () => simNow * 1000 },
  navigator: { getGamepads: () => [], userAgent: 'node-smoke' },
  localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; }, clear: () => { for (const k in storage) delete storage[k]; } },
  document: documentStub, location: { search: '', href: 'http://smoke/' },
  innerWidth: 1400, innerHeight: 820, devicePixelRatio: 1,
  addEventListener: noop, removeEventListener: noop,
  Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop }, FileReader: function () {},
  AudioContext: undefined, webkitAudioContext: undefined,
  URLSearchParams,
  HM: { headless: true },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
let simNow = 0;
vm.createContext(sandbox);

// ---------------------------------------------------------------- load scripts in index.html order
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const files = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const errors = new Map();
function report(where, e) {
  const key = (e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : String(e));
  if (!errors.has(key)) { errors.set(key, { where, count: 0, stack: e && e.stack ? e.stack.split('\n').slice(0, 7).join('\n') : String(e) }); }
  errors.get(key).count++;
}
for (const f of files) {
  const p = path.join(ROOT, f);
  try { vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: f }); }
  catch (e) {
    report('load ' + f, e);
    const stub = path.join(ROOT, 'src/stubs', path.basename(f));
    if (fs.existsSync(stub)) { console.log(`!! ${f} failed to load — falling back to stub`); vm.runInContext(fs.readFileSync(stub, 'utf8'), sandbox, { filename: 'stub:' + f }); }
  }
}
const HM = sandbox.HM;
const log = (...a) => { if (!QUIET) console.log(...a); };



function guard(where, fn) { try { return fn(); } catch (e) { report(where, e); return undefined; } }
const consoleErrors = new Map();
sandbox.console = Object.assign({}, console, { error: (...a) => { const k = a.map(String).join(' ').slice(0, 160); consoleErrors.set(k, (consoleErrors.get(k) || 0) + 1); } });
guard('R.init', () => HM.R.init(null, { headless: true, w: 1400, h: 820 }));
guard('UI.init', () => HM.UI.init(elements.ui));
guard('Save.use', () => HM.Save.use(1, 'BossTest'));
guard('Game.init', () => HM.Game.init());

const DT = 1 / 60;
let frameMs = 0, frames = 0, bossMs = 0;
function step() {
  simNow += DT;
  const t0 = process.hrtime.bigint();
  guard('Input.beginFrame', () => HM.Input.beginFrame(HM.Game.realT + DT));
  guard('Game.update[' + HM.Game.state + ']', () => HM.Game.update(DT));
  guard('Game.draw[' + HM.Game.state + ']', () => HM.Game.draw());
  frameMs += Number(process.hrtime.bigint() - t0) / 1e6; frames++;
}
function press(code) { HM.Input._pressedEdge.add(code); HM.Input.down.add(code); }
function release(code) { HM.Input.down.delete(code); HM.Input._releasedEdge.add(code); }
function releaseAll() { for (const c of [...HM.Input.down]) release(c); }

let taken = 0, hits = 0;
HM.Events.on('damage', (info) => { if (info.target && info.target.kind === 'player' && info.dealt > 0) { taken += info.dealt; hits++; } });

function bot(t, boss) {
  const G = HM.Game, p = G.player; if (!p || p.dead) return;
  releaseAll();
  if (BOT === 'idle') return;
  const tgt = boss && !boss.dead ? boss : null;
  if (!tgt) return;
  const d = Math.hypot(tgt.x - p.x, tgt.y - p.y);
  const [sx, sy] = HM.R.worldToScreen(tgt.x, tgt.y, 0);
  HM.Input.mouse.sx = sx; HM.Input.mouse.sy = sy;
  // circle-strafe at ~ (boss radius + 40)
  const want = tgt.radius + 38;
  const a = Math.atan2(p.y - tgt.y, p.x - tgt.x) + 0.9;
  const gx = tgt.x + Math.cos(a) * want, gy = tgt.y + Math.sin(a) * want;
  const dx = gx - p.x, dy = gy - p.y;
  if (dx > 6) press('KeyD'); if (dx < -6) press('KeyA'); if (dy > 6) press('KeyS'); if (dy < -6) press('KeyW');
  const f = Math.floor(t * 60);
  if (d < 140 && f % 6 === 0) press('Mouse0');
  if (f % 53 === 0) press('Mouse2');
  if (f % 97 === 0) press('KeyQ');
  if (f % 131 === 0) press('KeyE');
  if (BOT === 'dodge' && f % 41 === 0) press('Space');
  if (p.hp < p.maxHp * 0.3) p.hp = p.maxHp;  // keep the bot alive; damage is still counted
}

const results = [];
guard('newRun', () => HM.Game.newRun(HERO, { seed: 777 }));
for (const fl of FLOORS) {
  guard('enterFloor ' + fl, () => HM.Game.enterFloor(fl));
  const G = HM.Game;
  const p = G.player;
  if (p) { p.stats.dmgMul = DMG; p.maxHp = Math.max(p.maxHp, 300); p.hp = p.maxHp; }
  let boss = HM.Bosses && HM.Bosses.active ? HM.Bosses.active() : null;
  if (!boss) { // enemies module still a stub: replace its placeholder with the real boss
    const sp = (G.floor.spawns || []).find((s) => s.kind === 'boss') || { x: G.floor.w / 2, y: G.floor.h * 0.35, id: G.floor.bossId };
    G.entities = G.entities.filter((a) => !(a.isBoss && !(a instanceof HM.Bosses.Boss)));
    boss = HM.Bosses.spawn(sp.id || G.floor.bossId, sp.x, sp.y, G.floor);
    console.log('  (spawned ' + boss.defId + ' via harness)');
  }
  if (!boss) { results.push(`f${fl}: NO BOSS FOUND (entities ${G.entities.length})`); continue; }
  taken = 0; hits = 0; const ms0 = frameMs, fr0 = frames;
  const n = Math.round(SECONDS * 60); let t = 0, deadAt = null;
  const zonesMax = { v: 0 }, entsMax = { v: 0 };
  for (let k = 0; k < n; k++) {
    t += DT;
    guard('bot', () => bot(t, boss));
    step();
    zonesMax.v = Math.max(zonesMax.v, G.zones.length); entsMax.v = Math.max(entsMax.v, G.entities.length);
    if (boss.dead && deadAt === null) deadAt = t;
    if (G.state !== 'play') { if (G.state === 'dead') { guard('revive', () => { G.setState('play'); }); } else break; }
    if (deadAt !== null && t > deadAt + 4) break;
  }
  const L = boss.log || {};
  results.push(`f${fl} ${boss.defId}: hp ${Math.round(boss.hp)}/${boss.maxHp} phase ${boss.phase} state ${boss.state} dead@${deadAt === null ? '-' : deadAt.toFixed(1)}s exit ${G.floor && G.floor.exitOpen}`
    + `\n    intro@${(L.intro || -1).toFixed ? (L.intro).toFixed(1) : L.intro} phases ${JSON.stringify((L.phases || []).map((x) => x.phase + '@' + x.t.toFixed(1)))}`
    + `\n    patterns ${JSON.stringify(L.patterns)}`
    + `\n    player took ${Math.round(taken)} in ${hits} hits (${(taken / Math.max(1, t) * 60).toFixed(0)}/min), maxHp ${p && p.maxHp}, dmgUnit ${boss.dmgUnit.toFixed(1)}; max zones ${zonesMax.v}, max ents ${entsMax.v}`
    + `\n    ${((frameMs - ms0) / Math.max(1, frames - fr0)).toFixed(2)} ms/frame`);
}

console.log(results.join('\n'));
console.log(`\nframes ${frames}, avg ${(frameMs / Math.max(1, frames)).toFixed(2)} ms/frame`);
if (consoleErrors.size) { console.log('\nconsole.error:'); for (const [k, v] of consoleErrors) console.log(`  x${v} ${k}`); }
if (errors.size) {
  console.log(`\n${errors.size} unique error(s):`);
  for (const [, e] of errors) console.log(`\n[${e.where}] x${e.count}\n${e.stack}`);
  process.exit(1);
} else console.log('\nBOSSTEST OK');
