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

execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.renderer.json'], {
  cwd: root,
  stdio: 'inherit',
});

copyFile('src/index.html', 'dist');
copyFile('node_modules/phaser/dist/phaser.min.js', 'dist');

fs.cpSync(fromRoot('assets'), fromRoot('dist/assets'), { recursive: true });
copyFile('docs/img/copilot-mission-control.webp', 'dist/docs/img');
