// Browser walkthrough of the real pages against the local e2e stack.
//   npm i --no-save puppeteer-core   (uses an installed Chrome: CHROME_BIN)
//   PGPASSWORD=... POSTGREST_BIN=... node tests/e2e/run.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const puppeteer = (await import(process.env.PUPPETEER_PATH || 'puppeteer-core')).default;
const { db, BASE, server, pgrst, addUser, sessionFor, fakes } = await import('./server.mjs');

const OUT = process.env.SHOTS || 'e2e-shots';
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const problems = [];
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); console.log('PASS', name); }
  catch (e) {
    results.push(['FAIL', name, e.message]); console.log('FAIL', name, '\n   ', e.message);
    let i = 0;
    for (const ctx of browser.browserContexts()) for (const pg of await ctx.pages()) {
      await pg.screenshot({ path: path.join(OUT, `fail-${results.length}-${i++}.png`), fullPage: true }).catch(() => {});
    }
  }
};

async function pageAs(userId, { width = 1280, height = 900 } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  // HTTP refusals (403 etc.) are tested on purpose, so only real script errors count
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`[console] ${m.text()}`); });
  if (userId) {
    const s = await sessionFor(userId);
    await page.goto(BASE + '/privacy.html');
    await page.evaluate((v) => localStorage.setItem('sb-127-auth-token', v), JSON.stringify(s));
  }
  return page;
}
const shot = (page, name, full = true) => page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full });
const text = (page, sel) => page.$eval(sel, (el) => el.innerText);
const waitText = (page, sel, re, timeout = 8000) => page.waitForFunction((s, r) => {
  const el = document.querySelector(s); return el && new RegExp(r, 'i').test(el.innerText);
}, { timeout }, sel, re.source);
const clickText = async (page, root, label) => {
  const ok = await page.evaluate((r, l) => {
    const b = [...document.querySelectorAll(r + ' button, ' + r + ' a.btn')].find((x) => x.innerText.trim().toLowerCase() === l.toLowerCase() && !x.disabled);
    if (b) { b.click(); return true; } return false;
  }, root, label);
  assert.ok(ok, `button "${label}" not found in ${root}`);
};
const dialogOk = async (page, fill) => {
  await page.waitForSelector('dialog[open]');
  if (fill != null) await page.type('dialog[open] input, dialog[open] textarea', fill);
  await page.click('dialog[open] button[value="ok"]');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
};

const ADMIN = await addUser('animeclubsimats@gmail.com', 'SIMATS Anime Club');
const ALICE = await addUser('alice.k@example.com', 'Alice Kumar');
const BOB = await addUser('bob@example.com', 'Bob');

await step('visitor sees the hub with sign-in and empty states', async () => {
  const p = await pageAs(null);
  await p.goto(BASE + '/members');
  await waitText(p, '#accountCard', /Join the member lounge/);
  await waitText(p, '#pollList', /No polls right now/);
  await waitText(p, '#eventList', /No upcoming events/);
  assert.match(await text(p, '#acctSlot'), /SIGN IN/i);
  await shot(p, '01-visitor-members');
});

await step('visitor cannot open the admin dashboard', async () => {
  const p = await pageAs(null);
  await p.goto(BASE + '/admin');
  await waitText(p, '#gate', /Admins only/);
  assert.equal(await p.$eval('#app', (e) => e.hidden), true);
});

