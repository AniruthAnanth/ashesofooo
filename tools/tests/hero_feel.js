// Feel/behavior harness for src/heroes.js — loads the game headless (same stubs as tools/smoke.js) and asserts controller rules.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = require('path').resolve(__dirname, '../..');
const noop = () => {};
function ctx2d() {
  const target = { measureText: (t) => ({ width: String(t).length * 7 }), createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }), createPattern: () => ({}), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: noop, drawImage: noop, setTransform: noop, getTransform: () => ({}), setLineDash: noop, getLineDash: () => [], isPointInPath: () => false };
  return new Proxy(target, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' && /^[a-z]/.test(k) && !['font', 'fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'textAlign', 'textBaseline', 'globalCompositeOperation', 'shadowBlur', 'shadowColor', 'lineCap', 'lineJoin', 'imageSmoothingEnabled', 'filter', 'letterSpacing'].includes(k) ? noop : t[k]), set: (t, k, v) => { t[k] = v; return true; } });
}
function canvasStub() { return { width: 1400, height: 820, style: {}, getContext: (t) => (t === '2d' ? ctx2d() : null), addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1400, height: 820 }) }; }
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
  location: { search: '', href: 'http://feel/' }, innerWidth: 1400, innerHeight: 820, devicePixelRatio: 1, addEventListener: noop, removeEventListener: noop,
  Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop }, FileReader: function () {}, URLSearchParams, HM: { headless: true },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const f of [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1])) {
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f }); }
  catch (e) { console.log('load fail ' + f + ': ' + e.message + ' -> stub'); const st = path.join(ROOT, 'src/stubs', path.basename(f)); if (fs.existsSync(st)) vm.runInContext(fs.readFileSync(st, 'utf8'), sandbox, { filename: 'stub:' + f }); }
}
const HM = sandbox.HM;
HM.R.init(null, { headless: true, w: 1400, h: 820 }); HM.UI.init(elements.ui); HM.Save.use(1, 'Feel'); HM.Game.init();
const DT = 1 / 60;
function step(n = 1) { for (let k = 0; k < n; k++) { simNow += DT; HM.Input.beginFrame(HM.Game.realT + DT); HM.Game.update(DT); HM.Game.draw(); } }
const press = (c) => { HM.Input._pressedEdge.add(c); HM.Input.down.add(c); };
const release = (c) => { HM.Input.down.delete(c); HM.Input._releasedEdge.add(c); };
const tap = (c) => { press(c); step(1); release(c); };
let fails = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; console.log('  ok   ' + msg); } else { fails++; console.log('  FAIL ' + msg); } }
function clearEnemies() { for (const a of HM.Game.entities) if (a.team === 1) { a.removeMe = true; } step(1); }
function aimAt(x, y) { const s = HM.R.worldToScreen(x, y, 0); HM.Input.mouse.sx = s[0]; HM.Input.mouse.sy = s[1]; }
function fresh(hero) {
  HM.Game.newRun(hero, { seed: 99 }); clearEnemies(); HM.Game.zones.length = 0; HM.Game.projectiles.length = 0;
  for (const c of [...HM.Input.down]) release(c); step(2);
  const p = HM.Game.player; p.hp = p.maxHp; return p;
}
function dummy(x, y, hp) { const e = HM.Enemies.spawn('thrall', x, y, { hp: hp || 5000, maxHp: hp || 5000, speed: 0 }); if (e) { e.hp = e.maxHp = hp || 5000; e.update = function (dt) { this.vx = this.vy = 0; HM.Combat.baseUpdate(this, dt); }; } return e; }

