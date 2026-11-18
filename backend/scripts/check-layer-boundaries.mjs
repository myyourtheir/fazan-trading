// Enforces the backend layering ADR (docs/adr/0001-backend-layering.md):
// core imports only core; infra may import core and infra; api may import
// core and api. main.ts composes everything and is unrestricted, and only
// main.ts may live directly in src/. Only relative imports are checked;
// package and node: imports never cross layers.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const layerDirs = new Set(['core', 'infra', 'api']);
const allowedImports = {
  core: new Set(['core']),
  infra: new Set(['core', 'infra']),
  api: new Set(['core', 'api']),
};

const layerOf = (file) => {
  const rel = relative(srcRoot, file);
  if (rel === 'main.ts') return 'main';
  const [top] = rel.split('/');
  return layerDirs.has(top) ? top : null;
};

const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.ts')) check(full);
  }
}

function check(file) {
  const from = layerOf(file);
  if (!from) {
    violations.push(`${relative(srcRoot, file)}: only main.ts may live directly in src/`);
    return;
  }
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const spec = match[1];
    const target = resolve(dirname(file), spec);
    if (!target.startsWith(`${srcRoot}/`)) {
      violations.push(`${relative(srcRoot, file)}: relative import escapes src/ (${spec})`);
      continue;
    }
    const to = layerOf(target);
    if (to && from !== 'main' && !allowedImports[from].has(to)) {
      violations.push(`${relative(srcRoot, file)}: ${from} must not import ${to} (${spec})`);
    }
  }
}

walk(srcRoot);

if (violations.length) {
  console.error(`Layer boundary violations (${violations.length}):`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log('Layer boundaries ok.');
