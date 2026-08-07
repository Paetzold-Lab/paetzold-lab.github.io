/**
 * Backend for the Paetzold Lab contact form.
 *
 * The site posts JSON to this script's /exec URL (see CONTACT_ENDPOINT in js/main.js).
 * This file is the source of truth for that logic — Apps Script itself lives in the
 * owner's Google account, so keep the two in sync by hand.
 *
 * What it does:
 *   1. drops obvious bot submissions (honeypot field + submit-too-fast)
 *   2. appends the message to the spreadsheet
 *   3. emails a notification, with Reply-To set to the sender
 *
 * SETUP (one time)
 *   1. Open the sheet -> Extensions -> Apps Script, replace Code.gs with this file.
 *   2. Project Settings -> Script Properties -> add:
 *          NOTIFY_EMAIL = <primary recipient(s), comma separated>
 *          NOTIFY_CC    = <optional, also comma separated>
 *      Left unset, NOTIFY_EMAIL falls back to the account that owns the script.
 *      Keeping addresses here instead of in code keeps them out of the public repo.
 *   3. Deploy -> Manage deployments -> pencil icon on the EXISTING deployment ->
 *      Version: "New version" -> Deploy.
 *      Editing the existing deployment keeps the /exec URL that js/main.js points at.
 *      Creating a *new* deployment mints a new URL and the form silently stops working.
 *   4. Run `sendTestNotification` once from the editor and approve the Gmail scope,
 *      otherwise the first real submission fails on the unapproved permission.
 *
 * The endpoint has to be "Anyone" to work from a static site, so it is public by
 * design: anyone who reads main.js can post to it. That is why the checks below run
 * server-side too — the client-side copy only saves a round trip.
 */

const SHEET_NAME = 'Responses';     // tab to append to; created on first use
const MIN_FILL_MS = 2500;           // a human does not fill and submit faster than this
const MAX_EMAILS_PER_HOUR = 25;     // guards the daily MailApp quota during a spam burst
const LIMITS = { name: 120, email: 200, message: 4000, page: 500 };

function doPost(e) {
  try {
    const body = parseBody_(e);
    const rejection = screen_(body);
    if (rejection) {
      // Silent 200: telling a bot why it failed just helps it retry.
      console.warn('rejected submission: ' + rejection);
      return reply_({ ok: true });
    }

    const entry = {
      timestamp: new Date(),
      name: clip_(body.name, LIMITS.name),
      email: clip_(body.email, LIMITS.email),
      message: clip_(body.message, LIMITS.message),
      page: clip_(body.page, LIMITS.page)
    };

    const location = appendRow_(entry);
    notify_(entry, location);
    return reply_({ ok: true });
  } catch (err) {
    console.error(err);
    return reply_({ ok: false });
  }
}

function doGet() {
  // Deliberately returns nothing useful — this endpoint is write-only.
  return reply_({ ok: true, endpoint: 'contact', method: 'POST' });
}

/* ---------- request handling ---------- */

function parseBody_(e) {
  // The form uses fetch(mode:"no-cors"), so the Content-Type header is stripped and
  // the JSON arrives as text. Fall back to form-encoded parameters just in case.
  const raw = e && e.postData && e.postData.contents;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      // not JSON; fall through
    }
  }
  return (e && e.parameter) || {};
}

