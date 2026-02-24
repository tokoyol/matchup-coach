import { Pool, type PoolClient } from "pg";

let poolInstance: Pool | null = null;

async function withClient<T>(pool: Pool, handler: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await handler(client);
  } finally {
    client.release();
  }
}

export async function getPostgresPool(connectionString: string): Promise<Pool> {
  if (poolInstance) return poolInstance;

  poolInstance = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false }
  });

  await withClient(poolInstance, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS matchup_stats_cache (
        id BIGSERIAL PRIMARY KEY,
        patch TEXT NOT NULL,
        lane TEXT NOT NULL,
        player_champion TEXT NOT NULL,
        enemy_champion TEXT NOT NULL,
        stats_json JSONB NOT NULL,
        computed_at TIMESTAMPTZ NOT NULL,
        expires_at BIGINT NOT NULL,
        UNIQUE (patch, lane, player_champion, enemy_champion)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_matchup_stats_cache_patch_lane
        ON matchup_stats_cache (patch, lane);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_matchup_stats_cache_expires
        ON matchup_stats_cache (expires_at);
    `);
  });

  return poolInstance;
}
