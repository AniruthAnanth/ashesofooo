# ASHES OF OOO — Design Document

A single-player, in-browser action-roguelike rendered entirely in ASCII glyphs.
It is a dark fantasy take on the *Adventure Time* setting, and its look and combat feel copy
the "ASCII MMORPG" reels by @ansenjeo (Senje). Those are dark, top-down 3/4 scenes where
everything (grass, ruins, characters, fire) is drawn with monospace characters, with real
lighting, glow and fog.

The game runs from a plain `index.html` with no build step and no server. All persistence goes to `localStorage`,
and saves can be exported and imported as JSON files.

---

## 1. Lore (dark Adventure Time)

All lore text in the game is **original writing**. We use setting names and characters as a fan homage, and we
never copy episode dialogue. A single-word catchphrase as a bark is fine.

**The Land of Ooo, a thousand years after the Great Mushroom War.** Humanity burned the old world
with mushroom bombs. Magic came back mutated, and Ooo grew out of the ash: a bright and silly world built on
graveyards. In our telling the bright part is over.

**The Lich** is the will-to-extinction born in the last mushroom bomb. He has escaped his amber
prison and drunk from the **Well of Power**. Ooo is dying from the edges in:
- The war-dead rise as **bone thralls** across the Grasslands, and a **Bone Dragon** stalks the old highway ruins.
- The **Candy Kingdom** fell to the *Sugar Rot*, a decay plague that turns candy citizens into shambling,
  hungry husks. Princess Bubblegum's labs are dark. The **Earl of Lemongrab** holds court in the ruins, and
  every single thing is UNACCEPTABLE to him.
