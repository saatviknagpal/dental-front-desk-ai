import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native/WASM DB drivers are loaded at runtime instead of being bundled.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default nextConfig;
