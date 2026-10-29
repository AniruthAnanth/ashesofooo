// items.js — STUB. Items agent replaces with loot, materials, runes, boons, heirlooms.
(function () {
  const HM = (globalThis.window || globalThis).HM;
  HM.Items = {
    newInventory(heroId) { return { equipped: { weapon: { id: 'w1', name: 'Rusty Sword', slot: 'weapon', material: 'iron', rarity: 'common', dmg: [6, 9] } }, bag: [] }; },
    applyStats() {}, rollDrops() {}, updatePickups() {}, drawPickups() {}, populate() {},
  };
  HM.Boons = {
    pool: [{ id: 'b1', name: 'Grit', desc: '+10% damage' }, { id: 'b2', name: 'Pluck', desc: '+10% speed' }, { id: 'b3', name: 'Moxie', desc: '+20 max HP' }],
    draft(run, n) { return HM.Boons.pool.slice(0, n); },
    take(run, id) { run.boons.push(id); },
    apply() {},
  };
})();
