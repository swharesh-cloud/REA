import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const appRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // This folder lives inside the REA repo, which has its own lockfile.
  // Keep tracing and Turbopack rooted here so the parent project is not bundled.
  outputFileTracingRoot: appRoot,
  turbopack: {
    root: appRoot,
  },
};

export default nextConfig;
