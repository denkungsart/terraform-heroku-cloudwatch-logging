'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFirehoseRecordBatches,
  buildLogStreamName,
  chunk,
  FIREHOSE_MAX_RECORD_BYTES,
  removePrefix,
  validateBasicAuth,
  validateRequiredEnv,
} from './lambda_heroku_logs_helpers.js';

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

test('chunk splits items into fixed-size batches', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('buildLogStreamName appends request id to the base stream name', () => {
  assert.equal(buildLogStreamName('heroku-logs-stream', 'request-123'), 'heroku-logs-stream/request-123');
});

test('buildLogStreamName falls back to request id without a base stream name', () => {
  assert.equal(buildLogStreamName('', 'request-123'), 'request-123');
});

test('removePrefix removes Heroku frame and syslog tokens while preserving message spacing', () => {
  const line = '328 <134>1 2025-01-12T20:26:22.585603+00:00 host heroku router - at=info  path=/';

  assert.equal(
    removePrefix(line),
    '2025-01-12T20:26:22.585603+00:00 host heroku router - at=info  path=/'
  );
});

test('removePrefix leaves short lines unchanged', () => {
  assert.equal(removePrefix('one two'), 'one two');
});

test('buildFirehoseRecordBatches splits records by Firehose record count limit', () => {
  const batches = buildFirehoseRecordBatches(Array.from({ length: 501 }, (_, index) => `line ${index}`));

  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 500);
  assert.equal(batches[1].length, 1);
});

test('buildFirehoseRecordBatches splits records by Firehose request byte limit', () => {
  const batches = buildFirehoseRecordBatches(Array.from({ length: 6 }, () => 'a'.repeat(800_000)));

  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 5);
  assert.equal(batches[1].length, 1);
});

test('buildFirehoseRecordBatches rejects records above the Firehose record byte limit', () => {
  assert.throws(
    () => buildFirehoseRecordBatches(['a'.repeat(FIREHOSE_MAX_RECORD_BYTES)]),
    /exceeds Firehose record limit/
  );
});

test('validateBasicAuth accepts matching credentials', () => {
  const env = { AUTH_USERNAME: 'heroku', AUTH_PASSWORD: 'secret:with:colons' };

  assert.equal(validateBasicAuth(basicAuth('heroku', 'secret:with:colons'), env), true);
});

test('validateBasicAuth rejects invalid credentials', () => {
  const env = { AUTH_USERNAME: 'heroku', AUTH_PASSWORD: 'secret' };

  assert.equal(validateBasicAuth(basicAuth('heroku', 'wrong'), env), false);
  assert.equal(validateBasicAuth('Bearer token', env), false);
  assert.equal(validateBasicAuth(undefined, env), false);
});

test('validateRequiredEnv reports missing Lambda configuration', () => {
  assert.throws(
    () => validateRequiredEnv({ AUTH_USERNAME: 'u' }),
    /Missing required environment variable\(s\): AUTH_PASSWORD, FIREHOSE_STREAM_NAME, HEROKU_LOGS_GROUP, HEROKU_LOGS_STREAM/
  );
});
