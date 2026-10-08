#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const fromRoot = (...segments) => path.join(root, ...segments);

const remove = (target) => {
  fs.rmSync(fromRoot(target), { recursive: true, force: true });
};

const copyFile = (source, targetDir) => {
  const resolvedTargetDir = fromRoot(targetDir);
  fs.mkdirSync(resolvedTargetDir, { recursive: true });
  fs.copyFileSync(fromRoot(source), path.join(resolvedTargetDir, path.basename(source)));
};

remove('dist');

const typescriptPackage = require.resolve('typescript/package.json');
const tscBin = path.join(path.dirname(typescriptPackage), require(typescriptPackage).bin.tsc);

execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.renderer.json'], {
  cwd: root,
  stdio: 'inherit',
});

copyFile('src/index.html', 'dist');
copyFile('node_modules/phaser/dist/phaser.min.js', 'dist');

fs.cpSync(fromRoot('src/styles'), fromRoot('dist/styles'), { recursive: true });
fs.cpSync(fromRoot('assets'), fromRoot('dist/assets'), { recursive: true });
copyFile('docs/img/agent-mission-control.webp', 'dist/docs/img');
