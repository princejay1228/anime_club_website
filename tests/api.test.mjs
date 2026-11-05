// Tests for the Vercel functions: sheet parsing, Google access, the sync
// runner, cron/admin protection and the admin email. No network is used:
// Google, Resend and Supabase are replaced with small fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { normalizeRows, parseCsv, toIstIso, parseTime, normalizeImageUrl, mapHeaders } from '../api/_lib/events-normalize.js';
import { readEventSheet, getGoogleAccessToken } from '../api/_lib/drive-source.js';
import { runSync } from '../api/sync-events.js';
import syncHandler from '../api/sync-events.js';
import notifyHandler, { notify, buildEmail } from '../api/notify-admin.js';
import { notifyMembers, buildNoticeEmail, BATCH } from '../api/notify-members.js';
import { requireAdmin, redact, safeEqual } from '../api/_lib/server.js';

// ---------- a tiny fake Supabase client ----------
// Every query chain is recorded; `resolve(q)` decides what it returns.
function fakeSb(resolve, { rpc, users = {} } = {}) {
  const calls = [];
  const make = (table) => {
    const q = { table, ops: [] };
    calls.push(q);
    const chain = new Proxy(() => {}, {
      get(_, prop) {
        if (prop === 'then') return (ok, bad) => Promise.resolve(resolve(q)).then(ok, bad);
        return (...args) => { q.ops.push([prop, args]); return chain; };
      },
    });
    return chain;
  };
  return {
    calls,
    from: make,
    rpc: async (fn, args) => { calls.push({ rpc: fn, args }); return rpc ? rpc(fn, args) : { data: null, error: null }; },
    auth: { getUser: async (t) => (users[t] ? { data: { user: users[t] }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } }) },
  };
}
const op = (q, name) => q.ops.find(([n]) => n === name)?.[1];
const fakeRes = () => {
  const r = { statusCode: 0, headers: {}, body: '' };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.body = b; };
  r.json = () => JSON.parse(r.body);
  return r;
};

// ---------- sheet parsing ----------
test('reads common Indian date and time formats as India time', () => {
  assert.equal(toIstIso('2026-11-14', '3:30 PM'), '2026-11-14T15:30:00+05:30');
  assert.equal(toIstIso('14/11/2026', '15:30'), '2026-11-14T15:30:00+05:30');
  assert.equal(toIstIso('14-11-26', ''), '2026-11-14T00:00:00+05:30');
  assert.equal(toIstIso('14 Nov 2026'), '2026-11-14T00:00:00+05:30');
  assert.equal(toIstIso('Saturday, 14 November 2026', '10am'), '2026-11-14T10:00:00+05:30');
  assert.equal(toIstIso('Nov 14, 2026', '12:15 am'), '2026-11-14T00:15:00+05:30');
  assert.equal(toIstIso('14/11/2026 4:00 PM'), '2026-11-14T16:00:00+05:30');
  assert.equal(toIstIso('2026-11-14T10:00:00Z'), '2026-11-14T10:00:00.000Z');
  assert.equal(toIstIso('31/02/2026'), null);
  assert.equal(toIstIso('next friday'), null);
  assert.equal(parseTime('3'), null, 'a bare number is ambiguous');
});

test('Drive share links become direct image links; non-https links are refused', () => {
  assert.equal(normalizeImageUrl('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing'), 'https://lh3.googleusercontent.com/d/1AbCdEfGhIjKlMnOp');
  assert.equal(normalizeImageUrl('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp'), 'https://lh3.googleusercontent.com/d/1AbCdEfGhIjKlMnOp');
  assert.equal(normalizeImageUrl('http://x.com/a.png'), null);
  assert.equal(normalizeImageUrl('javascript:alert(1)'), null);
  assert.equal(normalizeImageUrl(''), '');
});

test('headers are matched by friendly names', () => {
  const i = mapHeaders(['Event ID', 'Event Name', 'Date', 'Start Time', 'End Time', 'Location', 'Details', 'Poster URL', 'Type', 'Status']);
  assert.deepEqual(i, { external_id: 0, title: 1, date: 2, start_time: 3, end_time: 4, venue: 5, description: 6, image_url: 7, category: 8, status: 9 });
});

