// save.js — localStorage save slots (3), autosave checkpoints, export/import JSON files with validation.
(function () {
  'use strict';
  const HM = (globalThis.window || globalThis).HM;

  const PREFIX = 'ashesOfOoo.slot.';
  const LAST = 'ashesOfOoo.lastSlot';
  const VERSION = 1;
  const SLOTS = [1, 2, 3];

  // localStorage may be unavailable (privacy mode, file:// quirks) — fall back to memory.
  const mem = {};
  let storageOk = true;
  const store = {
    get(k) { try { return globalThis.localStorage ? localStorage.getItem(k) : mem[k] ?? null; } catch (e) { storageOk = false; return mem[k] ?? null; } },
    set(k, v) { try { if (globalThis.localStorage) localStorage.setItem(k, v); else mem[k] = v; return true; } catch (e) { storageOk = false; mem[k] = v; return e; } },
    del(k) { try { if (globalThis.localStorage) localStorage.removeItem(k); delete mem[k]; } catch (e) { delete mem[k]; } },
  };

  function defaults(slot, name) {
    const now = new Date().toISOString();
    return {
      game: 'ashes-of-ooo', version: VERSION, slot,
      createdAt: now, updatedAt: now,
      profileName: name || 'Wanderer',
      playTime: 0,
      settings: {
        master: 0.8, sfx: 0.9, music: 0.55, shake: 1, glyphSize: 'medium',
        damageNumbers: true, aimAssist: true, showFps: false, minimap: true, binds: {},
      },
      meta: {
        ashes: 0, ashesTotal: 0, runs: 0, wins: 0, deaths: 0, kills: 0, bestFloor: 0, bestTime: null,
        ascension: 0, maxAscension: 0, heirlooms: {}, codex: {}, bestiary: {}, achievements: {},
        heroesUnlocked: ['finn', 'fp', 'marceline'], heroStats: {}, hintsSeen: {},
      },
      run: null,
      history: [],
    };
  }

  // FNV-1a checksum over a string
  function checksum(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, '0'); }

  function isObj(o) { return o && typeof o === 'object' && !Array.isArray(o); }

  // Deep-merge known defaults into loaded data so missing fields never crash the game.
  function fillDefaults(d, def) {
    for (const k in def) {
      if (d[k] === undefined || d[k] === null && def[k] !== null) d[k] = def[k];
      else if (isObj(def[k]) && isObj(d[k]) && k !== 'run') fillDefaults(d[k], def[k]);
    }
    return d;
  }

  function migrate(d) {
    // future: if (d.version === 1) { ...; d.version = 2; }
    d.version = VERSION;
    return d;
  }

  function validate(obj, slot) {
    if (!isObj(obj)) return { ok: false, error: 'Not a save object.' };
    // accept either an export envelope or raw slot data
    let data = obj;
    if (obj.format === 'ashes-of-ooo-save') {
      if (!isObj(obj.data)) return { ok: false, error: 'Save file has no data.' };
      const sum = checksum(JSON.stringify(obj.data));
      if (obj.checksum && obj.checksum !== sum) return { ok: false, error: 'Checksum mismatch — the file was modified or corrupted.' };
      data = obj.data;
    }
    if (data.game !== 'ashes-of-ooo') return { ok: false, error: 'This is not an Ashes of Ooo save.' };
    if (typeof data.version !== 'number' || data.version > VERSION) return { ok: false, error: 'Save is from a newer version (v' + data.version + ').' };
    if (!isObj(data.meta) || !isObj(data.settings)) return { ok: false, error: 'Save is missing required sections.' };
    if (data.run !== null && data.run !== undefined && !isObj(data.run)) return { ok: false, error: 'Run data is malformed.' };
    if (!Array.isArray(data.history)) data.history = [];
    data = migrate(JSON.parse(JSON.stringify(data)));
    fillDefaults(data, defaults(slot || data.slot || 1));
    if (slot) data.slot = slot;
    return { ok: true, data };
  }

  const Save = (HM.Save = {
    VERSION, SLOTS,
    slot: null,       // active slot number
    data: null,       // active slot data
    lastError: null,
    get storageOk() { return storageOk; },
    defaults, checksum, validate,

    read(slot) {
      const raw = store.get(PREFIX + slot);
      if (!raw) return null;
      try {
        const v = validate(JSON.parse(raw), slot);
        if (!v.ok) { Save.lastError = 'Slot ' + slot + ': ' + v.error; return { corrupt: true, error: v.error }; }
        return v.data;
      } catch (e) { Save.lastError = 'Slot ' + slot + ' is corrupted.'; return { corrupt: true, error: 'Unreadable JSON' }; }
    },

    list() {
      return SLOTS.map((n) => {
        const d = Save.read(n);
        if (!d) return { slot: n, exists: false };
        if (d.corrupt) return { slot: n, exists: true, corrupt: true, error: d.error };
        return {
          slot: n, exists: true, profileName: d.profileName, updatedAt: d.updatedAt, playTime: d.playTime,
          runs: d.meta.runs, wins: d.meta.wins, bestFloor: d.meta.bestFloor, ashes: d.meta.ashes,
          hasRun: !!d.run, runHero: d.run && d.run.heroId, runFloor: d.run && d.run.floorIndex,
        };
      });
    },

    lastSlot() { const n = parseInt(store.get(LAST), 10); return SLOTS.includes(n) ? n : null; },

    // Make slot active (load or create). Returns data.
    use(slot, name) {
      let d = Save.read(slot);
      if (!d || d.corrupt) { if (d && d.corrupt) return null; d = defaults(slot, name); }
      Save.slot = slot; Save.data = d;
      store.set(LAST, String(slot));
      Save.applySettings();
      Save.write();
      return d;
    },

    write() {
      if (!Save.data) return false;
      Save.data.updatedAt = new Date().toISOString();
      const r = store.set(PREFIX + Save.slot, JSON.stringify(Save.data));
      if (r !== true) { Save.lastError = 'Could not write save (' + (r && r.name ? r.name : 'storage error') + ').'; HM.Events.emit('saveError', Save.lastError); return false; }
      HM.Events.emit('saved', { slot: Save.slot });
      return true;
    },

    erase(slot) { store.del(PREFIX + slot); if (Save.slot === slot) { Save.slot = null; Save.data = null; } },

    // ----------------------------------------------------------------- settings
    applySettings() {
      const s = Save.data && Save.data.settings; if (!s) return;
      HM.Input.setBinds(s.binds);
      if (HM.R && HM.R.glyphSize !== s.glyphSize && HM.R.setGlyphSize) HM.R.setGlyphSize(s.glyphSize);
      if (HM.Audio && HM.Audio.setVolumes) HM.Audio.setVolumes({ master: s.master, sfx: s.sfx, music: s.music });
    },
    setSetting(key, value) { if (!Save.data) return; Save.data.settings[key] = value; Save.applySettings(); Save.write(); },
    setting(key, dflt) { return Save.data && Save.data.settings[key] !== undefined ? Save.data.settings[key] : dflt; },

    // ----------------------------------------------------------------- run checkpoints
    saveRunCheckpoint(run) { if (!Save.data) return; Save.data.run = JSON.parse(JSON.stringify(run)); Save.write(); },
    clearRun() { if (!Save.data) return; Save.data.run = null; Save.write(); },

    // Record a finished run (death or victory). summary: {heroId, floorIndex, act, killedBy, kills, time, gold, level, victory, ascension}
    recordRunEnd(summary) {
      if (!Save.data) return 0;
      const m = Save.data.meta;
      m.runs++; if (summary.victory) m.wins++; else m.deaths++;
      m.kills += summary.kills || 0;
      m.bestFloor = Math.max(m.bestFloor, summary.floorIndex || 0);
      if (summary.victory) { m.maxAscension = Math.max(m.maxAscension, (summary.ascension || 0) + 1); if (!m.bestTime || summary.time < m.bestTime) m.bestTime = summary.time; }
      const ashes = Math.round((summary.floorIndex || 0) * 6 + (summary.kills || 0) * 0.4 + (summary.victory ? 120 : 0) + (summary.ascension || 0) * 25);
      m.ashes += ashes; m.ashesTotal += ashes;
      const hs = (m.heroStats[summary.heroId] = m.heroStats[summary.heroId] || { runs: 0, wins: 0, bestFloor: 0 });
      hs.runs++; if (summary.victory) hs.wins++; hs.bestFloor = Math.max(hs.bestFloor, summary.floorIndex || 0);
      Save.data.history.unshift(Object.assign({ date: new Date().toISOString(), ashes }, summary));
      Save.data.history.length = Math.min(Save.data.history.length, 25);
      Save.data.run = null;
      Save.write();
      return ashes;
    },
    addPlayTime(sec) { if (Save.data) Save.data.playTime += sec; },
    unlockCodex(id) { if (!Save.data || Save.data.meta.codex[id]) return false; Save.data.meta.codex[id] = new Date().toISOString(); Save.write(); return true; },
    addBestiary(defId) { if (!Save.data) return; const b = Save.data.meta.bestiary; b[defId] = (b[defId] || 0) + 1; },
    unlockAchievement(id) { if (!Save.data || Save.data.meta.achievements[id]) return false; Save.data.meta.achievements[id] = new Date().toISOString(); Save.write(); HM.Events.emit('achievement', id); return true; },

    // ----------------------------------------------------------------- export / import
    exportEnvelope(slot) {
      const d = slot === Save.slot && Save.data ? Save.data : Save.read(slot);
      if (!d || d.corrupt) return null;
      return { format: 'ashes-of-ooo-save', formatVersion: 1, exportedAt: new Date().toISOString(), checksum: checksum(JSON.stringify(d)), data: d };
    },
    exportSlot(slot) {
      const env = Save.exportEnvelope(slot); if (!env) return { ok: false, error: 'Slot ' + slot + ' is empty.' };
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
      const name = `ashes-of-ooo-slot${slot}-${stamp}.json`;
      try {
        const blob = new Blob([JSON.stringify(env, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
        return { ok: true, name };
      } catch (e) { return { ok: false, error: 'Export failed: ' + e.message }; }
    },
    // Opens a file picker; resolves {ok, data, error, fileName}. Does NOT write — call commitImport after confirming.
    pickImportFile() {
      return new Promise((resolve) => {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
        inp.onchange = () => {
          const f = inp.files && inp.files[0]; if (!f) return resolve({ ok: false, error: 'No file chosen.' });
          if (f.size > 2 * 1024 * 1024) return resolve({ ok: false, error: 'File is too large to be a save.' });
          const rd = new FileReader();
          rd.onload = () => { try { const v = validate(JSON.parse(rd.result)); v.fileName = f.name; resolve(v); } catch (e) { resolve({ ok: false, error: 'File is not valid JSON.' }); } };
          rd.onerror = () => resolve({ ok: false, error: 'Could not read file.' });
          rd.readAsText(f);
        };
        inp.click();
      });
    },
    importText(text, slot) { try { return validate(JSON.parse(text), slot); } catch (e) { return { ok: false, error: 'Not valid JSON.' }; } },
    commitImport(slot, data) {
      const v = validate(data, slot); if (!v.ok) return v;
      const r = store.set(PREFIX + slot, JSON.stringify(v.data));
      if (r !== true) return { ok: false, error: 'Could not write imported save.' };
      if (Save.slot === slot) { Save.data = v.data; Save.applySettings(); }
      return { ok: true };
    },
  });
})();
