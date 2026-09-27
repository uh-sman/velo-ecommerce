-- Extensions the schema depends on, created before the first migration runs.
-- Runs once, on an empty data volume.

-- Trigram matching: the Postgres FTS fallback when Meilisearch is unavailable
-- (ADR-007), and admin product search by name or SKU.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Query statistics — the first place to look when something is slow.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Test database, so the suite never runs against development data.
SELECT 'CREATE DATABASE velo_test OWNER velo'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'velo_test')\gexec
