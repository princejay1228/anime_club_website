// /api/sync-events
//   GET  — weekly Vercel Cron run. Vercel sends "Authorization: Bearer <CRON_SECRET>".
//   POST — manual refresh from the admin dashboard, with the admin's session token.
//
// Reads the events sheet, validates every row, then applies the changes in
// one database transaction (apply_event_sync). If anything fails, the events
// table keeps its last good state and the failure is logged.
import { runGallerySync } from './_lib/google-drive.js';
import { serviceClient, requireAdmin, bearer, safeEqual, redact, send, wrap, HttpError } from './_lib/server.js';
import { readEventSheet, describeSource } from './_lib/drive-source.js';
import { normalizeRows } from './_lib/events-normalize.js';

export async function runSync({ sb, env, trigger, triggeredBy, fetchImpl = fetch }) {
  const source = describeSource(env);
  const { data: log, error: logErr } = await sb.from('event_sync_logs')
    .insert({ trigger, triggered_by: triggeredBy || null, details: { source } })
    .select('id').single();
  if (logErr) throw new HttpError(500, 'Could not start the sync log: ' + logErr.message);

  const fail = async (message, extra = {}) => {
    const error = redact(message, env);
    await sb.from('event_sync_logs').update({
      status: 'failed', finished_at: new Date().toISOString(), error, details: { source, ...extra },
    }).eq('id', log.id);
    return { ok: false, logId: log.id, error, ...extra };
  };

  let values;
  try {
    values = await readEventSheet(env, fetchImpl);
  } catch (e) {
    return fail(e.message);
  }

  const { rows, skipped, rowsRead, warnings } = normalizeRows(values);
  await sb.from('event_sync_logs').update({ rows_read: rowsRead, skipped }).eq('id', log.id);
  if (rows.length === 0) {
    return fail(warnings[0] || 'No valid events were found in the sheet; the current events were kept.',
                { rows_read: rowsRead, skipped, warnings: warnings.slice(0, 25) });
  }

  const { data: result, error } = await sb.rpc('apply_event_sync', { p_log_id: log.id, p_rows: rows });
  if (error) return fail('Saving events failed: ' + error.message, { rows_read: rowsRead, skipped, warnings: warnings.slice(0, 25) });

  if (warnings.length) {
    const { data: cur } = await sb.from('event_sync_logs').select('details').eq('id', log.id).single();
    await sb.from('event_sync_logs').update({ details: { ...(cur?.details || {}), warnings: warnings.slice(0, 25) } }).eq('id', log.id);
  }
  return { ok: true, logId: log.id, rows_read: rowsRead, skipped, warnings: warnings.slice(0, 25), ...result };
}

export default wrap(async (req, res) => {
  const env = process.env;
  if (req.method === 'GET') {
    // Cron: only with the shared secret. With no secret configured, refuse to run at all.
    if (!env.CRON_SECRET) throw new HttpError(500, 'CRON_SECRET is not set, so scheduled syncs are disabled.');
    if (!safeEqual(bearer(req), env.CRON_SECRET)) throw new HttpError(401, 'Not allowed.');
    const sb = serviceClient(env);
    const out = await runSync({ sb, env, trigger: 'cron' });
    // the gallery refreshes on the same weekly run (a failure here never affects the events)
    if (env.GOOGLE_API_KEY) {
      out.gallery = await runGallerySync({ sb, env }).catch((e) => ({ ok: false, error: redact(e.message, env) }));
    }
    return send(res, out.ok ? 200 : 502, out);
  }
  if (req.method === 'POST') {
    const sb = serviceClient(env);
    const { user } = await requireAdmin(sb, req);
    // one manual sync per minute is plenty
    const { data: last } = await sb.from('event_sync_logs').select('started_at')
      .eq('trigger', 'manual').order('started_at', { ascending: false }).limit(1).maybeSingle();
    if (last && Date.now() - new Date(last.started_at).getTime() < 60_000) {
      throw new HttpError(429, 'A sync was started less than a minute ago. Please wait a moment.');
    }
    const out = await runSync({ sb, env, trigger: 'manual', triggeredBy: user.id });
    await sb.from('moderation_log').insert({
      actor_id: user.id, action: out.ok ? 'sync_manual_success' : 'sync_manual_failed',
      target_type: 'sync', target_id: String(out.logId), details: { inserted: out.inserted, updated: out.updated, hidden: out.hidden, error: out.error },
    });
    return send(res, out.ok ? 200 : 502, out);
  }
  res.setHeader('allow', 'GET, POST');
  throw new HttpError(405, 'Method not allowed.');
});
