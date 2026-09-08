'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler } from './lambda_heroku_logs_index.js';

const ENV = {
  AUTH_USERNAME: 'heroku',
  AUTH_PASSWORD: 'secret',
  FIREHOSE_STREAM_NAME: 'firehose-stream',
  HEROKU_LOGS_GROUP: '/heroku/logs',
  HEROKU_LOGS_STREAM: 'heroku-logs-stream',
};

function basicAuth(username = ENV.AUTH_USERNAME, password = ENV.AUTH_PASSWORD) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function createAwsClientStub(responses = []) {
  const calls = [];

  return {
    calls,
    async send(command) {
      calls.push(command);

      const response = responses.shift();
      if (response instanceof Error) {
        throw response;
      }

      return response || {};
    },
  };
}

function createLoggerStub() {
  return {
    errors: [],
    error(...args) {
      this.errors.push(args);
    },
  };
}

function assertDrainResponse(response, statusCode) {
  assert.deepEqual(response, {
    statusCode,
    headers: {
      ...(statusCode === 401 ? { 'WWW-Authenticate': 'Basic realm="Heroku Logs"' } : {}),
      'Content-Length': '0',
    },
    body: '',
  });
}

test('handler rejects requests without valid Basic Auth before sending to AWS', async t => {
  const cases = [
    { name: 'missing', authorization: undefined },
    { name: 'malformed', authorization: 'Bearer invalid' },
    { name: 'incorrect', authorization: basicAuth('wrong', 'password') },
  ];

  for (const { name, authorization } of cases) {
    await t.test(name, async () => {
      const firehoseClient = createAwsClientStub();
      const logsClient = createAwsClientStub();
      const logger = createLoggerStub();
      const handler = createHandler({ firehoseClient, logsClient, env: ENV, logger });

      const response = await handler({ headers: { authorization }, body: 'line\n' });

      assertDrainResponse(response, 401);
      assert.equal(firehoseClient.calls.length, 0);
      assert.equal(logsClient.calls.length, 0);
      assert.deepEqual(logger.errors, [['Unauthorized Heroku log drain request']]);
    });
  }
});

test('handler acknowledges an authenticated empty request without AWS writes', async () => {
  const firehoseClient = createAwsClientStub();
  const logsClient = createAwsClientStub();
  const handler = createHandler({
    firehoseClient,
    logsClient,
    env: ENV,
    logger: createLoggerStub(),
  });

  const response = await handler({ headers: { authorization: basicAuth() }, body: '' });

  assertDrainResponse(response, 200);
  assert.equal(firehoseClient.calls.length, 0);
  assert.equal(logsClient.calls.length, 0);
});

test('handler decodes base64 bodies and writes raw logs to Firehose and processed logs to CloudWatch', async () => {
  const line = '328 <134>1 2026-05-13T08:16:55.000000+00:00 host heroku router - \u001b[1;34mError L10\u001b[0m output buffer overflow';
  const firehoseClient = createAwsClientStub([{ FailedPutCount: 0 }]);
  const logsClient = createAwsClientStub([
    { logStreams: [] },
    {},
    {},
  ]);
  const handler = createHandler({
    firehoseClient,
    logsClient,
    env: ENV,
    logger: createLoggerStub(),
    now: () => new Date('2026-05-13T12:00:00Z'),
  });

  const response = await handler({
    headers: { authorization: basicAuth() },
    isBase64Encoded: true,
    body: Buffer.from(`${line}\n`, 'utf8').toString('base64'),
  });

  assertDrainResponse(response, 200);
  assert.equal(firehoseClient.calls.length, 1);
  assert.equal(firehoseClient.calls[0].constructor.name, 'PutRecordBatchCommand');
  assert.deepEqual(firehoseClient.calls[0].input, {
    DeliveryStreamName: ENV.FIREHOSE_STREAM_NAME,
    Records: [{ Data: `${line}\n` }],
  });

  assert.deepEqual(
    logsClient.calls.map(command => command.constructor.name),
    ['DescribeLogStreamsCommand', 'CreateLogStreamCommand', 'PutLogEventsCommand']
  );
  assert.equal(logsClient.calls[0].input.logStreamNamePrefix, 'heroku-logs-stream/2026-05-13');
  assert.deepEqual(logsClient.calls[1].input, {
    logGroupName: ENV.HEROKU_LOGS_GROUP,
    logStreamName: 'heroku-logs-stream/2026-05-13',
  });
  assert.deepEqual(logsClient.calls[2].input, {
    logGroupName: ENV.HEROKU_LOGS_GROUP,
    logStreamName: 'heroku-logs-stream/2026-05-13',
    logEvents: [{
      message: '2026-05-13T08:16:55.000000+00:00 host heroku router - Error L10 output buffer overflow',
      timestamp: Date.parse('2026-05-13T08:16:55.000000+00:00'),
    }],
  });
});

