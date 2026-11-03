// Database tests: run the real migrations on a throwaway Postgres database
// (with a small Supabase stand-in) and check every permission rule.
//
//   PGHOST=/var/run/postgresql PGUSER=postgres npm run test:db
//
// Needs a local Postgres 15+ the test can create databases on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const migDir = path.join(here, '..', 'migrations');
const DB = 'club_test_' + process.pid;
let admin, db;

before(async () => {
  admin = new pg.Client({ database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${DB}`);
  // the stand-in roles are cluster-wide; drop leftovers from a previous run
  for (const r of ['anon', 'authenticated', 'service_role']) {
    const { rows } = await admin.query('select 1 from pg_roles where rolname=$1', [r]);
    if (rows.length) { await admin.query(`drop owned by ${r} cascade`).catch(() => {}); }
  }
  await admin.query(`create database ${DB}`);
  db = new pg.Client({ database: DB });
  await db.connect();
  for (const r of ['anon', 'authenticated', 'service_role']) {
    const { rows } = await db.query('select 1 from pg_roles where rolname=$1', [r]);
    if (rows.length) await db.query(`drop role ${r}`).catch(() => {});
  }
  const shim = readFileSync(path.join(here, 'supabase_shim.sql'), 'utf8')
    .replace(/create role (\w+) nologin( bypassrls)?;/g, (m, r, b) =>
      `do $$ begin if not exists (select 1 from pg_roles where rolname='${r}') then create role ${r} nologin${b || ''}; end if; end $$;`);
  await db.query(shim);
  // someone who signed in before the migrations ran (e.g. while testing Google sign-in)
  await db.query(`insert into auth.users (email, email_confirmed_at, raw_app_meta_data) values ('early@example.com', now(), '{"provider":"google"}')`);
  for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(readFileSync(path.join(migDir, f), 'utf8'));
  }
});

after(async () => {
  await db?.end();
  await admin?.query(`drop database if exists ${DB}`);
  await admin?.end();
});

// ---------- helpers ----------
async function newUser(email, { provider = 'google', confirmed = true, name = 'Google Name' } = {}) {
  const { rows } = await db.query(
    `insert into auth.users (email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
     values ($1, $2, $3, $4) returning id`,
    [email, confirmed ? new Date() : null, { provider }, { full_name: name, avatar_url: 'https://example.com/a.png' }]);
  return rows[0].id;
}

// Run fn(query) as a given user (uid), as an anonymous visitor (null) or as the service role.
async function as(who, fn) {
  await db.query('begin');
  try {
    if (who === 'service') {
      await db.query('set local role service_role');
    } else if (who) {
      await db.query('set local role authenticated');
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: who, role: 'authenticated' })]);
    } else {
      await db.query('set local role anon');
      await db.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
    }
    const out = await fn((sql, params) => db.query(sql, params));
    await db.query('commit');
    return out;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}
const rpc = (who, fn, args = []) =>
  as(who, (q) => q(`select * from public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args)).then((r) => r.rows);
const one = async (who, sql, params) => (await as(who, (q) => q(sql, params))).rows;
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const profile = async (id) => (await db.query('select * from profiles where id=$1', [id])).rows[0];

let ADMIN, ALICE, BOB, CAROL;

// ---------- membership & admin bootstrap ----------
test('users who signed in before the migrations get a profile', async () => {
  const { rows } = await db.query(`select membership_status from profiles where email='early@example.com'`);
  assert.equal(rows[0]?.membership_status, 'pending');
});

test('admin account is bootstrapped from the allowlist (verified Google only)', async () => {
  ADMIN = await newUser('AnimeClubSimats@gmail.com', { name: 'Club Admin' });
  const p = await profile(ADMIN);
  assert.equal(p.is_admin, true);
  assert.equal(p.membership_status, 'approved');

  // same email through another provider, or unverified, must NOT become admin
  await db.query(`delete from auth.users where id=$1`, [ADMIN]);
  const fake = await newUser('animeclubsimats@gmail.com', { provider: 'email', confirmed: true });
  assert.equal((await profile(fake)).is_admin, false);
  await db.query(`delete from auth.users where id=$1`, [fake]);
  const unverified = await newUser('animeclubsimats@gmail.com', { confirmed: false });
  assert.equal((await profile(unverified)).is_admin, false);
  await db.query(`delete from auth.users where id=$1`, [unverified]);

  ADMIN = await newUser('animeclubsimats@gmail.com', { name: 'Club Admin' });
  assert.equal((await profile(ADMIN)).is_admin, true);
});

test('allowlist cannot be read or changed from the website', async () => {
  await rejects(one(null, 'select * from admin_allowlist'), /permission denied/);
  await rejects(one(ADMIN, 'select * from admin_allowlist'), /permission denied/);
  await rejects(one(ADMIN, `insert into admin_allowlist(email) values ('x@y.com')`), /permission denied/);
});

test('new members start pending and cannot promote or approve themselves', async () => {
  ALICE = await newUser('alice@example.com', { name: 'alice g' });
  BOB = await newUser('bob@example.com');
  CAROL = await newUser('carol@example.com');
  const p = await profile(ALICE);
  assert.equal(p.membership_status, 'pending');
  assert.equal(p.is_admin, false);
  assert.equal(p.google_name, 'alice g');

  await rejects(one(ALICE, `update profiles set is_admin=true, membership_status='approved' where id=auth.uid()`), /permission denied/);
  await rejects(one(ALICE, `insert into profiles(id,email) values (gen_random_uuid(),'z@z.com')`), /permission denied/);
  await rejects(rpc(ALICE, 'admin_review_member', [ALICE, true, null]), /Only club admins/);
  await rejects(rpc(ALICE, 'admin_set_admin', [ALICE, true]), /Only club admins/);
  assert.equal((await profile(ALICE)).is_admin, false);
});

test('members only see their own profile; visitors see none', async () => {
  assert.equal((await one(ALICE, 'select id from profiles')).length, 1);
  assert.equal((await one(null, 'select id from profiles')).length, 0);
  assert.ok((await one(ADMIN, 'select id from profiles')).length >= 4);
});

test('name form: validation and awaiting approval', async () => {
  await rejects(rpc(ALICE, 'submit_membership', ['', null, null]), /full name/);
  await rejects(rpc(ALICE, 'submit_membership', ['12345', null, null]), /full name/);
  await rejects(rpc(null, 'submit_membership', ['Alice', null, null]), /permission denied|sign in/);
  const [p] = await rpc(ALICE, 'submit_membership', ['  Alice   Kumar ', '2nd year', 'CSE']);
  assert.equal(p.full_name, 'Alice Kumar');
  assert.equal(p.membership_status, 'awaiting_approval');
  assert.ok(p.requested_at);
  const firstRequest = p.requested_at;
  // editing the name while waiting keeps the original request time (no repeat admin emails)
  const [p2] = await rpc(ALICE, 'submit_membership', ['Alice K', '2nd year', 'CSE']);
  assert.equal(p2.full_name, 'Alice K');
  assert.equal(p2.requested_at.getTime(), firstRequest.getTime());
  await rpc(BOB, 'submit_membership', ['Bob Raj', null, null]);
  await rpc(CAROL, 'submit_membership', ['Carol', null, null]);
});

test('admin approves, rejects and bulk-approves; every decision is logged', async () => {
  await rejects(rpc(ADMIN, 'admin_review_member', [ADMIN, true, null]), /Only members waiting/);
  const [a] = await rpc(ADMIN, 'admin_review_member', [ALICE, true, 'Welcome']);
  assert.equal(a.membership_status, 'approved');
  assert.equal(a.reviewed_by, ADMIN);
  const [c] = await rpc(ADMIN, 'admin_review_member', [CAROL, false, 'Not a SIMATS student']);
  assert.equal(c.membership_status, 'rejected');
  // rejected member may re-apply
  const [c2] = await rpc(CAROL, 'submit_membership', ['Carol Mary', null, null]);
  assert.equal(c2.membership_status, 'awaiting_approval');
  assert.equal(c2.review_note, null);
  const [{ admin_bulk_approve: n }] = await rpc(ADMIN, 'admin_bulk_approve', [[BOB, CAROL, ALICE]]);
  assert.equal(n, 2);
  assert.equal((await profile(BOB)).membership_status, 'approved');
  const log = await rpc(ADMIN, 'admin_list_log', ['member', null, 50]);
  const actions = log.map((l) => l.action);
  assert.ok(actions.includes('member_approved') && actions.includes('member_rejected'));
  // members cannot read the audit log
  assert.equal((await one(ALICE, 'select * from moderation_log')).length, 0);
  await rejects(rpc(ALICE, 'admin_list_log', [null, null, 10]), /Only club admins/);
});

// ---------- polls ----------
let POLL, OPTS, POLL2;
test('admin creates a draft poll; drafts are invisible to members and visitors', async () => {
  await rejects(rpc(ALICE, 'admin_save_poll', [null, 'Q?', null, null, null, JSON.stringify([{ label: 'a' }, { label: 'b' }])]), /Only club admins/);
  await rejects(rpc(ADMIN, 'admin_save_poll', [null, 'What next?', null, null, null, JSON.stringify([{ label: 'Quiz' }])]), /at least two/);
  await rejects(rpc(ADMIN, 'admin_save_poll', [null, 'What next?', null, null, null, JSON.stringify([{ label: 'Quiz' }, { label: 'quiz' }])]), /twice/);
  const [{ admin_save_poll: id }] = await rpc(ADMIN, 'admin_save_poll', [null, 'What should SIMATS Anime Club do next?', 'Pick one',
    null, null, JSON.stringify(['Anime movie screening', 'Cosplay competition', 'Fan art workshop', 'Anime quiz', 'Manga discussion'].map((label) => ({ label })))]);
  POLL = id;
  assert.equal((await one(null, 'select * from polls')).length, 0);
  const [{ get_polls: g }] = await rpc(ALICE, 'get_polls', [true]);
  assert.equal(g.length, 0, 'members never see drafts, even asking for them');
  const [{ get_polls: ga }] = await rpc(ADMIN, 'get_polls', [true]);
  assert.equal(ga.length, 1);
  OPTS = ga[0].options.map((o) => o.id);
  await rejects(rpc(ALICE, 'cast_vote', [POLL, OPTS[0]]), /does not exist/);
});

test('publishing, voting once, and hidden results until you vote', async () => {
  await rpc(ADMIN, 'admin_set_poll_status', [POLL, 'active']);
  const [{ get_polls: anonView }] = await rpc(null, 'get_polls', [false]);
  assert.equal(anonView.length, 1);
  assert.equal(anonView[0].phase, 'open');
  assert.equal(anonView[0].results_visible, false);
  assert.equal(anonView[0].options[0].votes, null);

  await rejects(rpc(null, 'cast_vote', [POLL, OPTS[0]]), /permission denied/);
  await rpc(ALICE, 'cast_vote', [POLL, OPTS[3]]);
  await rejects(rpc(ALICE, 'cast_vote', [POLL, OPTS[1]]), /already voted/);
  await rejects(one(ALICE, `insert into votes(poll_id,user_id,option_id) values ($1, auth.uid(), $2)`, [POLL, OPTS[1]]), /permission denied/);
  await rejects(one(ALICE, `update votes set option_id=$1`, [OPTS[0]]), /permission denied/);
  await rejects(one(ALICE, `update polls set question='hacked'`), /permission denied/);
  await rejects(one(ALICE, `update poll_options set label='hacked'`), /permission denied/);

  const [{ get_polls: aliceView }] = await rpc(ALICE, 'get_polls', [false]);
  assert.equal(aliceView[0].my_option_id, OPTS[3]);
  assert.equal(aliceView[0].results_visible, true);
  assert.equal(aliceView[0].options[3].votes, 1);

  const [{ get_polls: bobView }] = await rpc(BOB, 'get_polls', [false]);
  assert.equal(bobView[0].results_visible, false, 'Bob has not voted, so no counts');
  assert.equal(bobView[0].total_votes, 1);
  await rpc(BOB, 'cast_vote', [POLL, OPTS[3]]);
  // members only see their own vote row
  assert.equal((await one(BOB, 'select * from votes')).length, 1);
});

test('option checks: wrong-poll options, removing voted options, back to draft', async () => {
  const [{ admin_save_poll: id2 }] = await rpc(ADMIN, 'admin_save_poll', [null, 'Snack for next meet?', null, null, null,
    JSON.stringify([{ label: 'Pocky' }, { label: 'Mochi' }])]);
  POLL2 = id2;
  await rpc(ADMIN, 'admin_set_poll_status', [POLL2, 'active']);
  await rejects(rpc(CAROL, 'cast_vote', [POLL2, OPTS[0]]), /not part of this poll/);
  // removing "Anime quiz" (has 2 votes) is refused; editing its label is fine
  const keep = [0, 1, 2, 4].map((i) => ({ id: OPTS[i], label: 'opt' + i }));
  await rejects(rpc(ADMIN, 'admin_save_poll', [POLL, 'What next?', null, null, null, JSON.stringify(keep)]), /already have votes/);
  const relabel = OPTS.map((id, i) => ({ id, label: i === 3 ? 'Anime quiz night' : 'opt' + i }));
  await rpc(ADMIN, 'admin_save_poll', [POLL, 'What next?', null, null, null, JSON.stringify(relabel)]);
  await rejects(rpc(ADMIN, 'admin_set_poll_status', [POLL, 'draft']), /cannot go back to draft/);
});

test('closed and not-yet-open polls refuse votes', async () => {
  await rpc(ADMIN, 'admin_set_poll_status', [POLL, 'closed']);
  await rejects(rpc(CAROL, 'cast_vote', [POLL, OPTS[0]]), /closed/);
  const [{ get_polls: v }] = await rpc(CAROL, 'get_polls', [false]);
  const closed = v.find((p) => p.id === POLL);
  assert.equal(closed.phase, 'closed');
  assert.equal(closed.results_visible, true, 'closed results are public');

  // a poll whose closing time has passed is closed even if still "active"
  await rpc(ADMIN, 'admin_save_poll', [POLL2, 'Snack for next meet?', null, new Date(Date.now() - 86400e3 * 2), new Date(Date.now() - 1000),
    JSON.stringify((await db.query('select id,label from poll_options where poll_id=$1 order by position', [POLL2])).rows)]);
  const opt = (await db.query('select id from poll_options where poll_id=$1 limit 1', [POLL2])).rows[0].id;
  await rejects(rpc(CAROL, 'cast_vote', [POLL2, opt]), /closed/);
  await rpc(ADMIN, 'admin_save_poll', [POLL2, 'Snack for next meet?', null, new Date(Date.now() + 86400e3), null,
    JSON.stringify((await db.query('select id,label from poll_options where poll_id=$1 order by position', [POLL2])).rows)]);
  await rejects(rpc(CAROL, 'cast_vote', [POLL2, opt]), /not opened yet/);
});

// ---------- events & comments ----------
let EV, EV_HIDDEN, CMT;
test('admin events: create, validate, hide', async () => {
  await rejects(rpc(ALICE, 'admin_save_event', [null, 'x', new Date(), null, null, null, null, null, 'scheduled']), /Only club admins/);
  await rejects(rpc(ADMIN, 'admin_save_event', [null, 'Movie night', new Date(), null, null, null, 'http://bad.example/img.png', null, 'scheduled']), /https/);
  [{ admin_save_event: EV }] = await rpc(ADMIN, 'admin_save_event', [null, 'Movie night', new Date(Date.now() + 86400e3), null,
    'Block 3', 'Your Name (2016)', null, 'screening', 'scheduled']);
  [{ admin_save_event: EV_HIDDEN }] = await rpc(ADMIN, 'admin_save_event', [null, 'Secret planning', new Date(Date.now() + 86400e3), null,
    null, null, null, null, 'hidden']);
  const pub = await one(null, 'select id, category from events');
  assert.deepEqual(pub.map((e) => e.id), [EV]);
  assert.equal(pub[0].category, 'SCREENING');
  await rejects(one(ALICE, `insert into events(title,starts_at) values ('x', now())`), /permission denied/);
});

test('comments: pre-moderation, own pending visible to author only', async () => {
  await rejects(rpc(null, 'post_comment', [EV, 'hello']), /permission denied/);
  await rejects(rpc(ALICE, 'post_comment', [EV_HIDDEN, 'hello there']), /does not exist/);
  await rejects(rpc(ALICE, 'post_comment', [EV, ' ']), /Write a little more/);
  await rejects(rpc(ALICE, 'post_comment', [EV, 'x'.repeat(501)]), /500/);
  await rejects(rpc(ALICE, 'post_comment', [EV, 'see http://a.com http://b.com http://c.com']), /two links/);
  await rejects(rpc(ALICE, 'post_comment', [EV, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']), /spam/);
  [CMT] = await rpc(ALICE, 'post_comment', [EV, '<script>alert(1)</script> Can we watch Your Name?']);
  assert.equal(CMT.status, 'pending');
  assert.equal((await rpc(null, 'list_event_comments', [EV])).length, 0);
  assert.equal((await rpc(BOB, 'list_event_comments', [EV])).length, 0);
  const mine = await rpc(ALICE, 'list_event_comments', [EV]);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].is_mine, true);
  assert.equal(mine[0].author_name, 'Alice K');
  assert.equal(mine[0].body, '<script>alert(1)</script> Can we watch Your Name?', 'stored as text; the page escapes it');
  await rejects(rpc(ALICE, 'post_comment', [EV, '<script>alert(1)</script> Can we watch Your Name?']), /already posted/);
  await rejects(one(ALICE, `update comments set status='visible'`), /permission denied/);
});

test('admin approves; others see it; only the author edits or deletes', async () => {
  await rejects(rpc(BOB, 'admin_moderate_comment', [CMT.id, 'approve', null]), /Only club admins/);
  await rpc(ADMIN, 'admin_moderate_comment', [CMT.id, 'approve', null]);
  const pub = await rpc(null, 'list_event_comments', [EV]);
  assert.equal(pub.length, 1);
  assert.ok(!pub[0].is_mine, 'a visitor never owns a comment');
  const [{ comments }] = await rpc(null, 'event_comment_counts', []);
  assert.equal(Number(comments), 1);

  await rejects(rpc(BOB, 'edit_my_comment', [CMT.id, 'hijacked']), /only edit your own/);
  await rejects(rpc(BOB, 'delete_my_comment', [CMT.id]), /only delete your own/);
  const [edited] = await rpc(ALICE, 'edit_my_comment', [CMT.id, 'Can we watch Your Name? Please!']);
  assert.equal(edited.status, 'pending', 'edits are re-checked while pre-moderation is on');
  assert.ok(edited.edited_at);
  await rpc(ADMIN, 'admin_moderate_comment', [CMT.id, 'approve', null]);
});

test('admin hide / remove / restore, and soft delete by author', async () => {
  await rpc(ADMIN, 'admin_moderate_comment', [CMT.id, 'hide', 'Off topic']);
  assert.equal((await rpc(null, 'list_event_comments', [EV])).length, 0);
  const own = await rpc(ALICE, 'list_event_comments', [EV]);
  assert.equal(own[0].status, 'hidden');
  assert.equal(own[0].moderation_reason, 'Off topic');
  await rejects(rpc(ALICE, 'edit_my_comment', [CMT.id, 'try again']), /moderated/);
  await rpc(ADMIN, 'admin_moderate_comment', [CMT.id, 'restore', null]);
  assert.equal((await rpc(null, 'list_event_comments', [EV])).length, 1);

  await rpc(ALICE, 'delete_my_comment', [CMT.id]);
  assert.equal((await rpc(ALICE, 'list_event_comments', [EV])).length, 0);
  const all = await rpc(ADMIN, 'admin_list_comments', ['deleted', 10]);
  assert.equal(all.length, 1, 'deleted comments stay reviewable by admins');
  assert.equal(all[0].author_email, 'alice@example.com');
  await rpc(ADMIN, 'admin_moderate_comment', [CMT.id, 'restore', 'Deleted by mistake']);
});

test('pre-moderation off: comments appear straight away', async () => {
  await rejects(rpc(ALICE, 'admin_set_comment_premoderation', [false]), /Only club admins/);
  await rpc(ADMIN, 'admin_set_comment_premoderation', [false]);
  const [c] = await rpc(BOB, 'post_comment', [EV, 'Count me in!']);
  assert.equal(c.status, 'visible');
  await rpc(ADMIN, 'admin_set_comment_premoderation', [true]);
});

test('spam protection: at most 5 comments in 10 minutes', async () => {
  for (let i = 0; i < 4; i++) await rpc(CAROL, 'post_comment', [EV, `Comment number ${i}`]);
  await rpc(CAROL, 'post_comment', [EV, 'Fifth comment']);
  await rejects(rpc(CAROL, 'post_comment', [EV, 'Sixth comment']), /very fast/);
});

// ---------- suspension ----------
test('suspension blocks voting and commenting at the database; restore lifts it', async () => {
  await rejects(rpc(ADMIN, 'admin_suspend_member', [ADMIN, 'test']), /yourself/);
  await rejects(rpc(ADMIN, 'admin_suspend_member', [BOB, '']), /reason/);
  await rejects(rpc(BOB, 'admin_suspend_member', [ALICE, 'mean']), /Only club admins/);
  const [s] = await rpc(ADMIN, 'admin_suspend_member', [BOB, 'Spamming the comments']);
  assert.equal(s.membership_status, 'suspended');
  assert.equal(s.suspension_reason, 'Spamming the comments');
  assert.ok(s.suspended_at);
  // Bob calls the functions directly, as a tampered page would
  await rejects(rpc(BOB, 'post_comment', [EV, 'still here']), /suspended/);
  await rpc(ADMIN, 'admin_set_poll_status', [POLL, 'active']);
  await rejects(rpc(BOB, 'cast_vote', [POLL, OPTS[0]]), /suspended|already voted/);
  await rejects(rpc(BOB, 'edit_my_comment', [1, 'x']), /suspended/);
  await rejects(rpc(BOB, 'submit_membership', ['Bob again', null, null]), /suspended/);
  // the suspended member can still read their own profile to see why
  const [own] = await one(BOB, 'select membership_status, suspension_reason from profiles');
  assert.equal(own.membership_status, 'suspended');

  await rpc(ADMIN, 'admin_restore_member', [BOB, 'Apologised']);
  const [after] = await rpc(BOB, 'post_comment', [EV, 'Sorry everyone']);
  assert.equal(after.status, 'pending');
  const log = (await rpc(ADMIN, 'admin_list_log', ['member', BOB, 10])).map((l) => l.action);
  assert.ok(log.includes('member_suspended') && log.includes('member_restored'));
});

test('admins: grant, protect the last admin, cannot suspend an admin', async () => {
  await rpc(ADMIN, 'admin_set_admin', [ALICE, true]);
  await rejects(rpc(ADMIN, 'admin_suspend_member', [ALICE, 'test reason']), /Remove admin rights/);
  await rpc(ALICE, 'admin_set_admin', [ALICE, false]);
  await rejects(rpc(ADMIN, 'admin_set_admin', [ADMIN, false]), /at least one admin/);
  await rejects(rpc(ADMIN, 'admin_set_admin', [(await newUser('dave@example.com')), true]), /Only approved/);
});

test('overview numbers', async () => {
  const [{ admin_overview: o }] = await rpc(ADMIN, 'admin_overview', []);
  assert.equal(o.members_approved, 4);
  assert.equal(o.members_no_name, 2);
  assert.ok(o.votes_7d >= 2);
  assert.ok(o.comments_pending >= 1);
  assert.ok(Array.isArray(o.recent_votes) && !('user_id' in o.recent_votes[0]), 'votes listed without voters');
  await rejects(rpc(BOB, 'admin_overview', []), /Only club admins/);
});

// ---------- Drive sync ----------
const row = (id, title, extra = {}) => ({ external_id: id, title, starts_at: new Date(Date.now() + 7 * 86400e3).toISOString(),
  ends_at: '', venue: 'Hall A', description: 'desc', image_url: '', category: 'QUIZ', status: 'scheduled', hash: 'h-' + title, ...extra });
const newLog = async () => (await db.query(`insert into event_sync_logs(trigger) values ('cron') returning id`)).rows[0].id;
const sync = (rows) => newLog().then((id) => rpc('service', 'apply_event_sync', [id, JSON.stringify(rows)]));

test('sync function is server-only', async () => {
  const id = await newLog();
  await rejects(rpc(ADMIN, 'apply_event_sync', [id, '[]']), /permission denied/);
  await rejects(rpc(null, 'apply_event_sync', [id, '[]']), /permission denied/);
});

test('sync inserts, skips unchanged, updates changed, hides removed, keeps manual events', async () => {
  let [{ apply_event_sync: r }] = await sync([row('ev-1', 'Quiz'), row('ev-2', 'Cosplay walk')]);
  assert.deepEqual([r.inserted, r.updated, r.unchanged, r.hidden], [2, 0, 0, 0]);
  [{ apply_event_sync: r }] = await sync([row('ev-1', 'Quiz'), row('ev-2', 'Cosplay walk')]);
  assert.deepEqual([r.inserted, r.updated, r.unchanged], [0, 0, 2]);
  [{ apply_event_sync: r }] = await sync([row('ev-1', 'Quiz finals'), row('ev-2', 'Cosplay walk')]);
  assert.equal(r.updated, 1);
  assert.equal((await db.query(`select title from events where external_id='ev-1'`)).rows[0].title, 'Quiz finals');

  // admin edits ev-2: the sheet no longer overwrites it
  const ev2 = (await db.query(`select id from events where external_id='ev-2'`)).rows[0].id;
  await rpc(ADMIN, 'admin_save_event', [ev2, 'Cosplay walk (moved)', new Date(Date.now() + 9 * 86400e3), null, 'Hall B', null, null, 'COSPLAY', 'scheduled']);
  [{ apply_event_sync: r }] = await sync([row('ev-1', 'Quiz finals'), row('ev-2', 'Cosplay walk v2')]);
  assert.equal(r.kept_admin_edits, 1);
  assert.equal((await db.query('select title from events where id=$1', [ev2])).rows[0].title, 'Cosplay walk (moved)');

  // ev-1 disappears from the sheet: hidden, not deleted; manual events untouched
  [{ apply_event_sync: r }] = await sync([row('ev-3', 'Art jam')]);
  assert.equal(r.hidden, 1);
  assert.equal((await db.query(`select status from events where external_id='ev-1'`)).rows[0].status, 'hidden');
  assert.equal((await db.query('select status from events where id=$1', [EV])).rows[0].status, 'scheduled');
});

test('a failed or empty import leaves events untouched', async () => {
  const before = (await db.query('select id, status, title from events order by id')).rows;
  await rejects(sync([]), /no valid events/);
  await rejects(sync([row('ev-9', 'Bad', { starts_at: 'not a date' })]), /invalid input syntax|date/);
  const afterRows = (await db.query('select id, status, title from events order by id')).rows;
  assert.deepEqual(afterRows, before);
});

test('deleting a Drive event hides it; deleting a manual event removes it', async () => {
  const ev3 = (await db.query(`select id from events where external_id='ev-3'`)).rows[0].id;
  const [{ admin_delete_event: a }] = await rpc(ADMIN, 'admin_delete_event', [ev3]);
  assert.equal(a, 'hidden');
  const [{ apply_event_sync: r }] = await sync([row('ev-3', 'Art jam')]);
  assert.equal(r.kept_admin_edits, 1, 'stays hidden after the next sync');
  const [{ admin_delete_event: b }] = await rpc(ADMIN, 'admin_delete_event', [EV_HIDDEN]);
  assert.equal(b, 'deleted');
});

test('comments on hidden events are not listed', async () => {
  await rpc(ADMIN, 'admin_save_event', [EV, 'Movie night', new Date(Date.now() + 86400e3), null, 'Block 3', null, null, null, 'hidden']);
  assert.equal((await rpc(null, 'list_event_comments', [EV])).length, 0);
  await rejects(rpc(ALICE, 'post_comment', [EV, 'anyone?']), /does not exist/);
});

test('poll deletion is logged with its results', async () => {
  await rpc(ADMIN, 'admin_delete_poll', [POLL]);
  const [entry] = (await rpc(ADMIN, 'admin_list_log', ['poll', POLL, 5])).filter((l) => l.action === 'poll_deleted');
  assert.equal(entry.details.votes, 2);
  assert.equal(entry.details.results['Anime quiz night'], 2);
});

test('only the intended functions are callable from the website', async () => {
  const q = (role) => db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and has_function_privilege($1, p.oid, 'execute') order by 1`, [role]);
  const anon = (await q('anon')).rows.map((r) => r.proname);
  assert.deepEqual(anon, ['event_comment_counts', 'get_polls', 'is_admin', 'is_approved_member', 'list_event_comments']);
  const authed = (await q('authenticated')).rows.map((r) => r.proname);
  for (const internal of ['_log', '_require_admin', '_require_member', 'handle_new_user', 'apply_event_sync', 'touch_updated_at']) {
    assert.ok(!authed.includes(internal), internal + ' must not be callable');
  }
  await rejects(rpc(ALICE, '_log', ['fake', 'member', 'x', null, '{}']), /permission denied/);
});

test('club account becomes admin even when Google verification lands a moment after sign-up', async () => {
  await db.query(`delete from auth.users where email in ('animeclubsimats@gmail.com')`);
  const { rows } = await db.query(`insert into auth.users (email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
    values ('animeclubsimats@gmail.com', null, '{"provider":"google","providers":["google"]}', '{"full_name":"SIMATS Anime Club"}') returning id`);
  const id = rows[0].id;
  assert.equal((await profile(id)).is_admin, false, 'not yet verified');
  await db.query(`update auth.users set email_confirmed_at = now() where id = $1`, [id]);
  const p = await profile(id);
  assert.equal(p.is_admin, true);
  assert.equal(p.membership_status, 'approved');
  // an account that also has an email/password identity is never promoted
  await db.query(`update profiles set is_admin=false, membership_status='pending' where id=$1`, [id]);
  await db.query(`update auth.users set raw_app_meta_data = '{"provider":"google","providers":["google","email"]}' where id = $1`, [id]);
  assert.equal((await profile(id)).is_admin, false);
  await db.query(`update auth.users set raw_app_meta_data = '{"provider":"google","providers":["google"]}' where id = $1`, [id]);
  assert.equal((await profile(id)).is_admin, true);
  // other accounts are unaffected by updates
  await db.query(`update auth.users set email_confirmed_at = now() where email = 'alice@example.com'`);
  assert.equal((await db.query(`select is_admin from profiles where email='alice@example.com'`)).rows[0].is_admin, false);
});
