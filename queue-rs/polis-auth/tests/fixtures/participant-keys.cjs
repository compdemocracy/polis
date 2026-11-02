// Disposable test keys only. Mirrors Node's key-value decoding and bare RS256
// header; emits no files and requires no packages outside Node's standard library.
const { generateKeyPairSync, createPublicKey, createHash, sign } = require('node:crypto');
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
function decode(value) {
  return value.includes('BEGIN') ? value.replace(/\\n/g, '\n') : Buffer.from(value, 'base64').toString('utf8');
}
const escapedPrivate = privateKey.replace(/\n/g, '\\n');
const escapedPublic = publicKey.replace(/\n/g, '\\n');
const fingerprint = createHash('sha256').update(
  createPublicKey(decode(escapedPublic)).export({ type: 'spki', format: 'der' })
).digest('hex');
const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({
  aud: 'participants', iss: 'https://pol.is/', pid: 0, uid: 3,
  exp: 1831536000, iat: 1800000000, conversation_id: '2jwt-test',
  sub: 'anon:3', anonymous_participant: true,
})).toString('base64url');
const signed = `${header}.${payload}`;
const token = `${signed}.${sign('RSA-SHA256', Buffer.from(signed), decode(escapedPrivate)).toString('base64url')}`;
process.stdout.write(JSON.stringify({ privateKey, publicKey, fingerprint, token }));
