\set ON_ERROR_STOP on

-- Read-only preflight for an existing PocketCtl database. A normal deployment
-- must not rotate credentials or switch Relay to pocketctl_app until every
-- Relay-owned object has been transferred away from the legacy superuser.
DO $pocketctl_ownership_gate$
DECLARE
  app_role record;
  database_owner text;
  public_schema_owner text;
  incompatible_objects bigint;
BEGIN
  SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
    INTO app_role
    FROM pg_roles
   WHERE rolname = 'pocketctl_app';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'existing PocketCtl database ownership migration required: role pocketctl_app is missing';
  END IF;
  IF app_role.rolsuper OR app_role.rolcreatedb OR app_role.rolcreaterole
     OR app_role.rolreplication OR NOT app_role.rolcanlogin THEN
    RAISE EXCEPTION 'existing PocketCtl database ownership migration required: pocketctl_app privileges are unsafe';
  END IF;

  SELECT pg_get_userbyid(datdba)
    INTO database_owner
    FROM pg_database
   WHERE datname = current_database();
  IF database_owner IS DISTINCT FROM 'pocketctl_app' THEN
    RAISE EXCEPTION 'existing PocketCtl database ownership migration required: database owner is %', database_owner;
  END IF;

  SELECT pg_get_userbyid(nspowner)
    INTO public_schema_owner
    FROM pg_namespace
   WHERE nspname = 'public';
  -- PostgreSQL 15+ assigns public to pg_database_owner on a freshly-created
  -- database. Because the database owner was verified above, that predefined
  -- role is equivalent to pocketctl_app for this schema and keeps redeploys
  -- idempotent without broadening privileges to another login role.
  IF public_schema_owner IS DISTINCT FROM 'pocketctl_app'
     AND public_schema_owner IS DISTINCT FROM 'pg_database_owner' THEN
    RAISE EXCEPTION 'existing PocketCtl database ownership migration required: public schema owner is %', public_schema_owner;
  END IF;

  SELECT
    (SELECT count(*)
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname !~ '^pg_toast'
        AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
        AND pg_get_userbyid(c.relowner) <> 'pocketctl_app'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_class'::regclass
             AND d.objid = c.oid
             AND d.deptype = 'e'
        ))
    +
    (SELECT count(*)
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname !~ '^pg_toast'
        AND p.prokind IN ('f', 'p', 'w')
        AND pg_get_userbyid(p.proowner) <> 'pocketctl_app'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_proc'::regclass
             AND d.objid = p.oid
             AND d.deptype = 'e'
        ))
    +
    (SELECT count(*)
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname !~ '^pg_toast'
        AND t.typtype IN ('d', 'e')
        AND pg_get_userbyid(t.typowner) <> 'pocketctl_app'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_type'::regclass
             AND d.objid = t.oid
             AND d.deptype = 'e'
        ))
    INTO incompatible_objects;

  IF incompatible_objects <> 0 THEN
    RAISE EXCEPTION 'existing PocketCtl database ownership migration required: % non-extension objects are not owned by pocketctl_app', incompatible_objects;
  END IF;
END
$pocketctl_ownership_gate$;
