const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../src/catalog-core.js');

const fixture = (name, overrides = {}) => ({
  name, url: `https://github.com/${name}`, track: 'skills', stars: 10,
  category: 'coding', gain_7d: 0,
  summary: '代码审查与设计', summary_en: 'Code review and design', description: '',
  created_at: '2026-01-01', first_seen: '2026-10-26', last_refreshed: '2026-10-28',
  ...overrides
});

test('display normalization removes middle dots and decodes exactly one safe text layer', () => {
  assert.equal(Core.normalizeText('  A\u00b7B &amp; C &middot; D &#183; E &#xB7; F\n'), 'A B & C D E F');
  assert.equal(Core.normalizeText('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
  assert.equal(Core.normalizeText('&lt;script&gt;alert(1)&lt;/script&gt;'), '<script>alert(1)</script>');
  assert.equal(Core.normalizeText('&#0; &#xD800; &#x110000; &unknown;'), '&#0; &#xD800; &#x110000; &unknown;');
  assert.equal(Core.normalizeText(null), '');
});

test('preparation is immutable and falls back only to available source text', () => {
  const raw = [fixture('org/one', { summary: '', description: 'Existing description', stars: '5' }),
    fixture('org/two', { summary: '', description: '', summary_en: 'English source' }),
    fixture('org/three', { summary: '', description: '', summary_en: '', stars: -2 })];
  const before = JSON.stringify(raw);
  const rows = Core.prepareRecords(raw);
  assert.equal(rows[0].summary, 'Existing description');
  assert.equal(rows[0].stars, 5);
  assert.equal(rows[1].summary, 'English source');
  assert.equal(rows[2].summary, '');
  assert.equal(rows[2].stars, 0);
  assert.equal(JSON.stringify(raw), before);
  assert.throws(() => Core.prepareRecords({}), /array/);
  assert.throws(() => Core.prepareRecords([fixture('org/x', { track: 'unknown' })]), /category/);
});

test('search covers names and both source languages using NFKC and AND terms', () => {
  const rows = Core.prepareRecords([fixture('Org/Skills', { summary: '设计工具', summary_en: 'Code Review suite' }),
    fixture('org/other', { summary: '代码审查', summary_en: 'Review only' })]);
  assert.equal(Core.searchRecords(rows, 'ＳＫＩＬＬＳ review')[0].name, 'Org/Skills');
  assert.equal(Core.searchRecords(rows, '设计 code').length, 1);
  assert.equal(Core.searchRecords(rows, 'review missing').length, 0);
  assert.equal(Core.searchRecords(rows, 'ORG/SKILLS').length, 1);
  assert.equal(Core.searchRecords(rows, '<script>').length, 0);
  assert.equal(Core.searchRecords(rows, '   ').length, 2);
  assert.notEqual(Core.searchRecords(rows, ''), rows);
});

test('sorting is deterministic, keeps missing/invalid dates last, and never mutates input', () => {
  const rows = [fixture('org/z', { stars: 100, created_at: '' }),
    fixture('org/b', { stars: 20, created_at: '2026-02-01' }),
    fixture('org/a', { stars: 20, created_at: '2026-02-01' }),
    fixture('org/c', { stars: 10, created_at: '2026-03-01' }),
    fixture('org/invalid', { stars: 200, created_at: '2026-02-30' })];
  const before = JSON.stringify(rows);
  assert.deepEqual(Core.sortRecords(rows, 'created').map(r => r.name), ['org/c', 'org/a', 'org/b', 'org/invalid', 'org/z']);
  assert.deepEqual(Core.sortRecords(rows, 'seen').map(r => r.name), ['org/invalid', 'org/z', 'org/a', 'org/b', 'org/c']);
  assert.deepEqual(Core.sortRecords(rows, 'stars').map(r => r.name), ['org/invalid', 'org/z', 'org/a', 'org/b', 'org/c']);
  assert.equal(JSON.stringify(rows), before);
});

test('repository links reject credentials, protocols, redirects, path tricks and name mismatches', () => {
  assert.equal(Core.safeRepoUrl(fixture('Org/repo')), 'https://github.com/Org/repo');
  assert.equal(Core.safeRepoUrl(fixture('Org/repo', { url: 'https://github.com/org/REPO' })), 'https://github.com/Org/repo');
  for (const url of [
    'javascript:alert(1)', 'http://github.com/Org/repo', 'https://evil.test/Org/repo',
    'https://github.com.evil.test/Org/repo', 'https://user:pass@github.com/Org/repo',
    'https://github.com/Org/repo?redirect=evil', 'https://github.com/Org/repo#readme',
    'https://github.com/Org/other', 'https://github.com/Org/%72epo',
    'https://github.com/Org/../repo', 'https://github.com/Org/repo/',
    'https://github.com/Org/repo\n', ' https://github.com/Org/repo', 'https://github.com:443/Org/repo'
  ]) assert.equal(Core.safeRepoUrl(fixture('Org/repo', { url })), null, url);
  assert.equal(Core.safeRepoUrl(fixture('Org/..')), null);
});

test('category filtering keeps unknown values in other and rejects bad URL values', () => {
  const rows = Core.prepareRecords([
    fixture('org/a', { category: 'design' }),
    fixture('org/b', { category: 'bogus' }),
    fixture('org/c', {}),
  ]);
  const prepared = Core.prepareRecords([fixture('org/c', {})]);
  assert.equal(prepared[0].category, 'coding');
  assert.equal(rows[0].category, 'design');
  assert.equal(rows[1].category, 'other');
  assert.equal(Core.filterByCategory(rows, 'all').length, 3);
  assert.equal(Core.filterByCategory(rows, 'design').length, 1);
  assert.equal(Core.filterByCategory(rows, 'design')[0].name, 'org/a');
  assert.equal(Core.filterByCategory(rows, 'bogus').length, 3);
  assert.equal(Core.filterByCategory(rows, '').length, 3);
  assert.notEqual(Core.filterByCategory(rows, 'design'), rows);
});

test('gain7 sorting ranks by 7-day growth then stars then name', () => {
  const rows = Core.prepareRecords([
    fixture('org/low', { stars: 500, gain_7d: 10 }),
    fixture('org/high', { stars: 100, gain_7d: 900 }),
    fixture('org/tie-b', { stars: 50, gain_7d: 900 }),
    fixture('org/tie-a', { stars: 50, gain_7d: 900 }),
    fixture('org/zero', { stars: 999, gain_7d: 0 }),
    fixture('org/neg', { stars: 10, gain_7d: -5 }),
    fixture('org/nan', { stars: 10, gain_7d: 'bogus' }),
  ]);
  assert.deepEqual(Core.sortRecords(rows, 'gain7').map(r => r.name),
    ['org/high', 'org/tie-a', 'org/tie-b', 'org/low', 'org/zero', 'org/nan', 'org/neg']);
  assert.equal(Core.prepareRecords([fixture('org/x', {})])[0].gain_7d, 0);
});

test('URL state roundtrips and rejects invalid categories, dates, pages and oversized queries', () => {
  const state = { q: '代码 review & design', track: 'ai', sort: 'gain7', category: 'media', pages: { skills: 2, ai: 3 } };
  assert.deepEqual(Core.readState(Core.stateQuery(state)), state);
  assert.equal(Core.stateQuery(Core.readState('?utm_source=test')), '');
  assert.deepEqual(Core.readState('?track=bad&sort=bad&category=bad&skillsPage=-1&aiPage=Infinity'), {
    q: '', track: 'all', sort: 'stars', category: 'all', pages: { skills: 1, ai: 1 }
  });
  for (const invalid of ['0', '1.5', '01', '1e3', '9007199254740992']) {
    assert.equal(Core.readState('?skillsPage=' + invalid).pages.skills, 1);
  }
  const long = '😀'.repeat(201);
  assert.equal(Array.from(Core.readState('?q=' + encodeURIComponent(long)).q).length, 200);
  assert.equal(Core.stateQuery(), '');
});

test('the entire real catalog retains every repository and validates all outbound URLs', () => {
  const original = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/repos.json'), 'utf8'));
  const before = JSON.stringify(original);
  const records = Core.prepareRecords(Object.entries(original).map(([name, record]) => ({ name, ...record })));
  const groups = Core.groupRecords(records);
  assert.equal(records.length, Object.keys(original).length);
  assert.equal(groups.skills.length + groups.ai.length, records.length);
  assert.equal(records.filter(row => Core.safeRepoUrl(row)).length, records.length);
  assert.ok(records.every(row => Number.isInteger(row.gain_7d)));
  assert.ok(records.every(row => !row.summary.includes('\u00b7')));
  assert.equal(Core.searchRecords(records, 'morluto/rea').length, 1);
  assert.ok(Core.searchRecords(records, '需求').length > 0);
  for (const sort of ['stars', 'seen', 'created', 'gain7']) {
    const sorted = Core.sortRecords(records, sort);
    assert.equal(sorted.length, records.length);
    assert.equal(new Set(sorted.map(row => row.name)).size, records.length);
  }
  assert.equal(JSON.stringify(original), before);
});
