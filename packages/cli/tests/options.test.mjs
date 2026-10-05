import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServer, validateArguments, identityId } from '../dist/options.js';

test('remote credentials require a safe HTTPS origin', () => {
  assert.equal(normalizeServer('https://api.endport.io/'), 'https://api.endport.io');
  assert.equal(normalizeServer('http://localhost:8080'), 'http://localhost:8080');
  for (const url of ['http://evil.example', 'https://user:secret@api.endport.io', 'https://api.endport.io/path', 'https://api.endport.io?secret=x', 'file:///tmp/app']) assert.throws(() => normalizeServer(url));
});
test('reject ambiguous CLI options before creating an app', () => {
  for (const args of [['3000', '--name'], ['3000','--domain','https://example.com'], ['3000','--name','one','--name','two'], ['3000','--unknown'], ['3000','4000']]) assert.throws(() => validateArguments(args, '3000'));
  validateArguments(['3000','--name','my-app','--domain','api.example.com'], '3000');
  assert.throws(() => validateArguments(['3000'], 'start'));
});
test('project identity cannot escape the credential directory', () => {
  for (const value of ['../config.json','/etc/passwd','..','a/b',null]) assert.throws(() => identityId(value));
  assert.equal(identityId('endpoint_123-abc'), 'endpoint_123-abc');
});
