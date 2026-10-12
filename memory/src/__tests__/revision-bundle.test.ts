import {describe,expect,test} from 'vitest'
import {revisionBundleHash,type RevisionBundle} from '../governance/revision-bundle.js'
const bundle:RevisionBundle={schemaVersion:2,statement:'Invariant',structuredContent:{a:1,b:{c:2}},
 applicability:{scopeKind:'branch',canonicalRepositoryKey:'github.com/acme/repo',repositoryId:'local-repo',snapshotId:'snapshot',branch:'main',scopeKey:'main',status:'verified'},
 sourceContentHash:'source',sourceValidFrom:'2026-01-01T00:00:00Z',sourceValidUntil:null,sourceFreshnessAt:'2026-01-01T00:00:00Z',originPolicyHash:'origin',reviewPolicyHash:'policy',
 evidence:[{evidenceId:'shared:1',contentHash:'copy',sourceHash:'original',evidenceKind:'episode',occurredAt:'2026-01-01T00:00:00Z',locator:null}]}
describe('revision bundle digest',()=>{
 test('object ordering is canonical; exact array order and case remain meaningful',()=>{
  expect(revisionBundleHash({...bundle,structuredContent:{b:{c:2},a:1}})).toBe(revisionBundleHash(bundle))
  expect(revisionBundleHash({...bundle,statement:'invariant'})).not.toBe(revisionBundleHash(bundle))
 })
 test.each(['statement','structuredContent','applicability','sourceContentHash','sourceValidFrom','sourceValidUntil','sourceFreshnessAt','originPolicyHash','reviewPolicyHash','evidence'] as const)('binds %s into review identity',field=>{
  const copy=structuredClone(bundle)
  switch(field){
   case 'structuredContent':copy.structuredContent={a:2};break
   case 'applicability':copy.applicability.branch='release';break
   case 'evidence':copy.evidence[0].sourceHash='replaced';break
   default:copy[field]='changed'
  }
  expect(revisionBundleHash(copy)).not.toBe(revisionBundleHash(bundle))
 })
})