function screen_(body) {
  if (clip_(body.website, 200)) return 'honeypot filled';

  const elapsed = Number(body.elapsed);
  if (isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_MS) return 'submitted too fast';

  const name = clip_(body.name, LIMITS.name);
  const email = clip_(body.email, LIMITS.email);
  const message = clip_(body.message, LIMITS.message);

  if (!name || !email || !message) return 'missing field';
  if (!isAddress_(email)) return 'invalid email';
  if (message.length < 10) return 'message too short';
  // Link-stuffed bodies are the usual signature of SEO spam.
  if ((message.match(/https?:\/\//g) || []).length > 4) return 'too many links';

  return null;
}

function clip_(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function isAddress_(value) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value);
}

/* ---------- storage ---------- */

function appendRow_(entry) {
  const sheet = getSheet_();
  sheet.appendRow([entry.timestamp, entry.name, entry.email, entry.message, entry.page]);
  const row = sheet.getLastRow();
  const base = SpreadsheetApp.getActiveSpreadsheet().getUrl().replace(/\/edit.*$/, '');
  return {
    row: row,
    sheetUrl: base + '/edit',
    rowUrl: base + '/edit#gid=' + sheet.getSheetId() + '&range=A' + row
  };
}

function getSheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET_NAME) || book.getSheets()[0];
  if (!sheet) sheet = book.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Timestamp', 'Name', 'Email', 'Message', 'Submitted from']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/* ---------- notification ---------- */

function notify_(entry, location) {
  const recipients = notifyRecipients_();
  if (!recipients.to) return;
  if (!withinEmailBudget_()) {
    console.warn('hourly email cap reached; row saved but no notification sent');
    return;
  }

  const when = Utilities.formatDate(
    entry.timestamp, Session.getScriptTimeZone(), 'd MMM yyyy, HH:mm z');
  const subject = clip_('Paetzold Lab contact form: ' + entry.name.replace(/\s+/g, ' '), 180);

  const facts = [
    ['Name', entry.name],
    ['Email', entry.email],
    ['Received', when],
    ['Submitted from', entry.page || 'unknown'],
    ['Sheet row', String(location.row)]
  ];

  const text = ['New message from the Paetzold Lab website.', '']
    .concat(facts.map(function (fact) { return pad_(fact[0] + ':', 17) + fact[1]; }))
    .concat([
      '',
      'Message',
      '-------',
      entry.message,
      '',
      '---',
      'Reply to this email to answer ' + entry.name + ' directly.',
      'This row:        ' + location.rowUrl,
      'All submissions: ' + location.sheetUrl
    ])
    .join('\n');

  MailApp.sendEmail({
    to: recipients.to,
    cc: recipients.cc,
    subject: subject,
    body: text,
    htmlBody: htmlBody_(entry, facts, location),
    name: 'Paetzold Lab website',
    replyTo: entry.email
  });
}

function pad_(value, width) {
  let out = String(value);
  while (out.length < width) out += ' ';
  return out;
}

/* The submitted message is attacker-controlled, so everything interpolated into
   the HTML body is escaped and every URL is checked before it becomes an href. */
function htmlBody_(entry, facts, location) {
  const rows = facts.map(function (fact) {
    let value = esc_(fact[1]);
    if (fact[0] === 'Email') {
      value = '<a href="mailto:' + esc_(entry.email) + '">' + value + '</a>';
    }
    if (fact[0] === 'Submitted from') {
      const href = httpURL_(entry.page);
      if (href) value = '<a href="' + esc_(href) + '">' + esc_(href) + '</a>';
    }
    return '<tr>' +
      '<td style="padding:4px 18px 4px 0;color:#666;white-space:nowrap;vertical-align:top">' +
        esc_(fact[0]) + '</td>' +
      '<td style="padding:4px 0;color:#111;word-break:break-word">' + value + '</td>' +
      '</tr>';
  }).join('');

  const button = 'display:inline-block;padding:9px 16px;border-radius:6px;' +
    'font-weight:600;text-decoration:none;font-size:14px';

  return '' +
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;' +
      'font-size:15px;line-height:1.55;color:#111;max-width:640px">' +
      '<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;' +
        'text-transform:uppercase;color:#666">Paetzold Lab website</p>' +
      '<h2 style="margin:0 0 18px;font-size:20px">New contact form message</h2>' +
      '<table style="border-collapse:collapse;font-size:14px;margin-bottom:18px">' +
        rows + '</table>' +
      '<div style="border:1px solid #e2e2e2;border-radius:8px;padding:14px 16px;' +
        'background:#fafafa;white-space:pre-wrap;word-break:break-word">' +
        esc_(entry.message) + '</div>' +
      '<p style="margin:20px 0 0">' +
        '<a href="mailto:' + esc_(entry.email) + '" style="' + button +
          ';background:#111;color:#ffffff">Reply to ' + esc_(entry.name) + '</a>' +
        '&nbsp;&nbsp;' +
        '<a href="' + esc_(location.rowUrl) + '" style="' + button +
          ';background:#ffffff;color:#111;border:1px solid #111">Open this row</a>' +
      '</p>' +
      '<p style="margin:16px 0 0;font-size:13px;color:#666">' +
        'Replying to this email goes straight to ' + esc_(entry.email) + '.<br>' +
        '<a href="' + esc_(location.sheetUrl) + '" style="color:#666">All submissions</a>' +
      '</p>' +
    '</div>';
}

function esc_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* Only http(s) links become clickable; anything else stays plain text. */
function httpURL_(value) {
  const raw = clip_(value, LIMITS.page).replace(/[\u0000-\u0020\u007f]+/g, "");
  return /^https?:\/\/[^\s]+$/i.test(raw) ? raw : null;
}

/* NOTIFY_EMAIL and NOTIFY_CC each accept a comma-separated list of addresses. */
function notifyRecipients_() {
  const props = PropertiesService.getScriptProperties();
  const to = addressList_(props.getProperty('NOTIFY_EMAIL')) ||
    Session.getEffectiveUser().getEmail();
  return { to: to, cc: addressList_(props.getProperty('NOTIFY_CC')) };
}

/* Splits on commas, trims, and silently drops anything that is not an address,
   so one typo in the property cannot stop the whole notification going out. */
function addressList_(raw) {
  return clip_(raw, 500)
    .split(',')
    .map(function (address) { return address.trim(); })
    .filter(isAddress_)
    .join(',');
}

function withinEmailBudget_() {
  const cache = CacheService.getScriptCache();
  const key = 'contact_emails_' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
  const sent = Number(cache.get(key) || 0);
  if (sent >= MAX_EMAILS_PER_HOUR) return false;
  cache.put(key, String(sent + 1), 3900); // just over an hour
  return true;
}

/* ---------- helpers ---------- */

function reply_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this once from the editor to approve the Gmail + Sheets scopes and to confirm
 * NOTIFY_EMAIL / NOTIFY_CC resolve to the right people. Sends one email, writes no rows.
 */
function sendTestNotification() {
  const recipients = notifyRecipients_();
  MailApp.sendEmail({
    to: recipients.to,
    cc: recipients.cc,
    subject: 'Paetzold Lab contact form: test',
    body: 'If you are reading this, notifications are configured.\n\n' +
      'To: ' + recipients.to + '\n' +
      'Cc: ' + (recipients.cc || '(none)'),
    name: 'Paetzold Lab website'
  });
  console.log('test notification sent. to=' + recipients.to + ' cc=' + (recipients.cc || '(none)'));
}
