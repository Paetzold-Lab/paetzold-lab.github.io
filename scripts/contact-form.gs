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
 *          NOTIFY_EMAIL = <where notifications should go>
 *      (Left unset, it falls back to the account that owns the script.)
 *      Keeping the address here instead of in code keeps it out of the public repo.
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
const LIMITS = { name: 120, email: 200, message: 4000 };

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
      message: clip_(body.message, LIMITS.message)
    };

    appendRow_(entry);
    notify_(entry);
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
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return 'invalid email';
  if (message.length < 10) return 'message too short';
  // Link-stuffed bodies are the usual signature of SEO spam.
  if ((message.match(/https?:\/\//g) || []).length > 4) return 'too many links';

  return null;
}

function clip_(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/* ---------- storage ---------- */

function appendRow_(entry) {
  const sheet = getSheet_();
  sheet.appendRow([entry.timestamp, entry.name, entry.email, entry.message]);
}

function getSheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET_NAME) || book.getSheets()[0];
  if (!sheet) sheet = book.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Timestamp', 'Name', 'Email', 'Message']);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/* ---------- notification ---------- */

function notify_(entry) {
  const to = notifyAddress_();
  if (!to) return;
  if (!withinEmailBudget_()) {
    console.warn('hourly email cap reached; row saved but no notification sent');
    return;
  }

  const who = entry.name.replace(/\s+/g, ' ');
  const subject = clip_('Paetzold Lab contact form: ' + who, 180);
  const sheetUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();

  const lines = [
    'New message from the Paetzold Lab website.',
    '',
    'Name:    ' + entry.name,
    'Email:   ' + entry.email,
    'Time:    ' + Utilities.formatDate(entry.timestamp, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss z'),
    '',
    'Message:',
    entry.message,
    '',
    '---',
    'Reply to this email to answer the sender directly.',
    'All submissions: ' + sheetUrl
  ];

  MailApp.sendEmail({
    to: to,
    subject: subject,
    body: lines.join('\n'),
    name: 'Paetzold Lab website',
    replyTo: entry.email
  });
}

function notifyAddress_() {
  const configured = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
  return clip_(configured, 200) || Session.getEffectiveUser().getEmail();
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
 * Run this once from the editor to approve the Gmail + Sheets scopes and confirm
 * NOTIFY_EMAIL is set correctly. It sends one email and writes no rows.
 */
function sendTestNotification() {
  const to = notifyAddress_();
  MailApp.sendEmail({
    to: to,
    subject: 'Paetzold Lab contact form: test',
    body: 'If you are reading this, notifications are configured.\nDelivering to: ' + to,
    name: 'Paetzold Lab website'
  });
  console.log('test notification sent to ' + to);
}
