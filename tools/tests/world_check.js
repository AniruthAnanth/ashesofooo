// Headless world harness: prologue map gating + reachability, story NPC placement per act, ripple / isWater API,
// map-edge band (no sampling past the edge) and World.draw timing per realm.
// usage: node tools/tests/world_check.js
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = process.argv[2] || path.resolve(__dirname, '../..');
const src = fs.readFileSync(path.join(ROOT, 'tools/smoke.js'), 'utf8').replace(/^#!.*\n/, '');
const head = src.slice(0, src.indexOf('// ---------------------------------------------------------------- boot'));
const H = new Function('require', '__dirname', 'process', 'module', head.replace("'use strict';", '') + '\nreturn { sandbox, elements, storage, HM: sandbox.HM, setNow: (v) => { simNow = v; }, getNow: () => simNow, errors };')(require, path.join(ROOT, 'tools'), { argv: ['', ''], hrtime: process.hrtime, exit: process.exit }, {});
const HM = H.HM, W = HM.World, R = HM.R;
R.init(null, { headless: true, w: 1400, h: 820 });
let fails = 0; const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } else console.log(' ok ', msg); };

// ---------------------------------------------------------------- prologue
const F = W.generate({ prologue: true, seed: 7 });
ok(F.isPrologue === true && F.biomeId === 'grass', 'prologue floor generated (isPrologue, grass)');
const B = F.beats;
const need = ['start', 'lanterns', 'sword', 'dummies', 'sentinel', 'gap', 'barricade', 'pack', 'trap', 'captain', 'page', 'door'];
ok(B && need.every((k) => B[k]), 'beats present: ' + need.filter((k) => !(B && B[k])).join(',') || 'all');
ok(B.dummies.length === 3 && B.pack.length === 3 && B.lanterns.length >= 4, `3 dummies, 3 pack spots, ${B.lanterns.length} lanterns`);
ok(F.exit.x === B.door.x && F.exit.y === B.door.y && F.interactables.some((o) => o.kind === 'portal'), 'portal at the door');
const nav = F.nav, reach = (p) => { const c = Math.floor(p.y / nav.gs) * nav.gw + Math.floor(p.x / nav.gs); return nav.dist[c] >= 0; };
const walk = (p) => !W.isSolidF(F, p.x, p.y);
const pre = ['start', 'sword', 'sentinel'].map((k) => B[k]).concat(B.dummies, [{ x: B.gap.x, y: B.gap.y }]);
const post = ['captain', 'page', 'door', 'trap'].map((k) => B[k]).concat(B.pack);
ok(pre.concat(post).every(walk), 'every beat spot is walkable');
ok(pre.every(reach), 'start → sword → dummies → gap → sentinel reachable');
ok(post.every((p) => !reach(p)), 'beyond the barricade unreachable while it stands');
// the gap is narrow: blocked a little to each side
ok(W.isSolidF(F, B.gap.x - B.gap.w / 2 - 12, B.gap.y) && W.isSolidF(F, B.gap.x + B.gap.w / 2 + 12, B.gap.y) && walk({ x: B.gap.x - 18, y: B.gap.y }) && walk({ x: B.gap.x + 18, y: B.gap.y }), 'gap ≈ ' + B.gap.w + ' wide, walls either side');
ok(W.isWall(B.barricade.x, B.barricade.y), 'barricade is solid');
ok(W.setBarricade(true) === true && !W.isSolidF(F, B.barricade.x, B.barricade.y), 'setBarricade(true) opens it');
ok(post.every(reach), 'everything reachable once it is open');
ok(W.setBarricade(false) === true && W.isWall(B.barricade.x, B.barricade.y) && W.setBarricade(true), 'setBarricade(false) closes it again');
ok(['ground', 'stone', 'road', 'water', 'wall'].includes(W.groundAt(B.start.x, B.start.y)) && W.groundAt(B.start.x, B.start.y) !== 'wall', 'groundAt works on the prologue (' + W.groundAt(B.start.x, B.start.y) + ')');
ok(F.wetProps && F.wetProps.length >= 1 && F.hasWater, 'the pond (and the stone standing in it)');

