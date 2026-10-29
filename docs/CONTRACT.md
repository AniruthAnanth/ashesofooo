# ASHES OF OOO — Module Contract

Read `docs/DESIGN.md` first (lore, controls, art direction, animation direction). This file is the
**exact API contract** between modules. Every module is a classic script (no ES modules, no imports,
no npm deps, no build step) wrapped in an IIFE that attaches to the global `HM` namespace:

```js
(function () {
  'use strict';
  const HM = (globalThis.window || globalThis).HM;
  ...
  HM.Thing = { ... };
})();
```

Load order (index.html): `core → render → save → combat → lore → audio → fx → world → rig → items → heroes → enemies → bosses → ui → game → main`.
Modules may reference each other **at call time** (inside functions), never at load time (except core/render/combat which load first).
Always guard optional calls to other modules: `HM.FX && HM.FX.burst && HM.FX.burst(...)`, because during
parallel development another module might be a stub.

## Paths & tools

- Project root: the repository root
- Reference frames from the original reels (LOOK AT THEM with the Read tool, they are PNGs):
  a local `ref/` folder of frames captured from the reels (not committed — not ours to redistribute)
  — file names describe content (`fx_fissure_1_cracks_appear.png` … `fx_fissure_6_aftermath.png`, `anim_frame_1..4.png`,
  `enemy_skeleton_pack.png`, `fx_fire_ring_aura.png`, `boss_dragon_*.png`, `ui_inventory_panel.png`, `ui_craft_*.png`, `env_*.png`, `fx_poison_*.png`, `pvp_*.png`, `loot_ground_labels.png`).
- **Smoke test (run it often):** `node tools/smoke.js --seconds 6 --floors 1-15` — headless run of every hero through every
  floor with a bot, exercising update+draw+UI+save. Must print `SMOKE OK`. Flags: `--heroes finn`, `--floors 1,3,6`, `--quiet`.
  If another module (not yours) is mid-edit and broken, the harness falls back to `src/stubs/<file>` and tells you; ignore errors that
  are clearly in a file you don't own.
- **Screenshots (to SEE your work):** `tools/shot.sh "<query>" /tmp/<yourname>-1.png 1400 820 3000` then Read the PNG.
  Query params: `hero=finn|marceline|fp`, `floor=1..15`, `seed=N`, `nosave=1`, **`sim=SECONDS` (REQUIRED for staged shots: headless Chrome barely ticks rAF, so the game
  fast-forwards deterministically to that time at boot, running `do=` actions on schedule, then freezes)**, `freeze=SECONDS` (stop sim, keep rendering),
  `do=T:JS|T:JS` (run JS at time T; URL-encode `=`→`%3D`, `+`→`%2B`, `&`→`%26`, space→`%20`), `debug=1`.
  Example: fire Flame Princess skill1 at 0.8s and freeze at 1.3s:
  `tools/shot.sh "hero=fp&nosave=1&freeze=1.3&do=0.8:HM.Input.lastPress.skill1%3DHM.Input.now" /tmp/fp.png`
  Chrome is headless with SwiftShader WebGL; it's slow-ish (~6 s per shot). Use your own /tmp file names.
- **Perf budget:** the whole frame must stay < ~10 ms/frame in the smoke harness at default size (it prints avg ms/frame;
  baseline with stubs ≈ 9 ms, so your module's per-frame cost should be small: avoid per-cell noise/hash in hot loops,
  allocate nothing per cell, precompute, reuse typed arrays, cull by `R.inViewWorld`).

## Coordinates & rendering (src/render.js — `HM.R`, already written; don't edit unless told)

- World: ground `(x, y)`, height `z`. Projected px: `px = x`, `py = y*TILT - z` (`TILT = 0.75`). Cells are world-anchored:
  `ci = floor(px/5)`, `cj = floor(py/8)` (`CW=5`, `CH=8`). Visible buffer: `R.cols × R.rows` starting at world cell `R.ci0, R.cj0`.
