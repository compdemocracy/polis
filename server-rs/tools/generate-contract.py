#!/usr/bin/env python3
"""Deterministic, reviewable schema/type derivation from pinned decoded wire only.
Empty-only collections have explicit source-backed types below, never Any/Value.
"""
import gzip,json,pathlib,hashlib,re,collections
ROOT=pathlib.Path(__file__).resolve().parents[2]; DEST=ROOT/'server-rs'
archive=(ROOT/'server/characterization/artifacts/baseline.json.gz').read_bytes()
assert hashlib.sha256(archive).hexdigest()=='f448cbbb5d754b3e152ffef67578c41f0fdff4b583f6cf7eb7b6bc2090aa6eef'
files=json.loads(gzip.decompress(archive)); index=json.loads(files['index.json'])
full=[]; cases=[]
for e in index['cases']:
 if '/pca2/' not in e['case_id']:continue
 r=json.loads(files[e['path']+'/response.json']); raw=b''.join(__import__('base64').b64decode(x['bytes']['base64']) for x in r['body'])
 if r['status']!=200:continue
 b=json.loads(gzip.decompress(raw) if raw[:2]==b'\x1f\x8b' else raw)
 if 'math_tick' in b:full.append(b);cases.append(e['case_id'])
# Field order is a topological union of recorded orders, not alphabetic sorting.
def ordered(objects):
 keys=list(dict.fromkeys(k for o in objects for k in o)); edges={k:set() for k in keys}
 for o in objects:
  for a,b in zip(o,list(o)[1:]):edges[b].add(a)
 result=[]
 while len(result)<len(keys):
  ready=next((k for k in keys if k not in result and edges[k]<=set(result)),None)
  assert ready is not None,('incompatible orders',objects)
  result.append(ready)
 return result
MAX=9007199254740991
integer={'type':'integer','minimum':0,'maximum':MAX}
number={'type':'number'}
# The recording is not the domain. Where the Node source declares a wider type than
# the 96 seeded bodies exhibit, the source wins: a model fitted to the corpus alone
# turns a legal production value into a decode failure. Each entry cites its source.
SOURCE_TYPES={
 '$.lastModTimestamp':{
  'schema':{'anyOf':[{'type':'null'},integer]},
  'rust':'Option<u64>',
  'source':'server/src/utils/pca.ts:64 declares `lastModTimestamp?: number | null`; '
           'ensureCompletePcaStructure does not repair it, so a stored number reaches the wire.',
 },
}
# Keys the census observed outside the 96 seeded bodies. The Node route serves
# whatever is stored, so covering one costs a skipped `None` and not covering it
# costs a refusal. `after` is the preceding key in JSONB's length-then-bytewise
# order, which is the order a stored blob's extras arrive in.
EXTRA_FIELDS=[
 {'key':'conversation_id','after':'group_clusters','rust':'String',
  'source':'census: emitted by the Python engine output (math/python_conversion) alongside the '
           'extras this model already carries; not observed in any stored row, since the writer '
           'normalizes before publication. Modelled optional so a stored copy is served, not refused.'},
]
# ensureCompletePcaStructure fills these three AFTER the object spread, and
# createEmptyPcaStructure has no such key, so when the blob omits one Node APPENDS
# it after every other extra key rather than emitting it at its struct position.
APPENDED=[('mod-in','mod_dash_in'),('mod-out','mod_dash_out'),('meta-tids','meta_dash_tids')]
# Empty observations are resolved explicitly by pca.ts and populated sibling types.
def empty_hint(p):
 if p.endswith('.comment-priorities') or p.endswith('.comment_priorities'):return {'type':'object','patternProperties':{'^(0|[1-9][0-9]*)$':number},'additionalProperties':False}
 if p.endswith(('.mod-out','.meta-tids','.mod_out_tids','.mod_out_ptpts','.meta_tids')):return {'type':'array','items':integer}
 raise AssertionError(('unresolved empty collection',p))