let alicePage;
await step('new member fills the name form; admin gets one email', async () => {
  alicePage = await pageAs(ALICE);
  await alicePage.goto(BASE + '/members');
  await waitText(alicePage, '#accountCard', /Tell us who you are/);
  await shot(alicePage, '02-name-form');
  await alicePage.$eval('input[name=full_name]', (e) => { e.value = ''; });
  await alicePage.type('input[name=full_name]', 'Alice Kumar');
  await alicePage.select('select[name=year]', '2nd year');
  await alicePage.type('input[name=dept]', 'CSE');
  await clickText(alicePage, '#accountCard', 'SEND REQUEST');
  await waitText(alicePage, '#accountCard', /Code of Conduct/);          // must tick the box first
  assert.match(await text(alicePage, '#accountCard .note.err'), /tick the box/);
  await alicePage.click('#accountCard .check input');
  await clickText(alicePage, '#accountCard', 'SEND REQUEST');
  await waitText(alicePage, '#accountCard', /Thanks, Alice/);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(fakes.emails.length, 1);
  assert.equal(fakes.emails[0].to[0], 'animeclubsimats@gmail.com');
  assert.match(fakes.emails[0].subject, /Alice Kumar/);
  await shot(alicePage, '03-awaiting');
  // a waiting member cannot vote or comment even by calling the database directly
  const err = await alicePage.evaluate(() => Club.rpc('post_comment', { p_event: '00000000-0000-0000-0000-000000000000', p_body: 'hi there' }).then(() => 'ok', (e) => e.message));
  assert.match(err, /waiting for admin approval/);
});

await step('a non-admin cannot use admin functions from the console', async () => {
  const err = await alicePage.evaluate((id) => Club.rpc('admin_review_member', { p_user: id, p_approve: true, p_note: null }).then(() => 'ok', (e) => e.message), ALICE);
  assert.match(err, /Only club admins/);
  const err2 = await alicePage.evaluate(() => Club.api('/api/sync-events').then(() => 'ok', (e) => e.message));
  assert.match(err2, /Only club admins/);
  const direct = await alicePage.evaluate(() => Club.sb.from('profiles').update({ is_admin: true }).eq('email', 'alice.k@example.com').then((r) => r.error?.message || 'no error'));
  assert.match(direct, /permission denied/);
});

let adminPage;
await step('admin dashboard: overview and approving the request', async () => {
  adminPage = await pageAs(ADMIN);
  await adminPage.goto(BASE + '/admin');
  await waitText(adminPage, '#view', /Waiting approval/);
  assert.equal(await text(adminPage, '#bAppr'), '1');
  await shot(adminPage, '04-admin-overview');
  await adminPage.goto(BASE + '/admin#approvals');
  await waitText(adminPage, '#view', /Alice Kumar/);
  await shot(adminPage, '05-admin-approvals');
  await clickText(adminPage, '#view', 'Approve');
  await waitText(adminPage, '#view', /No requests waiting/);
  const { rows } = await db.query(`select membership_status, reviewed_by from profiles where id=$1`, [ALICE]);
  assert.equal(rows[0].membership_status, 'approved');
  assert.equal(rows[0].reviewed_by, ADMIN);
});

await step('admin creates and publishes a poll', async () => {
  await adminPage.goto(BASE + '/admin#polls');
  await waitText(adminPage, '#view', /No polls yet/);
  await clickText(adminPage, '#view', '+ New poll');
  await adminPage.waitForSelector('dialog[open]');
  await adminPage.type('dialog[open] input.input', 'What should SIMATS Anime Club do next?');
  const opts = await adminPage.$$('dialog[open] .opt-edit input');
  for (const [i, label] of ['Anime movie screening', 'Cosplay competition', 'Fan art workshop'].entries()) await opts[i].type(label);
  await clickText(adminPage, 'dialog[open]', '+ Add option');
  await (await adminPage.$$('dialog[open] .opt-edit input'))[3].type('Anime quiz');
  await clickText(adminPage, 'dialog[open]', '+ Add option');
  await (await adminPage.$$('dialog[open] .opt-edit input'))[4].type('Manga discussion');
  await shot(adminPage, '06-poll-editor', false);
  await clickText(adminPage, 'dialog[open]', 'Save as draft');
  await waitText(adminPage, '#view', /0 participants/);
  await clickText(adminPage, '#view', 'Publish');
  await dialogOk(adminPage);
  await waitText(adminPage, '#view', /Close now/);
  await shot(adminPage, '07-admin-polls');
});

