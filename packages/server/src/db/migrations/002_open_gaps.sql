-- Gaps in live data not yet recorded as feed_gap events, one per season, market and symbol. A row
-- is written when its gap opens and deleted in the transaction that records the feed_gap, so a
-- crash keeps the gap's start.
CREATE TABLE open_gaps (
  season_id INTEGER NOT NULL,
  market TEXT NOT NULL,
  symbol TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (season_id, market, symbol)
);
