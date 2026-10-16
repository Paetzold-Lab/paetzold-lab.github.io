const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const utils = fs.readFileSync(path.join(__dirname, '../js/site-utils.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../js/main.js'), 'utf8');
const publications = fs.readFileSync(path.join(__dirname, '../js/publications.js'), 'utf8');

function site(fetch = () => { throw Error('unexpected network call'); }) {
  const context = vm.createContext({
    URL, URLSearchParams, fetch, setTimeout, clearTimeout, AbortController,
    document: { currentScript: { src: 'https://example.org/lab/js/site-utils.js?v=test' },
      baseURI: 'https://example.org/lab/team_members_subpage/Matt.html', addEventListener() {} },
    window: { location: { href: 'https://example.org/lab/team_members_subpage/Matt.html' } }
  });
  vm.runInContext(utils, context);
  return context;
}

test('nested pages resolve assets at the site root and version only local images', () => {
  const c = site();
  assert.equal(c.siteAssetPath('./images/example.png'), 'https://example.org/lab/images/example.png');
  assert.match(c.versionedImage('./images/example.png'), /\/lab\/images\/example.png\?v=/);
  assert.equal(c.versionedImage('https://example.org/image.png'), 'https://example.org/image.png');
});

test('URL validation rejects executable, obfuscated, and malformed schemes', () => {
  const c = site();
  for (const link of ['javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,hi', 'vbscript:x', 'file:///etc/passwd', 'blob:https://example.org/a', 'https://[broken']) {
    assert.equal(c.safeURL(link), null, link);
  }
  for (const link of ['https://example.org/', '../research.html?q=paper', 'mailto:lab@example.org', '//example.org/paper']) {
    assert.equal(c.safeURL(link), link);
  }
});

test('simultaneous publication consumers share one fetch', async () => {
  let calls = 0;
  const c = site(async () => { calls++; return { ok: true, json: async () => ({ publications: [{ title: 'Paper' }], categories: { test: 'Test' } }) }; });
  const [a, b] = await Promise.all([c.loadPublicationData(), c.loadPublicationData()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(c.categoryLabel('test'), 'Test');
});

test('publication fetch failures can be retried', async () => {
  let calls = 0;
  const c = site(async () => ++calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ publications: [] }) });
  await assert.rejects(c.loadPublicationData(), /503/);
  assert.equal((await c.loadPublicationData()).publications.length, 0);
  assert.equal(calls, 2);
});

test('malformed publication responses fail clearly', async () => {
  for (const data of [null, {}, { publications: {} }, { publications: [null] }, { publications: [{ title: 'Paper' }], categories: [] }]) {
    const c = site(async () => ({ ok: true, json: async () => data }));
    await assert.rejects(c.loadPublicationData(), /Invalid publication/);
  }
});

test('search highlighting escapes attacker markup and regular expression syntax', () => {
  const c = site();
  vm.runInContext(main, c);
  assert.equal(c.highlightTerm('<script>[x]</script>', '[x]'), '&lt;script&gt;<span class="highlight">[x]</span>&lt;/script&gt;');
});

test('member filters match whole author names rather than substrings', () => {
  const c = site();
  vm.runInContext(publications, c);
  vm.runInContext(`publications = [
    { title: 'Unrelated', authors: 'Eric Li', year: 2026 },
    { title: 'Lab work', authors: 'C Li, Other Author', year: 2026 },
    { title: 'Credited work', authors: '', source_members: ['Chenjun Li'], year: 2026 }
  ]; activeMember = 'Chenjun Li';`, c);
  assert.deepEqual(Array.from(c.getFilteredPublications(), p => p.title).sort(), ['Credited work', 'Lab work']);
});

test('empty priority ranks do not outrank curated publications', () => {
  const c = site();
  vm.runInContext(publications, c);
  const sorted = c.sortPublications([
    { title: 'Missing', promotion_rank: null, year: 2026 },
    { title: 'Empty', promotion_rank: '', year: 2026 },
    { title: 'Curated', promotion_rank: 1, year: 2025 }
  ]);
  assert.equal(sorted[0].title, 'Curated');
});

test('contact validation rejects recipient lists and uppercase link spam before sending', () => {
  const c = site();
  vm.runInContext(main, c);
  const data = { name: 'Visitor', email: 'visitor@example.org', message: 'A legitimate lab inquiry.' };
  assert.equal(c.validateContactData(data), null);
  assert.equal(c.validateContactData({ ...data, email: 'a@example.org,b@example.org' }).field, 'email');
  assert.equal(c.validateContactData({ ...data, email: 'a@b.org?subject=spam' }).field, 'email');
  assert.equal(c.validateContactData({ ...data, message: 'HTTPS://x.org '.repeat(5) }).field, 'message');
});
