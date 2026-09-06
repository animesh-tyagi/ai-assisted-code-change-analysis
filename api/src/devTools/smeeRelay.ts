/**
 * Local webhook delivery (M6 Phase 6) — relays a smee.io channel to this
 * machine's `POST /api/webhooks/github` so GitHub can reach a laptop with no
 * public URL of its own. Dev-only; nothing in `src/index.ts` or the deployed
 * server depends on this.
 *
 * ```
 * npm run dev:webhook-relay
 * ```
 *
 * Get a channel at https://smee.io ("Start a new channel"), put its URL in
 * `.env` as `SMEE_URL`, and set the GitHub App's own webhook URL to that same
 * channel — the relay only forwards deliveries GitHub already sent there.
 */

import SmeeClient from 'smee-client';

interface SmeeConfig {
  source: string;
  targetPort: number;
}

function loadSmeeConfig(): SmeeConfig {
  const source = process.env.SMEE_URL;
  if (source === undefined || source === '') {
    throw new Error(
      'SMEE_URL is not set — get a channel URL from https://smee.io and put it in .env',
    );
  }
  return { source, targetPort: Number(process.env.PORT ?? 3000) };
}

async function main(): Promise<void> {
  const config = loadSmeeConfig();
  const target = `http://localhost:${String(config.targetPort)}/api/webhooks/github`;

  const client = new SmeeClient({ source: config.source, target, logger: console });
  await client.start();
  console.log(`[smee] relaying ${config.source} -> ${target}`);

  const shutdown = (): void => {
    client
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error('[smee] error while stopping:', err);
        process.exit(1);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error('[smee] fatal:', err);
  process.exitCode = 1;
});