def infer(values,p):
 kinds=set('null' if v is None else 'boolean' if isinstance(v,bool) else 'number' if isinstance(v,(int,float)) else 'string' if isinstance(v,str) else 'array' if isinstance(v,list) else 'object' for v in values)
 if kinds=={'array','object'}:
  assert p=='$.pca.comment-projection' and all(not v for v in values if isinstance(v,dict))
  return {'anyOf':[{'type':'object','additionalProperties':False,'maxProperties':0},infer([v for v in values if isinstance(v,list)],p)]}
 assert len(kinds)==1,(p,kinds)
 kind=kinds.pop()
 if kind=='null':return {'type':'null'}
 if kind in ('boolean','string'):return {'type':kind}
 if kind=='number':
  # Scores/coordinates are numbers even if a fixture happens to contain integers.
  key=p.split('.')[-1].replace('[]','')
  count=key in ['id','tid','gid','group','group_id','comment_id','comment_ids','tids','n','n-cmts','n-members','count','members','in-conv','mod-in','mod-out','meta-tids','math_tick','lastModTimestamp','lastVoteTimestamp','last_updated','comment_count','participant_count','n-agree','n-trials','n-success','n_pass','n_agree','n_disagree','n_votes','na','nd','ns','A','D','S','mod_in_tids','mod_out_tids','mod_out_ptpts','meta_tids'] or '.user-vote-counts.' in p
  return integer.copy() if count else number.copy()
 if kind=='array':
  items=[x for v in values for x in v]
  return {'type':'array','items':infer(items,p+'[]')} if items else empty_hint(p)
 keys=list(dict.fromkeys(k for v in values for k in v))
 if not keys:return empty_hint(p)
 if all(re.fullmatch('0|[1-9][0-9]*',k) for k in keys):
  return {'type':'object','patternProperties':{'^(0|[1-9][0-9]*)$':infer([x for v in values for x in v.values()],p+'.*')},'additionalProperties':False}
 props={k:infer([v[k] for v in values if k in v],p+'.'+k) for k in ordered(values)}
 return {'type':'object','properties':props,'required':[k for k in props if all(k in v for v in values)],'additionalProperties':False}
def widen(s):
 for path,rule in SOURCE_TYPES.items():
  key=path.split('.',1)[1]
  if key in s.get('properties',{}):s['properties'][key]=dict(rule['schema'],description=rule['source'])
 props=s.get('properties')
 if props is not None:
  for extra in EXTRA_FIELDS:
   rebuilt={}
   for k,v in props.items():
    rebuilt[k]=v
    if k==extra['after']:rebuilt[extra['key']]={'type':extra['rust'].lower(),'description':extra['source']}
   props.clear();props.update(rebuilt)
 return s
# Infer common types across empty + populated; full branch required lists stay distinct.
schema=widen(infer(full,'$'));schema['$schema']='http://json-schema.org/draft-07/schema#'
schema['title']='P-032 PCA2 implementation candidate; populated extension requires independent review'
for variant,vals in [('empty',[v for v in full if v['n']==0]),('populated',[v for v in full if v['n']>0])]:
 s=infer(vals,'$') if variant=='populated' else json.loads((pathlib.Path('/Users/colinmegill/polis/cost-reduction/04-plans/p032-slice1/decoded-empty.schema.json')).read_text())
 s['$schema']=schema['$schema']
 (DEST/'contract'/f'{variant}.schema.json').write_text(json.dumps(s,indent=2)+'\n')
