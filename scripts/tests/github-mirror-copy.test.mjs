import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const helper=fileURLToPath(new URL('../lib/github-mirror-copy.sh',import.meta.url))
test('public export includes only committed whitelist content',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pocketctl-public-copy-'))
 try{
  const source=path.join(root,'source'),dest=path.join(root,'dest')
  fs.mkdirSync(source);fs.mkdirSync(dest)
  const git=(...args)=>execFileSync('git',args,{cwd:source,stdio:'pipe'})
  git('init','-q');git('config','user.email','test@example.invalid');git('config','user.name','Mirror Test')
  fs.mkdirSync(path.join(source,'memory'))
  fs.writeFileSync(path.join(source,'.gitignore'),'memory/private/\n')
  fs.writeFileSync(path.join(source,'memory/public.txt'),'committed')
  git('add','.');git('commit','-qm','fixture')
  fs.writeFileSync(path.join(source,'memory/public.txt'),'uncommitted edit')
  fs.mkdirSync(path.join(source,'memory/private'));fs.writeFileSync(path.join(source,'memory/private/local.txt'),'private fixture')
  fs.writeFileSync(path.join(source,'memory/untracked.txt'),'untracked fixture')
  execFileSync('bash',[helper,source,dest,'memory'])
  assert.equal(fs.readFileSync(path.join(dest,'memory/public.txt'),'utf8'),'committed')
  assert.deepEqual(fs.readdirSync(path.join(dest,'memory')),['public.txt'])
  assert.throws(()=>execFileSync('bash',[helper,source,dest,'memory/untracked.txt'],{stdio:'pipe'}))
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})
