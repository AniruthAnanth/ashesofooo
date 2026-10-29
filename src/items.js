// items.js — loot, materials, runes, rarities, item generation, equipment stats, ground pickups,
// chests / shrines / Choose Goose's shop, item powers & rune procs, boons (HM.Boons) and heirlooms (HM.Meta).
//
// Everything stored on `run` (inventory, consumables, boons, shop stock, floor blessing) is plain JSON —
// no functions, no actor references — so checkpoints survive export/import untouched.
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M, R = HM.R;
  const { CW, CH, TILT } = HM.cfg;

  // ---------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------
  const hex = (h) => M.hexToRgb(h);
  const G = () => HM.Game;
  const play = (name, o) => { try { HM.Audio && HM.Audio.play && HM.Audio.play(name, o); } catch (e) { /* audio is optional */ } };
  const toast = (text, color, dur) => { try { HM.UI && HM.UI.toast && HM.UI.toast(text, color || '#d8d8d8', dur || 2.4); } catch (e) { /* ui optional */ } };
  const fx = (fn, ...a) => { const F = HM.FX; if (F && F[fn]) { try { return F[fn](...a); } catch (e) { console.error('[items fx ' + fn + ']', e); } } return null; };
  let uidN = 0;
  const newUid = () => 'it' + Date.now().toString(36).slice(-5) + (uidN++).toString(36) + Math.floor(Math.random() * 1296).toString(36);
  const pct = (v) => { const x = v * 100; const r = Math.abs(x) < 10 && Math.abs(x - Math.round(x)) > 0.05 ? x.toFixed(1) : String(Math.round(x)); return (v >= 0 ? '+' : '') + r + '%'; };
  const flat = (v, d) => (v >= 0 ? '+' : '') + (d ? v.toFixed(d) : Math.round(v));
  const r2 = (v) => Math.round(v * 100) / 100;

  // ---------------------------------------------------------------------------
  // RARITIES
  // ---------------------------------------------------------------------------
  const RARITIES = {
    common:    { id: 'common',    name: 'Common',    hex: '#c9c9c9', rank: 0, dmg: 1.00, modMul: 1.00, mods: [0, 0], value: 1.0 },
    magic:     { id: 'magic',     name: 'Magic',     hex: '#6f8fff', rank: 1, dmg: 1.10, modMul: 1.00, mods: [1, 2], value: 1.8 },
    rare:      { id: 'rare',      name: 'Rare',      hex: '#ffdc4a', rank: 2, dmg: 1.22, modMul: 1.10, mods: [2, 3], value: 3.2 },
    legendary: { id: 'legendary', name: 'Legendary', hex: '#ff8a1a', rank: 3, dmg: 1.38, modMul: 1.20, mods: [2, 2], value: 6.0 },
    cursed:    { id: 'cursed',    name: 'Cursed',    hex: '#e3203c', rank: 3, dmg: 1.50, modMul: 1.30, mods: [2, 2], value: 4.5 },
  };
  for (const k in RARITIES) RARITIES[k].color = hex(RARITIES[k].hex);
  const RARITY_ORDER = ['common', 'magic', 'rare', 'legendary', 'cursed'];

  // ---------------------------------------------------------------------------
  // MATERIALS — glyph sets & colors from the crafting reel (+ Ooo materials).
  // tier: 0 common .. 2 deep-floor; act: realm affinity (drops more often there)
  // ---------------------------------------------------------------------------
  const MATERIALS = {
    iron:       { name: 'Iron',        glyphs: '#%:',  hex: '#9aa1aa', tier: 0, act: 1, mods: [{ stat: 'armor', value: 4 }], blurb: 'Honest metal. It dents instead of breaking.' },
    steel:      { name: 'Steel',       glyphs: '@%.',  hex: '#dfe6ee', tier: 1, mods: [{ stat: 'critChance', value: 0.02 }], blurb: 'Folded in the old world, sharpened in the new.' },
    bronze:     { name: 'Bronze',      glyphs: '&o,',  hex: '#d08a4a', tier: 0, mods: [{ stat: 'atkSpeed', value: 0.04 }], blurb: 'Light and warm, like a coin left in the sun.' },
    silver:     { name: 'Silver',      glyphs: '$s.',  hex: '#c9cfda', tier: 1, mods: [{ stat: 'holyDmg', value: 0.10 }], blurb: 'The dead flinch from it. So do liars.' },
    gold:       { name: 'Gold',        glyphs: '0o.',  hex: '#ffc94a', tier: 2, mods: [{ stat: 'goldFind', value: 0.20 }], blurb: 'Soft, heavy, and greedy. It calls to more of itself.' },
    moonsteel:  { name: 'Moonsteel',   glyphs: 'O*.',  hex: '#a9c8ff', tier: 2, mods: [{ stat: 'cdr', value: 0.04 }], emissive: 0.15, blurb: 'Quenched in moonlight. It hums at night.' },
    nightglass: { name: 'Nightglass',  glyphs: "N/'",  hex: '#8a6cff', tier: 2, act: 5, mods: [{ stat: 'shadowDmg', value: 0.12 }], emissive: 0.2, blurb: 'Volcanic glass from a sky with no stars.' },
    bloodiron:  { name: 'Bloodiron',   glyphs: 'B8:',  hex: '#e0233c', tier: 2, mods: [{ stat: 'leech', value: 0.02 }], emissive: 0.35, blurb: 'Iron quenched in blood. It stays warm.' },
    ossite:     { name: 'Ossite',      glyphs: '=-.',  hex: '#e6dcc0', tier: 0, act: 5, mods: [{ stat: 'thorns', value: 3 }], blurb: 'Bone pressed until it forgot it was bone.' },
    emberstone: { name: 'Emberstone',  glyphs: '*+.',  hex: '#ff8a2a', tier: 2, act: 4, mods: [{ stat: 'fireDmg', value: 0.12 }], emissive: 0.6, blurb: 'A stone that never finished burning.' },
    grass:      { name: 'Grass',       glyphs: '"|;',  hex: '#5fd06a', tier: 0, act: 1, mods: [{ stat: 'regen', value: 0.5 }, { stat: 'poisonDmg', value: 0.08 }], emissive: 0.12, blurb: 'Woven blades, cursed to keep growing.' },
    demonblood: { name: 'Demon-blood', glyphs: '%&;',  hex: '#ff2a3a', tier: 2, mods: [{ stat: 'dmgPct', value: 0.06 }, { stat: 'leech', value: 0.01 }], emissive: 0.5, blurb: 'It drips upward when no one is looking.' },
    crystal:    { name: 'Crystal',     glyphs: '<>^',  hex: '#6ff0ff', tier: 1, act: 3, mods: [{ stat: 'critChance', value: 0.03 }], emissive: 0.3, blurb: 'Grown in the dark under the Crystal Dimension.' },
    candy:      { name: 'Candy',       glyphs: '@o*',  hex: '#ff7ac8', tier: 0, act: 2, mods: [{ stat: 'moveMul', value: 0.04 }, { stat: 'regen', value: 0.3 }], blurb: 'Hard candy, rot-proofed. Mostly.' },
    glacial:    { name: 'Glacial',     glyphs: "*+'",  hex: '#bfe8ff', tier: 1, act: 3, mods: [{ stat: 'iceDmg', value: 0.12 }], emissive: 0.2, blurb: 'Ice from the King\'s own walls. It never melts.' },
  };
  for (const k in MATERIALS) { const m = MATERIALS[k]; m.id = k; m.color = hex(m.hex); m.emissive = m.emissive || 0; }
  const ARMOR_METALS = ['iron', 'steel', 'bronze', 'silver', 'gold', 'moonsteel', 'nightglass', 'bloodiron', 'ossite', 'glacial'];

  // ---------------------------------------------------------------------------
  // RUNES — the reel's rune bar. 12% per rune ("3 runes → adds 36% as fire").
  // ---------------------------------------------------------------------------
  const RUNES = {
    holy:      { glyph: '+', name: 'Holy Rune',      hex: '#fff6d8', element: 'holy',   add: 0.12, desc: 'Adds 12% of hit damage as Holy (x1.5 vs. the undead).' },
    fire:      { glyph: '^', name: 'Fire Rune',      hex: '#ff7a2a', element: 'fire',   add: 0.12, proc: 'burn',   chance: 0.10, desc: 'Adds 12% of hit damage as Fire. 10% chance to Burn.' },
    frost:     { glyph: '*', name: 'Frost Rune',     hex: '#7fd4ff', element: 'ice',    add: 0.12, proc: 'chill',  chance: 0.10, desc: 'Adds 12% of hit damage as Ice. 10% chance to Chill.' },
    lightning: { glyph: 'z', name: 'Lightning Rune', hex: '#ffd84a', element: 'holy',   add: 0.12, proc: 'chain',  chance: 0.12, desc: 'Adds 12% of hit damage as Lightning. 12% chance to arc to a nearby foe.' },
    blood:     { glyph: '~', name: 'Blood Rune',     hex: '#ff3b4a', element: null,     proc: 'bleed', chance: 0.14, desc: '14% chance to make the target Bleed.' },
    haste:     { glyph: '>', name: 'Haste Rune',     hex: '#6fe36f', stats: [{ stat: 'atkSpeed', value: 0.05 }, { stat: 'moveMul', value: 0.03 }], desc: '+5% attack speed, +3% move speed.' },
    crit:      { glyph: '/', name: 'Edge Rune',      hex: '#5fe0e0', stats: [{ stat: 'critChance', value: 0.03 }, { stat: 'critMult', value: 0.10 }], desc: '+3% crit chance, +10% crit damage.' },
    poison:    { glyph: 'x', name: 'Venom Rune',     hex: '#b56cff', element: 'poison', add: 0.10, proc: 'poison', chance: 0.15, desc: 'Adds 10% of hit damage as Poison. 15% chance to Poison.' },
    leech:     { glyph: 'v', name: 'Leech Rune',     hex: '#7fe07f', stats: [{ stat: 'leech', value: 0.015 }], desc: '1.5% of damage leeched as life.' },
    arcane:    { glyph: '°', name: 'Arcane Rune',    hex: '#e8e8f4', stats: [{ stat: 'cdr', value: 0.05 }, { stat: 'mpRegen', value: 1 }], desc: '+5% cooldown recovery, +1 resource/s.' },
  };
  for (const k in RUNES) { RUNES[k].id = k; RUNES[k].color = hex(RUNES[k].hex); }
  const RUNE_IDS = Object.keys(RUNES);

  // ---------------------------------------------------------------------------
  // MODS (affixes). fmt: pct | flat | flat1. range at ilvl 1; pct mods grow 6%/ilvl, flats by perLvl.
  // w: weight per slot; hero affinities multiply weights.
  // ---------------------------------------------------------------------------
  const MODS = {
    dmgPct:     { label: 'Damage',            fmt: 'pct',   range: [0.05, 0.11],  w: { weapon: 10, trinket: 6 },          pre: 'Cruel',      suf: 'of Ruin' },
    physDmg:    { label: 'Physical Damage',   fmt: 'pct',   range: [0.08, 0.16],  w: { weapon: 6, trinket: 2 },           pre: 'Sharp',      suf: 'of Edges' },
    critChance: { label: 'Crit Chance',       fmt: 'pct',   range: [0.02, 0.045], w: { weapon: 7, trinket: 5 },           pre: 'Keen',       suf: 'of the Owl' },
    critMult:   { label: 'Crit Damage',       fmt: 'pct',   range: [0.12, 0.24],  w: { weapon: 5, trinket: 4 },           pre: 'Vicious',    suf: 'of Butchery' },
    atkSpeed:   { label: 'Attack Speed',      fmt: 'pct',   range: [0.04, 0.08],  w: { weapon: 6, trinket: 3, armor: 1 }, pre: 'Quick',      suf: 'of Haste' },
    castSpeed:  { label: 'Cast Speed',        fmt: 'pct',   range: [0.05, 0.09],  w: { weapon: 2, trinket: 3, armor: 1 }, pre: 'Fluent',     suf: 'of Incantation' },
    moveMul:    { label: 'Move Speed',        fmt: 'pct',   range: [0.03, 0.06],  w: { armor: 4, trinket: 3 },            pre: 'Fleet',      suf: 'of the Wind' },
    maxHp:      { label: 'Max Life',          fmt: 'flat',  range: [8, 16], perLvl: 2.2, w: { armor: 10, trinket: 5, weapon: 1 }, pre: 'Stout', suf: 'of the Bear' },
    maxMp:      { label: 'Max Resource',      fmt: 'flat',  range: [6, 12], perLvl: 1,   w: { armor: 2, trinket: 3 },     pre: 'Deep',       suf: 'of the Well' },
    armor:      { label: 'Armor',             fmt: 'flat',  range: [6, 13], perLvl: 1.6, w: { armor: 10, trinket: 2 },    pre: 'Plated',     suf: 'of the Wall' },
    resAll:     { label: 'All Resistances',   fmt: 'pct',   range: [0.04, 0.07],  w: { armor: 4, trinket: 3 },            pre: 'Warded',     suf: 'of Warding' },
    resFire:    { label: 'Fire Resistance',   fmt: 'pct',   range: [0.08, 0.15],  w: { armor: 3, trinket: 1 },            pre: 'Fireproof',  suf: 'of the Hearth' },
    resIce:     { label: 'Ice Resistance',    fmt: 'pct',   range: [0.08, 0.15],  w: { armor: 3, trinket: 1 },            pre: 'Furred',     suf: 'of the Thaw' },
    resPoison:  { label: 'Poison Resistance', fmt: 'pct',   range: [0.08, 0.15],  w: { armor: 3, trinket: 1 },            pre: 'Purified',   suf: 'of the Antidote' },
    resShadow:  { label: 'Shadow Resistance', fmt: 'pct',   range: [0.08, 0.15],  w: { armor: 3, trinket: 1 },            pre: 'Lantern-lit', suf: 'of Dawn' },
    resHoly:    { label: 'Holy Resistance',   fmt: 'pct',   special: true },
    leech:      { label: 'Life Leech',        fmt: 'pct',   range: [0.01, 0.022], w: { weapon: 5, trinket: 3 },           pre: 'Thirsting',  suf: 'of Hunger' },
    cdr:        { label: 'Cooldown Recovery', fmt: 'pct',   range: [0.03, 0.06],  w: { trinket: 5, armor: 2, weapon: 1 }, pre: 'Wise',       suf: 'of the Enchiridion' },
    regen:      { label: 'Life Regen',        fmt: 'flat1', range: [0.4, 0.9], perLvl: 0.08, w: { armor: 5, trinket: 4 }, pre: 'Mossy',      suf: 'of Mending', unit: '/s' },
    mpRegen:    { label: 'Resource Regen',    fmt: 'flat1', range: [0.6, 1.3], perLvl: 0.06, w: { trinket: 3, armor: 2, weapon: 1 }, pre: 'Humming', suf: 'of the Tonic', unit: '/s' },
    thorns:     { label: 'Thorns',            fmt: 'flat',  range: [3, 7], perLvl: 0.8, w: { armor: 5, trinket: 1 },      pre: 'Barbed',     suf: 'of Brambles' },
    fireDmg:    { label: 'Fire Damage',       fmt: 'pct',   range: [0.08, 0.15],  w: { weapon: 4, trinket: 3 },           pre: 'Smoldering', suf: 'of Embers' },
    iceDmg:     { label: 'Ice Damage',        fmt: 'pct',   range: [0.08, 0.15],  w: { weapon: 4, trinket: 3 },           pre: 'Rimed',      suf: 'of Ice' },
    poisonDmg:  { label: 'Poison Damage',     fmt: 'pct',   range: [0.08, 0.15],  w: { weapon: 3, trinket: 3 },           pre: 'Festering',  suf: 'of Rot' },
    shadowDmg:  { label: 'Shadow Damage',     fmt: 'pct',   range: [0.08, 0.15],  w: { weapon: 3, trinket: 3 },           pre: 'Hollow',     suf: 'of the Nightosphere' },
    holyDmg:    { label: 'Holy Damage',       fmt: 'pct',   range: [0.08, 0.15],  w: { weapon: 3, trinket: 3 },           pre: 'Hallowed',   suf: 'of Glob' },
    goldFind:   { label: 'Gold Find',         fmt: 'pct',   range: [0.10, 0.22],  w: { trinket: 3, armor: 1 },            pre: 'Gilded',     suf: 'of the Goose' },
    magicFind:  { label: 'Rarity Luck',       fmt: 'pct',   range: [0.08, 0.16],  w: { trinket: 3, armor: 1 },            pre: 'Lucky',      suf: 'of Fortune' },
    // special / downside stats (never rolled as regular affixes)
    maxHpPct:   { label: 'Max Life',          fmt: 'pct',   special: true },
    dmgTaken:   { label: 'Damage Taken',      fmt: 'pct',   special: true, bad: 1 },
    healMul:    { label: 'Healing from Pancakes', fmt: 'pct', special: true },
  };
  const HERO_AFFINITY = {
    finn: { physDmg: 2, critChance: 1.5, critMult: 1.4, atkSpeed: 1.3, castSpeed: 0.2 },
    marceline: { shadowDmg: 2.5, leech: 1.8, critMult: 1.2, castSpeed: 0.5 },
    fp: { fireDmg: 3, castSpeed: 2.5, cdr: 1.5, physDmg: 0.3, atkSpeed: 0.6, leech: 0.6 },
  };
  // Cursed downsides (scaled a little with ilvl so a deep curse still bites)
  const CURSES = [
    { stat: 'maxHpPct', range: [-0.20, -0.12], text: 'Its roots drink from you.' },
    { stat: 'dmgTaken', range: [0.12, 0.20],   text: 'It leaves you open.' },
    { stat: 'moveMul',  range: [-0.12, -0.07], text: 'It weighs more every floor.' },
    { stat: 'resAll',   range: [-0.18, -0.10], text: 'The world gets in more easily.' },
    { stat: 'healMul',  range: [-0.5, -0.3],   text: 'Food tastes like ash.' },
  ];

  // ---------------------------------------------------------------------------
  // POWERS — unique behaviours of legendary/cursed items (implemented below in the combat hooks)
  // ---------------------------------------------------------------------------
  const POWERS = {
    valor:          { name: 'Valor',            desc: '+25% damage while above 80% life.' },
    thirst:         { name: 'Thirst',           desc: 'Hits may Bleed. Kills restore 3% of max life.' },
    night_edge:     { name: 'Night\'s Edge',    desc: '+35% damage to foes below 30% life.' },
    crystal_shards: { name: 'Crystal Shards',   desc: 'Critical hits burst into three piercing shards.' },
    grass_curse:    { name: 'Grass Curse',      desc: 'Hits Poison. 12% chance to root the target in vines.' },
    abadeer_heir:   { name: 'Abadeer Heir',     desc: 'Life leech is doubled while below 50% life.' },
    bat_swarm:      { name: 'Bat Swarm',        desc: 'Kills release two hunting bats.' },
    ruinsong:       { name: 'Ruinsong',         desc: 'Every 5th hit releases a shockwave of grief.' },
    hellstring:     { name: 'Hellstring',       desc: 'Hits have a 20% chance to Weaken.' },
    ember_wake:     { name: 'Ember Wake',       desc: 'Kills erupt in fire and ignite flammable ground.' },
    flash_fire:     { name: 'Flash Fire',       desc: 'Critical hits burst into flame.' },
    brimstone:      { name: 'Brimstone',        desc: 'Every hit Burns.' },
    last_stand:     { name: 'Last Stand',       desc: '+30% damage while below 30% life.' },
    glacial_heart:  { name: 'Glacial Heart',    desc: 'Foes that strike you may be Chilled.' },
    billy_grip:     { name: 'Hero\'s Grip',     desc: 'Every 8th kill grants Haste for 4 s.' },
    locket:         { name: 'Remembrance',      desc: 'Once per floor, falling below 30% life grants a shield.' },
    crown_whisper:  { name: 'The Crown Whispers', desc: 'Hits may Chill. Every so often, the crown chills you.' },
    owl_dream:      { name: 'Prophetic Dream',  desc: 'Every 7 s, your next hit is a guaranteed critical.' },
  };

  // ---------------------------------------------------------------------------
  // BASES. dmg/armor/hp are ilvl-1 values. mat: fixed material, mats: allowed pool, '{mat}' in name → material name.
  // minR / maxR: rarity window; only: rarity forced (uniques). implicit: always-on mods. sockets: override.
  // ---------------------------------------------------------------------------
  const W = (o) => Object.assign({ slot: 'weapon' }, o);
  const A = (o) => Object.assign({ slot: 'armor', heroes: [] }, o);
  const T = (o) => Object.assign({ slot: 'trinket', heroes: [], kind: 'charm' }, o);
  const BASES = {
    // --- Finn: swords -------------------------------------------------------
    treehouse_sword: W({ name: 'Treehouse Shortsword', kind: 'sword', heroes: ['finn'], mat: 'steel', dmg: [7, 11], speed: 1.0, starter: true, maxR: 'magic', flavor: 'It hung over the door of a treehouse that isn\'t there anymore.' }),
    rusty_rod:       W({ name: 'Rusty Rod', kind: 'sword', heroes: ['finn'], mat: 'iron', dmg: [6, 11], speed: 1.05, maxR: 'magic', flavor: 'More rust than rod. It still remembers being sharp.' }),
    longsword:       W({ name: '{mat} Longsword', kind: 'sword', heroes: ['finn'], dmg: [7, 12], speed: 1.0 }),
    broadsword:      W({ name: '{mat} Broadsword', kind: 'sword', heroes: ['finn'], dmg: [9, 14], speed: 0.88 }),
    falchion:        W({ name: '{mat} Falchion', kind: 'sword', heroes: ['finn'], dmg: [6, 10], speed: 1.15 }),
    blade:           W({ name: '{mat} Blade', kind: 'sword', heroes: ['finn'], dmg: [7, 11], speed: 1.05 }),
    root_sword:      W({ name: 'Root Sword', kind: 'sword', heroes: ['finn'], mat: 'grass', dmg: [8, 12], speed: 1.0, minR: 'magic', maxR: 'rare', minFloor: 3, flavor: 'Grown, not forged. It drinks from whatever it\'s buried in.' }),
    scarlet:         W({ name: 'Scarlet', kind: 'sword', heroes: ['finn'], mat: 'gold', dmg: [10, 15], speed: 1.05, only: 'legendary', power: 'valor', implicit: [{ stat: 'critChance', value: 0.05 }], flavor: 'Gold that refuses to tarnish, like a promise kept too long.' }),
    demon_sword:     W({ name: 'Demon Blood Sword', kind: 'sword', heroes: ['finn'], mat: 'demonblood', dmg: [11, 17], speed: 0.95, only: 'legendary', power: 'thirst', implicit: [{ stat: 'leech', value: 0.03 }], flavor: 'The blood never dried. The demon never forgave.' }),
    night_sword:     W({ name: 'Night Sword', kind: 'sword', heroes: ['finn'], mat: 'nightglass', dmg: [10, 16], speed: 1.0, only: 'legendary', power: 'night_edge', implicit: [{ stat: 'shadowDmg', value: 0.25 }], flavor: 'Its edge is the dark between two stars.' }),
    crystal_sword:   W({ name: 'Crystal Sword', kind: 'sword', heroes: ['finn'], mat: 'crystal', dmg: [9, 13], speed: 1.12, only: 'legendary', power: 'crystal_shards', implicit: [{ stat: 'critChance', value: 0.06 }], flavor: 'Cut from a gem that hums whenever the dead are near.' }),
    family_sword:    W({ name: 'Family Sword', kind: 'sword', heroes: ['finn'], mat: 'steel', dmg: [10, 15], speed: 1.0, only: 'legendary', sockets: 4, implicit: [{ stat: 'dmgPct', value: 0.15 }], flavor: 'Passed hand to hand down a line of heroes who all died young.' }),
    grass_sword:     W({ name: 'Grass Sword', kind: 'sword', heroes: ['finn'], mat: 'grass', dmg: [13, 19], speed: 1.1, only: 'cursed', power: 'grass_curse', implicit: [{ stat: 'regen', value: 2 }], curse: { stat: 'maxHpPct', value: -0.18, text: 'It took root in the last hand that held it.' }, flavor: 'It will take root in yours.' }),
    // --- Marceline: axe-basses ----------------------------------------------
    busker_bass:     W({ name: 'Busker\'s Axe-Bass', kind: 'bass', heroes: ['marceline'], mat: 'iron', dmg: [9, 15], speed: 0.85, starter: true, maxR: 'magic', flavor: 'Played for coins on the ruined highway. Swung for keeps.' }),
    axe_bass_g:      W({ name: '{mat} Axe-Bass', kind: 'bass', heroes: ['marceline'], dmg: [9, 15], speed: 0.85 }),
    war_bass:        W({ name: '{mat} War-Bass', kind: 'bass', heroes: ['marceline'], dmg: [11, 18], speed: 0.74 }),
    battle_lute:     W({ name: '{mat} Battle Lute', kind: 'bass', heroes: ['marceline'], dmg: [8, 13], speed: 0.96 }),
    grave_bass:      W({ name: 'Gravewood Bass', kind: 'bass', heroes: ['marceline'], mat: 'ossite', dmg: [10, 16], speed: 0.85, minR: 'magic', maxR: 'rare', minFloor: 3, flavor: 'Strung with catgut from no cat you would recognise.' }),
    axe_bass:        W({ name: 'Axe Bass', kind: 'bass', heroes: ['marceline'], mat: 'bloodiron', dmg: [12, 19], speed: 0.85, only: 'legendary', sockets: 4, power: 'abadeer_heir', implicit: [{ stat: 'leech', value: 0.03 }], flavor: 'A thousand years of grudges, tuned down to drop-D.' }),
    bat_bass:        W({ name: 'Bat Bass', kind: 'bass', heroes: ['marceline'], mat: 'nightglass', dmg: [11, 17], speed: 0.9, only: 'legendary', power: 'bat_swarm', implicit: [{ stat: 'shadowDmg', value: 0.2 }], flavor: 'Its strings are made of something that still screams.' }),
    ruinsong:        W({ name: 'Ruinsong', kind: 'bass', heroes: ['marceline'], mat: 'ossite', dmg: [13, 21], speed: 0.8, only: 'legendary', power: 'ruinsong', implicit: [{ stat: 'dmgPct', value: 0.12 }], flavor: 'Carved from a giant\'s thighbone. Every chord is a funeral.' }),
    hellstring:      W({ name: 'Hunson\'s Hellstring', kind: 'bass', heroes: ['marceline'], mat: 'demonblood', dmg: [15, 23], speed: 0.85, only: 'cursed', power: 'hellstring', implicit: [{ stat: 'shadowDmg', value: 0.35 }, { stat: 'leech', value: 0.04 }], curse: { stat: 'dmgTaken', value: 0.18, text: 'A gift from Dad. It only plays in the key of debt.' }, flavor: 'Some strings come with strings.' }),
    // --- Flame Princess: foci, wands, sceptres -----------------------------
    ember_focus:     W({ name: 'Ember Focus', kind: 'wand', heroes: ['fp'], mat: 'emberstone', dmg: [6, 10], speed: 1.0, starter: true, maxR: 'magic', flavor: 'A coal that never cools, cupped in black iron.' }),
    focus_g:         W({ name: '{mat} Focus', kind: 'wand', heroes: ['fp'], dmg: [6, 10], speed: 1.0 }),
    wand_g:          W({ name: '{mat} Wand', kind: 'wand', heroes: ['fp'], dmg: [5, 9], speed: 1.15 }),
    sceptre_g:       W({ name: '{mat} Sceptre', kind: 'staff', heroes: ['fp'], dmg: [8, 13], speed: 0.88 }),
    coal_sceptre:    W({ name: 'Coal Sceptre', kind: 'staff', heroes: ['fp'], mat: 'nightglass', dmg: [9, 14], speed: 0.9, minR: 'magic', maxR: 'rare', minFloor: 3, implicit: [{ stat: 'fireDmg', value: 0.1 }], flavor: 'Heavy as grief, hot as an apology.' }),
    flame_lantern:   W({ name: 'Lantern of the Flame King', kind: 'wand', heroes: ['fp'], mat: 'emberstone', dmg: [10, 15], speed: 1.0, only: 'legendary', power: 'ember_wake', implicit: [{ stat: 'fireDmg', value: 0.25 }], flavor: 'He kept his own heart in this, once. It is still warm.' }),
    flambo_match:    W({ name: 'Flambo\'s Matchstick', kind: 'wand', heroes: ['fp'], mat: 'emberstone', dmg: [8, 13], speed: 1.2, only: 'legendary', power: 'flash_fire', implicit: [{ stat: 'critChance', value: 0.06 }, { stat: 'castSpeed', value: 0.1 }], flavor: 'Strike it once for light. Strike it twice for war.' }),
    brimstone:       W({ name: 'Brimstone Censer', kind: 'staff', heroes: ['fp'], mat: 'demonblood', dmg: [13, 20], speed: 0.9, only: 'cursed', power: 'brimstone', implicit: [{ stat: 'fireDmg', value: 0.45 }], curse: { stat: 'moveMul', value: -0.1, text: 'It burns your enemies. It also burns.' }, flavor: 'The smoke has a face in it, and the face is patient.' }),
    // --- armor ----------------------------------------------------------------
    bear_hood:       A({ name: 'White Bear Hood', kind: 'hood', heroes: ['finn'], armor: 6, hp: 10, starter: true, maxR: 'magic', tint: '#e8ecf2', flavor: 'Two ears, one hero. The stitches are older than the war.' }),
    sun_hat:         A({ name: 'Wide Sunhat', kind: 'hood', heroes: ['marceline'], armor: 4, hp: 8, starter: true, maxR: 'magic', tint: '#7a6a8a', implicit: [{ stat: 'resHoly', value: 0.1 }], flavor: 'A thousand summers kept off a face that cannot bear one.' }),
    ash_shawl:       A({ name: 'Ash Shawl', kind: 'cloak', heroes: ['fp'], armor: 3, hp: 8, starter: true, maxR: 'magic', tint: '#b0563a', implicit: [{ stat: 'resFire', value: 0.1 }], flavor: 'Woven from the cinders of a kingdom\'s tapestry.' }),
    patched_hood:    A({ name: 'Patched Hood', kind: 'hood', armor: 5, hp: 12, tint: '#8c8578', implicit: [{ stat: 'moveMul', value: 0.02 }] }),
    wander_cloak:    A({ name: 'Wanderer\'s Cloak', kind: 'cloak', armor: 6, hp: 10, tint: '#5a6a78', implicit: [{ stat: 'moveMul', value: 0.04 }] }),
    plate_g:         A({ name: '{mat} Plate', kind: 'plate', mats: ARMOR_METALS, armor: 16, hp: 14, implicit: [{ stat: 'moveMul', value: -0.03 }] }),
    mail_g:          A({ name: '{mat} Mail', kind: 'mail', mats: ARMOR_METALS, armor: 11, hp: 12 }),
    candy_armor:     A({ name: 'Candy Armor', kind: 'plate', mat: 'candy', armor: 9, hp: 20, implicit: [{ stat: 'regen', value: 0.4 }], flavor: 'Hard candy plating. It smells sweet until it doesn\'t.' }),
    banana_cuirass:  A({ name: 'Banana Guard Cuirass', kind: 'plate', armor: 13, hp: 12, minFloor: 4, tint: '#e8d24a', flavor: 'Its guard stood his post until the rot took him. It took a while.' }),
    penguin_coat:    A({ name: 'Penguin-Down Coat', kind: 'cloak', armor: 7, hp: 14, minFloor: 7, tint: '#cfd8e8', implicit: [{ stat: 'resIce', value: 0.15 }], flavor: 'Warm. Do not ask where the down came from.' }),
    ashwoven_robe:   A({ name: 'Ashwoven Robe', kind: 'robe', armor: 5, hp: 10, minFloor: 10, tint: '#7a4030', implicit: [{ stat: 'resFire', value: 0.15 }, { stat: 'castSpeed', value: 0.05 }], flavor: 'Spun from ash that fell for a hundred days.' }),
    ossuary_plate:   A({ name: 'Ossuary Plate', kind: 'plate', mat: 'ossite', armor: 18, hp: 16, minFloor: 4, implicit: [{ stat: 'thorns', value: 4 }], flavor: 'Ribs of the war-dead, riveted together with spite.' }),
    nightweave:      A({ name: 'Nightweave Cloak', kind: 'cloak', mat: 'nightglass', armor: 8, hp: 12, minR: 'rare', minFloor: 6, implicit: [{ stat: 'resShadow', value: 0.2 }], flavor: 'Darkness, folded and hemmed.' }),
    billy_mantle:    A({ name: 'Billy\'s Battle Mantle', kind: 'plate', mat: 'gold', armor: 22, hp: 30, only: 'legendary', power: 'last_stand', implicit: [{ stat: 'resAll', value: 0.1 }], flavor: 'It has bled for Ooo more times than you have.' }),
    simon_coat:      A({ name: 'Simon\'s Old Coat', kind: 'cloak', mat: 'glacial', armor: 10, hp: 22, only: 'legendary', power: 'glacial_heart', implicit: [{ stat: 'resIce', value: 0.3 }, { stat: 'cdr', value: 0.08 }], flavor: 'The pockets still hold a pair of broken glasses.' }),
    lich_shroud:     A({ name: 'Lich-Touched Shroud', kind: 'robe', mat: 'nightglass', armor: 26, hp: 44, only: 'cursed', implicit: [{ stat: 'resShadow', value: 0.3 }, { stat: 'dmgPct', value: 0.15 }], curse: { stat: 'healMul', value: -0.4, text: 'Something green lives in the weave.' }, flavor: 'It is patient. It can afford to be.' }),
    // --- trinkets -------------------------------------------------------------
    ench_page:       T({ name: 'Enchiridion Page', kind: 'page', glyph: '§', minR: 'magic', implicit: [{ stat: 'cdr', value: 0.06 }, { stat: 'holyDmg', value: 0.1 }], tint: '#f0e6c0', flavor: 'The ink rearranges itself when no one is reading.' }),
    hero_gauntlet:   T({ name: 'Gauntlet of the Hero', kind: 'gauntlet', glyph: 'W', minR: 'rare', minFloor: 3, implicit: [{ stat: 'dmgPct', value: 0.12 }, { stat: 'critChance', value: 0.03 }], tint: '#d8d0b8', flavor: 'Its knuckles are dented in the shape of a hundred villains.' }),
    bone_ring:       T({ name: 'Bone Ring', kind: 'ring', glyph: 'o', tint: '#e6dcc0', flavor: 'Carved from a knuckle. The rest of the hand is still looking for it.' }),
    tarnished_amulet:T({ name: 'Tarnished Amulet', kind: 'amulet', glyph: '¤', tint: '#a89a70', flavor: 'Whoever it protected, it didn\'t.' }),
    snail_charm:     T({ name: 'Snail Shell Charm', kind: 'charm', glyph: '@', tint: '#c8b48a', implicit: [{ stat: 'magicFind', value: 0.06 }], flavor: 'It waves at you when you aren\'t looking.' }),
    lumpy_pin:       T({ name: 'Lumpy Pin', kind: 'charm', glyph: '*', tint: '#b58ae8', implicit: [{ stat: 'moveMul', value: 0.03 }], flavor: 'Purple, puffy, and deeply offended to be worn.' }),
    candy_heart:     T({ name: 'Candy Heart', kind: 'charm', glyph: '&', tint: '#ff7ac8', minFloor: 3, implicit: [{ stat: 'maxHp', value: 10 }], flavor: 'It still beats, faintly, out of habit.' }),
    lemon_rind:      T({ name: 'Lemon Rind Talisman', kind: 'charm', glyph: '(', tint: '#f2e64a', minFloor: 4, implicit: [{ stat: 'resPoison', value: 0.12 }], flavor: 'Sour enough to ward off anything with a tongue.' }),
    penguin_feather: T({ name: 'Frostbit Feather', kind: 'feather', glyph: '/', tint: '#bfe8ff', minFloor: 7, implicit: [{ stat: 'iceDmg', value: 0.1 }], flavor: 'It is cold to the touch, even in fire.' }),
    ember_charm:     T({ name: 'Ember Charm', kind: 'charm', glyph: '*', tint: '#ff8a2a', minFloor: 10, implicit: [{ stat: 'fireDmg', value: 0.1 }], flavor: 'A spark someone chose to keep.' }),
    witch_bead:      T({ name: 'Witchfire Bead', kind: 'amulet', glyph: 'o', tint: '#6cff8a', minFloor: 13, implicit: [{ stat: 'shadowDmg', value: 0.1 }, { stat: 'poisonDmg', value: 0.1 }], flavor: 'Green flame in a glass bead. It knows your name.' }),
    billys_ring:     T({ name: 'Billy\'s Ring', kind: 'ring', glyph: 'O', only: 'legendary', power: 'billy_grip', implicit: [{ stat: 'dmgPct', value: 0.15 }, { stat: 'maxHp', value: 20 }], tint: '#ffc94a', flavor: 'Too big for any finger now living.' }),
    gumball_locket:  T({ name: 'Gumball Locket', kind: 'amulet', glyph: '¤', only: 'legendary', power: 'locket', implicit: [{ stat: 'regen', value: 1.2 }, { stat: 'maxHp', value: 15 }], tint: '#ff8ad8', flavor: 'Inside: a pink smile, faded to grey.' }),
    owl_feather:     T({ name: 'Feather of the Cosmic Owl', kind: 'feather', glyph: '/', only: 'legendary', power: 'owl_dream', implicit: [{ stat: 'critChance', value: 0.06 }], tint: '#a9c8ff', flavor: 'It falls upward if you let go.' }),
    crown_shard:     T({ name: 'Crown Shard', kind: 'shard', glyph: 'M', only: 'cursed', power: 'crown_whisper', implicit: [{ stat: 'iceDmg', value: 0.4 }, { stat: 'cdr', value: 0.15 }], curse: { stat: 'maxHpPct', value: -0.15, text: 'It sings. Do not sing back.' }, tint: '#6ff0ff', flavor: 'A splinter of the crown, still cold from his head.' }),
    demon_contract:  T({ name: 'Demon\'s Contract', kind: 'page', glyph: '§', only: 'cursed', implicit: [{ stat: 'dmgPct', value: 0.4 }, { stat: 'leech', value: 0.04 }], curse: { stat: 'dmgTaken', value: 0.2, text: 'Signed in a hand you don\'t remember having.' }, tint: '#ff2a3a', flavor: 'The fine print is still writing itself.' }),
    gunter_bottle:   T({ name: 'Gunter\'s Bottle', kind: 'bottle', glyph: '!', only: 'cursed', implicit: [{ stat: 'critMult', value: 0.6 }, { stat: 'critChance', value: 0.06 }], curse: { stat: 'resAll', value: -0.15, text: 'Empty. Always empty.' }, tint: '#6fbf8f', flavor: 'It was a gift. From whom, no one will say.' }),
  };
  for (const k in BASES) { const b = BASES[k]; b.id = k; b.heroes = b.heroes || []; }

  const GLYPH_BY_KIND = { sword: '/', bass: 'Y', axe: 'P', wand: 'i', staff: '|', hood: 'n', cloak: 'A', plate: 'H', mail: '#', robe: 'A', ring: 'o', amulet: '¤', page: '§', charm: '*', gauntlet: 'W', feather: '/', shard: 'M', bottle: '!' };
  const RARE_A = ['Grave', 'Ash', 'Bone', 'Hollow', 'Mourn', 'Rot', 'Wick', 'Gloom', 'Witch', 'Ember', 'Frost', 'Dusk', 'Lich', 'Sorrow', 'Cinder', 'Marrow', 'Moth', 'Tallow'];
  const RARE_B = {
    weapon: ['Song', 'Fang', 'Edge', 'Bite', 'Lament', 'Wail', 'Hymn', 'Thorn', 'Kiss', 'Chord', 'Vow', 'Brand', 'Howl', 'Dirge'],
    armor: ['Mantle', 'Shroud', 'Ward', 'Shell', 'Coat', 'Hide', 'Veil', 'Husk', 'Carapace'],
    trinket: ['Charm', 'Eye', 'Token', 'Knot', 'Tear', 'Heart', 'Relic', 'Promise'],
  };
  const KIND_FLAVOR = {
    sword: ['Forged after the war, from things the war left behind.', 'Someone carved tally marks into the grip. They stop at forty.', 'It has been sharpened so often it is half the blade it was.'],
    bass: ['Every scratch on the body is a verse no one wrote down.', 'The frets are worn smooth by a thousand sad songs.', 'It hums when the moon is out, out of tune on purpose.'],
    wand: ['Warm in the hand, like something alive and sleeping.', 'Ash flakes from it in a slow, unending snow.', 'It sparks when it is pointed at the dead.'],
    staff: ['Heavy with old heat.', 'The head is blackened glass with a coal inside it.', 'It leaves a scorched ring wherever it rests.'],
    armor: ['Patched more times than its last owner was.', 'It smells of rain, smoke, and old fear.', 'Dented in places that tell a bad story.', 'Too big for you. It was too big for them, too.'],
    trinket: ['It is lighter than it should be.', 'Found on a body that did not need it any longer.', 'It is warm. It shouldn\'t be.', 'It ticks, very quietly, like a heart counting down.'],
  };

  // ---------------------------------------------------------------------------
  // generation
  // ---------------------------------------------------------------------------
  const rankOf = (r) => RARITY_ORDER.indexOf(r);

  function rarityWeights(floorIndex, bias) {
    const f = M.clamp(floorIndex || 1, 1, 16), m = 1 + Math.max(-0.5, bias || 0);
    return {
      common: Math.max(16, 72 - f * 3.6) / Math.sqrt(m),
      magic: (22 + f * 0.9) * Math.sqrt(m),
      rare: (5 + f * 1.1) * m,
      legendary: (0.5 + f * 0.32) * Math.pow(m, 1.4),
      cursed: f >= 3 ? (0.4 + f * 0.22) * Math.pow(m, 1.1) : 0,
    };
  }
  function rollRarity(floorIndex, bias, rng, minR) {
    const w = rarityWeights(floorIndex, bias);
    const min = minR ? rankOf(minR) : 0;
    const ids = RARITY_ORDER.filter((r) => rankOf(r) >= min && w[r] > 0);
    return rng.weighted(ids, (r) => w[r]);
  }

  function basesFor(slot, heroId, rarity, floorIndex) {
    const out = [];
    for (const k in BASES) {
      const b = BASES[k];
      if (b.slot !== slot) continue;
      if (b.heroes.length && heroId && !b.heroes.includes(heroId)) continue;
      if (b.minFloor && floorIndex < b.minFloor) continue;
      if (b.only) { if (b.only !== rarity) continue; }
      else { // generic bases may also carry a generated legendary/cursed roll
        if (b.minR && rankOf(rarity) < rankOf(b.minR)) continue;
        if (b.maxR && rankOf(rarity) > rankOf(b.maxR)) continue;
      }
      out.push(b);
    }
    return out;
  }

  function rollMaterial(base, floorIndex, rarity, rng) {
    if (base.mat) return base.mat;
    if (base.slot === 'trinket') return null;
    if (base.slot === 'armor' && !base.mats) return null; // cloth armor
    const pool = base.mats || Object.keys(MATERIALS);
    const f = floorIndex || 1, act = Math.ceil(f / 3), rk = rankOf(rarity);
    return rng.weighted(pool, (id) => {
      const m = MATERIALS[id];
      let w = m.tier === 0 ? Math.max(1.2, 10 - f * 0.6) : m.tier === 1 ? 3 + f * 0.4 : 0.5 + f * 0.45;
      if (m.act === act) w *= 3;
      if (rk >= 2) w *= 1 + m.tier * 0.8;
      return w;
    });
  }

  function modValue(stat, ilvl, rarity, rng) {
    const d = MODS[stat];
    const base = M.lerp(d.range[0], d.range[1], rng.next());
    let v = d.fmt === 'pct' ? base * (1 + 0.06 * (ilvl - 1)) : base + (d.perLvl || 0) * (ilvl - 1);
    v *= RARITIES[rarity].modMul;
    return d.fmt === 'flat' ? Math.max(1, Math.round(v)) : d.fmt === 'flat1' ? r2(v) : Math.round(v * 1000) / 1000;
  }

  function rollMods(slot, heroId, n, ilvl, rarity, rng, exclude) {
    const out = [];
    const used = new Set(exclude || []);
    const aff = HERO_AFFINITY[heroId] || {};
    for (let k = 0; k < n; k++) {
      const pool = Object.keys(MODS).filter((s) => !MODS[s].special && !used.has(s) && (MODS[s].w[slot] || 0) > 0);
      if (!pool.length) break;
      const stat = rng.weighted(pool, (s) => MODS[s].w[slot] * (aff[s] || 1));
      used.add(stat);
      out.push({ stat, value: modValue(stat, ilvl, rarity, rng) });
    }
    return out;
  }

  function baseName(base, matId) {
    return base.name.replace('{mat}', matId ? MATERIALS[matId].name : 'Plain');
  }

  function makeName(item, base, rng) {
    const bn = baseName(base, item.material);
    if (base.only) return bn; // uniques keep their names
    const rolled = item.mods.filter((m) => !m.implicit && !m.curse);
    if (item.rarity === 'common' || !rolled.length) return item.rarity === 'cursed' ? 'Cursed ' + bn : bn;
    const a = MODS[rolled[0].stat], b = rolled[1] ? MODS[rolled[1].stat] : null;
    if (item.rarity === 'magic') {
      if (b) return a.pre + ' ' + bn + ' ' + b.suf;
      return rng.chance(0.5) ? a.pre + ' ' + bn : bn + ' ' + a.suf;
    }
    if (item.rarity === 'cursed') return 'Cursed ' + bn + ' ' + a.suf;
    if (item.rarity === 'legendary') return rng.pick(['The Last ', 'The Hollow ', 'Old ', 'The Weeping ', 'The Black ']) + rng.pick(RARE_B[item.slot]) + ' of ' + rng.pick(['Ooo', 'the Ash', 'the Well', 'Glob', 'the Mushroom War', 'the Last Human']);
    // rare
    if (rng.chance(0.45)) return rng.pick(RARE_A) + ' ' + rng.pick(RARE_B[item.slot]);
    const kindWord = item.slot === 'weapon' ? ({ sword: 'Blade', bass: 'Axe-Bass', wand: 'Wand', staff: 'Sceptre' }[item.kind] || 'Blade') : bn.split(' ').pop();
    return a.pre + ' ' + kindWord + ' ' + (b ? b.suf : a.suf);
  }

  function itemValue(item) {
    const rv = RARITIES[item.rarity] ? RARITIES[item.rarity].value : 1;
    return Math.round((8 + item.level * 5) * rv * (item.slot === 'weapon' ? 1.2 : 1) + (item.sockets || 0) * 6 + (item.runes ? item.runes.length * 12 : 0));
  }

  // opts: {floorIndex, slot, heroId, rarityBias, rng, rarity, baseId, ilvl}
  function rollItem(opts) {
    opts = opts || {};
    const rng = opts.rng || HM.rng;
    const floorIndex = opts.floorIndex || (G() && G().run ? G().run.floorIndex : 1);
    const heroId = opts.heroId || (G() && G().run ? G().run.heroId : 'finn');
    let base = opts.baseId ? BASES[opts.baseId] : null;
    let rarity = opts.rarity || (base && base.only) || rollRarity(floorIndex, opts.rarityBias || 0, rng, base && base.minR);
    let slot = base ? base.slot : opts.slot || rng.weighted(['weapon', 'armor', 'trinket'], (s) => ({ weapon: 4, armor: 3.2, trinket: 2.6 }[s]));
    if (!base) {
      let pool = basesFor(slot, heroId, rarity, floorIndex);
      // legendary/cursed: prefer uniques, otherwise a generic base carries a generated unique-style roll
      if (rarity === 'legendary' || rarity === 'cursed') {
        const uniq = pool.filter((b) => b.only === rarity);
        const gen = pool.filter((b) => !b.only && !b.starter && !b.maxR);
        pool = uniq.length && (rng.chance(0.78) || !gen.length) ? uniq : gen;
      } else pool = pool.filter((b) => !b.only && (!b.starter || rarity === 'common'));
      if (!pool.length) pool = basesFor(slot, heroId, 'common', floorIndex).filter((b) => !b.only);
      if (!pool.length) { slot = 'trinket'; pool = basesFor('trinket', heroId, 'common', floorIndex).filter((b) => !b.only); }
      base = rng.weighted(pool, (b) => (b.only ? 3 : b.mat ? 1.6 : 1.2) * (b.starter ? 0.4 : 1));
    }
    const ilvl = M.clamp(opts.ilvl || floorIndex + rng.int(-1, 1), 1, 18);
    const RR = RARITIES[rarity];
    const material = rollMaterial(base, floorIndex, rarity, rng);
    const item = {
      uid: newUid(), baseId: base.id, name: '', slot: base.slot, kind: base.kind, heroes: base.heroes.slice(),
      material, rarity, level: ilvl, dmg: null, speed: base.speed || 1, armor: 0, hp: 0,
      mods: [], runes: [], sockets: 0, power: base.power || null, flavor: '', glyph: base.glyph || GLYPH_BY_KIND[base.kind] || '?', value: 0,
    };
    if (base.slot === 'weapon') {
      const sc = (1 + 0.12 * (ilvl - 1)) * RR.dmg * (0.94 + rng.next() * 0.12);
      item.dmg = [Math.max(1, Math.round(base.dmg[0] * sc)), Math.max(2, Math.round(base.dmg[1] * sc))];
      if (item.dmg[1] <= item.dmg[0]) item.dmg[1] = item.dmg[0] + 1;
      item.sockets = base.sockets || { common: rng.chance(0.35) ? 1 : 0, magic: 1, rare: 2, legendary: 3, cursed: 2 }[rarity];
    } else if (base.slot === 'armor') {
      const ra = { common: 1, magic: 1.08, rare: 1.18, legendary: 1.3, cursed: 1.4 }[rarity];
      item.armor = Math.round(base.armor * (1 + 0.14 * (ilvl - 1)) * ra);
      item.hp = Math.round(base.hp * (1 + 0.12 * (ilvl - 1)) * ra);
    }
    // implicit (always-on) mods scale gently with level
    for (const im of base.implicit || []) {
      const d = MODS[im.stat] || {};
      const v = d.fmt === 'pct' ? im.value * (1 + 0.025 * (ilvl - 1)) : d.fmt === 'flat' ? Math.round(im.value * (1 + 0.08 * (ilvl - 1))) : im.value * (1 + 0.05 * (ilvl - 1));
      item.mods.push({ stat: im.stat, value: d.fmt === 'flat' ? v : Math.round(v * 1000) / 1000, implicit: true });
    }
    // rolled affixes
    const n = rng.int(RR.mods[0], RR.mods[1]);
    for (const m of rollMods(item.slot, heroId, n, ilvl, rarity, rng, item.mods.map((x) => x.stat))) item.mods.push(m);
    // curse: the real downside
    if (rarity === 'cursed') {
      if (base.curse) item.mods.push({ stat: base.curse.stat, value: base.curse.value, curse: true, text: base.curse.text });
      else {
        const c = rng.pick(CURSES);
        item.mods.push({ stat: c.stat, value: Math.round(M.lerp(c.range[0], c.range[1], rng.next()) * (1 + 0.02 * (ilvl - 1)) * 1000) / 1000, curse: true, text: c.text });
        // generic cursed items get a big extra upside to pay for it
        const up = rollMods(item.slot, heroId, 1, ilvl + 4, 'cursed', rng, item.mods.map((x) => x.stat))[0];
        if (up) { up.value = MODS[up.stat].fmt === 'flat' ? Math.round(up.value * 1.6) : Math.round(up.value * 1600) / 1000; item.mods.push(up); }
      }
    }
    // pre-socketed runes on some magic+ weapons
    if (item.sockets > 0 && rarity !== 'common' && rng.chance({ magic: 0.15, rare: 0.3, legendary: 0.5, cursed: 0.4 }[rarity] || 0)) item.runes.push(rng.pick(RUNE_IDS));
    item.name = opts.name || makeName(item, base, rng);
    // named bases carry their own line; generic ones ask Lore, then fall back to our per-kind lines
    let fl = base.flavor || null;
    if (!fl) { try { if (HM.Lore && typeof HM.Lore.itemFlavor === 'function') fl = HM.Lore.itemFlavor(item); } catch (e) { fl = null; } }
    item.flavor = typeof fl === 'string' && fl ? fl : rng.pick(KIND_FLAVOR[item.slot === 'weapon' ? item.kind : item.slot] || KIND_FLAVOR.trinket);
    item.value = itemValue(item);
    return item;
  }

  function starterFor(slot, heroId) {
    for (const k in BASES) { const b = BASES[k]; if (b.starter && b.slot === slot && b.heroes.includes(heroId)) return b; }
    return null;
  }
  function newInventory(heroId, meta) {
    const rng = new HM.RNG(HM.M.hashStr(String(heroId)) ^ 0x51ed);
    const wb = starterFor('weapon', heroId) || BASES.treehouse_sword, ab = starterFor('armor', heroId) || BASES.patched_hood;
    const weapon = rollItem({ baseId: wb.id, rarity: 'common', ilvl: 1, rng, heroId, floorIndex: 1 });
    const armor = rollItem({ baseId: ab.id, rarity: 'common', ilvl: 1, rng, heroId, floorIndex: 1 });
    weapon.mods = weapon.mods.filter((m) => m.implicit); armor.mods = armor.mods.filter((m) => m.implicit);
    weapon.sockets = 1; weapon.runes = []; weapon.starter = true; armor.starter = true;
    weapon.value = itemValue(weapon); armor.value = itemValue(armor);
    return { equipped: { weapon, armor, trinket: null }, bag: [], runes: {} };
  }

  // ---------------------------------------------------------------------------
  // stats
  // ---------------------------------------------------------------------------
  // Sum all stat contributions of one item (implicit + rolled + curse + material + runes).
  function itemContribs(item, out) {
    out = out || {};
    const add = (s, v) => { out[s] = (out[s] || 0) + v; };
    for (const m of item.mods || []) add(m.stat, m.value);
    const mat = item.material && MATERIALS[item.material];
    if (mat && item.slot !== 'trinket') for (const m of mat.mods) add(m.stat, item.slot === 'armor' ? m.value * 0.5 : m.value);
    if (item.slot === 'armor') { add('armor', item.armor || 0); add('maxHp', item.hp || 0); }
    for (const rid of item.runes || []) { const ru = RUNES[rid]; if (ru && ru.stats) for (const s of ru.stats) add(s.stat, s.value); }
    return out;
  }

  function inv(run) {
    if (!run) return null;
    const I = run.inventory || (run.inventory = { equipped: {}, bag: [], runes: {} });
    I.equipped = I.equipped || {}; I.bag = I.bag || []; I.runes = I.runes || {};
    for (const s of ['weapon', 'armor', 'trinket']) if (I.equipped[s] === undefined) I.equipped[s] = null;
    return I;
  }
  const runOf = (player) => (player && player.run) || (G() && G().run) || null;

  // Apply a stat bag {stat: value} onto an actor (stats are expected to be freshly reset by Heroes.recompute).
  function applyStatBag(p, c) {
    const st = p.stats;
    st.res = st.res || { phys: 0, fire: 0, ice: 0, poison: 0, shadow: 0, holy: 0 };
    st.elemMul = st.elemMul || { phys: 1, fire: 1, ice: 1, poison: 1, shadow: 1, holy: 1 };
    const v = (k) => c[k] || 0;
    if (v('dmgPct')) st.dmgMul *= 1 + v('dmgPct');
    st.critChance += v('critChance'); st.critMult += v('critMult');
    if (v('atkSpeed')) st.atkSpeed *= 1 + v('atkSpeed');
    if (v('castSpeed')) st.castSpeed *= 1 + v('castSpeed');
    if (v('moveMul')) st.moveMul *= Math.max(0.3, 1 + v('moveMul'));
    st.armor += v('armor');
    for (const [k, t] of [['resFire', 'fire'], ['resIce', 'ice'], ['resPoison', 'poison'], ['resShadow', 'shadow'], ['resHoly', 'holy'], ['resPhys', 'phys']]) st.res[t] = (st.res[t] || 0) + v(k);
    if (v('resAll')) for (const t of ['phys', 'fire', 'ice', 'poison', 'shadow', 'holy']) st.res[t] = (st.res[t] || 0) + v('resAll') * (t === 'phys' ? 0.5 : 1);
    st.leech += v('leech');
    st.cdr = M.clamp((st.cdr || 0) + v('cdr'), -0.5, 0.6);
    st.regen += v('regen'); st.mpRegen += v('mpRegen'); st.thorns += v('thorns');
    if (v('dmgTaken')) st.dmgTakenMul *= Math.max(0.2, 1 + v('dmgTaken'));
    for (const [k, t] of [['fireDmg', 'fire'], ['iceDmg', 'ice'], ['poisonDmg', 'poison'], ['shadowDmg', 'shadow'], ['holyDmg', 'holy'], ['physDmg', 'phys']]) if (v(k)) st.elemMul[t] = (st.elemMul[t] || 1) * (1 + v(k));
    st.goldFind = (st.goldFind || 0) + v('goldFind');
    st.magicFind = (st.magicFind || 0) + v('magicFind');
    st.healMul = (st.healMul === undefined ? 1 : st.healMul) * Math.max(0.1, 1 + v('healMul'));
    if (v('maxHp')) p.maxHp += v('maxHp');
    if (v('maxHpPct')) p.maxHp *= Math.max(0.2, 1 + v('maxHpPct'));
    if (v('maxMp') && p.maxMp > 0) p.maxMp += v('maxMp');
    p.maxHp = Math.max(1, Math.round(p.maxHp));
  }

  function weaponInfo(item) {
    const mat = (item && item.material && MATERIALS[item.material]) || MATERIALS.iron;
    let trail = mat.color.slice(), element = null, runeKind = null;
    if (item && item.runes && item.runes.length) {
      // dominant rune tints the swing trail
      const cnt = {}; for (const r of item.runes) cnt[r] = (cnt[r] || 0) + 1;
      let best = null; for (const r in cnt) if (!best || cnt[r] > cnt[best]) best = r;
      const ru = RUNES[best]; trail = M.mixRgb(mat.color, ru.color, Math.min(1, 0.55 + 0.15 * cnt[best])); element = ru.element || null; runeKind = best;
    }
    return {
      kind: item ? item.kind : 'fists', material: mat.id, glyphs: mat.glyphs, color: mat.color.slice(), emissive: mat.emissive || 0,
      trail, element, runeKind, rarity: item ? item.rarity : 'common', name: item ? item.name : 'Bare Hands',
      runes: item ? (item.runes || []).map((r) => (RUNES[r] ? RUNES[r].glyph : '')).join('') : '', runeIds: item ? (item.runes || []).slice() : [],
    };
  }

  // equipment → player.stats / player.weapon / player.weaponDmg (+ runeAdds, procs, itemPowers for the hooks below)
  function applyStats(player) {
    if (!player || !player.stats) return;
    const run = runOf(player); const I = inv(run);
    player.mods = player.mods || {};
    player._statGen = (player._statGen || 0) + 1; // recompute generation (see Meta.applyPlayer)
    const eq = I ? I.equipped : {};
    const w = eq.weapon;
    const c = {};
    for (const s of ['weapon', 'armor', 'trinket']) if (eq[s]) itemContribs(eq[s], c);
    applyStatBag(player, c);
    if (w && w.dmg) {
      player.weaponDmg = [w.dmg[0], w.dmg[1]];
      player.weaponSpeed = w.speed || 1;
      if (w.speed && w.speed !== 1) { player.stats.atkSpeed *= w.speed; if (w.kind === 'wand' || w.kind === 'staff') player.stats.castSpeed *= w.speed; }
    } else { player.weaponDmg = [2, 4]; player.weaponSpeed = 1; }
    player.weapon = weaponInfo(w);
    if (!w) player.weapon.kind = 'fists';
    // rune adds & procs (consumed by the damage hook)
    const adds = {}, procs = {};
    for (const rid of (w && w.runes) || []) {
      const ru = RUNES[rid]; if (!ru) continue;
      if (ru.add) { const k = rid === 'lightning' ? 'lightning' : ru.element; adds[k] = (adds[k] || 0) + ru.add; }
      if (ru.proc) procs[ru.proc] = (procs[ru.proc] || 0) + ru.chance;
    }
    player.runeAdds = adds; player.runeProcs = procs;
    player.itemPowers = [];
    for (const s of ['weapon', 'armor', 'trinket']) if (eq[s] && eq[s].power && POWERS[eq[s].power]) player.itemPowers.push(eq[s].power);
    player.weaponDps = r2(((player.weaponDmg[0] + player.weaponDmg[1]) / 2) * player.stats.dmgMul * (player.weaponSpeed || 1));
  }

  // summary numbers for compare / UI
  function summary(item) {
    if (!item) return { dps: 0, avg: 0, armor: 0, maxHp: 0, contrib: {} };
    const c = itemContribs(item, {});
    const avg = item.dmg ? (item.dmg[0] + item.dmg[1]) / 2 : 0;
    const dmul = (1 + (c.dmgPct || 0)) * (1 + (c.physDmg || 0) * 0.5) * (1 + Math.max(0, c.critChance || 0) * 0.6);
    let runeAdd = 0; for (const r of item.runes || []) runeAdd += (RUNES[r] && RUNES[r].add) || 0;
    return { dps: r2(avg * (item.speed || 1) * dmul * (1 + runeAdd)), avg, armor: c.armor || 0, maxHp: c.maxHp || 0, contrib: c };
  }

  function fmtMod(stat, value) {
    const d = MODS[stat]; if (!d) return flat(value) + ' ' + stat;
    if (d.fmt === 'pct') return pct(value) + ' ' + d.label;
    if (d.fmt === 'flat1') return flat(value, 1) + ' ' + d.label + (d.unit || '');
    return flat(value) + ' ' + d.label;
  }
  const fmtModFull = (m) => fmtMod(m.stat, m.value);

  const C = { title: null, sub: '#8d939c', stat: '#e8e8e8', mod: '#8fb0ff', implicit: '#c8d0dc', curse: '#ff4a5a', power: '#ff9a3a', flavor: '#7f858e', meta: '#5f656e', up: '#6fe36f', down: '#ff5a5a', rune: '#d8d8e8' };
  // Tooltip lines. compareTo (optional): the equipped item in the same slot → delta lines.
  function describe(item, compareTo) {
    if (!item) return [{ text: 'Empty', color: C.sub, style: 'sub' }];
    const R0 = RARITIES[item.rarity] || RARITIES.common;
    const mat = item.material && MATERIALS[item.material];
    const L = [];
    L.push({ text: item.name, color: R0.hex, style: 'title' });
    const kindName = { sword: 'Sword', bass: 'Axe-Bass', wand: 'Focus', staff: 'Sceptre', hood: 'Hood', cloak: 'Cloak', plate: 'Plate Armor', mail: 'Mail', robe: 'Robe' }[item.kind] || (item.slot === 'trinket' ? 'Trinket' : item.kind);
    L.push({ text: R0.name.toLowerCase() + ' ' + kindName.toLowerCase() + (mat ? ', ' + mat.name.toLowerCase() : '') + (item.heroes && item.heroes.length === 1 ? ' · ' + ({ finn: 'Finn', marceline: 'Marceline', fp: 'Flame Princess' }[item.heroes[0]] || item.heroes[0]) : ''), color: C.sub, style: 'sub' });
    const s = summary(item);
    if (item.dmg) L.push({ text: 'damage ' + item.dmg[0] + '-' + item.dmg[1] + ' · speed ' + (item.speed || 1).toFixed(2) + ' · dps ' + s.dps.toFixed(1), color: C.stat, style: 'stat' });
    if (item.slot === 'armor') L.push({ text: 'armor ' + item.armor + ' · life +' + item.hp, color: C.stat, style: 'stat' });
    for (const m of item.mods) if (m.implicit) L.push({ text: fmtModFull(m), color: C.implicit, style: 'implicit' });
    for (const m of item.mods) if (!m.implicit && !m.curse) L.push({ text: fmtModFull(m), color: C.mod, style: 'mod' });
    if (mat && item.slot !== 'trinket') L.push({ text: mat.name + ': ' + mat.mods.map((m) => fmtMod(m.stat, item.slot === 'armor' ? m.value * 0.5 : m.value)).join(', '), color: mat.hex, style: 'material' });
    if (item.power && POWERS[item.power]) L.push({ text: POWERS[item.power].name + ' — ' + POWERS[item.power].desc, color: C.power, style: 'power' });
    for (const m of item.mods) if (m.curse) { L.push({ text: 'CURSE: ' + fmtModFull(m), color: C.curse, style: 'curse' }); if (m.text) L.push({ text: m.text, color: '#b0303e', style: 'curse' }); }
    if (item.sockets > 0) {
      const slots = []; for (let k = 0; k < item.sockets; k++) slots.push(item.runes[k] ? '[' + RUNES[item.runes[k]].glyph + ']' : '[ ]');
      L.push({ text: 'runes ' + item.runes.length + '/' + item.sockets + '  ' + slots.join(''), color: C.rune, style: 'runes' });
      const cnt = {}; for (const rid of item.runes) cnt[rid] = (cnt[rid] || 0) + 1;
      for (const rid in cnt) { const ru = RUNES[rid]; if (ru) L.push({ text: runeText(ru, cnt[rid]), color: ru.hex, style: 'rune' }); }
    }
    if (compareTo && compareTo !== item && compareTo.slot === item.slot) {
      const o = summary(compareTo);
      const d = (label, a, b, dec) => { const x = a - b; if (Math.abs(x) < (dec ? 0.05 : 0.5)) return; L.push({ text: (x > 0 ? '+' : '') + (dec ? x.toFixed(1) : Math.round(x)) + ' ' + label + ' vs. equipped', color: x > 0 ? C.up : C.down, style: 'compare' }); };
      if (item.slot === 'weapon') d('dps', s.dps, o.dps, 1);
      d('armor', s.armor, o.armor); d('life', s.maxHp, o.maxHp);
      const keys = new Set([...Object.keys(s.contrib), ...Object.keys(o.contrib)]);
      for (const k of keys) {
        if (k === 'armor' || k === 'maxHp' || !MODS[k]) continue;
        const x = (s.contrib[k] || 0) - (o.contrib[k] || 0); if (Math.abs(x) < 0.004) continue;
        const good = MODS[k].bad ? x < 0 : x > 0;
        L.push({ text: fmtMod(k, x) + ' vs. equipped', color: good ? C.up : C.down, style: 'compare' });
      }
    }
    if (item.flavor) L.push({ text: item.flavor, color: C.flavor, style: 'flavor' }); // exact text: UI dedups on it
    L.push({ text: 'item level ' + item.level + ' · worth ' + item.value + 'g', color: C.meta, style: 'meta' });
    return L;
  }

  // Combined effect of n identical runes, e.g. "^^ Fire x2: adds 24% of hit damage as Fire, 20% chance to Burn"
  function runeText(ru, n) {
    const head = ru.glyph.repeat(n) + ' ' + ru.name.replace(' Rune', '') + (n > 1 ? ' x' + n : '') + ': ';
    const parts = [];
    if (ru.add) parts.push('adds ' + Math.round(ru.add * n * 100) + '% of hit damage as ' + (ru.id === 'lightning' ? 'Lightning' : ru.element[0].toUpperCase() + ru.element.slice(1)) + (ru.id === 'holy' ? ' (x1.5 vs. undead)' : ''));
    if (ru.proc) parts.push(Math.round(Math.min(1, ru.chance * n) * 100) + '% chance to ' + ({ burn: 'Burn', chill: 'Chill', chain: 'arc to a nearby foe', bleed: 'cause Bleeding', poison: 'Poison' }[ru.proc]));
    if (ru.stats) for (const st of ru.stats) parts.push(fmtMod(st.stat, st.value * n));
    return head + parts.join(', ');
  }
  // Small multi-line ASCII icon for inventory slots: {lines, color, hex, glyphColor(ch)}
  const ICONS = {
    sword: ['    /', '   /', '\\ /', ' X', '/ \\'], bass: ['  _/', ' //', '/#\\', '\\#/'], wand: ['   o', '  /', ' /', '/'], staff: ['  @', '  |', '  |', '  |'], axe: [' _ /', '|_X', '  \\'],
    hood: [' /\\ ', '/##\\', '|  |'], cloak: [' /\\', '/##\\', '####'], plate: ['/##\\', '####', ' ## '], mail: ['/##\\', '####', ' ## '], robe: [' /\\', '/##\\', '/##\\'],
  };
  function icon(item) {
    if (!item) return { lines: [], hex: '#555', color: [0.3, 0.3, 0.3] };
    const mat = item.material && MATERIALS[item.material];
    const col = mat ? mat.hex : (BASES[item.baseId] && BASES[item.baseId].tint) || RARITIES[item.rarity].hex;
    let lines = ICONS[item.kind];
    if (!lines) lines = [' ' + item.glyph + ' '];
    if (mat) { let n = 0; lines = lines.map((l) => l.replace(/#/g, () => mat.glyphs[n++ % mat.glyphs.length])); }
    return { lines, hex: col, color: hex(col), rarityHex: RARITIES[item.rarity].hex };
  }

  // ---------------------------------------------------------------------------
  // inventory operations
  // ---------------------------------------------------------------------------
  const BAG_CAP = 20;
  function refreshPlayer() {
    const p = G() && G().player;
    if (p && HM.Heroes && HM.Heroes.recompute) { try { HM.Heroes.recompute(p); } catch (e) { console.error('[items] recompute', e); } }
  }
  function findItem(run, uid) {
    const I = inv(run); if (!I) return null;
    const bi = I.bag.findIndex((it) => it && it.uid === uid);
    if (bi >= 0) return { item: I.bag[bi], where: 'bag', index: bi };
    for (const s of ['weapon', 'armor', 'trinket']) if (I.equipped[s] && I.equipped[s].uid === uid) return { item: I.equipped[s], where: 'equipped', slot: s };
    return null;
  }
  function canUse(run, item) { return !item.heroes || !item.heroes.length || !run || item.heroes.includes(run.heroId); }

  function equip(run, uid) {
    const I = inv(run); const f = findItem(run, uid);
    if (!f) return { ok: false, error: 'No such item.' };
    if (f.where === 'equipped') return { ok: true, item: f.item };
    const it = f.item;
    if (!canUse(run, it)) return { ok: false, error: 'Only ' + ({ finn: 'Finn', marceline: 'Marceline', fp: 'Flame Princess' }[it.heroes[0]] || 'another hero') + ' can wield that.' };
    const prev = I.equipped[it.slot];
    I.equipped[it.slot] = it;
    if (prev) I.bag[f.index] = prev; else I.bag.splice(f.index, 1);
    refreshPlayer();
    if (it.rarity === 'cursed') toast('The ' + it.name + ' tightens around you.', RARITIES.cursed.hex, 2.6);
    return { ok: true, item: it, prev: prev || null };
  }
  function unequip(run, slot) {
    const I = inv(run); if (!I || !I.equipped[slot]) return { ok: false, error: 'Nothing equipped there.' };
    if (I.bag.length >= BAG_CAP) return { ok: false, error: 'Your pack is full.' };
    const it = I.equipped[slot]; I.equipped[slot] = null; I.bag.push(it);
    refreshPlayer();
    return { ok: true, item: it };
  }
  // Discard = drop it on the ground at your feet (recoverable) when in a floor; otherwise it's gone.
  function discard(run, uid) {
    const I = inv(run); const f = findItem(run, uid); if (!f) return { ok: false, error: 'No such item.' };
    if (f.where === 'bag') I.bag.splice(f.index, 1); else { I.equipped[f.slot] = null; refreshPlayer(); }
    const p = G() && G().player;
    if (p && G().floor) { const pk = dropItem(p.x, p.y, f.item, { pop: 0.6 }); if (pk) pk.dropT = 1.2; return { ok: true, item: f.item, dropped: true }; }
    return { ok: true, item: f.item, dropped: false };
  }
  // Salvage for gold (35% of value).
  function salvage(run, uid) {
    const I = inv(run); const f = findItem(run, uid); if (!f) return { ok: false, error: 'No such item.' };
    if (f.where === 'bag') I.bag.splice(f.index, 1); else { I.equipped[f.slot] = null; refreshPlayer(); }
    const g = Math.max(1, Math.round(f.item.value * 0.35));
    if (G() && G().addGold && G().run === run) G().addGold(g); else run.gold = (run.gold || 0) + g;
    play('gold');
    return { ok: true, gold: g };
  }
  function socketRune(run, itemUid, runeId) {
    const I = inv(run); const f = findItem(run, itemUid);
    if (!f) return { ok: false, error: 'No such item.' };
    const it = f.item; const ru = RUNES[runeId];
    if (!ru) return { ok: false, error: 'Unknown rune.' };
    if (!(I.runes[runeId] > 0)) return { ok: false, error: 'You have no ' + ru.name + '.' };
    if (!it.sockets || it.runes.length >= it.sockets) return { ok: false, error: 'No empty rune slot.' };
    I.runes[runeId]--; if (I.runes[runeId] <= 0) delete I.runes[runeId];
    it.runes.push(runeId); it.value = itemValue(it);
    if (f.where === 'equipped') refreshPlayer();
    play('shrine', { vol: 0.5 });
    return { ok: true, item: it };
  }
  function unsocketRune(run, itemUid, index) {
    const I = inv(run); const f = findItem(run, itemUid); if (!f) return { ok: false, error: 'No such item.' };
    const it = f.item; if (!it.runes || index < 0 || index >= it.runes.length) return { ok: false, error: 'Empty slot.' };
    const rid = it.runes.splice(index, 1)[0]; I.runes[rid] = (I.runes[rid] || 0) + 1; it.value = itemValue(it);
    if (f.where === 'equipped') refreshPlayer();
    return { ok: true, runeId: rid };
  }

  // ---------------------------------------------------------------------------
  // consumables
  // ---------------------------------------------------------------------------
  const hots = []; // heal-over-time {target, rate, left}
  function useConsumable(player, kind) {
    const run = runOf(player); if (!run || !player || player.dead) return false;
    const c = run.consumables || (run.consumables = { pancake: 0, tonic: 0 });
    const now = G() ? G().t : 0;
    if (now - (player._lastConsumeT === undefined ? -9 : player._lastConsumeT) < 0.45) return false;
    if (!(c[kind] > 0)) { toast(kind === 'pancake' ? 'No Bacon Pancakes left.' : 'No Tonics left.', '#9a9a9a', 1.4); play('ui_error'); return false; }
    player._lastConsumeT = now;
    c[kind]--;
    if (kind === 'pancake') {
      const bonus = 1 + 0.4 * ((player.mods && player.mods.pancake_bonus) || 0);
      const total = player.maxHp * 0.35 * bonus * (player.stats.healMul === undefined ? 1 : player.stats.healMul);
      hots.push({ target: player, rate: total / 2, left: 2 });
      fx('text', player.x, player.y, (player.height || 60) + 14, '+' + Math.round(total), [0.45, 1, 0.5], 1.1);
      fx('burst', player.x, player.y, 30, 'holy', 10, { color: [1, 0.8, 0.45] });
      play('potion');
    } else {
      if (typeof player.onTonic === 'function') player.onTonic();
      else if (player.maxMp > 0) player.mp = Math.min(player.maxMp, player.mp + player.maxMp * 0.6);
      fx('burst', player.x, player.y, 30, 'spark', 10, { color: [0.45, 0.7, 1] });
      fx('text', player.x, player.y, (player.height || 60) + 14, 'tonic', [0.5, 0.75, 1], 0.9);
      play('potion', { pitch: 1.3 });
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // pickups
  // ---------------------------------------------------------------------------
  const GRAV = 620, MAGNET_R = 46, COLLECT_R = 10;
  function pickups() { return (G() && G().pickups) || null; }

  function spawnPickup(o, opts) {
    const list = pickups(); if (!list) return null;
    opts = opts || {};
    const rng = HM.rng;
    const pop = opts.pop === undefined ? 1 : opts.pop;
    const ang = opts.ang !== undefined ? opts.ang + rng.range(-0.6, 0.6) : rng.range(0, Math.PI * 2);
    const sp = (40 + rng.next() * 70) * pop * (opts.spread || 1);
    const p = Object.assign({
      id: HM.uid(), x: 0, y: 0, z: pop > 0 ? (opts.z || 10) : 0, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, vz: pop > 0 ? (150 + rng.next() * 70) * Math.max(0.5, pop) : 0,
      t: 0, settled: pop <= 0, bounces: 0, spin: rng.range(-9, 9), ang: rng.range(-0.55, 0.25), r: 26, seed: rng.int(0, 1e6), dead: false, magnet: false,
      label: '', labelColor: '#d8d8d8', labelRgb: [0.85, 0.85, 0.85], labelZ: 14, prompt: '',
      canInteract: null, interact: null, used: false, hidden: false,
    }, o);
    if (p.kind !== 'item') { p.canInteract = () => false; p.interact = () => {}; }
    list.push(p);
    return p;
  }

  function dropItem(x, y, item, opts) {
    if (!item) return null;
    const RR = RARITIES[item.rarity] || RARITIES.common;
    const p = spawnPickup({ kind: 'item', x, y, item, label: item.name, labelColor: RR.hex, labelRgb: RR.color, prompt: 'Take ' + item.name }, opts);
    if (!p) return null;
    p.canInteract = () => p.settled || p.t > 0.5;
    p.interact = (pl) => pickUpItem(p, pl);
    return p;
  }
  function dropGold(x, y, n, opts) {
    n = Math.max(1, Math.round(n));
    // no ground label (it's auto-collected; labels would only clutter) — drawLabels can show amounts with {gold:true}
    return spawnPickup({ kind: 'gold', x, y, amount: n, label: '', goldLabel: n + ' gold', labelColor: '#ffc94a', labelRgb: [1, 0.79, 0.29], r: 0 }, opts);
  }
  function dropConsumable(x, y, kind, opts) {
    const name = kind === 'tonic' ? 'Tonic' : 'Bacon Pancakes';
    return spawnPickup({ kind: kind === 'tonic' ? 'tonic' : 'pancake', x, y, amount: 1, label: name, labelColor: kind === 'tonic' ? '#7fb4ff' : '#e8b070', labelRgb: kind === 'tonic' ? [0.5, 0.7, 1] : [0.91, 0.69, 0.44], r: 0 }, opts);
  }
  function dropRune(x, y, runeId, opts) {
    const ru = RUNES[runeId] || RUNES[HM.rng.pick(RUNE_IDS)];
    return spawnPickup({ kind: 'rune', x, y, runeId: ru.id, amount: 1, label: ru.name + ' ' + ru.glyph, labelColor: ru.hex, labelRgb: ru.color, r: 0 }, opts);
  }

  function pickUpItem(pk, player) {
    const run = runOf(player); const I = inv(run); if (!I || pk.dead) return false;
    const it = pk.item;
    const RR = RARITIES[it.rarity] || RARITIES.common;
    // (the UI toasts "+ name" for every collected item; only add what it can't know)
    if (!I.equipped[it.slot] && canUse(run, it)) {
      I.equipped[it.slot] = it; pk.equipped = true; refreshPlayer();
    } else if (I.bag.length < BAG_CAP) {
      I.bag.push(it);
      if (!canUse(run, it)) toast(it.name + ' is not yours to wield. Sell it to the Goose.', '#9a9a9a', 2.2);
    } else {
      toast('Your pack is full (' + BAG_CAP + ').', '#ff6a6a', 1.8); play('ui_error');
      return false;
    }
    pk.dead = true; pk.used = true;
    play('pickup', { x: pk.x, y: pk.y, pitch: 1 + RR.rank * 0.08 });
    fx('burst', pk.x, pk.y, 8, RR.rank >= 3 ? 'gold' : 'spark', 6 + RR.rank * 3, { color: RR.color });
    HM.Events.emit('itemPickup', { item: it, run });
    return true;
  }

  function collect(pk, player) {
    const run = runOf(player); if (!run) return;
    pk.dead = true;
    if (pk.kind === 'gold') {
      if (G().addGold) G().addGold(pk.amount); else run.gold += pk.amount;
      play('gold', { x: pk.x, y: pk.y, pitch: 0.9 + Math.random() * 0.25 });
      fx('text', player.x, player.y, (player.height || 60) + 6, '+' + pk.amount + 'g', [1, 0.8, 0.3], 0.8);
    } else if (pk.kind === 'pancake' || pk.kind === 'tonic') {
      const c = run.consumables || (run.consumables = { pancake: 0, tonic: 0 });
      c[pk.kind] = Math.min(9, (c[pk.kind] || 0) + pk.amount);
      play('pickup', { x: pk.x, y: pk.y, pitch: 1.2 });
      fx('text', player.x, player.y, (player.height || 60) + 6, '+1 ' + (pk.kind === 'pancake' ? 'Pancake' : 'Tonic'), pk.labelRgb, 0.8);
    } else if (pk.kind === 'rune') {
      const I = inv(run); I.runes[pk.runeId] = (I.runes[pk.runeId] || 0) + 1;
      play('pickup', { x: pk.x, y: pk.y, pitch: 1.5 });
      toast('Found a ' + RUNES[pk.runeId].name + ' ' + RUNES[pk.runeId].glyph + ' — socket it from your pack.', RUNES[pk.runeId].hex, 2.4);
    }
  }

  // first touchdown: dust, a clink, and for rare+ loot a little moment of light
  function landed(pk) {
    fx('burst', pk.x, pk.y, 2, 'dust', pk.kind === 'item' ? 5 : 2);
    if (pk.kind === 'gold') { play('gold', { x: pk.x, y: pk.y, vol: 0.25, pitch: 1.4 }); return; }
    if (pk.kind !== 'item') return;
    const RR = RARITIES[pk.item.rarity] || RARITIES.common;
    play('pickup', { x: pk.x, y: pk.y, pitch: 0.55 + 0.1 * (3 - RR.rank), vol: 0.35 + 0.12 * RR.rank });
    if (RR.rank >= 2) fx('light', pk.x, pk.y, 12, 70 + RR.rank * 20, RR.color, 0.9 + 0.4 * RR.rank, 0.45);
    if (RR.rank >= 3) { fx('burst', pk.x, pk.y, 10, 'spark', 14, { color: RR.color }); fx('ring', pk.x, pk.y, 4, 34, 0.35, RR.color); }
  }

  // Loot tables
  function luckOf(run, player) {
    return (run && run.luck ? run.luck : 0) + ((player && player.stats && player.stats.magicFind) || 0);
  }
  function rollDrops(actor, run) {
    if (!actor || !run || actor.noLoot || actor.noDrops || actor.summoned || actor.team !== 1) return;
    const rng = HM.rng, f = run.floorIndex || 1, p = G() && G().player;
    const luck = luckOf(run, p);
    const goldMul = (1 + 0.1 * f) * (1 + ((p && p.stats && p.stats.goldFind) || 0)) * (1 + ((p && p.mods && p.mods.gold_find) || 0) * 0.3);
    const x = actor.x, y = actor.y;
    const gd = actor.goldDrop || [0, 2];
    const ang0 = p ? M.angle(p.x, p.y, x, y) : undefined; // loot tends to spill away from the killer
    if (actor.isBoss) {
      const total = Math.max(rng.int(gd[0], gd[1]), 40 + f * 14) * goldMul;
      for (let k = 0; k < 7; k++) dropGold(x, y, total / 7, { spread: 1.8, z: 30 });
      // (World also reveals a Reliquary chest once the boss falls, so the body itself drops a focused 3)
      for (let k = 0; k < 2; k++) dropItem(x, y, rollItem({ floorIndex: f + 1, heroId: run.heroId, rarityBias: 1.2 + luck, rng, rarity: k === 0 ? (rng.chance(0.25) ? 'cursed' : 'legendary') : undefined }), { spread: 1.6, z: 34 });
      dropItem(x, y, rollItem({ floorIndex: f + 1, heroId: run.heroId, slot: 'weapon', rarityBias: 1 + luck, rng }), { spread: 1.6, z: 34 });
      for (let k = 0; k < 2; k++) dropRune(x, y, null, { spread: 1.4, z: 30 });
      dropConsumable(x, y, 'pancake', { spread: 1.3 }); dropConsumable(x, y, 'tonic', { spread: 1.3 });
      fx('light', x, y, 30, 220, [1, 0.8, 0.4], 1.6, 1.2);
      return;
    }
    const gold = rng.int(gd[0], gd[1]) * goldMul * (actor.isElite ? 2.5 : 1);
    if (gold >= 1) {
      const piles = actor.isElite ? 3 : gold > 40 ? 2 : 1;
      for (let k = 0; k < piles; k++) dropGold(x, y, gold / piles, { ang: ang0 });
    }
    if (actor.isElite) {
      dropItem(x, y, rollItem({ floorIndex: f, heroId: run.heroId, rarityBias: 0.6 + luck, rng, rarity: rng.chance(0.5) ? rollRarity(f, 0.6 + luck, rng, 'magic') : undefined }), { ang: ang0 });
      if (rng.chance(0.35 + luck * 0.2)) dropItem(x, y, rollItem({ floorIndex: f, heroId: run.heroId, rarityBias: 0.3 + luck, rng }), { ang: ang0 });
      if (rng.chance(0.3)) dropRune(x, y, null, { ang: ang0 });
      if (rng.chance(0.35)) dropConsumable(x, y, 'pancake', { ang: ang0 });
      if (rng.chance(0.2)) dropConsumable(x, y, 'tonic', { ang: ang0 });
      return;
    }
    if (rng.chance((0.065 + 0.002 * f) * (1 + luck * 0.5))) dropItem(x, y, rollItem({ floorIndex: f, heroId: run.heroId, rarityBias: luck, rng }), { ang: ang0 });
    if (rng.chance(0.035)) dropConsumable(x, y, 'pancake', { ang: ang0 });
    if (rng.chance(0.025)) dropConsumable(x, y, 'tonic', { ang: ang0 });
    if (rng.chance(0.012 + 0.001 * f)) dropRune(x, y, null, { ang: ang0 });
  }

  function updatePickups(dt) {
    const Gm = G(); const list = pickups(); if (!Gm || !list) return;
    const pl = Gm.player;
    const W = HM.World;
    for (let k = list.length - 1; k >= 0; k--) {
      const pk = list[k];
      if (pk.dead) { list.splice(k, 1); continue; }
      pk.t += dt;
      if (pk.dropT > 0) pk.dropT -= dt;
      if (!pk.settled) {
        // arc + bounce
        let nx = pk.x + pk.vx * dt, ny = pk.y + pk.vy * dt;
        if (W && W.isSolid && W.isSolid(nx, ny)) { pk.vx *= -0.45; pk.vy *= -0.45; nx = pk.x; ny = pk.y; }
        pk.x = nx; pk.y = ny;
        pk.vz -= GRAV * dt; pk.z += pk.vz * dt; pk.ang += pk.spin * dt;
        if (pk.z <= 0) {
          pk.z = 0;
          if (pk.vz < -55 && pk.bounces < 3) {
            pk.vz = -pk.vz * 0.38; pk.vx *= 0.55; pk.vy *= 0.55; pk.spin *= 0.4; pk.bounces++;
            if (pk.bounces === 1) landed(pk);
          } else { pk.settled = true; pk.vx = pk.vy = pk.vz = 0; pk.spin = 0; }
        }
        continue;
      }
      // magnet: gold / consumables / runes fly to the player
      if (pk.kind !== 'item' && pl && !pl.dead && !(pk.dropT > 0)) {
        const d = M.dist(pk.x, pk.y, pl.x, pl.y);
        if (pk.magnet || d < MAGNET_R + (pl.radius || 8)) {
          pk.magnet = true;
          const sp = 160 + 520 * Math.min(1, pk.t * 0.6) + Math.max(0, 260 - d * 3);
          const a = M.angle(pk.x, pk.y, pl.x, pl.y), st = Math.min(d, sp * dt);
          pk.x += Math.cos(a) * st; pk.y += Math.sin(a) * st; pk.z = M.lerp(pk.z, 14, Math.min(1, dt * 10));
          if (d < COLLECT_R + (pl.radius || 8)) collect(pk, pl);
        }
      }
    }
    updateEffects(dt);
  }

  // --------------------------------------------------------------- pickup drawing
  let GLY = null; // lazily-built glyph tables (render LUT is ready by first draw)
  function gly() {
    if (GLY) return GLY;
    GLY = { mat: {}, pillar: R.ramp("|:'.|!:'"), dot: R.gi('.'), o: R.gi('o'), O: R.gi('O'), $: R.gi('$'), eq: R.gi('='), tilde: R.gi('~'), bang: R.gi('!'), q: R.gi("'"), star: R.gi('*'), plus: R.gi('+'), dash: R.gi('-'), at: R.gi('@'), colon: R.gi(':'), zero: R.gi('0'), deg: R.gi('°') };
    for (const k in MATERIALS) GLY.mat[k] = R.ramp(MATERIALS[k].glyphs);
    GLY.cloth = R.ramp('#%&8');
    return GLY;
  }
  // line of cycling glyphs through cells (no duplicate cells)
  function stroke(ax, ay, bx, by, glyphs, rgb, key, flags, emitK, off) {
    const dx = bx - ax, dy = by - ay;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx) / CW, Math.abs(dy) / CH) * 1.5));
    let last = -2, n = off || 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps; const i = R.idxP(ax + dx * t, ay + dy * t);
      if (i === last || i < 0) continue; last = i;
      const g = glyphs[n++ % glyphs.length];
      if (R.setI(i, g, rgb[0], rgb[1], rgb[2], key, flags) && emitK) R.emitI(i, rgb[0] * emitK, rgb[1] * emitK, rgb[2] * emitK);
    }
  }
  function sprite(px, py, lines, glyphs, rgb, key, flags, emitK) {
    let n = 0; const h = lines.length;
    for (let y = 0; y < h; y++) {
      const l = lines[y]; const cj = Math.floor(py / CH) - h + 1 + y; const ci0 = Math.floor(px / CW - l.length / 2);
      for (let x = 0; x < l.length; x++) {
        const ch = l.charCodeAt(x); if (ch === 32) continue;
        const g = ch === 35 /* # */ ? glyphs[n++ % glyphs.length] : R.gc(ch);
        const i = R.idx(ci0 + x, cj);
        const shade = ch === 35 ? 1 : 0.8;
        if (R.setI(i, g, rgb[0] * shade, rgb[1] * shade, rgb[2] * shade, key, flags) && emitK) R.emitI(i, rgb[0] * emitK, rgb[1] * emitK, rgb[2] * emitK);
      }
    }
  }
  const ARMOR_SPRITES = { plate: ['/##\\', '####', ' ## '], mail: ['/##\\', '####', ' ## '], hood: [' /#\\', '(# #)'], cloak: [' /#\\', '/###\\'], robe: [' /#\\', '/###\\', '#####'] };

  function drawItemSprite(pk, px, py, key) {
    const g = gly(); const it = pk.item;
    const RR = RARITIES[it.rarity] || RARITIES.common;
    const mat = it.material && MATERIALS[it.material];
    const base = BASES[it.baseId];
    const col = mat ? mat.color : base && base.tint ? hex(base.tint) : RR.color;
    const glyphs = mat ? g.mat[mat.id] : g.cloth;
    const lit = RR.rank >= 2 || (mat && mat.emissive > 0.25);
    const flags = lit ? R.F_UNLIT : 0;
    const em = (mat ? mat.emissive * 0.35 : 0) + (RR.rank >= 3 ? 0.18 : RR.rank === 2 ? 0.1 : 0.04);
    const br = lit ? 0.95 : 1.15;
    const c = [col[0] * br, col[1] * br, col[2] * br];
    const a = pk.ang;
    const ca = Math.cos(a), sa = Math.sin(a) * 0.75;
    const sh = [0.42, 0.36, 0.3];
    if (it.slot === 'weapon') {
      const len = it.kind === 'staff' ? 30 : it.kind === 'wand' ? 22 : it.kind === 'bass' ? 30 : 32;
      const hx = px - ca * len * 0.42, hy = py - sa * len * 0.42; // hilt end
      const tx = px + ca * len * 0.58, ty = py + sa * len * 0.58; // tip end
      if (it.kind === 'sword') {
        stroke(hx + ca * 7, hy + sa * 7, tx, ty, glyphs, c, key, flags, em);
        const gx = hx + ca * 6, gy = hy + sa * 6; // crossguard
        stroke(gx - sa * 9, gy + ca * 6, gx + sa * 9, gy - ca * 6, [g.dash, g.plus, g.dash], [0.6, 0.55, 0.48], key + 0.01, 0);
        stroke(hx - ca * 2, hy - sa * 2, gx, gy, [g.eq], sh, key, 0);
        R.set(hx - ca * 4, hy - sa * 4, g.o, 0.7, 0.62, 0.45, key, 0);
      } else if (it.kind === 'bass') {
        stroke(px - ca * 2, py - sa * 2, tx, ty, [g.eq, g.dash], [0.55, 0.42, 0.35], key, 0);
        R.ball(hx + ca * 3, hy + sa * 3, 6.5, key + 0.02, R.RAMPS.metal, c[0], c[1], c[2], flags);
        stroke(tx - sa * 7, ty + ca * 5, tx + ca * 4, ty + sa * 4, glyphs, c, key + 0.03, flags, em); // axe-blade head
      } else {
        stroke(hx, hy, tx - ca * 3, ty - sa * 3, it.kind === 'staff' ? [g.colon, g.eq] : [g.eq], [0.5, 0.38, 0.3], key, 0);
        const fl = 0.75 + 0.25 * Math.sin(R.time * 6 + pk.seed);
        const oc = [c[0] * 1.3 * fl, c[1] * 1.3 * fl, c[2] * 1.3 * fl];
        R.glowGlyph(tx, ty, it.kind === 'staff' ? g.at : g.o, oc[0], oc[1], oc[2], key + 0.04, 0.6 + em);
        stroke(tx - ca * 3, ty - sa * 3, tx, ty, glyphs, c, key + 0.03, R.F_UNLIT, em);
        R.light(pk.x, pk.y, pk.z + 6, 34, col[0], col[1], col[2], 0.35 * fl);
      }
    } else if (it.slot === 'armor') {
      sprite(px, py + CH * 0.5, ARMOR_SPRITES[it.kind] || ARMOR_SPRITES.plate, glyphs, c, key, flags, em);
    } else {
      const tw = 0.75 + 0.25 * Math.sin(R.time * 4 + pk.seed);
      const gi = R.gi(it.glyph || '*');
      R.glowGlyph(px, py, gi, c[0] * 1.2 * tw, c[1] * 1.2 * tw, c[2] * 1.2 * tw, key, 0.5 + em);
      R.set(px - CW, py, g.dot, c[0] * 0.6, c[1] * 0.6, c[2] * 0.6, key, 0);
      R.set(px + CW, py, g.dot, c[0] * 0.6, c[1] * 0.6, c[2] * 0.6, key, 0);
      if (((R.time * 1.3 + pk.seed) % 3) < 0.25) R.glowGlyph(px + CW, py - CH, g.star, 1, 1, 0.9, key + 0.1, 0.8);
    }
  }

  // Vertical light pillar for rare+ loot: white-hot core fading to rarity color, bloom haze, sparkles rising.
  function drawPillar(pk, px, py, RR) {
    const g = gly();
    const legendary = RR.rank >= 3;
    const H = legendary ? 128 : 76;
    const col = RR.color, t = R.time;
    const n = Math.floor(H / CH);
    const key = pk.y - 0.5;
    const appear = M.clamp(pk.t * 2.5, 0, 1);
    const pulse = 0.85 + 0.15 * Math.sin(t * 2.6 + pk.seed);
    const scroll = Math.floor(t * 10 + pk.seed);
    const cx = (Math.floor(px / CW) + 0.5) * CW; // snap to the item's cell column
    for (let k = 1; k <= n; k++) {
      const h01 = k / n;
      const fade = Math.pow(1 - h01, 0.85) * appear * pulse;
      const flick = 0.78 + 0.22 * Math.sin(t * 9 + k * 1.9 + pk.seed);
      const b = fade * flick * (legendary ? 1.9 : 1.4);
      if (b < 0.05) continue;
      const hot = Math.max(0, 1 - h01 * 2.2) * 0.55; // white core near the base
      const r = M.lerp(col[0], 1, hot) * b, gg = M.lerp(col[1], 1, hot) * b, bb = M.lerp(col[2], 0.95, hot) * b;
      const sp = (k + scroll) % 7; // a sparkle travelling up the beam
      const gi = sp === 0 ? g.star : sp === 3 ? g.q : h01 > 0.7 ? g.colon : g.pillar[0];
      const yy = py - k * CH;
      const i = R.idxP(cx, yy);
      const e = legendary ? 0.95 : 0.7;
      if (R.setI(i, gi, r, gg, bb, key, R.F_UNLIT)) R.emitI(i, r * e, gg * e, bb * e);
      else R.emitI(i, r * e * 0.5, gg * e * 0.5, bb * e * 0.5); // occluded by something in front: still glows through
      const side = legendary ? 0.3 : 0.2;
      R.emit(cx - CW, yy, col[0] * b * side, col[1] * b * side, col[2] * b * side);
      R.emit(cx + CW, yy, col[0] * b * side, col[1] * b * side, col[2] * b * side);
      if (legendary && k < n * 0.7) {
        R.emit(cx - 2 * CW, yy, col[0] * b * 0.1, col[1] * b * 0.1, col[2] * b * 0.1);
        R.emit(cx + 2 * CW, yy, col[0] * b * 0.1, col[1] * b * 0.1, col[2] * b * 0.1);
      }
    }
    // motes drifting up around the beam
    const motes = legendary ? 5 : 3;
    for (let m = 0; m < motes; m++) {
      const ph = ((t * (0.35 + m * 0.07) + m / motes + (pk.seed % 97) * 0.01) % 1);
      const mx = cx + Math.sin(ph * 7 + m * 2.1 + pk.seed) * (7 + m * 3), my = py - ph * H * 0.95;
      const b = Math.sin(ph * Math.PI) * appear;
      R.glowGlyph(mx, my, m % 2 ? g.dot : g.q, col[0] * b * 1.4, col[1] * b * 1.4, col[2] * b * 1.4, key + 0.1, 0.7);
    }
    // ground glow ring
    const rr = legendary ? 16 : 12;
    R.ring(pk.x, pk.y, rr, 4, (i, u, ci, cj, ang) => {
      const b = (0.3 + 0.2 * Math.sin(t * 3 + ang * 3)) * appear;
      if (R.key[i] <= R.KEY_DECAL) R.setI(i, g.dot, col[0] * b, col[1] * b, col[2] * b, R.KEY_DECAL + 2, R.F_UNLIT);
      R.emitI(i, col[0] * b * 0.08, col[1] * b * 0.08, col[2] * b * 0.08);
    });
    R.light(pk.x, pk.y, 8, legendary ? 95 : 62, col[0], col[1], col[2], (legendary ? 0.6 : 0.36) * appear * pulse);
  }

  function drawPickups() {
    const list = pickups(); if (!list || !list.length) return;
    const g = gly(); const t = R.time;
    for (const pk of list) {
      if (pk.dead || !R.inViewWorld(pk.x, pk.y, 140)) continue;
      const q = R.proj(pk.x, pk.y, pk.z);
      const px = q[0], py = q[1];
      const key = pk.y + 0.3;
      // blob shadow (shrinks while airborne)
      const sz = pk.kind === 'item' ? 9 : 4;
      R.shadowEllipse(pk.x, pk.y, sz * (1 - Math.min(0.6, pk.z / 60)), sz * 0.55, 0.45);
      if (pk.kind === 'item') {
        const RR = RARITIES[pk.item.rarity] || RARITIES.common;
        if (RR.rank >= 2 && pk.settled) drawPillar(pk, px, py, RR);
        drawItemSprite(pk, px, py, key);
      } else if (pk.kind === 'gold') {
        const nG = M.clamp(1 + Math.floor(pk.amount / 12), 1, 4);
        for (let k = 0; k < nG; k++) {
          const h = M.hash2(pk.seed + k, k * 7);
          const ox = (k === 0 ? 0 : (h - 0.5) * 12), oy = k === 0 ? 0 : (M.hash2(k, pk.seed) - 0.5) * 6;
          const gl = k === 0 ? g.$ : h < 0.5 ? g.o : g.zero;
          R.glowGlyph(px + ox, py + oy, gl, 1.0, 0.78, 0.25, key + k * 0.01, 0.22);
        }
        if (((t * 1.7 + pk.seed * 0.37) % 2.4) < 0.18) R.glowGlyph(px + CW, py - CH * 0.6, g.star, 1.2, 1.1, 0.7, key + 0.2, 0.9);
      } else if (pk.kind === 'pancake') {
        R.set(px, py, g.eq, 0.92, 0.66, 0.36, key, 0);
        R.set(px, py - CH, g.eq, 0.98, 0.76, 0.44, key + 0.01, 0);
        R.set(px + CW, py - CH, g.tilde, 0.9, 0.3, 0.25, key + 0.02, 0);
        R.emit(px, py, 0.08, 0.05, 0.02);
      } else if (pk.kind === 'tonic') {
        const b = 0.8 + 0.2 * Math.sin(t * 5 + pk.seed);
        R.glowGlyph(px, py, g.zero, 0.45 * b, 0.7 * b, 1.1 * b, key, 0.5);
        R.set(px, py - CH, g.q, 0.75, 0.6, 0.45, key + 0.01, 0);
        R.light(pk.x, pk.y, pk.z + 4, 26, 0.4, 0.6, 1, 0.3);
      } else if (pk.kind === 'rune') {
        const ru = RUNES[pk.runeId]; if (!ru) continue;
        const b = 0.85 + 0.25 * Math.sin(t * 4 + pk.seed);
        R.glowGlyph(px, py - 2, R.gi(ru.glyph), ru.color[0] * 1.3 * b, ru.color[1] * 1.3 * b, ru.color[2] * 1.3 * b, key, 0.8);
        if (pk.settled) R.ring(pk.x, pk.y, 9, 3, (i, u, ci, cj, ang) => { if (R.key[i] <= R.KEY_DECAL) R.setI(i, g.dot, ru.color[0] * 0.4 * b, ru.color[1] * 0.4 * b, ru.color[2] * 0.4 * b, R.KEY_DECAL + 1, R.F_UNLIT); });
        R.light(pk.x, pk.y, pk.z + 4, 30, ru.color[0], ru.color[1], ru.color[2], 0.35);
      }
    }
    // Prophetic Dream ready: a pale eye above the hero's head
    const p = G() && G().player;
    if (p && !p.dead && p._owlReady) {
      const q = R.proj(p.x, p.y, (p.height || 60) + 22);
      const b = 0.8 + 0.2 * Math.sin(t * 5);
      R.glowGlyph(q[0], q[1], g.deg, 0.7 * b, 0.85 * b, 1.2 * b, R.KEY_TOP - 10, 0.7);
    }
  }

  // Canvas2D ground labels (UI may call this, or draw its own from Game.pickups[].label/labelColor)
  function drawLabels(ctx, opts) {
    const list = pickups(); if (!ctx || !list) return;
    opts = opts || {};
    const tgt = G() && G().interactTarget;
    const placed = [];
    ctx.save();
    ctx.font = (opts.font || '11px Menlo, Consolas, monospace');
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const lab = (pk) => pk.label || (opts.gold && pk.goldLabel) || '';
    const sorted = list.filter((pk) => !pk.dead && lab(pk) && !pk.magnet && R.inViewWorld(pk.x, pk.y, 20)).sort((a, b) => b.y - a.y);
    for (const pk of sorted) {
      const text = lab(pk);
      const [sx, sy0] = R.worldToScreen(pk.x, pk.y, pk.z + (pk.kind === 'item' ? 18 : 12));
      const w = ctx.measureText(text).width + 8; let sy = sy0;
      for (let it = 0; it < 6; it++) { const hit = placed.find((r) => Math.abs(r.x - sx) < (r.w + w) / 2 && Math.abs(r.y - sy) < 13); if (!hit) break; sy = hit.y - 14; }
      placed.push({ x: sx, y: sy, w });
      const focus = pk === tgt;
      ctx.fillStyle = focus ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.55)';
      ctx.fillRect(sx - w / 2, sy - 12, w, 13);
      if (focus) { ctx.strokeStyle = pk.labelColor; ctx.lineWidth = 1; ctx.strokeRect(sx - w / 2 + 0.5, sy - 11.5, w - 1, 12); }
      ctx.fillStyle = pk.labelColor; ctx.fillText(text, sx, sy);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // floor population, chests, shrines, merchant
  // ---------------------------------------------------------------------------
  const SHRINES = {
    glob: { name: 'Shrine of Glob', hex: '#9fe8ff', desc: 'Glob mends what the dark has torn.' },
    grob: { name: 'Shrine of Grob', hex: '#ffd36a', desc: 'Grob offers a choice. Choices are heavy.' },
    gob:  { name: 'Shrine of Gob',  hex: '#c08aff', desc: 'Gob lends a blessing until the floor ends.' },
  };
  const BLESSINGS = {
    gob_fury:   { name: 'Gob\'s Fury',     desc: '+25% damage this floor.',                    apply: (p) => { p.stats.dmgMul *= 1.25; } },
    gob_swift:  { name: 'Gob\'s Haste',    desc: '+15% move, attack and cast speed this floor.', apply: (p) => { p.stats.moveMul *= 1.15; p.stats.atkSpeed *= 1.15; p.stats.castSpeed *= 1.15; } },
    gob_ward:   { name: 'Gob\'s Ward',     desc: '+30 armor and +15% resistances this floor.', apply: (p) => { p.stats.armor += 30; for (const k in p.stats.res) p.stats.res[k] += 0.15; } },
    gob_hunger: { name: 'Gob\'s Hunger',   desc: '+5% life leech this floor.',                 apply: (p) => { p.stats.leech += 0.05; } },
    gob_eye:    { name: 'Gob\'s Third Eye', desc: '+12% crit chance and +30% crit damage this floor.', apply: (p) => { p.stats.critChance += 0.12; p.stats.critMult += 0.3; } },
  };
  const CHEST_TIERS = {
    wooden: { label: 'Open Chest', items: [1, 2], bias: 0.2, gold: [8, 18] },
    gilded: { label: 'Open Gilded Chest', items: [2, 3], bias: 0.8, gold: [20, 40] },
    bone:   { label: 'Open Bone Chest', items: [1, 1], bias: 0.5, gold: [10, 20], cursed: true },
    reliquary: { label: 'Open the Reliquary', items: [3, 4], bias: 1.4, gold: [60, 100], runes: 2, minRarity: 'rare' }, // boss reward
  };

  function populate(floor, run) {
    if (!floor) return;
    const rng = new HM.RNG(((floor.seed || 1) ^ 0x1735) >>> 0);
    for (const o of floor.interactables || []) {
      if (o.kind === 'shrine') {
        if (!o.variant || !SHRINES[o.variant]) o.variant = rng.weighted(['glob', 'grob', 'gob'], (v) => ({ glob: 4, grob: 2.2, gob: 3.5 }[v]));
        // World names shrines per realm ("Sugar Altar", "Frost Cairn"…); the god behind it decides the gift.
        const god = SHRINES[o.variant].name.replace('Shrine of ', '');
        const wn = o.name && !/^Shrine of /.test(o.name) ? o.name + ' of ' + god : SHRINES[o.variant].name;
        o.name = wn; o.label = 'Pray at the ' + wn; o.prompt = o.label;
        o.color = hex(SHRINES[o.variant].hex);
      } else if (o.kind === 'chest') {
        if (!o.tier || !CHEST_TIERS[o.tier]) {
          o.tier = o.reward ? 'reliquary' : o.rare ? 'gilded' : rng.weighted(['wooden', 'gilded', 'bone'], (t) => ({ wooden: 72, gilded: 20, bone: (run && run.floorIndex >= 3) ? 8 : 0 }[t]));
        }
        if (o.tier === 'gilded') o.rare = true; // World draws rare chests with gold banding
        if (!o.label || o.label === 'chest' || o.label === 'Open Chest') o.label = CHEST_TIERS[o.tier].label;
        o.prompt = o.label;
      } else if (o.kind === 'merchant') {
        if (!o.label || o.label === 'merchant') o.label = 'Trade with Choose Goose';
        o.prompt = 'Trade with Choose Goose';
      }
    }
    // a few loose spoils scattered across non-boss floors (exploration reward)
    if (!floor.isBoss && HM.World && HM.World.randomOpenPoint && pickups()) {
      const n = rng.int(2, 4);
      for (let k = 0; k < n; k++) {
        const pt = HM.World.randomOpenPoint(rng, floor, floor.start.x, floor.start.y, 260, 3000);
        if (!pt) continue;
        const f = run ? run.floorIndex : 1;
        const pk = dropGold(pt[0], pt[1], rng.int(4, 9) + f * 2, { pop: 0 });
        if (pk) pk.settled = true;
      }
      if (rng.chance(0.35)) { const pt = HM.World.randomOpenPoint(rng, floor, floor.start.x, floor.start.y, 300, 3000); if (pt) dropConsumable(pt[0], pt[1], rng.chance(0.65) ? 'pancake' : 'tonic', { pop: 0 }); }
    }
  }

  HM.Interact.chest = function (obj, player) {
    if (obj.used || obj.open) return;
    const Gm = G(); const run = runOf(player); if (!run) return;
    obj.open = true; obj.used = true; obj.openT = Gm ? Gm.t : 0;
    const tier = CHEST_TIERS[obj.tier] || CHEST_TIERS.wooden;
    play('chest', { x: obj.x, y: obj.y });
    fx('burst', obj.x, obj.y, 14, 'dust', 10);
    fx('light', obj.x, obj.y, 16, 90, obj.tier === 'bone' ? [0.9, 0.2, 0.3] : [1, 0.8, 0.45], 1.2, 0.6);
    const spill = () => {
      const rng = HM.rng, f = run.floorIndex || 1, luck = luckOf(run, player);
      const ang = M.angle(obj.x, obj.y, player.x, player.y);
      const n = rng.int(tier.items[0], tier.items[1]);
      for (let k = 0; k < n; k++) {
        const rar = tier.cursed && k === 0 ? 'cursed' : tier.minRarity ? rollRarity(f + 1, tier.bias + luck, rng, tier.minRarity) : undefined;
        const it = rollItem({ floorIndex: f, heroId: run.heroId, rarityBias: tier.bias + luck, rng, rarity: rar, slot: k === 0 && rng.chance(0.4) ? 'weapon' : undefined });
        dropItem(obj.x, obj.y, it, { ang: tier.runes ? undefined : ang, z: 16, spread: tier.runes ? 1.4 : 0.9 });
      }
      for (let k = 0; k < (tier.runes || 0); k++) dropRune(obj.x, obj.y, null, { z: 16, spread: 1.2 });
      const gold = rng.int(tier.gold[0], tier.gold[1]) * (1 + 0.12 * f);
      for (let k = 0; k < 2; k++) dropGold(obj.x, obj.y, gold / 2, { ang, z: 14 });
      if (rng.chance(0.35)) dropConsumable(obj.x, obj.y, rng.chance(0.6) ? 'pancake' : 'tonic', { ang, z: 14 });
      if (rng.chance(obj.tier === 'gilded' ? 0.6 : 0.2)) dropRune(obj.x, obj.y, null, { ang, z: 14 });
      fx('burst', obj.x, obj.y, 18, 'gold', 12);
    };
    if (Gm && Gm.after) Gm.after(0.22, spill); else spill();
  };

  HM.Interact.shrine = function (obj, player) {
    if (obj.used) return;
    const run = runOf(player); if (!run) return;
    if (!obj.variant || !SHRINES[obj.variant]) obj.variant = HM.rng.pick(['glob', 'grob', 'gob']);
    const S = SHRINES[obj.variant]; const col = hex(S.hex); const title = obj.name || S.name;
    obj.used = true; obj.spent = true; obj.lit = false;
    play('shrine', { x: obj.x, y: obj.y });
    fx('burst', obj.x, obj.y, 30, 'holy', 24, { color: col });
    fx('ring', obj.x, obj.y, 6, 80, 0.6, col);
    fx('light', obj.x, obj.y, 30, 160, col, 1.6, 1.0);
    if (obj.variant === 'glob') {
      const amt = player.maxHp - player.hp;
      if (HM.Combat && HM.Combat.heal) HM.Combat.heal(player, amt); else player.hp = player.maxHp;
      if (player.maxMp > 0) player.mp = player.maxMp;
      toast(title + ' — Glob mends you. Your wounds close.', S.hex, 2.6);
    } else if (obj.variant === 'grob') {
      run.boonPoints = (run.boonPoints || 0) + 1;
      toast(title + ' — Grob offers a choice: +1 boon point when you descend.', S.hex, 3);
    } else {
      const ids = Object.keys(BLESSINGS);
      const id = HM.rng.pick(ids);
      run.floorBuff = { id, floorIndex: run.floorIndex };
      refreshPlayer();
      toast(title + ' — ' + BLESSINGS[id].name + ': ' + BLESSINGS[id].desc, S.hex, 3.2);
    }
    HM.Events.emit('shrine', { variant: obj.variant, obj, run });
  };

  const GOOSE_LINES = [
    'Choose Goose: "Honk. Gold for goods, goods for gold. Nobody leaves even."',
    'Choose Goose: "A fine pick. The last one who bought it is fine too. Mostly."',
    'Choose Goose: "Spend it now. The Lich won\'t let you keep it."',
    'Choose Goose: "Feathers for feathers. Pleasure doing business."',
    'Choose Goose: "No refunds. No regrets. Some regrets."',
  ];
  const GOOSE_HELLO = [
    'Choose Goose ruffles a coat sewn from other people\'s pockets. "Browse. Buy. Be gone."',
    '"Honk. The world is ending, so everything is on sale."',
    '"You again? Good. The dead don\'t tip."',
  ];
  function priceMul(run) {
    const lv = (run && run.heirlooms && run.heirlooms.goose_coupon) || 0;
    let m = 1 - 0.1 * lv;
    if (run && run.boons && run.boons.includes('curse_poor')) m *= 1.25;
    return Math.max(0.4, m);
  }
  function shopStock(run) {
    if (!run) return [];
    if (run.shop && run.shop.floorIndex === run.floorIndex && Array.isArray(run.shop.stock)) return run.shop.stock;
    const rng = new HM.RNG(((run.seed || 1) ^ Math.imul(run.floorIndex || 1, 2654435761) ^ 0x6005e) >>> 0);
    const f = run.floorIndex || 1, pm = priceMul(run), luck = run.luck || 0;
    const stock = [];
    const addItem = (it, mul) => stock.push({ kind: 'item', item: it, name: it.name, color: RARITIES[it.rarity].hex, desc: '', price: Math.round(it.value * 2.2 * (mul || 1) * pm), sold: false });
    addItem(rollItem({ floorIndex: f + 1, heroId: run.heroId, slot: 'weapon', rarity: rollRarity(f + 1, 0.4 + luck, rng, 'magic'), rng }));
    addItem(rollItem({ floorIndex: f + 1, heroId: run.heroId, slot: 'armor', rarity: rollRarity(f + 1, 0.2 + luck, rng, 'magic'), rng }));
    addItem(rollItem({ floorIndex: f + 1, heroId: run.heroId, slot: 'trinket', rarity: rollRarity(f + 1, 0.2 + luck, rng, 'magic'), rng }));
    addItem(rollItem({ floorIndex: f + 2, heroId: run.heroId, rarity: rollRarity(f + 2, 1.2 + luck, rng, 'rare'), rng }), 1.15);
    for (let k = 0; k < 2; k++) { const rid = rng.pick(RUNE_IDS); const ru = RUNES[rid]; stock.push({ kind: 'rune', runeId: rid, name: ru.name + ' ' + ru.glyph, color: ru.hex, desc: ru.desc, price: Math.round((45 + f * 6) * pm), sold: false }); }
    stock.push({ kind: 'pancake', name: 'Bacon Pancakes', color: '#e8b070', desc: 'Heals 35% of max life over 2 s. [' + ((HM.Input && HM.Input.actionLabel) ? HM.Input.actionLabel('potion1') : '1') + ']', price: Math.round((22 + f * 3) * pm), qty: 3, sold: false });
    stock.push({ kind: 'tonic', name: 'Tonic', color: '#7fb4ff', desc: 'Restores your resource.', price: Math.round((16 + f * 2) * pm), qty: 2, sold: false });
    stock.push({ kind: 'boon', name: 'Golden Goose Egg', color: '#ffd36a', desc: '+1 boon point. Hatches into a choice when you descend.', price: Math.round((150 + f * 18) * pm), sold: false });
    run.shop = { floorIndex: run.floorIndex, stock };
    return stock;
  }
  function buy(run, index) {
    const stock = shopStock(run); const e = stock[index];
    if (!e) return { ok: false, error: 'Nothing there.' };
    if (e.sold) return { ok: false, error: 'Sold out.' };
    if ((run.gold || 0) < e.price) { play('ui_error'); return { ok: false, error: 'Not enough gold. Honk.' }; }
    const I = inv(run);
    if (e.kind === 'item') {
      if (!I.equipped[e.item.slot] && canUse(run, e.item)) { I.equipped[e.item.slot] = e.item; refreshPlayer(); }
      else if (I.bag.length < BAG_CAP) I.bag.push(e.item);
      else { play('ui_error'); return { ok: false, error: 'Your pack is full.' }; }
      e.sold = true;
    } else if (e.kind === 'rune') { I.runes[e.runeId] = (I.runes[e.runeId] || 0) + 1; e.sold = true; }
    else if (e.kind === 'pancake' || e.kind === 'tonic') {
      const c = run.consumables || (run.consumables = { pancake: 0, tonic: 0 });
      if ((c[e.kind] || 0) >= 9) { play('ui_error'); return { ok: false, error: 'You can\'t carry more.' }; }
      c[e.kind] = (c[e.kind] || 0) + 1; e.qty = (e.qty || 1) - 1; if (e.qty <= 0) e.sold = true;
    } else if (e.kind === 'boon') { run.boonPoints = (run.boonPoints || 0) + 1; e.sold = true; }
    run.gold -= e.price;
    HM.Events.emit('gold', { amount: -e.price });
    // the shop UI plays the sound / toast; hand it a goose line to show
    return { ok: true, entry: e, line: GOOSE_LINES[Math.floor(Math.random() * GOOSE_LINES.length)] };
  }
  HM.Interact.merchant = function (obj, player) {
    const run = runOf(player); if (!run) return;
    const stock = shopStock(run);
    play('ui_select'); play('wenk', { x: obj.x, y: obj.y, pitch: 0.7, vol: 0.5 });
    if (G() && G().setState) G().setState('shop', { stock, merchant: obj, greeting: GOOSE_HELLO[Math.floor(Math.random() * GOOSE_HELLO.length)], gold: run.gold });
  };

  // ---------------------------------------------------------------------------
  // combat hooks: rune damage/procs, item powers, internal boon effects
  // ---------------------------------------------------------------------------
  const weaponAvg = (p) => (p.weaponDmg ? (p.weaponDmg[0] + p.weaponDmg[1]) / 2 : 6);
  const has = (p, power) => p.itemPowers && p.itemPowers.indexOf(power) >= 0;
  const isUndead = (t) => !!(t && ((t.tags && (t.tags.includes('undead') || t.tags.includes('bone'))) || /thrall|archer|knight|priest|wraith|boneDragon|lich|skeleton/i.test(t.defId || '')));
  const PROC = ['proc'];

  // re-enter the damage pipeline with a pre-multiplied amount (undo the source multipliers so nothing double-dips)
  function procDamage(target, src, amount, type, extra) {
    if (!target || target.dead || !HM.Combat) return null;
    const st = src.stats; const pre = Math.max(0.05, (st.dmgMul || 1) * ((st.elemMul && st.elemMul[type]) || 1));
    return HM.Combat.damage(target, Object.assign({ amount: amount / pre, type, source: src, isDot: true, canCrit: false, tags: ['rune'], numColor: type }, extra || {}));
  }

  function onPlayerHit(p, t, info) {
    const avg = weaponAvg(p);
    const adds = p.runeAdds, procs = p.runeProcs;
    p._hitN = (p._hitN || 0) + 1;
    // runes: % of the hit as elemental damage
    if (adds) {
      for (const el in adds) {
        if (t.dead) break;
        let amt = info.amount * adds[el];
        if (amt < 0.3) continue;
        if (el === 'lightning') {
          procDamage(t, p, amt, 'holy', { numColor: 'holy' });
        } else {
          if (el === 'holy' && isUndead(t)) amt *= 1.5;
          procDamage(t, p, amt, el);
        }
      }
    }
    if (procs && !t.dead) {
      const C = HM.Combat;
      if (procs.burn && Math.random() < procs.burn) C.applyStatus(t, 'burn', { dur: 3, dps: avg * 0.18, src: p });
      if (procs.chill && Math.random() < procs.chill) C.applyStatus(t, 'chill', { dur: 1.6, src: p });
      if (procs.poison && Math.random() < procs.poison) C.applyStatus(t, 'poison', { dur: 4, dps: avg * 0.07, stacks: 1, src: p });
      if (procs.bleed && Math.random() < procs.bleed) C.applyStatus(t, 'bleed', { dur: 3, dps: avg * 0.09, stacks: 1, src: p });
      if (procs.chain && Math.random() < procs.chain) {
        const o = C.nearestHostile(t.x, t.y, p.team, 120, (a) => a !== t);
        if (o) {
          procDamage(o, p, info.amount * 0.45, 'holy', { numColor: 'holy' });
          fx('beam', t.x, t.y, o.x, o.y, { w: 2, color: [1, 0.92, 0.4], dur: 0.14, glyphs: 'zZ~' });
          play('hit_holy', { x: o.x, y: o.y, vol: 0.5 });
        }
      }
    }
    // item powers
    if (!t.dead) {
      if (has(p, 'thirst') && Math.random() < 0.15) HM.Combat.applyStatus(t, 'bleed', { dur: 3, dps: avg * 0.1, src: p });
      if (has(p, 'grass_curse')) {
        HM.Combat.applyStatus(t, 'poison', { dur: 4, dps: avg * 0.08, stacks: 2, src: p });
        if (Math.random() < 0.12) { HM.Combat.applyStatus(t, 'stun', { dur: 0.5, src: p }); fx('burst', t.x, t.y, 6, 'poison', 8, { color: [0.4, 0.9, 0.4] }); }
      }
      if (has(p, 'hellstring') && Math.random() < 0.2) HM.Combat.applyStatus(t, 'weaken', { dur: 3, src: p });
      if (has(p, 'brimstone')) HM.Combat.applyStatus(t, 'burn', { dur: 3, dps: avg * 0.14, src: p });
      if (has(p, 'crown_whisper') && Math.random() < 0.25) HM.Combat.applyStatus(t, 'chill', { dur: 1.5, src: p });
      if (p.mods && p.mods.b_chill && Math.random() < 0.2) HM.Combat.applyStatus(t, 'chill', { dur: 1.5, src: p });
      if (p.mods && p.mods.b_weaken && Math.random() < 0.15) HM.Combat.applyStatus(t, 'weaken', { dur: 3, src: p });
    }
    if (has(p, 'abadeer_heir') && p.hp01 < 0.5 && p.stats.leech > 0) p.hp = Math.min(p.maxHp, p.hp + info.amount * p.stats.leech);
    if (has(p, 'ruinsong') && p._hitN % 5 === 0) {
      HM.Combat.hitCircle(t.x, t.y, 70, p.team, { amount: avg * 0.6, type: 'shadow', source: p, knock: 180, tags: PROC, hitstop: 0.02 });
      fx('ring', t.x, t.y, 8, 74, 0.35, [0.75, 0.45, 1]); fx('burst', t.x, t.y, 20, 'shadow', 14);
      play('sonic', { x: t.x, y: t.y });
    }
    if (info.crit) {
      if (has(p, 'crystal_shards')) {
        const a0 = M.angle(p.x, p.y, t.x, t.y);
        for (let k = -1; k <= 1; k++) {
          const a = a0 + k * 0.45;
          const pr = HM.Combat.projectile({ x: t.x, y: t.y, z: 22, vx: Math.cos(a) * 320, vy: Math.sin(a) * 320, r: 6, team: p.team, life: 0.55, pierce: 1, look: 'ice', color: [0.45, 0.95, 1], source: p, damage: { amount: avg * 0.35, type: 'ice', source: p, canCrit: false, knock: 60, tags: PROC }, light: [40, 0.4, 0.9, 1] });
          if (pr) pr.hit.add(t.id);
        }
        play('shatter', { x: t.x, y: t.y, vol: 0.6 });
      }
      if (has(p, 'flash_fire')) {
        HM.Combat.hitCircle(t.x, t.y, 38, p.team, { amount: avg * 0.5, type: 'fire', source: p, knock: 80, tags: PROC, status: { id: 'burn', dur: 2, dps: avg * 0.12 } });
        HM.Combat.igniteAt && HM.Combat.igniteAt(t.x, t.y, 38, p);
        fx('explosion', t.x, t.y, 38, 'fire');
      }
    }
  }

  function onPlayerKill(p, t, info) {
    const avg = weaponAvg(p);
    if (has(p, 'thirst')) HM.Combat.heal(p, p.maxHp * 0.03);
    if (has(p, 'bat_swarm')) {
      for (let k = 0; k < 2; k++) {
        const tgt = HM.Combat.nearestHostile(t.x, t.y, p.team, 320, (a) => a !== t);
        const a = HM.rng.range(0, Math.PI * 2);
        HM.Combat.projectile({ x: t.x, y: t.y, z: 30, vx: Math.cos(a) * 200, vy: Math.sin(a) * 200, r: 7, team: p.team, life: 2.4, look: 'bat', color: [0.6, 0.35, 0.9], source: p, homing: tgt ? { target: tgt, turn: 6 } : null, damage: { amount: avg * 0.45, type: 'shadow', source: p, canCrit: false, knock: 40, tags: PROC } });
      }
      play('bat', { x: t.x, y: t.y, vol: 0.6 });
    }
    if (has(p, 'ember_wake')) {
      HM.Combat.hitCircle(t.x, t.y, 46, p.team, { amount: avg * 0.7, type: 'fire', source: p, knock: 120, tags: PROC, status: { id: 'burn', dur: 3, dps: avg * 0.15 } });
      HM.Combat.igniteAt && HM.Combat.igniteAt(t.x, t.y, 46, p);
      fx('explosion', t.x, t.y, 46, 'fire'); play('explode', { x: t.x, y: t.y, vol: 0.5 });
    }
    if (has(p, 'billy_grip')) {
      p._killN = (p._killN || 0) + 1;
      if (p._killN % 8 === 0) { HM.Combat.applyStatus(p, 'haste', { dur: 4 }); fx('text', p.x, p.y, (p.height || 60) + 16, 'HERO\'S GRIP', [1, 0.85, 0.4], 0.9); }
    }
  }

  function onPlayerHurt(p, info) {
    if (info.isDot || !(info.dealt > 0)) return;
    const src = info.source;
    if (has(p, 'glacial_heart') && src && src !== p && !src.dead && src.team !== p.team && Math.random() < 0.3) HM.Combat.applyStatus(src, 'chill', { dur: 2, src: p });
    if (has(p, 'locket') && !p._locketUsed && p.hp > 0 && p.hp01 < 0.3) {
      p._locketUsed = true;
      HM.Combat.applyStatus(p, 'shield', { dur: 8, amount: p.maxHp * 0.2 });
      fx('burst', p.x, p.y, 30, 'holy', 16, { color: [1, 0.55, 0.85] });
      toast('The locket remembers her. A shield of pink light holds.', '#ff8ad8', 2.6);
      play('shrine', { pitch: 1.4, vol: 0.6 });
    }
    const gv = p.mods && p.mods.b_ghost;
    if (gv && HM.Game) {
      const now = HM.Game.t, cd = 8 / gv;
      if (now - (p._ghostT === undefined ? -99 : p._ghostT) >= cd) { p._ghostT = now; p.iframeT = Math.max(p.iframeT || 0, 0.5); fx('ghost', p, 0.5); }
    }
  }

  HM.Events.on('damage', (info) => {
    const src = info.source, t = info.target;
    if (!t) return;
    if (t.kind === 'player') { if (src !== t) onPlayerHurt(t, info); return; }
    if (!src || src.kind !== 'player' || src.dead || info.isDot || info.evaded) return;
    if (info.tags && (info.tags.indexOf('rune') >= 0 || info.tags.indexOf('proc') >= 0 || info.tags.indexOf('thorns') >= 0)) return;
    onPlayerHit(src, t, info);
  });
  HM.Events.on('preDamage', (info) => {
    const p = info.source, t = info.target;
    if (!p || p.kind !== 'player' || !t || t === p || info.isDot) return;
    let m = 1;
    if (has(p, 'valor') && p.hp01 > 0.8) m *= 1.25;
    if (has(p, 'night_edge') && t.hp01 < 0.3) m *= 1.35;
    if (has(p, 'last_stand') && p.hp01 < 0.3) m *= 1.3;
    const mods = p.mods || {};
    if (mods.b_huntress && (t.isElite || t.isBoss)) m *= 1 + 0.25 * mods.b_huntress;
    if (mods.b_waltz && p.hp01 < 0.4) m *= 1.4;
    info.amount *= m;
    if (p._owlReady && info.spec && info.tags.indexOf('rune') < 0 && info.tags.indexOf('proc') < 0) { info.spec.crit = true; p._owlReady = false; p._owlT = 0; }
  });
  HM.Events.on('kill', (e) => {
    const t = e.target, src = e.source;
    if (!t || !src || src.kind !== 'player' || t.team === src.team) return;
    if (e.info && e.info.tags && e.info.tags.indexOf('proc') >= 0) return; // no chain reactions from proc kills
    onPlayerKill(src, t, e.info);
  });
  HM.Events.on('floorStart', () => { hots.length = 0; });

  // per-frame effects (called from updatePickups → only while playing)
  function updateEffects(dt) {
    for (let k = hots.length - 1; k >= 0; k--) {
      const h = hots[k]; const d = Math.min(dt, h.left); h.left -= dt;
      if (h.target.dead) { hots.splice(k, 1); continue; }
      if (HM.Combat && HM.Combat.heal) HM.Combat.heal(h.target, h.rate * d, { silent: true }); else h.target.hp = Math.min(h.target.maxHp, h.target.hp + h.rate * d);
      if (h.left <= 0) hots.splice(k, 1);
    }
    const p = G() && G().player; if (!p || p.dead || !dt) return;
    const mods = p.mods || {};
    // Prophetic Dream (boon and/or Feather of the Cosmic Owl)
    const owl = (mods.b_owl || 0) + (has(p, 'owl_dream') ? 1 : 0);
    if (owl > 0 && !p._owlReady) {
      p._owlT = (p._owlT || 0) + dt;
      if (p._owlT >= Math.max(3, 8 - owl * 1.5)) { p._owlReady = true; fx('burst', p.x, p.y, (p.height || 60) + 16, 'holy', 4, { color: [0.7, 0.85, 1] }); }
    }
    // NEPTR pies
    if (mods.b_neptr) {
      p._pieT = (p._pieT || 0) + dt;
      const every = Math.max(2.2, 4.6 - 0.7 * mods.b_neptr);
      if (p._pieT >= every) {
        const tgt = HM.Combat.nearestHostile(p.x, p.y, p.team, 280);
        if (tgt) { p._pieT = 0; throwPie(p, tgt, mods.b_neptr); } else p._pieT = every * 0.8;
      }
    }
    // the Crown Shard whispers
    if (has(p, 'crown_whisper')) {
      p._crownT = (p._crownT || 0) + dt;
      if (p._crownT > 28) {
        p._crownT = 0;
        HM.Combat.applyStatus(p, 'chill', { dur: 1.6 });
        fx('burst', p.x, p.y, 40, 'ice', 12);
        toast('The crown whispers. You forget, for a moment, who you are.', '#6ff0ff', 2.6);
      }
    }
  }

  function throwPie(p, tgt, lvl) {
    const avg = weaponAvg(p);
    const z0 = 34, d = M.dist(p.x, p.y, tgt.x, tgt.y), sp = 300, tt = Math.max(0.15, d / sp);
    const a = M.angle(p.x, p.y, tgt.x, tgt.y);
    HM.Combat.projectile({
      x: p.x, y: p.y, z: z0, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: (14 - z0) / tt + 0.5 * 300 * tt, gravity: 300, r: 8, team: p.team, life: tt + 0.6,
      source: p, look: 'sugar', color: [0.95, 0.75, 0.45],
      damage: { amount: avg * 0.6 + 6 * lvl, type: 'phys', source: p, canCrit: true, knock: 170, tags: PROC },
      onHit: (t2, pr) => { fx('burst', pr.x, pr.y, pr.z, 'sugar', 12, { color: [0.95, 0.8, 0.55] }); play('hit', { x: pr.x, y: pr.y, pitch: 1.6, vol: 0.5 }); },
      onGround: (pr) => fx('burst', pr.x, pr.y, 2, 'sugar', 8, { color: [0.95, 0.8, 0.55] }),
      draw: (pr) => {
        const q = R.proj(pr.x, pr.y, pr.z);
        R.glowGlyph(q[0], q[1], R.gi('@'), 0.98, 0.78, 0.48, pr.y + 1, 0.25);
        R.set(q[0], q[1] - CH, R.gi('~'), 1, 0.95, 0.85, pr.y + 1.01, R.F_UNLIT);
        R.shadowEllipse(pr.x, pr.y, 5, 3, 0.35);
      },
    });
    play('swing', { x: p.x, y: p.y, pitch: 1.5, vol: 0.5 });
  }

  // ---------------------------------------------------------------------------
  // HM.Items
  // ---------------------------------------------------------------------------
  HM.Items = {
    MATERIALS, RUNES, RUNE_IDS, RARITIES, RARITY_ORDER, BASES, MODS, POWERS, SHRINES, BLESSINGS, CHEST_TIERS, BAG_CAP,
    newInventory, rollItem, rollRarity, rarityWeights, rollDrops, dropItem, dropGold, dropConsumable, dropRune,
    updatePickups, drawPickups, drawLabels, applyStats, equip, unequip, discard, salvage, socketRune, unsocketRune,
    describe, summary, icon, weaponInfo, useConsumable, populate, shopStock, buy, priceMul,
    applyHeirloomsToRun: (run, meta) => HM.Meta.applyHeirloomsToRun(run, meta),
    fmtMod, inventory: inv, find: findItem, canUse: (run, it) => canUse(run, it),
    trailColor: (p) => (p && p.weapon && p.weapon.trail) || [0.9, 0.92, 1],
    bagFull: (run) => { const I = inv(run); return !I || I.bag.length >= BAG_CAP; },
    pickUp: pickUpItem,
  };

  // ===========================================================================
  // BOONS
  // ===========================================================================
  const BR = { common: '#c9c9c9', rare: '#ffdc4a', legendary: '#ff8a1a', cursed: '#e3203c' };
  const mul = (o, k, v) => { o[k] = (o[k] || 1) * v; };
  const ELEMS = ['fire', 'ice', 'poison', 'shadow', 'holy'];
  const flag = (name) => (p, run, lv) => { p.mods[name] = lv; };
  const pool = [
    // --- common: stats --------------------------------------------------------
    { id: 'billy_might', name: 'Billy\'s Might', giver: 'Billy', rarity: 'common', max: 3, tags: ['damage'], desc: '+15% damage.', quote: 'Swing like the world is watching. It isn\'t, anymore.', apply: (p, r, lv) => { p.stats.dmgMul *= 1 + 0.15 * lv; } },
    { id: 'owl_omen', name: 'Omen of the Owl', giver: 'Cosmic Owl', rarity: 'common', max: 3, tags: ['crit'], desc: '+6% critical chance.', quote: 'The owl blinks. Somewhere, a weak point opens.', apply: (p, r, lv) => { p.stats.critChance += 0.06 * lv; } },
    { id: 'gunter_bottle', name: 'Gunter\'s Bottle', giver: 'Gunter', rarity: 'common', max: 3, tags: ['crit'], desc: '+30% critical damage.', quote: 'Wenk. (It is not clear whose bottle it was.)', apply: (p, r, lv) => { p.stats.critMult += 0.3 * lv; } },
    { id: 'bubblegum_bio', name: 'Candy Biology', giver: 'Princess Bubblegum', rarity: 'common', max: 3, tags: ['defense'], desc: '+12% max life and +1 life regenerated per second.', quote: 'A formula from the old labs, before the lights went out.', apply: (p, r, lv) => { p.maxHp *= 1 + 0.12 * lv; p.stats.regen += 1 * lv; } },
    { id: 'jake_pep', name: 'Brother\'s Pep', giver: 'Jake', rarity: 'common', max: 2, tags: ['speed'], desc: '+10% move speed, +8% attack speed.', quote: 'Shake it off, man. Shake all of it off.', apply: (p, r, lv) => { p.stats.moveMul *= 1 + 0.1 * lv; p.stats.atkSpeed *= 1 + 0.08 * lv; } },
    { id: 'bmo_battery', name: 'Spare Battery', giver: 'BMO', rarity: 'common', max: 3, tags: ['cooldown'], desc: '+10% cooldown recovery and +25% resource regeneration.', quote: 'BMO found it in a dead console. BMO said a few words for it.', apply: (p, r, lv) => { p.stats.cdr = Math.min(0.6, p.stats.cdr + 0.1 * lv); p.stats.mpRegen = p.stats.mpRegen * (1 + 0.25 * lv) + 0.5 * lv; } },
    { id: 'starchy_grit', name: 'Gravedigger\'s Grit', giver: 'Starchy', rarity: 'common', max: 3, tags: ['defense'], desc: '+20 armor and +8% to all resistances.', quote: 'Dug a thousand graves. Never needed one of his own. Yet.', apply: (p, r, lv) => { p.stats.armor += 20 * lv; for (const k in p.stats.res) p.stats.res[k] += 0.08 * lv; } },
    { id: 'lemonhope_song', name: 'Lemonhope\'s Song', giver: 'Lemonhope', rarity: 'common', max: 2, tags: ['speed'], desc: '+12% attack and cast speed.', quote: 'A sour little tune about leaving. You hum it without meaning to.', apply: (p, r, lv) => { p.stats.atkSpeed *= 1 + 0.12 * lv; p.stats.castSpeed *= 1 + 0.12 * lv; } },
    { id: 'tree_trunks_pie', name: 'Apple Pie Charity', giver: 'Tree Trunks', rarity: 'common', max: 2, tags: ['healing'], desc: 'Gain a Bacon Pancake now. Pancakes heal 40% more.', quote: 'She baked it for someone who never came home. Eat it for them.', onTake: (run) => { run.consumables = run.consumables || {}; run.consumables.pancake = Math.min(9, (run.consumables.pancake || 0) + 1); }, apply: flag('pancake_bonus') },
    { id: 'goose_coin', name: 'Goose\'s Golden Coin', giver: 'Choose Goose', rarity: 'common', max: 3, tags: ['gold'], desc: 'Gain 60 gold now and +30% gold from kills.', quote: '"Consider it an investment. In me."', onTake: (run) => { run.gold = (run.gold || 0) + 60; }, apply: (p, r, lv) => { p.stats.goldFind = (p.stats.goldFind || 0) + 0.3 * lv; } },
    { id: 'susan_strength', name: 'Hyooman Strength', giver: 'Susan Strong', rarity: 'common', max: 2, tags: ['damage', 'defense'], desc: '+30 max life and +15% physical damage.', quote: 'Strong arms remember what the head forgets.', apply: (p, r, lv) => { p.maxHp += 30 * lv; mul(p.stats.elemMul, 'phys', 1 + 0.15 * lv); } },
    { id: 'betty_math', name: 'Betty\'s Equation', giver: 'Betty Grof', rarity: 'common', max: 2, tags: ['damage'], desc: '+20% fire, ice, poison, shadow and holy damage.', quote: 'Magic is just math that stopped asking permission.', apply: (p, r, lv) => { for (const e of ELEMS) mul(p.stats.elemMul, e, 1 + 0.2 * lv); } },
    // --- rare -----------------------------------------------------------------
    { id: 'hunson_appetite', name: 'Soul Appetite', giver: 'Hunson Abadeer', rarity: 'rare', max: 2, tags: ['leech'], desc: '+4% life leech.', quote: 'Go on. Have a little taste. Everyone does, eventually.', apply: (p, r, lv) => { p.stats.leech += 0.04 * lv; } },
    { id: 'death_tithe', name: 'Death\'s Tithe', giver: 'Death', rarity: 'rare', max: 3, tags: ['healing'], desc: 'Each kill restores 3% of max life.', quote: 'Every soul you send me, I pay you back in breath.', apply: flag('kill_heal') },
    { id: 'magic_man_prank', name: 'Magic Man\'s Prank', giver: 'Magic Man', rarity: 'rare', max: 2, tags: ['crit'], desc: 'Critical hits detonate in a small explosion.', quote: 'Ha! Ha! Hm. You weren\'t supposed to like it.', apply: flag('crit_explode') },
    { id: 'lsp_stride', name: 'Lumpy Stride', giver: 'Lumpy Space Princess', rarity: 'rare', max: 1, tags: ['dodge'], desc: 'Your dodge holds 2 charges.', quote: 'Whatever. Just bounce out of the way, it\'s not hard.', apply: flag('dodge_charges2') },
    { id: 'flambo_steps', name: 'Cinder Steps', giver: 'Flambo', rarity: 'rare', max: 1, tags: ['dodge', 'fire'], desc: 'Your dodge leaves a trail of fire.', quote: 'A little spark for your heels, eh? Mind the grass.', apply: flag('dodge_fire_trail') },
    { id: 'neptr_pies', name: 'Pie-Throwing Protocol', giver: 'NEPTR', rarity: 'rare', max: 3, tags: ['summon'], desc: 'Every few seconds, hurl a pie at the nearest foe.', quote: 'NEPTR LIVES TO SERVE. NEPTR HAS ALWAYS LIVED TO SERVE.', apply: (p, r, lv) => { p.mods.b_neptr = lv; } },
    { id: 'huntress_mark', name: 'Huntress\'s Mark', giver: 'Huntress Wizard', rarity: 'rare', max: 2, tags: ['damage'], desc: '+25% damage to elites and bosses.', quote: 'Pick the biggest thing in the forest. Then be quieter than it.', apply: (p, r, lv) => { p.mods.b_huntress = lv; } },
    { id: 'ghost_veil', name: 'Ghostly Veil', giver: 'Ghost Princess', rarity: 'rare', max: 2, tags: ['defense'], desc: 'After taking a hit, become intangible for 0.5 s (8 s cooldown, halved at rank 2).', quote: 'Being dead is mostly about knowing when to not be there.', apply: (p, r, lv) => { p.mods.b_ghost = lv; } },
    { id: 'owl_dream', name: 'Prophetic Dream', giver: 'Cosmic Owl', rarity: 'rare', max: 2, tags: ['crit'], desc: 'Every few seconds, your next hit is a guaranteed critical.', quote: 'You dream of the blow before you land it. Then you land it.', apply: (p, r, lv) => { p.mods.b_owl = lv; } },
    { id: 'simon_scarf', name: 'Simon\'s Scarf', giver: 'Simon Petrikov', rarity: 'rare', max: 2, tags: ['ice'], desc: '+20% ice damage; hits have a 20% chance to Chill.', quote: 'Knitted for someone, a long time ago. He forgot who.', apply: (p, r, lv) => { mul(p.stats.elemMul, 'ice', 1 + 0.2 * lv); p.mods.b_chill = lv; } },
    { id: 'pb_mint', name: 'Dark Mint Rites', giver: 'Peppermint Butler', rarity: 'rare', max: 2, tags: ['shadow', 'fire'], desc: '+25% shadow and fire damage; hits have a 15% chance to Weaken.', quote: 'A small ritual. Barely any screaming. Do keep it between us.', apply: (p, r, lv) => { mul(p.stats.elemMul, 'shadow', 1 + 0.25 * lv); mul(p.stats.elemMul, 'fire', 1 + 0.25 * lv); p.mods.b_weaken = lv; } },
    { id: 'rainicorn_mane', name: 'Prismatic Mane', giver: 'Lady Rainicorn', rarity: 'rare', max: 2, tags: ['damage', 'speed'], desc: '+10% damage, +10% move speed, +10% max life.', quote: 'She speaks softly in a language of colours. You understand anyway.', apply: (p, r, lv) => { p.stats.dmgMul *= 1 + 0.1 * lv; p.stats.moveMul *= 1 + 0.1 * lv; p.maxHp *= 1 + 0.1 * lv; } },
    // --- legendary ------------------------------------------------------------
    { id: 'prismo_wish', name: 'Prismo\'s Wish', giver: 'Prismo', rarity: 'legendary', max: 2, weight: 0.6, tags: ['wish'], desc: 'Get something big. Get something else, too.', quote: 'A wish is a wish. The fine print is also a wish.', apply: () => {} },
    { id: 'death_waltz', name: 'The Last Waltz', giver: 'Death', rarity: 'legendary', max: 1, tags: ['damage'], desc: '+40% damage while below 40% life.', quote: 'Dance with me a while. I\'m in no hurry. Are you?', apply: (p, r, lv) => { p.mods.b_waltz = lv; } },
    // --- cursed ---------------------------------------------------------------
    { id: 'lich_whisper', name: 'Whisper of Extinction', giver: 'The Lich', rarity: 'cursed', max: 1, tags: ['damage', 'curse'], desc: '+35% damage. −25% max life.', quote: 'ALL THINGS END. LET ME SHOW YOU HOW.', apply: (p) => { p.stats.dmgMul *= 1.35; p.maxHp *= 0.75; } },
    { id: 'hunson_contract', name: 'Nightosphere Contract', giver: 'Hunson Abadeer', rarity: 'cursed', max: 1, tags: ['leech', 'curse'], desc: '+6% life leech and +20% damage. You take 20% more damage.', quote: 'Sign here, and here, and — there. Chaos is a family business.', apply: (p) => { p.stats.leech += 0.06; p.stats.dmgMul *= 1.2; p.stats.dmgTakenMul *= 1.2; } },
    { id: 'magic_mirror', name: 'Backwards Mirror', giver: 'Magic Man', rarity: 'cursed', max: 1, tags: ['speed', 'curse'], desc: '+20% move and attack speed. Pancakes heal half as much.', quote: 'Look in it. No, the other way. Ha!', apply: (p) => { p.stats.moveMul *= 1.2; p.stats.atkSpeed *= 1.2; p.stats.healMul = (p.stats.healMul === undefined ? 1 : p.stats.healMul) * 0.5; } },
    // --- Finn -------------------------------------------------------------------
    { id: 'finn_combo4', name: 'Fourth Verse', giver: 'Billy', rarity: 'rare', heroes: ['finn'], max: 1, tags: ['hero'], desc: 'Your 4th combo strike becomes a spinning slash.', quote: 'Three strikes is a song. Four is a legend.', apply: flag('finn_combo4') },
    { id: 'finn_leap_vines', name: 'Grass-Curse Bloom', giver: 'The Grass Wizard', rarity: 'rare', heroes: ['finn'], max: 1, tags: ['hero'], desc: 'Leap Slam leaves rooting vines where you land.', quote: 'The curse wants to grow. Let it grow on them.', apply: flag('finn_leap_vines') },
    { id: 'finn_jake_long', name: 'Stretchier Brother', giver: 'Jake', rarity: 'rare', heroes: ['finn'], max: 1, tags: ['hero'], desc: 'Jake stays 50% longer.', quote: 'I can stretch a little further for you, bro. I always could.', apply: flag('finn_jake_long') },
    { id: 'finn_cleave_wave', name: 'Root-Sword Wave', giver: 'Fern', rarity: 'rare', heroes: ['finn'], max: 1, tags: ['hero'], desc: 'Heavy Cleave launches a wave of grass.', quote: 'He has your face and none of your luck. He gives you this anyway.', apply: flag('finn_cleave_wave') },
    // --- Marceline ------------------------------------------------------------
    { id: 'marcy_drain_chain', name: 'Hunger of the Nightosphere', giver: 'Hunson Abadeer', rarity: 'rare', heroes: ['marceline'], max: 1, tags: ['hero'], desc: 'Drain chains to 2 extra targets.', quote: 'Why drink from one cup, sweetie, when there\'s a whole table?', apply: flag('marcy_drain_chain') },
    { id: 'marcy_bat_bleed', name: 'Red Bat Kiss', giver: 'The Vampire King', rarity: 'rare', heroes: ['marceline'], max: 1, tags: ['hero'], desc: 'Bat Swarm makes its victims Bleed.', quote: 'The old king\'s bats still answer to the old ways.', apply: flag('marcy_bat_bleed') },
    { id: 'marcy_chord_stun', name: 'Hambo\'s Lullaby', giver: 'Hambo', rarity: 'rare', heroes: ['marceline'], max: 1, tags: ['hero'], desc: 'Sonic Chord stuns for 0.8 s.', quote: 'A stuffed bear\'s song, played loud enough to stop a heart.', apply: flag('marcy_chord_stun') },
    { id: 'marcy_queen_heal', name: 'Bonnibel\'s Sweater', giver: 'Princess Bubblegum', rarity: 'rare', heroes: ['marceline'], max: 1, tags: ['hero'], desc: 'Shadow Queen heals 30% of max life when it begins.', quote: 'It still smells like her lab. Like sugar and burnt hair.', apply: flag('marcy_queen_heal') },
    // --- Flame Princess -------------------------------------------------------
    { id: 'fp_fissure5', name: 'Five Tongues', giver: 'Cinnamon Bun', rarity: 'rare', heroes: ['fp'], max: 1, tags: ['hero'], desc: 'Fire Fissure splits into 5 prongs.', quote: 'More fire, Princess! There\'s always room for more fire!', apply: flag('fp_fissure5') },
    { id: 'fp_volley5', name: 'Volley of Five', giver: 'Don John', rarity: 'rare', heroes: ['fp'], max: 1, tags: ['hero'], desc: 'Fireball Volley fires 5 orbs.', quote: 'Your uncle\'s only lesson: never throw three when five will do.', apply: flag('fp_volley5') },
    { id: 'fp_ring_bigger', name: 'Wider Halo', giver: 'Flambo', rarity: 'rare', heroes: ['fp'], max: 1, tags: ['hero'], desc: '+40% Flame Ring radius.', quote: 'Let it spread, lady. Fire was never meant to stay small.', apply: flag('fp_ring_bigger') },
    { id: 'fp_temper_cool', name: 'Bubblegum\'s Dampener', giver: 'Princess Bubblegum', rarity: 'rare', heroes: ['fp'], max: 1, tags: ['hero'], desc: 'Temper cools 50% faster; Wildfire lasts 50% longer.', quote: 'I built it to hold you back. Now it holds you together.', apply: flag('fp_temper_cool') },
  ];
  // Hidden boons granted by Prismo's Wish (never drafted)
  const hidden = [
    { id: 'wish_titan', name: 'Wish: Titan', giver: 'Prismo', rarity: 'legendary', hidden: true, desc: '+35% max life and +25% damage.', apply: (p, r, lv) => { p.maxHp *= 1 + 0.35 * lv; p.stats.dmgMul *= 1 + 0.25 * lv; } },
    { id: 'wish_storm', name: 'Wish: Storm', giver: 'Prismo', rarity: 'legendary', hidden: true, desc: '+40% attack and cast speed.', apply: (p, r, lv) => { p.stats.atkSpeed *= 1 + 0.4 * lv; p.stats.castSpeed *= 1 + 0.4 * lv; } },
    { id: 'wish_hunger', name: 'Wish: Hunger', giver: 'Prismo', rarity: 'legendary', hidden: true, desc: '+8% life leech; kills restore life.', apply: (p, r, lv) => { p.stats.leech += 0.08 * lv; p.mods.kill_heal = (p.mods.kill_heal || 0) + lv; } },
    { id: 'wish_fortune', name: 'Wish: Fortune', giver: 'Prismo', rarity: 'legendary', hidden: true, desc: 'Gain 250 gold and 2 boon points.', onTake: (run) => { run.gold = (run.gold || 0) + 250; run.boonPoints = (run.boonPoints || 0) + 2; }, apply: () => {} },
    { id: 'wish_owl', name: 'Wish: Clear Sight', giver: 'Prismo', rarity: 'legendary', hidden: true, desc: '+15% crit chance and +50% crit damage.', apply: (p, r, lv) => { p.stats.critChance += 0.15 * lv; p.stats.critMult += 0.5 * lv; } },
    { id: 'curse_glass', name: 'Curse: Glass Bones', giver: 'Prismo', rarity: 'cursed', hidden: true, desc: 'You take 25% more damage.', apply: (p, r, lv) => { p.stats.dmgTakenMul *= 1 + 0.25 * lv; } },
    { id: 'curse_frail', name: 'Curse: Thin Blood', giver: 'Prismo', rarity: 'cursed', hidden: true, desc: '−20% max life.', apply: (p, r, lv) => { p.maxHp *= Math.pow(0.8, lv); } },
    { id: 'curse_slow', name: 'Curse: Lead Feet', giver: 'Prismo', rarity: 'cursed', hidden: true, desc: '−12% move speed.', apply: (p, r, lv) => { p.stats.moveMul *= Math.pow(0.88, lv); } },
    { id: 'curse_hunger', name: 'Curse: Ash Mouth', giver: 'Prismo', rarity: 'cursed', hidden: true, desc: 'Pancakes heal half as much.', apply: (p, r, lv) => { p.stats.healMul = (p.stats.healMul === undefined ? 1 : p.stats.healMul) * Math.pow(0.5, lv); } },
    { id: 'curse_poor', name: 'Curse: Empty Pockets', giver: 'Prismo', rarity: 'cursed', hidden: true, desc: '−50% gold from kills; shop prices +25%.', apply: (p) => { p.stats.goldFind = (p.stats.goldFind || 0) - 0.5; } },
  ];
  const BOONS = {}; for (const b of pool.concat(hidden)) { b.color = hex(BR[b.rarity]); b.hex = BR[b.rarity]; b.max = b.max || 1; BOONS[b.id] = b; }
  const BOON_W = { common: 60, rare: 30, legendary: 7, cursed: 5 };

  const Boons = (HM.Boons = {
    pool, hidden, defs: BOONS, RARITY_HEX: BR, BLESSINGS,
    count(run, id) { let n = 0; for (const b of (run && run.boons) || []) if (b === id) n++; return n; },
    // The Shrine of Gob blessing active on this floor (for the HUD), or null.
    blessing(run) { const fb = run && run.floorBuff; const B = fb && fb.floorIndex === run.floorIndex && BLESSINGS[fb.id]; return B ? { id: fb.id, name: B.name, desc: B.desc, hex: SHRINES.gob.hex } : null; },
    levels(run) { const o = {}; for (const b of (run && run.boons) || []) o[b] = (o[b] || 0) + 1; return o; },

    // Weighted, no duplicates, respects heroes and stack caps. Deterministic per run/floor/draft count.
    draft(run, n) {
      n = n || 3; if (!run) return [];
      run.draftCount = (run.draftCount || 0) + 1;
      const rng = new HM.RNG(((run.seed || 1) ^ Math.imul(run.floorIndex || 1, 977) ^ Math.imul(run.draftCount, 7919)) >>> 0);
      const lv = Boons.levels(run);
      const avail = pool.filter((b) => (!b.heroes || b.heroes.includes(run.heroId)) && (lv[b.id] || 0) < b.max && !(b.id === 'prismo_wish' && (run.floorIndex || 1) < 2));
      const f = run.floorIndex || 1;
      const wt = (b) => {
        let w = BOON_W[b.rarity] * (b.weight || 1);
        if (b.rarity === 'legendary') w *= 1 + f * 0.08;
        if (b.rarity === 'cursed') w *= f >= 4 ? 1 + f * 0.05 : 0.3;
        if (b.heroes) w *= 1.8;             // hero boons show up often enough to build around
        if (lv[b.id]) w *= 1.25;             // gentle nudge toward stacking what you have
        return w;
      };
      const out = [];
      const left = avail.slice();
      while (out.length < n && left.length) {
        const b = rng.weighted(left, wt);
        out.push(b); left.splice(left.indexOf(b), 1);
      }
      return out;
    },

    take(run, id) {
      const b = BOONS[id]; if (!run || !b) return null;
      run.boons = run.boons || [];
      run.boons.push(id);
      const granted = [b];
      if (b.onTake) b.onTake(run);
      if (id === 'prismo_wish') {
        const rng = new HM.RNG(((run.seed || 1) ^ (run.boons.length * 4099) ^ 0x9715) >>> 0);
        const wish = rng.pick(hidden.filter((h) => h.rarity === 'legendary'));
        const curse = rng.pick(hidden.filter((h) => h.rarity === 'cursed'));
        for (const h of [wish, curse]) { run.boons.push(h.id); if (h.onTake) h.onTake(run); granted.push(h); }
        // one toast: Game.chooseBoon moves straight on to the next floor, which clears game timers
        toast('Prismo grants ' + wish.name + ': ' + wish.desc + '\n...and the fine print. ' + curse.name + ': ' + curse.desc, BR.legendary, 4.2);
      }
      refreshPlayer();
      HM.Events.emit('boon', { id, run, granted: granted.map((g) => g.id) });
      return b;
    },

    // Re-applies every taken boon (+ heirloom stats + the floor's Gob blessing) onto a freshly recomputed player.
    apply(player, run) {
      run = run || runOf(player); if (!player || !player.stats) return;
      player.mods = player.mods || {};
      const lv = Boons.levels(run);
      // heirloom stat effects (guarded so a separate Meta.apply call doesn't double them)
      HM.Meta.applyPlayer(player, run);
      for (const id in lv) { const b = BOONS[id]; if (b && b.apply) { try { b.apply(player, run, lv[id]); } catch (e) { console.error('[boon ' + id + ']', e); } } }
      if (run && run.floorBuff && run.floorBuff.floorIndex === run.floorIndex && BLESSINGS[run.floorBuff.id]) BLESSINGS[run.floorBuff.id].apply(player);
      player.maxHp = Math.max(1, Math.round(player.maxHp));
      if (player.hp > player.maxHp) player.hp = player.maxHp;
    },

    // Tooltip lines (array) with extra props: name, giver, desc, rarity, hex, color, quote, level, max.
    describe(id, run) {
      const b = BOONS[id];
      if (!b) { const L = [{ text: 'Unknown boon', color: '#888' }]; L.name = id; L.desc = ''; return L; }
      const level = run ? Boons.count(run, id) : 0;
      const L = [
        { text: b.name + (b.max > 1 ? '  ' + (level ? 'rank ' + level + '/' + b.max : 'max ' + b.max) : ''), color: b.hex, style: 'title' },
        { text: 'from ' + b.giver + ' · ' + b.rarity + (b.heroes ? ' · ' + ({ finn: 'Finn', marceline: 'Marceline', fp: 'Flame Princess' }[b.heroes[0]]) + ' only' : ''), color: '#8d939c', style: 'sub' },
        { text: b.desc, color: '#e8e8e8', style: 'stat' },
      ];
      if (b.quote) L.push({ text: '"' + b.quote + '"', color: '#7f858e', style: 'flavor' });
      Object.assign(L, { id, name: b.name, giver: b.giver, desc: b.desc, rarity: b.rarity, hex: b.hex, color: b.color, quote: b.quote || '', level, max: b.max, heroes: b.heroes || null });
      return L;
    },
  });

  // ===========================================================================
  // META — heirlooms bought with Ashes, per save slot
  // ===========================================================================
  const HEIRLOOMS = [
    { id: 'grit', name: 'Hero\'s Grit', glyph: '+', maxLevel: 5, base: 40, step: 30, desc: '+5% max life per level.', kind: 'player' },
    { id: 'pancake_recipe', name: 'Pancake Recipe', glyph: '=', maxLevel: 3, base: 60, step: 60, desc: 'Start each run with +1 Bacon Pancake per level.', kind: 'run' },
    { id: 'goose_coupon', name: 'Goose Coupon', glyph: '$', maxLevel: 3, base: 50, step: 40, desc: 'Choose Goose charges 10% less per level.', kind: 'run' },
    { id: 'billy_training', name: 'Billy\'s Training', glyph: '/', maxLevel: 5, base: 45, step: 35, desc: '+3% damage per level.', kind: 'player' },
    { id: 'enchiridion_index', name: 'Enchiridion Index', glyph: '§', maxLevel: 3, base: 80, step: 80, desc: '+1 boon reroll per run per level.', kind: 'run' },
    { id: 'lucky_sock', name: 'Lucky Sock', glyph: '&', maxLevel: 4, base: 60, step: 50, desc: '+15% rarity luck per level.', kind: 'run' },
    { id: 'treehouse_stash', name: 'Treehouse Stash', glyph: '0', maxLevel: 4, base: 30, step: 30, desc: 'Start each run with +30 gold per level.', kind: 'run' },
    { id: 'second_wind', name: 'Second Wind', glyph: '*', maxLevel: 1, base: 220, step: 0, desc: 'Once per run, a killing blow leaves you at 30% life instead.', kind: 'player' },
  ];
  const HL = {}; for (const h of HEIRLOOMS) {
    HL[h.id] = h;
    h.cost = ((hh) => (level) => (level >= hh.maxLevel ? null : Math.round(hh.base + hh.step * level + (hh.step ? 6 * level * level : 0))))(h);
    h.apply = ((hh) => (target, level) => { if (target && target.stats) Meta.applyPlayerOne(hh.id, target, level); else if (target) Meta.applyRunOne(hh.id, target, level); })(h);
  }

  const Meta = (HM.Meta = {
    list: HEIRLOOMS, defs: HL,
    meta() { return HM.Save && HM.Save.data ? HM.Save.data.meta : null; },
    level(id) { const m = Meta.meta(); return m && m.heirlooms ? m.heirlooms[id] || 0 : 0; },
    cost(id) { const h = HL[id]; return h ? h.cost(Meta.level(id)) : null; },
    canBuy(id) { const c = Meta.cost(id); const m = Meta.meta(); return c !== null && !!m && m.ashes >= c; },
    buy(id) {
      const h = HL[id]; const m = Meta.meta();
      if (!h || !m) return { ok: false, error: 'No profile loaded.' };
      m.heirlooms = m.heirlooms || {};
      const lv = m.heirlooms[id] || 0; const c = h.cost(lv);
      if (c === null) return { ok: false, error: 'Already mastered.' };
      if (m.ashes < c) return { ok: false, error: 'Not enough Ashes (' + c + ' needed).' };
      m.ashes -= c; m.heirlooms[id] = lv + 1;
      HM.Save.write && HM.Save.write();
      play('boon');
      HM.Events.emit('heirloom', { id, level: lv + 1 });
      return { ok: true, level: lv + 1, cost: c, next: h.cost(lv + 1) };
    },
    applyRunOne(id, run, lv) {
      if (!lv) return;
      run.consumables = run.consumables || { pancake: 0, tonic: 0 };
      if (id === 'pancake_recipe') run.consumables.pancake = (run.consumables.pancake || 0) + lv;
      else if (id === 'treehouse_stash') run.gold = (run.gold || 0) + 30 * lv;
      else if (id === 'enchiridion_index') run.rerolls = (run.rerolls || 0) + lv;
      else if (id === 'lucky_sock') run.luck = (run.luck || 0) + 0.15 * lv;
    },
    applyPlayerOne(id, p, lv) {
      if (!lv) return;
      p.mods = p.mods || {};
      if (id === 'grit') p.maxHp *= 1 + 0.05 * lv;
      else if (id === 'billy_training') p.stats.dmgMul *= 1 + 0.03 * lv;
      else if (id === 'second_wind') p.mods.second_wind = 1;
    },
    // at run start (Game.newRun → Items.applyHeirloomsToRun). Snapshots levels into run.heirlooms.
    applyHeirloomsToRun(run, meta) {
      if (!run) return;
      const hl = (meta && meta.heirlooms) || {};
      run.heirlooms = {};
      for (const h of HEIRLOOMS) { const lv = Math.min(h.maxLevel, hl[h.id] || 0); if (lv) run.heirlooms[h.id] = lv; }
      run.rerolls = run.rerolls || 0; run.luck = run.luck || 0;
      for (const id in run.heirlooms) Meta.applyRunOne(id, run, run.heirlooms[id]);
    },
    // player-stat heirlooms; called by Boons.apply. Idempotent per stats object.
    applyPlayer(player, run) {
      if (!player || !player.stats) return;
      if (player._metaStats === player.stats && player._metaGen === player._statGen) return;
      player._metaStats = player.stats; player._metaGen = player._statGen;
      run = run || runOf(player);
      const hl = (run && run.heirlooms) || (Meta.meta() && Meta.meta().heirlooms) || {};
      for (const h of HEIRLOOMS) if (h.kind === 'player' && hl[h.id]) Meta.applyPlayerOne(h.id, player, hl[h.id]);
    },
    apply(target, run) { if (target && target.stats) Meta.applyPlayer(target, run); else if (target) Meta.applyHeirloomsToRun(target, Meta.meta()); },
  });
})();
