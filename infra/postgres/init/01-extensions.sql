-- Extensions required by the Rentwell schema.
-- pgcrypto: gen_random_uuid() for database-side identifier defaults.
-- citext:   case-insensitive unique email addresses.
--
-- Order matters here. An extension is installed into one database, not into the
-- server, and a new database is cloned from template1 — which has neither of
-- these. So the test database is created first and then gets its own copies;
-- installing them only into the default database would leave rentwell_test
-- without citext, and applying the schema there fails on User.email with
-- 'type "citext" does not exist'.
--
-- This file runs only when the data volume is first initialised. On an existing
-- volume, recreate it (docker compose down -v) or create the extensions by hand.

-- Integration tests run against a separate database on the same instance.
SELECT 'CREATE DATABASE rentwell_test'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'rentwell_test')\gexec

-- The application database (POSTGRES_DB), which psql is already connected to.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- The test database.
\connect rentwell_test
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
