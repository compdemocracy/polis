#!/usr/bin/env python3
"""Build-time skeleton; generated JSON only. Never connects to a database.

Production integration requires an isolated clone-builder and a reviewed policy for
EVERY column in its catalog, including empty tables. No transcript scrubber exists.
"""
import hashlib,hmac,json,re,secrets,unicodedata
ACTIONS={'preserve','email','identity','capability','text','null'}
def validate(catalog,policy):
 expected={(r['table'],r['column']) for r in catalog}
 actual={(t,c) for t,columns in policy.items() for c in columns}
 if expected!=actual:raise ValueError('unknown/missing schema columns: '+repr(expected^actual))
 for t,c in expected:
  p=policy[t][c]
  if p.get('action') not in ACTIONS or not p.get('reviewed') or not p.get('reason'):
   raise ValueError(f'unreviewed column {t}.{c}')
def text_shape(value):
 # Keep length, whitespace, Unicode general category and script for common scripts.
 # Unsupported classes fail closed, so shape is never silently misrepresented.
 out=[]
 for ch in value:
  if ch.isspace():out.append(ch);continue
  cat=unicodedata.category(ch);name=unicodedata.name(ch,'')
  if 'LATIN' in name:replacement='X' if cat=='Lu' else 'x'
  elif 'CYRILLIC' in name:replacement='Ж' if cat=='Lu' else 'ж'
  elif 'GREEK' in name:replacement='Ω' if cat=='Lu' else 'ω'
  elif 'CJK' in name:replacement='文'
  elif cat=='Nd':replacement='0'
  elif cat=='Mn':replacement='\u0301'
  elif cat=='Po':replacement='.'
  elif cat=='Pd':replacement='-'
  else:raise ValueError('unsupported Unicode shape: '+cat)
  if unicodedata.category(replacement)!=cat:raise ValueError('Unicode category mismatch')
  out.append(replacement)
 return ''.join(out)
def scrub(catalog,rows,policy,key):
 if not isinstance(key,bytearray) or len(key)<32:raise ValueError('fresh mutable 256-bit corpus key required')
 aliases={}
 def substitute(value,p):
  if value is None:return None
  action=p['action']
  if action=='preserve':return value
  if action=='null':return None
  if action=='text':return text_shape(value)
  namespace=p.get('namespace')
  if not namespace:raise ValueError('identity/capability namespace required')
  raw=namespace+'\0'+json.dumps(value,ensure_ascii=False)
  if raw not in aliases:
   pseudonym=hmac.new(key,raw.encode(),hashlib.sha256).hexdigest()
   if action=='email':pseudonym='email-'+pseudonym[:24]+'@example.invalid'
   elif action=='capability':pseudonym=p.get('prefix','2')+pseudonym[:24]
   else:pseudonym='user#'+pseudonym[:24]
   aliases[raw]=pseudonym
  return aliases[raw]
 try:
  validate(catalog,policy)
  result={}
  for table,records in rows.items():
   if table not in policy:raise ValueError('unknown table '+table)
   result[table]=[]
   for row in records:
    if set(row)!=set(policy[table]):raise ValueError('row does not match schema: '+table)
    result[table].append({c:substitute(v,policy[table][c]) for c,v in row.items()})
  payload=json.dumps(result,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
  return {'corpus_hash':hashlib.sha256(payload).hexdigest(),'data':result}
 finally:
  aliases.clear()
  for i in range(len(key)):key[i]=0
  # Python/allocator copies are not guaranteed erased. Production MUST destroy the enclave/process,
  # encrypted scratch volume and memory snapshot capability before publishing the safe corpus.
def skeleton(catalog):
 return {t:{r['column']:{'action':'REVIEW','reviewed':False,'reason':''} for r in catalog if r['table']==t} for t in sorted({r['table'] for r in catalog})}
