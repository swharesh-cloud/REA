import { apiFunction } from "../src/server/vercel-entry.js";

export const config = { runtime: "nodejs", maxDuration: 60 };

const route = apiFunction("/api/sources");

export default {
  fetch(request) {
    return route.fetch(request);
  },
};
