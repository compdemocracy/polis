'use strict';
// Offline native-verifier controls. The runtime's compiled blocklist is used
// for affected objects; test hooks are used only for our generated local CA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const tls = require('node:tls');
const { once } = require('node:events');
const { X509Certificate, createHash } = require('node:crypto');
const { internalBinding } = require('internal/test/binding');
const { addBlockedSPKIForTesting, clearBlockedSPKIsForTesting } = internalBinding('crypto');
const dir = process.argv[2];
const root = fs.readFileSync(`${dir}/root.pem`, 'utf8');
const intermediate = fs.readFileSync(`${dir}/intermediate.pem`, 'utf8');
const leaf = fs.readFileSync(`${dir}/leaf.pem`, 'utf8');
const key = fs.readFileSync(`${dir}/leaf.key`, 'utf8');
const objects = fs.readFileSync('/audit/fixtures/affected-intermediates.pem', 'utf8')
  .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
assert.equal(objects.length, 16);

async function handshake(extra, ca, expected) {
  const server = tls.createServer({ key, cert: leaf + intermediate + extra }, s => s.end());
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let client;
  try {
    client = tls.connect({ host: '127.0.0.1', port: server.address().port,
      servername: 'localhost', ca, rejectUnauthorized: true });
    client.setTimeout(5000, () => client.destroy(new Error('local TLS test timed out')));
    if (expected) {
      await assert.rejects(once(client, 'secureConnect'), { code: expected });
    } else {
      await once(client, 'secureConnect');
      assert.equal(client.authorized, true);
    }
  } finally {
    client?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  await handshake('', root);
  await handshake('', [], 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
  const spki = new X509Certificate(intermediate).publicKey.export({ type: 'spki', format: 'der' });
  try {
    addBlockedSPKIForTesting(createHash('sha256').update(spki).digest());
    await handshake('', root, 'CERT_REVOKED');
  } finally {
    clearBlockedSPKIsForTesting();
  }
  await handshake('', root);
  // An untrusted generated chain makes Node inspect every peer-sent object.
  // These are blocklist-precedence checks, not forged affected leaf chains.
  // No hook inserts affected keys: each must already be compiled into Node.
  for (const object of objects) {
    await handshake(object, [], 'CERT_REVOKED');
  }
  console.log('PASS Node native verifier: 16/16 compiled-key refusals; 4 generated-chain controls');
})().catch(error => { console.error(error); process.exitCode = 1; });
