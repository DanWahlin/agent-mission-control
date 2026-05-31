#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.docs-dist');

fs.rmSync(outDir, { recursive: true, force: true });
fs.cpSync(path.join(root, 'docs'), outDir, {
  recursive: true,
  filter: (source) => path.basename(source) !== 'script.ts',
});

execFileSync(process.execPath, [
  require.resolve('typescript/bin/tsc'),
  path.join(root, 'docs', 'script.ts'),
  '--target',
  'ES2022',
  '--module',
  'none',
  '--outFile',
  path.join(outDir, 'script.js'),
], {
  cwd: root,
  stdio: 'inherit',
});

console.log(`Built docs artifact at ${path.relative(root, outDir)}`);