- In the **Ice Kingdom** the crown finally won. Nothing of Simon Petrikov is left in the **Ice King**, only
  scraps of his journal frozen into the walls. His penguins (Gunter's brood) are frost-cursed and they *wenk* in the dark.
- In the **Fire Kingdom** the **Flame King** has burned his kingdom down to black glass to keep the Lich's cold out.
- At the bottom is **the Lich's Well**: bone fields, green witchfire and the void. The Lich waits there.

**Heroes (single player, pick one per run):**
| Hero | Fantasy | Kit summary |
|---|---|---|
| **Finn, the Last Human** | sword hero in a white two-eared hood | 3-hit sword combo, heavy cleave, leap slam, Grass-curse vines, **Jake** ultimate (stretchy slam) |
| **Marceline, the Vampire Queen** | floating vampire with an axe-bass | wide axe sweeps, life-drain, bat-swarm dodge, sonic chord shockwave, shadow form ult; long hair with physics |
| **Flame Princess** | volatile fire elemental | fireball volley, **Fire Fissure** (the 3-prong eruption from the reels), Flame Ring aura, Temper meter → **Wildfire** ult |

**Easter eggs & recurring characters:**
- **The Waving Snail** hides on every floor and waves. On late floors its eyes glow Lich-green, and hitting it causes something bad.
- **Choose Goose** is the travelling merchant. He appears on floor 2 of each act.
- **Enchiridion pages** are codex collectibles, one per floor.
- **Bacon Pancakes** are the healing consumable.
- **Prismo's Wish** is a rare boon: you get something big and also a curse.
- **Gunter** shows up as the cursed-penguin elite variant ("Gunter, Who Was").

---

## 2. Structure (roguelite)

`Title → Save Slot (3 slots, export/import) → Hero Select → Run`

A run is **5 Acts × 3 floors = 15 floors**. Floor 3 of each act is a boss arena.

| Act | Realm | Palette | Common foes | Boss |
|---|---|---|---|---|
| I | **The Grasslands** (moonlit grass, Mushroom-War ruins, monoliths, shoreline) | dark green / slate / moon-blue | Bone Thrall (sword), Bone Archer, Ghoul Hound, Waving Snail | **The Bone Dragon** |
| II | **The Candy Necropolis** (rotted pink streets, gumdrop tombs, candy-cane pillars) | dusty pink / sick red / sugar white | Sugar Husk (shambler), Gumdrop Bloater (explodes into rot pools), Banana Guard Revenant (spear) | **Earl of Lemongrab** |
| III | **The Ice Kingdom** (snowfields, ice spires, blizzard fog) | ice blue / white / deep navy | Cursed Penguin (slides, freezes), Snow Golem, Frost Wisp (ranged) | **The Ice King** |
| IV | **The Fire Kingdom** (black glass, lava cracks, ash fall) | ember orange / obsidian | Flame Elemental, Cinder Hound, Magma Brute | **The Flame King** |
| V | **The Lich's Well** (bone fields, green witchfire, void edges) | bone white / witch green / black | Lich Thrall Knight, Bone Priest (summons), Void Wraith | **The Lich** (3 phases; cast and attack speed rise each phase) |

**Floor flow:** you arrive on an open procedural map (about 2400×1800 world units). It holds 5–8 enemy packs,
1 elite pack, 1 shrine, 1–2 chests, 1 Enchiridion page and the Waving Snail. The **Dungeon Door** (exit portal) wakes once
the elite pack is dead. Walk to it and press **F** to descend.

**Between floors:** spend boon points on a **Boon Draft** (pick 1 of 3). You earn a point per level-up and per elite or boss kill.
After that the run is autosaved as a checkpoint at the start of the next floor.

**Death** ends the run. You get an epitaph screen ("Here lies Finn, the Last Human, unmade by a Sugar Husk on
floor 5"), and the run is recorded in history. You earn **Ashes** (meta currency) based on depth and kills.

**Meta progression (per save slot):** spend Ashes on small permanent **Heirlooms** (+max HP, +1 flask charge,
starting gold, reroll in drafts, etc.). The slot also tracks a codex (lore pages found), a bestiary (kills per enemy),
achievements, run history and best floor. Beating the Lich unlocks **Ascension** levels: harder runs with extra modifiers.

---

## 3. Controls (applying Dotsenko, *Designing Game Controls*)

| Input | Action | Why it lives there |
|---|---|---|
| **W A S D** | Move | Habitual, so movement runs on autopilot. It uses an ADSR curve: ~70 ms to full speed, ~90 ms to stop. That reads as weight without feeling sluggish. |
| **Mouse** | Aim (crosshair `+` cursor) | Precision belongs on the primary hand |
| **LMB** (hold OK) | Primary attack, a 3-hit combo | Primary action goes on the primary finger |
| **RMB** | Heavy / secondary (hero-specific) | Second precise action on the same hand |
| **Space** | Dodge roll (i-frames) | State change for the left thumb. It is the strongest and most reachable key. |
| **Q / E** | Skills | Top-tier keys next to WASD |
| **R** | Ultimate | Top tier, one finger stretch away |
| **F** | Interact (contextual: take loot, descend, shrine, read, trade) | Conventional key; it is the one contextual action per hand |
| **1 / 2** | Bacon Pancakes (heal) / Tonic (mana) | Lower tier because they are infrequent |
| **Tab** or **I** | Inventory & character | Menu |
| **Esc** | Pause / options / back | Convention |

The same principles are built into the code:
- **Hand split.** The left hand has movement, one state change (dodge) and the contextual/skill keys. The right hand has aim and attacks.
- **No lost inputs.** Key and mouse presses are captured as *edges* in event handlers, so a tap shorter than a frame still counts.
- **Input buffer (150 ms).** Attack, dodge and skill presses made during a locked animation are queued and fire on the first legal frame.
- **Response under 100 ms.** Every verb shows visible motion on the frame after input. Light-attack anticipation is 60–90 ms.
- **Cancel windows.** Dodge cancels attack recovery and cast recovery. Attacks chain within a combo window.
- **Weak aim assist,** because the mouse is precise. Melee swings bend up to 15° toward the nearest enemy inside the swing cone. Projectiles get no assist.
- **Affordances.** Enemies wind up visibly (anticipation pose, plus a red or orange ground telegraph on big attacks). Loot labels are colored by rarity.
  Interact prompts say `[F] Take Grass Sword`. The hotbar shows cooldown sweeps. The crosshair has three states (default / over enemy /
  over interactable). Low HP adds a heartbeat and a red vignette.
- **Juice.** Hitstop of 40–90 ms scaled to impact, screen shake, a white hit flash, knockback, damage numbers (crits are bigger and yellow),
  a sound for every verb, and enemy barks.
- **Expression space (easy to learn, hard to master).** Skills interact with each other:
  - Fire ignites poison or rot pools, which explode.
  - Rolling through your own Flame Ring gives *Kindled* (your next attacks burn).
  - Frozen enemies shatter for bonus damage.
  - Bleed hurts more on moving targets, which rewards knockback.
- **Remappable keys** live in Options and are stored in the save slot. Gamepad support is a stretch goal
  (left stick move, right stick aim, RT attack, LT heavy, A dodge, X/Y skills, RB ult, B interact).

---

## 4. Art direction — replicate the reference

Reference frames live in the session scratchpad `ref/` folder (see CONTRACT.md for the path). Look at them.

- **Everything is glyphs on near-black.** The background is about `#05070a`. There are no solid fills, only soft glow halos behind bright glyphs.
- **A fine glyph grid.** Cells are 5×8 world px, which gives about 250–300 columns on screen. That density is what makes characters look "3D".
- **Camera.** Top-down 3/4 oblique: ground y is compressed by `TILT = 0.75`, objects have height (`z`), and the moon is at the top-right,
  so shadows fall down and left.
- **Grass.** Blade strokes `| / \ ' , ; ! ( ) "` in dark greens (`#16301c` → `#4d7a48` tips). Blades sway in rolling wind waves
  and bend away from anything walking through. Sparse pale flecks `. o * '` in grey-white are scattered like dew or fireflies.
- **Stone or dirt patches.** Dense letters and digits `0 O Q @ $ 8 B W M # & % d b p q w` in desaturated slate blue (`#3a4458` → `#8a96b0`),
  laid out *in rows like text*. They form irregular blobs on the grass.
- **Ruins and monoliths.** Tall prisms filled with dense glyphs `$&@WM#Q8B%`. The top face is brightest, the front face is mid,
  and the side faces are dark. They cast long dark diagonal drop shadows on the grass.
- **Water.** Deep navy `~ - = ' .` with white foam streaks along the shore, animated.
- **Characters.** Small (~9 rows tall), shaded like 3D models through glyph ramps, with a dark blob shadow. A name tag sits above in
  small white mono text. Enemies have a thin HP bar under their name.
- **Lighting.** Dark ambient (moonlit blue-green). Point lights tint glyph colors: near fire the grass *turns orange*.
  Emissive sources (fireball cores, fire columns) get a soft bloom halo.
- **Fog.** Drifting pale-grey glyph clouds `. : ' ~` with a soft haze that partly hides what's behind it.
- **Particles are glyphs.** Embers `. ' * +` (orange to dark red), sparks, poison `o O .` (green), blood `, . ;` (dark red),
  bone shards `' - ~ =` (bone white), sugar `* . +` (pink).
- **Telegraphs.** Dotted rings of `o` and `.` that fill from the center outward, and jagged crack lines.
- **UI.** Black panels with 1px light-grey borders and small mono text. Bars are segmented tick bars `||||||`.
  - Target frame at the top: `Skeleton Warrior 32/95`. Boss bar: `Bone Dragon — phase 2`.
  - Bottom hotbar with numbered slots, and an XP bar above it: `LV 14 · 267 / 6201 XP`.
  - Player frame at top-left with a tiny ASCII figure portrait, HP/MP bars, and a `LV 13 · 2728g` line.
  - Damage numbers are small mono white. Poison ticks are green, crits yellow, fire orange.
- **Weapon materials change the weapon's glyphs and colors,** as in the crafting reel:
  `Iron #%:`, `Steel @%.`, `Bronze &o,`, `Silver $s.`, `Gold 0o.`, `Moonsteel O*.`, `Nightglass N/'`,
  `Bloodiron B8:`, `Ossite =-.`, `Emberstone *+.`. Add Ooo materials too: `Grass "|;` (green), `Demon-blood %&;` (crimson),
  `Crystal <>^` (cyan), `Candy @o*` (pink), `Glacial *+'` (ice blue).
  Runes add an element and tint the swing trail.


## 4b. FIGURE / GROUND SEPARATION — top priority (user feedback)

The user's feedback: *"make the forms of characters and the monsters and all of that stuff more defined — it's hard to separate
forms from the background and the setting."* Every figure must read instantly against the terrain.
- **Renderer (done in render.js):**
  - Cells flagged `R.F_FIGURE` use a **bold** glyph weight, get a mild rim boost on silhouette edges and a lift inside.
  - Terrain cells *directly touching* a figure get a THIN soft shadow: they are darkened to about 42%, never erased.
  - Cells flagged `R.F_PROP` get a lighter version of the same treatment.
  - Terrain is dimmed and desaturated (`R.groundDim`, `R.groundDesat`) so the background recedes.
  - **User feedback (second round): thick black borders look ugly. Do NOT add halos or blank-cell outlines around figures.**
    The renderer refills any blank halo cell next to a figure from the ground layer (`R.snapshotGround()`), so outlines
    stay one cell thin and soft. Separation should come from bold glyphs, contrast, color and size, not from borders.
- **Rigs:** every actor cell is `F_FIGURE`. Characters are big enough to read: the player is ≈ 11–13 rows tall and ≈ 5–7 cols wide.
  Use high-contrast palettes that differ from the biome's ground colors (skeletons bright bone white, heroes saturated accents).
  Silhouettes must stay solid, with no single-glyph-wide limbs disappearing into grass, and every figure gets a blob shadow.
- **World:**
  - Props (monoliths, trees, tombs, spires, chests, shrines, merchant, portal) use `R.F_PROP`.
  - Ground stays quieter than figures: lower contrast, sparser glyphs, and no bright high-frequency noise.
    Stone and "text" patches are dimmer than any character.
- **FX:** particles and projectiles stay readable, but must never be brighter or denser than the figures they surround, except on purpose (impacts).
- **Loot and pickups:** `R.F_PROP` with a light pillar for rare items.

## 5. Animation direction (from frame-by-frame study of the reels)

1. **Fire Fissure (3-prong):**
   - **0–0.25 s:** thin jagged crack polylines race outward from the caster in a trident (~±30°). They are drawn as dim orange-red `. ' ,` glyphs with jitter.
   - **0.25–0.5 s:** the cracks brighten and **flame columns erupt in sequence along each line**. The cores are white-yellow `@ # *`, and orange halo orbs sit every ~40 px. A large orange ground light comes up.
   - **0.5–1.1 s:** the columns collapse into rising embers and drifting sparks.
   - **Up to 2 s:** the cracks linger as dim red lines and fade.
2. **Fireball volley:** three orbs (bright core plus halo) fly out in a fan. Each leaves a dotted trail of fading sparks. On impact there is an ember burst, a ring shockwave and a light flash.
3. **Flame Ring aura:** a flickering ring of fire glyphs (radius ~70) orbits the caster. The ground inside glows orange, and enemies inside take burn ticks.
4. **Melee swing:** a crescent **arc trail** of glyphs follows the weapon tip and fades over ~150 ms. It is colored by weapon material and element (green poison, orange fire, white steel).
   Timing is anticipation pull-back (60–90 ms) → snap strike (~60 ms) → follow-through and recovery (~150 ms).
5. **Dodge roll:** the body tucks into a ball and rotates 360° while travelling ~110 units in 0.32 s with ease-out. Dust puffs at start and end, and there are 2–3 afterimage ghosts.
6. **Walk / run:** legs swing alternately and arms counter-swing. The body bobs 1–2 px. Cape, hair and beard trail behind with verlet physics (lag plus sway).
7. **Hit reaction:** white flash for 1–2 frames, knockback slide, recoil lean.
8. **Skeleton death:** the rig breaks into its bones. The bones scatter as physics debris and settle into a **bone pile** that stays ~20 s, with a dust burst. Loot pops out with a label.
9. **Status visuals:** poisoned targets shed rising green `o .` motes with green damage ticks, bleeding targets drip red droplets, chilled targets get frost glyphs, and burning targets throw embers.
10. **Boss telegraphs:** dotted circles fill before they detonate. Lines of fire orbs march across the arena. Cast speed rises each phase.
11. **Loot drop:** the item pops in an arc, bounces, then shows a ground label (`Rusty Rod`, colored by rarity). Rares and above get a light pillar.
12. **Ambient:** grass waves, drifting fireflies, fog drift, water ripples and foam.

## 6. Save system (single player, browser)

- `localStorage` with 3 slots: keys `ashesOfOoo.slot.1..3`, plus `ashesOfOoo.lastSlot`.
- Each slot holds `{version, createdAt, updatedAt, profileName, settings, meta, run, history}` (exact schema in CONTRACT.md).
- **Autosave** happens at floor start (checkpoint), on settings change, on death or victory, and on pause/quit.
  Mid-floor progress is *not* saved; resuming restarts the floor, which is the roguelike rule against save-scumming.
- **Export:** download `ashes-of-ooo-slot1-YYYYMMDD-HHMM.json` with an integrity checksum.
- **Import:** a file picker reads the JSON, validates it and runs migrations, asks for confirmation, then overwrites the slot.
- Corrupted or unknown data never crashes the game. It is reported in the UI and the slot is left untouched.

## 7. Tech

- Plain JS (classic scripts, `window.HM` namespace) so `index.html` works from `file://`.
- **WebGL2 ASCII compositor.** A CPU cell buffer (glyph index, albedo, emissive, depth key, shadow, light) is uploaded each frame.
  A fragment shader draws glyphs from a font atlas, adds a blurred glow texture, then applies tone mapping, vignette and grain.
  The world-anchored cell grid scrolls smoothly through a sub-cell shader offset.
- A Canvas2D overlay draws crisp UI text: HUD, name tags, damage numbers, menus.
- WebAudio procedural SFX and ambient drones (no audio files).
- `tools/smoke.js` runs the whole game headless in Node with stubbed DOM and WebGL, simulating input for N seconds.

## 8. Map edges and minimap (user feedback)

- **No mirrored terrain past the map edge.** Out-of-bounds cells must NOT sample the map (no reflect, wrap or clamp).
  The end of the world must be visible and unambiguous:
  - The playable area ends in a biome-themed boundary band: thicket wall or cliff lip (grass), crumbling sugar wall (candy),
    ice cliff (ice), lava moat (fire), void lip (well).
  - Beyond the band is near-black void, with very sparse dim drifting motes and a soft falloff from the band.
- **Minimap.** It sits top-right, under the floor/objective panel, styled like the reference UI (black panel, 1px grey border, tiny glyph dots).
  - The terrain image is precomputed per floor and downsampled from `F.type`/`F.solid`/props.
  - **Fog of war:** the area within ~380 units of the player is revealed as you explore (stored per floor; not saved).
  - **Markers:** player arrow (facing), visible enemies (red dots), elites (orange), boss (large red), the portal once seen
    (cyan; pulses when open), shrine (yellow), chests (gold; dim when opened), note (white), merchant (green), the Waving Snail (tiny pink,
    an easter egg once discovered).
  - **M** toggles a large centered map overlay; the minimap can be turned off in Options. Remappable action `map`.

## 9. Teaching the controls and the story (user feedback)

Principles: teach one mechanic at a time, by doing, in a safe space, then test it. Use the level design to force the verb.
Show just-in-time prompts in screen space that fade once performed, never walls of text. Make tutorials skippable for veterans.
Keep a full move reference one keypress away. Drip-feed story through short in-world beats, not exposition dumps.

**A. Prologue — "The Tree Fort Clearing" (floor 0).** It plays on the first run of a profile and is skippable (title → New Run asks
"Play the prologue?", default Yes on a fresh profile). It is a small hand-authored grass map (the ruined Tree Fort at night) and introduces
one verb per beat, each gated by level design:
  1. **Move** (WASD prompt) along a path of lanterns. The prompt fades after ~2 s of movement.
  2. **Interact (F):** take your weapon from the Tree Fort's door. This also teaches item pickup.
  3. **Attack (LMB):** smash 3 bramble-bound training husks (straw dummies), then the 3-hit combo (hint appears after the first hit).
  4. **Dodge (Space):** a slow, heavily telegraphed Bone Sentinel slam blocks a gap. The prompt says "Roll THROUGH the attack — you are untouchable mid-roll".
     It repeats until the player rolls through while the telegraph detonates.
  5. **Heavy (RMB):** shatter a bone barricade.
  6. **Skills (Q, E):** a small pack of 3 thralls; each prompt appears when that skill is first usable, and a synergy tip follows (hero-specific).
  7. **Potions (1):** you take scripted chip damage from a trap → "Press 1 — Bacon Pancakes".
  8. **Ultimate (R):** charged for the beat; a Bone Captain (mini-elite) → "R — JAKE!" / hero equivalent.
  9. **Read (F):** the first Enchiridion page (story hook), then the Dungeon Door opens → descend to Floor 1.
  Story beat: a dying BMO (or the Enchiridion's voice) frames the quest in 3–4 short lines: the Lich drank from the Well; Ooo is dying from the edges inward; go down.

**B. Just-in-time hints** (each shown once per profile, stored in `meta.hintsSeen`; Options: Hints on/off):
first loot ("[F] take"), first gold, bag full, first elite (explain affixes), first status effect on you (poison/burn/chill with a counter tip),
low HP and no pancake used ("[1] Bacon Pancakes"), ult ready (a hotbar glow plus "[R] ready"), hit 4+ times without dodging ("[SPACE] rolls through attacks"),
first shrine, first chest, first note, first merchant, first boon draft (what boons are), exit open ("The Dungeon Door is open — find it on the map [M]"),
and the first boss (telegraph tip "dotted rings fill, then strike").

**C. Move reference.**
- Pause → **Moves** page: every verb for the current hero with keycap, name, description, cost and cooldown, plus 1–2 tips and the synergies (expression space).
- Hotbar hover shows the same tooltip.
- For the first ~3 uses of each skill, its name flashes briefly above the player.
- Hero Select shows the kit with keycaps.

**D. Story / plot progression.**
- Each act opens with a short act card (typewriter narration, 2–3 lines; any key to skip).
- On non-boss floors of each act, an optional **Remnant** NPC encounter (2–4 lines of dialogue when approached; `story` interactable)
  advances the plot. Grassland: Billy's ghost. Candy: Peppermint Butler in the ruins. Ice: an echo of Simon. Fire: the Flame King's herald.
  Well: Prismo (or the Cosmic Owl in a dream).
- Each boss gets a pre-fight line and a defeat line.
- The HUD objective line always says what to do next.
- The pause and boon screens show a **Descent track**: 5 acts × 3 floors with your position on it.
- Enchiridion pages and journal notes remain the optional deep lore in the Codex.

## 10. Water, dither and definition (user feedback, round 3)

Reference: ya_demidov's "Sinking into dither", a surface-stable fractal dithering reel. Frames are in `ref/dither_water_*.png`.
Look especially at `dither_water_night_moon_column.png`; our game is the night version.
- **Water.**
  - Surface: a fine dot texture (`. , : '`) whose density follows a slow wave field, with occasional brighter crests (`~ -`) drawn as long thin horizontal streaks that drift.
  - **Concentric ripple rings** spread from anything touching the water: actors wading or standing at the shore, rocks and pillars in water (slow idle rings), projectiles and impacts (fast splash rings). Rings are elliptical (ground tilt), lighter than the water, expand, thin out and fade.
  - **Moon reflection column:** a vertical band in screen space under the moon (top-right) of shimmering wavy highlights. These are short bright `~ = -` dashes stacked in rows, which break up and recombine with the waves.
  - A darker band hugs objects in the water (contact shadow).
  - Shore foam pulses. Deep water is darker and sparser.
  - All patterns are world-anchored, so they never swim when the camera moves.
- **Dither as shading.** Tone is shown by ordered (Bayer) dot density.
  - Terrain: anchor the pattern to world cells, which makes it surface-stable.
  - Figures: anchor the pattern to the figure's own origin cell, so it moves with the character and doesn't crawl across them.
  - Use clean 4–5 level ramps per material instead of noisy random glyph mixing. This gives crisp light and shadow sides and strong definition.
- **Resolution.** The grid is finer now: `TARGET_ROWS` is 92 for medium, 112 for small and 74 for large.
  Figures are scaled up so they gain detail: the player is about 14–16 rows tall and 6–8 cols wide, enemies scale accordingly, and bosses are huge.
  Characters must be *easier* to see than before. The finer grid adds detail inside the silhouette; it must not shrink it.
