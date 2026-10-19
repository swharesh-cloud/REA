import { apiFunction } from "../src/server/vercel-entry.js";

export const config = { runtime: "nodejs", maxDuration: 60 };

export default apiFunction("/api/comps");
