/* eslint-disable no-restricted-properties -- This isolated SDK fixture controls its own credential environment. */
// Separate process: exercise the real SDK provider chain outside Jest's VM.
const http = require('node:http');
const { createHash } = require('node:crypto');
const Module = require('node:module');
require('ts-node/register/transpile-only');
const [mode, service] = process.argv.slice(2);
let roleReads = 0;
const requests = [];
const server = http.createServer((req, res) => {
  if (req.url === '/role') {
    roleReads++;
    res.end(JSON.stringify({AccessKeyId: 'generated-role-id', SecretAccessKey: 'generated-role-secret',
      Token: 'generated-role-token', Expiration: '2099-01-01T00:00:00Z'}));
    return;
  }
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    requests.push({path: req.url, body, auth: req.headers.authorization, token: req.headers['x-amz-security-token']});
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({MessageId: 'generated-message', TableNames: [],
      MD5OfMessageBody: createHash('md5').update('generated body').digest('hex')}));
  });
});
server.listen(0, '127.0.0.1', async () => {
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  for (const name of Object.keys(process.env)) if (name.startsWith('AWS_')) delete process.env[name];
  Object.assign(process.env, {AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: '/nonexistent/generated-config',
    AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/generated-credentials', AWS_CONTAINER_CREDENTIALS_FULL_URI: `${endpoint}/role`});
  if (mode === 'static') Object.assign(process.env, {AWS_ACCESS_KEY_ID: 'generated-static-id', AWS_SECRET_ACCESS_KEY: 'generated-static-secret'});
  const config = {AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID, awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: 'us-east-1', awsRegion: 'us-east-1', SESEndpoint: endpoint, AWS_S3_ENDPOINT: endpoint,
    dynamoDbEndpoint: endpoint, SQS_LOCAL_ENDPOINT: endpoint, nodeEnv: 'test'};
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    if (resolved.endsWith('/src/config.ts')) return {__esModule: true, default: config};
    if (resolved.endsWith('/src/utils/logger.ts')) return {__esModule: true, default: {info() {}, warn() {}, error() {}}};
    if (resolved.endsWith('/src/db/pg-query.ts')) return {__esModule: true, default: {}};
    return originalLoad.apply(this, arguments);
  };
  let client;
  try {
    if (service === 'SES') {
      const {sendTextEmail} = require('../../src/email/senders');
      await sendTextEmail('sender@example.invalid', 'recipient@example.invalid', 'generated subject', 'generated body');
    } else if (service === 'S3') {
      client = require('../../src/workers/import-processor').s3Client;
      const {PutObjectCommand} = require('@aws-sdk/client-s3');
      await client.send(new PutObjectCommand({Bucket: 'generated-bucket', Key: 'object', Body: 'generated body'}));
    } else if (service === 'DynamoDB') {
      client = require('../../src/utils/dynamoClient').makeDynamoClient();
      const {ListTablesCommand} = require('@aws-sdk/client-dynamodb');
      await client.send(new ListTablesCommand({}));
    } else if (service === 'SQS') {
      client = require('../../src/utils/sqs').sqsClient;
      const {SendMessageCommand} = require('@aws-sdk/client-sqs');
      await client.send(new SendMessageCommand({QueueUrl: `${endpoint}/queue`, MessageBody: 'generated body'}));
    } else throw new Error('unsupported service');
    process.stdout.write(JSON.stringify({roleReads, requests}));
    client?.destroy(); server.closeAllConnections(); server.close(() => process.exit(0));
  } catch (error) { process.stderr.write(String(error)); process.exit(1); }
});
