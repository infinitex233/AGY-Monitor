import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const tempRoot = mkdtempSync(join(tmpdir(), 'agy-acp-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

const home = join(tempRoot, 'home');
const geminiDir = join(tempRoot, 'gemini');
const t3UserDataDir = join(home, '.t3', 'userdata');
const providersDir = join(t3UserDataDir, 'providers', 'antigravity');
const acpRoot = join(geminiDir, 'antigravity-acp');
const firstProviderRoot = join(providersDir, 'first', 'antigravity-acp');
const secondProviderRoot = join(providersDir, 'second', 'antigravity-acp');
const secondProviderCliRoot = join(providersDir, 'second', 'antigravity-cli');
const customRoot = join(tempRoot, 'custom');
for (const root of [acpRoot, firstProviderRoot, secondProviderRoot, secondProviderCliRoot]) {
  mkdirSync(root, { recursive: true });
}
writeFileSync(join(providersDir, 'first', 'antigravity-cli'), '');

Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  ANTIGRAVITY_GEMINI_DIR: geminiDir,
  T3_USERDATA_DIR: t3UserDataDir,
  USAGE_MONITOR_APP_DATA_DIR: customRoot,
  USAGE_MONITOR_DATA_DIR: join(tempRoot, 'monitor-data'),
  ANTIGRAVITY_LS_ADDRESS: 'test.invalid',
  ANTIGRAVITY_CSRF_TOKEN: 'test',
});

const config = await import('../backend/config.mjs');
const {
  getNodeSqliteDatabaseSync,
  readAnnotationTitleForCascade,
  readLocalSummaryIndex,
  readLocalSummarySnapshot,
} = await import('../backend/cli-sqlite-reader.mjs');
const { enumerateAndSyncConversations } = await import('../backend/local-scanner.mjs');
const { discoverAntigravityLsEndpoint } = await import('../backend/ls-discovery.mjs');

test('discovers ACP roots and refreshes the paths after the TTL, force, and cache clear', (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const initialRoots = [
    customRoot,
    ...['antigravity', 'antigravity-cli', 'antigravity-acp', 'antigravity-ide', 'antigravity-idea']
      .map((name) => join(geminiDir, name)),
    firstProviderRoot,
    secondProviderRoot,
    secondProviderCliRoot,
  ];
  assert.deepEqual(config.PRODUCT_DATA_ROOTS, initialRoots);
  assert.deepEqual(config.getProductDataRoots({ force: true }), initialRoots);

  const newRoot = join(providersDir, 'new', 'antigravity-acp');
  mkdirSync(newRoot, { recursive: true });
  assert.deepEqual(config.getProductDataRoots(), initialRoots);
  now += 5001;
  assert.ok(config.getConversationDirs().includes(join(newRoot, 'conversations')));
  assert.ok(config.getBrainDirs().includes(join(newRoot, 'brain')));
  assert.ok(config.getAnnotationDirs().includes(join(newRoot, 'annotations')));
  assert.ok(config.getDaemonDirs().includes(join(newRoot, 'daemon')));
  assert.ok(config.getDeepStatsCacheCandidates().includes(join(newRoot, 'brain', '.deep_stats_cache.json')));

  const laterRoot = join(providersDir, 'later', 'antigravity-acp');
  mkdirSync(laterRoot, { recursive: true });
  assert.ok(!config.getProductDataRoots().includes(laterRoot));
  assert.ok(config.getProductDataRoots({ force: true }).includes(laterRoot));

  const clearedRoot = join(providersDir, 'cleared', 'antigravity-acp');
  mkdirSync(clearedRoot, { recursive: true });
  assert.ok(config.clearRuntimeCaches());
  assert.ok(config.getProductDataRoots().includes(clearedRoot));
});

test('a Gemini directory override disables discovery of the default T3 user data directory', (t) => {
  t.after(() => {
    process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
    process.env.T3_USERDATA_DIR = t3UserDataDir;
    config.getProductDataRoots({ force: true });
  });
  delete process.env.T3_USERDATA_DIR;
  assert.ok(!config.getProductDataRoots({ force: true }).includes(firstProviderRoot));
  process.env.ANTIGRAVITY_GEMINI_DIR = '   ';
  assert.ok(config.getProductDataRoots({ force: true }).includes(firstProviderRoot));
  delete process.env.ANTIGRAVITY_GEMINI_DIR;
  assert.ok(config.getProductDataRoots({ force: true }).includes(firstProviderRoot));
});

function writeSummaryDb(DatabaseSync, root, rows) {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, 'conversation_summaries.db'));
  try {
    db.exec(`CREATE TABLE conversation_summaries (
      conversation_id TEXT, title TEXT, status TEXT, parent_conversation_id TEXT, agent_name TEXT,
      not_fully_idle INTEGER, killed INTEGER, step_count INTEGER, last_modified_time TEXT, app_data_dir TEXT
    )`);
    const insert = db.prepare(`INSERT INTO conversation_summaries
      (conversation_id, title, step_count, last_modified_time, app_data_dir) VALUES (?, ?, ?, ?, ?)`);
    for (const row of rows) insert.run(...row);
  } finally {
    db.close();
  }
}

