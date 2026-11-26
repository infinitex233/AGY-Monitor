import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import test from 'node:test';
import tls from 'node:tls';
import vm from 'node:vm';
import { createContextWindowSyncExpression } from '../backend/context-windows.mjs';
import {
  createCloudCodeProxyController,
  detectSystemHttpsProxy,
  extractUpstreamCheckpointDefaults,
  isValidUpstreamCloudCodeUrl,
  normalizeCcProxyCandidateUrl,
  openCcProxyTunnelSocket,
  rewriteFetchAvailableModelsPayload,
  shouldCcProxyBypassHost,
} from '../backend/cloudcode-proxy.mjs';
import { createWindowBridgeController } from '../backend/window-bridge.mjs';
import { backendHarness } from './backend-harness.mjs';
import { createMockDom } from './mock-dom.mjs';

const argon = 'MODEL_PLACEHOLDER_M430';
const flash = 'MODEL_PLACEHOLDER_M431';
const other = 'MODEL_PLACEHOLDER_M432';
const carbon = 'MODEL_PLACEHOLDER_M427';
const carbonLow = 'MODEL_PLACEHOLDER_M438';
const newCarbonLow = 'MODEL_PLACEHOLDER_M439';
const carbonGroup = 'model:gemini-4-carbon';
const availableModels = {
  'gemini-4-carbon-high': { model: carbon, maxTokens: 1048576, maxOutputTokens: 262144 },
  'gemini-4-carbon-low': { model: carbonLow, maxTokens: 700000, maxOutputTokens: 64000 },
  'gemini-other': { model: other, maxTokens: 250000, maxOutputTokens: 64000 },
};
const carbonModels = [
  { label: 'Gemini 4 Carbon (High)', modelId: 'gemini-4-carbon-high', modelOrAlias: { model: carbon } },
  { label: 'Gemini 4 Carbon (Low)', modelId: 'gemini-4-carbon-low', modelOrAlias: { model: carbonLow } },
];

test('saves and restores one model at a time using host presets or verified model capacity', async () => {
  const h = backendHarness({
    settings: { contextLimitOverrideTokens: 900000 },
    availableModels,
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label: 'Argon', modelOrAlias: { model: argon },
            contextWindowOptions: [{ name: '512K' }, { name: '900K', expensive: true }] },
          { label: 'Flash', modelOrAlias: { model: flash }, contextWindowOptions: [{ name: '256K' }] },
          { label: 'Other', modelOrAlias: { model: other } },
          ...carbonModels,
        ],
      },
    },
  });
  const update = h.executeModelContextWindowAction;
  const { contextWindowModels } = await h.buildTelemetryPayloadInternal('');
  const [argonModel, flashModel, otherModel, carbonModel] = JSON.parse(JSON.stringify(contextWindowModels));
  assert.deepEqual(argonModel.options, [{ name: '512K', expensive: false }, { name: '900K', expensive: true }]);
  assert.deepEqual(flashModel.options, [{ name: '256K', expensive: false }]);
  assert.deepEqual(otherModel.options.map(({ tokens }) => tokens), [128000, 186000]);
  assert.equal(carbonModel.id, carbonGroup);
  assert.equal(carbonModel.label, 'Gemini 4 Carbon');
  assert.deepEqual(carbonModel.members, [carbon, carbonLow]);
  assert.deepEqual(carbonModel.options.map(({ tokens }) => tokens), [128000, 256000, 384000, 512000, 636000]);
  assert.equal((await update({ modelId: carbonGroup, option: '768000' })).status, 400);
  h.state.settings.modelContextWindows = { [carbon]: '768000', [carbonLow]: '256000' };
  assert.equal((await update({ modelId: carbonGroup, option: '384000' })).status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [carbonGroup]: '384000' });
  assert.equal((await update({ modelId: carbonGroup, option: '512000' })).status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [carbonGroup]: '512000' });
  assert.equal((await update({ modelId: carbonGroup, option: null })).status, 200);
  assert.equal((await update({ modelId: flash, option: '900K' })).status, 400);
  assert.equal((await update({ modelId: other, option: '900K' })).status, 400);
  assert.equal((await update({ modelId: '__proto__', option: null })).status, 400);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, {});

  const [a, b] = await Promise.all([
    update({ modelId: argon, option: '900K' }),
    update({ modelId: flash, option: '256K' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [argon]: '900K', [flash]: '256K' });
  assert.equal((await update({ modelId: argon, option: null })).status, 200);
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, { [flash]: '256K' });
  h.executeResetSettingsAction();
  assert.deepEqual({ ...h.loadSettings().modelContextWindows }, {});
});

test('reports the latest observed threshold separately from the saved group preference', async () => {
  const h = backendHarness({
    availableModels,
    settings: { modelContextWindows: { [carbonGroup]: '512000' } },
    userStatus: { cascadeModelConfigData: { clientModelConfigs: carbonModels } },
    summaries: { active: { stepCount: 1, lastModifiedTime: '2026-01-01T00:00:01Z', status: 'IDLE' } },
    trajectories: {
      active: { trajectory: {
        steps: [{ metadata: {
          createdAt: '2026-01-01T00:00:00Z',
          finishedGeneratingAt: '2026-01-01T00:00:01Z',
          modelUsage: { model: carbonLow, inputTokens: 20, outputTokens: 20 },
        }, plannerResponse: { response: 'ok' } }],
        generatorMetadata: [{ stepIndices: [0], chatModel: {
          chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } },
        } }],
      } },
    },
  });
  const result = await h.buildTelemetryPayloadInternal('active');
  assert.equal(result.contextWindowModels.find(({ id }) => id === carbonGroup).reportedLimitTokens, 256000);
  assert.equal(result.settings.modelContextWindows[carbonGroup], '512000');
  const previouslyCached = h.state.saves.find(({ data }) => data.active?.contextLimitTelemetry).data.active;
  const cached = structuredClone(previouslyCached);
  delete cached.contextLimitTelemetry;
  delete cached.steps[0].reportedContextLimitTokens;
  const upgraded = backendHarness({
    availableModels,
    userStatus: h.state.userStatus,
    cache: { active: cached },
    summaries: { active: { stepCount: 1, lastModifiedTime: '2026-01-01T00:00:01Z', status: 'IDLE' } },
    trajectories: h.state.trajectories,
  });
  const reloaded = await upgraded.buildTelemetryPayloadInternal('active');
  assert.equal(reloaded.contextWindowModels[0].reportedLimitTokens, 256000);
});