test('normalizes a realistic sheet, skipping bad rows with clear warnings', () => {
  const { rows, skipped, rowsRead, warnings } = normalizeRows([
    ['ID', 'Title', 'Date', 'Start time', 'End time', 'Venue', 'Description', 'Image', 'Category', 'Status'],
    ['quiz-1', 'Spin-the-Wheel Quiz', '14/11/2026', '3:30 PM', '5:30 PM', 'Block 3, Room 204', 'Teams of 3.\n\n\n\nPrizes!', '', 'quiz', ''],
    ['', 'Movie Night', '2026-11-21', '18:00', '', 'Auditorium', '', 'https://example.com/p.jpg', 'Screening', 'Confirmed'],
    ['quiz-1', 'Duplicate', '15/11/2026', '', '', '', '', '', '', ''],
    ['x', '', '15/11/2026', '', '', '', '', '', '', ''],
    ['y', 'No date', 'sometime', '', '', '', '', '', '', ''],
    ['z', 'Odd status', '16/11/2026', '', '', '', '', 'http://insecure', '', 'maybe'],
    ['', '', '', '', '', '', '', '', '', ''],
  ]);
  assert.equal(rowsRead, 6);
  assert.equal(skipped, 3);
  assert.equal(rows.length, 3);
  const [quiz, movie, odd] = rows;
  assert.equal(quiz.external_id, 'quiz-1');
  assert.equal(quiz.starts_at, '2026-11-14T15:30:00+05:30');
  assert.equal(quiz.ends_at, '2026-11-14T17:30:00+05:30');
  assert.equal(quiz.description, 'Teams of 3.\n\nPrizes!');
  assert.equal(quiz.category, 'QUIZ');
  assert.equal(quiz.status, 'scheduled');
  assert.match(movie.external_id, /^auto-[0-9a-f]{16}$/);
  assert.equal(odd.status, 'scheduled');
  assert.equal(odd.image_url, '');
  assert.ok(warnings.some((w) => /duplicate id/.test(w)));
  assert.ok(warnings.some((w) => /could not read the date/.test(w)));
  assert.ok(warnings.some((w) => /unknown status/.test(w)));
  assert.ok(warnings.some((w) => /https/.test(w)));
  // same input -> same hash; a change -> new hash
  const again = normalizeRows([['ID', 'Title', 'Date'], ['a', 'X event', '1/1/2027']]).rows[0].hash;
  assert.equal(normalizeRows([['ID', 'Title', 'Date'], ['a', 'X event', '1/1/2027']]).rows[0].hash, again);
  assert.notEqual(normalizeRows([['ID', 'Title', 'Date'], ['a', 'X event!', '1/1/2027']]).rows[0].hash, again);
});

test('a sheet without the needed columns is rejected', () => {
  const r = normalizeRows([['Name of thing', 'When?'], ['a', 'b']]);
  assert.equal(r.rows.length, 0);
  assert.match(r.warnings[0], /Title.*Date/);
});

test('CSV parser handles quotes, commas and line breaks', () => {
  assert.deepEqual(parseCsv('﻿Title,Desc\r\n"Quiz, finals","Say ""hi""\nthen go"\n'),
    [['Title', 'Desc'], ['Quiz, finals', 'Say "hi"\nthen go']]);
});

// ---------- Google access ----------
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const googleEnv = { EVENTS_SHEET_ID: 'sheet123', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sync@club.iam.gserviceaccount.com', GOOGLE_PRIVATE_KEY: pem.replace(/\n/g, '\\n') };

function fakeGoogle({ sheetStatus = 200, values = [['Title', 'Date'], ['Quiz', '14/11/2026']] } = {}) {
  const seen = [];
  const f = async (url, opts = {}) => {
    seen.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const jwt = new URLSearchParams(opts.body).get('assertion');
      const [h, c, s] = jwt.split('.');
      const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'));
      const claim = JSON.parse(Buffer.from(c, 'base64url'));
      if (!ok || claim.iss !== googleEnv.GOOGLE_SERVICE_ACCOUNT_EMAIL || !/spreadsheets\.readonly/.test(claim.scope)) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    if (url.startsWith('https://sheets.googleapis.com/')) {
      if (opts.headers?.authorization !== 'Bearer tok') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify(sheetStatus === 200 ? { values } : {}), { status: sheetStatus });
    }
    throw new Error('unexpected url ' + url);
  };
  f.seen = seen;
  return f;
}

test('service account signs a valid read-only token request and reads the sheet', async () => {
  const f = fakeGoogle();
  const values = await readEventSheet({ ...googleEnv, EVENTS_SHEET_RANGE: 'Events' }, f);
  assert.deepEqual(values, [['Title', 'Date'], ['Quiz', '14/11/2026']]);
  assert.match(f.seen[1], /spreadsheets\/sheet123\/values\/Events/);
});

