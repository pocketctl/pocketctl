import {test,expect} from 'vitest'
import {resolveSubjectFromCatalog} from '../curation/entity-resolver.js'
const long={entity_id:'canonical',name:'Atlas service',alias:null},short={entity_id:'short',name:'Atlas',alias:null}
test('AC-21 source_named_entity_rejects_short_name_without_merging',()=>{
 for(const rows of [[long],[long,short]])expect(resolveSubjectFromCatalog('Atlas',['Atlas service timeout is 120 seconds.'],rows)).toEqual({kind:'unresolved'})
})
test('AC-21 registered_alias_resolves_only_its_own_entity',()=>{
 expect(resolveSubjectFromCatalog('Atlas',['Atlas service timeout is 120 seconds.'],[{...long,alias:'Atlas'}])).toEqual({kind:'existing',entityId:'canonical'})
 expect(resolveSubjectFromCatalog('Atlas',['Atlas service timeout is 120 seconds.'],[{...long,alias:'Atlas'},short])).toEqual({kind:'unresolved'})
})
test('AC-21 entity_names_require_source_literal_and_word_boundaries',()=>{
 expect(resolveSubjectFromCatalog('Atlas',['Atlas timeout is 120 seconds.'],[long])).toEqual({kind:'new'})
 expect(resolveSubjectFromCatalog('Atlas',['Atlas services timeout is 120 seconds.'],[long])).toEqual({kind:'new'})
 expect(resolveSubjectFromCatalog('Atlases',['Atlases timeout is 120 seconds.'],[short])).toEqual({kind:'new'})
 expect(resolveSubjectFromCatalog('Beta',['Atlas service and Beta timeout is 120 seconds.'],[long])).toEqual({kind:'new'})
 expect(resolveSubjectFromCatalog('Atlas',['Atlas service timeout is 120 seconds.'],[{...long,name:'Atlas.service'}])).toEqual({kind:'new'})
})
test('AC-21 entity_catalog_overflow_is_unresolved',()=>{
 expect(resolveSubjectFromCatalog('Atlas',['Atlas timeout is 120 seconds.'],Array.from({length:1001},(_,i)=>({entity_id:String(i),name:'Other '+i,alias:null})))).toEqual({kind:'unresolved'})
})
test('AC-21 canonical_normalization_and_self_keep_validated_semantics',()=>{
 expect(resolveSubjectFromCatalog('ＡＴＬＡＳ',['Atlas   service timeout is 120 seconds.'],[long])).toEqual({kind:'unresolved'})
 expect(resolveSubjectFromCatalog('atlas service',['Atlas service timeout is 120 seconds.'],[long])).toEqual({kind:'existing',entityId:'canonical'})
 expect(resolveSubjectFromCatalog('self',['I prefer trains.'],[])).toEqual({kind:'new'})
})
