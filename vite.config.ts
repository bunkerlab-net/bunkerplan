import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

// One source tree, two deployment targets. `BUILD_TARGET` picks both the
// deployment plugin and which runtime module the `#runtime` alias resolves to,
// so `pg`/`ioredis`/`bun:sqlite` are unreachable from the Workers bundle.
const target = process.env["BUILD_TARGET"] === "node" ? "node" : "cloudflare";

export default defineConfig({
  resolve: {
    alias: {
      "#runtime": new URL(`./src/runtime/${target}.ts`, import.meta.url)
        .pathname,
    },
  },
  plugins: [
    ...(target === "cloudflare"
      ? [cloudflare({ viteEnvironment: { name: "ssr" } })]
      : [nitro()]),
    tanstackStart(),
    react(),
  ],
});
