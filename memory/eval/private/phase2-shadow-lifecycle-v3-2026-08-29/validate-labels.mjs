import { readFileSync } from 'node:fs'
const base=new URL('./',import.meta.url)
const manifest=JSON.parse(readFileSync(new URL('manifest.json',base),'utf8'))
const cases=readFileSync(new URL('cases.jsonl',base),'utf8').trim().split(/\n+/).map(JSON.parse)
const file=process.argv[2];if(!file)throw new Error('usage: node validate-labels.mjs <human-labels.json>')
const data=JSON.parse(readFileSync(file,'utf8'));if(data.dataset_id!==manifest.dataset_id)throw new Error('dataset_id mismatch')
const expected=new Set(cases.map(c=>c.case_id)),allowed=new Set(manifest.labels),seen=new Set(),valid=[],extra=[],duplicate=[],invalid=[]
for(const x of data.labels??[]){if(!expected.has(x.case_id)){extra.push(x.case_id);continue}if(seen.has(x.case_id)){duplicate.push(x.case_id);continue}seen.add(x.case_id);if(!allowed.has(x.label)){invalid.push(x.case_id);continue}valid.push(x)}
const missing=[...expected].filter(id=>!seen.has(id));const count=l=>valid.filter(x=>x.label===l).length;const pct=(n,d)=>d?Number((100*n/d).toFixed(2)):0
const repositories=new Set(cases.map(c=>c.context.repository_key).filter(Boolean)).size,adapters=new Set(cases.map(c=>c.context.agent)).size,sessions=new Set(cases.map(c=>c.trace.session_ref)).size
const coverage={eligible_turns:cases.length,sessions,repositories,adapters,required_judgments:cases.length,labeled_judgments:valid.length,missing:missing.length,extra:extra.length,duplicate:duplicate.length,invalid:invalid.length}
const metrics={should_inject_pct:pct(count('useful'),cases.length),irrelevant_or_duplicate_pct:pct(count('irrelevant')+count('duplicate'),cases.length),incorrect_or_harmful_pct:pct(count('incorrect')+count('harmful'),cases.length)}
const gate={coverage:Boolean(data.reviewer)&&coverage.eligible_turns>=100&&sessions>=20&&repositories>=3&&adapters>=2&&valid.length===cases.length&&!missing.length&&!extra.length&&!duplicate.length&&!invalid.length,should_inject:metrics.should_inject_pct>=70,irrelevant_or_duplicate:metrics.irrelevant_or_duplicate_pct<10,incorrect_or_harmful:metrics.incorrect_or_harmful_pct<1}
const report={dataset_id:data.dataset_id,reviewer:data.reviewer??'',coverage,metrics,thresholds:{should_inject_pct_min:70,irrelevant_or_duplicate_pct_max_exclusive:10,incorrect_or_harmful_pct_max_exclusive:1},gate};console.log(JSON.stringify(report,null,2));if(!Object.values(gate).every(Boolean))process.exitCode=1
