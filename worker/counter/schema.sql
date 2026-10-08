-- horain visit counter: only aggregate numbers, no personal data.
CREATE TABLE IF NOT EXISTS counters (id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO counters (id, n) VALUES ('total', 0);
