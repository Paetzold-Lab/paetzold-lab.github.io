/* Run with Node.js: node --test scripts/site-regression.test.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function context(overrides = {}) {
  const location = new URL('https://paetzold-lab.github.io/research.html');
  const document = {
    currentScript: { src: 'https://paetzold-lab.github.io/js/site-utils.js' },
    baseURI: location.href, addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getElementById() { return null; }
  };
  const window = { location, matchMedia: () => ({ matches: false }), history: { replaceState() {} } };
  const sandbox = vm.createContext({
    document, window, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    setInterval, clearInterval, queueMicrotask, console,
    fetch: async () => { throw Error('Unexpected network access in a test'); },
    ...overrides
  });
  for (const file of ['site-utils.js', 'main.js', 'publications.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'js', file), 'utf8'), sandbox, { filename: file });
  }
  return sandbox;
}
function run(ctx, code) { return vm.runInContext(code, ctx); }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }

for (const url of ['javascript:alert(1)', 'java\tscript:alert(1)', 'JaVa\nScript:alert(1)', 'data:text/html,test', 'vbscript:test', 'file:///etc/passwd']) {
  test(`unsafe link blocked: ${JSON.stringify(url)}`, () => assert.equal(context().safeURL(url), null));
}
test('safe relative, HTTPS and email links are retained', () => {
  const ctx = context();
  for (const url of ['./images/test.png', '../research.html', 'https://doi.org/10.1/test', 'mailto:lab@example.com']) assert.equal(ctx.safeURL(url), url);
});
test('publication requests are shared by concurrent consumers', async () => {
  let calls = 0;
  const ctx = context({ fetch: async () => { calls++; return json({ publications: [{ id: 'a' }] }); } });
  const [a, b] = await Promise.all([ctx.loadPublicationData(), ctx.loadPublicationData()]);
  assert.equal(calls, 1); assert.equal(a, b);
});
test('failed publication requests can be retried', async () => {
  let calls = 0;
  const ctx = context({ fetch: async () => ++calls === 1 ? json({}, 503) : json({ publications: [] }) });
  await assert.rejects(ctx.loadPublicationData());
  assert.equal((await ctx.loadPublicationData()).publications.length, 0);
  assert.equal(calls, 2);
});
test('malformed publication data is an error, not an empty result', async () => {
  const ctx = context({ fetch: async () => json({ publications: 'unavailable' }) });
  await assert.rejects(ctx.loadPublicationData(), /Invalid publication data/);
});
test('requests abort after the configured deadline', async () => {
  const ctx = context({ fetch: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')))) });
  await assert.rejects(ctx.fetchJSONWithTimeout('/slow', {}, 5), /aborted/);
});
const validContact = { name: 'Website visitor', email: 'visitor@example.org', message: 'I would like to learn more about the lab.' };
test('valid contact fields pass validation', () => assert.equal(context().validateContactData(validContact), null));
for (const [label, patch, field] of [
  ['empty name', { name: '' }, 'name'], ['invalid email', { email: 'a@b' }, 'email'],
  ['short message', { message: 'Hi' }, 'message'], ['long message', { message: 'x'.repeat(4001) }, 'message'],
  ['link spam', { message: 'https://x '.repeat(5) }, 'message']
]) test(`contact validation rejects ${label}`, () => assert.equal(context().validateContactData({ ...validContact, ...patch }).field, field));
test('contact success requires a readable positive server acknowledgement', async () => {
  let request;
  const ctx = context({ fetch: async (url, options) => { request = options; return json({ ok: true }); } });
  await ctx.sendContactMessage(validContact);
  assert.equal(request.mode, 'cors');
  assert.equal(request.headers['Content-Type'], 'text/plain;charset=UTF-8');
  assert.deepEqual(JSON.parse(request.body), validContact);
});
for (const [label, response] of [
  ['server rejection', () => json({ ok: false })], ['missing acknowledgement', () => json({})],
  ['HTTP failure', () => json({}, 500)], ['opaque response', () => ({ ok: false, status: 0 })],
  ['invalid JSON', () => new Response('not JSON')]
]) test(`contact form must not report success for ${label}`, async () => {
  const ctx = context({ fetch: async () => response() });
  await assert.rejects(ctx.sendContactMessage(validContact));
});
const records = [
  { id: 'li', title: 'Alpha imaging', year: 2026, authors: 'C. Li, J. Paetzold', source_members: ['Chenjun Li'], categories: ['mri'], promotion_rank: 2, citations: 3 },
  { id: 'liu', title: 'Beta imaging', year: 2025, authors: 'C. Liu, Another Author', source_members: [], categories: ['ct'], promotion_rank: null, citations: 1 },
  { id: 'full', title: 'Gamma learning', year: 2026, authors: 'Chenjun Li and Another Author', source_members: [], categories: ['ct'], promotion_rank: 1, citations: 2 }
];
function publicationContext() { const ctx = context({ records }); run(ctx, 'publications = records;'); return ctx; }
test('member filters match complete author names, not the start of someone else’s surname', () => {
  const ctx = publicationContext(); run(ctx, 'activeMember = "Chenjun Li";');
  assert.deepEqual(Array.from(ctx.getFilteredPublications(), p => p.id), ['full', 'li']);
});
test('publication searches trim surrounding whitespace', () => {
  const ctx = publicationContext(); run(ctx, 'searchQuery = "  alpha  ";');
  assert.deepEqual(Array.from(ctx.getFilteredPublications(), p => p.id), ['li']);
});
test('publication searches include years', () => {
  const ctx = publicationContext(); run(ctx, 'searchQuery = "2025";');
  assert.deepEqual(Array.from(ctx.getFilteredPublications(), p => p.id), ['liu']);
});
test('member and topic filters combine', () => {
  const ctx = publicationContext(); run(ctx, 'activeFilter = "mri"; activeMember = "Chenjun Li";');
  assert.deepEqual(Array.from(ctx.getFilteredPublications(), p => p.id), ['li']);
});
test('missing promotion ranks sort after assigned ranks', () => {
  const ctx = publicationContext();
  assert.deepEqual(Array.from(ctx.getFilteredPublications(), p => p.id), ['full', 'li', 'liu']);
  assert.deepEqual(records.map(p => p.id), ['li', 'liu', 'full']);
});
test('clearing filters removes legacy search parameters from reloadable URLs', () => {
  const ctx = context();
  ctx.window.location = new URL('https://paetzold-lab.github.io/research.html?search=old&q=new&member=Chenjun+Li&filter=mri');
  let updated;
  ctx.window.history.replaceState = (state, title, url) => { updated = url; };
  ctx.clearPublicationFilters();
  assert.equal(updated.search, '');
});
test('publication rendering escapes scraped citations and titles', () => {
  const ctx = context();
  const html = ctx.renderPublication({ title: '<script>bad()</script>', citations: '<img src=x>', authors: 'A Person', links: {} });
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img src=x>')); assert.ok(html.includes('&lt;img'));
});

function carouselContext() {
  class Element extends EventTarget {
    constructor() { super(); this.attrs = {}; this.style = {}; this.hidden = false; this.classList = { toggle() {} }; }
    setAttribute(k, v) { this.attrs[k] = v; }
    toggleAttribute(k, on) { if (on) this.attrs[k] = ''; else delete this.attrs[k]; }
  }
  const carousel = new Element(), wrap = new Element(), pause = new Element(), prev = new Element(), next = new Element();
  const slides = [new Element(), new Element(), new Element()];
  const dots = slides.map(() => new Element());
  const document = new Element();
  document.currentScript = { src: 'https://paetzold-lab.github.io/js/site-utils.js' };
  document.baseURI = 'https://paetzold-lab.github.io/';
  document.hidden = false; document.activeElement = null;
  document.getElementById = id => ({ 'carousel-wrapper': wrap, 'carousel-pause': pause, 'carousel-prev': prev, 'carousel-next': next })[id] || null;
  document.querySelectorAll = () => dots;
  document.querySelector = () => null;
  carousel.matches = () => carousel.hovered || false;
  carousel.contains = el => [pause, prev, next, ...dots].includes(el);
  wrap.closest = () => carousel; wrap.querySelectorAll = () => slides;
  const motion = new Element(); motion.matches = false;
  const timers = new Set();
  const ctx = context({ document, window: { location: new URL(document.baseURI), matchMedia: () => motion },
    setInterval: callback => { timers.add(callback); return callback; }, clearInterval: callback => timers.delete(callback) });
  return { ctx, carousel, wrap, pause, prev, next, document, timers };
}
test('carousel pauses on focus and manual navigation does not restart it while focused', () => {
  const state = carouselContext(); state.ctx.initializeCarousel(); assert.equal(state.timers.size, 1);
  state.document.activeElement = state.next;
  state.carousel.dispatchEvent(new Event('focusin')); assert.equal(state.timers.size, 0);
  state.next.dispatchEvent(new Event('click')); assert.equal(state.timers.size, 0);
});
test('carousel reinitialization leaves one timer and honors the explicit pause choice', () => {
  const state = carouselContext(); state.ctx.initializeCarousel(); state.ctx.initializeCarousel();
  assert.equal(state.timers.size, 1);
  state.pause.dispatchEvent(new Event('click')); assert.equal(state.timers.size, 0);
  state.ctx.initializeCarousel(); assert.equal(state.timers.size, 0);
  assert.equal(state.pause.textContent, 'Play slideshow');
});
