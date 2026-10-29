// lore.js — STUB. Lore/UI agent replaces with all game text.
(function () {
  const HM = (globalThis.window || globalThis).HM;
  HM.Lore = {
    floorIntro(act, inAct, name) { return { title: name || 'Ooo', sub: 'Floor ' + inAct }; },
    epitaph(run, killedBy) { return 'Here lies a hero, unmade by ' + killedBy + '.'; },
    bossIntro(id) { return { name: id, title: '' }; },
    notes: [], barks: {},
  };
})();