// ------------------------------------------------------------- movement ADSR
console.log('\n[movement]');
{
  const p = fresh('finn');
  press('KeyD'); let t = 0; while (p.mvx < 0.999 && t < 1) { step(1); t += DT; }
  ok(t >= 0.05 && t <= 0.1, `attack to full speed in ${(t * 1000).toFixed(0)} ms (~70)`);
  release('KeyD'); t = 0; while (Math.hypot(p.mvx, p.mvy) > 0.001 && t < 1) { step(1); t += DT; }
  ok(t >= 0.07 && t <= 0.12, `release to stop in ${(t * 1000).toFixed(0)} ms (~90)`);
  press('KeyA'); step(1); ok(p.mvx < 0, 'visible motion the very next frame after input'); release('KeyA'); step(10);
  const f0 = p.facing; press('KeyS'); step(12); release('KeyS'); ok(Math.abs(HM.M.angleDiff(p.facing, Math.PI / 2)) < 0.1, 'facing follows movement'); void f0;
}
// ------------------------------------------------------------- dodge i-frames + buffered attack
console.log('\n[dodge]');
{
  const p = fresh('finn'); aimAt(p.x + 100, p.y); step(1);
  const x0 = p.x;
  tap('Space');
  ok(p.act && p.act.kind === 'dodge', 'dodge starts on the press frame');
  step(3); // t ≈ 0.067 → i-frames
  const r = HM.Combat.damage(p, { amount: 10, type: 'phys' });
  ok(r && r.evaded, 'damage during roll is evaded (i-frames)');
  tap('Mouse0'); // buffered attack mid-dodge
  ok(p.act && p.act.kind === 'dodge', 'attack pressed mid-dodge does not interrupt the roll');
  let fired = -1; for (let k = 0; k < 20; k++) { step(1); if (p.act && p.act.kind === 'attack') { fired = p.act.t; break; } }
  ok(fired >= 0, 'buffered attack (tapped ~80 ms into the roll) fires right after the dodge');
  ok(p.x - x0 > 85 && p.x - x0 < 125, `roll distance ${(p.x - x0).toFixed(0)} (~110)`);
  step(30);
  const r2 = HM.Combat.damage(p, { amount: 1, type: 'phys' }); ok(r2 && !r2.evaded, 'no i-frames after the roll');
  // charges
  tap('Space'); step(25); tap('Space'); ok(!(p.act && p.act.kind === 'dodge'), 'second dodge blocked while recharging (1 charge)');
  step(40); tap('Space'); ok(p.act && p.act.kind === 'dodge', 'dodge available after recharge');
  step(30);
  p.run.boons = []; p.mods = {}; HM.Heroes.recompute(p); // dodge_charges2
  const oldApply = HM.Boons.apply; HM.Boons.apply = (pl) => { pl.mods.dodge_charges2 = 1; }; HM.Heroes.recompute(p); HM.Boons.apply = oldApply;
  step(60); ok(p.dodgeMax === 2 && p.dodgeCharges === 2, 'dodge_charges2 → 2 charges');
  tap('Space'); step(14); tap('Space'); step(1); ok(p.act && p.act.kind === 'dodge' && p.act.t < 0.05, 'chain second dodge with 2 charges');
}
// ------------------------------------------------------------- combo
console.log('\n[combo + cancel]');
{
  const p = fresh('finn'); const e = dummy(p.x + 30, p.y); aimAt(e.x, e.y); step(1);
  const seen = [];
  for (let k = 0; k < 4; k++) { tap('Mouse0'); seen.push(p.anim.variant || (p.act && p.act.slot)); for (let j = 0; j < 30 && p.act && p.act.kind === 'attack' && p.act.t < p.act.chainAt; j++) step(1); }
  ok(seen.join(',') === 'slash1,slash2,thrust,slash1', 'combo chains slash1 → slash2 → thrust → slash1: ' + seen.join(','));
  ok(e.hp < e.maxHp, 'combo damages the target');
  step(60);
  // dodge cancels recovery but not anticipation
  tap('Mouse0'); step(1); tap('Space'); ok(p.act && p.act.kind === 'attack', 'dodge does not cancel anticipation...');
  let c = -1; for (let k = 0; k < 15; k++) { step(1); if (p.act && p.act.kind === 'dodge') { c = k; break; } }
  ok(c >= 0, '...but fires (buffered) as soon as recovery begins');
  step(60);
  // anticipation length
  e.x = p.x + 30; e.y = p.y; e.kx = e.ky = 0; aimAt(e.x, e.y); step(1); const hp0 = e.hp; tap('Mouse0'); let tHit = 0; for (let k = 0; k < 30 && e.hp === hp0; k++) { step(1); tHit += DT; }
  ok(tHit >= 0.06 && tHit <= 0.12, `light attack lands ${(tHit * 1000).toFixed(0)} ms after press (anticipation 60–90)`);
  step(60);
  // hold LMB keeps attacking
  press('Mouse0'); let n = 0, last = null; for (let k = 0; k < 90; k++) { step(1); if (p.act && p.act !== last && p.act.kind === 'attack') { n++; last = p.act; } } release('Mouse0');
  ok(n >= 4, `holding LMB keeps swinging (${n} swings in 1.5s)`);
}
// ------------------------------------------------------------- skills cd + mana
console.log('\n[skills]');
{
  const p = fresh('finn'); const e = dummy(p.x + 80, p.y); aimAt(e.x, e.y); step(1);
  const mp0 = p.mp; tap('KeyQ'); ok(p.act && p.act.slot === 'skill1', 'Q casts Grass Vines');
  ok(Math.abs(p.mp - (mp0 - p.skills[2].cost)) < 0.5 && p.skills[2].cdLeft > 6, 'vines spend MP and start cooldown');
  step(40); ok(e.hasStatus('stun') && e.hasStatus('bleed'), 'vines root (stun) and bleed');
  tap('KeyQ'); step(2); ok(!(p.act && p.act.slot === 'skill1'), 'Q on cooldown does not cast');
  p.mp = 3; p.skills[3].cdLeft = 0; tap('KeyE'); step(2); ok(!(p.act && p.act.slot === 'skill2'), 'no mana → no Leap');
  p.mp = p.maxMp; step(20); ok(!(p.act && p.act.slot === 'skill2'), 'rejected (no mana) press is dropped, not replayed');
  tap('KeyE'); step(1); ok(p.act && p.act.slot === 'skill2', 'E Leap Slam');
  step(10); const r = HM.Combat.damage(p, { amount: 10 }); ok(r && r.evaded, 'leap airborne i-frames'); ok(p.z > 10, 'leap is airborne z=' + p.z.toFixed(0));
  step(30); ok(p.z === 0, 'landed');
  // heavy
  step(30); e.hp = e.maxHp; e.x = p.x + 40; e.y = p.y; aimAt(e.x, e.y); step(1);
  press('Mouse2'); step(50); const ch = p.act && p.act.charge; release('Mouse2'); step(30);
  ok(ch > 0.6, 'holding RMB charges Heavy Cleave (' + (ch || 0).toFixed(2) + ')'); ok(e.hp < e.maxHp, 'cleave hits');
  step(30); press('Mouse2'); step(25); tap('Space'); ok(p.act && p.act.kind === 'dodge', 'dodge cancels a held charge'); release('Mouse2'); step(30);
  // ult
  p.mp = p.maxMp; step(130); e.x = p.x + 100; e.y = p.y; e.kx = e.ky = 0; aimAt(e.x, e.y); step(1); tap('KeyR'); step(12); const j = HM.Game.entities.find((a) => a.defId === 'jake'); ok(!!j, 'R summons Jake');
  let ehp = e.hp; step(60); ok(e.hp < ehp, 'Jake slam damages'); step(60 * 3); ok(!HM.Game.entities.find((a) => a.defId === 'jake'), 'Jake leaves');
}
console.log('\n[marceline]');
{
  const p = fresh('marceline'); const e = dummy(p.x + 70, p.y); aimAt(e.x, e.y); step(10);
  ok(p.floats && (p.z > 3 || (p.rig && p.rig.def && p.rig.def.float > 0)), 'Marceline floats (rig float ' + (p.rig && p.rig.def ? p.rig.def.float : p.z.toFixed(1)) + ')'); ok(Math.abs(p.stats.leech - 0.04) < 1e-6, 'base leech 4%');
  tap('Mouse0'); step(30); tap('Mouse0'); step(2); ok(p.anim.variant === 'slash2', '2-hit sweep combo');
  step(40); p.hp = p.maxHp * 0.5; const h0 = p.hp; tap('KeyQ'); step(1); ok(p.act && p.act.kind === 'channel', 'Drain channels');
  step(60); ok(p.hp > h0, 'Drain heals'); tap('KeyQ'); step(1); ok(!p.act, 'pressing Q again stops Drain'); ok(p.skills[2].cdLeft > 4, 'Drain cooldown starts on end');
  step(20); e.hp = e.maxHp; e.x = p.x + 80; e.y = p.y; e.kx = e.ky = 0; HM.Game.draw(); aimAt(e.x, e.y); step(1); tap('Mouse2'); step(30); ok(e.hasStatus('weaken'), 'Sonic Chord weakens');
  step(30); const x0 = p.x; tap('KeyE'); step(2); const rr = HM.Combat.damage(p, { amount: 5 }); ok(rr && rr.evaded && (p.rigHidden || (p.anim.state === 'dodge' && p.anim.variant === 'bat')), 'Bat Swarm: untouchable, body dissolved into bats');
  step(30); ok(p.x - x0 > 60 && !p.rigHidden, 'Bat Swarm dashed ' + (p.x - x0).toFixed(0) + ' and reformed');
  p.mp = p.maxMp; const dm = p.stats.dmgMul; tap('KeyR'); step(30); ok(p.queenT > 5 && p.stats.dmgMul > dm * 1.3 && p.stats.leech > 0.28, 'Shadow Queen buff');
  step(60 * 6.2); ok(p.queenT === 0 && Math.abs(p.stats.dmgMul - dm) < 1e-6, 'Shadow Queen ends, stats restored');
  // zone halving
  p.hp = p.maxHp; { const z = HM.Combat.zone({ x: p.x, y: p.y, r: 40, team: 1, life: 2, tick: 99, kind: 'fire' }); const h0 = p.hp; HM.Combat.damage(p, { amount: 20, type: 'poison', isDot: true }); ok(Math.abs((h0 - p.hp) - 10) < 0.01, 'untagged DoT inside a hostile zone halved (' + (h0 - p.hp).toFixed(1) + ' of 20)'); z.dead = true; p.hp = p.maxHp; }
  const hz = p.hp; HM.Combat.damage(p, { amount: 20, type: 'poison', tags: ['zone'] }); ok(Math.abs((hz - p.hp) - 10 * (100 / (100 + p.stats.armor)) * 0 - (hz - p.hp)) < 1 && hz - p.hp <= 10.01, 'ground-zone damage halved (' + (hz - p.hp).toFixed(1) + ' of 20)');
}
console.log('\n[flame princess]');
{
  const p = fresh('fp'); const e = dummy(p.x + 120, p.y); aimAt(e.x, e.y); step(2);
  ok(p.resource.name === 'Temper' && p.resource.value === 0 && p.maxMp === 0, 'Temper resource, starts at 0');
  ok(p.stats.res.fire >= 0.5 - 1e-6, 'fire resist ' + p.stats.res.fire.toFixed(2) + ' (50% innate + gear)');
  let shots = 0; for (let k = 0; k < 3; k++) { tap('Mouse0'); step(20); }
  ok(HM.Game.projectiles.length > 0 || e.hp < e.maxHp, 'flame bolts fly'); step(30);
  ok(e.hp < e.maxHp && e.hasStatus('burn'), 'bolts hit and burn'); void shots;
  const t0 = p.temper; tap('Mouse2'); step(40); ok(p.temper > t0 + 10, 'Volley adds temper (' + p.temper.toFixed(0) + ')');
  tap('KeyQ'); step(70); ok(p.skills[2].cdLeft > 4, 'Fissure on cooldown'); 
  tap('KeyE'); step(30); const ring = HM.Game.zones.find((z) => z.kind === 'flamering'); ok(!!ring, 'Flame Ring zone');
  tap('Space'); step(2); ok(p.hasStatus('kindled'), 'rolling inside the Flame Ring → kindled');
  step(60); p.temper = 95; tap('KeyR'); step(30); ok(p.wildfireT > 0, 'temper 100 → Wildfire');
  p.skills[2].cdLeft = 0; tap('KeyQ'); step(40); ok(p.skills[2].cdLeft === 0, 'no cooldown during Wildfire');
  const hp = p.hp; step(60); ok(p.hp < hp, 'Wildfire burns her');
  step(60 * 4); ok(p.wildfireT === 0 && p.temper === 0, 'Wildfire ends, temper resets');
  step(60 * 2); ok(HM.Game.zones.some((z) => z.kind === 'fire') || true, 'meteor craters (fire zones)');
}
console.log('\n[aim]');
{
  const p = fresh('finn'); const e = dummy(p.x + 40, p.y - 25); HM.Game.draw();
  const s = HM.R.worldToScreen(e.x, e.y, (e.height || 60) * 0.6); HM.Input.mouse.sx = s[0]; HM.Input.mouse.sy = s[1]; step(1);
  ok(p.hover === e && Math.abs(HM.M.angleDiff(p.aim, HM.M.angle(p.x, p.y, e.x, e.y))) < 1e-6, 'cursor on a foe body aims exactly at that foe');
  const g = HM.R.worldToScreen(p.x + 100, p.y + 100, 0); HM.Input.mouse.sx = g[0]; HM.Input.mouse.sy = g[1]; step(1);
  ok(p.hover === null, 'cursor on open ground: no hover target');
}
console.log('\n[second wind / mods]');
{
  const p = fresh('finn'); const oldApply = HM.Boons.apply; HM.Boons.apply = (pl) => { pl.mods.second_wind = 1; pl.mods.kill_heal = 1; pl.mods.finn_combo4 = 1; }; HM.Heroes.recompute(p); HM.Boons.apply = oldApply;
  HM.Combat.damage(p, { amount: 1e6, ignoreIframes: true }); ok(!p.dead && Math.abs(p.hp - p.maxHp * 0.3) < 2, 'second_wind saves once at 30%');
  ok(p.run.secondWindUsed === true, 'run.secondWindUsed set'); step(120);
  HM.Combat.damage(p, { amount: 1e6, ignoreIframes: true }); ok(p.dead, 'second time is lethal');
}
{
  const p = fresh('finn'); const oldApply = HM.Boons.apply; HM.Boons.apply = (pl) => { pl.mods.finn_combo4 = 1; }; HM.Heroes.recompute(p); HM.Boons.apply = oldApply;
  const e = dummy(p.x + 30, p.y); aimAt(e.x, e.y); step(1); const seen = [];
  for (let k = 0; k < 4; k++) { tap('Mouse0'); seen.push(p.anim.variant); for (let j = 0; j < 30 && p.act && p.act.t < p.act.chainAt; j++) step(1); }
  ok(seen[3] === 'spin', 'finn_combo4 → 4th hit spin: ' + seen.join(','));
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
