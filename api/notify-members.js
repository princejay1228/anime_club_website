// /api/notify-members  (POST { notice_id }, with an admin's session token)
// Emails a notice (or a meeting cancellation) to every approved member, from
// the club Gmail account, using a Gmail app password (GMAIL_APP_PASSWORD).
// Each notice is emailed at most once: the notice row is claimed first.
// Members are BCC'd, so nobody sees anyone else's address.
// If email isn't set up or fails, the notice is still on the site (bell icon).
import nodemailer from 'nodemailer';
import { serviceClient, requireAdmin, redact, send, wrap, HttpError } from './_lib/server.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@<>(),;:"\[\]\\]+@[^\s@<>(),;:"\[\]\\]+\.[a-z]{2,}$/i;
export const BATCH = 90;                         // BCC recipients per message (Gmail allows up to 500)

export function gmailUser(env) { return (env.GMAIL_USER || 'animeclubsimats@gmail.com').trim(); }

export function buildNoticeEmail(notice, siteUrl) {
  const base = (siteUrl || 'https://simats-anime-club.vercel.app').replace(/\/+$/, '');
  const link = `${base}/members#notices`;
  const cancelled = notice.kind === 'cancellation';
  const tag = cancelled ? 'MEETING CANCELLED' : 'CLUB NOTICE';
  const subject = (cancelled ? notice.title : `Notice: ${notice.title}`).replace(/[\r\n]+/g, ' ').slice(0, 140);
  const text = `${tag}\n\n${notice.title}\n\n${notice.body}\n\nSee all notices: ${link}\n\n`
    + `You get this because you're an approved member of SIMATS Anime Club.\n`;
  const paras = String(notice.body).split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 12px;line-height:1.55">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;background:#0b0305;color:#fff1eb;padding:24px;border-radius:12px;max-width:560px">
  <div style="background:${cancelled ? '#a8001c' : '#7a5a1e'};color:#fff3dc;display:inline-block;padding:4px 10px;font-size:11px;letter-spacing:3px;font-weight:bold">${tag}</div>
  <h2 style="color:#f6dca0;margin:14px 0 12px">${esc(notice.title)}</h2>
  <div style="font-size:15px;color:#efdcdd">${paras}</div>
  <a href="${esc(link)}" style="display:inline-block;margin-top:8px;background:#a8001c;color:#fff3dc;padding:12px 20px;text-decoration:none;font-weight:bold;letter-spacing:2px;font-size:12px">OPEN THE MEMBER LOUNGE</a>
  <p style="color:#9c8487;font-size:11px;margin-top:20px">You get this because you're an approved member of SIMATS Anime Club.</p>
</div>`;
  return { subject, text, html };
}

export function defaultTransport(env) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: gmailUser(env), pass: String(env.GMAIL_APP_PASSWORD).replace(/\s+/g, '') },
  });
}

export async function notifyMembers({ sb, env, noticeId, makeTransport = defaultTransport }) {
  if (!env.GMAIL_APP_PASSWORD) return { sent: 0, reason: 'email-not-configured' };
  const id = Number(noticeId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Which notice? (notice_id missing)');

  // Claim the notice so a double click or a retry can't email everyone twice.
  const { data: claimed, error } = await sb.from('notices').update({ emailed_at: new Date().toISOString(), email_error: null })
    .eq('id', id).is('emailed_at', null).is('deleted_at', null).select('id,kind,title,body');
  if (error) throw new HttpError(500, 'Could not load the notice.');
  if (!claimed?.length) return { sent: 0, reason: 'already-emailed-or-missing' };
  const notice = claimed[0];

  const { data: members, error: mErr } = await sb.from('profiles').select('email').eq('membership_status', 'approved').limit(5000);
  if (mErr) {
    await sb.from('notices').update({ emailed_at: null, email_error: 'Could not read the member list.' }).eq('id', id);
    throw new HttpError(500, 'Could not read the member list.');
  }
  const to = [...new Set((members || []).map((m) => String(m.email || '').trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))];
  if (!to.length) {
    await sb.from('notices').update({ email_count: 0 }).eq('id', id);
    return { sent: 0, reason: 'no-members' };
  }

  const mail = buildNoticeEmail(notice, env.SITE_URL);
  const from = gmailUser(env);
  const transport = makeTransport(env);
  let sent = 0, failure = null;
  for (let i = 0; i < to.length; i += BATCH) {
    const bcc = to.slice(i, i + BATCH);
    try {
      await transport.sendMail({ from: `SIMATS Anime Club <${from}>`, to: from, bcc, subject: mail.subject, text: mail.text, html: mail.html });
      sent += bcc.length;
    } catch (e) {
      failure = redact(e?.response || e?.message || e, env).slice(0, 300);
      console.error('[notify-members] batch failed', failure);
      break;                                       // stop on the first failure (bad password, daily limit)
    }
  }
  transport.close?.();

  if (!sent) {
    // nothing went out: give the claim back so the admin can retry
    await sb.from('notices').update({ emailed_at: null, email_error: failure }).eq('id', id);
    return { sent: 0, failed: to.length, reason: 'email-failed', error: failure };
  }
  await sb.from('notices').update({ email_count: sent, email_error: failure }).eq('id', id);
  return failure ? { sent, failed: to.length - sent, reason: 'partly-sent', error: failure } : { sent, failed: 0 };
}

export default wrap(async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); throw new HttpError(405, 'Method not allowed.'); }
  const sb = serviceClient();
  await requireAdmin(sb, req);
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  return send(res, 200, await notifyMembers({ sb, env: process.env, noticeId: body.notice_id }));
});
