// Full, eager mode list (PLAN.md 6), used by the tests and the asset scripts. The app itself goes through
// registry.js, which loads modes on demand; importing this file registers every mode there as well.
// Adding a mode = create the file in this folder, import it here, add it to registry.js (IMPORTERS) and run
// `cd tests && node make-mode-meta.mjs`. The order below is the order of the list in the UI (grouped by category).

import ascii from './ascii.js';
import braille from './braille.js';
import ansi from './ansi.js';
import petscii from './petscii.js';
import matrix from './matrix.js';
import typoportrait from './typoportrait.js';
import dither1bit from './dither1bit.js';
import halftone from './halftone.js';
import pixelart from './pixelart.js';
import led from './led.js';
import thermal from './thermal.js';
import glitch from './glitch.js';
import pixelsort from './pixelsort.js';
import crosshatch from './crosshatch.js';
import linehalftone from './linehalftone.js';
import contours from './contours.js';
import voronoi from './voronoi.js';
import flowfield from './flowfield.js';
import blueprint from './blueprint.js';
import vectrex from './vectrex.js';
import spiral from './spiral.js';
import lidar from './lidar.js';
import hiddenwire from './hiddenwire.js';
import raymarch from './raymarch.js';
import volumetext from './volumetext.js';
import reactiondiffusion from './reactiondiffusion.js';
import { CATEGORIES, checkMode, registerMode, modeAvailable } from './registry.js';

export { CATEGORIES, modeAvailable };

export const MODES = [
  ascii,
  braille,
  ansi,
  petscii,
  matrix,
  typoportrait,
  dither1bit,
  halftone,
  pixelart,
  led,
  thermal,
  glitch,
  pixelsort,
  crosshatch,
  linehalftone,
  contours,
  voronoi,
  flowfield,
  blueprint,
  vectrex,
  spiral,
  lidar,
  hiddenwire,
  raymarch,
  volumetext,
  reactiondiffusion,
];

MODES.forEach(checkMode);
MODES.forEach(registerMode);

export const MODE_IDS = MODES.map((m) => m.id);
export const hasMode = (id) => MODES.some((m) => m.id === id);
export const getMode = (id) => MODES.find((m) => m.id === id) || MODES[0];
export const modesByCategory = () => CATEGORIES
  .map((cat) => ({ category: cat, modes: MODES.filter((m) => m.category === cat) }))
  .filter((g) => g.modes.length);
