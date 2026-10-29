import type pg from 'pg'
import type {TeamTemplate} from './template-contract.js'
export class TeamTemplateRepository {
 async read(db:Pick<pg.Pool,'query'>,team:string,id:string,revision?:number){
  const row=(await db.query(`SELECT r.* FROM team_template_revisions r JOIN team_template_heads h USING(team_id,template_id) WHERE r.team_id=$1 AND r.template_id=$2 AND r.revision=COALESCE($3,h.revision)`,[team,id,revision??null])).rows[0]
  return row?{...row,revision:Number(row.revision),definition:row.definition as TeamTemplate}:null
 }
 async list(db:Pick<pg.Pool,'query'>,team:string,after:string){
  const rows=(await db.query(`SELECT r.template_id,r.revision,r.content_hash,r.definition->>'name' AS name FROM team_template_heads h JOIN team_template_revisions r USING(team_id,template_id,revision) WHERE h.team_id=$1 AND h.template_id>$2 ORDER BY h.template_id LIMIT 51`,[team,after])).rows
  return {items:rows.slice(0,50),next_cursor:rows.length>50?rows[49].template_id:null}
 }
}
