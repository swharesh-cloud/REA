import { createCache } from "./http.js";
import { createMaricopaDebtLookup } from "./maricopa-recorder.js";
import { createPinalDebtLookup } from "./pinal-recorder.js";

export const createDebtLookups = ({
  fetchImpl = globalThis.fetch,
  cache = createCache(),
  now = () => new Date(),
} = {}) => ({
  maricopa: createMaricopaDebtLookup({ fetchImpl, cache, now }),
  pinal: createPinalDebtLookup(),
});
