import {mkdtemp,mkdir,readFile,writeFile,chmod} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {expect,test} from 'vitest'
async function fixture(failHealth:boolean,policy:string|undefined='forward-only',failDrain=false){
 const source=await readFile(resolve('../.claude/skills/deploy-mem-online/scripts/deploy-mem-online.sh'),'utf8')
 const body=source.match(/cat > "\$apply_script" <<'REMOTE_APPLY'\n([\s\S]*?)\nREMOTE_APPLY/)?.[1]
 if(!body)throw Error('remote_apply_script_not_found')
 const root=await mkdtemp(join(tmpdir(),'memory-forward-deploy-')),bin=join(root,'bin'),log=join(root,'commands.log'),staged=join(root,'staged.env'),script=join(root,'apply.sh')
 await mkdir(bin);await mkdir(join(root,'memory'));await mkdir(join(root,'deploy/systemd'),{recursive:true})
 await writeFile(staged,'MEMORY_DATABASE_URL=postgres://synthetic-only/new_authority\n');await writeFile(join(root,'memory/.env'),'MEMORY_DATABASE_URL=postgres://synthetic-only/old_authority\n')
 await writeFile(join(root,'deploy/systemd/pocketctl-memory-api.service'),'fixture');await writeFile(join(root,'deploy/systemd/pocketctl-memory-worker.service'),'fixture');await writeFile(script,body)
 const stub=`#!/bin/sh
name=\${0##*/}
printf '%s %s\\n' "$name" "$*" >> "$TEST_LOG"
case "$name" in
 install)
  case "$*" in *'/var/backups/'*) exit 77;; esac
  for arg in "$@"; do case "$arg" in "$TEST_ROOT"/*) last=$arg;; esac; done
  case "$last" in *.env.new) /bin/cp "$TEST_STAGED" "$last";; esac;;
 git) printf '%040d\\n' 1;;
 curl)
  if [ "$TEST_FAIL_HEALTH" = 1 ]; then exit 22; fi
  case "$*" in *metrics*) printf '403';; *ready*) printf '{"readiness":"ready"}';; *) printf '{"status":"ok"}';; esac;;
 systemctl) case "$*" in *LoadState*) printf 'loaded';; *ActiveState*) if [ "$TEST_FAIL_DRAIN" = 1 ]; then printf 'active'; else printf 'inactive'; fi;; *MainPID*|*NRestarts*) printf '0';; esac;;
 node) case "$*" in *cleanup-production-backups*) exit 78;; esac
  [ -z "$BACKUP_FILE" ] || exit 79;;
esac
exit 0
`
 for(const name of ['install','git','npm','systemd-analyze','systemctl','nginx','node','curl','sleep','journalctl','pg_dump','pg_restore']){const path=join(bin,name);await writeFile(path,stub);await chmod(path,0o700)}
 const run=spawnSync('/bin/bash',[script,root,staged,...(policy?[policy]:[])],{env:{...process.env,PATH:bin+':'+process.env.PATH,TEST_ROOT:root,TEST_LOG:log,TEST_STAGED:staged,TEST_FAIL_HEALTH:failHealth?'1':'0',TEST_FAIL_DRAIN:failDrain?'1':'0'},encoding:'utf8'})
 return {run,commands:await readFile(log,'utf8'),env:await readFile(join(root,'memory/.env'),'utf8')}
}
test('forward-only deployment performs no data/config backup, backup cleanup or rollback',async()=>{
 const {run,commands,env}=await fixture(false)
 expect(run.status,run.stderr).toBe(0)
 expect(run.stdout).toContain('policy=forward-only backup=none rollback=disabled')
 expect(commands).not.toMatch(/pg_dump|pg_restore|cleanup-production-backups|\/var\/backups/)
 expect(commands).not.toContain('node --env-file')
 expect(env).toContain('new_authority')
 expect(commands.indexOf('systemctl stop pocketctl-memory-api.service')).toBeLessThan(commands.indexOf('install -o root -g pocketctl -m 0640'))
})
test('an API or Worker that did not drain stops before installing the new authority',async()=>{
 const {run,commands,env}=await fixture(false,'forward-only',true)
 expect(run.status).not.toBe(0)
 expect(env).toContain('old_authority');expect(env).not.toContain('new_authority')
 expect(commands).not.toContain('install -o root -g pocketctl -m 0640')
 expect(run.stderr).toContain('did not drain')
})
test('ordinary apply and the remote default use the same no-backup forward policy',async()=>{
 const source=await readFile(resolve('../.claude/skills/deploy-mem-online/scripts/deploy-mem-online.sh'),'utf8')
 const selector=source.slice(0,source.indexOf('repo_root='))
 for(const action of ['--apply','check','--apply-forward-only','check-forward-only']){
  const selected=spawnSync('/bin/bash',['-c',selector+'\nprintf "%s" "$deployment_policy"','selector',action],{encoding:'utf8'})
  expect(selected.status,selected.stderr).toBe(0);expect(selected.stdout).toBe('forward-only')
 }
 const {run,commands}=await fixture(false,'')
 expect(run.status,run.stderr).toBe(0)
 expect(commands).not.toMatch(/pg_dump|pg_restore|cleanup-production-backups|\/var\/backups/)
})
test('forward-only failed health keeps latest configuration and stops Memory instead of restoring old authority',async()=>{
 const {run,commands,env}=await fixture(true)
 expect(run.status).not.toBe(0);expect(env).toContain('new_authority');expect(env).not.toContain('old_authority')
 expect(run.stderr).toContain('FORWARD_ONLY_FAILURE')
 expect(commands).toContain('systemctl stop pocketctl-memory-worker.service pocketctl-memory-api.service')
 expect(commands).not.toMatch(/pg_dump|pg_restore|cleanup-production-backups|\/var\/backups/)
})
test('failed postflight stops both deployed services without restoring old configuration',async()=>{
 const source=await readFile(resolve('../.claude/skills/deploy-mem-online/scripts/deploy-mem-online.sh'),'utf8')
 const verify=source.match(/verify_deployed_memory\(\) \{[\s\S]*?\n\}/)?.[0]
 expect(verify,'postflight must have its own failure handler').toBeDefined()
 const root=await mkdtemp(join(tmpdir(),'memory-postflight-')),script=join(root,'postflight.sh')
 await writeFile(script,`set -eu\n${verify}\nremote_bash() { printf 'postflight failed\\n'; return 1; }\nsshpass() { printf '%s\\n' "$*"; }\ndie() { printf '%s\\n' "$*" >&2; exit 1; }\nssh_options=(-o BatchMode=yes)\nremote_host=unit.invalid\npreflight_script=fixture\nremote_root=fixture\ndeployment_policy=forward-only\nverify_deployed_memory\n`)
 const run=spawnSync('/bin/bash',[script],{encoding:'utf8'})
 expect(run.status).not.toBe(0)
 expect(run.stdout).toContain('systemctl stop pocketctl-memory-worker.service pocketctl-memory-api.service')
 expect(run.stderr).toContain('postflight failed')
 expect(run.stdout+run.stderr).not.toMatch(/pg_restore|old_authority|backup/)
})
test('SSH wrapper preserves empty/spaced arguments without evaluating literal shell syntax',async()=>{
 const source=await readFile(resolve('../.claude/skills/deploy-mem-online/scripts/deploy-mem-online.sh'),'utf8'),wrapper=source.match(/remote_bash\(\) \{[\s\S]*?\n\}/)?.[0]
 if(!wrapper)throw Error('remote_wrapper_missing')
 const root=await mkdtemp(join(tmpdir(),'memory-ssh-quote-')),bin=join(root,'bin'),remote=join(root,'remote.sh'),entry=join(root,'entry.sh')
 await mkdir(bin)
 await writeFile(remote,'printf "%s\\0" "$@"\n')
 const sentinel=join(root,'must-not-exist'),literal=`literal $(touch ${sentinel}) with spaces`
 await writeFile(entry,`#!/bin/bash\nset -eu\nssh_options=(-o BatchMode=yes)\nremote_host=unit.invalid\n${wrapper}\nremote_bash "$TEST_REMOTE" "$TEST_LITERAL" "" required forward-only\n`)
 await writeFile(join(bin,'sshpass'),'#!/bin/sh\nfor arg do last=$arg; done\n/bin/bash -c "$last"\n');await chmod(join(bin,'sshpass'),0o700)
 const run=spawnSync('/bin/bash',[entry],{env:{...process.env,PATH:bin+':'+process.env.PATH,TEST_REMOTE:remote,TEST_LITERAL:literal},encoding:'utf8'})
 expect(run.status,run.stderr).toBe(0);expect(run.stdout.split('\0')).toEqual([literal,'','required','forward-only',''])
 await expect(readFile(sentinel)).rejects.toMatchObject({code:'ENOENT'})
})

