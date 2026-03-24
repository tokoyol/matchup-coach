# Matchup Coach

Pick your champion and your opponent's. Matchup Coach returns lane advice: trade patterns, all-in windows, rune adjustments, and three common mistakes. Built to fit a champion select window.

## Features

- **Matchup advice for any two champions:** early game plan, level 1-3 rules, all-in windows, common mistakes
- **Botlane context:** ADC and support each get separate advice vs the enemy ADC and support
- **Stat-backed confidence:** win rate and sample size from Lolalytics; responses carry low/medium/high confidence based on sample size
- **Gemini coaching:** Gemini 2.0 Flash generates the advice text when stats are available; rule-based templates cover the rest
- **Fact guard:** catches wrong advice lines (wrong resource type, non-dodgeable abilities, self-referencing champion names) and corrects them before the response goes out
- **Dual language:** English and Japanese (`?language=ja`)

## Stack

- **Backend:** Node.js, Express, TypeScript
- **AI:** Google Gemini 2.0 Flash
- **Database:** SQLite (local dev) or Postgres/Supabase (production)
- **Stats:** Lolalytics scraper, runs weekly via GitHub Actions
- **Deployment:** any Node host; backend only (no frontend in this repo)

## API

### `POST /api/matchup`

**Body**
```json
{
  "playerChampion": "Jinx",
  "enemyChampion": "Caitlyn",
  "lane": "bot",
  "playerRole": "adc",
  "playerChampionPartner": "Thresh",
  "enemyChampionPartner": "Lux",
  "patch": "26.5",
  "language": "en"
}
```

**Response fields**
| Field | Description |
|---|---|
| `difficulty` | `easy` / `favored` / `even` / `not_favored` / `hard` |
| `earlyGamePlan` | One-paragraph lane approach |
| `level1to3Rules` | 3-5 specific rules for the opening levels |
| `allInWindows` | 2-5 timing windows, each with a signal and action |
| `runeAdjustments` | Keystone recommendation with reason |
| `commonMistakes` | Three mistakes specific to this matchup |
| `botlaneAdvice` | Threat patterns, spacing rules, and punish windows vs both enemy champs |
| `meta` | Data confidence, sample size, win rate, source flags |

### `GET /health`

Returns `{ ok: true, patch }`.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | Server port |
| `CURRENT_PATCH` | `26.4` | Patch used when the request omits one |
| `DB_PROVIDER` | `sqlite` | `sqlite` or `postgres` |
| `DATABASE_URL` | — | Postgres connection string; required when `DB_PROVIDER=postgres` |
| `STATS_DB_PATH` | `./data/matchup-coach.db` | SQLite file path |
| `GEMINI_API_KEY` | — | Gemini API key |
| `GEMINI_API_KEYS` | — | Comma-separated keys; rotated on rate limit |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Gemini model name |
| `EXTERNAL_STATS_PROVIDER` | `none` | `none` or `lolalytics` |
| `EXTERNAL_STATS_TIMEOUT_MS` | `3500` | Per-request timeout for Lolalytics fetches (ms) |
| `MATCHUP_MIN_SAMPLE_GAMES` | `10` | Minimum sample before the scraper treats stats as usable |
| `STATS_CACHE_TTL_MINUTES` | `60` | How long scraped stats stay valid |

## Running Locally

```bash
npm install
cp .env.example .env   # fill in your keys
npm run dev
```

## Stats Pipeline

The scraper pulls matchup win rates from Lolalytics and writes them to Postgres. GitHub Actions runs it on a weekly schedule.

### Scrape a patch manually

```bash
npm run scrape:lolalytics -- \
  --patch 26.5 \
  --lane top \
  --allChampions \
  --requestDelayMs 140
```

**CLI flags**

| Flag | Description |
|---|---|
| `--patch` | Patch to scrape (e.g. `26.5`) |
| `--lane` | Lane(s): `top`, `mid`, `adc`, `support`, `jungle` |
| `--allChampions` | Fetches the champion list from Data Dragon (172 champs) |
| `--champions` | Comma-separated list; alternative to `--allChampions` |
| `--startIndex` | Start offset into the pair list |
| `--maxPairs` | Max pairs to process in this run |
| `--skipExisting` | Skip pairs already in the database for this patch |
| `--requestDelayMs` | Delay between requests (ms) |

### GitHub Actions workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `lolalytics-botlane-deep.yml` | Fridays 5pm CST + manual | Full ADC and support scrape: 4 chunks of 7500 pairs each, covering all 29,412 pairs per lane |
| `lolalytics-refresh.yml` | Manual | Patch refresh for configured lanes |

The deep botlane workflow runs 8 sequential jobs (4 ADC, 4 support), each with a 2-hour timeout. At 120ms per request, each chunk takes about 15 minutes.

### Circuit breaker

The scraper calls `process.exit(1)` after 20 consecutive service failures (`http_error`, `timeout`, `network_error`). A `parse_miss` (matchup has no data on Lolalytics) does not count toward the threshold.

HTTP 429s, 5xx errors, and timeouts each retry up to 3 times with exponential backoff: 1s, 2s, 4s.

## License

MIT
