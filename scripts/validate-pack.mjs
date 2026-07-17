import { execFileSync } from 'node:child_process';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const tarball = process.argv[2];
if (!tarball) fail('Usage: node scripts/validate-pack.mjs <tarball.tgz>');

const listOutput = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' });
const entries = new Set(
  listOutput
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean),
);

const packageJsonText = execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' });
const manifest = JSON.parse(packageJsonText);

const declaredEntries = [];

if (typeof manifest.main === 'string' && manifest.main.trim()) {
  declaredEntries.push({ label: 'main', path: manifest.main.trim() });
}

const openclawExtensions = manifest?.openclaw?.extensions;
if (Array.isArray(openclawExtensions)) {
  for (const extensionPath of openclawExtensions) {
    if (typeof extensionPath === 'string' && extensionPath.trim()) {
      declaredEntries.push({ label: 'openclaw.extensions', path: extensionPath.trim() });
    }
  }
}

for (const entry of declaredEntries) {
  const normalized = entry.path.replace(/^\.\//, '');
  const tarPath = `package/${normalized}`;
  if (!entries.has(tarPath)) {
    fail(
      `Packed tarball is missing declared ${entry.label} entry "${entry.path}" from package.json (${tarPath})`,
    );
  }
}

console.log(`Validated packed artifact ${tarball}`);