await step('Drive sync: imports events, reports bad rows, failure keeps events', async () => {
  const d = (n) => { const t = new Date(Date.now() + n * 86400e3 + 5.5 * 3600e3); return `${t.getUTCDate()}/${t.getUTCMonth() + 1}/${t.getUTCFullYear()}`; };
  fakes.csv = `ID,Title,Date,Start time,End time,Venue,Description,Category,Status\n`
    + `quiz-1,Spin-the-Wheel Quiz,${d(5)},3:30 PM,5:30 PM,"Block 3, Room 204","Teams of 3. Prizes!",Quiz,\n`
    + `movie-1,Movie Night: Your Name,${d(9)},6:00 PM,,Auditorium,Bring snacks,Screening,Confirmed\n`
    + `bad-1,Broken row,sometime,,,,,,\n`;
  await adminPage.goto(BASE + '/admin#events');
  await waitText(adminPage, '#view', /No sync has run yet/);
  await clickText(adminPage, '#view', '↻ Refresh from Drive now');
  await waitText(adminPage, '#view', /Sync finished: 2 new/);
  assert.match(await text(adminPage, '#view'), /could not read the date/);
  await shot(adminPage, '08-admin-events-sync');
  // the sheet goes missing: the sync fails and the events stay
  await db.query(`update event_sync_logs set started_at = started_at - interval '2 minutes'`);
  fakes.csvStatus = 404;
  await adminPage.goto(BASE + '/admin#events');
  await waitText(adminPage, '#view', /Spin-the-Wheel Quiz/);
  await clickText(adminPage, '#view', '↻ Refresh from Drive now');
  await waitText(adminPage, '#view', /Sync failed/);
  fakes.csvStatus = 200;
  const { rows } = await db.query(`select count(*)::int n from events where status <> 'hidden'`);
  assert.equal(rows[0].n, 2);
  // the weekly cron needs the secret
  const r1 = await fetch(BASE + '/api/sync-events');
  assert.equal(r1.status, 401);
  const r2 = await fetch(BASE + '/api/sync-events', { headers: { authorization: 'Bearer e2e-cron-secret-value' } });
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).unchanged, 2);
});

await step('member votes once and sees results; comments wait for review', async () => {
  await alicePage.goto(BASE + '/members');
  await waitText(alicePage, '#accountCard', /Okaeri, Alice/);
  await waitText(alicePage, '#pollList', /CAST MY VOTE/);
  await alicePage.evaluate(() => document.querySelector('#pollList .opt:nth-child(4) input').click());
  await clickText(alicePage, '#pollList', 'CAST MY VOTE');
  await waitText(alicePage, '#pollList', /YOU VOTED/);
  assert.match(await text(alicePage, '#pollList'), /100% · 1/);
  const again = await alicePage.evaluate(() => Club.rpc('get_polls').then((p) => Club.rpc('cast_vote', { p_poll: p[0].id, p_option: p[0].options[0].id })).then(() => 'ok', (e) => e.message));
  assert.match(again, /already voted/);
  await waitText(alicePage, '#eventList', /Spin-the-Wheel Quiz/);
  await clickText(alicePage, '#eventList article:first-child', '💬 COMMENTS');
  await alicePage.waitForSelector('#eventList article:first-child textarea');
  await alicePage.type('#eventList article:first-child textarea', '<img src=x onerror=alert(1)> Can our team be called "Konoha Quizzers"?');
  await clickText(alicePage, '#eventList article:first-child', 'POST');
  await waitText(alicePage, '#eventList', /Waiting for an admin to approve/);
  assert.equal(await alicePage.$('#eventList .cm .t img'), null, 'comment text must not become HTML');
  await shot(alicePage, '09-member-vote-comment');
  // Bob (not approved) sees no counts and can't vote
  const bob = await pageAs(BOB);
  await bob.goto(BASE + '/members');
  await waitText(bob, '#pollList', /once an admin approves/);
  assert.doesNotMatch(await text(bob, '#pollList'), /%/);
});

