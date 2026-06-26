CREATE TABLE IF NOT EXISTS webhook_events (
  id           uuid        PRIMARY KEY,
  provider     text        NOT NULL,
  event_type   text        NOT NULL,
  raw_payload  jsonb       NOT NULL,
  classified   jsonb,
  status       text        DEFAULT 'pending',
  attempts     integer     DEFAULT 0,
  created_at   timestamptz DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_events_status  ON webhook_events (status);
CREATE INDEX IF NOT EXISTS idx_events_created ON webhook_events (created_at DESC);

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid REFERENCES webhook_events(id),
  last_error text,
  failed_at  timestamptz DEFAULT now()
);
