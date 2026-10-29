// story_shots.js — staged screenshots of the story/teaching layer (DESIGN §9): tutorial keycap prompts, the dialogue
// box (BMO + a remnant), the act card, the Moves page, the hotbar tooltip, the real prologue and a melee scrum (name tags).
// usage: node tools/tests/story_shots.js <outDir> [--only a,b] [--par 3] [--w 1400] [--h 820]
'use strict';
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const outDir = args[0];
if (!outDir) { console.error('usage: node tools/tests/story_shots.js <outDir> [--only a,b]'); process.exit(1); }
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', '') ? opt('only').split(',') : null;
const par = parseInt(opt('par', '3'), 10);
const W = parseInt(opt('w', '1400'), 10), H = parseInt(opt('h', '820'), 10);
fs.mkdirSync(outDir, { recursive: true });
const enc = (s) => s.replace(/%/g, '%25').replace(/=/g, '%3D').replace(/\+/g, '%2B').replace(/&/g, '%26').replace(/ /g, '%20').replace(/#/g, '%23');
const dos = (list) => 'do=' + enc(list.join('|'));
const crowd = (ids) => `0.25:(function(){HM.UI.banners.length=0;var p=HM.Game.player;var ids=${JSON.stringify(ids)};ids.forEach(function(id,k){var a=-0.5+k*1.25;var d=k%2?30:40;var e=HM.Enemies.spawn(id,p.x+Math.cos(a)*d,p.y+Math.sin(a)*d*0.9);if(e){e.facing=Math.atan2(p.y-e.y,p.x-e.x);}});})()`;
const aimNearest = '0.3:(function(){var p=HM.Game.player;var es=HM.Game.entities.filter(function(e){return e.team===1&&!e.dead});es.sort(function(a,b){return Math.hypot(a.x-p.x,a.y-p.y)-Math.hypot(b.x-p.x,b.y-p.y)});var e=es[0];if(e){var s=HM.R.worldToScreen(e.x,e.y,30);HM.Input.mouse.sx=s[0];HM.Input.mouse.sy=s[1];HM.Input.mouse.inside=true;}})()';
const swings = ['0.5:HM.Input.lastPress.attack=HM.Input.now', '0.95:HM.Input.lastPress.attack=HM.Input.now', '1.4:HM.Input.lastPress.attack=HM.Input.now', '1.9:HM.Input.lastPress.attack=HM.Input.now'];

const SHOTS = {
  prologue_bmo: `hero=finn&nosave=1&seed=7&sim=4.2&${dos(["0.1:HM.Game.newRun('finn',{seed:7,prologue:true})"])}`,
  prologue_move: `hero=finn&nosave=1&seed=7&sim=4.6&${dos(["0.1:HM.Game.newRun('finn',{seed:7,prologue:true})", '2.6:HM.UI.closeDialogue(true)'])}`,
  actcard: 'hero=marceline&nosave=1&seed=5&actcard=1&sim=3.6',
  prompts: `hero=finn&nosave=1&seed=7&sim=1.6&${dos(["0.4:HM.UI.banners.length=0;HM.UI.prompt('m',{keys:['up','left','down','right'],text:'Move',sub:'follow the lanterns to the Tree Fort'});HM.UI.prompt('s',{keys:['skill1','skill2'],text:'Skills',sub:'Grass Vines roots a line of foes, Leap Slam lands on whoever is stuck',pos:'center'})"])}`,
  remnant: `hero=finn&floor=4&nosave=1&seed=7&sim=3.4&${dos(['0.2:HM.UI.banners.length=0', '1.0:HM.Interact.story({kind:"story",npc:"pepbut",x:HM.Game.player.x+20,y:HM.Game.player.y},HM.Game.player)'])}`,
  moves_fp: `hero=fp&nosave=1&seed=7&sim=1.4&${dos(["0.8:HM.Game.setState('pause');HM.UI.pauseSub='moves'", "1.2:HM.UI.focus='mv:skill2'"])}`,
  moves_marceline: `hero=marceline&nosave=1&seed=7&sim=1.4&${dos(["0.8:HM.Game.setState('pause');HM.UI.pauseSub='moves'"])}`,
  pause_prologue: `hero=finn&nosave=1&seed=7&sim=3.0&${dos(["0.1:HM.Game.newRun('finn',{seed:7,prologue:true})", "2.8:HM.Game.setState('pause')"])}`,
  // (the headless window is resized after the sim, so the pinned pointer recomputes the slot position on every read)
  tooltip: `hero=finn&nosave=1&seed=7&sim=1.2&${dos(['0.3:HM.UI.banners.length=0', '1.1:(function(){var m=HM.Input.mouse;function sw(){return Math.round(52*HM.UI.S)}Object.defineProperty(m,"sx",{get:function(){return Math.round(HM.UI.W/2-5*sw())+2.5*sw()},set:function(){}});Object.defineProperty(m,"sy",{get:function(){return HM.UI.H-12*HM.UI.S-Math.round(44*HM.UI.S)/2},set:function(){}});m.inside=true;})()'])}`,
  newrun_ask: `nosave=1&sim=1.3&${dos(["0.3:HM.Save.use(3,'Tester');HM.Game.setState('heroSelect')", "0.8:HM.Input._pressedEdge.add('Enter')"])}`,
  title_replay: `nosave=1&sim=1.0&${dos(["0.3:HM.Save.use(3,'Tester');HM.Save.data.meta.prologueDone=true;HM.Game.setState('title');HM.UI.focus='t:prologue'"])}`,
  crowd_grass: `hero=finn&floor=1&nosave=1&seed=7&sim=2.2&${dos([crowd(['thrall', 'thrall', 'archer', 'hound', 'thrall', 'thrall']), aimNearest].concat(swings))}`,
  crowd_candy: `hero=fp&floor=4&nosave=1&seed=7&sim=2.2&${dos([crowd(['husk', 'husk', 'banana', 'bloater', 'husk', 'husk']), aimNearest].concat(swings))}`,
  billy_near: `hero=marceline&nosave=1&seed=7&sim=1.6&${dos(['0.2:HM.UI.banners.length=0', '0.3:(function(){var o=HM.Game.floor.interactables.find(function(i){return i.kind==="story"});var p=HM.Game.player;if(o){p.x=o.x-40;p.y=o.y+20;HM.Game.cam.x=p.x;HM.Game.cam.y=p.y;}})()'])}`,
  billy_talk: `hero=marceline&nosave=1&seed=7&sim=4.4&${dos(['0.2:HM.UI.banners.length=0', '0.3:(function(){var o=HM.Game.floor.interactables.find(function(i){return i.kind==="story"});var p=HM.Game.player;if(o){p.x=o.x-40;p.y=o.y+20;HM.Game.cam.x=p.x;HM.Game.cam.y=p.y;}})()', '1.0:HM.Input.lastPress.interact=HM.Input.now', '2.2:HM.Input._pressedEdge.add("KeyF")', '2.6:HM.Input._pressedEdge.add("KeyF")'])}`,
  codex_remnant: `nosave=1&sim=1.0&${dos(["0.3:HM.Save.use(3,'Tester');HM.Save.unlockCodex('remnant_billy');HM.Save.unlockCodex('ench_prologue');HM.Game.setState('codex')", "0.6:HM.UI.focus='c:n:remnant_billy'"])}`,
  actcard_full: 'hero=fp&floor=10&nosave=1&seed=5&actcard=1&sim=6.4',
  flash: `hero=finn&nosave=1&seed=7&sim=1.25&${dos(['0.2:HM.UI.banners.length=0', '1.0:HM.Input.lastPress.skill2=HM.Input.now'])}`,
};

const jobs = Object.keys(SHOTS).filter((k) => !only || only.indexOf(k) >= 0).map((k) => ({ k, q: SHOTS[k], out: path.join(outDir, k + '.png') }));
const shot = path.resolve(__dirname, '..', 'shot.sh');
let i = 0, live = 0;
function next() {
  if (i >= jobs.length) { if (!live) console.log('done'); return; }
  const j = jobs[i++]; live++;
  execFile('bash', [shot, j.q, j.out, String(W), String(H), '4000'], (err, so) => { live--; console.log((so || '').trim().split('\n').pop() || (err && err.message)); next(); });
}
for (let k = 0; k < par; k++) next();
