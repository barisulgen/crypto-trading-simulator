-- The BTC spot best bid at each equity snapshot, kept only while BTC spot data was fresh: the
-- stats value the BTC bought with each deposit at it. Snapshots taken before this have none.
ALTER TABLE equity_snapshots ADD COLUMN btc_bid TEXT;
