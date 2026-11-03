# Club Hub backend — setup, deployment and testing report

This adds a members area to the existing site without changing the intro, the cherry blossoms, the oni transition, the logo or Benio:

- **Google sign-in** (Supabase Auth). New members give their full name, and **an admin approves every member** before they can vote or comment.
- **Polls** ("What should SIMATS Anime Club do next?"): drafts, opening/closing times, one vote per member, results shown after voting.
- **Event comments** with admin review, editing and soft delete.
- **Admin dashboard** at `/admin`: overview, approvals, members (suspend/restore, co-admins), polls, comment moderation, events and Drive sync, activity log.
- **Weekly event sync from a Google Sheet** (Vercel Cron, Mondays 06:00 IST), plus a manual refresh button.
- **Email to animeclubsimats@gmail.com** whenever someone asks to join.

## Files

| Path | What it is |
|---|---|
| `members.html`, `assets/club/members.js` | Club Hub: membership card, polls, events, comments |
| `admin.html`, `assets/club/admin.js` | Admin dashboard |
| `assets/club/club.css`, `assets/club/club.js` | Shared theme and browser helpers |
| `assets/club/config.js` | Public Supabase URL + publishable key (**paste the key here**) |
| `assets/club/vendor/supabase.js` | Pinned copy of supabase-js (no CDN needed) |
| `api/sync-events.js` | Drive → events sync (cron GET + admin POST) |
| `api/notify-admin.js` | Emails the admin about a new request |
| `api/_lib/*` | Sheet reader, row validation, auth helpers (not public endpoints) |
| `supabase/migrations/*.sql` | Database schema, Row Level Security, functions |
| `supabase/cleanup_earlier_draft.sql` | Only if you ran the draft SQL from chat earlier |
| `docs/events-sheet-template.csv` | Columns for the events sheet |
| `tests/`, `supabase/tests/` | Automated tests (not deployed, see `.vercelignore`) |
| `index.html` | Small additions only: "Club Hub" chip in the header bar, "Vote & comment" button, footer links, Drive events merged into Upcoming Events with a "Talk about it" link |
| `privacy.html` | Updated: the site now stores data for signed-in members |

## How security works

The browser never decides who may do what.

1. **Row Level Security is on for every table.** The website's roles can only *read* through policies (public events/polls, approved comments, your own profile and vote). Direct inserts, updates and deletes are revoked.
2. **Every write is a database function** (`cast_vote`, `post_comment`, `admin_suspend_member`, …). Each one checks the caller (`auth.uid()`), their membership status and admin rights, validates the input, and writes the audit log in the same transaction. A pending, rejected or suspended member calling these functions directly gets the same refusal as the page shows.
3. **One vote per member** is the table's primary key `(poll_id, user_id)`, and votes on closed or not-yet-open polls are refused in the database.
4. **Nobody can make themselves admin.** Admin rights come from `admin_allowlist` (only `animeclubsimats@gmail.com`), granted on first sign-in and only for a verified Google account. The allowlist cannot be read or changed from the website. Admins can then make other approved members co-admins; the last admin can't be removed.
5. **Secrets stay on the server.** The service role key, Google key, Resend key and cron secret exist only in Vercel environment variables. The cron endpoint refuses to run without `CRON_SECRET`; manual sync re-checks admin rights on the server.
6. **User text is never rendered as HTML.** Comments, names and event text are inserted with `textContent`, and the admin email escapes everything.
7. **Activity log** (`moderation_log`) records approvals, rejections, suspensions, restores, admin changes, poll changes, comment moderation, event edits and manual syncs. It is append-only from the website.

## Setup (about 30 minutes)

