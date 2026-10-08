#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.docs-dist');

const typescriptPackage = require.resolve('typescript/package.json');
const tscBin = path.join(path.dirname(typescriptPackage), require(typescriptPackage).bin.tsc);

fs.rmSync(outDir, { recursive: true, force: true });
execFileSync(process.execPath, [
  tscBin,
  path.join(root, 'docs', 'script.ts'),
  '--target',
  'ES2022',
  '--module',
  'preserve',
  '--rootDir',
  path.join(root, 'docs'),
  '--outDir',
  path.join(root, 'docs'),
], {
  cwd: root,
  stdio: 'inherit',
});

fs.cpSync(path.join(root, 'docs'), outDir, {
  recursive: true,
  filter: (source) => path.basename(source) !== 'script.ts',
});

console.log(`Built docs artifact at ${path.relative(root, outDir)}`);