test('host requests apply a rule only to the exact model across App and IDE transports', async () => {
  const sendPath = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
  const statusPath = sendPath.replace('SendUserCascadeMessage', 'GetUserStatus');
  const host = 'https://127.0.0.1:25190';
  let catalog = availableModels;
  let variants = carbonModels;
  const nativeFetch = async (url, init) => {
    if (url === host + statusPath.replace('GetUserStatus', 'GetAvailableModels')) {
      return { ok: true, json: async () => ({ response: { models: catalog } }) };
    }
    if (url !== host + statusPath || init.body !== '{}') return init;
    assert.equal(init.headers['x-codeium-csrf-token'], 'local-test');
    return { ok: true, json: async () => ({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [
      { modelOrAlias: { model: argon }, contextWindowOptions: [{ name: '900K' }] },
      { modelOrAlias: { model: flash }, contextWindowOptions: [{ name: '256K' }] },
      ...variants,
      { modelOrAlias: { model: other } },
    ] } } }) };
  };
  class WebSocket {
    constructor(url) { this.url = url; }
    send(data) { return data; }
  }
  const nativeSend = WebSocket.prototype.send;
  const window = { location: new URL(host), fetch: nativeFetch, WebSocket, __APP_CONFIG__: { csrfToken: 'local-test' } };
  const context = vm.createContext({ window, URL, TextEncoder, TextDecoder, Headers, Uint8Array, AbortSignal, setTimeout, clearTimeout });
  const install = (rules, boot = 'first') => vm.runInContext(createContextWindowSyncExpression(rules, boot), context);
  const request = (model) => ({
    cascadeId: 'conversation-1',
    items: [{ text: 'Keep the request intact' }],
    cascadeConfig: {
      plannerConfig: { planModel: model },
      checkpointConfig: { maxTokenLimit: 128000, checkpointIntervalTokens: 20000 },
    },
  });
  const options = (body, type = 'application/json') => ({
    method: 'POST', headers: { 'Content-Type': type }, body,
  });
  const preferences = { [argon]: '900K', [flash]: '900K', [carbonGroup]: '512000', [other]: '512000' };
  await install(preferences);
  try {
    const payload = request(argon);
    const input = options(JSON.stringify(payload));
    const edited = JSON.parse((await window.fetch(host + sendPath, input)).body);
    assert.deepEqual(edited, {
      ...payload,
      cascadeConfig: {
        ...payload.cascadeConfig,
        checkpointConfig: { contextWindow: '900K', checkpointIntervalTokens: 20000 },
      },
    });
    const untouched = options(JSON.stringify(request(flash)));
    assert.equal(await window.fetch(host + sendPath, untouched), untouched);
    const lowCapacity = options(JSON.stringify(request(other)));
    assert.equal(await window.fetch(host + sendPath, lowCapacity), lowCapacity);
    const carbonPayload = request(carbon);
    carbonPayload.cascadeConfig.checkpointConfig.contextWindow = 'default';
    const carbonBody = (await window.fetch(host + sendPath, options(JSON.stringify(carbonPayload)))).body;
    assert.deepEqual(JSON.parse(carbonBody).cascadeConfig.checkpointConfig,
      { maxTokenLimit: 512000, checkpointIntervalTokens: 20000 });
    const lowPayload = options(JSON.stringify(request(carbonLow)));
    assert.equal(JSON.parse((await window.fetch(host + sendPath, lowPayload)).body).cascadeConfig.checkpointConfig.maxTokenLimit, 512000);
    assert.equal(await window.fetch('https://127.0.0.1:25191' + sendPath, input), input);
    assert.equal(await window.fetch(host + statusPath, input), input);

    const frame = Buffer.alloc(5 + Buffer.byteLength(input.body));
    frame.writeUInt32BE(frame.length - 5, 1);
    frame.write(input.body, 5);
    const framed = await window.fetch(host + sendPath, options(frame, 'application/grpc-web+json'));
    assert.equal(Buffer.from(framed.body).readUInt32BE(1), framed.body.length - 5);
    assert.deepEqual(JSON.parse(Buffer.from(framed.body.subarray(5)).toString()), edited);

    const socket = new WebSocket('wss://127.0.0.1:25190/connect-websocket');
    const msg = { type: 'start', stream: false, procedure: sendPath, streamId: 'request-1', payload };
    assert.deepEqual(JSON.parse(socket.send(JSON.stringify(msg))), { ...msg, payload: edited });
    const unrelated = JSON.stringify({ ...msg, payload: request(flash) });
    assert.equal(socket.send(unrelated), unrelated);
    const external = new WebSocket('wss://127.0.0.1:25191/connect-websocket');
    assert.equal(external.send(JSON.stringify(msg)), JSON.stringify(msg));

    const firstHook = window.fetch;
    variants = [carbonModels[0], { ...carbonModels[1], modelOrAlias: { model: newCarbonLow } }];
    catalog = { ...availableModels, 'gemini-4-carbon-low': { ...availableModels['gemini-4-carbon-low'], model: newCarbonLow } };
    await install(preferences, 'second');
    assert.notEqual(window.fetch, firstHook);
    assert.equal(await window.fetch(host + sendPath, lowPayload), lowPayload);
    window.fetch = nativeFetch;
    await install(preferences, 'second');
    const newLowPayload = options(JSON.stringify(request(newCarbonLow)));
    assert.equal(JSON.parse((await window.fetch(host + sendPath, newLowPayload)).body).cascadeConfig.checkpointConfig.maxTokenLimit, 512000);

    catalog['gemini-4-carbon-low'] = { model: newCarbonLow, maxTokens: 300000, maxOutputTokens: 64000 };
    await install(preferences, 'third');
    assert.equal(await window.fetch(host + sendPath, newLowPayload), newLowPayload);
    assert.equal(await window.fetch(host + sendPath, options(JSON.stringify(carbonPayload))).then(({ body }) => body), JSON.stringify(carbonPayload));
  } finally {
    await install({});
  }
  assert.equal(window.fetch, nativeFetch);
  assert.equal(WebSocket.prototype.send, nativeSend);
});

