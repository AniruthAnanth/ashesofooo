// crowd_shots.js — staged "crowded melee" screenshots for figure/ground definition checks (DESIGN §4b, §10).
// Spawns a pack of the act's enemies tight around the hero, has the hero swing at them, and screenshots via tools/shot.sh.
// usage: node tools/tests/crowd_shots.js <outDir> [prefix] [--heroes finn,marceline,fp] [--floors 1,4,7,10,13] [--sim 2.2] [--par 3]
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const outDir = args[0];
if (!outDir) { console.error('usage: node tools/tests/crowd_shots.js <outDir> [prefix] [--heroes ..] [--floors ..]'); process.exit(1); }
const prefix = args[1] && !args[1].startsWith('--') ? args[1] : 'shot';
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const heroes = opt('heroes', 'finn,marceline,fp').split(',');
const floors = opt('floors', '1,4,7,10,13').split(',').map(Number);
const simT = parseFloat(opt('sim', '2.2'));
const par = parseInt(opt('par', '3'), 10);
const W = parseInt(opt('w', '1400'), 10), H = parseInt(opt('h', '820'), 10);
fs.mkdirSync(outDir, { recursive: true });

const PACK = {
  1: ['thrall', 'thrall', 'archer', 'hound', 'thrall'],
  4: ['husk', 'husk', 'banana', 'bloater', 'husk'],
  7: ['penguin', 'golem', 'penguin', 'wisp', 'penguin'],
  10: ['elemental', 'cinder', 'brute', 'cinder', 'elemental'],
  13: ['knight', 'priest', 'wraith', 'knight', 'wraith'],
};

function stageJS(floor) {
  const ids = JSON.stringify(PACK[floor] || PACK[1]);
  // spawn the pack in a tight ring (some in front of, some behind the hero), aim at the first one
  return [
    `0.25:(function(){if(HM.UI&&HM.UI.banners)HM.UI.banners.length=0;var p=HM.Game.player;var ids=${ids};ids.forEach(function(id,k){var a=-0.5+k*1.25;var d=k%2?30:40;var e=HM.Enemies.spawn(id,p.x+Math.cos(a)*d,p.y+Math.sin(a)*d*0.9);if(e){e.facing=Math.atan2(p.y-e.y,p.x-e.x);}});})()`,
    `0.3:(function(){var p=HM.Game.player;var es=HM.Game.entities.filter(function(e){return e.team===1&&!e.dead});es.sort(function(a,b){return Math.hypot(a.x-p.x,a.y-p.y)-Math.hypot(b.x-p.x,b.y-p.y)});var e=es[0];if(e){var s=HM.R.worldToScreen(e.x,e.y,30);HM.Input.mouse.sx=s[0];HM.Input.mouse.sy=s[1];}})()`,
    '0.5:HM.Input.lastPress.attack=HM.Input.now',
    '0.95:HM.Input.lastPress.attack=HM.Input.now',
    '1.4:HM.Input.lastPress.attack=HM.Input.now',
    `${(simT - 0.32).toFixed(2)}:HM.Input.lastPress.attack=HM.Input.now`,
  ].join('|');
}
const enc = (s) => s.replace(/%/g, '%25').replace(/=/g, '%3D').replace(/\+/g, '%2B').replace(/&/g, '%26').replace(/ /g, '%20').replace(/#/g, '%23');

const jobs = [];
for (const f of floors) for (const h of heroes) jobs.push({ h, f, out: path.join(outDir, `${prefix}_f${f}_${h}.png`) });
const shot = path.resolve(__dirname, '..', 'shot.sh');
let i = 0, live = 0;
function next() {
  if (i >= jobs.length) { if (!live) console.log('done'); return; }
  const j = jobs[i++]; live++;
  const q = `hero=${j.h}&floor=${j.f}&nosave=1&seed=7&sim=${simT}&do=${enc(stageJS(j.f))}`;
  execFile('bash', [shot, q, j.out, String(W), String(H), '4000'], (err, so) => { live--; console.log((so || '').trim() || (err && err.message)); next(); });
}
for (let k = 0; k < par; k++) next();
