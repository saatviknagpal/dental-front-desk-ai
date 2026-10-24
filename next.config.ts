import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default nextConfig;