test('Issue #27: syncHostContextWindows falls back to backend pre-resolved rules without __APP_CONFIG__.csrfToken and intercepts StartCascade + Uint8Array / connect+json frames', async () => {
  const sendPath = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
  const startPath = '/exa.language_server_pb.LanguageServerService/StartCascade';
  const host = 'https://127.0.0.1:26190';
  const nativeFetch = async (_url, init) => init;
  class WebSocket {
    constructor(url) {
      this.url = url;
    }
    send(data) {
      return data;
    }
  }
  const window = {
    location: new URL(host),
    fetch: nativeFetch,
    WebSocket,
    __APP_CONFIG__: {}, // Simulate 2.33.0+ environment without exposed csrfToken on window
  };
  const context = vm.createContext({
    window,
    URL,
    TextEncoder,
    TextDecoder,
    Headers,
    Uint8Array,
    AbortSignal,
    setTimeout,
    clearTimeout,
  });

  const prefs = { [carbonGroup]: '256000' };
  const fallbackRules = { [carbon]: 256000, [carbonLow]: 256000 };
  const syncResult = await vm.runInContext(
    createContextWindowSyncExpression(prefs, 'boot-233', fallbackRules),
    context
  );
  assert.deepEqual({ ...syncResult }, { attached: true, ruleCount: 2 });

  try {
    // 1. StartCascade on new conversation creation with Uint8Array JSON body
    const startPayload = {
      cascadeConfig: {
        plannerConfig: { planModel: carbon },
        checkpointConfig: { maxTokenLimit: 512000 },
      },
    };
    const uint8Body = new TextEncoder().encode(JSON.stringify(startPayload));
    const startOut = await window.fetch(new URL(host + startPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: uint8Body,
    });
    assert.equal(startOut.body instanceof Uint8Array, true);
    assert.equal(
      JSON.parse(new TextDecoder().decode(startOut.body)).cascadeConfig.checkpointConfig
        .maxTokenLimit,
      256000
    );

    // 2. application/connect+json 5-byte envelope on SendUserCascadeMessage
    const msgBytes = Buffer.from(JSON.stringify(startPayload), 'utf8');
    const connectFrame = new Uint8Array(5 + msgBytes.length);
    new DataView(connectFrame.buffer).setUint32(1, msgBytes.length);
    connectFrame.set(msgBytes, 5);
    const framedOut = await window.fetch(host + sendPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/connect+json' },
      body: connectFrame,
    });
    const decodedJson = JSON.parse(
      new TextDecoder().decode(framedOut.body.subarray(5))
    );
    assert.equal(decodedJson.cascadeConfig.checkpointConfig.maxTokenLimit, 256000);

    // 3. WebSocket StartCascade frame
    const ws = new WebSocket('wss://127.0.0.1:26190/connect-websocket');
    const wsFrame = JSON.parse(
      ws.send(
        JSON.stringify({
          type: 'start',
          stream: false,
          procedure: startPath,
          payload: startPayload,
        })
      )
    );
    assert.equal(wsFrame.payload.cascadeConfig.checkpointConfig.maxTokenLimit, 256000);
  } finally {
    await vm.runInContext(createContextWindowSyncExpression({}, 'boot-233', {}), context);
  }
  assert.equal(window.fetch, nativeFetch);
});

