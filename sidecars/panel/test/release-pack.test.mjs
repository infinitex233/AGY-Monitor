import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_REPO_ROOT,
  collectReleaseRuntimeFiles,
  packReleaseZip,
} from '../scripts/pack-release-zip.mjs';

test('pack-release-zip ships only runtime-essential files, excludes dev bloat, and extracts a self-contained runnable plugin', async (t) => {
  const relFiles = collectReleaseRuntimeFiles(DEFAULT_REPO_ROOT);

  // Required runtime files exist in whitelist
  for (const mustHave of [
    'plugin.json',
    'assets/logo.svg',
    'mcp_config.json',
    'pricing-catalog.json',
    'LICENSE',
    'sidecars/panel/sidecar.json',
    'sidecars/panel/index.html',
    'sidecars/panel/app.js',
    'sidecars/panel/styles.css',
    'sidecars/panel/main.mjs',
    'sidecars/panel/mcp-entry.mjs',
    'sidecars/panel/bridge-daemon.mjs',
    'sidecars/panel/standalone.mjs',
    'sidecars/panel/cli-statusline.mjs',
    'sidecars/panel/trajectory-metrics.mjs',
    'sidecars/panel/backend/api-actions.mjs',
    'sidecars/panel/shared/settings-normalization.mjs',
  ]) {
    assert.ok(relFiles.includes(mustHave), `Release whitelist must include ${mustHave}`);
  }

  // Non-runtime dev/doc/test/preview files and removed dead/sensitive modules must NEVER enter the release ZIP
  for (const rel of relFiles) {
    assert.doesNotMatch(rel, /^host-i18n\//);
    assert.doesNotMatch(rel, /^sidecars\/panel\/backend\/host-i18n\//);
    assert.doesNotMatch(rel, /account-.*\.mjs$|account-credentials\.ps1$/i);
    assert.doesNotMatch(rel, /(?:quota-reservation|session-migrator)\.mjs$/);
    assert.doesNotMatch(rel, /^sidecars\/panel\/(?:src|test|scripts)\//);
    assert.doesNotMatch(rel, /\.png$/i);
    assert.doesNotMatch(rel, /^README/i);
    assert.doesNotMatch(rel, /^\.gitignore$/);
    assert.doesNotMatch(rel, /(?:^|\/)(?:\.git|\.data|node_modules|plan|dist)(?:\/|$)/);
  }
  assert.equal(relFiles.includes('sidecars/panel/package.json'), false);
  assert.equal(relFiles.includes('sidecars/panel/backend/cloudcode-proxy.mjs'), false);
  assert.equal(relFiles.includes('sidecars/panel/backend/context-windows.mjs'), false);

  const workDir = mkdtempSync(join(tmpdir(), 'ag-um-pack-test-'));
  t.after(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup error
    }
  });

  const zipPath = join(workDir, 'agy-monitor.zip');
  const extractDir = join(workDir, 'extracted');
  const summary = packReleaseZip({ repoRoot: DEFAULT_REPO_ROOT, outFile: zipPath });

  assert.ok(existsSync(zipPath));
  const zipBuf = readFileSync(zipPath);
  assert.ok(
    zipBuf.includes(Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01])),
    'ZIP entries must include Info-ZIP 0x5455 UTC extended timestamps'
  );
  assert.ok(summary.zipBytes > 100 * 1024, 'ZIP should contain compiled assets and backend');
  assert.ok(
    summary.zipBytes < 900 * 1024,
    `Runtime-only ZIP should stay compact (<900 KB), got ${(summary.zipBytes / 1024).toFixed(1)} KB`
  );

  // Extract via OS-native expander (same path used by plugin-updater.mjs, where extractDir already exists)
  mkdirSync(extractDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`,
      ],
      { stdio: 'pipe', windowsHide: true }
    );
  } else {
    execFileSync('unzip', ['-oq', zipPath, '-d', extractDir], { stdio: 'pipe' });
  }

  const pluginRoot = join(extractDir, 'agy-monitor');
  assert.ok(existsSync(join(pluginRoot, 'plugin.json')));
  assert.ok(existsSync(join(pluginRoot, 'assets', 'logo.svg')));
  const sourceManifest = JSON.parse(readFileSync(join(DEFAULT_REPO_ROOT, 'plugin.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agy-monitor');
  assert.equal(manifest.displayName, 'AGY Monitor');
  assert.equal(manifest.logo, 'assets/logo.svg');
  assert.equal(manifest.version, sourceManifest.version);

  assert.equal(relFiles.includes('sidecars/panel/backend/quota-pools.mjs'), false);

  // Verify zero broken syntax and clean standalone ESM load from the extracted clean tree (no src/, test/, package.json)
  for (const rel of relFiles) {
    if (rel.endsWith('.mjs') || rel === 'sidecars/panel/app.js') {
      execFileSync(process.execPath, ['--check', join(pluginRoot, rel)], { stdio: 'pipe' });
    }
  }

  const apiMod = await import(pathToFileURL(join(pluginRoot, 'sidecars/panel/backend/api-actions.mjs')).href);
  assert.equal(typeof apiMod.executeTelemetryAction, 'function');
  const cliMod = await import(pathToFileURL(join(pluginRoot, 'sidecars/panel/cli-statusline.mjs')).href);
  assert.equal(typeof cliMod.runCliStatusLineMain, 'function');
});