test('handler retries only failed retryable Firehose records before continuing to CloudWatch', async () => {
  const firstLine = '328 <134>1 2026-05-13T08:16:55.000000+00:00 host heroku router - first';
  const secondLine = '328 <134>1 2026-05-13T08:16:56.000000+00:00 host heroku router - second';
  const sleepDelays = [];
  const firehoseClient = createAwsClientStub([
    {
      FailedPutCount: 1,
      RequestResponses: [
        { RecordId: 'accepted' },
        { ErrorCode: 'ServiceUnavailableException', ErrorMessage: 'try again' },
      ],
    },
    { FailedPutCount: 0 },
  ]);
  const logsClient = createAwsClientStub([
    { logStreams: [{ logStreamName: 'heroku-logs-stream/2026-05-13' }] },
    {},
  ]);
  const handler = createHandler({
    firehoseClient,
    logsClient,
    env: ENV,
    logger: createLoggerStub(),
    now: () => new Date('2026-05-13T12:00:00Z'),
    sleepFn: async delay => {
      sleepDelays.push(delay);
    },
  });

  const response = await handler({
    headers: { Authorization: basicAuth() },
    body: `${firstLine}\n${secondLine}\n`,
  });

  assertDrainResponse(response, 200);
  assert.deepEqual(sleepDelays, [100]);
  assert.equal(firehoseClient.calls.length, 2);
  assert.deepEqual(
    firehoseClient.calls.map(command => command.input.Records.map(record => record.Data)),
    [
      [`${firstLine}\n`, `${secondLine}\n`],
      [`${secondLine}\n`],
    ]
  );
  assert.deepEqual(
    logsClient.calls.map(command => command.constructor.name),
    ['DescribeLogStreamsCommand', 'PutLogEventsCommand']
  );
});

test('handler returns 500 and skips CloudWatch when Firehose reports non-retryable failures', async () => {
  const line = '328 <134>1 2026-05-13T08:16:55.000000+00:00 host heroku router - dropped';
  const logger = createLoggerStub();
  const firehoseClient = createAwsClientStub([
    {
      FailedPutCount: 1,
      RequestResponses: [
        { ErrorCode: 'InvalidArgumentException', ErrorMessage: 'bad record' },
      ],
    },
  ]);
  const logsClient = createAwsClientStub();
  const handler = createHandler({
    firehoseClient,
    logsClient,
    env: ENV,
    logger,
  });

  const response = await handler({
    headers: { authorization: basicAuth() },
    body: `${line}\n`,
  });

  assertDrainResponse(response, 500);
  assert.match(logger.errors.at(-1)[1].message, /Failed to deliver 1 Heroku log record/);
  assert.equal(logsClient.calls.length, 0);
  assert.equal(logger.errors.length, 2);
});

test('handler caches confirmed CloudWatch log streams across warm invocations', async () => {
  const line = '328 <134>1 2026-05-13T08:16:55.000000+00:00 host heroku router - cached';
  const firehoseClient = createAwsClientStub([
    { FailedPutCount: 0 },
    { FailedPutCount: 0 },
  ]);
  const logsClient = createAwsClientStub([
    { logStreams: [] },
    {},
    {},
    {},
  ]);
  const handler = createHandler({
    firehoseClient,
    logsClient,
    env: ENV,
    logger: createLoggerStub(),
    now: () => new Date('2026-05-13T12:00:00Z'),
  });

  const event = {
    headers: { authorization: basicAuth() },
    body: `${line}\n`,
  };

  assertDrainResponse(await handler(event), 200);
  assertDrainResponse(await handler(event), 200);
  assert.deepEqual(
    logsClient.calls.map(command => command.constructor.name),
    [
      'DescribeLogStreamsCommand',
      'CreateLogStreamCommand',
      'PutLogEventsCommand',
      'PutLogEventsCommand',
    ]
  );
});