await step('admin moderates the comment, then suspends and restores the member', async () => {
  await adminPage.goto(BASE + '/admin#comments');
  await waitText(adminPage, '#view', /Konoha Quizzers/);
  await shot(adminPage, '10-admin-comments');
  await clickText(adminPage, '#view', 'Approve');
  await waitText(adminPage, '#view', /All caught up/);
  const anon = await pageAs(null);
  await anon.goto(BASE + '/members');
  await waitText(anon, '#eventList', /COMMENTS \(1\)/);

  await adminPage.goto(BASE + '/admin#members');
  await waitText(adminPage, '#view', /Alice Kumar/);
  await adminPage.evaluate(() => {
    const row = [...document.querySelectorAll('#view .li')].find((r) => r.innerText.includes('Alice Kumar'));
    [...row.querySelectorAll('button')].find((b) => b.innerText.trim() === 'SUSPEND' || b.innerText.trim() === 'Suspend').click();
  });
  await adminPage.waitForSelector('dialog[open]');
  await adminPage.click('dialog[open] button[value="ok"]');           // empty reason is refused
  assert.match(await text(adminPage, 'dialog[open] .note.err'), /reason/i);
  await adminPage.type('dialog[open] textarea', 'Testing the suspension flow');
  await adminPage.click('dialog[open] button[value="ok"]');
  await waitText(adminPage, '#view', /Suspended .* Testing the suspension flow/);
  await shot(adminPage, '11-admin-members');

  await alicePage.goto(BASE + '/members');
  await waitText(alicePage, '#accountCard', /suspended/);
  const blocked = await alicePage.evaluate(() => Club.sb.from('events').select('id').limit(1)
    .then(({ data }) => Club.rpc('post_comment', { p_event: data[0].id, p_body: 'I am suspended but trying anyway' })).then(() => 'ok', (e) => e.message));
  assert.match(blocked, /suspended/);
  await shot(alicePage, '12-member-suspended');

  await adminPage.evaluate(() => {
    const row = [...document.querySelectorAll('#view .li')].find((r) => r.innerText.includes('Alice Kumar'));
    [...row.querySelectorAll('button')].find((b) => /restore/i.test(b.innerText)).click();
  });
  await dialogOk(adminPage, 'Talked it through');
  await adminPage.waitForFunction(() => {
    const row = [...document.querySelectorAll('#view .li')].find((r) => r.innerText.includes('Alice Kumar'));
    return row && !/SUSPENDED/.test(row.innerText);
  }, { timeout: 8000 });
  const { rows } = await db.query('select membership_status from profiles where id=$1', [ALICE]);
  assert.equal(rows[0].membership_status, 'approved');
});

await step('activity log records every admin action', async () => {
  await adminPage.goto(BASE + '/admin#log');
  await waitText(adminPage, '#view', /Suspended member/);
  const t = await text(adminPage, '#view');
  for (const a of ['Approved member', 'Created poll', 'Published poll', 'Approved comment', 'Restored member', 'Ran Drive sync']) assert.match(t, new RegExp(a));
  await shot(adminPage, '13-admin-log');
});

