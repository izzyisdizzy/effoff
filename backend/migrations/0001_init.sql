-- Bootstrap migration: proves migrations apply to a fresh database and gives
-- the health check a real table to query. Product schema lands with issue #6.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO meta (key, value) VALUES ('schema_version', '1');
