import type { NextConfig } from "next";
import { resolve } from "node:path";
const config: NextConfig = {
  turbopack: { root: resolve(process.cwd(), "..") },
  devIndicators: false,
};
export default config;
