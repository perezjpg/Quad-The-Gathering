// Decks de demostración (listas de 100 cartas) para probar la mesa sin pegar links.

function build(commander, spells, basics) {
  const lines = ['Commander', `1 ${commander}`, '', 'Deck'];
  for (const s of spells) lines.push(`1 ${s}`);
  const remaining = 99 - spells.length;
  const names = Object.keys(basics);
  const weights = Object.values(basics);
  const totalW = weights.reduce((a, b) => a + b, 0);
  let given = 0;
  names.forEach((n, i) => {
    const q = i === names.length - 1 ? remaining - given : Math.round((remaining * weights[i]) / totalW);
    given += q;
    if (q > 0) lines.push(`${q} ${n}`);
  });
  return lines.join('\n');
}

export const DEMO_DECKS = [
  {
    name: 'Chatterfang Squirrels',
    player: 'Miku',
    text: build(
      'Chatterfang, Squirrel General',
      [
        'Sol Ring', 'Arcane Signet', 'Golgari Signet', 'Cultivate', "Kodama's Reach", 'Rampant Growth',
        'Llanowar Elves', 'Elvish Mystic', 'Birds of Paradise', 'Squirrel Nest', 'Deranged Hermit',
        'Toski, Bearer of Secrets', 'Scurry Oak', 'Chitterspitter', 'Squirrel Wrangler', 'Swarmyard',
        "Nadier's Nightblade", 'Pitiless Plunderer', 'Zulaport Cutthroat', 'Blood Artist', 'Viscera Seer',
        'Carrion Feeder', 'Ravenous Squirrel', 'Tireless Provisioner', 'Beast Within', "Assassin's Trophy",
        'Putrefy', 'Murder', 'Doom Blade', 'Harmonize', "Night's Whisper", 'Sign in Blood', 'Toxic Deluge',
        'Skullclamp', 'Lightning Greaves', 'Swiftfoot Boots', 'Command Tower', 'Overgrown Tomb',
        'Llanowar Wastes', 'Woodland Cemetery', 'Golgari Rot Farm', 'Evolving Wilds', 'Terramorphic Expanse',
        'Grim Backwoods', 'Gilded Goose', 'Wood Elves', 'Farhaven Elf', 'Ravenous Chupacabra', 'Plaguecrafter',
        'Grave Pact', 'Eternal Witness', 'Liliana, Death Wielder', 'Tendershoot Dryad', 'Hornet Queen',
        'Acorn Harvest', 'Chatter of the Squirrel', 'Krosan Grip', 'Abrupt Decay', 'Golgari Charm',
        'Sylvan Library', 'Garruk, Primal Hunter',
      ],
      { Forest: 3, Swamp: 2 }
    ),
  },
  {
    name: 'Krenko Goblins',
    player: 'Kuromi',
    text: build(
      'Krenko, Mob Boss',
      [
        'Sol Ring', 'Arcane Signet', 'Mind Stone', 'Fire Diamond', 'Goblin Matron', 'Goblin Recruiter',
        'Goblin Warchief', 'Goblin Chieftain', 'Goblin King', 'Legion Loyalist', 'Skirk Prospector',
        'Goblin Instigator', 'Beetleback Chief', 'Mogg War Marshal', 'Krenko, Tin Street Kingpin',
        'Siege-Gang Commander', 'Goblin Rabblemaster', 'Purphoros, God of the Forge', 'Impact Tremors',
        'Shared Animosity', 'Coat of Arms', 'Lightning Bolt', 'Chaos Warp', 'Blasphemous Act', 'Vandalblast',
        'Abrade', 'Fiery Confluence', 'Faithless Looting', 'Lightning Greaves', 'Swiftfoot Boots',
        'Thousand-Year Elixir', 'Goblin Bombardment', 'Skullclamp', 'Command Tower', 'Goblin Piledriver',
        'Goblin Ringleader', 'Goblin Lackey', 'Conspicuous Snoop', 'Muxus, Goblin Grandee',
        'Battle Hymn', 'Hellrider', 'Goblin Trashmaster', 'Goblin Sharpshooter', 'Mogg Fanatic',
        'Goblin Guide', 'Wort, Boggart Auntie', 'Boggart Shenanigans', 'Pashalik Mons', 'Gempalm Incinerator',
        'Kiki-Jiki, Mirror Breaker', 'Valakut Awakening // Valakut Stoneforge', 'Thrill of Possibility',
        'Reckless Charge', 'Mountain Goat', 'Volcanic Fallout', 'Arc Trail',
        'Lightning Strike', 'Searing Spear',
      ],
      { Mountain: 1 }
    ),
  },
  {
    name: 'Talrand Spells',
    player: 'Hatsune',
    text: build(
      'Talrand, Sky Summoner',
      [
        'Sol Ring', 'Arcane Signet', 'Mind Stone', 'Sky Diamond', 'Counterspell', 'Brainstorm', 'Ponder',
        'Preordain', 'Opt', 'Consider', 'Impulse', 'Fact or Fiction', 'Rhystic Study', 'Mystic Remora',
        'Cyclonic Rift', 'Swan Song', 'Negate', 'Arcane Denial', 'Mana Leak', 'Pongify', 'Rapid Hybridization',
        'Reality Shift', 'Into the Roil', 'Blink of an Eye', "Talrand's Invocation", 'Murmuring Mystic',
        'Archmage Emeritus', 'Metallurgic Summonings', 'Command Tower', 'Thing in the Ice', 'Baral, Chief of Compliance',
        'Sea Gate Oracle', 'Mulldrifter', 'Frantic Search', 'Gitaxian Probe', 'Thought Scour', 'Deep Analysis',
        'Treasure Cruise', 'Dig Through Time', 'Ancestral Vision', 'Divination', 'Think Twice', 'Lat-Nam\'s Legacy',
        'Snap', 'Unsummon', 'Repulse', 'Capsize', 'Aetherize', 'Evacuation', 'Whirlwind Denial',
        'Lightning Greaves', 'Swiftfoot Boots', 'Commander\'s Sphere', 'Thran Dynamo',
        'Riptide Laboratory', 'Mystic Sanctuary', 'Reliquary Tower',
      ],
      { Island: 1 }
    ),
  },
  {
    name: 'Edgar Vampires',
    player: 'Shiro',
    text: build(
      'Edgar Markov',
      [
        'Sol Ring', 'Arcane Signet', 'Boros Signet', 'Rakdos Signet', 'Orzhov Signet', 'Talisman of Conviction',
        'Bloodline Keeper', 'Captivating Vampire', 'Vampire Nocturnus', 'Stromkirk Captain', 'Legion Lieutenant',
        'Sorin, Vengeful Bloodlord', 'Cordial Vampire', 'Vampire of the Dire Moon', 'Bloodghast',
        'Drana, Liberator of Malakir', 'Elenda, the Dusk Rose', 'Twilight Prophet', 'Swords to Plowshares',
        'Path to Exile', 'Terminate', 'Anguished Unmaking', 'Vindicate', 'Wrath of God', 'Lightning Greaves',
        'Heirloom Blade', 'Kindred Discovery', 'Door of Destinies', 'Command Tower', 'Nomad Outpost',
        'Savai Triome', 'Clifftop Retreat', 'Isolated Chapel', 'Dragonskull Summit', 'Arcane Sanctum',
        'Viscera Seer', 'Blood Artist', 'Bloodthrone Vampire', 'Vampire Socialite', 'Indulgent Aristocrat',
        'Champion of Dusk', 'New Blood', 'Anowon, the Ruin Thief', 'Olivia Voldaren', 'Olivia, Mobilized for War',
        'Patron of the Vein', 'Butcher of Malakir', 'Vona, Butcher of Magan', 'Falkenrath Noble',
        'Mavren Fein, Dusk Apostle', 'Sanctum Seeker', 'Utter End', 'Despark', 'Damn',
        'Bloodsworn Steward', 'Teferi\'s Protection', 'Shadow Alley Denizen', 'Knight of the Ebon Legion',
      ],
      { Plains: 1, Swamp: 1, Mountain: 1 }
    ),
  },
];