test('cloudcode-proxy validates upstream URLs and rewrites checkpointer experiments cleanly', () => {
  assert.equal(isValidUpstreamCloudCodeUrl('https://daily-cloudcode-pa.googleapis.com'), true);
  assert.equal(isValidUpstreamCloudCodeUrl('https://cloudcode-pa.googleapis.com'), true);
  assert.equal(isValidUpstreamCloudCodeUrl('http://127.0.0.1:18148'), false);
  assert.equal(isValidUpstreamCloudCodeUrl('https://127.0.0.1:18148'), false);
  assert.equal(isValidUpstreamCloudCodeUrl('https://localhost:443'), false);
  assert.equal(isValidUpstreamCloudCodeUrl('http://daily-cloudcode-pa.googleapis.com'), false);

  const payload = {
    models: {
      'gemini-4-carbon-high': {
        model: carbon,
        maxTokens: 1048576,
        maxOutputTokens: 32768,
        ignoreExperiments: ['CASCADE_USE_EXPERIMENT_CHECKPOINTER', 'checkpoint-variant', 'unrelated-flag'],
        modelExperiments: {
          experiments: {
            CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
              stringValue: JSON.stringify({
                strategy: 'CHECKPOINT_STRATEGY_SAME_MODEL',
                max_token_limit: '512000',
                max_output_tokens: '32768',
              }),
            },
            'CASCADE_USE_EXPERIMENT_CHECKPOINTER/claude-1m_840k': {
              stringValue: JSON.stringify({ max_token_limit: '840000' }),
            },
          },
        },
      },
      'argon-named': {
        model: argon,
        maxTokens: 1048576,
        maxOutputTokens: 32768,
        modelExperiments: {
          experiments: {
            CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
              stringValue: JSON.stringify({ max_token_limit: '256000' }),
            },
            'CASCADE_USE_EXPERIMENT_CHECKPOINTER/context-window_900K': {
              stringValue: JSON.stringify({ max_token_limit: '900000', enabled: true }),
            },
          },
        },
      },
      'untouched-flash': {
        model: flash,
        maxTokens: 1048576,
        modelExperiments: {
          experiments: {
            CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
              stringValue: JSON.stringify({ max_token_limit: '128000' }),
            },
          },
        },
      },
    },
  };

  const beforeDefaults = extractUpstreamCheckpointDefaults(payload.models);
  assert.deepEqual(beforeDefaults, { [carbon]: 512000, [argon]: 256000, [flash]: 128000 });

  const res = rewriteFetchAvailableModelsPayload(payload, { [carbon]: 300000, [argon]: '900K' });
  assert.equal(res.modified, true);
  assert.equal(res.applied.length, 2);
  assert.deepEqual(res.defaultsByModelId, { [carbon]: 512000, [argon]: 256000, [flash]: 128000 });

  const carbonMain = JSON.parse(
    payload.models['gemini-4-carbon-high'].modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER
      .stringValue
  );
  const carbonVariant = JSON.parse(
    payload.models['gemini-4-carbon-high'].modelExperiments.experiments[
      'CASCADE_USE_EXPERIMENT_CHECKPOINTER/claude-1m_840k'
    ].stringValue
  );
  assert.equal(carbonMain.max_token_limit, '300000');
  assert.equal(carbonMain.strategy, 'CHECKPOINT_STRATEGY_SAME_MODEL');
  assert.equal(carbonVariant.max_token_limit, '300000');
  assert.equal(payload.models['gemini-4-carbon-high'].maxTokens, 1048576);
  assert.deepEqual(payload.models['gemini-4-carbon-high'].ignoreExperiments, ['unrelated-flag']);

  const argonMain = JSON.parse(
    payload.models['argon-named'].modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue
  );
  assert.equal(argonMain.max_token_limit, '900000');
  assert.equal(argonMain.enabled, true);

  const flashMain = JSON.parse(
    payload.models['untouched-flash'].modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER.stringValue
  );
  assert.equal(flashMain.max_token_limit, '128000');
});

