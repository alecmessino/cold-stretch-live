// The site's settings: nothing identifies an owner, every paid slot ships switched off, and links are checked before use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SITE, dataBase, safeLink, safeMail } from '../js/site.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// js/site.js is the one file where an address belongs, so it is the one file left out.
const shipped = ['index.html', 'README.md', 'css/app.css', ...readdirSync(new URL('../js/', import.meta.url)).filter((f) => f !== 'site.js').map((f) => `js/${f}`)];

test('nothing outside the settings file names an account or an address', () => {
  for (const f of shipped) {
    const text = read(f);
    assert.doesNotMatch(text, /github\.com\/(?!<owner>)[\w-]+\/[\w-]+/, `${f} links to a named repository`);
    assert.doesNotMatch(text, /\b(?!<owner>)[\w-]+\.github\.io\//, `${f} names a github.io address`);
    assert.doesNotMatch(text, /raw\.githubusercontent\.com\/(?!<owner>|\$\{)[\w-]+\//, `${f} names a data address`);
  }
});

test('every paid or tracking slot ships switched off unless it is complete', () => {
  assert.ok(SITE.name && SITE.tagline);
  if (SITE.analytics) assert.match(SITE.analytics, /^[a-f0-9]{16,64}$/i);
  if (SITE.newsletter.action) assert.ok(safeLink(SITE.newsletter.action), 'the signup form posts over https');
  assert.equal(!!SITE.book.url, !!SITE.book.name, 'a referral link needs both a name and an address');
  if (SITE.book.url) assert.ok(safeLink(SITE.book.url));
  if (SITE.contact) assert.ok(safeMail(SITE.contact));
  if (SITE.support.url) assert.ok(safeLink(SITE.support.url));
  if (SITE.data) assert.match(SITE.data, /^https:\/\/.+\/$/);
});

test('the recorded data is found on a github.io address, a custom domain, and a local override', () => {
  const at = (hostname, pathname = '/', search = '') => ({ hostname, pathname, search });
  const off = { ...SITE, data: '' };
  assert.equal(dataBase(at('someone.github.io', '/repo/'), off), 'https://raw.githubusercontent.com/someone/repo/data/');
  assert.equal(dataBase(at('example.com'), off), 'data/');
  assert.equal(dataBase(at('example.com'), { ...SITE, data: 'https://raw.githubusercontent.com/org/repo/data' }), 'https://raw.githubusercontent.com/org/repo/data/');
  assert.equal(dataBase(at('example.com', '/', '?data=_store'), { ...SITE, data: 'https://x.test/data/' }), '_store/', 'an explicit override wins');
});

test('only https links and real-looking addresses are used', () => {
  assert.equal(safeLink('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  for (const bad of ['http://example.com', 'javascript:alert(1)', 'https://exa mple.com', 'https://example.com/"onclick', '', null]) assert.equal(safeLink(bad), '', String(bad));
  assert.equal(safeMail('hello@example.com'), 'hello@example.com');
  for (const bad of ['hello', 'a@b', 'a b@c.com', '']) assert.equal(safeMail(bad), '');
});
