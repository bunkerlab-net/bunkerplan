/**
 * Refuses a Cloudflare deploy that would ship the local-dev placeholders.
 *
 * The placeholder D1/KV ids and the localhost base URL exist so `bun run dev`
 * works with no setup. Shipping them is silently broken rather than loudly
 * broken: a localhost `PUBLIC_BASE_URL` makes WebAuthn reject every ceremony,
 * because the relying-party origin must match the browser origin exactly.
 */
const PLACEHOLDERS: ReadonlyArray<{ needle: string; fix: string }> = [
  {
    needle: '"database_id": "00000000-0000-0000-0000-000000000000"',
    fix: "d1_databases[0].database_id — run `wrangler d1 create bunkerplan`",
  },
  {
    needle: '"id": "00000000000000000000000000000000"',
    fix: "kv_namespaces[0].id — run `wrangler kv namespace create KV`",
  },
  {
    needle: '"PUBLIC_BASE_URL": "http://localhost:3000"',
    fix: "vars.PUBLIC_BASE_URL — set the real origin, e.g. https://plans.example.com",
  },
];

const config = await Bun.file("wrangler.jsonc").text();
const unresolved = PLACEHOLDERS.filter((p) => config.includes(p.needle));

if (unresolved.length > 0) {
  console.error(
    "wrangler.jsonc still contains local-development placeholders:\n" +
      unresolved.map((p) => `  - ${p.fix}`).join("\n") +
      "\n\nAlso confirm the secret is set: wrangler secret put BETTER_AUTH_SECRET",
  );
  process.exit(1);
}
