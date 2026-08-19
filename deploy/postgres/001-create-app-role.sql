-- M-7: manual psql variant of the init script (for non-compose deployments).
-- Run as a superuser with the variables supplied explicitly, e.g.:
--   psql -v ON_ERROR_STOP=1 \
--     --set=app_password='<secret>' \
--     --set=app_role=pocketctl_app \
--     --set=db_name=pocketctl \
--     -f 001-create-app-role.sql
-- The password travels as a psql variable and is referenced with :'app_password'
-- (properly quoted literal) — never concatenated into the SQL text.
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
              :'app_role', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role')
\gexec
ALTER ROLE pocketctl_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER DATABASE :"db_name" OWNER TO pocketctl_app;
