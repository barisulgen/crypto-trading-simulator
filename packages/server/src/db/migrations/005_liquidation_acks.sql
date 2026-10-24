-- The id of the latest liquidation event the owner has acknowledged in the alert: liquidations
-- after it are alerted again on every connect until acknowledged, even ones applied while no
-- browser was connected. Every liquidation recorded before this existed counts as acknowledged.
INSERT INTO meta (key, value)
  SELECT 'liquidations_acked_through', CAST(COALESCE(MAX(id), 0) AS TEXT) FROM events WHERE type = 'liquidation';
