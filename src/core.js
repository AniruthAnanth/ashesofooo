// core.js — namespace, math, RNG, noise, events, input (edge-captured + buffered + remappable).
(function () {
  'use strict';
  const Math = globalThis.Math; // lexical alias: hot loops skip the global-object lookup (big win in the Node smoke VM)
  const root = typeof window !== 'undefined' ? window : globalThis;
  const HM = (root.HM = root.HM || {});

  // ---------------------------------------------------------------------------
  // Config / constants
  // ---------------------------------------------------------------------------
  HM.cfg = {
    CW: 5,            // cell width in projected world px
    CH: 8,            // cell height in projected world px
    TILT: 0.75,       // ground y compression (top-down 3/4)
    TARGET_ROWS: 92,  // visible rows at "medium" glyph size (finer grid = more resolution; rigs scale figures up to compensate)
    FIG_SCALE: 1.3,   // global figure scale for heroes / monsters on the finer grid (DESIGN §10: player ≈ 14–16 rows tall)
    BOSS_FIG_SCALE: 1.1, // bosses are already huge; they grow a little less
    MAX_DT: 1 / 30,
    BUFFER_WINDOW: 0.15, // input buffer seconds
    VERSION: '1.0.0',
  };

  // ---------------------------------------------------------------------------
  // Math
  // ---------------------------------------------------------------------------
  const M = (HM.M = {
    TAU: Math.PI * 2,
    clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
    lerp: (a, b, t) => a + (b - a) * t,
    invLerp: (a, b, v) => (b === a ? 0 : (v - a) / (b - a)),
    smooth: (t) => t * t * (3 - 2 * t),
    easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
    easeInCubic: (t) => t * t * t,
    easeOutBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    dist: (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay),
    dist2: (ax, ay, bx, by) => (bx - ax) * (bx - ax) + (by - ay) * (by - ay),
    angle: (ax, ay, bx, by) => Math.atan2(by - ay, bx - ax),
    angleDiff: (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; },
    approach: (v, target, step) => (v < target ? Math.min(v + step, target) : Math.max(v - step, target)),
    damp: (a, b, lambda, dt) => b + (a - b) * Math.exp(-lambda * dt), // frame-rate independent smoothing
    // integer hash -> [0,1)
    hash2: (x, y) => {
      let h = (x | 0) * 374761393 + (y | 0) * 668265263;
      h = (h ^ (h >>> 13)) * 1274126177;
      h = h ^ (h >>> 16);
      return (h >>> 0) / 4294967296;
    },
    hash3: (x, y, z) => {
      let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647;
      h = (h ^ (h >>> 13)) * 1274126177;
      h = h ^ (h >>> 16);
      return (h >>> 0) / 4294967296;
    },
    hashStr: (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; },
    // smooth value noise in [0,1]
    noise2: (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = M.hash2(xi, yi), b = M.hash2(xi + 1, yi), c = M.hash2(xi, yi + 1), d = M.hash2(xi + 1, yi + 1);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    },
    fbm: (x, y, oct = 4) => {
      let s = 0, a = 0.5, f = 1, n = 0;
      for (let i = 0; i < oct; i++) { s += a * M.noise2(x * f, y * f); n += a; a *= 0.5; f *= 2.03; }
      return s / n;
    },
    // closest point on segment param t in [0,1]
    segT: (px, py, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay; const l2 = dx * dx + dy * dy;
      if (l2 < 1e-9) return 0;
      return M.clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
    },
    distToSeg: (px, py, ax, ay, bx, by) => {
      const t = M.segT(px, py, ax, ay, bx, by);
      return Math.hypot(px - (ax + (bx - ax) * t), py - (ay + (by - ay) * t));
    },
    rot: (x, y, a) => { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; },
    hexToRgb: (hex) => {
      const h = hex.replace('#', '');
      const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    },
    mixRgb: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
    fmt: (n) => (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n))),
  });

  // ---------------------------------------------------------------------------
  // Seeded RNG (mulberry32)
  // ---------------------------------------------------------------------------
  class RNG {
    constructor(seed) { this.s = (seed >>> 0) || 1; }
    next() {
      let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    range(a, b) { return a + (b - a) * this.next(); }
    int(a, b) { return Math.floor(this.range(a, b + 1)); } // inclusive
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
    chance(p) { return this.next() < p; }
    sign() { return this.next() < 0.5 ? -1 : 1; }
    weighted(items, wfn) { // items: array, wfn(item)->weight
      let tot = 0; for (const it of items) tot += wfn(it);
      let r = this.next() * tot;
      for (const it of items) { r -= wfn(it); if (r <= 0) return it; }
      return items[items.length - 1];
    }
    shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this.next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
    fork(salt) { return new RNG((Math.imul(this.s ^ (salt | 0), 2654435761) >>> 0) ^ 0x9e3779b9); }
  }
  HM.RNG = RNG;
  HM.rng = new RNG((Date.now() & 0xffffffff) >>> 0); // non-deterministic gameplay rng (fx etc.)

  // ---------------------------------------------------------------------------
  // Event bus
  // ---------------------------------------------------------------------------
  const listeners = {};
  HM.Events = {
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); return () => HM.Events.off(name, fn); },
    off(name, fn) { const l = listeners[name]; if (!l) return; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
    emit(name, data) {
      const l = listeners[name]; if (!l) return;
      for (const fn of l.slice()) { try { fn(data); } catch (e) { console.error('[event ' + name + ']', e); } }
    },
  };

  // ---------------------------------------------------------------------------
  // Input — edge-captured so no tap is ever lost, with an input buffer and remapping.
  // Action names: up down left right attack heavy dodge skill1 skill2 ult interact
  //               potion1 potion2 inventory pause
  // ---------------------------------------------------------------------------
  const DEFAULT_BINDS = {
    up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
    attack: ['Mouse0'], heavy: ['Mouse2'], dodge: ['Space'],
    skill1: ['KeyQ'], skill2: ['KeyE'], ult: ['KeyR'], interact: ['KeyF'],
    potion1: ['Digit1'], potion2: ['Digit2'],
    inventory: ['Tab', 'KeyI'], pause: ['Escape'], map: ['KeyM'],
  };

  const Input = (HM.Input = {
    DEFAULT_BINDS,
    binds: JSON.parse(JSON.stringify(DEFAULT_BINDS)),
    down: new Set(),           // codes currently held
    _pressedEdge: new Set(),   // codes pressed since last endFrame
    _releasedEdge: new Set(),
    pressed: new Set(),        // snapshot for the current frame
    released: new Set(),
    lastPress: {},             // action -> game time of last unconsumed press (buffer)
    mouse: { sx: 0, sy: 0, wx: 0, wy: 0, inside: false, wheel: 0, _wheel: 0 },
    typed: [],                 // printable chars typed this frame (for text fields)
    _typed: [],
    capturing: null,           // when set (fn), the next key press is delivered to it (keybind remap)
    enabled: true,
    now: 0,
    gamepad: { connected: false, mx: 0, my: 0, ax: 0, ay: 0 },

    attach(target) {
      const t = target || window;
      const prevent = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
      t.addEventListener('keydown', (e) => {
        if (Input.capturing) { e.preventDefault(); const cb = Input.capturing; Input.capturing = null; cb(e.code); return; }
        if (prevent.has(e.code)) e.preventDefault();
        if (e.key && e.key.length === 1) Input._typed.push(e.key);
        else if (e.key === 'Backspace' || e.key === 'Enter') Input._typed.push(e.key);
        if (e.repeat) return;
        Input.down.add(e.code); Input._pressedEdge.add(e.code);
      });
      t.addEventListener('keyup', (e) => { Input.down.delete(e.code); Input._releasedEdge.add(e.code); });
      t.addEventListener('blur', () => { for (const c of Input.down) Input._releasedEdge.add(c); Input.down.clear(); });
      const canvasEl = document.getElementById('ui') || document.body;
      const md = (e) => {
        if (Input.capturing) { e.preventDefault(); const cb = Input.capturing; Input.capturing = null; cb('Mouse' + e.button); return; }
        const c = 'Mouse' + e.button; Input.down.add(c); Input._pressedEdge.add(c);
        Input.mouse.sx = e.clientX; Input.mouse.sy = e.clientY; Input.mouse.inside = true; // a click without a prior move still aims / shows the cursor
      };
      const mu = (e) => { const c = 'Mouse' + e.button; Input.down.delete(c); Input._releasedEdge.add(c); };
      canvasEl.addEventListener('mousedown', md);
      window.addEventListener('mouseup', mu);
      canvasEl.addEventListener('contextmenu', (e) => e.preventDefault());
      window.addEventListener('mousemove', (e) => { Input.mouse.sx = e.clientX; Input.mouse.sy = e.clientY; Input.mouse.inside = true; });
      document.addEventListener('mouseleave', () => { Input.mouse.inside = false; });
      canvasEl.addEventListener('wheel', (e) => { Input.mouse._wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    },

    // Call once at the start of each frame (before game logic).
    beginFrame(now) {
      Input.now = now;
      Input.pressed = Input._pressedEdge; Input._pressedEdge = new Set();
      Input.released = Input._releasedEdge; Input._releasedEdge = new Set();
      Input.typed = Input._typed; Input._typed = [];
      Input.mouse.wheel = Input.mouse._wheel; Input.mouse._wheel = 0;
      // record buffered presses per action
      for (const act in Input.binds) {
        for (const code of Input.binds[act]) {
          if (Input.pressed.has(code)) { Input.lastPress[act] = now; break; }
        }
      }
      Input._pollGamepad();
    },

    isDown(action) { const b = Input.binds[action]; if (!b) return false; for (const c of b) if (Input.down.has(c)) return true; return Input._padDown(action); },
    wasPressed(action) { const b = Input.binds[action]; if (!b) return false; for (const c of b) if (Input.pressed.has(c)) return true; return Input._padPressed(action); },
    wasReleased(action) { const b = Input.binds[action]; if (!b) return false; for (const c of b) if (Input.released.has(c)) return true; return false; },
    // Buffered press: true if pressed within `win` seconds and not yet consumed. Consumes it.
    consume(action, win) {
      const t = Input.lastPress[action];
      if (t === undefined) return false;
      if (Input.now - t <= (win === undefined ? HM.cfg.BUFFER_WINDOW : win)) { delete Input.lastPress[action]; return true; }
      return false;
    },
    peek(action, win) { const t = Input.lastPress[action]; return t !== undefined && Input.now - t <= (win === undefined ? HM.cfg.BUFFER_WINDOW : win); },
    clearBuffer() { Input.lastPress = {}; },
    // Raw movement vector (unnormalized -1..1 each axis)
    moveVec() {
      let x = 0, y = 0;
      if (Input.isDown('left')) x -= 1; if (Input.isDown('right')) x += 1;
      if (Input.isDown('up')) y -= 1; if (Input.isDown('down')) y += 1;
      if (Input.gamepad.connected && (Math.abs(Input.gamepad.mx) > 0.2 || Math.abs(Input.gamepad.my) > 0.2)) { x = Input.gamepad.mx; y = Input.gamepad.my; }
      return [x, y];
    },
    codeLabel(code) {
      if (!code) return '—';
      if (code.startsWith('Key')) return code.slice(3);
      if (code.startsWith('Digit')) return code.slice(5);
      if (code === 'Mouse0') return 'LMB'; if (code === 'Mouse2') return 'RMB'; if (code === 'Mouse1') return 'MMB';
      if (code === 'Space') return 'SPACE'; if (code === 'Escape') return 'ESC';
      if (code.startsWith('Arrow')) return code.slice(5).toUpperCase();
      if (code.startsWith('Shift')) return 'SHIFT'; if (code.startsWith('Control')) return 'CTRL';
      return code.toUpperCase();
    },
    actionLabel(action) { const b = Input.binds[action]; return b && b.length ? Input.codeLabel(b[0]) : '—'; },
    setBinds(b) { Input.binds = Object.assign(JSON.parse(JSON.stringify(DEFAULT_BINDS)), b || {}); },

    // --- gamepad (stretch goal; standard mapping) ---
    _pad: null, _padPrev: [],
    _pollGamepad() {
      const gp = (typeof navigator !== 'undefined' && navigator.getGamepads) ? Array.from(navigator.getGamepads()).find((g) => g) : null;
      Input._padPrev = Input._pad ? Input._pad.buttons.map((b) => b.pressed) : [];
      Input._pad = gp || null;
      const G = Input.gamepad; G.connected = !!gp;
      if (!gp) return;
      const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
      G.mx = dz(gp.axes[0] || 0); G.my = dz(gp.axes[1] || 0); G.ax = dz(gp.axes[2] || 0); G.ay = dz(gp.axes[3] || 0);
      for (const act in PAD_MAP) if (Input._padPressed(act)) Input.lastPress[act] = Input.now;
    },
    _padDown(action) { const p = Input._pad; const i = PAD_MAP[action]; return !!(p && i !== undefined && p.buttons[i] && p.buttons[i].pressed); },
    _padPressed(action) { const p = Input._pad; const i = PAD_MAP[action]; return !!(p && i !== undefined && p.buttons[i] && p.buttons[i].pressed && !Input._padPrev[i]); },
  });
  const PAD_MAP = { attack: 7, heavy: 6, dodge: 0, skill1: 2, skill2: 3, ult: 5, interact: 1, potion1: 12, potion2: 13, inventory: 8, pause: 9 };

  // Interact registry: kind -> (obj, player) => void. World creates interactables, other modules register handlers.
  HM.Interact = HM.Interact || {};

  // Small helpers
  HM.now = () => (typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000);
  HM.uid = (() => { let n = 1; return () => n++; })();
  HM.log = (...a) => { if (HM.debug) console.log('[HM]', ...a); };
})();
