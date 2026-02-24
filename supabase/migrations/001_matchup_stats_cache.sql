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

CREATE INDEX IF NOT EXISTS idx_matchup_stats_cache_patch_lane
  ON matchup_stats_cache (patch, lane);

CREATE INDEX IF NOT EXISTS idx_matchup_stats_cache_expires
  ON matchup_stats_cache (expires_at);