test('handler keeps configuration and AWS failure diagnostics in logs', async t => {
  const failure = new Error('Downstream delivery unavailable');
  const scenarios = [
    { name: 'missing configuration', env: {}, firehoseCalls: 0, logsCalls: 0, message: /Missing required environment/ },
    { name: 'Firehose request failure', firehoseResponses: [failure], firehoseCalls: 1, logsCalls: 0 },
    { name: 'CloudWatch stream lookup failure', logsResponses: [failure], firehoseCalls: 1, logsCalls: 1 },
    { name: 'CloudWatch stream creation failure', logsResponses: [{ logStreams: [] }, failure], firehoseCalls: 1, logsCalls: 2 },
    { name: 'CloudWatch delivery failure', logsResponses: [{ logStreams: [] }, {}, failure], firehoseCalls: 1, logsCalls: 3 },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const firehoseClient = createAwsClientStub(scenario.firehoseResponses);
      const logsClient = createAwsClientStub(scenario.logsResponses);
      const logger = createLoggerStub();
      const handler = createHandler({ firehoseClient, logsClient, env: scenario.env || ENV, logger });

      const response = await handler({ headers: { authorization: basicAuth() }, body: 'line\n' });

      assertDrainResponse(response, 500);
      assert.equal(firehoseClient.calls.length, scenario.firehoseCalls);
      assert.equal(logsClient.calls.length, scenario.logsCalls);
      assert.match(logger.errors.at(-1)[1].message, scenario.message || /Downstream delivery unavailable/);
    });
  }
});

test('handler returns an empty 500 after exhausting Firehose retries', async () => {
  const firehoseClient = createAwsClientStub(Array.from({ length: 4 }, () => ({
    FailedPutCount: 1,
    RequestResponses: [{ ErrorCode: 'ServiceUnavailableException', ErrorMessage: 'try again' }],
  })));
  const logsClient = createAwsClientStub();
  const logger = createLoggerStub();
  const sleepDelays = [];
  const handler = createHandler({
    firehoseClient,
    logsClient,
    env: ENV,
    logger,
    sleepFn: async delay => { sleepDelays.push(delay); },
  });

  const response = await handler({ headers: { authorization: basicAuth() }, body: 'line\n' });

  assertDrainResponse(response, 500);
  assert.equal(firehoseClient.calls.length, 4);
  assert.deepEqual(sleepDelays, [100, 200, 400]);
  assert.equal(logsClient.calls.length, 0);
  assert.match(logger.errors.at(-1)[1].message, /Failed to deliver 1 Heroku log record/);
});

test('handler waits for both downstream writes before acknowledging delivery', async () => {
  const firehoseWrite = Promise.withResolvers();
  const cloudWatchWrite = Promise.withResolvers();
  const calls = [];
  const handler = createHandler({
    firehoseClient: { send: () => { calls.push('firehose'); return firehoseWrite.promise; } },
    logsClient: { send: () => { calls.push('cloudwatch'); return cloudWatchWrite.promise; } },
    knownLogStreams: new Set([`${ENV.HEROKU_LOGS_GROUP}:${ENV.HEROKU_LOGS_STREAM}/2026-05-13`]),
    now: () => new Date('2026-05-13T12:00:00Z'),
    env: ENV,
    logger: createLoggerStub(),
  });
  let acknowledged = false;
  const pendingResponse = handler({ headers: { authorization: basicAuth() }, body: 'line\n' });
  pendingResponse.then(() => { acknowledged = true; });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['firehose']);
  assert.equal(acknowledged, false);

  firehoseWrite.resolve({ FailedPutCount: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['firehose', 'cloudwatch']);
  assert.equal(acknowledged, false);

  cloudWatchWrite.resolve({});
  assertDrainResponse(await pendingResponse, 200);
});
