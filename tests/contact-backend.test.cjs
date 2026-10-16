const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/contact-form.gs'), 'utf8');
const valid = { name: 'Test Person', email: 'test@example.org', message: 'A legitimate lab inquiry.', elapsed: 5000, page: 'https://example.org/' };

function backend({ mailFailure = false, storageFailure = false, quota = 100 } = {}) {
  let locked = false;
  let released = 0;
  const rows = [];
  const emails = [];
  const properties = new Map([['NOTIFY_EMAIL', 'owner@example.org'], ['NOTIFY_CC', 'cc@example.org']]);
  const sheet = {
    appendRow(row) { assert.ok(locked); if (storageFailure) throw Error('storage unavailable'); rows.push(row); },
    getLastRow() { assert.ok(locked); return rows.length; },
    getRange() { return { setFontWeight() {} }; },
    setFrozenRows() {}, getSheetId() { return 42; }
  };
  const book = {
    getSheetByName(name) { assert.equal(name, 'Responses'); return rows.length ? sheet : null; },
    insertSheet(name) { assert.equal(name, 'Responses'); assert.ok(locked); return sheet; },
    getUrl() { return 'https://docs.google.com/spreadsheets/d/test/edit'; },
    getSheets() { throw Error('must not fall back to unrelated tabs'); }
  };
  const context = vm.createContext({
    console: { warn() {}, error() {}, log() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => book, flush: () => assert.ok(locked) },
    LockService: { getScriptLock: () => ({
      waitLock() { assert.equal(locked, false); locked = true; },
      releaseLock() { assert.equal(locked, true); locked = false; released++; }
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) ?? null,
      setProperties(values) { assert.ok(locked); Object.entries(values).forEach(([key, value]) => properties.set(key, value)); }
    }) },
    MailApp: { getRemainingDailyQuota: () => quota, sendEmail(email) { if (mailFailure) throw Error('mail unavailable'); emails.push(email); } },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.org' }), getScriptTimeZone: () => 'UTC' },
    Utilities: { formatDate: (_date, _zone, format) => format === 'yyyyMMddHH' ? '2026101512' : '15 Oct 2026, 12:00 UTC' },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput(text) { return { setMimeType: () => JSON.parse(text) }; } }
  });
  vm.runInContext(source, context);
  return { context, rows, emails, properties, get locked() { return locked; }, get released() { return released; },
    post: body => context.doPost({ postData: { contents: JSON.stringify(body) } }) };
}

test('accepts a valid submission and sends a reply-to notification pointing to its saved row', () => {
  const b = backend();
  assert.equal(b.post(valid).ok, true);
  assert.equal(b.rows.length, 2);
  assert.equal(b.emails.length, 1);
  assert.equal(b.emails[0].replyTo, valid.email);
  assert.match(b.emails[0].body, /gid=42&range=A2/);
  assert.equal(b.properties.get('CONTACT_EMAIL_COUNT'), '2');
  assert.equal(b.locked, false);
  assert.equal(b.released, 2);
});

test('rejects malformed bodies, objects, short messages, excess links and invalid fill times before storage', () => {
  const bodies = [null, [], 'invalid', { ...valid, name: {} }, { ...valid, message: 'short' },
    { ...valid, message: 'HTTPS://x.org '.repeat(5) }, { ...valid, name: 'x'.repeat(121) },
    ...[undefined, null, -1, 0, 'NaN', 'Infinity'].map(elapsed => ({ ...valid, elapsed }))];
  for (const body of bodies) {
    const b = backend();
    assert.equal(b.post(body).ok, true); // Deliberately silent bot rejection.
    assert.equal(b.rows.length, 0, JSON.stringify(body));
    assert.equal(b.emails.length, 0);
  }
});

test('does not allow header injection or recipient lists as a sender address', () => {
  const b = backend();
  for (const email of ['one@example.org,two@example.org', 'a@example.org\r\nBcc: b@example.org', 'a@bad..org', '<a@example.org>', 'a@b.org?subject=spam']) {
    assert.equal(b.post({ ...valid, email }).ok, true);
    assert.equal(b.rows.length, 0, email);
  }
});

test('stores formula prefixes as text in every visitor-controlled column', () => {
  const b = backend();
  b.post({ ...valid, name: '=IMPORTXML("https://example.org")', email: '+tag@example.org', message: '@SUM(A1:A5) is visitor text', page: '-1+2' });
  assert.deepEqual(Array.from(b.rows[1].slice(1)), [
    '\'=IMPORTXML("https://example.org")', "'+tag@example.org", "'@SUM(A1:A5) is visitor text", "'-1+2"
  ]);
});

test('preserves saved submissions when notification delivery fails', () => {
  const b = backend({ mailFailure: true });
  assert.equal(b.post(valid).ok, true);
  assert.equal(b.rows.length, 2);
  assert.equal(b.locked, false);
});

test('reports storage failure and releases its lock without sending mail', () => {
  const b = backend({ storageFailure: true });
  assert.equal(b.post(valid).ok, false);
  assert.equal(b.locked, false);
  assert.equal(b.emails.length, 0);
});

test('hourly budget counts recipients and persists instead of relying on evictable cache', () => {
  const b = backend();
  for (let i = 0; i < 15; i++) b.post(valid);
  assert.equal(b.rows.length, 16);
  assert.equal(b.emails.length, 12);
  assert.equal(b.properties.get('CONTACT_EMAIL_COUNT'), '24');
});

test('daily quota exhaustion still saves the message', () => {
  const b = backend({ quota: 1 });
  assert.equal(b.post(valid).ok, true);
  assert.equal(b.rows.length, 2);
  assert.equal(b.emails.length, 0);
  assert.equal(b.locked, false);
});

test('notification HTML escapes visitor markup and refuses executable page links', () => {
  const b = backend();
  b.post({ ...valid, name: '<img src=x onerror=alert(1)>', message: '<script>alert(1)</script>', page: 'javascript:alert(1)' });
  const html = b.emails[0].htmlBody;
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
});

test('mailto links encode reserved characters in valid email local parts', () => {
  const b = backend();
  const email = 'lab+tag?test@example.org';
  b.post({ ...valid, email });
  assert.equal(b.emails[0].replyTo, email);
  assert.ok(b.emails[0].htmlBody.includes('mailto:' + encodeURIComponent(email)));
});
