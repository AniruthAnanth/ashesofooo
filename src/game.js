// game.js — state machine, run flow (15 floors / 5 acts), entity management, camera, timers, hitstop.
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const HM = (globalThis.window || globalThis).HM;
  const M = HM.M, Input = HM.Input;

  const ACTS = [
    { act: 1, biome: 'grass',  name: 'The Grasslands',       boss: 'boneDragon' },
    { act: 2, biome: 'candy',  name: 'The Candy Necropolis', boss: 'lemongrab' },
    { act: 3, biome: 'ice',    name: 'The Ice Kingdom',      boss: 'iceKing' },
    { act: 4, biome: 'fire',   name: 'The Fire Kingdom',     boss: 'flameKing' },
    { act: 5, biome: 'well',   name: "The Lich's Well",      boss: 'lich' },
  ];
  const FLOORS = 15;

  const Game = (HM.Game = {
    ACTS, FLOORS,
    state: 'boot', prevState: null, stateT: 0,
    t: 0, dt: 0, realT: 0, timeScale: 1, hitstopT: 0, slowT: 0, slowScale: 1,
    run: null, floor: null, player: null,
    entities: [], projectiles: [], zones: [], pickups: [], timers: [],
    cam: { x: 0, y: 0 },
    interactTarget: null,
    deathT: 0, killer: null,
    menuData: null,   // state-specific data for UI (boon draft, shop stock, ...)
    fps: 60,

    // --------------------------------------------------------------- lifecycle
    init() {
      HM.Events.on('kill', (e) => Game._onKill(e));
      HM.Events.on('damage', (info) => {
        if (!Game.run) return;
        if (info.source && info.source.kind === 'player') Game.run.stats.dealt += info.dealt;
        if (info.target.kind === 'player') { Game.run.stats.taken += info.dealt; if (!info.isDot) Game.lastHitBy = info.source; }
      });
      Game.setState('title');
      Game.titleScene();
    },

    setState(s, data) {
      Game.prevState = Game.state; Game.state = s; Game.stateT = 0;
      if (data !== undefined) Game.menuData = data;
      Input.clearBuffer();
      HM.Events.emit('state', { state: s, prev: Game.prevState, data });
    },

    // Backdrop for title/menus: a generated floor with a slow drifting camera.
    titleScene() {
      Game.clearWorld();
      try {
        Game.floor = HM.World.generate({ act: 1, inAct: 1, biome: 'grass', seed: 1337, title: true, ascension: 0 });
      } catch (e) { console.error(e); Game.floor = null; }
      if (Game.floor) { Game.cam.x = Game.floor.start.x; Game.cam.y = Game.floor.start.y; HM.R.ambient = Game.floor.ambient || [1, 1, 1]; }
      if (HM.Enemies && HM.Enemies.titleDressing && Game.floor) { try { HM.Enemies.titleDressing(Game.floor); } catch (e) { console.error(e); } }
      HM.Audio && HM.Audio.ambient && HM.Audio.ambient('title');
    },

    clearWorld() {
      if (HM.Tutorial && HM.Tutorial.stop) HM.Tutorial.stop();
      Game.entities = []; Game.projectiles = []; Game.zones = []; Game.pickups = []; Game.timers = [];
      Game.player = null; Game.interactTarget = null;
      HM.FX && HM.FX.clear && HM.FX.clear();
    },

    // --------------------------------------------------------------- run flow
    // floor 0 is the prologue (act I scenery, no act of its own)
    actInfo(floorIndex) {
      if (!(floorIndex >= 1)) return Object.assign({}, ACTS[0], { inAct: 0, name: 'Prologue', boss: null, prologue: true });
      const act = Math.ceil(floorIndex / 3); return Object.assign({ inAct: ((floorIndex - 1) % 3) + 1 }, ACTS[act - 1]);
    },

    // A fresh run object (heirlooms applied). Also used to rebuild the run after the prologue sandbox.
    makeRun(heroId, opts) {
      opts = opts || {};
      const seed = opts.seed || ((Date.now() ^ (Math.random() * 1e9)) >>> 0);
      const meta = HM.Save.data ? HM.Save.data.meta : null;
      const run = {
        seed, heroId, floorIndex: 1, level: 1, xp: 0, gold: 0, kills: 0, time: 0,
        boons: [], boonPoints: 0, ascension: opts.ascension || 0,
        hp: null, mp: null,
        inventory: HM.Items.newInventory(heroId, meta),
        consumables: { pancake: 2, tonic: 1 },
        codexThisRun: [], elitesKilled: 0, bossesKilled: [],
        stats: { dealt: 0, taken: 0 },
        startedAt: opts.startedAt || new Date().toISOString(),
      };
      if (HM.Items.applyHeirloomsToRun && meta) HM.Items.applyHeirloomsToRun(run, meta);
      return run;
    },

    // opts: {seed, ascension, prologue} — prologue:true plays "The Tree Fort Clearing" (floor 0) first.
    newRun(heroId, opts) {
      opts = opts || {};
      Game.run = Game.makeRun(heroId, opts);
      if (HM.Save.data) HM.Save.write();
      if (opts.prologue) Game.enterPrologue();
      else Game.enterFloor(1);
    },

    resumeRun() {
      const r = HM.Save.data && HM.Save.data.run; if (!r) return false;
      Game.run = JSON.parse(JSON.stringify(r));
      Game.enterFloor(Game.run.floorIndex, { resumed: true });
      return true;
    },

    enterFloor(i, opts) {
      if (!(i >= 1)) { Game.enterPrologue(opts); return; }
      const run = Game.run; run.floorIndex = i;
      const info = Game.actInfo(i);
      Game.clearWorld();
      Game.floor = HM.World.generate({ act: info.act, inAct: info.inAct, biome: info.biome, seed: (run.seed ^ Math.imul(i, 7919)) >>> 0, ascension: run.ascension, isBoss: info.inAct === 3, bossId: info.boss });
      Game.floor.act = info.act; Game.floor.inAct = info.inAct; Game.floor.index = i; Game.floor.actName = info.name;
      HM.R.ambient = Game.floor.ambient || [1, 1, 1];
      const p = (Game.player = HM.Heroes.createPlayer(run));
      p.x = Game.floor.start.x; p.y = Game.floor.start.y;
      Game.entities.push(p);
      Game.cam.x = p.x; Game.cam.y = p.y; Game.clampCam();
      HM.Enemies.populate(Game.floor, run);
      if (HM.Items.populate) HM.Items.populate(Game.floor, run);
      // checkpoint: the run as it stands at the start of this floor
      run.hp = p.hp; run.mp = p.mp;
      HM.Save.saveRunCheckpoint(run);
      Game.deathT = 0; Game.killer = null; Game.lastHitBy = null;
      Game.setState('play');
      const resumed = !!(opts && opts.resumed);
      HM.Events.emit('floorStart', { floor: Game.floor, run, resumed });
      // each act opens with its act card (DESIGN §9D). UI dedupes per run+act (its floorStart handler may already have
      // opened it); quick-start test URLs (?hero=…) skip cards unless ?actcard=1, so staged screenshots stay unfrozen.
      if (info.inAct === 1 && !resumed && Game._actCardsOn() && HM.UI && typeof HM.UI.actCard === 'function' && !(HM.UI.card && HM.UI.card.act === info.act)) {
        try { HM.UI.actCard(info.act); } catch (e) { console.error(e); }
      }
      HM.Audio && HM.Audio.ambient && HM.Audio.ambient(Game.floor.biomeId || Game.floor.biome, Game.floor.isBoss);
    },
    _actCardsOn() { const P = HM.params || {}; if (P.actcard === '0') return false; return !(P.hero && P.actcard !== '1'); },

    // The prologue (DESIGN §9A): floor index 0, World.generate({prologue:true}) (falls back to an ordinary grass floor that
    // HM.Tutorial lays its beats onto), no packs or loot; HM.Tutorial drives the beats and the objective line.
    enterPrologue(opts) {
      const run = Game.run; run.floorIndex = 0;
      Game.clearWorld();
      const seed = (run.seed ^ 0x51a7e) >>> 0;
      let F = null;
      try { F = HM.World.generate({ prologue: true, act: 1, inAct: 1, biome: 'grass', seed, ascension: 0 }); } catch (e) { console.error(e); F = null; }
      if (!F) F = HM.World.generate({ act: 1, inAct: 1, biome: 'grass', seed, ascension: 0 });
      const P = (HM.Lore && HM.Lore.prologue) || {};
      F.isPrologue = true; F.isBoss = false; F.act = 1; F.inAct = 0; F.index = 0; F.actName = 'Prologue';
      F.title = F.title || P.title || 'The Tree Fort Clearing'; F.sub = F.sub || P.sub || 'before the descent';
      Game.floor = F;
      HM.R.ambient = F.ambient || [1, 1, 1];
      const p = (Game.player = HM.Heroes.createPlayer(run));
      const st = (F.beats && F.beats.start) || F.start;
      p.x = st.x; p.y = st.y; p.facing = -Math.PI / 2;
      Game.entities.push(p);
      Game.cam.x = p.x; Game.cam.y = p.y - 10; Game.clampCam();
      // checkpoint at floor 0: quitting mid-prologue and pressing Continue replays the prologue
      run.hp = p.hp; run.mp = p.mp;
      HM.Save.saveRunCheckpoint(run);
      Game.deathT = 0; Game.killer = null; Game.lastHitBy = null;
      Game.setState('play');
      HM.Events.emit('floorStart', { floor: F, run, resumed: !!(opts && opts.resumed), prologue: true });
      if (HM.Tutorial && HM.Tutorial.start) { try { HM.Tutorial.start(run); } catch (e) { console.error(e); } }
      HM.Audio && HM.Audio.ambient && HM.Audio.ambient('grass', false);
    },
    // HM.Tutorial.finish (door or Skip Prologue) → the prologue was a sandbox: a fresh run (same hero/seed) starts floor 1.
    finishPrologue() {
      const r = Game.run; if (!r) return;
      Game.run = Game.makeRun(r.heroId, { seed: r.seed, ascension: r.ascension, startedAt: r.startedAt });
      Game.enterFloor(1);
    },

    openExit(reason) {
      if (!Game.floor || Game.floor.exitOpen) return;
      Game.floor.exitOpen = true;
      HM.Events.emit('exitOpen', { floor: Game.floor, reason });
      HM.Audio && HM.Audio.play('portal');
    },

    // Called when the player uses the open exit.
    descend() {
      if (Game.floor && Game.floor.isPrologue) {
        if (HM.Tutorial && HM.Tutorial.active && HM.Tutorial.finish) HM.Tutorial.finish(false); else Game.finishPrologue();
        return;
      }
      const run = Game.run; const p = Game.player;
      run.hp = p.hp; run.mp = p.mp;
      HM.Events.emit('floorClear', { floor: Game.floor, run });
      if (run.floorIndex >= FLOORS) { Game.victory(); return; }
      if (run.boonPoints > 0 && HM.Boons) { Game.openBoonDraft(); return; }
      Game.enterFloor(run.floorIndex + 1);
    },
    openBoonDraft() {
      const draft = HM.Boons.draft(Game.run, 3);
      if (!draft || !draft.length) { Game.run.boonPoints = 0; Game.enterFloor(Game.run.floorIndex + 1); return; }
      Game.setState('boon', { draft, rerolls: Game.run.rerolls || 0 });
    },
    chooseBoon(boonId) {
      const run = Game.run; HM.Boons.take(run, boonId); run.boonPoints = Math.max(0, run.boonPoints - 1);
      HM.Audio && HM.Audio.play('boon');
      if (run.boonPoints > 0) Game.openBoonDraft(); else Game.enterFloor(run.floorIndex + 1);
    },
    rerollBoons() { const run = Game.run; if (!(run.rerolls > 0)) return false; run.rerolls--; Game.openBoonDraft(); return true; },

    victory() {
      const run = Game.run;
      const ashes = HM.Save.recordRunEnd({ heroId: run.heroId, floorIndex: run.floorIndex, act: 5, killedBy: null, kills: run.kills, time: run.time, gold: run.gold, level: run.level, victory: true, ascension: run.ascension });
      HM.Save.unlockAchievement('slay_lich');
      Game.setState('victory', { ashes, run });
    },

    onPlayerDeath() {
      const run = Game.run;
      // the prologue is not a real run: nothing is recorded (HM.Tutorial keeps the hero alive; this is a failsafe)
      if (Game.floor && Game.floor.isPrologue) {
        if (Game.player && Game.player.dead) { Game.enterPrologue(); return; }
        Game.run = null; HM.Save.clearRun(); Game.setState('title'); Game.titleScene(); return;
      }
      const k = Game.lastHitBy;
      const killedBy = k ? (k.fullName || k.displayName || k.name || k.defId || 'something') : 'the dark';
      const ashes = HM.Save.recordRunEnd({ heroId: run.heroId, floorIndex: run.floorIndex, act: Game.floor.act, killedBy, kills: run.kills, time: run.time, gold: run.gold, level: run.level, victory: false, ascension: run.ascension });
      Game.setState('dead', { ashes, run, killedBy, killer: k });
    },

    abandonRun() { if (Game.run && Game.player && !Game.player.dead) { Game.lastHitBy = null; Game.onPlayerDeath(); } },
    quitToTitle() { if (Game.run && Game.state !== 'dead' && Game.state !== 'victory') HM.Save.write(); Game.run = null; Game.setState('title'); Game.titleScene(); },

    // --------------------------------------------------------------- progression
    xpToNext(level) { return Math.round(30 + 22 * Math.pow(level, 1.55)); },
    grantXP(n) {
      const run = Game.run, p = Game.player; if (!run || !p || p.dead) return;
      run.xp += n;
      while (run.xp >= Game.xpToNext(run.level)) {
        run.xp -= Game.xpToNext(run.level); run.level++; run.boonPoints++;
        if (HM.Heroes.onLevelUp) HM.Heroes.onLevelUp(p, run);
        HM.Events.emit('levelup', { level: run.level, player: p });
        HM.Audio && HM.Audio.play('levelup');
      }
    },
    addGold(n) { if (!Game.run) return; Game.run.gold += n; HM.Events.emit('gold', { amount: n }); },

    _onKill(e) {
      const t = e.target; const run = Game.run; if (!run) return;
      if (t.kind === 'player') return;
      // prologue kills are a sandbox: no XP, loot, bestiary, kill count or boon points
      if (Game.floor && Game.floor.isPrologue) { if (HM.Tutorial && HM.Tutorial.onKill) HM.Tutorial.onKill(e); return; }
      if (t.isBoss) Game._bossDefeatLine(t);
      if (t.team === 1) {
        run.kills++;
        if (!t.isDecoy && !(e.info && e.info.collapse)) HM.Save.addBestiary(t.defId);
        Game.grantXP(t.xpValue || 0);
        if (HM.Items.rollDrops) HM.Items.rollDrops(t, run);
        if (t.isElite) { run.elitesKilled++; run.boonPoints++; }
        if (t.isBoss) { run.bossesKilled.push(t.defId); run.boonPoints++; }
        const obj = Game.floor && Game.floor.objective;
        if (obj && !obj.done) {
          if ((obj.type === 'elite' && t.isElite) || (obj.type === 'boss' && t.isBoss)) { obj.remaining = Math.max(0, (obj.remaining || 1) - 1); if (obj.remaining <= 0) { obj.done = true; Game.openExit(obj.type); } }
          if (obj.type === 'clear') { const left = Game.entities.filter((a) => a.team === 1 && !a.dead).length; if (left === 0) { obj.done = true; Game.openExit('clear'); } }
        }
      }
    },

    // Boss defeat line (HM.Lore.bossDefeat). The UI folds it into the boss's VANQUISHED banner; if no such banner shows
    // up shortly after the kill (e.g. a stand-in boss without a death sequence), narrate it ourselves.
    _bossDefeatLine(b) {
      const L = HM.Lore && HM.Lore.bossDefeat; const line = L && (L[b.defId] || L[b.bossId]);
      if (!line || !HM.UI) return;
      const floor = Game.floor;
      Game.after(1.8, () => {
        if (Game.floor !== floor || !HM.UI) return;
        const shown = (HM.UI.banners || []).some((bn) => bn && /VANQUISH/i.test(String(bn.kicker || '')));
        if (shown) return;
        const name = b.displayName || b.name || 'The guardian';
        if (HM.UI.banner) HM.UI.banner(name, '', 6.5, { kicker: 'VANQUISHED', intro: [line] });
        else if (HM.UI.toast) HM.UI.toast(line, '#e8dcc0', 5);
      });
    },

    // Camera clamp: near a map edge the void beyond it may fill at most ~30% of the view, so the end of the world stays
    // visible (DESIGN §8) without the camera drifting out over nothing.
    clampCam() {
      const F = Game.floor, R = HM.R; if (!F || !(F.w > 0) || !(F.h > 0) || !R || !(R.viewW > 0)) return;
      const TILT = HM.cfg.TILT || 0.75, VOID = 0.3;
      const hw = R.viewW / 2, hh = R.viewH / TILT / 2;
      const mx = hw * (1 - 2 * VOID), my = hh * (1 - 2 * VOID);
      Game.cam.x = F.w < 2 * mx ? F.w / 2 : M.clamp(Game.cam.x, mx, F.w - mx);
      Game.cam.y = F.h < 2 * my ? F.h / 2 : M.clamp(Game.cam.y, my, F.h - my);
    },

    // --------------------------------------------------------------- entities
    spawn(a) { Game.entities.push(a); return a; },
    hitstop(sec) { Game.hitstopT = Math.max(Game.hitstopT, Math.min(sec, 0.12)); },
    slowmo(sec, scale) { Game.slowT = Math.max(Game.slowT, sec); Game.slowScale = scale; },
    after(sec, fn) { Game.timers.push({ t: sec, fn }); },
    enemiesAlive() { let n = 0; for (const a of Game.entities) if (a.team === 1 && !a.dead) n++; return n; },
    bossesAlive() { return Game.entities.filter((a) => a.isBoss && !a.dead); },

    // --------------------------------------------------------------- frame
    update(realDt) {
      Game.realT += realDt; Game.stateT += realDt;
      Game.fps = M.lerp(Game.fps, 1 / Math.max(realDt, 1e-4), 0.05);
      HM.UI && HM.UI.update && HM.UI.update(realDt);
      if (Game.state === 'play') Game.updatePlay(realDt);
      else if (Game.state === 'title' || Game.state === 'slots' || Game.state === 'heroSelect' || Game.state === 'options' || Game.state === 'codex' || Game.state === 'heirlooms') Game.updateBackdrop(realDt);
      if (HM.Save.data && (Game.state === 'play')) HM.Save.addPlayTime(realDt);
    },

    updateBackdrop(dt) {
      Game.t += dt;
      if (Game.floor) {
        Game.cam.x += Math.cos(Game.t * 0.05) * 9 * dt + 6 * dt; Game.cam.y += Math.sin(Game.t * 0.07) * 6 * dt;
        HM.World.update && HM.World.update(dt);
        for (const a of Game.entities) { a.update(dt); HM.Rig && HM.Rig.update && HM.Rig.update(a, dt); }
        HM.FX && HM.FX.update && HM.FX.update(dt);
      }
    },

    updatePlay(realDt) {
      // pause / inventory toggles are handled by UI (it owns menu input), but keep a failsafe here
      let dt = realDt;
      if (Game.hitstopT > 0) { Game.hitstopT -= realDt; dt = 0; }
      if (Game.slowT > 0) { Game.slowT -= realDt; dt *= Game.slowScale; }
      dt *= Game.timeScale;
      Game.dt = dt; Game.t += dt;
      const run = Game.run; if (run) run.time += dt;

      // timers
      for (let i = Game.timers.length - 1; i >= 0; i--) { const tm = Game.timers[i]; tm.t -= dt; if (tm.t <= 0) { Game.timers.splice(i, 1); try { tm.fn(); } catch (e) { console.error(e); } } }

      // prologue beats (before the actors, so its verb locks apply before the controller reads input)
      if (HM.Tutorial && HM.Tutorial.active) HM.Tutorial.update(dt);
      if (Game.state !== 'play') return; // the tutorial may have finished the prologue (→ floor 1) this frame

      HM.World.update && HM.World.update(dt);
      const ents = Game.entities;
      for (let i = 0; i < ents.length; i++) { const a = ents[i]; a.update(dt); HM.Rig && HM.Rig.update && HM.Rig.update(a, dt); }
      Game.separate(dt);
      for (const p of Game.projectiles) if (!p.dead) HM.Combat.updateProjectile(p, dt);
      for (const z of Game.zones) if (!z.dead) HM.Combat.updateZone(z, dt);
      HM.Items.updatePickups && HM.Items.updatePickups(dt);
      HM.FX && HM.FX.update && HM.FX.update(dt);

      // cleanup
      Game.entities = ents.filter((a) => !a.removeMe);
      Game.projectiles = Game.projectiles.filter((p) => !p.dead);
      Game.zones = Game.zones.filter((z) => !z.dead);

      // interaction
      Game.updateInteract();

      // camera: follow player with a lead toward the aim point
      const p = Game.player;
      if (p) {
        const [mx, my] = HM.R.screenToWorld(Input.mouse.sx, Input.mouse.sy);
        const lead = 0.16; let lx = (mx - p.x) * lead, ly = (my - p.y) * lead; const ll = Math.hypot(lx, ly); if (ll > 70) { lx *= 70 / ll; ly *= 70 / ll; }
        Game.cam.x = M.damp(Game.cam.x, p.x + lx, 7, realDt);
        Game.cam.y = M.damp(Game.cam.y, p.y + ly - 10, 7, realDt);
        Game.clampCam();
        if (p.dead) { Game.deathT += realDt; if (Game.deathT > 2.2 && Game.state === 'play') Game.onPlayerDeath(); }
      }
      HM.R.hurt = p && !p.dead ? M.clamp((0.35 - p.hp01) * 2.6, 0, 1) * (0.75 + 0.25 * Math.sin(Game.realT * 6)) : p && p.dead ? 0.8 : 0;
    },

    // soft actor-actor separation
    separate(dt) {
      const ents = Game.entities; const n = ents.length;
      for (let i = 0; i < n; i++) {
        const a = ents[i]; if (a.dead || a.noCollide) continue;
        for (let j = i + 1; j < n; j++) {
          const b = ents[j]; if (b.dead || b.noCollide) continue;
          const dx = b.x - a.x, dy = b.y - a.y; const rr = a.radius + b.radius;
          const d2 = dx * dx + dy * dy; if (d2 >= rr * rr || d2 < 1e-6) continue;
          const d = Math.sqrt(d2), push = (rr - d) * 0.5;
          const nx = dx / d, ny = dy / d;
          const wa = b.mass / (a.mass + b.mass), wb = a.mass / (a.mass + b.mass);
          if (!a.anchored) HM.Combat.move(a, -nx * push * wa * 2, -ny * push * wa * 2);
          if (!b.anchored) HM.Combat.move(b, nx * push * wb * 2, ny * push * wb * 2);
        }
      }
    },

    updateInteract() {
      const p = Game.player; Game.interactTarget = null; if (!p || p.dead) return;
      let best = null, bd = 1e9;
      const consider = (o) => { if (!o || o.used || o.hidden || (o.canInteract && !o.canInteract(p))) return; const d = M.dist(p.x, p.y, o.x, o.y); const r = o.r || 34; if (d < r + p.radius && d < bd) { bd = d; best = o; } };
      if (Game.floor && Game.floor.interactables) for (const o of Game.floor.interactables) consider(o);
      for (const o of Game.pickups) consider(o);
      Game.interactTarget = best;
      if (best && Input.consume('interact')) { try { best.interact(p); } catch (e) { console.error(e); } }
    },

    draw() {
      const R = HM.R;
      const sh = HM.FX && HM.FX.shakeOffset ? HM.FX.shakeOffset() : [0, 0];
      R.beginFrame(Game.cam.x + sh[0], Game.cam.y + sh[1], Game.dt || 0.016);
      if (Game.floor) {
        HM.World.draw();
        R.snapshotGround && R.snapshotGround(); // ground layer copy (lets the renderer keep figure outlines thin)
        HM.FX && HM.FX.drawGround && HM.FX.drawGround();
        if (HM.Tutorial && HM.Tutorial.active) HM.Tutorial.draw();
        for (const z of Game.zones) { if (z.draw) z.draw(z); else HM.FX && HM.FX.drawZone && HM.FX.drawZone(z); }
        HM.Items.drawPickups && HM.Items.drawPickups();
        for (const a of Game.entities) if (R.inViewWorld(a.x, a.y, 160)) a.draw();
        for (const p of Game.projectiles) {
          if (p.draw) { p.draw(p); if (p.light) R.light(p.x, p.y, p.z, p.light[0], p.light[1], p.light[2], p.light[3], 1); }
          else HM.FX && HM.FX.drawProjectile && HM.FX.drawProjectile(p);
        }
        HM.FX && HM.FX.draw && HM.FX.draw();
        HM.World.drawOver && HM.World.drawOver();
      }
      R.endFrame(Game.dt || 0.016);
      HM.UI && HM.UI.draw && HM.UI.draw();
    },
  });
})();
