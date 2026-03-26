-- Migration: Enable Row Level Security on matchup_stats_cache
-- Fixes: rls_disabled_in_public advisory flagged by Supabase Security Advisor
-- Project: jlfcvpubgrcctmwswvnz (tokoyol's Project)

-- Step 1: Enable RLS on the table
ALTER TABLE matchup_stats_cache ENABLE ROW LEVEL SECURITY;

-- Step 2: Allow public read access
-- matchup_stats_cache contains public League of Legends matchup data
-- scraped from Lolalytics. Anyone (including unauthenticated users via the
-- anon key) should be able to read it. Writes are done by the backend
-- scraper via a direct DATABASE_URL connection (postgres superuser), which
-- bypasses RLS entirely, so no INSERT/UPDATE/DELETE policies are needed.
CREATE POLICY "Allow public read access"
  ON matchup_stats_cache
  FOR SELECT
  TO anon, authenticated
  USING (true);