test('ACP summaries merge by conversation ID and prefer native rows over newer copies', (t) => {
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return t.skip('node:sqlite is unavailable');

  const nativeTime = '2026-11-26T10:00:00Z';
  const copiedTime = '2026-11-26T11:00:00Z';
  writeSummaryDb(DatabaseSync, join(geminiDir, 'antigravity'), [
    ['desktop', 'Native desktop', 2, nativeTime, 'antigravity'],
    ['acp', 'Copied ACP', 10, copiedTime, 'antigravity-acp'],
  ]);
  writeSummaryDb(DatabaseSync, acpRoot, [
    ['desktop', 'Copied desktop', 8, copiedTime, 'antigravity'],
    ['acp', 'Native ACP', 3, nativeTime, 'antigravity-acp'],
  ]);
  const snapshot = readLocalSummarySnapshot();
  assert.equal(snapshot.byId.size, 2);
  assert.equal(Object.keys(snapshot.summariesObj).length, 2);
  for (const [id, title, stepCount] of [['desktop', 'Native desktop', 2], ['acp', 'Native ACP', 3]]) {
    assert.equal(snapshot.byId.get(id).isNativeRootRow, true);
    assert.equal(snapshot.byId.get(id).title, title);
    assert.equal(snapshot.summariesObj[id].annotations.title, title);
    assert.equal(snapshot.summariesObj[id].stepCount, stepCount);
  }

  const newRoot = join(providersDir, 'summary', 'antigravity-acp');
  mkdirSync(newRoot, { recursive: true });
  config.getProductDataRoots({ force: true });
  const refreshed = readLocalSummarySnapshot();
  assert.equal(refreshed.sig, snapshot.sig);
  assert.notEqual(refreshed.byId, snapshot.byId);

  writeSummaryDb(DatabaseSync, newRoot, [['t3', 'New T3 session', 1, nativeTime, 'antigravity-acp']]);
  const updated = readLocalSummaryIndex();
  assert.equal(updated.size, 3);
  assert.equal(updated.get('t3').title, 'New T3 session');
});

test('classifies ACP paths and ACP summary rows as CLI sessions', async (t) => {
  const cascadeId = '278a0174-296c-45a9-bc6c-62ce7bdd82c4';
  const summaryId = '8c5ca325-0e2b-4e68-bb16-ae04f457770f';
  const root = join(providersDir, 'session', 'antigravity-acp');
  const logDir = join(root, 'brain', cascadeId, '.system_generated', 'logs');
  const annotationDir = join(root, 'annotations');
  mkdirSync(logDir, { recursive: true });
  mkdirSync(annotationDir, { recursive: true });
  writeFileSync(join(annotationDir, `${cascadeId}.pbtxt`), 'title:"T3 session"\n');
  writeFileSync(join(logDir, 'transcript.jsonl'), JSON.stringify({
    type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-26T10:00:00Z',
    model: 'gemini-4-hydrogen-medium', input_tokens: 10, output_tokens: 5,
  }));
  const deepStatsDir = join(geminiDir, 'antigravity-ide', 'brain');
  mkdirSync(deepStatsDir, { recursive: true });
  writeFileSync(join(deepStatsDir, '.deep_stats_cache.json'), JSON.stringify({
    perConvo: {
      [cascadeId]: {
        entries: [{ ts: '2026-11-26T10:00:00Z', model: 'gemini-4-hydrogen-medium', inp: 10, out: 5 }],
      },
    },
  }));

  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Language Server address unavailable');
  });
  const { conversations } = await enumerateAndSyncConversations({
    summariesObj: { [summaryId]: { appDataDir: 'antigravity-acp' } },
    summariesFromLocalDb: true,
    requestedConvId: cascadeId,
    forceRefresh: true,
  });
  assert.equal(readAnnotationTitleForCascade(cascadeId), 'T3 session');
  assert.equal(conversations.find((conversation) => conversation.cascadeId === cascadeId).appSource, 'cli');
  assert.equal(conversations.find((conversation) => conversation.cascadeId === summaryId).appSource, 'cli');
  assert.equal(config.getCachedTrajectory(cascadeId).appSource, 'cli');
  assert.equal(config.getCachedTrajectory(cascadeId).steps[0].inputTokens, 10);
});

test('skips memoizing partial summary snapshots and refreshes daemon dirs on forced discovery', async (t) => {
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (DatabaseSync) {
    const partialA = join(tempRoot, 'partial-a');
    const partialB = join(tempRoot, 'partial-b');
    writeSummaryDb(DatabaseSync, partialA, [['conv-a', 'Desktop A', 1, '2026-11-26T10:00:00Z', 'partial-a']]);
    mkdirSync(partialB, { recursive: true });
    writeFileSync(join(partialB, 'conversation_summaries.db'), 'not-a-sqlite-db');

    const first = readLocalSummarySnapshot([partialA, partialB]);
    assert.equal(first.available, true);
    assert.equal(first.byId.size, 1);
    assert.equal(config.localSummaryMemo.byRootsKey.has(JSON.stringify([partialA, partialB])), false);

    rmSync(join(partialB, 'conversation_summaries.db'));
    writeSummaryDb(DatabaseSync, partialB, [['conv-b', 'ACP B', 2, '2026-11-26T10:01:00Z', 'partial-b']]);
    const second = readLocalSummarySnapshot([partialA, partialB]);
    assert.equal(second.byId.size, 2);
    assert.equal(second.byId.get('conv-b').title, 'ACP B');
    assert.equal(config.localSummaryMemo.byRootsKey.has(JSON.stringify([partialA, partialB])), true);
  }

  const daemonRoot = join(providersDir, 'forced-daemon', 'antigravity-acp', 'daemon');
  mkdirSync(daemonRoot, { recursive: true });
  writeFileSync(join(daemonRoot, 'hub_55123.json'), JSON.stringify({
    pid: process.pid,
    httpPort: 55123,
    csrfToken: 'forced-csrf',
  }));
  const found = await discoverAntigravityLsEndpoint({
    force: true,
    fetchFn: async (url) => ({ ok: String(url).includes(':55123/') }),
  });
  assert.equal(found?.csrfToken, 'forced-csrf');
  assert.equal(found?.addr, '127.0.0.1:55123');
});
