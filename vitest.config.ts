import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const config = defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    env: {
      ENVIRONMENT: "local",
    },
  },
});

export default config;
