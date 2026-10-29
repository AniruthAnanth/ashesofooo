// Headless UI flow test: drives menus with injected key presses / clicks and asserts state transitions.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = process.argv[2] || require('path').resolve(__dirname, '../..');
let src = fs.readFileSync(path.join(ROOT, 'tools/smoke.js'), 'utf8').replace(/^#!.*\n/, '');
const head = src.slice(0, src.indexOf('// ---------------------------------------------------------------- boot'));
const H = new Function('require', '__dirname', 'process', 'module', head.replace("'use strict';", '') + '\nreturn { sandbox, elements, storage, HM: sandbox.HM, setNow: (v) => { simNow = v; }, getNow: () => simNow, errors };')(require, path.join(ROOT, 'tools'), { argv: ['', ''], hrtime: process.hrtime, exit: process.exit }, {});
const HM = H.HM, I = HM.Input, G = () => HM.Game;
HM.params = HM.params || {}; HM.params.actcard = '1'; // headless harnesses skip act cards by default; this one tests them
HM.R.init(null, { headless: true, w: 1400, h: 820 }); HM.UI.init(H.elements.ui); HM.Game.init();
const DT = 1 / 60;
function step(n) { for (let k = 0; k < (n || 1); k++) { H.setNow(H.getNow() + DT); I.beginFrame(G().realT + DT); G().update(DT); G().draw(); } }
function key(code, n) { I._pressedEdge.add(code); step(1); I.down.delete(code); step(n === undefined ? 2 : n); }
function type(str) { for (const ch of str) I._typed.push(ch); step(1); }
function clickId(id) { const h = HM.UI._hits ? null : null; }
let fails = 0; const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } else console.log(' ok ', msg); };
// expose hits for clicking
step(30);
ok(HM.UI.modal && HM.UI.modal.kind === 'input', 'first launch opens the name prompt');
for (let i = 0; i < 9; i++) I._typed.push('Backspace'); step(1);
type('Senje'); I._typed.push('Enter'); step(3);
ok(HM.Save.data && HM.Save.data.profileName === 'Senje', 'profile created: ' + (HM.Save.data && HM.Save.data.profileName));
ok(G().state === 'title' && !HM.UI.modal, 'back on title');
key('Enter', 3);
ok(G().state === 'heroSelect', 'Enter on New Run -> heroSelect (' + G().state + ')');
key('ArrowRight', 2);
ok(HM.UI.focus === 'h:marceline', 'right -> marceline focus (' + HM.UI.focus + ')');
key('Enter', 3);
// new-run flow: a fresh profile is asked about the prologue first (default: yes)
ok(HM.UI.modal && HM.UI.modal.kind === 'confirm' && /prologue/i.test(HM.UI.modal.text), 'fresh profile asks "Play the prologue?"');
ok(HM.UI.focus === 'm:yes', 'prologue question defaults to yes (' + HM.UI.focus + ')');
key('Escape', 2); ok(G().state === 'heroSelect' && !HM.UI.modal, 'Esc on the prologue question cancels back to hero select');
key('Enter', 3); key('ArrowRight', 2); ok(HM.UI.focus === 'm:no', 'right -> skip to floor 1');
key('Enter', 3);
ok(G().state === 'play' && G().run && G().run.heroId === 'marceline', 'declining begins a Marceline run on floor 1 (' + G().state + ')');
ok(HM.Save.data.meta.prologueDeclined === true, 'declining is remembered (no nagging)');
// act card (DESIGN §9D): act I opens with a full-screen card; the world is frozen under it; any key skips
ok(HM.UI.card && HM.UI.actCardOpen && HM.UI.card.act === 1, 'act I card is up');
ok(G().timeScale === 0, 'world frozen under the act card');
step(30); key('Escape', 2); ok(G().state === 'play', 'Esc skips the card instead of pausing');
step(40); ok(!HM.UI.card && !HM.UI.actCardOpen && G().timeScale === 1, 'card closed, time restored (' + G().timeScale + ')');
key('Escape', 2); ok(G().state === 'pause', 'Esc -> pause');
key('ArrowDown', 2); ok(HM.UI.focus === 'p:moves', 'down -> moves (' + HM.UI.focus + ')');
key('ArrowDown', 2); ok(HM.UI.focus === 'p:options', 'down -> options (' + HM.UI.focus + ')');
key('Enter', 2); ok(HM.UI.pauseSub === 'options', 'Enter -> pause options');
const m0 = HM.Save.setting('master'); key('ArrowRight', 2); ok(Math.abs(HM.Save.setting('master') - m0 - 0.05) < 1e-6, 'right raises master volume ' + m0 + ' -> ' + HM.Save.setting('master'));
key('Escape', 2); ok(G().state === 'pause' && !HM.UI.pauseSub, 'Esc closes options sub-screen');
key('Escape', 2); ok(G().state === 'play', 'Esc resumes');
key('Tab', 2); ok(G().state === 'inventory', 'Tab -> inventory');
key('KeyI', 2); ok(G().state === 'play', 'I closes inventory');
// boon draft
G().run.boonPoints = 2; G().run.rerolls = 1; G().openBoonDraft(); step(2);
ok(G().state === 'boon', 'boon draft open');
const f0 = G().run.floorIndex;
key('KeyR', 2); ok(G().run.rerolls === 0 && G().state === 'boon', 'R rerolls');
key('Digit2', 2); ok(G().run.boons.length === 1 && G().state === 'boon', 'Digit2 picks a boon; second point keeps draft open');
key('Enter', 3); ok(G().run.boons.length === 2 && G().state === 'play' && G().run.floorIndex === f0 + 1, 'Enter picks focused card and descends');
// shop
G().run.gold = 999; HM.Interact.merchant({ x: 0, y: 0 }, G().player); step(2);
ok(G().state === 'shop', 'merchant opens shop');
const g0 = G().run.gold; key('Enter', 2); ok(G().run.gold < g0, 'Enter buys first stock entry (' + g0 + ' -> ' + G().run.gold + ')');
ok(HM.Save.data.meta.achievements.goose_buy, 'goose_buy achievement');
key('Escape', 2); ok(G().state === 'play', 'Esc leaves shop');
// ---- story layer: tutorial prompts, dialogue, remnants, act cards, skill flash, moves page
HM.UI.prompt('t:attack', { keys: ['attack'], text: 'Attack', sub: 'break the training husks' });
HM.UI.prompt('t:move', { keys: ['up', 'left', 'down', 'right'], text: 'Move', pos: 'center' });
step(30); ok(HM.UI.promptActive('t:attack') && HM.UI.promptActive('t:move') && HM.UI.prompts.length === 2, 'two tutorial prompts up');
HM.UI.prompt('t:attack', { keys: ['attack'], text: 'Attack again' }); step(2);
ok(HM.UI.prompts.length === 2 && HM.UI.prompts.find((q) => q.id === 't:attack').text === 'Attack again', 're-prompting the same id updates it in place');
HM.UI.clearPrompt('t:attack'); step(4); ok(!HM.UI.promptActive('t:attack') && HM.UI.prompts.length === 2, 'clearPrompt starts a fade-out');
step(30); ok(HM.UI.prompts.length === 1, 'faded prompt removed');
HM.UI.clearPrompt(); step(30); ok(HM.UI.prompts.length === 0, 'clearPrompt() clears all');
{
  const p = G().player, x0 = p.x, y0 = p.y; let done = 0;
  HM.UI.dialogue({ speaker: 'BMO', title: 'the last little console', lines: ['BMO has four percent battery.', 'Go down.'], onDone: () => done++ });
  step(2); ok(HM.UI.dialogueOpen === true && HM.UI.dlg.npc === 'bmo', 'dialogue open (BMO portrait)');
  I.down.add('KeyD'); I.down.add('Mouse0'); I._pressedEdge.add('KeyD'); step(40);
  ok(Math.abs(p.x - x0) < 0.5 && Math.abs(p.y - y0) < 0.5, 'player cannot walk while the dialogue is open (moved ' + (p.x - x0).toFixed(2) + ')');
  ok(!p.act || p.act.slot !== 'attack', 'held attack is suppressed while talking');
  ok(I.down.has('KeyD') && I.down.has('Mouse0'), 'held keys are restored after the frame (not lost)');
  I.down.delete('KeyD'); I.down.delete('Mouse0'); step(2);
  let n = 0; while (HM.UI.dialogueOpen && n++ < 10) key('KeyF', 2);
  ok(!HM.UI.dialogueOpen && done === 1, 'F advances lines, closes, calls onDone once (' + done + ', ' + n + ' presses)');
  key('Space', 2); step(20);
}
{
  const p = G().player; const npc = { kind: 'story', npc: 'billy', x: p.x, y: p.y, r: 30, used: false };
  HM.Interact.story(npc, p); step(2);
  ok(HM.UI.dialogueOpen && /Billy/.test(HM.UI.dlg.speaker) && npc.used, 'story interact opens the remnant conversation');
  ok(HM.Save.data.meta.codex.remnant_billy, 'remnant remembered in the codex');
  let n = 0; while (HM.UI.dialogueOpen && n++ < 20) key('Enter', 2);
  ok(!HM.UI.dialogueOpen && npc.talked, 'conversation finished (' + n + ' presses)');
}
{
  let cd = 0; HM.UI.actCard(3, () => cd++); step(2);
  ok(HM.UI.card && HM.UI.card.act === 3 && G().timeScale === 0, 'actCard(3) opens and freezes time');
  step(30); key('KeyW', 2); step(40);
  ok(!HM.UI.card && cd === 1 && G().timeScale === 1, 'any key skips the card and calls onDone (' + cd + ')');
  HM.UI.actCard(3, () => cd++); step(2); ok(!HM.UI.card && cd === 2, 'a card already shown this run just calls onDone');
  HM.UI.actCard(9, () => cd++); ok(cd === 3 && !HM.UI.card, 'unknown act: onDone, no card');
}
{
  for (let k = 0; k < 5; k++) { HM.UI.flashSkill('Test Skill'); step(60); }
  ok(HM.Save.data.meta.skillFlash['Test Skill'] === 3, 'skill name flashes only for the first 3 uses (' + HM.Save.data.meta.skillFlash['Test Skill'] + ')');
}
key('Escape', 2); ok(G().state === 'pause', 'pause for the Moves page');
HM.UI.focus = 'p:moves'; key('Enter', 2); ok(HM.UI.pauseSub === 'moves', 'Pause -> Moves');
step(2); key('ArrowDown', 2); ok(/^mv:/.test(HM.UI.focus || ''), 'moves cards are focusable (' + HM.UI.focus + ')');
key('Escape', 2); ok(G().state === 'pause' && !HM.UI.pauseSub && HM.UI.focus === 'p:moves', 'Esc returns from Moves to the pause menu');
key('Escape', 2); ok(G().state === 'play', 'Esc resumes after Moves');
// note
HM.Interact.note({}, G().player); step(2);
ok(G().state === 'note' && HM.UI.noteEntry, 'note reader open: ' + (HM.UI.noteEntry && HM.UI.noteEntry.title));
key('Enter', 2); key('Enter', 2); ok(G().state === 'play', 'Enter reveals then closes note');
ok(G().run.codexThisRun.filter((id) => !/^remnant_/.test(id)).length === 1 && Object.keys(HM.Save.data.meta.codex).filter((id) => !/^remnant_/.test(id)).length === 1, 'codex unlocked');
// debug cheat path
HM.debug = true; key('KeyL', 2); ok(G().run.level >= 2, 'debug L levels up (lv ' + G().run.level + ')'); HM.debug = false;
// death
G().lastHitBy = { name: 'The Waving Snail', defId: 'snail' }; G().onPlayerDeath(); step(2);
ok(G().state === 'dead', 'death screen'); ok(HM.Save.data.meta.achievements.snail_death, 'snail achievement');
step(120); key('Enter', 3); ok(G().state === 'title', 'Enter on death -> title');
// options from title: rebind with conflict swap
G().setState('options'); step(2);
HM.UI.focus = 'o:bind:skill1'; key('Enter', 2);
ok(HM.UI.capture && typeof I.capturing === 'function', 'Enter on binding starts capture');
I.capturing('KeyE'); step(2);
ok(I.binds.skill1[0] === 'KeyE' && I.binds.skill2[0] === 'KeyQ', 'rebind skill1->E swaps skill2->Q (' + I.binds.skill1 + ' / ' + I.binds.skill2 + ')');
ok(HM.Save.data.settings.binds.skill1[0] === 'KeyE', 'binds persisted in slot settings');
HM.UI.focus = 'o:reset'; key('Enter', 2); key('Enter', 2);
ok(I.binds.skill1[0] === 'KeyQ', 'reset controls restores defaults');
key('Escape', 2); ok(G().state === 'title', 'Esc options -> title');
// slots: rename
G().setState('slots'); step(2); HM.UI.focus = 's1:ren'; key('Enter', 2);
ok(HM.UI.modal && HM.UI.modal.kind === 'input', 'rename prompt');
for (let i = 0; i < 20; i++) I._typed.push('Backspace'); type('Simon'); I._typed.push('Enter'); step(2);
ok(HM.Save.data.profileName === 'Simon', 'renamed active profile');
HM.UI.focus = 's2:new'; key('Enter', 2); type('Betty'); I._typed.push('Enter'); step(2);
ok(HM.Save.slot === 2 && HM.Save.data.profileName === 'Betty' && G().state === 'title', 'new profile in slot 2');
G().setState('slots'); step(2); HM.UI.focus = 's2:del'; key('Enter', 2); ok(HM.UI.modal && HM.UI.modal.kind === 'confirm', 'delete asks for confirmation');
ok(HM.UI.focus === 'm:no', 'delete defaults to the safe button (' + HM.UI.focus + ')');
key('ArrowLeft', 2); key('Enter', 3); ok(!HM.Save.list()[1].exists, 'slot 2 erased');
// codex tabs
HM.Save.use(1); G().setState('codex'); step(2); key('KeyE', 2); ok(HM.UI.codexTab === 'bestiary', 'E -> bestiary tab'); key('KeyE', 2); key('KeyE', 2); ok(HM.UI.codexTab === 'chronicle', 'chronicle tab');
key('Escape', 2);
// continue / resume
ok(G().state === 'title', 'codex Esc -> title');
// replay prologue from the title (offered once the prologue was played or declined)
HM.UI.focus = 't:prologue'; step(2); ok(HM.UI.focus === 't:prologue', 'title offers Replay Prologue');
key('Enter', 3); ok(G().state === 'heroSelect' && HM.UI._forcePrologue, 'Replay Prologue -> hero select (prologue mode)');
key('Enter', 3); ok(G().state === 'play' && G().run && !HM.UI.modal, 'replaying starts a run with no questions asked');
const proFloor = !!(G().floor && G().floor.isPrologue);
console.log('     (prologue floor ' + (proFloor ? 'generated by World/Tutorial' : 'not available yet: Game.newRun ignored {prologue}') + ')');
if (!proFloor) G().floor.isPrologue = true; // stand-in so the pause menu offers the skip
if (HM.UI.card) { step(30); key('KeyW', 2); step(40); }
key('Escape', 2); HM.UI.focus = 'p:skipPro'; step(2); ok(HM.UI.focus === 'p:skipPro', 'pause offers Skip Prologue during the prologue');
key('Enter', 2); key('Enter', 3); step(5);
ok(G().state === 'play' && G().run && G().run.floorIndex === 1 && !G().floor.isPrologue, 'Skip Prologue lands on floor 1 (' + G().state + ', floor ' + (G().run && G().run.floorIndex) + ')');
G().quitToTitle(); step(3);
console.log(H.errors.size ? 'ERRORS: ' + [...H.errors.values()].map((e) => e.stack).join('\n') : 'no harness errors');
console.log(fails ? fails + ' FAILURES' : 'FLOW OK');
