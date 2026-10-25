-- Phase 30: the statistics Worker's tables (apps/stats). Applied with `wrangler d1 migrations apply wesnoth-stats`.

-- One row per gameplay statistics event the game sent (opt-in). `data` holds the event type's own fields as
-- JSON (`packages/ui/src/telemetry/schema.ts`'s EXTRA_FIELDS). No IP or user agent is kept.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  received TEXT NOT NULL,
  t INTEGER NOT NULL,
  v INTEGER NOT NULL,
  type TEXT NOT NULL,
  build TEXT,
  lang TEXT,
  device TEXT,
  browser TEXT,
  run TEXT,
  campaign TEXT,
  scenario TEXT,
  difficulty TEXT,
  turn INTEGER,
  data TEXT
);
CREATE INDEX events_scenario ON events (campaign, scenario, type);
CREATE INDEX events_run ON events (run, t);
CREATE INDEX events_received ON events (received);

-- One row per bug report; the report itself is `reports/<id>.json` in the R2 bucket.
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  received TEXT NOT NULL,
  kind TEXT NOT NULL,
  build TEXT,
  campaign TEXT,
  scenario TEXT,
  turn INTEGER,
  summary TEXT,
  has_save INTEGER NOT NULL,
  bytes INTEGER NOT NULL
);
CREATE INDEX reports_received ON reports (received);