### 1. Database
In Supabase → **SQL Editor → New query**, paste all of **`supabase/setup_all.sql`** and press **Run**. It is the four migrations in order plus a safety check: it removes the early draft tables from chat if they exist, gives a profile to anyone who already signed in, and refuses to run a second time. If you ran an older copy of the setup and the admin page doesn't appear for the club account, run **`supabase/fix_admin.sql`** (safe to repeat; it ends with a table of every account). (With the Supabase CLI you can instead `supabase link` + `supabase db push` the files in `supabase/migrations/`.)

### 2. Supabase Auth
1. **Authentication → Sign In / Providers → Google**: already enabled.
2. **Authentication → URL Configuration**
   - Site URL: `https://simats-anime-club.vercel.app`
   - Redirect URLs: `https://simats-anime-club.vercel.app/**` (and `https://*-princejay1228s-projects.vercel.app/**` if you want preview deployments to sign in; check your real preview domain in Vercel).
3. Recommended: turn off the **Email** provider so Google is the only way in.
4. In Google Cloud → **OAuth consent screen**, publish the app (or add testers) so students can sign in.

### 3. Website config
Done: `assets/club/config.js` holds the project URL and the **publishable key** (`sb_publishable_…`). It is safe to publish. Never put the service role / secret key there.

### 4. Vercel environment variables
Vercel → Project → Settings → **Environment Variables** (see `.env.example`):

| Variable | Required | Value |
|---|---|---|
| `SUPABASE_URL` | yes | `https://kfpcqjjwsrveqzlzvlml.supabase.co` |
| `SUPABASE_SECRET_KEY` | yes | Supabase → API Keys → the `sb_secret_…` key (the legacy `SUPABASE_SERVICE_ROLE_KEY` also works) |
| `CRON_SECRET` | yes | any long random string (`openssl rand -hex 32`). Vercel sends it to the cron automatically |
| `EVENTS_SHEET_ID` | one source | the ID in the sheet link (`/d/<ID>/edit`) |
| `EVENTS_SHEET_RANGE` | no | tab name, default `Events` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | with sheet ID | the service account's email |
| `GOOGLE_PRIVATE_KEY` | with sheet ID | `private_key` from the service account JSON (paste as is) |
| `EVENTS_CSV_URL` | other source | a sheet published to the web as CSV (public link) |
| `RESEND_API_KEY` | for emails | from resend.com |
| `ADMIN_EMAIL` | no | default `animeclubsimats@gmail.com` |
| `NOTIFY_FROM` | no | default `SIMATS Anime Club <onboarding@resend.dev>` |
| `SITE_URL` | no | default `https://simats-anime-club.vercel.app` |

### 5. Events sheet (Google Drive)
1. Create a Google Sheet with a tab named **Events** and the columns from `docs/events-sheet-template.csv`. Only **Title** and **Date** are required. Dates may be `14/11/2026`, `2026-11-14` or `14 Nov 2026`; times `3:30 PM` or `15:30` (India time). Status: Scheduled, Postponed, Cancelled, Completed or Hidden. Image: an https link or a Drive file link (file shared as "Anyone with the link").
2. **Keep the ID column filled** (any short unique text per row). It is how the sync recognises an event when you rename it; without it, a renamed event counts as a new one.
3. Connect it (pick one):
   - **Private sheet (recommended):** Google Cloud console → enable **Google Sheets API** → IAM → Service Accounts → create one → Keys → Add key → JSON. Share the sheet with the service account email as **Viewer**. Set `EVENTS_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`. Do not commit the JSON file.
   - **Public CSV:** File → Share → Publish to web → Events tab → CSV. Set `EVENTS_CSV_URL`.
4. Sync rules: new rows are added, changed rows updated, rows removed from the sheet are **hidden** (not deleted). Events added by hand in the dashboard are never touched, and a Drive event you edit in the dashboard stops syncing until you press "Let sync manage". If the sheet can't be read or has no valid rows, the sync fails, is logged, and the site keeps the last good events.

### 6. Admin email (Resend)
Create a free Resend account **with animeclubsimats@gmail.com** and set `RESEND_API_KEY`. With the default `onboarding@resend.dev` sender, Resend only delivers to the account's own address, which is exactly the admin inbox. If email isn't configured, requests still appear in the dashboard.

