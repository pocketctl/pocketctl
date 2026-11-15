import {it,expect} from 'vitest'
import {normalizeUsage} from '../usage-analytics/token-projector.js'
const meta={version:1,source_usage_id:'r',revision:1,mode:'cumulative',provider:'fixture',input_semantics:'includes_cache'} as const
it('normalizes inclusive input without reasoning duplication',()=>expect(normalizeUsage({input_tokens:100,output_tokens:20,cache_read_tokens:40,reasoning_tokens:8},meta)).toEqual({input:'60',output:'20',cache_read:'40',cache_create:'0',total:'120'}))
it('keeps exclusive input',()=>expect(normalizeUsage({input_tokens:100,output_tokens:20,cache_read_tokens:40},{...meta,input_semantics:'excludes_cache'}).total).toBe('160'))
it('does not guess legacy components',()=>expect(normalizeUsage({input_tokens:100},{...meta,input_semantics:'unknown'}).input).toBeNull())
it('rejects corrupt cache and unsafe integers',()=>{expect(()=>normalizeUsage({input_tokens:1,cache_read_tokens:2},meta)).toThrow();expect(()=>normalizeUsage({input_tokens:1e20},meta)).toThrow()})
