'use strict';
// This is normalization of nondeterminism in already-safe generated data, NOT PII redaction.
const policy = {
  version: 1,
  entropy: {algorithm:'xorshift32', seed:'first 8 hex digits of case seed; zero maps to 0x270027', crypto:'unmodified'},
  urlFields: ['url','location'],
  encodedFields: {'$.response.body.pca.asJSON':'json','$.response.body.pca.asBufferOfGzippedJson':'gzip-json'},
  timeFields: [
    'expiration',
    'lastModTimestamp',
    'created',
    'modified',
    'last_interaction',
    'last_notified',
    'created_at',
    'updated_at',
    'timestamp',
    'serverTimestamp',
    'currentTimestamp',
    'lastVoteTimestamp',
    'lastCommentTimestamp',
    'last_activity',
    'started_time',
    'finished_time',
  ],
  symbolFields: [
    'zinvite',
    'conversation_id',
    'report_id',
    'uuid',
    'site_id',
    'oinvite',
    'einvite',
    'invite_code',
    'login_code',
    'pwresettoken',
    'auth_token',
  ],
  responseHeaders: [
    'content-type',
    'location',
    'allow',
    'access-control-allow-origin',
    'access-control-allow-credentials',
    'content-disposition',
    'cache-control',
  ],
  requestHeaders: ['content-type', 'accept', 'origin', 'authorization', 'x-forwarded-proto'],
};
class Normalizer {
  constructor() {
    this.symbols = new Map();
    this.rules = [];
  }
  normalize(x, path = '$', key = '') {
    if (x === null || x === undefined) return x;
    const encoding=policy.encodedFields[path];
    if(encoding) {
      let decoded;
      if(encoding==='gzip-json') {
        if(x.type!=='Buffer'||!Array.isArray(x.data))throw Error('invalid PCA gzip buffer');
        decoded=require('node:zlib').gunzipSync(Buffer.from(x.data)).toString('utf8');
      } else decoded=x;
      const parsed=JSON.parse(decoded);
      this.rules.push({path,rule:encoding});
      return {$encoding:encoding,value:this.normalize(parsed,path+'.decoded')};
    }

    if (policy.timeFields.includes(key) && (typeof x === 'number' || typeof x === 'string')) {
      if (x === 0 || x === '0' || x === -1 || x === '-1') return x;
      this.rules.push({ path, rule: 'clock-value', type: typeof x });
      // Preserve representation, sentinel, and precision; only the wall-clock instant varies.
      return {
        $clock: typeof x,
        format: typeof x === 'string' && /T/.test(x) ? 'ISO8601' : 'epoch',
        precision:
          typeof x === 'string' && x.includes('.') ? x.split('.')[1].replace(/Z$/, '').length : 0,
      };
    }
    if (
      typeof x === 'string' &&
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(x) &&
      /jwt|token/i.test(key)
    ) {
      try {
        const parts = x.split('.'),
          p = JSON.parse(Buffer.from(parts[1], 'base64url'));
        const ttl = p.exp - p.iat;
        delete p.exp;
        delete p.iat;
        return {
          $jwt: this.normalize(p, `${path}.claims`),
          ttl,
          header: JSON.parse(Buffer.from(parts[0], 'base64url')),
        };
      } catch {
        return x;
      }
    }
    if(policy.urlFields.includes(key) && typeof x==='string') {
      try {
        const u=new URL(x);let changed=false;
        const parts=u.pathname.split('/').map(segment=>{
          for(const namespace of ['conversation_id','report_id','uuid']) {
            const replacement=this.symbols.get(`${namespace}:${segment}`);
            if(replacement){changed=true;return replacement;}
          }
          return segment;
        });
        if(changed){u.pathname=parts.join('/');this.rules.push({path,rule:'URL capability path segment'});return u.toString();}
      }catch{}
      return x;
    }
    if (policy.symbolFields.includes(key) && typeof x === 'string') {
      // Public generated fixture capabilities are stable; new server-minted values bind in encounter order.
      if (x.includes('p027') || !x) return x;
      const ns = key === 'zinvite' ? 'conversation_id' : key;
      const id = `${ns}:${x}`;
      if (!this.symbols.has(id))
        this.symbols.set(
          id,
          `$${ns}:${[...this.symbols.keys()].filter((k) => k.startsWith(ns + ':')).length + 1}`
        );
      this.rules.push({ path, rule: 'symbol', namespace: ns });
      return this.symbols.get(id);
    }
    if (Array.isArray(x)) return x.map((v, i) => this.normalize(v, `${path}[${i}]`, key));
    if (typeof x === 'object')
      return Object.fromEntries(
        Object.keys(x)
          .sort()
          .map((k) => [k, this.normalize(x[k], `${path}.${k}`, k)])
      );
    return x;
  }
}
module.exports = { policy, Normalizer };
