import type pg from 'pg'
/** A live, read-only Memory scan needs an actual drained/fenced maintenance
 * source, not a renamed production database or an unverified flag. */
export async function assertFrozenMemorySource(source:Pick<pg.Client,'query'>){
 // pg_stat_activity fields such as backend_type may be hidden from a reader.
 // Count every other backend instead of filtering hidden fields to NULL.
 if((await source.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() LIMIT 1')).rowCount)throw Error('source_not_drained')
 if((await source.query("SELECT 1 FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND rolname<>current_user AND has_database_privilege(oid,current_database(),'CONNECT') LIMIT 1")).rowCount)throw Error('source_connections_not_fenced')
 const acl=(await source.query("SELECT EXISTS(SELECT 1 FROM pg_database d,LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='CONNECT') AS public_connect")).rows[0]
 if(acl.public_connect)throw Error('source_connections_not_fenced')
 if((await source.query("SELECT 1 FROM pg_roles r,pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE r.rolname=current_user AND NOT r.rolsuper AND n.nspname='public' AND c.relkind='r' AND has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') LIMIT 1")).rowCount)throw Error('source_reader_has_write_privileges')
}
