CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE seasons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL,
  time INTEGER NOT NULL,
  type TEXT NOT NULL,
  symbol TEXT,
  market TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX events_season_time ON events(season_id, time DESC);
CREATE INDEX events_symbol ON events(symbol);
CREATE INDEX events_type ON events(type);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

-- No CHECK on type/status: an order of unknown type must still be storable.
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  season_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX orders_season_status ON orders(season_id, status);

CREATE TABLE fills (
  id TEXT PRIMARY KEY,
  season_id INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,
  side TEXT NOT NULL,
  qty TEXT NOT NULL,
  price TEXT NOT NULL,
  quote TEXT NOT NULL,
  liquidity TEXT NOT NULL,
  fee_asset TEXT NOT NULL,
  fee TEXT NOT NULL,
  fee_usd TEXT NOT NULL,
  best_at_arrival TEXT,
  best_at_submit TEXT,
  slippage_usd TEXT NOT NULL,
  drift_usd TEXT NOT NULL,
  trigger_price TEXT,
  realized_pnl TEXT,
  round_trip_id TEXT,
  time INTEGER NOT NULL
);
CREATE INDEX fills_symbol_time ON fills(symbol, time);

CREATE TABLE balances (
  season_id INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  asset TEXT NOT NULL,
  free TEXT NOT NULL,
  locked TEXT NOT NULL,
  PRIMARY KEY (season_id, wallet, asset)
);

CREATE TABLE basis (
  season_id INTEGER NOT NULL,
  asset TEXT NOT NULL,
  qty TEXT NOT NULL,
  cost TEXT NOT NULL,
  round_trip_id TEXT,
  opened_at INTEGER,
  trip_realized TEXT NOT NULL,
  PRIMARY KEY (season_id, asset)
);

CREATE TABLE round_trips (
  id TEXT PRIMARY KEY,
  season_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER NOT NULL,
  pnl TEXT NOT NULL
);

CREATE TABLE account (
  season_id INTEGER PRIMARY KEY,
  total_deposited TEXT NOT NULL
);

CREATE TABLE trade_cursor (
  season_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  last_trade_id INTEGER NOT NULL,
  PRIMARY KEY (season_id, symbol)
);

CREATE TABLE equity_snapshots (
  season_id INTEGER NOT NULL,
  time INTEGER NOT NULL,
  total TEXT NOT NULL,
  deposited TEXT NOT NULL,
  spot_value TEXT NOT NULL,
  leverage_value TEXT NOT NULL
);
CREATE INDEX equity_season_time ON equity_snapshots(season_id, time);
