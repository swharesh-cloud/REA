import { createMaricopaSource } from "./maricopa-source.js";
import { createPinalSource } from "./pinal-source.js";
import { createSampleSource } from "./sample-source.js";

/** Sample first so the offline Arizona demo is the default source. */
export const createRegistry = (options = {}) => [
  createSampleSource(),
  createMaricopaSource(options),
  createPinalSource(options),
];
