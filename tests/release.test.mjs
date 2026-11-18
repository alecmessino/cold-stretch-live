// One release number on every local file. A page that pairs one release's HTML with another's scripts does not start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const scripts = readdirSync(new URL('../js/', import.meta.url)).filter((f) => f.endsWith('.js'));

test('the page and every module import carry the same release number', () => {
  const refs = [...html.matchAll(/(?:href|src)="((?:css|js)\/[^"]+)"/g)].map((m) => m[1]);
  for (const f of scripts) for (const m of read(`js/${f}`).matchAll(/from '(\.\/[^']+)'/g)) refs.push(m[1]);
  refs.push(/getJSON\('(model\.json[^']*)'\)/.exec(read('js/app.js'))[1]);
  assert.ok(refs.length >= 6, `found ${refs.length} references`);
  const versions = new Set(refs.map((r) => { const v = /\?v=(\w+)$/.exec(r); assert.ok(v, `${r} has no release number`); return v[1]; }));
  assert.equal(versions.size, 1, `release numbers disagree: ${[...versions].join(', ')}`);
});

test('every module the page imports exists', () => {
  for (const f of scripts) for (const m of read(`js/${f}`).matchAll(/from '\.\/([^'?]+)/g)) assert.ok(scripts.includes(m[1]), `${f} imports ${m[1]}`);
});