await step('office bearers, notices under the bell, and cancelling a meeting with a reason', async () => {
  // admin gives Alice a title
  await adminPage.goto(BASE + '/admin#members');
  await waitText(adminPage, '#view', /Alice Kumar/);
  await adminPage.evaluate(() => {
    const row = [...document.querySelectorAll('#view .li')].find((r) => r.innerText.includes('Alice Kumar'));
    const sel = row.querySelector('select'); sel.value = 'secretary'; sel.dispatchEvent(new Event('change'));
  });
  await dialogOk(adminPage);
  await adminPage.waitForFunction(() => [...document.querySelectorAll('#view .li')].some((r) => r.innerText.includes('Alice Kumar') && /SECRETARY/.test(r.innerText)), { timeout: 8000 });

  // admin posts a notice (email is not set up in this test, so it is only posted on the site)
  await adminPage.goto(BASE + '/admin#notices');
  await waitText(adminPage, '#view', /New notice/);
  await clickText(adminPage, '#view', 'Post notice');
  await waitText(adminPage, '#view', /title/);                                 // empty form is refused
  await adminPage.type('#view input.input', 'Room change for Tuesday');
  await adminPage.type('#view textarea', 'We meet in Block B, room 204 this week.\nBring your quiz teams!');
  await clickText(adminPage, '#view', 'Post notice');
  await waitText(adminPage, '#view', /All notices[\s\S]*Room change for Tuesday/);
  assert.match(await text(adminPage, '#view'), /Not emailed|Email failed/);
  await shot(adminPage, '14a-admin-notices');

  // Alice sees the bell with 1 new notice, opens it, and it is marked as seen
  await alicePage.goto(BASE + '/members');
  await waitText(alicePage, '#accountCard', /SECRETARY/);
  await alicePage.waitForFunction(() => document.querySelector('.bell-badge:not([hidden])')?.innerText === '1', { timeout: 8000 });
  await alicePage.click('.bell-btn');
  await waitText(alicePage, '.bell-panel', /Room change for Tuesday/);
  const panel = await text(alicePage, '.bell-panel');
  assert.match(panel, /NEW/);
  assert.match(panel, /Block B, room 204/);
  assert.match(panel, /2026|2027/, 'notice shows its date');
  assert.match(panel, /SIMATS Anime Club/, 'notice shows who posted it');
  await shot(alicePage, '14b-member-bell', false);
  await alicePage.waitForFunction(() => document.querySelector('.bell-badge')?.hidden === true, { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 400));
  const seen = await db.query('select notices_seen_at from profiles where id=$1', [ALICE]);
  assert.ok(seen.rows[0].notices_seen_at, 'opening the bell marks notices as seen');
  await waitText(alicePage, '#bearers', /Alice Kumar[\s\S]*Secretary/);

  // admin cancels a meeting: a reason is required
  const evId = await adminPage.evaluate(() => Club.rpc('admin_save_event', { p_id: null, p_title: 'Tuesday meet', p_starts_at: new Date(Date.now() + 2 * 86400e3).toISOString(),
    p_ends_at: null, p_venue: 'Block B, Room 204', p_description: null, p_image_url: null, p_category: 'MEETUP', p_status: 'scheduled' }));
  await adminPage.goto(BASE + '/admin#events');
  await waitText(adminPage, '#view', /Tuesday meet/);
  await adminPage.evaluate(() => {
    const row = [...document.querySelectorAll('#view .li')].find((r) => r.innerText.includes('Tuesday meet'));
    [...row.querySelectorAll('button')].find((b) => /cancel meeting/i.test(b.innerText)).click();
  });
  await adminPage.waitForSelector('dialog[open]');
  await adminPage.click('dialog[open] button[value="ok"]');
  assert.match(await text(adminPage, 'dialog[open] .note.err'), /why/i);
  await adminPage.type('dialog[open] textarea', 'Internal exams this week');
  await adminPage.click('dialog[open] button[value="ok"]');
  await adminPage.waitForFunction(() => !document.querySelector('dialog[open]'));
  await adminPage.evaluate(() => { const s = document.querySelector('#view select'); if (s) { s.value = 'all'; s.dispatchEvent(new Event('change')); } });
  await waitText(adminPage, '#view', /Cancelled .* Internal exams this week/);
  await shot(adminPage, '14c-admin-cancelled');
  const ev = (await db.query('select status, cancel_reason from events where id=$1', [evId])).rows[0];
  assert.deepEqual(ev, { status: 'cancelled', cancel_reason: 'Internal exams this week' });

  // members: gone from upcoming, shown under Recent with the reason, and a new notice under the bell
  await alicePage.goto(BASE + '/members');
  await waitText(alicePage, '#eventList', /Spin-the-Wheel Quiz/);
  assert.doesNotMatch(await text(alicePage, '#eventList'), /Tuesday meet/);
  await alicePage.click('#tabPast');
  await waitText(alicePage, '#eventList', /Tuesday meet[\s\S]*This meeting is cancelled\. Reason: Internal exams this week/);
  await alicePage.waitForFunction(() => document.querySelector('.bell-badge:not([hidden])')?.innerText === '1', { timeout: 8000 });
  await alicePage.click('.bell-btn');
  await waitText(alicePage, '.bell-panel', /MEETING CANCELLED[\s\S]*Cancelled: Tuesday meet[\s\S]*Reason: Internal exams this week/);
  await shot(alicePage, '14d-member-cancelled', false);

  // home page calendar does not list the cancelled meeting; approved members get the bell there too
  const home = await pageAs(ALICE);
  await home.goto(BASE + '/');
  await home.waitForFunction(() => document.querySelector('#evList')?.innerText.includes('Spin-the-Wheel Quiz'), { timeout: 10000 });
  assert.doesNotMatch(await text(home, '#evList'), /Tuesday meet/);
  await home.waitForFunction(() => document.getElementById('hubBell') && !document.getElementById('hubBell').hidden, { timeout: 8000 });
  assert.equal(await home.$eval('#hubBell', (b) => b.getAttribute('href')), '#notices');

  // notices are public: a visitor sees the notice board and the bell, on the home page and in the lounge
  const visitor = await pageAs(null);
  await visitor.goto(BASE + '/');
  await visitor.waitForFunction(() => !document.getElementById('notices').hidden, { timeout: 10000 });
  const board = await text(visitor, '#notices');
  assert.match(board, /Cancelled: Tuesday meet[\s\S]*Reason: Internal exams this week/);
  assert.match(board, /Room change for Tuesday/);
  assert.match(board, /NEW/, 'a first-time visitor sees them as new');
  await visitor.waitForFunction(() => document.querySelector('#hubBell .hb-n:not([hidden])')?.innerText === '2', { timeout: 8000 });
  await visitor.evaluate(() => document.getElementById('notices').scrollIntoView());
  await (await visitor.$('#notices')).screenshot({ path: path.join(OUT, '14f-home-notice-board.png') });
  await visitor.goto(BASE + '/members');
  await visitor.waitForSelector('.bell-btn');
  await visitor.waitForFunction(() => document.querySelector('.bell-badge:not([hidden])')?.innerText === '2', { timeout: 8000 });
  await visitor.click('.bell-btn');
  await waitText(visitor, '.bell-panel', /Room change for Tuesday/);
  await visitor.waitForFunction(() => document.querySelector('.bell-badge')?.hidden === true, { timeout: 5000 });
  await visitor.goto(BASE + '/members');                      // remembered in this browser
  await visitor.waitForSelector('.bell-btn');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await visitor.$eval('.bell-badge', (b) => b.hidden), true);
});

