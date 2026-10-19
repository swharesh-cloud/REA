import { apiFunction } from "../src/server/vercel-entry.js";

export const config = { runtime: "nodejs", maxDuration: 60 };

const route = apiFunction("/api/comps.csv");

export default {
  fetch(request) {
    return route.fetch(request);
  },
};
