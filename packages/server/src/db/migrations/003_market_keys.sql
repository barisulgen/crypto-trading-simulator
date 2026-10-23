-- Perpetuals reuse the spot symbol names, so the trade cursor is kept per market. Every existing
-- cursor belongs to the spot market.
CREATE TABLE trade_cursor_new (
  season_id INTEGER NOT NULL,
  market TEXT NOT NULL,
  symbol TEXT NOT NULL,
  last_trade_id INTEGER NOT NULL,
  PRIMARY KEY (season_id, market, symbol)
);
INSERT INTO trade_cursor_new (season_id, market, symbol, last_trade_id)
  SELECT season_id, 'spot', symbol, last_trade_id FROM trade_cursor;
DROP TABLE trade_cursor;
ALTER TABLE trade_cursor_new RENAME TO trade_cursor;

-- The id of the last trade processed for the market and symbol when the gap opened: trades after
-- it were not processed live. NULL when unknown (a gap saved before this column existed) or when
-- no trade had been processed yet.
ALTER TABLE open_gaps ADD COLUMN last_trade_id_before INTEGER;