await step('gallery: Drive items replace the built-in photos; admins hide items; uploads need setup', async () => {
  await db.query(`insert into gallery_items (drive_id, folder_id, name, kind, width, height, sort_time) values
    ('PHOTO_meet_00001', 'FOLDER_main_000', 'quiz.jpg', 'photo', 1600, 1200, now() - interval '1 day'),
    ('VIDEO_meet_00001', 'FOLDER_main_000', 'cosplay.mp4', 'video', 1920, 1080, now() - interval '2 day'),
    ('PHOTO_meet_00002', 'FOLDER_main_000', 'secret.jpg', 'photo', 1600, 1200, now() - interval '3 day')
    on conflict do nothing`);
  // admin tab: setup still needed (no Google keys in this test), items listed, hide one
  await adminPage.goto(BASE + '/admin#gallery');
  await waitText(adminPage, '#view', /Still to set up in Vercel: GOOGLE_API_KEY/);
  await waitText(adminPage, '#view', /3 items · 3 on the home page/);
  assert.equal(await adminPage.$eval('#view .g-tile', () => true), true);
  const uploadDisabled = await adminPage.evaluate(() => [...document.querySelectorAll('#view button')].find((b) => /upload photos/i.test(b.innerText))?.disabled);
  assert.equal(uploadDisabled, true, 'upload needs Drive to be connected');
  await adminPage.evaluate(() => {
    const t = [...document.querySelectorAll('#view .g-tile')].find((x) => x.innerText.includes('secret.jpg'));
    [...t.querySelectorAll('button')].find((b) => /hide/i.test(b.innerText)).click();
  });
  await waitText(adminPage, '#view', /3 items · 2 on the home page/);
  await shot(adminPage, '14e-admin-gallery');
  // members cannot use the gallery API
  const deny = await alicePage.evaluate(() => Club.api('/api/gallery', { action: 'status' }).then(() => 'ok', (e) => e.message));
  assert.match(deny, /Only club admins/);
  // home page: the two shown Drive items replace the built-in ones; the video opens in Google's player
  const home = await pageAs(null);
  await home.goto(BASE + '/');
  await home.waitForFunction(() => document.querySelector('#meetsTrack .meet[data-drive]'), { timeout: 10000 });
  const g = await home.evaluate(() => {
    const figs = [...document.querySelectorAll('#meetsTrack .meet')];
    return { total: figs.length, drive: figs.filter((f) => f.dataset.drive).length, ids: [...new Set(figs.map((f) => f.dataset.drive))],
      photo: figs.find((f) => f.dataset.kind === 'photo').querySelector('img').getAttribute('src'), builtIn: !!document.querySelector('#meetsTrack video') };
  });
  assert.deepEqual(g.ids.sort(), ['PHOTO_meet_00001', 'VIDEO_meet_00001'], 'hidden item is not shown');
  assert.equal(g.total, g.drive);
  assert.equal(g.builtIn, false);
  assert.match(g.photo, /^https:\/\/lh3\.googleusercontent\.com\/d\/PHOTO_meet_00001=w1100$/);
  await home.evaluate(() => { const v = document.querySelector('#meetsTrack .meet[data-kind="video"]'); v.scrollIntoView(); v.click(); });
  await home.waitForSelector('#lightbox.open iframe');
  assert.match(await home.$eval('#lightbox iframe', (f) => f.src), /^https:\/\/drive\.google\.com\/file\/d\/VIDEO_meet_00001\/preview$/);
  await home.keyboard.press('Escape');
});

