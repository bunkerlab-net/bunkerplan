/**
 * The development loop, in place of `vite dev`.
 *
 * Two processes, because there are two bundles with different lifetimes: the
 * browser one has to be rebuilt to disk before the server can reference its
 * hashed filename, and the server one is whatever runtime you asked for.
 *
 * Defaults to workerd, which is the primary deployment target - `wrangler dev`
 * bundles src/worker.ts itself and serves `dist/client` as static assets.
 * `bun run dev:node` runs the self-hosted entry instead.
 *
 * What this does not do is push a rebuild to the browser. Vite's HMR is the
 * one thing lost in the move off it; reload the tab.
 */
import { watch } from "node:fs";

const PORT = process.env["PORT"] ?? "3000";

const target = process.argv[2] === "node" ? "node" : "workers";

/**
 * `--local-upstream` is not optional here.
 *
 * `wrangler.jsonc` declares a `routes` entry for the production custom domain,
 * and `wrangler dev` takes its local upstream host from that route unless told
 * otherwise. The Worker then sees `Origin: http://plan.bunkerlab.net` on a
 * request the browser actually sent from `http://localhost:3000`, Better Auth
 * compares it against `PUBLIC_BASE_URL`, and every passkey ceremony fails with
 * `INVALID_ORIGIN`. The port matters as much as the host: `localhost` alone
 * yields `http://localhost` and fails the same way.
 */
const command =
  target === "node"
    ? ["bun", "--hot", "src/node.ts"]
    : [
        "bun",
        "wrangler",
        "dev",
        "--port",
        PORT,
        "--local-upstream",
        `localhost:${PORT}`,
      ];

function build(): boolean {
  const result = Bun.spawnSync(["bun", "run", "scripts/build.ts"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode === 0;
}

if (!build()) process.exit(1);

console.log(`\n${target} — http://localhost:${PORT}\n`);

const server = Bun.spawn(command, {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, PORT },
});

// Coalesced: an editor save fires several events, and a rebuild takes longer
// than the burst does. The generated manifest is skipped or the build would
// retrigger itself.
let pending: ReturnType<typeof setTimeout> | undefined;
const watcher = watch("src", { recursive: true }, (_event, filename) => {
  if (filename === null || filename.endsWith("manifest.generated.ts")) return;
  clearTimeout(pending);
  pending = setTimeout(() => {
    console.log(`\nrebuilding (${filename})`);
    build();
  }, 120);
});

const stop = () => {
  watcher.close();
  server.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// The watcher holds the event loop open, so closing it is what lets this
// script exit when the server dies on its own rather than hanging on a dead
// port. Its status is ours: a crashed server must not report success.
const code = await server.exited;
watcher.close();
process.exit(code);