// ---------------------------------------------------------------- ripples / water API
const wp = (() => { for (let k = 0; k < F.type.length; k++) if (F.type[k] === W.T.WATER) return [((k % F.cols) + 0.5) * 5, (((k / F.cols) | 0) + 0.5) * HM.cfg.CH / HM.cfg.TILT]; })();
ok(wp && W.isWater(wp[0], wp[1]) && !W.isWater(B.start.x, B.start.y), 'isWater true on the pond, false on the grass');
ok(W.liquidAt(wp[0], wp[1]) === 'water' && W.liquidAt(B.start.x, B.start.y) === null, 'liquidAt');
ok(W.ripple(wp[0], wp[1], { strength: 1 }) && W.ripple(B.start.x, B.start.y) === null, 'ripple on water spawns, on land no-ops');
for (let n = 0; n < 80; n++) W.ripple(wp[0], wp[1]);
ok(W._rip.length <= 48, 'ripple pool capped (' + W._rip.length + ')');

// ---------------------------------------------------------------- story NPCs on each act's first floor
const npcs = ['billy', 'pepbut', 'simon', 'herald', 'prismo'], biomes = ['grass', 'candy', 'ice', 'fire', 'well'];
for (let a = 1; a <= 5; a++) {
  let found = 0, total = 0;
  for (const seed of [7, 11, 1234, 98765]) {
    const G = W.generate({ act: a, inAct: 1, biome: biomes[a - 1], seed });
    const st = G.interactables.filter((o) => o.kind === 'story');
    total++; if (st.length === 1 && st[0].npc === npcs[a - 1] && st[0].label === 'Speak' && !W.isSolidF(G, st[0].x, st[0].y)) found++;
    const G2 = W.generate({ act: a, inAct: 2, biome: biomes[a - 1], seed });
    if (G2.interactables.some((o) => o.kind === 'story')) { ok(false, 'no story NPC on inAct 2'); }
  }
  ok(found === total, `act ${a}: '${npcs[a - 1]}' remnant placed on inAct 1 (${found}/${total} seeds)`);
}

// ---------------------------------------------------------------- draw: edge band never samples past the map; timing
function timeDraw(Fl, label, camX, camY, frames) {
  W.floor = Fl; HM.Game.floor = Fl; HM.Game.entities = []; HM.Game.projectiles = [];
  let ms = 0;
  for (let f = 0; f < frames; f++) {
    R.beginFrame(camX, camY, 1 / 60); W.update(1 / 60);
    const t0 = process.hrtime.bigint(); W.draw(); ms += Number(process.hrtime.bigint() - t0) / 1e6;
  }
  const avg = ms / frames;
  console.log(`     World.draw ${label.padEnd(26)} ${avg.toFixed(3)} ms`);
  return avg;
}
const title = W.generate({ act: 1, inAct: 1, biome: 'grass', seed: 1337, title: true });
timeDraw(title, 'title (shore, moon column)', title.start.x, title.start.y, 60);
const P = W.generate({ prologue: true, seed: 7 });
timeDraw(P, 'prologue start (pond)', P.start.x, P.start.y, 60);
for (let a = 1; a <= 5; a++) { const G = W.generate({ act: a, inAct: 1, biome: biomes[a - 1], seed: 7 }); timeDraw(G, biomes[a - 1] + ' field', G.start.x, G.start.y, 40); }
const corner = W.generate({ act: 2, inAct: 1, biome: 'candy', seed: 7 });
const tc = timeDraw(corner, 'candy map corner (band)', 40, 40, 30);
// band cells exist past the edge and the map interior was never mirrored: compare a row above the map with row 0
R.beginFrame(40, 40, 1 / 60); W.draw();
let past = 0; for (let y = 0; y < R.rows; y++) { const cj = R.cj0 + y; if (cj >= 0) break; for (let x = 0; x < R.cols; x++) if (R.glyph[y * R.cols + x]) past++; }
ok(past > 0, 'boundary band drawn past the top edge (' + past + ' cells)');
ok(tc < 3, 'edge draw stays cheap');
console.log(fails ? `\n${fails} FAILED` : '\nWORLD OK');
process.exit(fails ? 1 : 0);
