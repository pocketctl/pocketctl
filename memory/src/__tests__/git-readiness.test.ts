import {expect,test} from 'vitest'
import {gitBootstrapStatus} from '../git-sync/readiness.js'
test('enabled without a current snapshot or principal explains the bootstrap gate',()=>{
 expect(gitBootstrapStatus('enabled',undefined)).toMatchObject({state:'required',reason:'initial_export_required'})
 expect(gitBootstrapStatus('enabled',{snapshot:true,principal:false})).toMatchObject({state:'required',reason:'sync_principal_required'})
 expect(gitBootstrapStatus('enabled',{snapshot:true,principal:true})).toMatchObject({state:'registered',reason:'poll_admission_required'})
 expect(gitBootstrapStatus('off',{snapshot:true,principal:true})).toMatchObject({state:'disabled'})
})
