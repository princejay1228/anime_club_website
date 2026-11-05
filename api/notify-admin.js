// /api/notify-admin  (POST, with the member's session token)
// Called by the members page right after someone submits the name form.
// Emails the club admin once per request (never repeatedly for the same
// request), using Resend. If email isn't configured, the request still
// shows up in the admin dashboard, so nothing is lost.
import { serviceClient, requireUser, redact, send, wrap, HttpError } from './_lib/server.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function buildEmail(profile, waiting, siteUrl) {
  const link = `${(siteUrl || 'https://simats-anime-club.vercel.app').replace(/\/+$/, '')}/admin#approvals`;
  const rows = [['Name', profile.full_name], ['Email', profile.email], ['Year', profile.year_of_study], ['Department', profile.department], ['Google name', profile.google_name]]
    .filter(([, v]) => v);
  const subject = `New member request: ${profile.full_name}`.slice(0, 120);
  const text = `${profile.full_name} (${profile.email}) wants to join SIMATS Anime Club.\n\n`
    + rows.map(([k, v]) => `${k}: ${v}`).join('\n')
    + `\n\n${waiting} request${waiting === 1 ? '' : 's'} waiting in total.\nReview: ${link}\n`;
  const html = `<div style="font-family:Arial,sans-serif;background:#0b0305;color:#fff1eb;padding:24px;border-radius:12px;max-width:520px">
  <div style="background:#a8001c;color:#fff3dc;display:inline-block;padding:4px 10px;font-size:11px;letter-spacing:3px;font-weight:bold">NEW MEMBER REQUEST</div>
  <h2 style="color:#f6dca0;margin:14px 0 6px">${esc(profile.full_name)}</h2>
  <table style="font-size:14px;color:#e7d3d5;border-collapse:collapse">${rows.map(([k, v]) =>
    `<tr><td style="padding:4px 14px 4px 0;color:#e6c06f">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('')}</table>
  <p style="color:#cdb4b6;font-size:13px">${waiting} request${waiting === 1 ? '' : 's'} waiting in total.</p>
  <a href="${esc(link)}" style="display:inline-block;background:#a8001c;color:#fff3dc;padding:12px 20px;text-decoration:none;font-weight:bold;letter-spacing:2px;font-size:12px">REVIEW REQUESTS</a>
</div>`;
  return { subject, text, html };
}

export async function notify({ sb, env, profile, fetchImpl = fetch }) {
  if (profile.membership_status !== 'awaiting_approval' || !profile.requested_at) {
    return { sent: false, reason: 'not-waiting' };
  }
  if (profile.admin_notified_at && new Date(profile.admin_notified_at) >= new Date(profile.requested_at)) {
    return { sent: false, reason: 'already-notified' };
  }
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'email-not-configured' };

  // Claim the notification first so two quick calls can't send two emails.
  const now = new Date().toISOString();
  let claim = sb.from('profiles').update({ admin_notified_at: now }).eq('id', profile.id).eq('membership_status', 'awaiting_approval');
  claim = profile.admin_notified_at ? claim.lt('admin_notified_at', profile.requested_at) : claim.is('admin_notified_at', null);
  const { data: claimed, error } = await claim.select('id');
  if (error) throw new HttpError(500, 'Could not update the profile.');
  if (!claimed?.length) return { sent: false, reason: 'already-notified' };

  const { count } = await sb.from('profiles').select('id', { count: 'exact', head: true }).eq('membership_status', 'awaiting_approval');
  const mail = buildEmail(profile, count ?? 1, env.SITE_URL);
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.NOTIFY_FROM || 'SIMATS Anime Club <onboarding@resend.dev>',
      to: [env.ADMIN_EMAIL || 'animeclubsimats@gmail.com'],
      reply_to: profile.email,
      subject: mail.subject, text: mail.text, html: mail.html,
    }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));

  if (!res.ok) {
    // give the claim back so a later attempt can try again
    await sb.from('profiles').update({ admin_notified_at: profile.admin_notified_at }).eq('id', profile.id);
    const detail = redact(await res.text().catch(() => ''), env).slice(0, 200);
    console.error('[notify-admin] email failed', res.status, detail);
    return { sent: false, reason: 'email-failed' };
  }
  return { sent: true };
}

export default wrap(async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); throw new HttpError(405, 'Method not allowed.'); }
  const sb = serviceClient();
  const { profile } = await requireUser(sb, req);
  return send(res, 200, await notify({ sb, env: process.env, profile }));
});