test('clear errors for a missing key, an unshared sheet and a wrong CSV link', async () => {
  await assert.rejects(getGoogleAccessToken({ GOOGLE_SERVICE_ACCOUNT_EMAIL: 'a' }), /not configured/);
  await assert.rejects(readEventSheet(googleEnv, fakeGoogle({ sheetStatus: 403 })), /shared with the service account/);
  await assert.rejects(readEventSheet({}), /No events source/);
  await assert.rejects(readEventSheet({ EVENTS_CSV_URL: 'https://evil.example/x.csv' }), /docs\.google\.com/);
  const html = async () => new Response('<!doctype html><html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(readEventSheet({ EVENTS_CSV_URL: 'https://docs.google.com/spreadsheets/d/x/pub?output=csv' }, html), /not CSV/);
  const csv = async () => new Response('Title,Date\nQuiz,14/11/2026\n', { status: 200, headers: { 'content-type': 'text/csv' } });
  assert.deepEqual(await readEventSheet({ EVENTS_CSV_URL: 'https://docs.google.com/spreadsheets/d/x/pub?output=csv' }, csv), [['Title', 'Date'], ['Quiz', '14/11/2026']]);
});

// ---------- sync runner ----------
const syncSb = (rpcResult = { data: { inserted: 1, updated: 0, unchanged: 0, hidden: 0 }, error: null }) =>
  fakeSb((q) => {
    if (q.table === 'event_sync_logs' && op(q, 'insert')) return { data: { id: 42 }, error: null };
    if (q.table === 'event_sync_logs' && op(q, 'select') && op(q, 'eq')) return { data: { details: { source: 'google-sheet' } }, error: null };
    return { data: null, error: null };
  }, { rpc: () => rpcResult });

test('sync success: rows go to apply_event_sync in one call', async () => {
  const sb = syncSb();
  const out = await runSync({ sb, env: googleEnv, trigger: 'cron', fetchImpl: fakeGoogle() });
  assert.equal(out.ok, true);
  assert.equal(out.inserted, 1);
  const call = sb.calls.find((c) => c.rpc === 'apply_event_sync');
  assert.equal(call.args.p_log_id, 42);
  assert.equal(call.args.p_rows[0].title, 'Quiz');
});

test('sync failure: Google down -> logged as failed, events never touched', async () => {
  const sb = syncSb();
  const down = async () => { throw new Error('ECONNRESET'); };
  const out = await runSync({ sb, env: googleEnv, trigger: 'cron', fetchImpl: down });
  assert.equal(out.ok, false);
  assert.match(out.error, /Could not reach Google/);
  assert.ok(!sb.calls.some((c) => c.rpc), 'apply_event_sync must not run');
  const upd = sb.calls.find((c) => c.table === 'event_sync_logs' && op(c, 'update')?.[0]?.status === 'failed');
  assert.ok(upd, 'failure is written to the sync log');
});

test('sync failure: empty sheet keeps current events', async () => {
  const sb = syncSb();
  const out = await runSync({ sb, env: googleEnv, trigger: 'manual', fetchImpl: fakeGoogle({ values: [['Title', 'Date']] }) });
  assert.equal(out.ok, false);
  assert.ok(!sb.calls.some((c) => c.rpc));
});

test('sync failure: database error is reported and secrets are redacted', async () => {
  const env = { ...googleEnv, SUPABASE_SERVICE_ROLE_KEY: 'super-secret-service-key' };
  const sb = syncSb({ data: null, error: { message: 'boom with super-secret-service-key inside' } });
  const out = await runSync({ sb, env, trigger: 'cron', fetchImpl: fakeGoogle() });
  assert.equal(out.ok, false);
  assert.doesNotMatch(out.error, /super-secret/);
  assert.match(redact('key -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- end'), /\[redacted key\]/);
});

// ---------- endpoint protection ----------
test('cron endpoint needs the secret, and refuses to run if no secret is configured', async () => {
  const saved = { ...process.env };
  try {
    delete process.env.CRON_SECRET;
    let res = fakeRes();
    await syncHandler({ method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 500);
    assert.match(res.json().error, /CRON_SECRET/);

    process.env.CRON_SECRET = 'c'.repeat(32);
    res = fakeRes();
    await syncHandler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
    assert.equal(res.statusCode, 401);

    res = fakeRes();
    await syncHandler({ method: 'DELETE', headers: {} }, res);
    assert.equal(res.statusCode, 405);

    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'x';
    res = fakeRes();
    await syncHandler({ method: 'POST', headers: {} }, res);
    assert.equal(res.statusCode, 401, 'manual sync without a session is refused');
    res = fakeRes();
    await notifyHandler({ method: 'POST', headers: {} }, res);
    assert.equal(res.statusCode, 401);
  } finally {
    process.env = saved;
  }
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('', ''), false);
});

test('manual sync requires an approved admin', async () => {
  const profiles = {
    u1: { id: 'u1', is_admin: false, membership_status: 'approved' },
    u2: { id: 'u2', is_admin: true, membership_status: 'approved' },
  };
  const sb = fakeSb((q) => ({ data: profiles[op(q, 'eq')?.[1]] ?? null, error: null }),
    { users: { tokMember: { id: 'u1' }, tokAdmin: { id: 'u2' } } });
  await assert.rejects(requireAdmin(sb, { headers: {} }), /sign in/);
  await assert.rejects(requireAdmin(sb, { headers: { authorization: 'Bearer forged' } }), /expired/);
  await assert.rejects(requireAdmin(sb, { headers: { authorization: 'Bearer tokMember' } }), /Only club admins/);
  const ok = await requireAdmin(sb, { headers: { authorization: 'Bearer tokAdmin' } });
  assert.equal(ok.profile.id, 'u2');
});

// ---------- admin email ----------
const waiting = { id: 'p1', email: 'alice@example.com', full_name: 'Alice <b>K</b>', year_of_study: '2nd', department: 'CSE',
  membership_status: 'awaiting_approval', requested_at: '2026-11-03T08:00:00Z', admin_notified_at: null };

test('admin email: sent once, escaped, and to the club address', async () => {
  let claimed = 0; const sent = [];
  const sb = fakeSb((q) => {
    if (op(q, 'update')) { claimed++; return { data: claimed === 1 ? [{ id: 'p1' }] : [], error: null }; }
    return { count: 3, data: null, error: null };
  });
  const mail = async (url, opts) => { sent.push(JSON.parse(opts.body)); return new Response('{}', { status: 200 }); };
  const env = { RESEND_API_KEY: 're_test', SITE_URL: 'https://simats-anime-club.vercel.app' };
  assert.deepEqual(await notify({ sb, env, profile: waiting, fetchImpl: mail }), { sent: true });
  assert.equal(sent[0].to[0], 'animeclubsimats@gmail.com');
  assert.equal(sent[0].reply_to, 'alice@example.com');
  assert.match(sent[0].html, /Alice &lt;b&gt;K&lt;\/b&gt;/);
  assert.doesNotMatch(sent[0].html, /<b>K<\/b>/);
  assert.match(sent[0].text, /3 requests waiting/);
  assert.match(sent[0].html, /\/admin#approvals/);
  // a second, simultaneous call loses the claim and sends nothing
  assert.deepEqual(await notify({ sb, env, profile: waiting, fetchImpl: mail }), { sent: false, reason: 'already-notified' });
  assert.equal(sent.length, 1);
});

test('admin email: skipped when already sent, not waiting, or not configured; failure releases the claim', async () => {
  const sb = fakeSb(() => ({ data: [{ id: 'p1' }], count: 1, error: null }));
  const env = { RESEND_API_KEY: 're_test' };
  assert.equal((await notify({ sb, env, profile: { ...waiting, admin_notified_at: '2026-11-03T09:00:00Z' } })).reason, 'already-notified');
  assert.equal((await notify({ sb, env, profile: { ...waiting, membership_status: 'approved' } })).reason, 'not-waiting');
  assert.equal((await notify({ sb, env: {}, profile: waiting })).reason, 'email-not-configured');
  const fail = async () => new Response('rate limited', { status: 429 });
  const out = await notify({ sb, env, profile: waiting, fetchImpl: fail });
  assert.equal(out.reason, 'email-failed');
  const release = sb.calls.filter((c) => op(c, 'update')).pop();
  assert.equal(op(release, 'update')[0].admin_notified_at, null);
  assert.equal(buildEmail(waiting, 1).subject, 'New member request: Alice <b>K</b>');
});

test('new-style sb_secret keys are accepted and never leak into errors', async () => {
  const { secretKey } = await import('../api/_lib/server.js');
  assert.equal(secretKey({ SUPABASE_SECRET_KEY: 'sb_secret_abc' }), 'sb_secret_abc');
  assert.equal(secretKey({ SUPABASE_SERVICE_ROLE_KEY: 'eyJlegacy' }), 'eyJlegacy');
  assert.doesNotMatch(redact('failed with sb_secret_FAKE_test_value-123 in header', {}), /sb_secret_/);
});

// ---------- member notices by email (Gmail) ----------
const noticeRow = { id: 7, kind: 'notice', title: 'Room <change>', body: 'Tuesday meet is in Block B.\n\nBring <b>snacks</b>.' };
function noticeSb({ members, claim = true }) {
  return fakeSb((q) => {
    if (q.table === 'notices' && op(q, 'update') && op(q, 'is')) return { data: claim ? [noticeRow] : [], error: null };
    if (q.table === 'notices') return { data: null, error: null };
    if (q.table === 'profiles') return { data: members, error: null };
    return { data: null, error: null };
  });
}
const fakeTransport = (sentLog, failOn = -1) => () => ({
  n: 0,
  async sendMail(m) { if (this.n++ === failOn) throw Object.assign(new Error('Invalid login: 535 fake pass word here'), {}); sentLog.push(m); },
  close() {},
});

test('member notice email: BCC in batches, escaped, from the club Gmail, claimed once', async () => {
  const members = Array.from({ length: BATCH + 5 }, (_, i) => ({ email: `m${i}@example.com` }))
    .concat([{ email: 'M0@Example.com' }, { email: 'not-an-email' }, { email: null }]);
  const sent = [];
  const sb = noticeSb({ members });
  const env = { GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', SITE_URL: 'https://simats-anime-club.vercel.app' };
  const out = await notifyMembers({ sb, env, noticeId: 7, makeTransport: fakeTransport(sent) });
  assert.deepEqual(out, { sent: BATCH + 5, failed: 0 });
  assert.equal(sent.length, 2, 'two batches');
  assert.equal(sent[0].bcc.length, BATCH);
  assert.equal(sent[0].to, 'animeclubsimats@gmail.com', 'members are only in BCC');
  assert.match(sent[0].from, /animeclubsimats@gmail\.com/);
  assert.ok(!sent.flatMap((m) => m.bcc).includes('not-an-email'));
  assert.equal(new Set(sent.flatMap((m) => m.bcc)).size, BATCH + 5, 'duplicates removed');
  assert.match(sent[0].html, /Room &lt;change&gt;/);
  assert.doesNotMatch(sent[0].html, /<b>snacks<\/b>/);
  assert.match(sent[0].html, /\/members#notices/);
  const final = sb.calls.filter((c) => c.table === 'notices' && op(c, 'update')).pop();
  assert.equal(op(final, 'update')[0].email_count, BATCH + 5);
  // already claimed: nothing is sent again
  const again = await notifyMembers({ sb: noticeSb({ members, claim: false }), env, noticeId: 7, makeTransport: fakeTransport(sent) });
  assert.equal(again.reason, 'already-emailed-or-missing');
  assert.equal(sent.length, 2);
});

test('member notice email: not configured, bad id, failure releases the claim and hides the password', async () => {
  const members = [{ email: 'a@example.com' }];
  assert.equal((await notifyMembers({ sb: noticeSb({ members }), env: {}, noticeId: 7 })).reason, 'email-not-configured');
  await assert.rejects(notifyMembers({ sb: noticeSb({ members }), env: { GMAIL_APP_PASSWORD: 'x'.repeat(16) }, noticeId: 'abc' }), /notice_id/);
  const sb = noticeSb({ members });
  const env = { GMAIL_APP_PASSWORD: 'fake pass word here' };
  const out = await notifyMembers({ sb, env, noticeId: 7, makeTransport: fakeTransport([], 0) });
  assert.equal(out.reason, 'email-failed');
  assert.doesNotMatch(out.error, /fake pass|word here/);
  const release = sb.calls.filter((c) => c.table === 'notices' && op(c, 'update')).pop();
  assert.equal(op(release, 'update')[0].emailed_at, null, 'claim released so the admin can retry');
  assert.equal(buildNoticeEmail({ kind: 'cancellation', title: 'Cancelled: Tuesday meet', body: 'Reason: exams' }).subject, 'Cancelled: Tuesday meet');
});