- Depth keys: higher key wins a cell. Terrain = `R.KEY_GROUND`, ground decals/telegraphs = `R.KEY_DECAL` (+small offsets),
  actors/props/particles = **their world `y`** (+tiny offsets for part ordering), always-on-top = `R.KEY_TOP`.
- Flags: `R.F_UNLIT` (ignore lighting — use for emissive glyphs/UI), `R.F_GROUND` (terrain; receives full shadow),
  **`R.F_FIGURE`** (characters/monsters: bold glyph weight (`glyph | R.BOLD`), rim light, thin soft terrain shadow — REQUIRED for every actor cell; never draw your own black halo/border, the user found thick borders ugly), **`R.F_PROP`** (props/interactables/loot: outline + rim, regular weight).
  `R.capsule`/`R.ball` add `F_FIGURE` automatically (pass `opts.notFigure` to opt out). See DESIGN §4b — figure/ground separation is the user's top visual priority.
- Colors are linear floats ~0..1 (can exceed 1 for hot emissive). Final = albedo×ambient×(1-shadow) + light×(glyphLum×1.8) + emissive, then tone-mapped.
- Primitives (projected px unless noted):
  - `R.gi(char)` → glyph index; `R.ramp(str)` → Uint8Array of glyph indices (dark→bright); `R.RAMPS.{solid,soft,dense,stone,bone,cloth,metal,flesh,hair,fire,ice,candy,shadow}`
  - `R.proj(x,y,z)` → `[px,py]`; `R.worldToScreen(x,y,z)` → CSS px; `R.screenToWorld(sx,sy)` → world ground `[x,y]`; `R.inViewWorld(x,y,margin)`
  - `R.set(px,py,g,r,g,b,key,flags)`, `R.setI(i,…)`, `R.setC(ci,cj,…)`, `R.idx(ci,cj)`, `R.idxP(px,py)`
  - `R.glowGlyph(px,py,g,r,g,b,key,emitK)` — emissive glyph (+bloom)
  - `R.emit(px,py,r,g,b)` / `R.emitI(i,…)` — add emissive glow to a cell (no glyph change)
  - `R.seg(ax,ay,bx,by,g|null,r,g,b,key,flags,keyB)` — line of glyphs (null → directional `- | / \`)
  - `R.capsule(ax,ay,bx,by,ra,rb,ka,kb,ramp,r,g,b,flags,opts)` — shaded 3D tube (the core of character rendering);
    `R.ball(cx,cy,rad,key,ramp,r,g,b,flags)` — shaded sphere. Very thin capsules fall back to `seg`.
  - `R.ellipse(x,y,rx,ry,fn(i,u,ci,cj,ang))` / `R.ring(x,y,rad,thick,fn)` — iterate ground cells (world coords)
  - `R.shadowEllipse(x,y,rx,ry,amount)` — soft blob shadow on the ground
  - `R.text(px,py,str,r,g,b,key,flags)`, `R.textCenter(...)`, `R.sprite(px,py,lines[],rgb|fn,key,flags)` (bottom-center anchored ASCII art)
  - `R.light(x,y,z,radius,r,g,b,intensity)` — point light (world). `R.flash(r,g,b,a)` full-screen flash. `R.hurt` (0..1 red vignette, set by Game).
  - `R.ambient = [r,g,b]` (set by Game from `floor.ambient`).
- The UI overlay is a separate Canvas2D (`#ui`) drawn by `HM.UI.draw()` after the GL frame. Map world→screen with `R.worldToScreen`.

## Core (src/core.js — written)

`HM.cfg`, `HM.M` (clamp, lerp, damp, easeOutCubic, easeOutBack, angle, angleDiff, dist, hash2, noise2, fbm, segT, distToSeg, rot, hexToRgb, fmt…),
`HM.RNG(seed)` (next, range, int, pick, chance, weighted, shuffle, fork), `HM.rng` (unseeded), `HM.Events` (on/off/emit), `HM.uid()`.

**Input (`HM.Input`)** — edge-captured so short taps are never lost; supports buffering & remapping.
Actions: `up down left right attack heavy dodge skill1 skill2 ult interact potion1 potion2 inventory pause`.
Defaults: WASD, LMB attack, RMB heavy, Space dodge, Q skill1, E skill2, R ult, F interact, 1/2 potions, Tab/I inventory, Esc pause.
- `Input.isDown(a)`, `Input.wasPressed(a)` (this frame), `Input.consume(a, window=0.15)` (buffered press — USE THIS for verbs so
  presses during locked animations fire when legal), `Input.peek(a)`, `Input.moveVec()` → `[x,y]`, `Input.mouse.{sx,sy,wheel}`,
  `Input.pressed` (Set of raw codes this frame, e.g. `'Enter'`, `'Mouse0'`, `'ArrowUp'`), `Input.typed` (chars typed this frame),
  `Input.binds`, `Input.actionLabel(a)` → e.g. `'Q'`, `Input.codeLabel(code)`, `Input.capturing = fn(code)` (next key → fn, for remapping UI),
  `Input.setBinds(obj)`, `Input.DEFAULT_BINDS`, `Input.clearBuffer()`.

## Combat (src/combat.js — written)

`HM.Actor` base class (fields: `id kind team defId name x y z vx vy kx ky radius mass height hp maxHp mp maxMp speed facing aim dead removeMe deathT
statuses flashT iframeT stunT invuln stats level xpValue goldDrop isElite isBoss affixes rig anim moving tags t`).
`stats`: `armor res{phys,fire,ice,poison,shadow,holy} critChance critMult dmgMul moveMul atkSpeed castSpeed leech cdr thorns dmgTakenMul regen mpRegen elemMul{…}`.
Subclasses override `update(dt)` and MUST call `HM.Combat.baseUpdate(this, dt)` (timers, statuses, knockback, applies `vx/vy` intended velocity with collision).
Optional hooks: `onDamaged(info)`, `onDealDamage(info)`, `onDeath(info)`, `onKill(target, info)`, `onBeforeDeath(info)` (return false to cancel death, e.g. phase gate).
Default `draw()` calls `HM.Rig.draw(this)`.

`HM.Combat`:
- `damage(target, spec)` — spec `{amount, type:'phys'|'fire'|'ice'|'poison'|'shadow'|'holy', source, canCrit, crit, knock, dir, status:[{id,dur,dps,stacks,amount}], hitstop, shake, noNumber, numColor, isDot, ignoreIframes, tags}` → info or null. Handles crit, shatter-frozen, resist/armor, shields, leech, thorns, flash, knockback, hitstop+shake (only if player involved), numbers (`FX.number`), sounds (`Audio.play('hit'|'crit'|'hit_fire'…)`), statuses, `Events 'damage'`, death → `kill()`.
- `heal(target, amount)`, `kill(target, info)` (→ `Rig.onDeath`, `Events 'kill'` → Game grants XP, `Items.rollDrops`, bestiary, objectives).
- Statuses: `applyStatus(t, id, {dur,dps,stacks,src,amount})`, `removeStatus`, ids: `burn poison bleed chill freeze stun weaken rot kindled haste shield doom`.
- Areas: `hitCircle(x,y,r,team,spec,opts)`, `hitArc(x,y,ang,half,range,team,spec,opts)`, `hitLine(x0,y0,x1,y1,w,team,spec,opts)`; `opts.once` = a Set to prevent multi-hits across frames; `spec` may be a function `(actor)=>spec`. `query*` versions return actors without damaging. `nearestHostile(x,y,team,maxR)`, `assistAim(x,y,ang,range,team,maxBend)` (weak melee aim assist; use maxBend ≈ 0.26 rad).
  `team` = attacker's team (hits everyone not on that team and not team 2).
- `move(actor, dx, dy)` with world collision.
- Projectiles: `projectile({x,y,z,vx,vy,vz,r,team,life,damage:spec|fn,pierce,look,color,onHit(t,p),onExpire(p),onWall(p),update(p,dt),draw(p),homing:{target,turn},gravity,source,light:[radius,r,g,b],ghost})` → pushed to `Game.projectiles`, updated/collided by Game. If no `draw`, `HM.FX.drawProjectile(p)` draws it by `p.look`.
- Zones: `zone({x,y,r,team,life,tick,onTick(z,inside),kind,tags:['flammable'],ignite(z,src),draw(z),hitsAll,source})` → `Game.zones`; drawn by `z.draw` or `HM.FX.drawZone(z)` by `z.kind`.
- `igniteAt(x,y,r,source)` — fire skills call this; flammable zones (poison clouds, rot pools, sugar) explode. (Expression space!)

## Game (src/game.js — written)

`HM.Game`: `state` ∈ `title slots heroSelect play pause inventory boon shop dead victory options codex heirlooms`; `setState(s, data)` (data → `Game.menuData`).
`run` (serializable): `{seed, heroId, floorIndex(1..15), level, xp, gold, kills, time, boons[], boonPoints, rerolls, ascension, hp, mp, inventory, consumables{pancake,tonic}, codexThisRun[], elitesKilled, bossesKilled[], stats{dealt,taken}}`.
`floor` (from World.generate + Game adds `act, inAct, index, actName`). `player`, `entities` (all actors incl. player), `projectiles`, `zones`, `pickups`, `cam{x,y}`, `interactTarget`.
Methods: `newRun(heroId,{seed,ascension})`, `resumeRun()`, `enterFloor(i)`, `openExit(reason)`, `descend()`, `openBoonDraft()`, `chooseBoon(id)`, `rerollBoons()`,
`victory()`, `onPlayerDeath()`, `abandonRun()`, `quitToTitle()`, `xpToNext(level)`, `grantXP(n)`, `addGold(n)`, `spawn(actor)`, `hitstop(sec)`, `slowmo(sec, scale)`,
`after(sec, fn)` (game-time timer; respects pause/hitstop), `enemiesAlive()`, `bossesAlive()`, `actInfo(floorIndex)`. `Game.t` = game time, `Game.realT` = real time.
Game calls per frame (play): `World.update`, each `actor.update(dt)` then `Rig.update(actor, dt)`, separation, projectiles, zones, `Items.updatePickups`, `FX.update`, interaction
(nearest `floor.interactables`/`pickups` with `canInteract(p)` within `r` → `Game.interactTarget`; `Input.consume('interact')` → `obj.interact(player)`), camera.
Draw order: `World.draw` → `FX.drawGround` → zones → `Items.drawPickups` → actors (`a.draw()`) → projectiles → `FX.draw` → `World.drawOver` → `R.endFrame` → `UI.draw`.
Objectives: `floor.objective = {type:'elite'|'boss'|'clear', remaining, done}` — Game decrements on elite/boss kills and calls `openExit`.
Boon points: +1 per level-up, per elite kill, per boss kill. On `descend()`, if `boonPoints>0` → `state 'boon'` with `menuData.draft` = `HM.Boons.draft(run,3)`.
Events emitted: `state, floorStart, floorClear, exitOpen, levelup, gold, damage, preDamage, kill, evade, status, saved, saveError, achievement, resize`.

**Interact registry:** `HM.Interact = { kind: (obj, player) => void }` — the World creates interactables via `HM.World.makeInteractable(kind, x, y, extra)`
whose `interact()` dispatches to `HM.Interact[kind]`. Owners: World → `portal`; Items → `chest`, `shrine`, `merchant`; UI/Lore → `note`.

## Save (src/save.js — written)

`HM.Save`: `slot`, `data`, `list()`, `use(slot,name)`, `write()`, `erase(slot)`, `read(slot)`, `lastSlot()`, `setSetting(k,v)`, `setting(k,dflt)`, `applySettings()`,
`saveRunCheckpoint(run)`, `clearRun()`, `recordRunEnd(summary)` → ashes earned, `unlockCodex(id)`, `addBestiary(defId)`, `unlockAchievement(id)`, `addPlayTime(sec)`,
`exportSlot(slot)` → triggers a JSON file download, `pickImportFile()` → Promise `{ok,data,error,fileName}` (does NOT write), `commitImport(slot, data)`, `validate(obj)`, `storageOk`, `lastError`.
Slot data: `{game, version, slot, createdAt, updatedAt, profileName, playTime, settings{master,sfx,music,shake,glyphSize,damageNumbers,aimAssist,showFps,binds}, meta{ashes, ashesTotal, runs, wins, deaths, kills, bestFloor, bestTime, ascension, maxAscension, heirlooms{id:level}, codex{id:date}, bestiary{defId:n}, achievements{id:date}, heroesUnlocked[], heroStats{}}, run|null, history[]}`.

---

## Module APIs to implement

### World — `src/world.js` → `HM.World`  (owner: world agent; a first pass exists — extend it, keep the look)
- `generate({act, inAct, biome:'grass'|'candy'|'ice'|'fire'|'well', seed, ascension, isBoss, bossId, title})` → floor `F`:
  `{biomeId, biome(palette obj incl. name), w, h, cols, rows, start{x,y}, exit{x,y}, exitOpen, objective, spawns[{x,y,kind:'pack'|'elite'|'boss'|'snail', size, id}], interactables[], props[], ambient[r,g,b], isBoss, bossId}`.
  Also places (as interactables via `makeInteractable`): 1 `shrine`, 1–2 `chest`, 1 `note` (non-boss floors), 1 `merchant` when `inAct===2`, and the `portal` exit.
- `makeInteractable(kind, x, y, extra)` → `{kind,x,y,r,label,used,hidden,canInteract(p),interact(p)}` (dispatch to `HM.Interact[kind]`). Draw interactable props by kind (chest open/closed, shrine lit/spent, merchant stall + Choose Goose ASCII, note as glowing page, portal).
- `update(dt)`, `draw()`, `drawOver()` (fog/weather/foreground), `resolve(x,y,r,actor)`, `isSolid(x,y)`, `los(x0,y0,x1,y1)`, `randomOpenPoint(rng, F, nearX, nearY, minR, maxR)`.
- `BIOMES[id]` palettes; `World.floor` current floor.

### Rig — `src/rig.js` → `HM.Rig` (owner: rig agent; a first-pass humanoid exists — replace)
- `create(actor, rigId, opts)` sets `actor.rig`. `opts`: `{scale, colors:{...}, weapon:{kind, material, glyphs, color}}`. Rig IDs:
  heroes `finn marceline fp jake`; Act I `thrall archer hound snail`; Act II `husk bloater banana`; Act III `penguin golem wisp`;
  Act IV `elemental cinder brute`; Act V `knight priest wraith`; bosses `boneDragon lemongrab iceKing flameKing lich`; npc `goose`.
- `update(actor, dt)` (walk phase, verlet cloth/hair/beard/cape, debris physics), `draw(actor)`, `setAnim(actor, state, {dur, variant})`, `phase(actor)` → 0..1,
  `onDeath(actor, info)` (debris / bone pile / collapse; actor.removeMe=true when finished for non-players), `weaponTip(actor)` → world `[x,y,z]`, `trigger(actor, name)`.
- `actor.anim = {state, t, dur, variant, speed01}`. States: `idle attack cast channel dodge hit stun dead spawn special`; walking is blended from `speed01`.
  Attack timing convention: **anticipation 0–30% of dur, strike 30–50%, recovery 50–100%** (controllers deal damage at ≈35%).
  Variants used by controllers: attack: `slash1 slash2 slash3 heavy thrust overhead spin bite claw shoot slam breath punch stretch`; cast: `raise forward channel summon`;
  dodge: `roll dash bat`. Unknown variants must fall back gracefully.
- `actor.weapon = {kind:'sword'|'axe'|'bass'|'staff'|'wand'|'bow'|'spear'|'claws'|'fists'|'none', material, glyphs, color}` — rig draws it with the material's glyphs/colors from `HM.Items.MATERIALS[material]` (`{name, glyphs, color:[r,g,b], emissive}`) with a fallback table of its own.

### FX — `src/fx.js` → `HM.FX` (owner: fx/audio agent)
`update(dt) drawGround() draw() clear()`, `burst(x,y,z,preset,n,opts)` presets `ember spark blood bone poison ice dust sugar smoke ash shadow holy gold rot witchfire lightning`,
`emit(particle)`, `number(target, amount, type, crit, isDot)`, `text(x,y,z,str,rgb,scale)`, `floaters[]` (`{x,y,z,text,rgb,size,t,life,crit,kind}` — drawn by UI),
`shake(amount)`, `shakeOffset()`, `hitSpark(target, info)`, `statusAura(actor, status, dt)`,
`swing({actor,x,y,z,a0,a1,r0,r1,dur,life,color,glyphs,emissive,width})` crescent trail, `telegraph({shape:'circle'|'ring'|'line'|'cone'|'rect',x,y,r,ang,len,w,half,dur,color,onDone})` → handle `{cancel()}`,
`fissure({x,y,ang,prongs,spread,len,color,onErupt(points)})`, `explosion(x,y,r,kind)`, `ring(x,y,r0,r1,dur,color)`, `light(x,y,z,radius,rgb,intensity,dur)`,
`decal(x,y,kind,r,life)` (`scorch blood rot frost witch crack bones`), `ghost(actor,dur)` afterimage, `beam(x0,y0,x1,y1,{w,color,dur,glyphs})`,
`drawProjectile(p)` by `p.look` (`fireball arrow bolt ice poison shadow bone sonic witchfire lemon sugar ember bat`), `drawZone(z)` by `z.kind` (`fire poison rot ice shadow witchfire sugar flamering`).

### Audio — `src/audio.js` → `HM.Audio` (owner: fx/audio agent)
`init()` (first user gesture; must no-op when AudioContext is missing), `play(name, {x,y,vol,pitch})`, `ambient(biomeId|'title', isBoss)`, `music(id)`, `setVolumes({master,sfx,music})`, `stopAll()`.
SFX names: `hit crit hit_fire hit_ice hit_poison hit_shadow hit_holy shatter swing swing_heavy dodge step fire fireball explode ice poison bone_break death death_big
pickup gold levelup portal boon ui_move ui_select ui_back ui_error bossRoar zombie wenk lich_laugh shriek sonic bat jake_stretch potion chest shrine note door heartbeat`.
All procedural (WebAudio oscillators/noise/filters). Positional pan/volume from player distance.

### Items & Boons & Meta — `src/items.js` → `HM.Items`, `HM.Boons`, `HM.Meta` (owner: items agent)
- `MATERIALS` (iron steel bronze silver gold moonsteel nightglass bloodiron ossite emberstone + grass demonblood crystal candy glacial; each `{name, glyphs, color, emissive?, mods}`),
  `RUNES` (elemental/utility; add element damage, tint swing trails), `RARITIES` (`common magic rare legendary cursed` with colors), `BASES` (weapons per hero kind, armor, trinkets).
- Item: `{uid, baseId, name, slot:'weapon'|'armor'|'trinket', kind, heroes[], material, rarity, level, dmg:[min,max], speed, mods:[{stat,value}], runes:[], sockets, flavor, glyph, value}`.
- `newInventory(heroId, meta)`, `rollItem({floorIndex, slot, heroId, rarityBias, rng})`, `rollDrops(actor, run)`, `dropItem(x,y,item)`, `dropGold(x,y,n)`, `dropConsumable(x,y,kind)`,
  `updatePickups(dt)`, `drawPickups()` (glyph icon + bounce + light pillar for rare+; labels drawn by UI from `Game.pickups[].label/labelColor`),
  `applyStats(player)` (equipment → `player.stats`, `player.weapon`, `player.weaponDmg`), `equip(run, uid)`, `unequip(run, slot)`, `discard(run, uid)`, `socketRune(run, itemUid, runeId)`,
  `describe(item)` → `[{text, color}]`, `useConsumable(player, 'pancake'|'tonic')`, `populate(floor, run)`, `shopStock(run)`, `buy(run, index)`, `applyHeirloomsToRun(run, meta)`.
  Registers `HM.Interact.chest`, `HM.Interact.shrine`, `HM.Interact.merchant` (merchant → `Game.setState('shop', {stock})`).
- Pickup objects in `Game.pickups`: `{x,y,z,kind:'item'|'gold'|'pancake'|'tonic', item, amount, label, labelColor, r, t, canInteract, interact(p)}` (gold auto-collects on proximity).
- `HM.Boons`: `pool[]` (`{id, name, giver, desc, rarity, tags, heroes?, apply(player, run), hooks?}` — givers are Ooo entities, e.g. Prismo, Cosmic Owl, Billy, Gunter, Hunson, Bubblegum, Peppermint Butler, Death),
  `draft(run, n)`, `take(run, id)`, `apply(player, run)` (called from `Heroes.recompute`), `describe(id)`.
- `HM.Meta`: heirlooms `list[]` `{id, name, desc, maxLevel, cost(level), apply(player|run)}`, `buy(id)` (spends `Save.data.meta.ashes`), `level(id)`.

### Heroes — `src/heroes.js` → `HM.Heroes` (owner: heroes agent)
- `list` `[{id:'finn'|'marceline'|'fp', name, title, blurb, color:[r,g,b], difficulty, kit:[{slot, name, desc}]}]`, `Player` class (extends `HM.Actor`).
- `createPlayer(run)` → Player (restores `run.hp/mp` if not null, else full; calls `recompute`), `recompute(player)` (base hero stats + level growth + `Items.applyStats` + `Boons.apply` + heirlooms), `onLevelUp(player, run)`.
- Player exposes for UI: `player.heroId`, `player.title`, `player.skills = [{slot:'attack'|'heavy'|'skill1'|'skill2'|'ult', action, name, icon, cd, cdLeft, cost, costType, desc}]`,
  `player.resource = {name, value, max, color}` (MP; Flame Princess uses Temper), `player.potionCd`.
- Controller rules (from DESIGN §3): ADSR movement, mouse aim, buffered verbs via `Input.consume`, cancel windows (dodge cancels recovery), weak melee aim assist, i-frames on dodge, potions on 1/2 (`Items.useConsumable`).

### Enemies — `src/enemies.js` → `HM.Enemies` (owner: enemies agent)
- `defs` registry (≥ 15 types across 5 acts — see DESIGN §2), `Enemy` base class (AI helpers), `spawn(defId, x, y, opts)`, `populate(floor, run)` (packs scaled by floor/ascension;
  elite pack with affixes; `snail` spawn; boss spawn → `HM.Bosses.spawn(id, x, y, floor)`), `scale(def, floorIndex, ascension)`, `titleDressing(floor)` (idle actors for the title backdrop).
- Barks via `HM.UI.bark(actor, text)` using `HM.Lore.barks[defId]`.

### Bosses — `src/bosses.js` → `HM.Bosses` (owner: bosses agent)
- `defs`, `spawn(id, x, y, floor)` → boss actor (`kind:'boss', isBoss:true, team:1, displayName, title, phase, phaseCount`), 5 bosses: `boneDragon lemongrab iceKing flameKing lich`.
  Each: 3 phases (phase thresholds 66% / 33%), attack & cast speed rise per phase, telegraphed patterns (FX.telegraph), intro (`HM.UI.banner`, `Audio.play('bossRoar')`, `Audio.music('boss')`), death sequence.

### UI & Lore — `src/ui.js` → `HM.UI`, `src/lore.js` → `HM.Lore` (owner: UI agent)
- `HM.UI.init(canvas)`, `resize()`, `update(dt)` (owns ALL menu input; Esc toggles pause in play; Tab/I inventory), `draw()`; helpers `banner(title, sub, dur)`, `toast(text, color, dur)`, `bark(actor, text, dur)`, `showNote(entry)`, `confirm(text, onYes, onNo)`.
- Screens: title (Continue / New Run / Profiles / Options / Codex / Heirlooms), slots (3 slots: new/load/rename/delete/**Export**/**Import**), heroSelect, HUD (player frame w/ ASCII portrait, HP/MP segmented bars, LV·gold, hotbar with key labels + cooldown sweeps, XP bar `LV 14 · 267 / 6201 XP`,
  target frame, boss bar w/ phase, name tags + enemy HP bars, damage numbers from `FX.floaters`, pickup labels, interact prompt `[F] …`, crosshair with 3 states, floor banner, minimal objective text), pause (resume/options/abandon/quit), inventory/character (equip, compare tooltips, runes), boon draft, shop, dead (epitaph + stats + ashes), victory, options (volumes, shake, glyph size, damage numbers, aim assist, **key remapping**), codex (lore pages, bestiary, achievements), heirlooms (meta shop).
- `HM.Lore`: `acts`, `floorIntro(act, inAct)`, `bossIntro(id)`, `notes[]` (`{id, act, title, text}` — Enchiridion pages & Simon's journal etc., original text), `barks{defId:[...]}`, `epitaph(run, killedBy, hero)`, `itemFlavor(item)`, `victory`, `heroBlurbs`, `achievements[]`.
  Registers `HM.Interact.note` (unlock codex via `Save.unlockCodex`, show note).

---

## Integration notes (post-integration pass — binding for further work)

- **Figure scale:** `HM.cfg.FIG_SCALE` (1.3) and `HM.cfg.BOSS_FIG_SCALE` (1.1, also used for `isDecoy` actors) are multiplied into
  `rig.sc` by `HM.Rig` (create + every update), and `actor.height` follows. Gameplay radii/ranges are NOT scaled. Anything that
  places effects on a body should use `actor.height` or `Rig.joint()` rather than hard-coded z values.
- **Projectiles** stop only at walls/props (`World.isWall`); they fly over water, lava and void. `p.light` is added at draw time
  (FX.drawProjectile, or Game.draw for projectiles with a custom `p.draw`) — never call `R.light` during update.
- **Zones that deal damage over time** tag it `tags: ['zone']` (Marceline's passive halves it).
- **Fear:** `actor.fearT` (seconds) + `actor.fearFrom` make non-neutral `Enemy`s drop their attack and flee (Enemies.fearAI).
- **Neutral/hidden actors** (`a.neutral`, e.g. the Waving Snail; `a.hidden`) are skipped by `Combat.assistAim` and `Combat.nearestHostile`.
- **Heartbeat** is owned by `HM.Audio.tick` only. **Level-up**: FX draws the ring/burst, Heroes floats `LEVEL n`, UI toasts.
- **Map edge** (DESIGN §8): `World.draw` never samples the map out of bounds — the edge dissolves over ~4 cells into void with sparse motes.
- **Minimap / big map** (DESIGN §8) live in `HM.UI` (terrain baked once per floor from `World.groundAt`/`isWall`, fog-of-war per floor,
  `M` = `map` action toggles the overlay, Options → Minimap). Interactables get `o._mapSeen` once revealed.
- **Hints** (DESIGN §9B) live in `HM.UI` (`meta.hintsSeen`, Options → Hints). **Descent track** (§9D) shows on Pause and Boon screens.
- **Settings** added to the slot schema: `minimap`, `hints` (booleans, default true). Meta adds `hintsSeen{}`.
- **Perf note:** every module aliases `const Math = globalThis.Math` inside its IIFE. In the Node smoke VM every global lookup goes
  through a slow interceptor; the alias makes smoke ms/frame match real browser JS cost (~3.5–4 ms/frame measured in headless Chrome).
  Keep hot loops free of other global lookups (cache typed-array constructors, `Infinity`, etc. in closure consts).
