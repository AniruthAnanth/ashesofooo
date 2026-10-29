// lore.js — all game text for ASHES OF OOO: acts, floor titles, boss intros, codex notes, barks,
// epitaphs, item flavor, the ending, hero blurbs, bestiary lines and achievements.
// Everything here is original writing (a dark-fantasy homage to the Land of Ooo).
// Also registers HM.Interact.note (Enchiridion pages / journals found on each floor).
(function () {
  'use strict';
  const HM = (globalThis.window || globalThis).HM;

  // ---------------------------------------------------------------------------
  // Acts (index 1..5). intro = 2–3 short lines shown on the first floor of the act.
  // ---------------------------------------------------------------------------
  // card = the full-screen act card (HM.UI.actCard): 2–3 typewriter lines, any key skips. glyphs = its horizon strip.
  const acts = [
    null,
    { act: 1, name: 'The Grasslands', numeral: 'I', color: '#8fbf86', glyphs: '"|/\\\',;!(`',
      intro: ['Moonlight on the old highway. The grass grows tall over the war-dead,', 'and lately the war-dead have been getting up.'],
      card: ['The Lich drank from the Well of Power, and the world began to drain.',
        'Out here at the frayed edge of Ooo, the war-dead answer his cold and form their ranks again.',
        'Somewhere down the old highway, a dragon made of bones is waking up.'] },
    { act: 2, name: 'The Candy Necropolis', numeral: 'II', color: '#e59ab8', glyphs: '@o*.%&,\'',
      intro: ['The Candy Kingdom smells of burnt sugar and wet rot.', 'Its citizens still walk the streets. They no longer remember why.'],
      card: ['The Candy Kingdom was the sweetest place in Ooo. The Sugar Rot found it anyway.',
        'Now the Rot walks the streets wearing the citizens, looking for the people they used to be.',
        'The Earl of Lemongrab rules the ruins, and finds all of it unacceptable.'] },
    { act: 3, name: 'The Ice Kingdom', numeral: 'III', color: '#9fd2ff', glyphs: '*+\'.:-=',
      intro: ['Snow that never quite lands. Somewhere in the spires a crown hums to itself,', 'and the man who wore it is gone.'],
      card: ['Snow falls here without ever landing. The spires hum a tune nobody taught them.',
        'The crown finished what it started. The man who wore it is gone.',
        'Only his journal is left, frozen into the walls, still trying to remember a name.'] },
    { act: 4, name: 'The Fire Kingdom', numeral: 'IV', color: '#ff9a4a', glyphs: '^\'*.,`~',
      intro: ['A king burned his own country to black glass to keep the cold out.', 'It did not work. The fire is all he has left.'],
      card: ['The Flame King burned his kingdom to black glass to keep the Lich\'s cold out.',
        'It did not work.',
        'The fire is all he has left now, and he does not intend to share it.'] },
    { act: 5, name: "The Lich's Well", numeral: 'V', color: '#8dffa0', glyphs: 'o.:\'=-~',
      intro: ['The bottom of the world. Green fire, white bone,', 'and a patience older than the bombs.'],
      card: ['The bottom of the world: bone fields, green witchfire, and nothing at the edges.',
        'The Well of Power is here. So is the one who drank it dry.',
        'Go down.'] },
  ];

  const FLOORS = {
    1: [{ title: 'The Long Grass', sub: 'where the old highway sleeps' },
        { title: 'Monoliths of the Mushroom War', sub: 'the stones still remember the light that made them' },
        { title: 'The Ossuary Road', sub: 'something vast is nesting in the ruins' }],
    2: [{ title: 'Gumdrop Graves', sub: 'the sweetest rot in all of Ooo' },
        { title: 'Peppermint Row', sub: 'the lamps are lit; nobody lit them' },
        { title: 'The Sour Court', sub: 'everything here has been judged and found wanting' }],
    3: [{ title: 'The White Silence', sub: 'snow falls upward when no one is watching' },
        { title: "Gunter's Rookery", sub: 'something waddles just past the edge of the light' },
        { title: "The Crown's Hollow", sub: 'a king without a man inside him' }],
    4: [{ title: 'The Glass Fields', sub: 'a kingdom burned to keep itself warm' },
        { title: 'The Cinder Market', sub: 'everything is for sale, and everything is ash' },
        { title: 'Throne of Last Embers', sub: 'the final fire refuses to go out' }],
    5: [{ title: 'The Bone Shelf', sub: 'green fire, white bone, no wind' },
        { title: 'The Unlit Stair', sub: 'every step down is a year forgotten' },
        { title: 'The Well of Power', sub: 'it has been waiting for you' }],
  };

  function floorIntro(act, inAct) {
    const a = FLOORS[act] || FLOORS[1];
    const f = a[Math.max(0, Math.min(2, (inAct || 1) - 1))];
    const info = acts[act] || acts[1];
    return { title: f.title, sub: f.sub, act: info.name, numeral: info.numeral, intro: inAct === 1 ? info.intro : null, color: info.color };
  }

  // ---------------------------------------------------------------------------
  // Bosses
  // ---------------------------------------------------------------------------
  const BOSSES = {
    boneDragon: { name: 'The Bone Dragon', title: 'Wyrm of the Ossuary Road', line: 'It was buried with the old world. It did not stay buried.' },
    lemongrab:  { name: 'Earl of Lemongrab', title: 'Sovereign of the Sour Court', line: 'He has judged the whole kingdom. Now he will judge you.' },
    iceKing:    { name: 'The Ice King', title: 'What the Crown Kept', line: 'There is no Simon left in there. Only the cold, and the cold is lonely.' },
    flameKing:  { name: 'The Flame King', title: 'Lord of Black Glass', line: 'He burned everything so the dark could not have it. You are next.' },
    lich:       { name: 'The Lich', title: 'Last Breath of the Old World', line: 'All things end. He is only the ending, arriving on time.' },
  };
  function bossIntro(id) { return BOSSES[id] || { name: id || 'Something', title: 'from the dark', line: '' }; }
  // One line of narration when each lair guardian falls (the VANQUISHED banner shows it under the boss name).
  const bossDefeat = {
    boneDragon: 'It comes apart like a cathedral in slow rain. All along the highway, the thralls lower their swords.',
    lemongrab: 'The Earl folds up like a dropped umbrella, still scowling. For once, the Sour Court has no verdict.',
    iceKing: 'The crown rolls free and stops spinning. For one breath the snow remembers a man named Simon.',
    flameKing: 'The last fire gutters out. The black glass cools, and for the first time in years it is only dark.',
    lich: 'The Lich unravels like old smoke. The Well goes quiet. Somewhere far above, it is almost morning.',
  };

  // ---------------------------------------------------------------------------
  // Prologue — "The Tree Fort Clearing" (floor 0). Read by HM.Tutorial; prompts are drawn by HM.UI.prompt.
  // beats[id] = {text, sub, byHero?:{heroId:{text?, sub?}}}; use Lore.beat(id, heroId) to get the resolved {text, sub}.
  // ---------------------------------------------------------------------------
  const prologue = {
    title: 'The Tree Fort Clearing', sub: 'before the descent',
    speaker: 'BMO', speakerTitle: 'the last little console',
    bmo: [
      'Oh. You are awake. BMO was starting to think BMO would have to finish the story alone.',
      'The Lich got out of his amber. He walked to the Well of Power, and he drank, and drank, and did not stop.',
      'Now Ooo is dying from the edges in. Every night the dark eats a little more of the map.',
      'BMO\'s battery is at four percent. That is all right. Four percent is enough for a goodbye and some advice.',
      'The only way to stop it is down. Through all five kingdoms, to the bottom of the Well.',
      'Your weapon is by the Tree Fort door. BMO will keep the lanterns lit for as long as BMO can.',
    ],
    bmoEnd: [
      'That is everything BMO knows. The door is open now.',
      'Go down. BMO will leave the porch light on, even if nobody is left to see it.',
    ],
    // tiny barks BMO can say as each beat starts (optional)
    bmoBeats: {
      move: 'Follow the lanterns. BMO lit them in a straight line, mostly.',
      interact: 'Your weapon is there. It missed you.',
      attack: 'Those are training husks. BMO made them from straw and spite.',
      dodge: 'That one is not training. Roll THROUGH it. Do not be brave about it.',
      heavy: 'Bones are stubborn. Hit them harder.',
      skills: 'Remember your tricks? Use them on the real ones.',
      potion: 'You are hurt. Eat a pancake. BMO insists.',
      ult: 'That big one is a captain. Call for help. That is allowed.',
      read: 'A page from the Enchiridion. It has been waiting for you longer than BMO has.',
    },
    beats: {
      move: { text: 'Move', sub: 'follow the lanterns to the Tree Fort' },
      interact: { text: 'Interact', sub: 'take your weapon from the Tree Fort door' },
      attack: { text: 'Attack', sub: 'break the bramble-bound training husks', byHero: { fp: { sub: 'hold to keep firing · burn the bramble-bound training husks' } } },
      combo: { text: 'Keep swinging: three hits make a combo', sub: 'the last hit knocks them back · hold the button to keep going',
        byHero: { marceline: { text: 'Keep swinging: two wide arcs', sub: 'hold the button to keep the axe-bass moving' }, fp: { text: 'Keep firing', sub: 'every third bolt splits into three' } } },
      dodge: { text: 'Roll THROUGH the attack', sub: 'you are untouchable mid-roll · wait for the ring to fill, then go' },
      heavy: { text: 'Heavy attack', sub: 'shatter the bone barricade', byHero: { marceline: { text: 'Sonic Chord', sub: 'one chord to shake the barricade apart' }, fp: { text: 'Fireball Volley', sub: 'burn the bone barricade down' } } },
      skills: { text: 'Skills', sub: 'they cost MP and recharge · watch the hotbar sweep',
        byHero: {
          finn: { sub: 'Grass Vines roots a line of foes · Leap Slam lands on whoever is stuck' },
          marceline: { sub: 'Drain heals you while it lasts · Bat Swarm tears through a line, untouchable' },
          fp: { sub: 'Fissure erupts along three cracks · roll inside your Flame Ring to become Kindled' },
        } },
      skill1: { text: 'Skill', sub: 'your first trick', byHero: { finn: { text: 'Grass Vines', sub: 'root a line of thralls in place' }, marceline: { text: 'Drain', sub: 'channel into a foe to heal · press again to stop' }, fp: { text: 'Fire Fissure', sub: 'cracks first, then columns of flame' } } },
      skill2: { text: 'Skill', sub: 'your second trick', byHero: { finn: { text: 'Leap Slam', sub: 'leap to the cursor · untouchable in the air' }, marceline: { text: 'Bat Swarm', sub: 'come apart into bats and tear through them' }, fp: { text: 'Flame Ring', sub: 'roll inside it to become Kindled' } } },
      potion: { text: 'Bacon Pancakes', sub: 'heal 35% over two seconds · you carry a few' },
      ult: { text: 'Ultimate', sub: 'your biggest move · it charges slowly',
        byHero: { finn: { text: 'JAKE!', sub: 'your brother answers: a fist from the sky' }, marceline: { text: 'Shadow Queen', sub: 'grow huge and hungry for six seconds' }, fp: { text: 'Cinder Rain', sub: 'burning stones fall around the cursor' } } },
      read: { text: 'Read the page', sub: 'the Enchiridion keeps whatever it is given' },
      door: { text: 'Descend', sub: 'the Dungeon Door is open · floor 1 waits below' },
      map: { text: 'Map', sub: 'see where you have been · the door shows in cyan' },
    },
    // the synergy tip that follows the skills beat (HM.Tutorial reads prologue.synergy[heroId])
    synergy: {
      finn: { text: 'Synergy', sub: 'root a pack with Grass Vines, then Leap Slam into the middle of it' },
      marceline: { text: 'Synergy', sub: 'Sonic Chord knocks them into a line · Bat Swarm bites the whole line' },
      fp: { text: 'Synergy', sub: 'cast Flame Ring, roll inside it · Kindled bolts burn hotter' },
    },
    page: { id: 'ench_prologue', source: 'Enchiridion, the first page', title: 'For Whoever Holds This Next',
      text: 'The Lich has drunk from the Well of Power, and the world is draining into him like bathwater down a drain. ' +
        'It starts at the edges. It always starts at the edges. The far woods go grey, then quiet, then gone. ' +
        'There is no army left to send, so the book sends you. Go down. Every floor you clear is a day you hand back to someone. ' +
        'Write in the margins if you like. Do not let the book get wet.' },
  };
  function beat(id, heroId) {
    const b = prologue.beats[id]; if (!b) return { text: id, sub: '' };
    const o = (b.byHero && heroId && b.byHero[heroId]) || {};
    return { text: o.text || b.text, sub: o.sub !== undefined ? o.sub : b.sub };
  }

  // ---------------------------------------------------------------------------
  // Remnants — story NPCs, one per act (World places a 'story' interactable on each act's first floor).
  // HM.Interact.story (ui.js) plays `lines` through HM.UI.dialogue and unlocks `codex` as 'remnant_<npc>'.
  // ---------------------------------------------------------------------------
  const remnants = {
    billy: { npc: 'billy', act: 1, name: "Billy's Ghost", title: 'once the greatest hero in Ooo', color: '#bcd6ff',
      lines: [
        'Easy there, little hero. I am not one of them. I just look like it these days.',
        'I am Billy. I used to be the greatest hero in Ooo. Now I am mostly a cold spot in the grass.',
        'The Lich walked this road on his way down. Wherever his breath touched the old battlefields, the dead remembered their drills.',
        'A Bone Dragon sleeps at the end of the highway. Wake it, break it, and the thralls lose their marching tune.',
        'After that, the Candy Kingdom. Something sweet has gone very sour there. Bring a strong stomach.',
        'And kid, I quit once. Sat in a cave for years feeling sorry. Do not take the long way to learning what I learned.',
      ],
      codex: { title: 'The Ghost on the Highway', source: 'Remnant · Billy, as remembered',
        text: 'Billy\'s ghost keeps a lonely watch on the old highway. He says the Lich passed this way on his road to the Well, and where his cold breath crossed the Mushroom War battlefields, the dead got up and fell back into ranks. ' +
          'Break the Bone Dragon and the thralls lose their tune. Then go to the Candy Kingdom. He admitted, without being asked, that he once gave up, and that it was the worst thing he ever did.' } },
    pepbut: { npc: 'pepbut', act: 2, name: 'Peppermint Butler', title: 'keeper of the ruined palace', color: '#ff8a9a',
      lines: [
        'Ah. A guest. Do forgive the state of the kingdom. The staff have all turned to rot.',
        'The Princess saw it first. She called it a disease. I called it what it was: an invitation, and the Lich answered for everyone.',
        'In a candy person, sugar is memory. The Rot eats the sugar. That is why they wander. They are looking for who they were.',
        'The Earl of Lemongrab holds court in the old palace. He has declared the plague unacceptable. The plague was not listening.',
        'I have certain arrangements with certain parties further down. They tell me the Ice Kingdom has gone quiet. Quiet is worse than screaming.',
        'Run along now. If you happen to meet Death, tell him Peppermint still has his casserole dish.',
      ],
      codex: { title: 'Tea in the Necropolis', source: 'Remnant · Peppermint Butler, as remembered',
        text: 'Peppermint Butler is still keeping house in the ruins of the Candy Kingdom, polishing silver for no one. He explained the Sugar Rot plainly: candy people keep their memories in their sugar, and the Rot eats it, so the husks wander the streets looking for who they used to be. ' +
          'The Earl of Lemongrab rules what is left. Below, he warned, the Ice Kingdom has gone quiet, and quiet is worse.' } },
    simon: { npc: 'simon', act: 3, name: 'An Echo of Simon', title: 'what the crown could not hold', color: '#9fd2ff',
      lines: [
        '...is someone there? Sorry. Sorry. I am only a little of myself. Just the part the crown could not hold.',
        'The crown took everything else. My name it kept for last, like a toy it was saving for later.',
        'When the Lich drank from the Well, the cold in the crown answered him. Like calling to like. I felt it laugh.',
        'If you meet the Ice King, do not talk to him about Betty. He will not remember her, and it will hurt him anyway.',
        'Past the ice there is fire. The Flame King thinks that if he burns bright enough, the dark will not find him. Oh, he is so wrong.',
        'Tell Marcy... no. Never mind. She knows. She always knew.',
      ],
      codex: { title: 'The Part the Crown Could Not Hold', source: 'Remnant · Simon Petrikov, an echo',
        text: 'A small warm voice in the ice, all that is left of Simon Petrikov. When the Lich drank from the Well, the cold inside the crown answered him like an old friend, and Simon felt it laugh. ' +
          'He asked that no one mention Betty to the Ice King. He said the Flame King will try to burn the dark away, and that it will not work. He started to leave a message for Marcy and then decided she already knew.' } },
    herald: { npc: 'herald', act: 4, name: 'The Ember Herald', title: 'voice of the Flame King', color: '#ffb050',
      lines: [
        'HALT. Behold the herald of the Flame King, Lord of Black Glass, Last Light of... oh, sit down. I do not have the breath for the full title any more.',
        'His Majesty burned the kingdom to keep the cold out. Then the gardens. Then the archives. Then a little bit of me.',
        'He is not mad. Madness is warm. He is afraid, and fear burns cleaner than any coal.',
        'The cold comes from below, from the Well. His Majesty knows. That is exactly why he will not stop burning.',
        'Past the throne is the stair down to the Well. Nobody who takes it comes back. Most of them were not as rude as you, so perhaps you will be fine.',
      ],
      codex: { title: 'The Herald\'s Short Title', source: 'Remnant · the Ember Herald, as remembered',
        text: 'The Flame King\'s herald is still at his post, guttering. He says the King is not mad, only afraid: the cold is rising from the Well, and the King has burned gardens, archives and servants to keep it out. ' +
          'Beyond the throne lies the stair to the Lich\'s Well. No one has come back up it. The herald thought this might be fine in your case, since you are so rude.' } },
    prismo: { npc: 'prismo', act: 5, name: 'Prismo', title: 'the wishmaster, very far from home', color: '#d8b0ff',
      lines: [
        'Hey. Easy. You are not dead, you are just very deep. Down here those feel about the same.',
        'I am Prismo. I grant wishes. Want to know what the Lich wished for? Nothing. He just drank the Well like it was a glass of water at a diner.',
        'Every wish anybody in Ooo ever made is in there with him now. That is why the world is coming apart at the edges. He is holding all the stitches.',
        'You cannot kill an ending, pal. But you can make it wait. Every floor you came down was a day you bought back for somebody.',
        'Go on. He is at the bottom. And if you make it out, swing by my place. I make a pretty mean pickle sandwich.',
      ],
      codex: { title: 'A Wishmaster in the Dark', source: 'Remnant · Prismo, as remembered',
        text: 'Prismo found you near the bottom of the Well, very far from his time room. The Lich, he said, never made a wish. He simply drank the Well, and every wish anyone in Ooo ever made went down with it. That is why the world unravels from its edges: the Lich is holding the stitches. ' +
          'An ending cannot be killed, Prismo said. It can be made to wait, and that is what heroes are for.' } },
  };

  // ---------------------------------------------------------------------------
  // Codex notes — Enchiridion pages, journals, logs, decrees. 4 per act.
  // ---------------------------------------------------------------------------
  const notes = [
    // ---- Act I: The Grasslands
    { id: 'ench_first', act: 1, source: 'Enchiridion, loose page', title: 'On the Keeping of Heroes',
      text: 'A hero is not the strongest one in the room. A hero is the one who stays when the room starts burning. ' +
        'This book has been carried by many hands, and most of them were shaking. Do not be ashamed of the shaking. ' +
        'Be ashamed only of the leaving. If you are reading this page, the book has chosen you, or you have stolen it. ' +
        'Either way, it is yours now. Keep it dry. Keep it close. Do not read the last chapter until you must.' },
    { id: 'soldier_letter', act: 1, source: 'Folded inside a rusted helmet', title: 'Letter Never Posted',
      text: 'Dear M. They say the bombs will end it by spring. They say a lot of things. The sky here is the wrong colour ' +
        'and the grass has started to grow in straight lines, like it is waiting for orders. I keep your picture in my boot. ' +
        'If I do not come home, plant something where the house was. Not flowers. Something that will fight back.' },
    { id: 'ench_waking', act: 1, source: 'Enchiridion, chapter of the dead', title: 'On the Waking Dead',
      text: 'The dead of the Mushroom War were never given proper rest; there was no one left to give it. ' +
        'For a thousand years they lay still out of habit. Habit is not peace. When a cold enough will passes over a battlefield, ' +
        'the bones remember their drills. They form ranks. They march toward whatever is warm. ' +
        'Strike the skull, not the ribs. The ribs have been broken before and did not mind.' },
    { id: 'monolith_scratch', act: 1, source: 'Scratched into a monolith', title: 'Words in the Stone',
      text: 'Someone has carved a message into the stone with something that was not a knife. ' +
        'The letters are too even, too patient. It reads: I WAS HERE BEFORE THE GRASS. I WILL BE HERE AFTER IT. ' +
        'Beneath it, in a smaller and shakier hand, someone else has added: no you will not. ' +
        'The second hand is braver. It is also, judging by the bones at the base of the stone, dead.' },

    // ---- Act II: The Candy Necropolis
    { id: 'pb_log_1', act: 2, source: "Princess Bubblegum's lab log", title: 'Lab Log: Day 1 of the Rot',
      text: 'Sample 44-C (a gumdrop citizen, volunteer) presented with grey mottling and an unusual sweetness of breath. ' +
        'Sugar levels elevated beyond anything I have catalogued. Subject reports feeling "very full, and very empty." ' +
        'Quarantine of the east district is recommended. I am not frightened. Fear is a chemical, and I know its recipe. ' +
        'Note to self: stop writing that down. It does not help.' },
    { id: 'pb_log_19', act: 2, source: "Princess Bubblegum's lab log", title: 'Lab Log: Day 19',
      text: 'The rot is not a disease. Diseases want to live. This wants everything else to stop. ' +
        'It spreads fastest where people gather to comfort each other, which is the cruellest design I have ever seen, and I have seen my own. ' +
        'Peppermint Butler says the stars over the Necropolis have gone green. I told him that is not possible. ' +
        'I have not gone to the window to check.' },
    { id: 'banana_orders', act: 2, source: 'Pinned to a guardhouse door', title: 'Banana Guard Standing Orders',
      text: 'ONE: Guard the gate. TWO: If the gate is gone, guard where the gate was. THREE: Do not eat the citizens, even if they ask. ' +
        'FOUR: The citizens will ask. FIVE: If you start to feel sweet, report to the infirmary. ' +
        'SIX: The infirmary is closed. Report to the gate. SEVEN: See order ONE. ' +
        'Signed in pencil, smudged: Captain. The captain\'s name has been licked off the page.' },
    { id: 'goose_ledger', act: 2, source: 'A leather ledger, feathers pressed between pages', title: "Choose Goose's Ledger",
      text: 'Sold: one lantern (cracked) to a crying knight. Sold: twelve bandages to a man who had no wounds yet but knew. ' +
        'Sold: a map of the Well, inaccurate, to the Lich, who paid in a coin that was very cold and very old. ' +
        'Bought: one hero\'s sword, from the hero\'s friend, after. Margin note: business is good at the end of the world. ' +
        'Margin note, later: business is lonely.' },

    // ---- Act III: The Ice Kingdom
    { id: 'simon_1', act: 3, source: "Simon Petrikov's journal, frozen into a wall", title: 'Journal: The Crown, Week Two',
      text: 'The headaches are worse. The crown is warm when I wear it and cold when I do not, which I think is backwards. ' +
        'I found myself speaking to the snow today, and the snow did not answer, and I was disappointed. ' +
        'Write everything down, Simon. If you forget yourself, the paper will remember. ' +
        'Today I am Simon. I collect antiques. I have a fiancee. I am Simon.' },
    { id: 'simon_2', act: 3, source: "Simon Petrikov's journal", title: 'Journal: For the Little Vampire',
      text: 'The girl hums when she is frightened. I taught her that, I think, or she taught me. ' +
        'If you are reading this, Marcy, and I have become something that does not know your name, please forgive the thing. ' +
        'It is wearing my face, but it is only cold. Keep the bear. Keep humming. ' +
        'I am so sorry that the world ended before you finished growing up in it.' },
    { id: 'simon_last', act: 3, source: 'The last page in his own hand', title: 'Journal: The Final Entry',
      text: 'I cannot remember what the word for her was. The woman with the glasses who laughed at my jokes. ' +
        'There is a word for her and it is gone. The crown says there was never anyone. ' +
        'The crown is lying. I am almost sure the crown is lying. ' +
        'If anyone finds this: there was someone. There was always someone. Gunter says wenk. I think Gunter agrees.' },
    { id: 'penguin_census', act: 3, source: 'Written in blue crayon', title: 'A Census of Penguins',
      text: 'Gunter. Gunter. Gunter. Gunter (big one). Gunter. Gunter (bites). Gunter. Gunter (stares at nothing). ' +
        'Gunter (stares at me). Gunter. The list goes on for nine pages. On the final page, in different handwriting: ' +
        'They are not all Gunter. One of them is something else wearing the shape. It is waiting for him to stop counting.' },

    // ---- Act IV: The Fire Kingdom
    { id: 'fire_decree_1', act: 4, source: 'Burned into an obsidian tablet', title: 'Decree of the Flame King, the First',
      text: 'By order of the Throne of Fire: the cold is an enemy of the realm. All citizens shall burn brighter. ' +
        'Hearths shall not be banked at night. Those who flicker shall be rekindled. Those who cannot be rekindled shall be used as kindling. ' +
        'The Lich\'s frost will find no purchase here. We will be too bright to see. We will be too hot to touch.' },
    { id: 'fire_decree_last', act: 4, source: 'Scrawled on glass, the letters still warm', title: 'Decree, the Last',
      text: 'By order of the Throne: there is no more fuel. Burn the gardens. Burn the archives. Burn the bridges, then the boats. ' +
        'Burn the palace, but leave the throne. A king must have somewhere to sit while he burns. ' +
        'The cold is still coming. Why is it still coming. Burn the decree. Burn this one too.' },
    { id: 'flame_letter', act: 4, source: 'A letter sealed with black wax', title: 'To My Daughter, Unsent',
      text: 'They tell me you went to live among the soft things, the candy people and the grass. ' +
        'They tell me you are kind now. Kindness is a cold word, daughter. I locked you away because you were too bright, ' +
        'and now my whole kingdom is ash and you are the only fire left that anyone would warm their hands at. ' +
        'Do not come back. Or come back and finish it. I cannot decide which I want.' },
    { id: 'glassblower', act: 4, source: 'Etched inside a black glass bowl', title: "Glassblower's Lament",
      text: 'Before the burning I made bowls and lamps and little glass birds for the children. ' +
        'Now the whole country is glass, and none of it is beautiful, and I did not make any of it. ' +
        'I found a bird in the ash this morning. It was one of mine. It had survived the fire. ' +
        'I held it until my hands blistered and I could not tell you why.' },

    // ---- Act V: The Lich's Well
    { id: 'lich_whisper', act: 5, source: 'Heard, not read', title: 'A Whisper from the Well',
      text: 'You climb down because you think there is a bottom. There is no bottom. There is only further. ' +
        'I have watched every light in this world go out, little hero, one after another, ' +
        'and each one thought it was the one that would not. I do not hate you. Hate is warm. ' +
        'I am simply what remains when everything warm has been spent.' },
    { id: 'lich_patience', act: 5, source: 'Carved into the Well stones, very old', title: 'On Patience',
      text: 'The mushroom bomb did not make me. It woke me. I was already there in every winter, every last breath, ' +
        'every candle left burning in an empty house. I was trapped in amber once, and I did not struggle. ' +
        'Amber is only slow honey. Honey is only slow rot. I can wait. I am the only thing in Ooo that has never needed to hurry.' },
    { id: 'ench_final', act: 5, source: 'Enchiridion, the final page', title: 'The Last Chapter',
      text: 'You were told not to read this until you must. So: you must. The Lich cannot be killed, ' +
        'because endings cannot be killed. But an ending can be postponed, and a postponed ending is called a day, ' +
        'and enough days in a row are called a life. Go down. Take as many days back from him as you can carry. ' +
        'That is all any hero has ever done.' },
    { id: 'pb_log_final', act: 5, source: "Princess Bubblegum's lab log, final", title: 'Lab Log: Final Entry',
      text: 'I followed the rot to its source. It led here, as I feared, to the Well. ' +
        'I have a formula that might reverse it, but it needs a catalyst I cannot synthesise: a living heart that refuses to give up. ' +
        'I have tested mine. It is not enough. Whoever finds this: I am sorry for asking. ' +
        'Please be stubborn. Please be so stubborn it is scientifically unreasonable.' },
  ];
  // The prologue's page opens act I; each act's remnant conversation closes its act section in the codex.
  // Both are `fixed` (never picked as a random floor page); remnant entries are flagged `remnant`.
  notes.unshift({ id: prologue.page.id, act: 1, fixed: true, source: prologue.page.source, title: prologue.page.title, text: prologue.page.text });
  for (const k in remnants) {
    const r = remnants[k]; let at = notes.length;
    for (let i = notes.length - 1; i >= 0; i--) if (notes[i].act <= r.act) { at = i + 1; break; }
    notes.splice(at, 0, { id: 'remnant_' + k, act: r.act, fixed: true, remnant: true, npc: k, source: r.codex.source, title: r.codex.title, text: r.codex.text });
  }

  // ---------------------------------------------------------------------------
  // Move reference (Pause → Moves, hotbar tooltips). Per-hero tips + synergies; `common` covers shared verbs.
  // Tips stay under ~80 chars so a card fits them on one line.
  // ---------------------------------------------------------------------------
  const moves = {
    common: {
      move: { name: 'Move', desc: 'Walk in eight directions. You reach full speed almost at once and stop just as fast.',
        tips: ['Keep moving: most attacks land where you were, not where you are.', 'Your aim follows the mouse, not your feet. Strafe as you swing.'] },
      dodge: { name: 'Dodge Roll', desc: 'Roll about a body-length and a half in a third of a second. You are untouchable for most of it, and it cancels the end of any attack or cast.',
        tips: ['Roll THROUGH attacks, not away from them. The roll does the work.', 'Swing, then roll out of the recovery. It is faster than waiting.'] },
      interact: { name: 'Interact', desc: 'Take loot, open chests, pray at shrines, read pages, trade, speak with remnants and descend.',
        tips: ['The prompt under a target says exactly what the key will do.', 'Loot labels are coloured by rarity: white, blue, gold, orange.'] },
      potion1: { name: 'Bacon Pancakes', desc: 'Heal 35% of your max HP over two seconds.',
        tips: ['Eat early. The heal ticks while you keep fighting.', 'Chests, elites and Choose Goose all hand out more.'] },
      potion2: { name: 'Tonic', desc: 'Restore 60% of your MP.', descFp: 'Cool your Temper by 60.',
        tips: ['Drink it before a big skill rotation, not after.'], tipsFp: ['A Tonic pulls you back from the edge of Wildfire.'] },
      map: { name: 'Map & Pack', desc: 'The map shows where you have been. The pack holds your gear: equip, socket runes, salvage.',
        tips: ['On the map: cyan door, gold chest, yellow shrine, violet remnant.'] },
    },
    synergies: [
      'Fire ignites rot pools and poison clouds. They explode, so stand back first.',
      'Frozen foes shatter for bonus damage when anything but ice hits them.',
      'Bleed hurts more on moving targets. Knock bleeding foes around.',
    ],
    finn: {
      attack: ['The third hit knocks foes back. Aim it so they fly into friends.', 'Hold the button and the combo keeps flowing.'],
      heavy: ['Hold to charge it. A full charge clears a half-circle around you.', 'Best when you are surrounded: it hits everything in front of you.'],
      skill1: ['Rooted foes cannot run from your combo.', 'Bleed hurts more on the move: let roots lapse, then knock them.'],
      skill2: ['You are untouchable in the air. Leap OUT of a telegraph.', 'Land on a vined pack to flatten all of it at once.'],
      ult: ['The fist lands at your cursor. Aim it at the thickest crowd.', 'Save Jake for an elite pack or a lair guardian.'],
      passive: ['Every kill heals 2 HP, so clearing a pack fast is also healing.'],
      synergies: ['Grass Vines, then Leap Slam: root a pack, then land on it.', 'Third combo hit, then Heavy Cleave: knock them into a heap, sweep it.', 'Roll cancels every swing\'s recovery: attack, roll, attack.'],
    },
    marceline: {
      attack: ['Two wide arcs: sweep groups, not single foes.', 'Lifesteal makes trading blows safer than it looks.'],
      heavy: ['It shatters missiles. Answer an arrow volley with a chord.', 'Weakened foes hit softer. Chord first, then fight.'],
      skill1: ['Press it again to stop the channel and save your MP.', 'Drain the elite while Sonic Chord keeps its friends away.'],
      skill2: ['Untouchable for the whole flight. Use it to escape and to engage.', 'Line them up: the swarm bites everything on its path.'],
      ult: ['The living flee from you. Chase down the elite.', '25% lifesteal: dive in when you are low, not when you are full.'],
      passive: ['You float, so ground hazards hurt you half as much. Stand in them.'],
      synergies: ['Sonic Chord knocks foes back into a line for Bat Swarm.', 'Shadow Queen plus Drain heals you to full in seconds.', 'Float over rot pools and fire: fight where they cannot.'],
    },
    fp: {
      attack: ['Burning foes take 15% more damage from you. Keep them lit.', 'Hold the button: the bolts keep coming as long as you do.'],
      heavy: ['Each fireball sets the ground alight. Seal a doorway with them.', 'Fire ignites rot pools and poison clouds, and they explode.'],
      skill1: ['Cracks first, flames after. Aim ahead of moving foes.', 'Stand close so all three prongs cross one target.'],
      skill2: ['Roll through your own ring to become Kindled.', 'Kindled attacks burn hotter. That is your cue to push in.'],
      ult: ['Stones fall around the cursor. Drop them on a clumped pack.', 'The burning ground stays. Pull foes back through it.'],
      passive: ['At 100 Temper you become Wildfire: no cooldowns, but you burn.'],
      synergies: ['Flame Ring, roll inside, then Kindled bolts.', 'Fireballs into rot pools make big explosions on the Candy floors.', 'Ride your Temper near 100 on purpose, then Wildfire through a pack.'],
    },
  };

  // ---------------------------------------------------------------------------
  // Barks — short lines spoken by actors (HM.UI.bark). Keyed by def id.
  // ---------------------------------------------------------------------------
  const barks = {
    thrall: ['...the war... is not over...', 'Hhhrrk.', 'Ranks... re-form...', 'Who buried us?', 'For the old flag...', 'Warm one. There.'],
    archer: ['Loose...', 'I see your light...', 'Hold still, little star.', 'One more arrow. Always one more.'],
    hound: ['*snarl*', 'Grrrhh...', '*a hungry whine*', '*bones rattle as it sniffs*'],
    snail: ['*waves*', '...', '*waves slowly*', '*keeps waving*'],
    snail_cursed: ['*waves. its eyes are green*', '*the waving is wrong*', 'hello hero', '*waves with too many fingers*'],
    snail_possessed: ['YOU STRUCK THE LITTLE ONE.', 'i was only waving', 'I SEE YOU THROUGH ITS EYES.', 'Wave goodbye, hero.'],
    elite: ['I lead what is left.', 'Kneel, and be counted.', 'The ranks close behind me.', 'You will not pass this one.'],
    brute_enrage: ['MORE HEAT! MORE!', 'BREAK! EVERYTHING BREAKS!', 'RRRAAAGH!', 'THE GLASS SINGS!'],
    husk: ['Sweet... so sweet...', 'Princess...? Princess...?', 'We were citizens...', 'Hungry. Always hungry.', 'Share... the sugar...'],
    bloater: ['Hhhngh... full... so full...', '*gurgle*', 'Pop... goes...', 'Too... sweet...'],
    banana: ['Halt! ...halt...', 'Orders are orders...', 'Protect the kingdom! ...What kingdom?', 'Intruder! Probably!', 'Back to the gate...'],
    penguin: ['Wenk.', 'Wenk?', 'WENK.', '...wenk...', '*slides menacingly*'],
    gunter: ['Wenk.', '...', '*stares with something older behind its eyes*', 'W E N K.'],
    golem: ['Cold... stays...', '*the grinding of packed snow*', 'Crown... commands...', 'Melt... no.'],
    wisp: ['So cold out here...', 'Follow the light...', '*a whisper like frost on glass*', 'Stay with us...'],
    elemental: ['BURN.', 'Warmth, at last!', 'The King wills it!', 'Brighter! Brighter!'],
    cinder: ['*ember snarl*', '*hiss*', 'Rrrrash!', '*sparks scatter as it barks*'],
    brute: ['SMASH THE COLD!', 'Glass bones break!', 'Hrrah!', 'MORE FIRE!'],
    knight: ['The Well calls.', 'Kneel to the ending.', 'We served kings. Now we serve the last one.', 'Your light offends him.'],
    priest: ['Rise, children.', 'Death is a door. Walk through.', 'The Lich provides.', 'Sleep, and serve.'],
    wraith: ['...nothing...', 'Join the quiet.', 'There is no bottom.', 'We were heroes too.'],
    boneDragon: ['*a roar like a cathedral collapsing*', '*bone grinds on bone*', '*the air turns to dust and old smoke*'],
    lemongrab: ['UNACCEPTABLE!', 'My court! MY COURT!', 'You smell of sugar. Revolting!', 'Kneel to the Earl!', 'Sour! SOUR! SOUR!'],
    iceKing: ['Why does everyone leave?', 'Stay! Stay and be frozen with me!', 'I had a name once. It was... it was...', 'Gunter, attack! ...Gunter?', 'Nobody ever visits.'],
    flameKing: ['Burn, and be warm forever!', 'My kingdom is ash. You will be ash.', 'The cold will not have me!', 'KNEEL BEFORE THE FIRE!'],
    lich: ['Sleep.', 'All candles gutter.', 'You are a flicker. I am the dark between.', 'Every hero I have met is dead.', 'Rest now.'],
    goose: ['Choose wisely. Or do not. I still get paid.', 'Honk. Prices are firm.', 'Shiny things for shiny coins.', 'Buy something before the world ends.', 'Everything must go. Everything is going.'],
    // heroes (UI uses these on level-up, boss kills and low health)
    finn: ['Mathematical!', 'Algebraic!', 'For Ooo!', 'I will fix it. I will fix all of it.', 'Come on, come on...'],
    marceline: ['Bored now.', "I've buried better than you.", 'Mmm. Red.', 'Play it louder.', 'A thousand years and this is still annoying.'],
    fp: ['Burn bright.', 'I am not cruel. You are just flammable.', 'Feel the heat.', 'Oh, I am so angry.', 'Everything burns. Even me.'],
  };

  // ---------------------------------------------------------------------------
  // Hero blurbs (fallback if HM.Heroes.list lacks them)
  // ---------------------------------------------------------------------------
  const heroBlurbs = {
    finn: 'The last human in Ooo, or so the stories go. He swings first and grieves later, and his hood still has both its stubborn ears.',
    marceline: 'A thousand years old and tired of most of them. Her axe-bass hums with grief; she drinks red and remembers too much.',
    fp: 'Elemental, volatile, honest to a fault. Her father burned their kingdom to glass. She carries what is left of the fire inside.',
  };

  // ---------------------------------------------------------------------------
  // Bestiary (codex one-liners); names are fallbacks if HM.Enemies.defs lacks them.
  // ---------------------------------------------------------------------------
  const bestiary = {
    thrall:    { name: 'Bone Thrall', act: 1, desc: 'A Mushroom War soldier still following its last order: advance.' },
    archer:    { name: 'Bone Archer', act: 1, desc: 'Its fingers never forgot the bowstring. Its eyes never needed to.' },
    hound:     { name: 'Ghoul Hound', act: 1, desc: 'What the soldiers kept as pets. Still loyal. Still hungry.' },
    snail:     { name: 'The Waving Snail', act: 1, desc: 'It is on every floor. It waves. Do not ask it why. Do not hit it.' },
    husk:      { name: 'Sugar Husk', act: 2, desc: 'A candy citizen hollowed by the Rot. It wants to share its sweetness.' },
    bloater:   { name: 'Gumdrop Bloater', act: 2, desc: 'Swollen with Rot. Bursts into pools that burn very well.' },
    banana:    { name: 'Banana Guard Revenant', act: 2, desc: 'Still guarding the gate. The gate is long gone.' },
    penguin:   { name: 'Cursed Penguin', act: 3, desc: 'Gunter\'s brood, frost-bitten and wrong. They wenk in the dark.' },
    golem:     { name: 'Snow Golem', act: 3, desc: 'Packed snow given a crown\'s command and nothing else.' },
    wisp:      { name: 'Frost Wisp', act: 3, desc: 'A lost light that wants you to be cold with it.' },
    elemental: { name: 'Flame Elemental', act: 4, desc: 'A citizen of the Fire Kingdom, burning brighter by royal decree.' },
    cinder:    { name: 'Cinder Hound', act: 4, desc: 'Coal-hearted and quick. It leaves smoke where it ran.' },
    brute:     { name: 'Magma Brute', act: 4, desc: 'Black-glass muscle around a molten core. Slow to start, slower to stop.' },
    knight:    { name: 'Lich Thrall Knight', act: 5, desc: 'Champions of old kingdoms, knighted again by the end of the world.' },
    priest:    { name: 'Bone Priest', act: 5, desc: 'Preaches the gospel of the last breath. Its congregation rises.' },
    wraith:    { name: 'Void Wraith', act: 5, desc: 'The silhouette of a hero who went down the Well first.' },
    boneDragon:{ name: 'The Bone Dragon', act: 1, boss: true, desc: 'A war-wyrm\'s skeleton animated by the Lich\'s cold breath.' },
    lemongrab: { name: 'Earl of Lemongrab', act: 2, boss: true, desc: 'Ruler of the Sour Court. Finds everything, and everyone, unacceptable.' },
    iceKing:   { name: 'The Ice King', act: 3, boss: true, desc: 'The crown, wearing what is left of Simon Petrikov.' },
    flameKing: { name: 'The Flame King', act: 4, boss: true, desc: 'He burned his kingdom down to keep it. He is still burning.' },
    lich:      { name: 'The Lich', act: 5, boss: true, desc: 'The will to extinction, born in the last mushroom bomb.' },
  };

  // ---------------------------------------------------------------------------
  // Epitaphs
  // ---------------------------------------------------------------------------
  const HERO_NAMES = { finn: ['Finn', 'the Last Human'], marceline: ['Marceline', 'the Vampire Queen'], fp: ['Flame Princess', 'of the Fire Kingdom'] };
  function heroName(heroId, hero) {
    if (hero && hero.name) return [hero.name, hero.title || ''];
    const h = HM.Heroes && HM.Heroes.list && HM.Heroes.list.find((x) => x.id === heroId);
    if (h) return [h.name, h.title || ''];
    return HERO_NAMES[heroId] || ['A Wanderer', ''];
  }
  // "Sugar Husk" -> "a Sugar Husk", "The Bone Dragon" -> "the Bone Dragon", "Earl of Lemongrab" -> "the Earl of Lemongrab"
  function killerPhrase(k) {
    if (!k || k === 'the dark') return 'the dark';
    const s = String(k);
    if (/^the\s/i.test(s)) return 'the' + s.slice(3);
    if (/^(a|an)\s/i.test(s) || /,/.test(s)) return s;                     // already articled, or a proper "Name, Who Was"
    if (/^(Earl|Lich|Ice King|Flame King|Bone Dragon|Waving Snail)/.test(s)) return 'the ' + s;
    if (s === 'Choose Goose' || s === 'Gunter') return s;
    return (/^[aeiou]/i.test(s) ? 'an ' : 'a ') + s;
  }
  function epitaph(run, killedBy, hero) {
    run = run || {};
    const [name, title] = heroName(run.heroId, hero);
    const full = title ? name + ', ' + title : name;
    const floor = run.floorIndex || 1;
    const act = Math.ceil(floor / 3);
    const actName = (acts[act] || acts[1]).name;
    const k = killerPhrase(killedBy);
    const seed = ((run.seed || 7) + floor * 31 + (run.kills || 0)) >>> 0;
    if (killedBy === 'abandoned' || killedBy === 'Abandoned') {
      return `${name} set down the burden on floor ${floor} and walked into the dark by choice. The grass did not judge. The grass never does.`;
    }
    if (/snail/i.test(String(killedBy))) {
      return `Here lies ${full}. The snail waved. ${name} waved back. It was the last thing ${name} ever did.`;
    }
    if (/lich/i.test(String(killedBy))) {
      return `Here lies ${full}, who reached the bottom of the Well and found it waiting. The Lich did not gloat. He simply added one more name to the quiet.`;
    }
    const T = [
      `Here lies ${full}, unmade by ${k} on floor ${floor}.`,
      `${name} walked into ${actName} and did not walk out. ${cap(k)} saw to that, on floor ${floor}.`,
      `The grass grows over ${name} now. ${cap(k)} did not even stop to look.`,
      `Here rests ${full}. Brave, briefly. Undone by ${k} on floor ${floor}, with ${run.kills || 0} foes sent ahead to make the bed.`,
      `${name} fought for ${fmtTime(run.time || 0)} and ${floor} floors. It was not enough, and then ${k} made sure it was over.`,
      `Ash to ash, and ${name} to ${actName}. Cut down by ${k}. Somewhere, the Lich smiled without a face to do it with.`,
    ];
    return T[seed % T.length];
  }
  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
  function fmtTime(sec) { sec = Math.max(0, Math.floor(sec)); const m = Math.floor(sec / 60), s = sec % 60; return m + ':' + String(s).padStart(2, '0'); }

  // ---------------------------------------------------------------------------
  // Item flavor
  // ---------------------------------------------------------------------------
  const MAT_FLAVOR = {
    iron: 'Honest metal from a dishonest age.',
    steel: 'Folded and folded again, like a letter no one will read.',
    bronze: 'Older than the bombs. It has been sold more times than it has been swung.',
    silver: 'The dead do not like it. Neither does the dark.',
    gold: 'Heavy, soft and beloved. Everything a weapon should not be, and yet.',
    moonsteel: 'Forged on a night when the moon came very close to listen.',
    nightglass: 'Look into it long enough and something looks politely back.',
    bloodiron: 'Rusts red in the rain. It does not rain in here.',
    ossite: 'Bone, worked like metal. Someone was very sure they would not need it back.',
    emberstone: 'Warm to the touch, always. It remembers being a hearth.',
    grass: 'It whispers in green. The whispers are not always kind.',
    demonblood: 'It drinks first and asks later. It does not ask.',
    crystal: 'Grown, not forged, in a cave that hums at night.',
    candy: 'Sticky with a sweetness that has gone very wrong.',
    glacial: 'Cold enough to remember someone you lost.',
  };
  const KIND_FLAVOR = {
    sword: 'Every sword in Ooo was someone\'s first.', axe: 'Made for trees. Used for other things.', bass: 'Tuned a half-step toward grief.',
    staff: 'It leans toward fire when no one is holding it.', wand: 'Points where it wants to. Usually at you.', armor: 'Dented by someone else\'s last stand.',
    trinket: 'Small enough to forget in a pocket. You will not forget it.', spear: 'Long enough to keep the dead at a polite distance.',
  };
  const RARITY_FLAVOR = {
    legendary: 'Songs were written about it. The singers are gone.',
    cursed: 'Something in it is looking back at you.',
  };
  function itemFlavor(item) {
    if (!item) return '';
    if (item.flavor) return item.flavor;
    if (RARITY_FLAVOR[item.rarity] && (((item.uid || 0) + (item.level || 0)) % 2 === 0)) return RARITY_FLAVOR[item.rarity];
    return MAT_FLAVOR[item.material] || KIND_FLAVOR[item.kind] || KIND_FLAVOR[item.slot] || 'It has seen worse. So have you.';
  }

  // ---------------------------------------------------------------------------
  // Victory
  // ---------------------------------------------------------------------------
  const victory = {
    title: 'THE WELL IS QUIET',
    lines: [
      'The Lich comes apart the way winter does: not all at once, but everywhere.',
      'The green fire gutters. For the first time in a thousand years, the Well is only a hole in the ground.',
      'Far above, in the Grasslands, the bone thralls lie down in their ranks and do not get up.',
      'In the Candy Kingdom a husk stops mid-step, looks at its hands, and remembers its own name.',
      'The snow over the Ice Kingdom finally lands. Somewhere in it, a penguin says wenk, softly, to no one.',
      'It will not last. Endings never die; they only wait. But you have bought Ooo a morning.',
      'Go home. Sleep. The light is yours for a while.',
    ],
    ascension: 'The Well remembers you. Next time, it will be deeper.',
  };

  const ascensionNotes = [
    'The world as it is.',
    'Foes hit harder and endure longer.',
    'Elites gain an extra affix.',
    'Healing is scarcer; pancakes are rarer.',
    'Bosses rage sooner.',
    'The Lich watches every floor.',
  ];

  // ---------------------------------------------------------------------------
  // Achievements (unlocked by HM.UI listening to HM.Events). 'slay_lich' is also granted by Game.victory.
  // ---------------------------------------------------------------------------
  const achievements = [
    { id: 'first_blood', name: 'First Blood', desc: 'Make your first kill.' },
    { id: 'elite_slayer', name: 'Crown Breaker', desc: 'Slay an elite.' },
    { id: 'boss_boneDragon', name: 'Ossuary Rest', desc: 'Lay the Bone Dragon back down.' },
    { id: 'boss_lemongrab', name: 'Acceptable', desc: 'Silence the Earl of Lemongrab.' },
    { id: 'boss_iceKing', name: 'Thaw', desc: 'Free what remained of Simon.' },
    { id: 'boss_flameKing', name: 'Embers to Ash', desc: 'Put out the Flame King.' },
    { id: 'slay_lich', name: 'A Morning for Ooo', desc: 'Destroy the Lich.' },
    { id: 'act_2', name: 'Sugar and Rot', desc: 'Reach the Candy Necropolis.' },
    { id: 'act_3', name: 'Into the White', desc: 'Reach the Ice Kingdom.' },
    { id: 'act_4', name: 'Through the Glass', desc: 'Reach the Fire Kingdom.' },
    { id: 'act_5', name: 'The Well Below', desc: "Reach the Lich's Well." },
    { id: 'kills_100', name: 'Century of Bones', desc: 'Defeat 100 foes across all runs.' },
    { id: 'kills_500', name: 'Ash Harvest', desc: 'Defeat 500 foes across all runs.' },
    { id: 'level_10', name: 'Seasoned', desc: 'Reach level 10 in a single run.' },
    { id: 'chests_10', name: 'Dungeon Crawler', desc: 'Open 10 chests.' },
    { id: 'notes_5', name: 'Enchiridion Scholar', desc: 'Recover 5 lost pages.' },
    { id: 'goose_buy', name: 'Choose Wisely', desc: 'Buy something from Choose Goose.' },
    { id: 'snail_death', name: 'He Was Waving', desc: 'Be slain by the Waving Snail.', hidden: true },
    { id: 'no_potions', name: 'Bacon Abstinence', desc: 'Destroy the Lich without eating a pancake or drinking a tonic.' },
    { id: 'ascendant', name: 'Deeper Still', desc: 'Win a run on Ascension 1 or higher.' },
  ];

  // Loading / death tips
  const tips = [
    'Dodge cancels the recovery of attacks and casts. Roll early, roll often.',
    'Fire ignites rot pools and poison clouds. Stand back first.',
    'Frozen foes shatter for bonus damage when struck by anything but ice.',
    'Bleed hurts more on moving targets. Knock them around.',
    'The Dungeon Door wakes only after the elite pack falls.',
    'Mid-floor progress is not saved. Each floor is a promise you have to keep.',
    'Choose Goose appears on the second floor of every act.',
    'Never hit the snail. Especially when its eyes are green.',
  ];

  // Objective line for the HUD
  function objectiveText(floor) {
    if (!floor) return '';
    if (floor.objectiveText) return floor.objectiveText; // set by HM.Tutorial (prologue) or any scripted floor
    if (floor.isPrologue) return floor.exitOpen ? 'The Dungeon Door is open' : 'Follow the lanterns to the Tree Fort';
    if (floor.exitOpen) return 'The Dungeon Door is open';
    const o = floor.objective; if (!o) return 'Find the Dungeon Door';
    const n = o.remaining || 1;
    if (o.type === 'elite') return n > 1 ? `Slay the elites to wake the Dungeon Door (${n} left)` : 'Slay the elite to wake the Dungeon Door';
    if (o.type === 'boss') { const b = BOSSES[floor.bossId]; return 'Destroy ' + (b ? b.name.replace(/^The /, 'the ') : 'the guardian'); }
    if (o.type === 'clear') return 'Clear the floor to wake the Dungeon Door';
    return 'Find the Dungeon Door';
  }

  const Lore = (HM.Lore = {
    acts, floorIntro, bossIntro, BOSSES, bossDefeat, notes, barks, heroBlurbs, bestiary, epitaph, itemFlavor, victory,
    achievements, ascensionNotes, tips, objectiveText, fmtTime, prologue, beat, remnants, moves,
    note(id) { return notes.find((n) => n.id === id) || null; },
    achievement(id) { return achievements.find((a) => a.id === id) || null; },
    // a random bark for a def id (or null)
    bark(defId, rng) { const l = barks[defId]; if (!l || !l.length) return null; const r = rng ? rng.next() : Math.random(); return l[Math.floor(r * l.length)]; },
    // choose a note to reveal: prefer unread notes of this act, then any unread, then a re-read
    // (fixed entries, i.e. the prologue page and remnant conversations, are never handed out at random)
    pickNote(act, extraSeen) {
      const codex = (HM.Save && HM.Save.data && HM.Save.data.meta && HM.Save.data.meta.codex) || {};
      const seen = (id) => !!codex[id] || (extraSeen && extraSeen.indexOf(id) >= 0);
      const loose = notes.filter((n) => !n.fixed);
      const inAct = loose.filter((n) => n.act === act);
      let pool = inAct.filter((n) => !seen(n.id));
      if (!pool.length) pool = loose.filter((n) => !seen(n.id) && n.act <= act);
      if (!pool.length) pool = inAct.length ? inAct : loose;
      return pool[Math.floor(Math.random() * pool.length)];
    },
  });

  // ---------------------------------------------------------------------------
  // Interact: note (a glowing page on the ground). World creates it via makeInteractable('note', ...).
  // ---------------------------------------------------------------------------
  HM.Interact = HM.Interact || {};
  HM.Interact.note = function (obj, player) {
    const G = HM.Game, run = G && G.run;
    const act = (obj && obj.act) || (G && G.floor && G.floor.act) || 1;
    let entry = obj && obj.noteId ? Lore.note(obj.noteId) : null;
    if (!entry) entry = Lore.pickNote(act, run ? run.codexThisRun : null);
    if (!entry) return;
    if (obj) { obj.used = true; obj.noteId = entry.id; }
    const isNew = HM.Save && HM.Save.unlockCodex ? HM.Save.unlockCodex(entry.id) : false;
    if (run) { run.codexThisRun = run.codexThisRun || []; if (run.codexThisRun.indexOf(entry.id) < 0) run.codexThisRun.push(entry.id); }
    HM.Audio && HM.Audio.play && HM.Audio.play('note');
    HM.Events && HM.Events.emit('noteRead', { id: entry.id, isNew, player });
    if (HM.UI && HM.UI.showNote) HM.UI.showNote(Object.assign({ isNew }, entry));
  };
})();
