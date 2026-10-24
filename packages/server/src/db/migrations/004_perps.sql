-- Perpetuals. Perp orders are kept in `orders` and their trade cursors in `trade_cursor`, both with
-- market 'perp'; perp fills in `fills` with market 'perp'.

-- Open positions only, at most one per symbol: a row is deleted when its position closes.
CREATE TABLE positions (
  season_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (season_id, symbol)
);

CREATE TABLE perp_settings (
  season_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  leverage INTEGER NOT NULL,
  margin_mode TEXT NOT NULL,
  PRIMARY KEY (season_id, symbol)
);

-- The funding windows open, waiting for their rate, and the funding times already applied (JSON).
CREATE TABLE perp_state (
  season_id INTEGER PRIMARY KEY,
  funding TEXT NOT NULL
);

-- Replays of the trades a gap in live data missed, per season, market and symbol.
CREATE TABLE catchup_jobs (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL,
  market TEXT NOT NULL,
  symbol TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  last_trade_id_before INTEGER,
  end_trade_id INTEGER,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX catchup_jobs_key_status ON catchup_jobs(season_id, market, symbol, status);

-- A perp fill's position, and the part of a reducing fill's loss nothing could cover. NULL on
-- every spot fill.
ALTER TABLE fills ADD COLUMN position_id TEXT;
ALTER TABLE fills ADD COLUMN uncovered TEXT;
