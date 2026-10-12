import {versionAuthorityCompatibility} from '../claims/types.js'
import {describe,expect,test} from 'vitest'
import {claimIdentityV2,claimDuplicateDigestV2,ClaimIdentityUnavailableError,type ClaimIdentityV2Input} from '../claims/identity.js'
const base:ClaimIdentityV2Input={claimType:'test_invariant',scopeKind:'branch',scopeKey:'main',canonicalRepositoryKey:'github.com/acme/Repo',snapshotId:null,branch:'main',statement:'Call verifyToken before publishing',status:'verified'}
describe('identity v2 semantic contract',()=>{
 test('stable exact identity differs from topic association',()=>{
  const one=claimIdentityV2(base),two=claimIdentityV2({...base,statement:'Call verifyToken after publishing'})
  expect(one.key).toMatch(/^[a-f0-9]{64}$/);expect(claimIdentityV2({...base}).key).toBe(one.key)
  expect(two.key).not.toBe(one.key);expect(two.topicKey).toBe(one.topicKey)
 })
 test.each(['identifier','repository','branch','quoted_whitespace'] as const)('preserves %s distinctions',kind=>{
  const a=kind==='quoted_whitespace'?{...base,statement:'const value = "a  b"'}:base
  const b=kind==='identifier'?{...a,statement:'Call verifytoken before publishing'}:kind==='repository'?{...a,canonicalRepositoryKey:'github.com/acme/repo'}:
   kind==='branch'?{...a,branch:'Main'}:{...a,statement:'const value = "a b"'}
  expect(claimIdentityV2(a).key).not.toBe(claimIdentityV2(b).key)
 })
 test('snapshot identity cannot silently absorb another snapshot',()=>{
  const snapshot={...base,scopeKind:'snapshot' as const,branch:null,snapshotId:'snapshot-a'}
  expect(claimIdentityV2(snapshot).key).not.toBe(claimIdentityV2({...snapshot,snapshotId:'snapshot-b'}).key)
 })
 test('only line endings and surrounding layout noise are normalized',()=>{
  expect(claimIdentityV2({...base,statement:'  line one\r\nline two\n '}).key).toBe(claimIdentityV2({...base,statement:'line one\nline two'}).key)
 })
 test.each(['legacy_unknown','requires_review'] as const)('holds %s applicability instead of inventing identity',status=>{
  expect(()=>claimIdentityV2({...base,status})).toThrow(ClaimIdentityUnavailableError)
 })
 test('missing repository identity cannot fall back to local paths or installation-wide scope',()=>{
  expect(()=>claimIdentityV2({...base,canonicalRepositoryKey:null})).toThrow(ClaimIdentityUnavailableError)
 })
 test.each(['/tmp/Repo','Repo','https://github.com/acme/Repo','github.com/acme/../Repo',
  'github.com/acme//Repo','github.com/acme/Repo?branch=main'])('unconfirmed repository key %s cannot be hashed as verified',canonicalRepositoryKey=>{
  expect(()=>claimIdentityV2({...base,canonicalRepositoryKey})).toThrow(ClaimIdentityUnavailableError)
 })
 test('installation exact identity stays separate from complete repository-qualified content equivalence',()=>{
  const a={...base,scopeKind:'installation' as const,scopeKey:'global',branch:null,repositoryId:'owned-repo-a',
   canonicalRepositoryKey:'github.com/acme/RepoA',structuredContent:{environment:'production'},validFrom:null,validUntil:null}
  const b={...a,repositoryId:'owned-repo-b',canonicalRepositoryKey:'github.com/acme/RepoB'}
  expect(claimIdentityV2(a).key).toBe(claimIdentityV2(b).key)
  expect(claimDuplicateDigestV2(a)).not.toBe(claimDuplicateDigestV2(b))
  expect(claimDuplicateDigestV2(a)).not.toBe(claimDuplicateDigestV2({...a,structuredContent:{environment:'staging'}}))
 })
 test('validity equivalence uses the same instant while retaining distinct intervals',()=>{
  const input={...base,structuredContent:{a:1,b:2},validFrom:'2026-01-01T00:00:00Z',validUntil:null}
  expect(claimDuplicateDigestV2(input)).toBe(claimDuplicateDigestV2({...input,structuredContent:{b:2,a:1},validFrom:'2026-01-01T08:00:00+08:00'}))
  expect(claimDuplicateDigestV2(input)).not.toBe(claimDuplicateDigestV2({...input,validUntil:'2026-02-01T00:00:00Z'}))
 })
})

test('machine authority is recognized without being labelled human approval',()=>{expect(versionAuthorityCompatibility('automation_accepted')).toEqual({recognized:true,human_approved:false})})
