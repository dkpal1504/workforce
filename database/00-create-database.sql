\set ON_ERROR_STOP on

-- Run as a PostgreSQL administrator from the database server:
--   sudo -u postgres psql --set=app_password='use-a-long-random-password' -f database/00-create-database.sql
-- Override these defaults with: --set=app_user=... --set=app_database=...
\if :{?app_user}
\else
\set app_user workforce_app
\endif
\if :{?app_database}
\else
\set app_database workforce
\endif
\if :{?app_password}
\else
\echo 'ERROR: app_password is required'
\quit 3
\endif

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_password') \gexec

SELECT format(
  'CREATE DATABASE %I OWNER %I ENCODING %L TEMPLATE template0',
  :'app_database', :'app_user', 'UTF8'
)
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = :'app_database') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'app_database', :'app_user') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'app_database') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'app_database', :'app_user') \gexec
