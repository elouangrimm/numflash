// What NumFlash knows about NumPlay's files. Source: NumPlay's README, Makefile and release.py
// (https://github.com/Mason363/NumPlay).

export const BIG_BYTES = 1048576;

// Big games install on their own: one of them (or NumPlay) at a time. NumPlay first, then the favourites.
export const BIG_ORDER = [
  'NumPlay.nwa', 'Celeste.nwa', 'ChampionIsland.nwa', 'HollowKnight.nwa',
  'Undertale.nwa', 'FinalEarth2.nwa', 'NumPowder.nwa',
];

export const TAGLINES = {
  'NumPlay.nwa': '17 games in one app',
  'Celeste.nwa': 'The whole climb, every B-side and C-side',
  'ChampionIsland.nwa': 'The whole island and its seven sports',
  'HollowKnight.nwa': "From King's Pass to Hornet in Greenpath",
  'Undertale.nwa': 'The whole Underground, to the neutral ending',
  'FinalEarth2.nwa': 'Build a city on floating islands in space',
  'NumPowder.nwa': 'The Powder Toy: 175 materials to mix, melt and burn',
};

// Other versions of NumPlay. Same app, same saves.
export const VARIANT_INFO = {
  'NumPlay-Invisible.nwa': 'NumPlay in disguise: a blank white icon with no name, so it looks like an empty spot on the calculator’s home screen. It is the same app with the same saves.',
  'NumPlay-Matrices.nwa': 'NumPlay in disguise: it shows up as a math app called “Matrices”. It is the same app with the same saves.',
  'NumPlay-French.nwa': 'NumPlay in French (same app, same saves).',
  'NumPlay-Chinese.nwa': 'NumPlay in Chinese (same app, same saves).',
  'NumPlay-Upsilon.nwa': 'Only for calculators running Upsilon (N0110/N0115): the 14 games that fit its memory.',
};
// the two the user asked to flag with an (i) button
export const DISGUISED = new Set(['NumPlay-Invisible.nwa', 'NumPlay-Matrices.nwa']);

export const isNumPlayVariant = (name) => /^NumPlay-.+\.nwa$/i.test(name);
const BIG_SET = new Set(BIG_ORDER.map((n) => n.toLowerCase()));

/** 'big': takes the whole extra-apps area (NumPlay, its versions, big games). 'small': can go next to others. */
export function roleOf(asset) {
  const n = asset.name.toLowerCase();
  if (BIG_SET.has(n) || isNumPlayVariant(asset.name)) return 'big';
  return (asset.size || 0) >= BIG_BYTES ? 'big' : 'small';
}

/** Home screen: NumPlay and the big games, in order. */
export function homeBig(assets) {
  const byName = new Map(assets.map((a) => [a.name.toLowerCase(), a]));
  const out = [];
  for (const n of BIG_ORDER) if (byName.has(n.toLowerCase())) out.push(byName.get(n.toLowerCase()));
  // a new big game that this list doesn't know yet still shows up on the home screen
  for (const a of assets) if (roleOf(a) === 'big' && !isNumPlayVariant(a.name) && !out.includes(a)) out.push(a);
  return out;
}

// ---- saves -------------------------------------------------------------------------------------
// Python scripts NumPlay's games keep their progress in (from each game's source: COPY_NAME).
export const SAVE_FILES = {
  'numplay_saves.py': { title: 'NumPlay', asset: 'NumPlay.nwa' },
  'celeste_saves.py': { title: 'Celeste', asset: 'Celeste.nwa' },
  'champion_saves.py': { title: 'Champion Island', asset: 'ChampionIsland.nwa' },
  'hollowknight_saves.py': { title: 'Hollow Knight', asset: 'HollowKnight.nwa' },
  'undertale_saves.py': { title: 'Undertale', asset: 'Undertale.nwa' },
  'finalearth2_saves.py': { title: 'The Final Earth 2', asset: 'FinalEarth2.nwa' },
  'numpowder_saves.py': { title: 'NumPowder', asset: 'NumPowder.nwa' },
  'numblocks_saves.py': { title: 'NumBlocks', asset: 'NumBlocks.nwa' },
};
// Scripts that come with every calculator.
export const DEFAULT_SCRIPTS = new Set(['mandelbrot.py', 'polynomial.py', 'parabola.py']);

export const saveInfo = (fileName) => SAVE_FILES[fileName.toLowerCase()] || null;
/** Which calculator records NumFlash backs up: Python scripts, except the ones every calculator has. */
export const isBackupName = (name) => /\.py$/i.test(name) && !DEFAULT_SCRIPTS.has(name.toLowerCase());
