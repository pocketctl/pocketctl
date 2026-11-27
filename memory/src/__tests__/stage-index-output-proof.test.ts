import {expect,test} from 'vitest'
import {currentIndexOutput} from '../jobs/index-output-proof.js'
import {buildSearchDocument} from '../retrieval/lexical.js'
test('matches the requested and consented adapter plus the current lexical document before looking up a vector call',()=>{
 const claim={claimType:'work_method',statement:'Ship a small patch.',structuredContent:{},repositoryKey:null,branch:null}
 const row={...claim,document:buildSearchDocument(claim),status:'ready',provider:'vendor',model:'one',dimensions:4,fingerprint:'adapter-old'}
 expect(currentIndexOutput(row,'enabled','adapter-new','adapter-new')).toBeUndefined()
 expect(currentIndexOutput(row,'enabled','adapter-old','adapter-new')).toBeUndefined()
 expect(currentIndexOutput(row,'enabled','adapter-old',undefined)).toBeUndefined()
 expect(currentIndexOutput({...row,statement:'Changed input.'},'enabled','adapter-old','adapter-old')).toBeUndefined()
 expect(currentIndexOutput(row,'enabled','adapter-old','adapter-old')?.call).toHaveLength(32)
})