test('createCloudCodeProxyController proxies fetchAvailableModels, streams passthrough, and restores SetCloudCodeURL cleanly', async () => {
  const upstreamHits = [];
  const upstreamServer = http.createServer((req, res) => {
    upstreamHits.push(req.url);
    if (req.url?.includes('fetchAvailableModels')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: {
            'gemini-4-carbon-high': {
              model: carbon,
              maxTokens: 1048576,
              modelExperiments: {
                experiments: {
                  CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
                    stringValue: JSON.stringify({ max_token_limit: '512000' }),
                  },
                },
              },
            },
          },
        })
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('chunk-1:');
    res.end('chunk-2');
  });
  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstreamServer.address().port;
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

  const rpcCalls = [];
  let failSetUrl = false;
  const proxy = createCloudCodeProxyController({
    allowHttpUpstream: true,
    allowTestEndpoint: true,
    retryCooldownMs: 5000,
    detectUpstreamFn: () => upstreamUrl,
    detectProxyFn: async () => '',
    getEndpointFn: () => ({ addr: '127.0.0.1:44444', baseUrl: 'http://127.0.0.1:44444', csrfToken: 'tok-1' }),
    callRpcFn: async (method, body) => {
      rpcCalls.push({ method, body });
      if (failSetUrl && method === 'SetCloudCodeURL') {
        throw new Error('enterprise gateway pinned');
      }
      return {};
    },
  });

  try {
    // 1. Enable with rule -> starts proxy & calls SetCloudCodeURL
    const st1 = await proxy.reconcile({ enabled: true, rulesByModelId: { [carbon]: 300000 } });
    assert.equal(st1.state, 'active');
    assert.equal(st1.active, true);
    assert.equal(st1.ruleCount, 1);
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].method, 'SetCloudCodeURL');
    assert.equal(rpcCalls[0].body.url, st1.localUrl);

    // 2. Fetch through proxy: /v1internal:fetchAvailableModels rewritten + upstream default captured
    const modelsRes = await fetch(`${st1.localUrl}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(modelsRes.status, 200);
    const modelsJson = await modelsRes.json();
    const rewrittenLimit = JSON.parse(
      modelsJson.models['gemini-4-carbon-high'].modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER
        .stringValue
    ).max_token_limit;
    assert.equal(rewrittenLimit, '300000');
    assert.deepEqual(proxy.getUpstreamDefaults(), { [carbon]: 512000 });

    // 3. Non-intercepted path passes through verbatim
    const streamRes = await fetch(`${st1.localUrl}/v1internal:streamGenerateContent`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(await streamRes.text(), 'chunk-1:chunk-2');

    // 4. Same reconcile is idempotent (no redundant SetCloudCodeURL)
    await proxy.reconcile({ enabled: true, rulesByModelId: { [carbon]: 300000 } });
    assert.equal(rpcCalls.length, 1);

    // 5. Rule change re-triggers SetCloudCodeURL to flush LS cache
    await proxy.reconcile({ enabled: true, rulesByModelId: { [carbon]: 256000 } });
    assert.equal(rpcCalls.length, 2);
    assert.equal(rpcCalls[1].body.url, st1.localUrl);

    // 6. Disabling restores upstream URL and closes proxy
    const stOff = await proxy.reconcile({ enabled: false, rulesByModelId: { [carbon]: 256000 } });
    assert.equal(stOff.state, 'disabled');
    assert.equal(stOff.active, false);
    assert.equal(rpcCalls.length, 3);
    assert.equal(rpcCalls[2].body.url, upstreamUrl);

    // 7. Error handling & cooldown
    failSetUrl = true;
    const stErr = await proxy.reconcile({ enabled: true, rulesByModelId: { [carbon]: 256000 } });
    assert.equal(stErr.state, 'error');
    assert.match(stErr.error, /enterprise gateway pinned/);
    assert.equal(rpcCalls.length, 4);
    await proxy.reconcile({ enabled: true, rulesByModelId: { [carbon]: 256000 } });
    assert.equal(rpcCalls.length, 4, 'cooldown skips immediate retry');
  } finally {
    failSetUrl = false;
    await proxy.stop();
    await new Promise((resolve) => upstreamServer.close(() => resolve()));
  }
  assert.ok(upstreamHits.some((u) => u.includes('fetchAvailableModels')));
  assert.ok(upstreamHits.some((u) => u.includes('streamGenerateContent')));
});

test('independent Main Agent & Subagents/Swarm switches persist, pin back main defaults, and reconcile across all 4 combos', async () => {
  // 1. Settings defaults, persistence, telemetry exposure, and factory reset
  const h = backendHarness({
    availableModels,
    userStatus: { cascadeModelConfigData: { clientModelConfigs: carbonModels } },
  });
  const initSettings = h.loadSettings();
  assert.equal(initSettings.contextWindowMainEnabled, true);
  assert.equal(initSettings.contextWindowSwarmEnabled, false);

  const patchRes = h.executeSettingsAction({
    contextWindowMainEnabled: false,
    contextWindowSwarmEnabled: true,
  });
  assert.equal(patchRes.status, 200);
  assert.equal(h.loadSettings().contextWindowMainEnabled, false);
  assert.equal(h.loadSettings().contextWindowSwarmEnabled, true);

  const tele = await h.buildTelemetryPayloadInternal('');
  assert.equal(tele.settings.contextWindowMainEnabled, false);
  assert.equal(tele.settings.contextWindowSwarmEnabled, true);
  assert.equal(tele.cloudCodeProxy.state, 'disabled');

  h.executeResetSettingsAction();
  assert.equal(h.loadSettings().contextWindowMainEnabled, true);
  assert.equal(h.loadSettings().contextWindowSwarmEnabled, false);

  // 2. syncHostContextWindows pin-back mode overrides preferences with upstream default even when csrfToken exists
  const sendPath = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';
  const host = 'https://127.0.0.1:26195';
  const nativeFetch = async (_url, init) => init;
  class WebSocket {
    constructor(url) {
      this.url = url;
    }
    send(data) {
      return data;
    }
  }
  const win = {
    location: new URL(host),
    fetch: nativeFetch,
    WebSocket,
    __APP_CONFIG__: { csrfToken: 'pin-test-token' },
  };
  const ctx = vm.createContext({
    window: win,
    URL,
    TextEncoder,
    TextDecoder,
    Headers,
    Uint8Array,
    AbortSignal,
    setTimeout,
    clearTimeout,
  });
  try {
    const syncOut = await vm.runInContext(
      createContextWindowSyncExpression(
        { [carbonGroup]: '300000' },
        'pin-boot',
        { [carbon]: 512000 },
        true,
        { [carbon]: 512000 }
      ),
      ctx
    );
    assert.deepEqual({ ...syncOut }, { attached: true, ruleCount: 1 });
    const reqPayload = {
      cascadeConfig: {
        plannerConfig: { planModel: carbon },
        checkpointConfig: {},
      },
    };
    const out = await win.fetch(host + sendPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqPayload),
    });
    assert.equal(
      JSON.parse(out.body).cascadeConfig.checkpointConfig.maxTokenLimit,
      512000,
      'pin-back mode forces main agent back to upstream default limit'
    );
  } finally {
    await vm.runInContext(createContextWindowSyncExpression({}, 'pin-boot', {}, true, null), ctx);
  }
  assert.equal(win.fetch, nativeFetch);

  // 3. Window bridge reconciles CloudCode proxy even without CDP ports when Swarm toggle is enabled
  const proxyLog = [];
  let proxyStopped = false;
  let currentSettings = {
    enableWindowOverlay: false,
    windowMountMode: 'sidebar',
    modelContextWindows: { [carbonGroup]: '300000' },
    contextWindowMainEnabled: false,
    contextWindowSwarmEnabled: true,
  };
  const mockCloudCodeProxy = {
    async reconcile(opts) {
      proxyLog.push(opts);
      return { state: opts.enabled ? 'active' : 'disabled', active: Boolean(opts.enabled) };
    },
    getUpstreamDefaults: () => ({ [carbon]: 512000 }),
    async stop() {
      proxyStopped = true;
    },
  };
  const bridgeCtrl = createWindowBridgeController({
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    readAssetFn: async () => '',
    getSettingsFn: () => currentSettings,
    env: {},
    homeDir: '/nonexistent-home-for-test',
    autoConfigureIdeArgv: false,
    cloudCodeProxy: mockCloudCodeProxy,
    resolveLocalContextRulesFn: async () => ({
      verified: true,
      rules: { [carbon]: 300000 },
      catalog: availableModels,
    }),
  });
  await bridgeCtrl.syncAllWindows();
  assert.equal(proxyLog.length, 1);
  assert.equal(proxyLog[0].enabled, true);
  assert.deepEqual(proxyLog[0].rulesByModelId, { [carbon]: 300000 });

  // Turning off Swarm switch disables CloudCode proxy
  currentSettings = { ...currentSettings, contextWindowSwarmEnabled: false };
  await bridgeCtrl.syncAllWindows();
  assert.equal(proxyLog.length, 2);
  assert.equal(proxyLog[1].enabled, false);

  await bridgeCtrl.stop();
  assert.equal(proxyStopped, true);
});

function createSelfSignedTlsFixture() {
  const derLen = (len) => {
    if (len < 0x80) return Buffer.from([len]);
    const hex = len.toString(16).padStart(len > 0xff ? 4 : 2, '0');
    const bytes = Buffer.from(hex, 'hex');
    return Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
  };
  const asn1 = (tag, body) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
  const seq = (...items) => asn1(0x30, Buffer.concat(items));
  const set = (...items) => asn1(0x31, Buffer.concat(items));

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  // ecdsa-with-SHA256 (1.2.840.10045.4.3.2)
  const sigAlg = seq(Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
  const cnAttr = seq(
    Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]),
    asn1(0x0c, Buffer.from('localhost', 'utf8'))
  );
  const name = seq(set(cnAttr));
  const validity = seq(
    asn1(0x17, Buffer.from('250101000000Z', 'ascii')),
    asn1(0x17, Buffer.from('350101000000Z', 'ascii'))
  );
  const tbs = seq(
    asn1(0xa0, Buffer.from([0x02, 0x01, 0x02])),
    asn1(0x02, Buffer.from([0x01])),
    sigAlg,
    name,
    validity,
    name,
    spkiDer
  );
  const sig = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, sigAlg, asn1(0x03, Buffer.concat([Buffer.from([0x00]), sig])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { key: keyPem, cert: certPem };
}

test('cloudcode-proxy handles socks5:// and authenticated HTTP/HTTPS proxies, enforces tunnel timeouts, and destroys upstream requests on client abort', async () => {
  // 1. Proxy URL normalization & environment detection (no http://socks5://... mangling!)
  assert.equal(normalizeCcProxyCandidateUrl('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
  assert.equal(
    normalizeCcProxyCandidateUrl('socks5h://dev:p%40ss@127.0.0.1:1080'),
    'socks5h://dev:p%40ss@127.0.0.1:1080'
  );
  assert.equal(normalizeCcProxyCandidateUrl('socks://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
  assert.equal(normalizeCcProxyCandidateUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeCcProxyCandidateUrl('https://proxy.example:8443'), 'https://proxy.example:8443');
  assert.equal(normalizeCcProxyCandidateUrl('socks4://127.0.0.1:1080'), '');
  assert.equal(normalizeCcProxyCandidateUrl('pac+http://127.0.0.1/proxy.pac'), '');

  assert.equal(
    await detectSystemHttpsProxy('daily-cloudcode-pa.googleapis.com', {
      env: { ALL_PROXY: 'socks5://127.0.0.1:1080' },
      platform: 'linux',
    }),
    'socks5://127.0.0.1:1080'
  );
  assert.equal(
    await detectSystemHttpsProxy('daily-cloudcode-pa.googleapis.com', {
      env: { ALL_PROXY: 'socks4://127.0.0.1:1080' },
      platform: 'linux',
    }),
    ''
  );
  assert.equal(shouldCcProxyBypassHost('intranet-host', 'localhost;127.*;<local>'), true);
  assert.equal(shouldCcProxyBypassHost('127.0.0.1', 'localhost;127.*;<local>'), true);
  assert.equal(shouldCcProxyBypassHost('daily-cloudcode-pa.googleapis.com', 'localhost;127.*;<local>'), false);
  assert.equal(shouldCcProxyBypassHost('daily-cloudcode-pa.googleapis.com', '*.googleapis.com'), true);
  assert.equal(shouldCcProxyBypassHost('[::1]', '[::1]:8080'), true);

  // 2. Real HTTPS upstream + pooled SOCKS5 proxy + mid-stream upstream reset + HTTP CONNECT auth + hung timeout + crash recovery
  const tlsCreds = createSelfSignedTlsFixture();
  let resolveUpstreamAborted;
  const upstreamAbortedPromise = new Promise((r) => {
    resolveUpstreamAborted = r;
  });

  const httpsUpstream = https.createServer(tlsCreds, (req, res) => {
    if (req.url?.includes('fetchAvailableModels')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: {
            'gemini-4-carbon-high': {
              model: carbon,
              maxTokens: 1048576,
              modelExperiments: {
                experiments: {
                  CASCADE_USE_EXPERIMENT_CHECKPOINTER: {
                    stringValue: JSON.stringify({ max_token_limit: '512000' }),
                  },
                },
              },
            },
          },
        })
      );
      return;
    }
    if (req.url?.includes('slowStream')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first-chunk\n');
      res.on('close', () => {
        resolveUpstreamAborted(true);
      });
      return;
    }
    if (req.url?.includes('upstreamMidStreamReset')) {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Transfer-Encoding': 'chunked' });
      res.write('partial-token-chunk\n', () => {
        setTimeout(() => {
          const rawTcp = res.socket?._parent || null;
          if (rawTcp && typeof rawTcp.resetAndDestroy === 'function') {
            rawTcp.resetAndDestroy();
          } else {
            res.socket?.destroy();
          }
        }, 15).unref();
      });
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((r) => httpsUpstream.listen(0, '127.0.0.1', r));
  const upstreamPort = httpsUpstream.address().port;
  const upstreamHttpsUrl = `https://127.0.0.1:${upstreamPort}`;

  // Minimal RFC 1928 + RFC 1929 SOCKS5 test server requiring dev:s3cr3t (supports IPv4 0x01, domain 0x03, IPv6 0x04)
  let socksConnectCount = 0;
  let lastSocksAtyp = 0;
  let lastSocksIpv6Hex = '';
  const testServerSockets = new Set();
  const trackSock = (s) => {
    testServerSockets.add(s);
    s.on('close', () => testServerSockets.delete(s));
  };
  httpsUpstream.on('connection', trackSock);
  const socksServer = net.createServer((clientSock) => {
    trackSock(clientSock);
    let stage = 0;
    clientSock.on('data', (buf) => {
      if (stage === 0) {
        assert.equal(buf[0], 0x05);
        assert.ok(buf.subarray(2, 2 + buf[1]).includes(0x02), 'client offers RFC1929 user/pass');
        stage = 1;
        clientSock.write(Buffer.from([0x05, 0x02]));
        return;
      }
      if (stage === 1) {
        const uLen = buf[1];
        const user = buf.subarray(2, 2 + uLen).toString('utf8');
        const pLen = buf[2 + uLen];
        const pass = buf.subarray(3 + uLen, 3 + uLen + pLen).toString('utf8');
        if (user !== 'dev' || pass !== 's3cr3t') {
          clientSock.end(Buffer.from([0x01, 0x01]));
          return;
        }
        stage = 2;
        clientSock.write(Buffer.from([0x01, 0x00]));
        return;
      }
      if (stage === 2) {
        stage = 3;
        socksConnectCount += 1;
        lastSocksAtyp = buf[3];
        let portOffset = 4;
        if (buf[3] === 0x01) portOffset = 8;
        else if (buf[3] === 0x03) portOffset = 5 + buf[4];
        else if (buf[3] === 0x04) {
          lastSocksIpv6Hex = buf.subarray(4, 20).toString('hex');
          portOffset = 20;
        }
        const dstPort = buf.readUInt16BE(portOffset);
        const upstreamSock = net.connect({ host: '127.0.0.1', port: dstPort }, () => {
          clientSock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          clientSock.pipe(upstreamSock);
          upstreamSock.pipe(clientSock);
        });
        trackSock(upstreamSock);
        upstreamSock.on('error', () => clientSock.destroy());
        clientSock.on('error', () => upstreamSock.destroy());
      }
    });
  });
  await new Promise((r) => socksServer.listen(0, '127.0.0.1', r));
  const socksPort = socksServer.address().port;

  // HTTP CONNECT proxy requiring Basic alice:p@ss
  let seenProxyAuth = '';
  const httpProxyServer = http.createServer();
  httpProxyServer.on('connection', trackSock);
  httpProxyServer.on('connect', (req, clientSock, head) => {
    trackSock(clientSock);
    seenProxyAuth = String(req.headers['proxy-authorization'] || '');
    const expected = `Basic ${Buffer.from('alice:p@ss', 'utf8').toString('base64')}`;
    if (seenProxyAuth !== expected) {
      clientSock.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      clientSock.destroy();
      return;
    }
    const [, rawPort] = String(req.url || '').split(':');
    const upSock = net.connect({ host: '127.0.0.1', port: Number(rawPort) }, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upSock.write(head);
      clientSock.pipe(upSock);
      upSock.pipe(clientSock);
    });
    trackSock(upSock);
    upSock.on('error', () => clientSock.destroy());
    clientSock.on('error', () => upSock.destroy());
  });
  await new Promise((r) => httpProxyServer.listen(0, '127.0.0.1', r));
  const httpProxyPort = httpProxyServer.address().port;

  // Hung proxy server that accepts TCP and never responds
  const hungSockets = new Set();
  const hungProxyServer = net.createServer((s) => {
    hungSockets.add(s);
    s.on('close', () => hungSockets.delete(s));
  });
  await new Promise((r) => hungProxyServer.listen(0, '127.0.0.1', r));
  const hungPort = hungProxyServer.address().port;

  let activeProxyUrl = `socks5://dev:s3cr3t@127.0.0.1:${socksPort}`;
  const makeProxyCtrl = (extraOpts = {}) =>
    createCloudCodeProxyController({
      allowHttpUpstream: true,
      allowTestEndpoint: true,
      tunnelTimeoutMs: 120,
      upstreamTlsOptions: { rejectUnauthorized: false },
      detectUpstreamFn: () => upstreamHttpsUrl,
      detectProxyFn: async () => activeProxyUrl,
      getEndpointFn: () => ({ addr: '127.0.0.1:44444', baseUrl: 'http://127.0.0.1:44444', csrfToken: 'tok' }),
      callRpcFn: async () => ({}),
      ...extraOpts,
    });

  const ctrlSocks = makeProxyCtrl();
  const ctrlHttpAuth = makeProxyCtrl();
  const ctrlHung = makeProxyCtrl();

  try {
    // A. SOCKS5 tunnel rewrites fetchAvailableModels over real TLS and POOLS Keep-Alive tunnel across consecutive requests
    const stSocks = await ctrlSocks.reconcile({ enabled: true, rulesByModelId: { [carbon]: 400000 } });
    const resSocks = await fetch(`${stSocks.localUrl}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      body: '{}',
    });
    const rawSocksBody = await resSocks.text();
    assert.equal(resSocks.status, 200, rawSocksBody);
    assert.equal(socksConnectCount, 1);
    const jsonSocks = JSON.parse(rawSocksBody);
    assert.equal(
      JSON.parse(
        jsonSocks.models['gemini-4-carbon-high'].modelExperiments.experiments.CASCADE_USE_EXPERIMENT_CHECKPOINTER
          .stringValue
      ).max_token_limit,
      '400000'
    );

    const resPassReuse = await fetch(`${stSocks.localUrl}/v1internal:countTokens`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(await resPassReuse.text(), 'ok');
    assert.equal(socksConnectCount, 1, 'Keep-Alive reuses warm SOCKS5 TLS tunnel without re-handshaking');

    // B. Client mid-stream abort immediately closes upstream request/socket over SOCKS5 tunnel
    await new Promise((resolve, reject) => {
      const clientReq = http.request(`${stSocks.localUrl}/v1internal:slowStream`, { method: 'POST' }, (res) => {
        res.once('data', () => {
          clientReq.destroy();
          resolve();
        });
      });
      clientReq.on('error', () => {});
      clientReq.end('{}');
      setTimeout(() => reject(new Error('Did not receive first chunk')), 2000).unref();
    });
    const abortedCleanly = await Promise.race([
      upstreamAbortedPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Upstream stream leaked after client abort')), 1500)),
    ]);
    assert.equal(abortedCleanly, true);

    // B2. Upstream mid-stream TCP reset in streaming passthrough terminates client response cleanly without unhandled error
    const resetHandled = await new Promise((resolve, reject) => {
      let seenChunk = '';
      const clientReq = http.request(
        `${stSocks.localUrl}/v1internal:upstreamMidStreamReset`,
        { method: 'POST' },
        (res) => {
          res.on('data', (c) => {
            seenChunk += c.toString('utf8');
          });
          res.on('error', () => resolve(seenChunk));
          res.on('aborted', () => resolve(seenChunk));
          res.on('close', () => resolve(seenChunk));
        }
      );
      clientReq.on('error', () => resolve(seenChunk));
      clientReq.end('{}');
      setTimeout(() => reject(new Error('Mid-stream upstream reset hung client response')), 2000).unref();
    });
    assert.match(resetHandled, /partial-token-chunk/);

    // B3. SOCKS5 IPv6 target ([::1]) encodes ATYP = 0x04 16-byte binary address
    const ipv6TlsSock = await openCcProxyTunnelSocket(
      { http, https, net, tls },
      '[::1]',
      upstreamPort,
      `socks5://dev:s3cr3t@127.0.0.1:${socksPort}`,
      { timeoutMs: 2000, tlsOptions: { rejectUnauthorized: false } }
    );
    assert.equal(lastSocksAtyp, 0x04);
    assert.equal(lastSocksIpv6Hex, '00000000000000000000000000000001');
    ipv6TlsSock.destroy();

    // C. Authenticated HTTP CONNECT proxy sends Proxy-Authorization: Basic
    activeProxyUrl = `http://alice:p%40ss@127.0.0.1:${httpProxyPort}`;
    const stHttp = await ctrlHttpAuth.reconcile({ enabled: true, rulesByModelId: { [carbon]: 320000 } });
    const resHttp = await fetch(`${stHttp.localUrl}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(resHttp.status, 200);
    assert.ok(seenProxyAuth.startsWith('Basic '), 'Proxy-Authorization header sent');

    // D. Hung proxy times out cleanly with 502 instead of hanging forever
    activeProxyUrl = `http://127.0.0.1:${hungPort}`;
    const stHung = await ctrlHung.reconcile({ enabled: true, rulesByModelId: { [carbon]: 320000 } });
    const resHung = await fetch(`${stHung.localUrl}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(resHung.status, 502);
    assert.match(await resHung.text(), /timed out/i);

    // E. Sticky localPort across reloads and automatic SetCloudCodeURL crash healing on next startup
    activeProxyUrl = '';
    let diskState = null;
    const crashRpcLog = [];
    const ctrlBeforeReload = makeProxyCtrl({
      stateFilePath: '/virtual/cloudcode-proxy-state.json',
      loadJsonFn: () => diskState,
      saveJsonFn: (_p, data) => {
        diskState = data;
      },
      callRpcFn: async (method, body) => {
        crashRpcLog.push({ method, body });
        return {};
      },
    });
    const stBefore = await ctrlBeforeReload.reconcile({ enabled: true, rulesByModelId: { [carbon]: 300000 } });
    const stickyPort = Number(new URL(stBefore.localUrl).port);
    assert.equal(diskState?.switched, true);
    assert.equal(diskState?.localPort, stickyPort);
    await ctrlBeforeReload.stop();
    assert.equal(diskState?.switched, false);
    assert.equal(diskState?.localPort, stickyPort);

    // Re-enabling in a new controller re-binds the exact same sticky port
    const ctrlAfterReload = makeProxyCtrl({
      stateFilePath: '/virtual/cloudcode-proxy-state.json',
      loadJsonFn: () => diskState,
      saveJsonFn: (_p, data) => {
        diskState = data;
      },
      callRpcFn: async (method, body) => {
        crashRpcLog.push({ method, body });
        return {};
      },
    });
    const stAfter = await ctrlAfterReload.reconcile({ enabled: true, rulesByModelId: { [carbon]: 300000 } });
    assert.equal(stAfter.localUrl, stBefore.localUrl, 'reuses sticky local port across worker reloads');
    await ctrlAfterReload.stop();

    // Simulate hard crash where previous worker left switched=true on disk, then new worker boots with Swarm disabled
    diskState = { switched: true, localPort: stickyPort, upstreamUrl: upstreamHttpsUrl, updatedAtMs: Date.now() };
    crashRpcLog.length = 0;
    const ctrlHealer = makeProxyCtrl({
      stateFilePath: '/virtual/cloudcode-proxy-state.json',
      loadJsonFn: () => diskState,
      saveJsonFn: (_p, data) => {
        diskState = data;
      },
      callRpcFn: async (method, body) => {
        crashRpcLog.push({ method, body });
        return {};
      },
    });
    await ctrlHealer.reconcile({ enabled: false, rulesByModelId: {} });
    assert.equal(crashRpcLog.length, 1);
    assert.equal(crashRpcLog[0].method, 'SetCloudCodeURL');
    assert.equal(crashRpcLog[0].body.url, upstreamHttpsUrl, 'heals orphaned Language Server CloudCode URL');
    assert.equal(diskState?.switched, false);
    await ctrlHealer.stop();
  } finally {
    await ctrlSocks.stop();
    await ctrlHttpAuth.stop();
    await ctrlHung.stop();
    httpsUpstream.closeAllConnections?.();
    httpProxyServer.closeAllConnections?.();
    for (const s of hungSockets) s.destroy();
    for (const s of testServerSockets) s.destroy();
    await Promise.all([
      new Promise((r) => httpsUpstream.close(() => r())),
      new Promise((r) => socksServer.close(() => r())),
      new Promise((r) => httpProxyServer.close(() => r())),
      new Promise((r) => hungProxyServer.close(() => r())),
    ]);
  }
});