async function modelGate(rows:unknown[]){
 const source=await readFile(resolve('../.claude/skills/deploy-mem-online/scripts/deploy-mem-online.sh'),'utf8')
 const body=source.match(/<<'NODE_MODEL_GATE'\n([\s\S]*?)\nNODE_MODEL_GATE/)?.[1]
 if(!body)throw Error('model_gate_script_missing')
 const root=await mkdtemp(join(tmpdir(),'memory-model-gate-'))
 const config=join(root,'config.mjs'),route=join(root,'route.mjs'),pg=join(root,'pg.mjs'),script=join(root,'gate.mjs')
 await writeFile(config,'export const loadMemoryConfig=()=>({})')
 await writeFile(route,"export const createExtractionTextRoute=()=>({provider:'mimo-realtime',model:'mimo-v2.6-flash',fingerprint:'current-consent'})")
 await writeFile(pg,`export default {Client:class{async connect(){} async end(){} async query(sql){if(!sql.includes('memory_installations'))throw Error('installation_status_not_checked');return {rows:JSON.parse(process.env.TEST_ROWS),rowCount:JSON.parse(process.env.TEST_ROWS).length}}}}`)
 await writeFile(script,body)
 return spawnSync(process.execPath,[script],{env:{...process.env,MODEL_GATE:'required',DEPLOYMENT_POLICY:'forward-only',MEMORY_CONFIG_MODULE:config,MEMORY_ROUTE_MODULE:route,PG_MODULE_PATH:pg,TEST_ROWS:JSON.stringify(rows)},encoding:'utf8'})
}
test('model preflight validates all enabled active installations, accepting inactive or opted-out peers',async()=>{
 const active={installation_id:'one',relay_status:'active',local_status:'ready',extraction_mode:'enabled',extraction_consent_fingerprint:'current-consent'}
 const ok=await modelGate([active,{...active,installation_id:'two',extraction_mode:'off',extraction_consent_fingerprint:null}])
 expect(ok.status,ok.stderr).toBe(0)
 const stale=await modelGate([active,{...active,installation_id:'two',extraction_consent_fingerprint:'stale'}])
 expect(stale.status).not.toBe(0)
 const revoked=await modelGate([active,{...active,installation_id:'two',relay_status:'revoked',extraction_consent_fingerprint:null}])
 expect(revoked.status,revoked.stderr).toBe(0)
 const noEnabled=await modelGate([{...active,extraction_mode:'off'}])
 expect(noEnabled.status,noEnabled.stderr).toBe(0)
 const staleShadow=await modelGate([{...active,extraction_mode:'shadow',extraction_consent_fingerprint:'stale'}])
 expect(staleShadow.status).not.toBe(0)
 const validShadow=await modelGate([{...active,extraction_mode:'shadow'}])
 expect(validShadow.status,validShadow.stderr).toBe(0)
})
