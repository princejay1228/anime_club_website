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
  await waitText(p, '#accountCard', /Join the club hub/);
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
  await alicePage.click('#pollList .opt:nth-child(4) input');
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
  await phone.evaluate(() => window.scrollTo(0, document.querySelector('#club').offsetTop + 200));
  await phone.waitForFunction(() => document.querySelector('#hubChip.on'), { timeout: 8000 });
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
