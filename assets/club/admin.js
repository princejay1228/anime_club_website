/* Admin dashboard. The page only shows the tools; the database refuses every
   admin function unless the signed-in account really is an approved admin. */
(function () {
  'use strict';
  const C = window.Club;
  const { h, $, $$, toast, busy, ask, rpc, state } = C;
  const view = $('#view');
  const TABS = ['overview', 'approvals', 'members', 'polls', 'comments', 'events', 'log'];
  let tab = 'overview';
  let started = false;

  // ---------- small building blocks ----------
  const section = (title, sub, ...actions) => h('div', { class: 'sec-head' },
    h('div', null, h('h2', { text: title }), sub ? h('p', { text: sub }) : null), actions.length ? h('div', { class: 'row' }, actions) : null);
  const btn = (label, onclick, cls = '') => h('button', { class: 'btn small ' + cls, type: 'button', text: label, onclick });
  const loading = () => view.replaceChildren(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  const failed = (e, retry) => view.replaceChildren(h('div', { class: 'state err' }, h('span', { class: 'big', text: 'Could not load this section' }),
    e.message, h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' }, btn('Try again', retry))));
  const empty = (title, text) => h('div', { class: 'state' }, h('span', { class: 'big', text: title }), text || '');
  const STATUS_TAG = {
    approved: ['MEMBER', 'ok'], awaiting_approval: ['WAITING', 'warn'], pending: ['NO NAME YET', 'dim'],
    rejected: ['REJECTED', 'pink'], suspended: ['SUSPENDED', ''],
  };
  const when = (t) => (C.isMidnightIst(t) ? C.fmtDate(t) + ', time TBA' : C.fmtDateTime(t));
  const statusTag = (s) => { const t = STATUS_TAG[s] || [s, 'dim']; return h('span', { class: 'tag ' + t[1], text: t[0] }); };

  // Run an admin action from a button: spinner, toast, then refresh.
  function act(button, fn, okMsg, after = render) {
    return busy(button, async () => {
      try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok'); await refreshBadges(); await after(); }
      catch (e) { toast(e.message, 'err'); }
    });
  }

  async function refreshBadges() {
    try {
      const o = await rpc('admin_overview');
      const set = (el, n) => { el.hidden = !n; el.textContent = n; };
      set($('#bAppr'), o.members_awaiting); set($('#bCmt'), o.comments_pending);
      return o;
    } catch { return null; }
  }

  // ======================= OVERVIEW =======================
  async function renderOverview() {
    loading();
    let o;
    try { o = await refreshBadges(); if (!o) o = await rpc('admin_overview'); } catch (e) { return failed(e, renderOverview); }
    const stat = (n, l, s, alert, href) => {
      const el = h(href ? 'a' : 'div', { class: 'stat' + (alert ? ' alert' : ''), href, style: href ? 'text-decoration:none;color:inherit' : null },
        h('div', { class: 'n', text: String(n) }), h('div', { class: 'l', text: l }), s ? h('div', { class: 's', text: s }) : null);
      return el;
    };
    const last = o.last_sync;
    const syncText = o.last_sync_success ? C.ago(o.last_sync_success) : 'never';
    view.replaceChildren(
      h('div', { class: 'stats' },
        stat(o.members_approved, 'Members', `${o.members_total} signed in · ${o.members_suspended} suspended`, false, '#members'),
        stat(o.members_awaiting, 'Waiting approval', o.members_no_name ? `${o.members_no_name} signed in without a name yet` : 'Requests to review', o.members_awaiting > 0, '#approvals'),
        stat(o.active_polls, 'Active polls', 'Open for voting now', false, '#polls'),
        stat(o.votes_7d, 'Votes', 'In the last 7 days', false, '#polls'),
        stat(o.comments_7d, 'Comments', `Last 7 days · ${o.comments_pending} to review`, o.comments_pending > 0, '#comments'),
        stat(o.upcoming_events, 'Upcoming events', 'Scheduled or postponed', false, '#events'),
        stat(syncText, 'Last Drive sync', last ? `Latest run: ${last.status}${last.status === 'failed' ? ' — see Events' : ''}` : 'No sync has run yet', last?.status === 'failed', '#events'),
        stat(o.comment_premoderation ? 'ON' : 'OFF', 'Comment review', o.comment_premoderation ? 'New comments wait for approval' : 'Comments appear immediately', false, '#comments')),
      h('div', { class: 'grid2', style: 'margin-top:18px' },
        h('div', { class: 'card' }, h('h3', { text: 'Recent votes' }), h('div', { class: 'hint', text: 'Ballots are private: voters are not shown.' }),
          o.recent_votes.length ? h('div', { class: 'list' }, o.recent_votes.map((v) => h('div', { class: 'li' },
            h('div', { class: 'main' }, h('strong', { text: v.label }), h('div', { class: 'sub', text: `${v.question} · ${C.ago(v.created_at)}` }))))) : h('p', { class: 'hint', text: 'No votes yet.' })),
        h('div', { class: 'card' }, h('h3', { text: 'Recent comments' }),
          o.recent_comments.length ? h('div', { class: 'list' }, o.recent_comments.map((c) => h('div', { class: 'li' },
            h('div', { class: 'main' }, h('strong', { text: c.author || 'Member' }), ' ', statusTagComment(c.status),
              h('div', { class: 'sub', text: `${c.event_title} · ${C.ago(c.created_at)}` }), h('div', { class: 'txt', text: c.body.length > 160 ? c.body.slice(0, 160) + '…' : c.body }))))) : h('p', { class: 'hint', text: 'No comments yet.' })),
        h('div', { class: 'card' }, h('h3', { text: 'Next events' }),
          o.next_events.length ? h('div', { class: 'list' }, o.next_events.map((e) => h('div', { class: 'li' },
            h('div', { class: 'main' }, h('strong', { text: e.title }), h('div', { class: 'sub', text: `${when(e.starts_at)}${e.venue ? ' · ' + e.venue : ''} · ${e.source === 'drive' ? 'from Drive' : 'added by hand'}` }))))) : h('p', { class: 'hint', text: 'No upcoming events.' })),
        h('div', { class: 'card' }, h('h3', { text: 'Quick actions' }), h('div', { class: 'row', style: 'margin-top:10px' },
          h('a', { class: 'btn small primary', href: '#approvals', text: `Review requests (${o.members_awaiting})` }),
          h('a', { class: 'btn small', href: '#polls', text: 'New poll' }),
          h('a', { class: 'btn small', href: '#events', text: 'Sync events' }),
          h('a', { class: 'btn small', href: '/members', text: 'View the hub' })))));
  }
  const CSTAT = { pending: ['PENDING', 'warn'], visible: ['VISIBLE', 'ok'], hidden: ['HIDDEN', 'dim'], removed: ['REMOVED', ''], deleted: ['DELETED BY AUTHOR', 'dim'] };
  function statusTagComment(s) { const t = CSTAT[s] || [s, 'dim']; return h('span', { class: 'tag ' + t[1], text: t[0] }); }

  // ======================= APPROVALS =======================
  async function renderApprovals() {
    loading();
    let waiting, noName;
    try {
      const [a, b] = await Promise.all([
        C.sb.from('profiles').select('*').eq('membership_status', 'awaiting_approval').order('requested_at', { ascending: true }),
        C.sb.from('profiles').select('id,email,google_name,created_at').eq('membership_status', 'pending').order('created_at', { ascending: false }).limit(100),
      ]);
      if (a.error || b.error) throw new Error(C.friendly(a.error || b.error));
      waiting = a.data; noName = b.data;
    } catch (e) { return failed(e, renderApprovals); }

    const chosen = new Set();
    const bulk = btn('Approve selected', null, 'primary');
    bulk.disabled = true;
    const updBulk = () => { bulk.disabled = !chosen.size; bulk.textContent = chosen.size ? `Approve selected (${chosen.size})` : 'Approve selected'; };
    bulk.addEventListener('click', () => act(bulk, () => rpc('admin_bulk_approve', { p_users: [...chosen] }), (n) => `${n} member${n === 1 ? '' : 's'} approved.`));

    const rows = waiting.map((p) => {
      const cb = h('input', { type: 'checkbox', 'aria-label': 'Select ' + p.full_name, onchange: (e) => { e.target.checked ? chosen.add(p.id) : chosen.delete(p.id); updBulk(); } });
      const approve = btn('Approve', null, 'primary');
      approve.addEventListener('click', () => act(approve, () => rpc('admin_review_member', { p_user: p.id, p_approve: true, p_note: null }), `${p.full_name} is now a member.`));
      const reject = btn('Reject', null, 'danger');
      reject.addEventListener('click', async () => {
        const note = await ask({ title: `Reject ${p.full_name}?`, text: 'They will see your note and can send the request again.', confirm: 'Reject', danger: true,
          input: { label: 'Note to the member', placeholder: 'e.g. Please use your full name as on your ID card', max: 300 } });
        if (note === null) return;
        act(reject, () => rpc('admin_review_member', { p_user: p.id, p_approve: false, p_note: note || null }), 'Request rejected.');
      });
      return h('div', { class: 'li' }, cb, C.avatar(p.avatar_url, p.full_name, 'lg'),
        h('div', { class: 'main' }, h('strong', { text: p.full_name }),
          h('div', { class: 'sub', text: [p.email, p.year_of_study, p.department].filter(Boolean).join(' · ') }),
          h('div', { class: 'sub', text: `Google name: ${p.google_name || '—'} · asked ${C.ago(p.requested_at)}` })),
        h('div', { class: 'row' }, approve, reject));
    });

    view.replaceChildren(
      section('Membership requests', 'Everyone who signs in must give their name and be approved before they can vote or comment.', bulk),
      waiting.length ? h('div', { class: 'card' }, h('div', { class: 'row', style: 'margin-bottom:6px' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => {
          $$('.li input[type=checkbox]', view).forEach((x) => { x.checked = e.target.checked; x.dispatchEvent(new Event('change')); });
        } }), h('span', { text: 'Select all' }))), h('div', { class: 'list' }, rows))
        : empty('No requests waiting', 'New requests appear here, and the club Gmail gets an email for each one.'),
      noName.length ? h('details', { class: 'card', style: 'margin-top:18px' },
        h('summary', { style: 'cursor:pointer;font-weight:800;color:var(--gold2)', text: `${noName.length} signed in but haven't given their name yet` }),
        h('p', { class: 'hint', text: 'Nothing to do: they become requests once they fill in the name form.' }),
        h('div', { class: 'list' }, noName.map((p) => h('div', { class: 'li' }, h('div', { class: 'main' },
          h('strong', { text: p.google_name || p.email }), h('div', { class: 'sub', text: `${p.email} · signed in ${C.ago(p.created_at)}` })))))) : null);
  }

  // ======================= MEMBERS =======================
  let memberFilter = { q: '', s: 'all' };
  async function renderMembers() {
    loading();
    let all;
    try {
      const { data, error } = await C.sb.from('profiles').select('*').order('created_at', { ascending: false }).limit(2000);
      if (error) throw new Error(C.friendly(error));
      all = data;
    } catch (e) { return failed(e, renderMembers); }

    const listBox = h('div', { class: 'list' });
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Search name or email', value: memberFilter.q, 'aria-label': 'Search members' });
    const s = h('select', { class: 'input', 'aria-label': 'Filter by status' },
      [['all', 'Everyone'], ['approved', 'Members'], ['admins', 'Admins'], ['awaiting_approval', 'Waiting'], ['suspended', 'Suspended'], ['rejected', 'Rejected'], ['pending', 'No name yet']]
        .map(([v, t]) => h('option', { value: v, text: t })));
    s.value = memberFilter.s;
    const countEl = h('span', { class: 'hint' });

    const draw = () => {
      memberFilter = { q: q.value.trim().toLowerCase(), s: s.value };
      const list = all.filter((p) => (memberFilter.s === 'all' || (memberFilter.s === 'admins' ? p.is_admin : p.membership_status === memberFilter.s))
        && (!memberFilter.q || `${p.full_name || ''} ${p.google_name || ''} ${p.email}`.toLowerCase().includes(memberFilter.q)));
      countEl.textContent = `${list.length} of ${all.length}`;
      listBox.replaceChildren(...(list.length ? list.slice(0, 300).map(memberRow) : [h('p', { class: 'hint', text: 'Nobody matches.' })]));
    };
    q.addEventListener('input', draw); s.addEventListener('change', draw);

    view.replaceChildren(section('Members', 'Suspend, restore and manage admins. Every change is logged.'),
      h('div', { class: 'filters' }, q, s, countEl), h('div', { class: 'card' }, listBox));
    draw();
  }

  function memberRow(p) {
    const me = p.id === state.user.id;
    const name = p.full_name || p.google_name || p.email;
    const acts = h('div', { class: 'row' });
    const s = p.membership_status;
    if (s === 'awaiting_approval' || s === 'rejected') {
      const a = btn('Approve', null, 'primary');
      a.addEventListener('click', () => act(a, () => rpc('admin_review_member', { p_user: p.id, p_approve: true, p_note: null }), `${name} approved.`));
      acts.append(a);
    }
    if (s === 'approved' && !p.is_admin && !me) {
      const sus = btn('Suspend', null, 'danger');
      sus.addEventListener('click', async () => {
        const reason = await ask({ title: `Suspend ${name}?`, text: 'They will not be able to vote or comment until you restore them. They will see the reason.', confirm: 'Suspend', danger: true,
          input: { label: 'Reason', required: true, min: 3, requiredMsg: 'Please give a reason (at least 3 characters).', multiline: true } });
        if (reason) act(sus, () => rpc('admin_suspend_member', { p_user: p.id, p_reason: reason }), `${name} is suspended.`);
      });
      const mk = btn('Make admin');
      mk.addEventListener('click', async () => {
        if (await ask({ title: `Make ${name} an admin?`, text: 'Admins can approve members, moderate comments, run polls and edit events.', confirm: 'Make admin' }))
          act(mk, () => rpc('admin_set_admin', { p_user: p.id, p_make_admin: true }), `${name} is now an admin.`);
      });
      acts.append(sus, mk);
    }
    if (p.is_admin && !me) {
      const rm = btn('Remove admin', null, 'danger');
      rm.addEventListener('click', async () => {
        if (await ask({ title: `Remove admin rights from ${name}?`, confirm: 'Remove', danger: true }))
          act(rm, () => rpc('admin_set_admin', { p_user: p.id, p_make_admin: false }), 'Admin rights removed.');
      });
      acts.append(rm);
    }
    if (s === 'suspended') {
      const r = btn('Restore', null, 'primary');
      r.addEventListener('click', async () => {
        const note = await ask({ title: `Restore ${name}?`, text: 'They can vote and comment again.', confirm: 'Restore', input: { label: 'Note', max: 300 } });
        if (note !== null) act(r, () => rpc('admin_restore_member', { p_user: p.id, p_note: note || null }), `${name} is restored.`);
      });
      acts.append(r);
    }
    acts.append(btn('History', () => showHistory('member', p.id, name), 'ghost'));
    return h('div', { class: 'li' }, C.avatar(p.avatar_url, name, 'lg'),
      h('div', { class: 'main' },
        h('div', { class: 'row' }, h('strong', { text: p.full_name || '(no name yet)' }), statusTag(s), p.is_admin ? h('span', { class: 'tag gold', text: 'ADMIN' }) : null, me ? h('span', { class: 'tag dim', text: 'YOU' }) : null),
        h('div', { class: 'sub', text: [p.email, p.year_of_study, p.department].filter(Boolean).join(' · ') }),
        h('div', { class: 'sub', text: `Signed in ${C.fmtDate(p.created_at)}${p.reviewed_at ? ' · reviewed ' + C.fmtDate(p.reviewed_at) : ''}${p.google_name && p.google_name !== p.full_name ? ' · Google: ' + p.google_name : ''}` }),
        s === 'suspended' ? h('div', { class: 'note err', style: 'margin-top:8px', text: `Suspended ${C.fmtDateTime(p.suspended_at)} — ${p.suspension_reason}` }) : null,
        s === 'rejected' && p.review_note ? h('div', { class: 'sub', text: 'Rejection note: ' + p.review_note }) : null),
      acts);
  }

  // ======================= POLLS =======================
  async function renderPolls() {
    loading();
    let polls;
    try { polls = (await rpc('get_polls', { p_include_drafts: true })) || []; } catch (e) { return failed(e, renderPolls); }
    const card = (p) => {
      const total = p.total_votes;
      const tags = { draft: ['DRAFT', 'dim'], open: ['OPEN', 'ok'], upcoming: ['SCHEDULED', 'warn'], closed: ['CLOSED', 'pink'] }[p.phase];
      const acts = h('div', { class: 'row', style: 'margin-top:14px' });
      const statusBtn = (label, to, cls, msg, confirmText) => {
        const b = btn(label, null, cls);
        b.addEventListener('click', async () => {
          if (confirmText && !(await ask({ title: confirmText, confirm: label }))) return;
          act(b, () => rpc('admin_set_poll_status', { p_poll: p.id, p_status: to }), msg);
        });
        return b;
      };
      acts.append(btn('Edit', () => pollEditor(p)));
      if (p.status === 'draft') acts.append(statusBtn('Publish', 'active', 'primary', 'Poll published. Members can vote now.', 'Publish this poll to all members?'));
      if (p.status === 'active') acts.append(statusBtn('Close now', 'closed', '', 'Poll closed. Results are now public.', 'Close voting now?'));
      if (p.status === 'closed' || p.phase === 'closed') acts.append(statusBtn('Reopen', 'active', '', 'Poll reopened.'));
      if (p.status !== 'draft' && !total) acts.append(statusBtn('Back to draft', 'draft', 'ghost', 'Poll moved back to draft.'));
      const del = btn('Delete', null, 'danger');
      del.addEventListener('click', async () => {
        if (await ask({ title: 'Delete this poll?', text: `"${p.question}" and its ${total} vote${total === 1 ? '' : 's'} will be deleted. The results are kept in the activity log.`, confirm: 'Delete', danger: true }))
          act(del, () => rpc('admin_delete_poll', { p_poll: p.id }), 'Poll deleted.');
      });
      acts.append(del, btn('History', () => showHistory('poll', p.id, p.question), 'ghost'));
      const max = Math.max(1, ...p.options.map((o) => o.votes || 0));
      return h('article', { class: 'card' },
        h('div', { class: 'row' }, h('span', { class: 'tag ' + tags[1], text: tags[0] }),
          h('span', { class: 'hint', style: 'margin:0', text: [p.opens_at && `opens ${C.fmtDateTime(p.opens_at)}`, p.closes_at && `closes ${C.fmtDateTime(p.closes_at)}`].filter(Boolean).join(' · ') || 'No time limits' })),
        h('h3', { text: p.question }), p.description ? h('div', { class: 'desc', text: p.description }) : null,
        h('div', { class: 'mini-bars', style: 'margin-top:12px' }, p.options.map((o) => h('div', { class: 'r' },
          h('div', null, o.label, h('div', { class: 'tr' }, h('i', { style: `width:${Math.round((o.votes || 0) * 100 / max)}%` }))),
          h('div', { class: 'v', text: `${o.votes || 0}${total ? ' · ' + Math.round((o.votes || 0) * 100 / total) + '%' : ''}` })))),
        h('div', { class: 'hint', text: `${total} participant${total === 1 ? '' : 's'} · created ${C.fmtDate(p.created_at)}` }),
        acts);
    };
    view.replaceChildren(
      section('Polls', 'Drafts are only visible to admins. Members see results after voting; everyone sees them once a poll closes.',
        btn('+ New poll', () => pollEditor(null), 'primary')),
      polls.length ? h('div', null, polls.map(card)) : empty('No polls yet', 'Start with "What should SIMATS Anime Club do next?"'));
  }

  function pollEditor(p) {
    const isNew = !p;
    const q = h('input', { class: 'input', maxlength: 200, required: true, placeholder: 'What should SIMATS Anime Club do next?' });
    const d = h('textarea', { class: 'input', maxlength: 1000, rows: 2, placeholder: 'Optional details' });
    const opens = h('input', { class: 'input', type: 'datetime-local' });
    const closes = h('input', { class: 'input', type: 'datetime-local' });
    const optBox = h('div');
    const err = h('div', { class: 'note err', hidden: true, role: 'alert' });
    if (p) { q.value = p.question; d.value = p.description || ''; opens.value = C.toLocalInput(p.opens_at); closes.value = C.toLocalInput(p.closes_at); }
    const addOpt = (o = {}) => {
      const inp = h('input', { class: 'input', maxlength: 120, placeholder: 'Option', 'aria-label': 'Option' });
      inp.value = o.label || '';
      const row = h('div', { class: 'opt-edit', dataset: { id: o.id || '' } }, inp,
        o.votes ? h('span', { class: 'tag dim', title: 'Options with votes cannot be removed', text: `${o.votes} votes` })
          : h('button', { class: 'btn small ghost', type: 'button', 'aria-label': 'Remove option', text: '✕', onclick: () => row.remove() }));
      optBox.append(row);
      return inp;
    };
    if (p) p.options.forEach((o) => addOpt(o));
    else ['Anime movie screening', 'Cosplay competition', 'Fan art workshop'].forEach((ex) => { addOpt().placeholder = 'e.g. ' + ex; });
    const save = h('button', { class: 'btn primary', type: 'button', text: isNew ? 'Save as draft' : 'Save changes' });
    const dlg = h('dialog', { class: 'dlg', style: 'width:min(640px,94vw)' },
      h('h3', { text: isNew ? 'New poll' : 'Edit poll' }),
      h('p', { class: 'sub', text: isNew ? 'New polls start as drafts. Publish when ready.' : (p.total_votes ? 'This poll has votes: options with votes can be renamed but not removed.' : '') }),
      h('label', { class: 'f' }, h('span', null, 'Question'), q),
      h('label', { class: 'f' }, h('span', null, 'Description ', h('em', { text: '(optional)' })), d),
      h('div', { class: 'grid2' },
        h('label', { class: 'f' }, h('span', null, 'Opens ', h('em', { text: '(optional, IST)' })), opens),
        h('label', { class: 'f' }, h('span', null, 'Closes ', h('em', { text: '(optional, IST)' })), closes)),
      h('label', { class: 'f' }, h('span', null, 'Options ', h('em', { text: '(2 to 12)' }))), optBox,
      h('button', { class: 'btn small', type: 'button', text: '+ Add option', onclick: () => { if (optBox.children.length < 12) addOpt().focus(); } }),
      err,
      h('div', { class: 'row end', style: 'margin-top:18px' }, h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => dlg.close() }), save));
    save.addEventListener('click', () => {
      const options = [...optBox.children].map((r) => ({ id: r.dataset.id || null, label: r.querySelector('input').value.trim() })).filter((o) => o.label || o.id);
      err.hidden = true;
      if (q.value.trim().length < 3) { err.textContent = 'Write the question.'; err.hidden = false; return; }
      if (options.filter((o) => o.label).length < 2) { err.textContent = 'Add at least two options.'; err.hidden = false; return; }
      busy(save, async () => {
        try {
          await rpc('admin_save_poll', { p_poll_id: p?.id || null, p_question: q.value, p_description: d.value || null,
            p_opens_at: C.fromLocalInput(opens.value), p_closes_at: C.fromLocalInput(closes.value), p_options: options });
          dlg.close(); toast(isNew ? 'Draft saved. Publish it when you are ready.' : 'Poll saved.', 'ok'); render();
        } catch (e) { err.textContent = e.message; err.hidden = false; }
      });
    });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg); dlg.showModal(); q.focus();
  }

  // ======================= COMMENTS =======================
  let commentFilter = 'pending';
  async function renderComments() {
    loading();
    let list, settings;
    try {
      [list, settings] = await Promise.all([
        rpc('admin_list_comments', { p_status: commentFilter === 'all' ? null : commentFilter, p_limit: 200 }),
        C.sb.from('club_settings').select('comment_premoderation').maybeSingle(),
      ]);
    } catch (e) { return failed(e, renderComments); }
    const premod = settings?.data?.comment_premoderation ?? true;
    const sel = h('select', { class: 'input', 'aria-label': 'Show comments' },
      [['pending', 'Waiting for review'], ['visible', 'Visible'], ['hidden', 'Hidden'], ['removed', 'Removed'], ['deleted', 'Deleted by author'], ['all', 'All comments']]
        .map(([v, t]) => h('option', { value: v, text: t })));
    sel.value = commentFilter;
    sel.addEventListener('change', () => { commentFilter = sel.value; renderComments(); });
    const tg = h('input', { type: 'checkbox', checked: premod });
    tg.addEventListener('change', async () => {
      try { await rpc('admin_set_comment_premoderation', { p_on: tg.checked }); toast(tg.checked ? 'New comments now wait for approval.' : 'New comments now appear immediately.', 'ok'); refreshBadges(); }
      catch (e) { tg.checked = !tg.checked; toast(e.message, 'err'); }
    });

    const row = (c) => {
      const acts = h('div', { class: 'row' });
      const mod = (label, action, cls, needReason) => {
        const b = btn(label, null, cls);
        b.addEventListener('click', async () => {
          let reason = null;
          if (needReason) {
            reason = await ask({ title: `${label} this comment?`, text: 'The author sees the reason next to their comment.', confirm: label, danger: action === 'remove', input: { label: 'Reason', max: 300 } });
            if (reason === null) return;
          }
          act(b, () => rpc('admin_moderate_comment', { p_id: c.id, p_action: action, p_reason: reason || null }), 'Done.');
        });
        return b;
      };
      if (c.status === 'pending') acts.append(mod('Approve', 'approve', 'primary'));
      if (c.status === 'pending' || c.status === 'visible') acts.append(mod('Hide', 'hide', '', true), mod('Remove', 'remove', 'danger', true));
      if (['hidden', 'removed', 'deleted'].includes(c.status)) acts.append(mod('Restore', 'restore', ''));
      if (c.author_status === 'approved') {
        const s = btn('Suspend author', null, 'ghost');
        s.addEventListener('click', async () => {
          const reason = await ask({ title: `Suspend ${c.author_name}?`, confirm: 'Suspend', danger: true,
            input: { label: 'Reason', required: true, min: 3, requiredMsg: 'Please give a reason.', multiline: true } });
          if (reason) act(s, () => rpc('admin_suspend_member', { p_user: c.author_id, p_reason: reason }), 'Author suspended.');
        });
        acts.append(s);
      }
      acts.append(btn('History', () => showHistory('comment', String(c.id), 'Comment #' + c.id), 'ghost'));
      return h('div', { class: 'li' },
        h('div', { class: 'main' },
          h('div', { class: 'row' }, h('strong', { text: c.author_name || '(no name)' }), statusTagComment(c.status), c.author_status !== 'approved' ? statusTag(c.author_status) : null),
          h('div', { class: 'sub', text: `${c.author_email} · on "${c.event_title}" · ${C.fmtDateTime(c.created_at)}${c.edited_at ? ' · edited' : ''}` }),
          h('div', { class: 'txt', text: c.body }),
          c.moderated_at ? h('div', { class: 'sub', text: `Last moderated by ${c.moderator_name || 'an admin'} ${C.ago(c.moderated_at)}${c.moderation_reason ? ' — ' + c.moderation_reason : ''}` }) : null),
        acts);
    };
    view.replaceChildren(
      section('Comments', 'Approve, hide, remove or restore. Removed and deleted comments are kept here for review.'),
      h('div', { class: 'filters' }, sel, h('span', { class: 'spacer' }), h('label', { class: 'toggle' }, tg, 'Review new comments before they appear')),
      list.length ? h('div', { class: 'card' }, h('div', { class: 'list' }, list.map(row))) : empty(commentFilter === 'pending' ? 'All caught up' : 'Nothing here', commentFilter === 'pending' ? 'No comments are waiting for review.' : ''));
  }

  // ======================= EVENTS =======================
  let eventFilter = 'upcoming';
  async function renderEvents() {
    loading();
    let evs, logs;
    try {
      const [a, b] = await Promise.all([
        C.sb.from('events').select('*').order('starts_at', { ascending: false }).limit(500),
        C.sb.from('event_sync_logs').select('*').order('started_at', { ascending: false }).limit(8),
      ]);
      if (a.error || b.error) throw new Error(C.friendly(a.error || b.error));
      evs = a.data; logs = b.data;
    } catch (e) { return failed(e, renderEvents); }

    const syncBtn = btn('↻ Refresh from Drive now', null, 'primary');
    const result = h('div');
    syncBtn.addEventListener('click', () => busy(syncBtn, async () => {
      result.replaceChildren();
      try {
        const r = await C.api('/api/sync-events');
        result.replaceChildren(h('div', { class: 'note ok', style: 'margin-top:12px' },
          `Sync finished: ${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged, ${r.hidden} hidden${r.skipped ? `, ${r.skipped} rows skipped` : ''}.`,
          r.warnings?.length ? h('pre', { class: 'warn', text: r.warnings.join('\n') }) : null));
        toast('Events refreshed from Drive.', 'ok');
        setTimeout(renderEvents, 1800);
      } catch (e) {
        result.replaceChildren(h('div', { class: 'note err', style: 'margin-top:12px' }, 'Sync failed: ', e.message,
          e.result?.warnings?.length ? h('pre', { class: 'warn', text: e.result.warnings.join('\n') }) : null,
          h('div', { class: 'hint', text: 'The events already on the site were kept.' })));
      }
    }));

    const logRow = (l) => h('div', { class: 'li' }, h('div', { class: 'main' },
      h('div', { class: 'row' }, h('span', { class: 'tag ' + (l.status === 'success' ? 'ok' : l.status === 'failed' ? '' : 'warn'), text: l.status.toUpperCase() }),
        h('strong', { text: C.fmtDateTime(l.started_at) }), h('span', { class: 'hint', style: 'margin:0', text: l.trigger === 'cron' ? 'weekly' : 'manual' })),
      l.status === 'success' ? h('div', { class: 'sub', text: `${l.rows_read ?? 0} rows read · ${l.inserted} new · ${l.updated} updated · ${l.unchanged} unchanged · ${l.hidden} hidden · ${l.skipped ?? 0} skipped` }) : null,
      l.error ? h('div', { class: 'sub', style: 'color:#ffc2cc', text: l.error }) : null,
      l.details?.warnings?.length ? h('details', null, h('summary', { class: 'sub', style: 'cursor:pointer', text: `${l.details.warnings.length} warnings` }), h('pre', { class: 'warn', text: l.details.warnings.join('\n') })) : null));

    const sel = h('select', { class: 'input', 'aria-label': 'Which events' },
      [['upcoming', 'Upcoming'], ['past', 'Past'], ['hidden', 'Hidden'], ['all', 'All']].map(([v, t]) => h('option', { value: v, text: t })));
    sel.value = eventFilter;
    sel.addEventListener('change', () => { eventFilter = sel.value; renderEvents(); });
    const now = Date.now();
    const endOf = (e) => new Date(e.ends_at || new Date(new Date(e.starts_at).getTime() + 3 * 3600e3)).getTime();
    let shown = evs.filter((e) => eventFilter === 'all' || (eventFilter === 'hidden' ? e.status === 'hidden'
      : e.status !== 'hidden' && (eventFilter === 'upcoming' ? endOf(e) >= now : endOf(e) < now)));
    if (eventFilter === 'upcoming') shown = shown.reverse();

    const evRow = (e) => {
      const acts = h('div', { class: 'row' }, btn('Edit', () => eventEditor(e)));
      if (e.manual_override) {
        const rel = btn('Let sync manage', null, 'ghost');
        rel.addEventListener('click', async () => {
          if (await ask({ title: 'Hand this event back to the Drive sheet?', text: 'Your edits will be replaced by the sheet row on the next sync.', confirm: 'Hand back' }))
            act(rel, () => rpc('admin_release_event_override', { p_id: e.id }), 'The next sync will update this event from the sheet.');
        });
        acts.append(rel);
      }
      const del = btn(e.source === 'drive' ? 'Hide' : 'Delete', null, 'danger');
      del.addEventListener('click', async () => {
        const drive = e.source === 'drive';
        if (await ask({ title: drive ? 'Hide this Drive event?' : 'Delete this event?', danger: true, confirm: drive ? 'Hide' : 'Delete',
          text: drive ? 'It stays in the sheet, so it is hidden here and the sync will leave it hidden.' : 'Its comments will be deleted too.' }))
          act(del, () => rpc('admin_delete_event', { p_id: e.id }), (r) => (r === 'hidden' ? 'Event hidden.' : 'Event deleted.'));
      });
      acts.append(del, btn('History', () => showHistory('event', e.id, e.title), 'ghost'));
      return h('div', { class: 'li' }, h('div', { class: 'main' },
        h('div', { class: 'row' }, h('strong', { text: e.title }),
          h('span', { class: 'tag ' + (e.source === 'drive' ? 'gold' : 'dim'), text: e.source === 'drive' ? 'DRIVE' : 'MANUAL' }),
          e.manual_override ? h('span', { class: 'tag warn', text: 'EDITED HERE' }) : null,
          e.status !== 'scheduled' ? h('span', { class: 'tag ' + (e.status === 'hidden' ? 'dim' : 'pink'), text: e.status.toUpperCase() }) : null),
        h('div', { class: 'sub', text: [when(e.starts_at), e.venue, e.category].filter(Boolean).join(' · ') })), acts);
    };

    view.replaceChildren(
      section('Events', 'Imported every Monday morning from the Google Drive sheet. Events you add or edit here are never overwritten by the sync.',
        btn('+ Add event', () => eventEditor(null), 'primary')),
      h('div', { class: 'card' }, h('h3', { text: 'Google Drive sync' }),
        h('p', { class: 'hint', text: 'A failed sync never removes events: the site keeps the last good data.' }),
        h('div', { class: 'row', style: 'margin-top:8px' }, syncBtn), result,
        logs.length ? h('div', { class: 'list', style: 'margin-top:12px' }, logs.map(logRow)) : h('p', { class: 'hint', text: 'No sync has run yet.' })),
      h('div', { class: 'filters', style: 'margin-top:22px' }, sel, h('span', { class: 'hint', text: `${shown.length} event${shown.length === 1 ? '' : 's'}` })),
      shown.length ? h('div', { class: 'card' }, h('div', { class: 'list' }, shown.map(evRow))) : empty('No events here', eventFilter === 'upcoming' ? 'Add one, or refresh from Drive.' : ''));
  }

  function eventEditor(e) {
    const f = (tag, attrs, val) => { const el = h(tag, { class: 'input', ...attrs }); if (val != null) el.value = val; return el; };
    const title = f('input', { maxlength: 140, required: true }, e?.title);
    const starts = f('input', { type: 'datetime-local', required: true }, C.toLocalInput(e?.starts_at));
    const ends = f('input', { type: 'datetime-local' }, C.toLocalInput(e?.ends_at));
    const venue = f('input', { maxlength: 140, placeholder: 'e.g. Block 3, Room 204' }, e?.venue);
    const cat = f('input', { maxlength: 40, placeholder: 'QUIZ, SCREENING, COSPLAY…' }, e?.category);
    const status = h('select', { class: 'input' }, ['scheduled', 'postponed', 'cancelled', 'completed', 'hidden'].map((s) => h('option', { value: s, text: s[0].toUpperCase() + s.slice(1) })));
    status.value = e?.status || 'scheduled';
    const img = f('input', { type: 'url', maxlength: 1000, placeholder: 'https://…' }, e?.image_url);
    const desc = f('textarea', { maxlength: 2000, rows: 4 }, e?.description);
    const err = h('div', { class: 'note err', hidden: true, role: 'alert' });
    const save = h('button', { class: 'btn primary', type: 'button', text: e ? 'Save changes' : 'Add event' });
    const dlg = h('dialog', { class: 'dlg', style: 'width:min(640px,94vw)' },
      h('h3', { text: e ? 'Edit event' : 'Add event' }),
      h('p', { class: 'sub', text: e?.source === 'drive' ? 'This event comes from the Drive sheet. After you save, the sync stops updating it (you can hand it back later).' : 'Times are India time (IST).' }),
      h('label', { class: 'f' }, h('span', null, 'Title'), title),
      h('div', { class: 'grid2' }, h('label', { class: 'f' }, h('span', null, 'Starts'), starts), h('label', { class: 'f' }, h('span', null, 'Ends ', h('em', { text: '(optional)' })), ends)),
      h('div', { class: 'grid2' }, h('label', { class: 'f' }, h('span', null, 'Venue'), venue), h('label', { class: 'f' }, h('span', null, 'Category'), cat)),
      h('div', { class: 'grid2' }, h('label', { class: 'f' }, h('span', null, 'Status'), status), h('label', { class: 'f' }, h('span', null, 'Image link ', h('em', { text: '(https)' })), img)),
      h('label', { class: 'f' }, h('span', null, 'Description'), desc), err,
      h('div', { class: 'row end' }, h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => dlg.close() }), save));
    save.addEventListener('click', () => {
      err.hidden = true;
      if (title.value.trim().length < 2 || !starts.value) { err.textContent = 'A title and a start time are needed.'; err.hidden = false; return; }
      busy(save, async () => {
        try {
          await rpc('admin_save_event', { p_id: e?.id || null, p_title: title.value, p_starts_at: C.fromLocalInput(starts.value), p_ends_at: C.fromLocalInput(ends.value),
            p_venue: venue.value || null, p_description: desc.value || null, p_image_url: img.value.trim() || null, p_category: cat.value || null, p_status: status.value });
          dlg.close(); toast(e ? 'Event saved.' : 'Event added.', 'ok'); render();
        } catch (x) { err.textContent = x.message; err.hidden = false; }
      });
    });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg); dlg.showModal(); title.focus();
  }

  // ======================= ACTIVITY LOG =======================
  const ACTION = {
    admin_bootstrapped: 'Admin account set up', member_approved: 'Approved member', member_rejected: 'Rejected request',
    member_suspended: 'Suspended member', member_restored: 'Restored member', admin_granted: 'Made admin', admin_revoked: 'Removed admin',
    poll_created: 'Created poll', poll_edited: 'Edited poll', poll_published: 'Published poll', poll_closed: 'Closed poll',
    poll_reopened: 'Reopened poll', poll_unpublished: 'Moved poll to draft', poll_deleted: 'Deleted poll',
    comment_approved: 'Approved comment', comment_hidden: 'Hid comment', comment_removed: 'Removed comment', comment_restored: 'Restored comment',
    premoderation_on: 'Turned comment review on', premoderation_off: 'Turned comment review off',
    event_created: 'Added event', event_edited: 'Edited event', event_deleted: 'Deleted event', event_hidden: 'Hid Drive event',
    event_override_released: 'Handed event back to sync', sync_manual_success: 'Ran Drive sync', sync_manual_failed: 'Drive sync failed',
  };
  const describe = (l) => l.target_name || l.details?.question || l.details?.title || (l.details?.body ? `"${l.details.body}"` : '') || l.details?.name || '';
  const logRow = (l) => h('div', { class: 'li' }, h('div', { class: 'main' },
    h('div', { class: 'row' }, h('strong', { text: ACTION[l.action] || l.action }), h('span', { class: 'tag dim', text: l.target_type.toUpperCase() })),
    describe(l) ? h('div', { class: 'txt', text: describe(l).slice(0, 220) }) : null,
    l.reason ? h('div', { class: 'sub', text: 'Reason: ' + l.reason }) : null,
    h('div', { class: 'sub', text: `${l.actor_name || l.actor_email || 'System'} · ${C.fmtDateTime(l.created_at)}` })));

  let logFilter = '';
  async function renderLog() {
    loading();
    let list;
    try { list = await rpc('admin_list_log', { p_target_type: logFilter || null, p_target_id: null, p_limit: 300 }); } catch (e) { return failed(e, renderLog); }
    const sel = h('select', { class: 'input', 'aria-label': 'Filter activity' },
      [['', 'Everything'], ['member', 'Members'], ['comment', 'Comments'], ['poll', 'Polls'], ['event', 'Events'], ['sync', 'Drive sync'], ['settings', 'Settings']].map(([v, t]) => h('option', { value: v, text: t })));
    sel.value = logFilter;
    sel.addEventListener('change', () => { logFilter = sel.value; renderLog(); });
    view.replaceChildren(section('Activity log', 'Every admin action, newest first. Entries cannot be edited or deleted from the website.'),
      h('div', { class: 'filters' }, sel), list.length ? h('div', { class: 'card' }, h('div', { class: 'list' }, list.map(logRow))) : empty('Nothing logged yet'));
  }

  async function showHistory(type, id, title) {
    const body = h('div', { class: 'list' }, h('p', { class: 'hint', text: 'Loading…' }));
    const dlg = h('dialog', { class: 'dlg', style: 'width:min(640px,94vw)' }, h('h3', { text: 'History' }), h('p', { class: 'sub', text: title }), body,
      h('div', { class: 'row end', style: 'margin-top:14px' }, h('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => dlg.close() })));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg); dlg.showModal();
    try {
      const list = await rpc('admin_list_log', { p_target_type: type, p_target_id: String(id), p_limit: 100 });
      body.replaceChildren(...(list.length ? list.map(logRow) : [h('p', { class: 'hint', text: 'No admin actions recorded yet.' })]));
    } catch (e) { body.replaceChildren(h('div', { class: 'note err', text: e.message })); }
  }

  // ======================= routing & gate =======================
  const RENDER = { overview: renderOverview, approvals: renderApprovals, members: renderMembers, polls: renderPolls, comments: renderComments, events: renderEvents, log: renderLog };
  function render() { return RENDER[tab](); }
  function route() {
    const t = location.hash.replace('#', '');
    tab = TABS.includes(t) ? t : 'overview';
    $$('.admin-tabs a').forEach((a) => a.setAttribute('aria-selected', String(a.dataset.tab === tab)));
    render();
  }

  function gate() {
    const g = $('#gate'), app = $('#app');
    const show = (el) => { app.hidden = true; g.hidden = false; g.replaceChildren(el); };
    if (!C.configured) return show(h('div', { class: 'note', text: 'The members area is not set up yet: add the Supabase publishable key to assets/club/config.js.' }));
    if (!state.ready) return;
    if (!state.user) return show(h('div', { class: 'state' }, h('img', { src: 'assets/benio-face-192.png', alt: '' }), h('span', { class: 'big', text: 'Admins only' }),
      'Sign in with the club admin Google account.', h('div', { class: 'row', style: 'justify-content:center;margin-top:14px' }, C.googleButton())));
    if (!state.profile?.is_admin || state.profile.membership_status !== 'approved') {
      return show(h('div', { class: 'state' }, h('img', { src: 'assets/benio-face-192.png', alt: '' }), h('span', { class: 'big', text: 'Admins only' }),
        `You're signed in as ${state.user.email}, which is not an admin account.`,
        h('div', { class: 'row', style: 'justify-content:center;margin-top:14px' }, h('a', { class: 'btn', href: '/members', text: 'Go to the club hub' }),
          h('button', { class: 'btn ghost', type: 'button', text: 'Switch account', onclick: async () => { await C.signOut(); } }))));
    }
    g.hidden = true; app.hidden = false;
    if (!started) { started = true; addEventListener('hashchange', route); route(); refreshBadges(); C.every(60000, refreshBadges); }
  }

  C.mountAccount($('#acctSlot'));
  C.on(gate);
  gate();
  C.init().catch((e) => { console.error(e); toast(C.friendly(e), 'err'); });
})();
