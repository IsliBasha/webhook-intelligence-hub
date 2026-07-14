ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS next_retry_at timestamptz DEFAULT now();

-- Partial index: only failed rows are ever queried by next_retry_at (see
-- EventStore.getForRetry), so indexing the other statuses would be pure
-- overhead.
CREATE INDEX IF NOT EXISTS idx_events_retry ON webhook_events (next_retry_at)
  WHERE status = 'failed';
