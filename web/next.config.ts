import type { NextConfig } from "next";

// The desktop app's lockfile sits one level up; keep Next scoped to web/.
const config: NextConfig = {
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
};

export default config;