### 7. Deploy safely
1. Push to a new branch (not `main`) → Vercel builds a **preview** URL. Production is untouched.
2. Sign in on the preview with **animeclubsimats@gmail.com** first: that account becomes admin.
3. Walk through the checklist below. When happy, merge to `main` for production.

## Admin quick guide
- **Approvals**: approve or reject each request (or tick several and "Approve selected"). Rejected members see your note and can re-apply.
- **Members**: suspend (reason required, the member sees it), restore, make admin, view history.
- **Polls**: new polls start as drafts → Publish → Close (results become public). Options with votes can be renamed, not removed.
- **Comments**: with "Review new comments" on, comments wait for approval; edits are re-checked. Hide / Remove (with reason) / Restore. Deleted comments stay reviewable.
- **Events**: Refresh from Drive, see each sync's counts, warnings and errors; add or edit events by hand.

## Testing report (3 November 2026)

All automated tests were run and pass. Nothing below was claimed without running it.

| Suite | How | Result |
|---|---|---|
| Database rules — `npm run test:db` | Real migrations on PostgreSQL 16 with a small stand-in for Supabase's `auth` schema and API roles; each check runs as a visitor, a member or an admin | **28 / 28 pass** |
| Server functions — `npm test` | Sheet parsing, Google service-account token signing (verified with a real RSA key), sync runner, cron/admin protection, admin email; Google, Resend and Supabase faked | **16 / 16 pass** |
| Browser walkthrough — `tests/e2e/run.mjs` | Real pages in headless Chrome against Postgres + **PostgREST 12** (the REST layer Supabase uses) + the real `/api` functions | **13 / 13 pass**, run 3 times in a row |

**Covered:** visitor view and empty states; admin page refused to visitors and members; name form validation (name, Code of Conduct tick) and one admin email per request; pending members refused when calling functions directly; non-admins refused by admin functions, the manual sync endpoint and direct table updates; approving (single and bulk), rejecting and re-applying; poll draft → publish → vote → close/reopen; duplicate vote refused in the database; results hidden until you vote; closed and not-yet-open polls refuse votes; options with votes can't be removed; comments pre-moderated, HTML in comments shown as text, edit re-checks, soft delete and restore, 5-per-10-minutes rate limit and duplicate check; suspension blocks voting/commenting/editing even through direct calls and shows the member the reason; restore; last-admin protection; Drive sync insert/update/unchanged/hide, admin edits kept, manual events untouched, empty or failed import leaves events unchanged, cron needs the secret, secrets redacted from logged errors; only the intended database functions are callable from the website; activity log entries; home page shows Drive events with comment links and the Club Hub chip; no sideways scrolling at phone width (390 px); no JavaScript errors on any page.

**Not tested here (needs your accounts, please check on the preview deployment):**
1. Real Google sign-in and the redirect back to `/members` and `/admin`.
2. The migrations on your actual Supabase project.
3. Reading your real Google Sheet with your service account.
4. A real email arriving through Resend.
5. The Vercel cron firing on its schedule (you can trigger it from Vercel → Settings → Cron Jobs → Run).
6. The production build/deploy on Vercel.

**Preview checklist:** sign in as admin → open `/admin` → sign in with a second Google account on another browser → submit name → check the Gmail notification → approve → create and publish a poll → vote → comment → approve the comment → Refresh from Drive → suspend and restore the test account.

### Running the tests yourself
```bash
npm install
npm test                                              # server functions
PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=... npm run test:db   # needs a local Postgres 15+
# browser walkthrough: also needs PostgREST and Chrome
npm i --no-save puppeteer-core
PGPASSWORD=... POSTGREST_BIN=/path/to/postgrest CHROME_BIN=/path/to/chrome node tests/e2e/run.mjs
```