await step('phone layout: hub and dashboard', async () => {
  const p = await pageAs(ALICE, { width: 390, height: 844 });
  await p.goto(BASE + '/members');
  await waitText(p, '#pollList', /YOU VOTED/);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 1, 'no sideways scrolling on phones, got ' + overflow);
  await shot(p, '14-phone-members');
  const a = await pageAs(ADMIN, { width: 390, height: 844 });
  await a.goto(BASE + '/admin#overview');
  await waitText(a, '#view', /Members/);
  assert.ok(await a.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1);
  await shot(a, '15-phone-admin');
});

if (process.env.E2E_INDEX !== '0') await step('home page shows Drive events and the club hub link', async () => {
  const p = await pageAs(ALICE);
  await p.goto(BASE + '/');
  await p.waitForFunction(() => document.querySelector('#evList')?.innerText.includes('Spin-the-Wheel Quiz'), { timeout: 10000 });
  assert.match(await text(p, '#evList'), /Movie Night/);
  assert.ok(await p.$('#evList a[href*="/members#event-"]'), 'events link to their comments');
  assert.ok(await p.$('#hubChip'), 'club hub chip exists');
  await (await p.$('#evList')).screenshot({ path: path.join(OUT, '16-home-events.png') });
  const phone = await pageAs(ALICE, { width: 390, height: 844 });
  await phone.goto(BASE + '/');
  // keep scrolling (like a person would) until the header bar shows; the first scroll can land before the page has laid out
  await phone.waitForFunction(() => { window.scrollTo(0, document.querySelector('#club').offsetTop + 200); return document.querySelector('#hubChip.on'); },
    { timeout: 12000, polling: 300 });
  await new Promise((r) => setTimeout(r, 500));
  const chip = await phone.$eval('#hubChip', (e) => e.getBoundingClientRect().toJSON());
  const logo = await phone.$eval('#fixedLogo', (e) => e.getBoundingClientRect().toJSON());
  assert.ok(chip.left >= logo.right || chip.right <= logo.left, 'hub chip must not cover the header logo on phones');
  await phone.screenshot({ path: path.join(OUT, '17-home-phone-header.png') });
});

await step('no JavaScript errors on any page', async () => {
  assert.deepEqual(problems, []);
});

await browser.close();
server.close(); pgrst.kill(); await db.end();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);