(DEST/'contract/model.schema.json').write_text(json.dumps(schema,indent=2)+'\n')
structs=[];names={}; top_fields=[]
def rust(s,p):
 name='MathData' if p=='$' else ''.join(x.title() for x in re.findall('[a-zA-Z0-9]+',p.replace('-', 'Dash')))+'Data'
 if 'anyOf' in s:
  t=rust(s['anyOf'][1],p+'Matrix')
  structs.append(f'#[derive(Debug, Clone, Serialize, Deserialize)]\n#[serde(untagged)]\npub enum {name} {{ Empty(EmptyObject), Matrix({t}) }}\nimpl Default for {name} {{ fn default() -> Self {{ Self::Empty(EmptyObject {{}}) }} }}')
  return name
 k=s['type']
 if k in ['number','integer','boolean','string','null']:return {'number':'f64','integer':'u64','boolean':'bool','string':'String','null':'()'}[k]
 if k=='array':return 'Vec<'+rust(s['items'],p+'Item')+'>'
 if 'patternProperties' in s:return 'BTreeMap<u32, '+rust(next(iter(s['patternProperties'].values())),p+'Entry')+'>'
 if not s.get('properties'):return 'EmptyObject'
 fields=[]
 for key,sub in s['properties'].items():
  ident=key.lower().replace('-','_dash_')
  if ident=='in':ident='r#in'
  rule=SOURCE_TYPES.get(p+'.'+key)
  if rule:
   # Source-declared type: absent and explicit null both decode, and null is re-emitted.
   fields.append(f'    // {rule["source"]}\n    #[serde(rename = "{key}")]\n    pub {ident}: {rule["rust"]},')
   if p=='$':top_fields.append((key,ident,False))
   continue
  typ=rust(sub,p+'.'+key);optional=key not in s['required']
  attr=f'#[serde(rename = "{key}"'+(', skip_serializing_if = "Option::is_none", deserialize_with = "present"' if optional else '')+')]'
  note=f'    // {sub["description"]}\n' if isinstance(sub,dict) and 'description' in sub else ''
  fields.append(f'{note}    {attr}\n    pub {ident}: '+(f'Option<{typ}>' if optional else typ)+',')
  if p=='$':top_fields.append((key,ident,optional))
 if p=='$':
  for key,ident in APPENDED:
   fields.append(
    f'    /// Set only when the stored blob omitted `{key}`; ensureCompletePcaStructure\n'
    f'    /// appends it after every other extra key, so it must serialize last.\n'
    f'    #[serde(rename = "{key}", skip_deserializing, skip_serializing_if = "Option::is_none")]\n'
    f'    pub {ident}_appended: Option<Vec<u64>>,')
 # Stored JSONB may omit default fields; output is always schema validated by harness.
 structs.append('#[derive(Debug, Clone, Default, Serialize, Deserialize)]\n#[serde(default, deny_unknown_fields)]\npub struct '+name+' {\n'+'\n'.join(fields)+'\n}')
 return name
rust(schema,'$')
header="""// Generated by tools/generate-contract.py from hash-pinned ordered wire.\nuse std::collections::BTreeMap;\nuse serde::{Serialize, Deserialize};\nfn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> { T::deserialize(d).map(Some) }\n#[derive(Debug, Clone, Default, Serialize, Deserialize)]\n#[serde(deny_unknown_fields)]\npub struct EmptyObject {}\n"""
# A typed, ordered subset serializer: only declared members are selectable.
subset='\npub struct Subset<\'a> { pub data: &\'a MathData, pub keys: &\'a [String] }\nimpl Serialize for Subset<\'_> {\n fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {\n use serde::ser::SerializeMap;\n let mut map = serializer.serialize_map(None)?;\n let mut seen = std::collections::HashSet::new();\n for key in self.keys { if !seen.insert(key) { continue; } match key.as_str() {\n'
appended={k:i for k,i in APPENDED}
for key,ident,opt in top_fields:
 if key in appended:
  # _.pick reads the merged object, where exactly one of the two carriers is set.
  value=f'self.data.{ident}.as_ref().or(self.data.{ident}_appended.as_ref())'
  subset+=f'"{key}" => if let Some(value) = {value} {{ map.serialize_entry(key, value)?; }}\n'
 else:
  subset+=f'"{key}" => '+(f'if let Some(value) = &self.data.{ident} {{ map.serialize_entry(key, value)?; }}' if opt else f'map.serialize_entry(key, &self.data.{ident})?,')+'\n'
subset+=' _ => {}\n } }\n map.end()\n }\n}\n'
(DEST/'src/model.rs').write_text(header+'\n\n'.join(structs)+subset)
(DEST/'contract/provenance.json').write_text(json.dumps({'archiveSha256':hashlib.sha256(archive).hexdigest(),'sourceCommit':'c9685319980cd048d3c7bfa98e75b0c302083a6a','fullCases':cases,'state':'implementation-candidate-not-client-admission'},indent=2)+'\n')
print(f'derived {len(structs)} typed structures from {len(full)} full responses')
