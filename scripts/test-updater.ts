#!/usr/bin/env node
/**
 * test-updater.ts — Simulate an available update to verify the updater UI flow.
 *
 * What it does:
 *   1. Starts a local HTTP server serving a fake latest.json (version 99.0.0)
 *   2. Temporarily swaps the updater endpoint in tauri.conf.json to localhost
 *   3. Builds the frontend and launches `cargo tauri dev`
 *   4. On exit (Ctrl+C or app close), restores the original tauri.conf.json
 *
 * Usage:
 *   node scripts/test-updater.ts          # default port 8888
 *   node scripts/test-updater.ts 9999     # custom port
 *
 * Expected result:
 *   ~5 seconds after the app window appears, the green "Version v99.0.0 is
 *   available!" banner should fade in at the top of the screen.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const PORT = parseInt(process.argv[2], 10) || 8888;
const ROOT = path.resolve(__dirname, '..');
const TAURI_CONF = path.join(ROOT, 'src-tauri', 'tauri.conf.json');

// Read and parse tauri.conf.json
const originalConf = fs.readFileSync(TAURI_CONF, 'utf8');
const conf = JSON.parse(originalConf);
const originalEndpoints = conf.plugins?.updater?.endpoints;

// Fake updater manifest — version much higher than any real release
const manifest = {
  version: '99.0.0',
  pub_date: new Date().toISOString(),
  notes: 'Test update — this is a simulated release for local testing.',
  platforms: {
    'darwin-aarch64': { signature: 'fake-sig', url: 'https://example.com/fake.tar.gz' },
    'darwin-x86_64':  { signature: 'fake-sig', url: 'https://example.com/fake.tar.gz' },
    'linux-x86_64':   { signature: 'fake-sig', url: 'https://example.com/fake.tar.gz' },
    'windows-x86_64': { signature: 'fake-sig', url: 'https://example.com/fake.tar.gz' },
  },
};

// ── Local HTTP server ──
const server = http.createServer((req, res) => {
  if (req.url === '/latest.json') {
    console.log(`  ✓ Updater fetched /latest.json (serving v${manifest.version})`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest, null, 2));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

function cleanup() {
  console.log('\n🧹 Restoring original tauri.conf.json...');
  fs.writeFileSync(TAURI_CONF, originalConf);
  server.close();
  console.log('✅ Done — tauri.conf.json restored.');
}

// Restore config on any exit
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

// ── Start ──
server.listen(PORT, () => {
  console.log(`🚀 Fake update server running on http://localhost:${PORT}/latest.json`);
  console.log(`   Serving manifest: v${manifest.version}\n`);

  // Swap the updater endpoint to our local server
  conf.plugins.updater.endpoints = [`http://localhost:${PORT}/latest.json`];
  fs.writeFileSync(TAURI_CONF, JSON.stringify(conf, null, 2) + '\n');
  console.log('📝 Patched tauri.conf.json → localhost endpoint');

  // Build frontend
  console.log('🔨 Building frontend...\n');
  try {
    execSync('npm run build:frontend', { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    console.error('❌ Frontend build failed');
    process.exit(1);
  }

  // Launch Tauri dev
  console.log('\n🎮 Launching app — watch for the update banner in ~5 seconds...\n');
  const tauri = spawn('cargo', ['tauri', 'dev'], {
    cwd: path.join(ROOT, 'src-tauri'),
    stdio: 'inherit',
  });

  tauri.on('close', (code) => {
    console.log(`\nApp exited (code ${code})`);
    process.exit(code || 0);
  });
});
