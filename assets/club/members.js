/* Members hub: membership card, polls, events and comments. */
(function () {
  'use strict';
  const C = window.Club;
  const { h, $, toast, busy, ask, rpc, state } = C;
  const BENIO = 'assets/benio-v4/03_BLINK_FRAME_STRIPS/frame_00_561x701.webp';
  const BENIO_HAPPY = 'assets/benio-v4/09_WORKING_WEBSITE_DEMO/emotion_happy_eyes_closed.webp';
  const YEARS = ['1st year', '2nd year', '3rd year', '4th year', '5th year', 'PG / Masters', 'PhD', 'Faculty / Staff', 'Alumni'];
  const status = () => state.profile?.membership_status || (state.user ? 'unknown' : 'signed_out');
  const isMember = () => status() === 'approved';
  let premod = true;

  $('#yr').textContent = new Date().getFullYear();

  // ======================= membership card =======================
  function nameForm(p, { submitLabel = 'SEND REQUEST', onCancel } = {}) {
    const name = h('input', { class: 'input', name: 'full_name', required: true, maxlength: 80, autocomplete: 'name', placeholder: 'e.g. Priya Ramesh' });
    name.value = p.full_name || p.google_name || '';
    const year = h('select', { class: 'input', name: 'year' }, h('option', { value: '', text: 'Choose…' }), YEARS.map((y) => h('option', { value: y, text: y })));
    year.value = p.year_of_study || '';
    const dept = h('input', { class: 'input', name: 'dept', maxlength: 80, placeholder: 'e.g. CSE, ECE, Biotech' });
    dept.value = p.department || '';
    const agree = h('input', { type: 'checkbox', required: true });
    const err = h('div', { class: 'note err', hidden: true, role: 'alert' });
    const submit = h('button', { class: 'btn primary', type: 'submit', text: submitLabel });
    const form = h('form', { class: 'name-form', novalidate: true },
      h('label', { class: 'f' }, h('span', null, 'Full name'), name, h('div', { class: 'hint', text: 'Your real name, so the admins can recognise you. It is shown next to your comments.' })),
      h('div', { class: 'grid2' },
        h('label', { class: 'f' }, h('span', null, 'Year ', h('em', { text: '(optional)' })), year),
        h('label', { class: 'f' }, h('span', null, 'Department ', h('em', { text: '(optional)' })), dept)),
      h('label', { class: 'check' }, agree, h('span', null, 'I agree to the club ', h('a', { href: 'conduct.html', target: '_blank', text: 'Code of Conduct' }),
        ' and understand the admins can see my name and email (see the ', h('a', { href: 'privacy.html', target: '_blank', text: 'Privacy Policy' }), ').')),
      err,
      h('div', { class: 'row', style: 'margin-top:16px' }, submit, onCancel ? h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: onCancel }) : null));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      err.hidden = true;
      const n = name.value.trim().replace(/\s+/g, ' ');
      const problem = n.length < 2 ? 'Please enter your full name.' : !/\p{L}/u.test(n) ? 'Your name should contain letters.' : !agree.checked ? 'Please tick the box to agree to the Code of Conduct.' : null;
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      busy(submit, async () => {
        try {
          await rpc('submit_membership', { p_full_name: n, p_year: year.value || null, p_department: dept.value.trim() || null });
          // tell the admin by email; the request is saved even if this fails
          C.api('/api/notify-admin').catch((x) => console.warn('admin email not sent:', x.message));
          await C.refreshProfile();
          toast('Request sent! An admin will review it soon.', 'ok');
        } catch (x) { err.textContent = x.message; err.hidden = false; }
      });
    });
    return form;
  }

  function renderAccount() {
    const box = $('#accountCard');
    $('#navAdmin').hidden = !state.profile?.is_admin;
    if (!C.configured) {
      box.replaceChildren(h('div', { class: 'note' }, 'The members area is still being set up. Polls, events and comments will appear here soon.'));
      return;
    }
    if (!state.ready) return;
    const p = state.profile;
    const card = (img, kicker, title, text, ...rest) => h('div', { class: 'card member-card' },
      h('img', { class: 'benio', src: img, alt: '', width: 96, height: 120 }),
      h('div', { class: 'body' }, kicker ? h('span', { class: 'tag ' + (kicker[1] || ''), text: kicker[0] }) : null,
        h('h3', { text: title }), text ? h('p', { text }) : null, ...rest));

    if (!state.user) {
      box.replaceChildren(card(BENIO, ['MEMBERS'], 'Join the member lounge',
        'Sign in with your Google account to vote in polls and comment on events. After you sign in, tell us your name and an admin will approve your membership.',
        h('div', { class: 'row' }, C.googleButton())));
      return;
    }
    if (!p) {
      box.replaceChildren(h('div', { class: 'state err' }, h('span', { class: 'big', text: 'Profile not found' }),
        'We could not load your membership. Please sign out and sign in again.', h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' },
          h('button', { class: 'btn', type: 'button', text: 'Sign out', onclick: () => C.signOut() }))));
      return;
    }
    const s = p.membership_status;
    if (s === 'pending' || s === 'rejected') {
      box.replaceChildren(card(BENIO, s === 'rejected' ? ['NOT APPROVED', 'warn'] : ['STEP 1 OF 2'],
        s === 'rejected' ? 'Your request was not approved' : `Konnichiwa${p.google_name ? ', ' + p.google_name.split(' ')[0] : ''}!`,
        s === 'rejected'
          ? (p.review_note ? `Note from the admin: "${p.review_note}". ` : '') + 'If you think this was a mistake, check your details and send the request again, or talk to an office bearer on campus.'
          : 'Tell us who you are. An admin approves every member, then you can vote and comment.',
        nameForm(p, { submitLabel: s === 'rejected' ? 'SEND AGAIN' : 'SEND REQUEST' })));
      return;
    }
    if (s === 'awaiting_approval') {
      const body = card(BENIO_HAPPY, ['STEP 2 OF 2 · WAITING', 'warn'], `Thanks, ${p.full_name.split(' ')[0]}!`,
        `Your request was sent ${C.ago(p.requested_at)}. An admin will approve it soon. Meanwhile you can browse the polls and events below.`,
        h('div', { class: 'meta', text: [p.full_name, p.year_of_study, p.department].filter(Boolean).join(' · ') }),
        h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn ghost small', type: 'button', text: 'Edit my details',
          onclick: () => box.replaceChildren(h('div', { class: 'card' }, h('h3', { text: 'Edit your details' }),
            nameForm(p, { submitLabel: 'SAVE', onCancel: renderAccount }))) })));
      box.replaceChildren(body);
      return;
    }
    if (s === 'suspended') {
      box.replaceChildren(card(BENIO, ['SUSPENDED', ''], 'Your account is suspended',
        `Since ${C.fmtDate(p.suspended_at)}. Reason: ${p.suspension_reason || 'not given'}. You can still read the hub, but voting and commenting are paused. Talk to an office bearer if you have questions.`));
      return;
    }
    // approved
    box.replaceChildren(h('div', { class: 'card member-card' },
      C.avatar(p.avatar_url, p.full_name, 'lg'),
      h('div', { class: 'body' },
        h('span', { class: 'tag ok', text: p.is_admin ? 'ADMIN · MEMBER' : 'MEMBER' }),
        h('h3', { text: `Okaeri, ${p.full_name.split(' ')[0]}!` }),
        h('p', { text: 'You can vote in polls and comment on events.' + (p.is_admin ? ' You also have access to the admin dashboard.' : '') }),
        p.is_admin ? h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '/admin', text: 'ADMIN DASHBOARD' })) : null)));
  }

  // ======================= polls =======================
  const picked = new Map();          // pollId -> chosen option, kept across refreshes
  let polls = [];

  function pollReason(p) {
    if (p.phase === 'upcoming') return `Voting opens ${C.fmtDateTime(p.opens_at)}.`;
    if (p.phase === 'closed') return null;
    if (p.my_option_id) return null;
    const s = status();
    if (s === 'signed_out') return 'sign-in';
    if (s === 'suspended') return 'Voting is paused while your account is suspended.';
    if (s !== 'approved') return 'You can vote once an admin approves your membership.';
    return null;
  }

  function renderPoll(p) {
    const phaseTag = { open: ['VOTING OPEN', 'ok'], upcoming: ['OPENS SOON', 'warn'], closed: ['CLOSED', 'dim'] }[p.phase] || [p.phase.toUpperCase(), 'dim'];
    const when = p.phase === 'open' && p.closes_at ? `Closes ${C.fmtDateTime(p.closes_at)}`
      : p.phase === 'upcoming' ? `Opens ${C.fmtDateTime(p.opens_at)}`
      : p.phase === 'closed' && p.closes_at ? `Closed ${C.fmtDate(p.closes_at)}` : '';
    const canVote = p.phase === 'open' && isMember() && !p.my_option_id;
    const total = p.total_votes || 0;
    const maxVotes = Math.max(0, ...p.options.map((o) => o.votes || 0));
    const opts = h('div', { class: 'opts' + (p.results_visible && !canVote ? ' results' : canVote ? '' : ' locked'), role: canVote ? 'radiogroup' : null, 'aria-label': p.question });

    for (const o of p.options) {
      const mine = p.my_option_id === o.id;
      const pct = p.results_visible && total ? Math.round((o.votes || 0) * 100 / total) : 0;
      const row = h('label', { class: 'opt' + (mine ? ' mine' : '') + (p.results_visible && o.votes && o.votes === maxVotes ? ' lead' : '') });
      if (p.results_visible) row.append(h('span', { class: 'bar', style: `width:${pct}%` }));
      if (canVote) {
        const r = h('input', { type: 'radio', name: 'poll-' + p.id, value: o.id, onchange: () => picked.set(p.id, o.id) });
        if (picked.get(p.id) === o.id) r.checked = true;
        row.append(r);
      }
      row.append(h('span', { class: 'lbl', text: o.label }));
      if (p.results_visible) row.append(h('span', { class: 'pct', text: `${pct}% · ${o.votes || 0}` }));
      opts.append(row);
    }

    const reason = pollReason(p);
    const foot = h('div', { class: 'foot' },
      h('span', { text: `${total} vote${total === 1 ? '' : 's'}` + (p.phase === 'open' ? ' so far' : '') }),
      p.my_option_id ? h('span', { class: 'tag gold', text: '✓ YOU VOTED' }) : null);

    const card = h('article', { class: 'card poll', id: 'poll-' + p.id },
      h('div', { class: 'phase' }, h('span', { class: 'tag ' + phaseTag[1], text: phaseTag[0] }), when ? h('span', { class: 'when', text: when }) : null),
      h('h3', { text: p.question }),
      p.description ? h('div', { class: 'desc', text: p.description }) : null,
      opts);

    if (canVote) {
      const voteBtn = h('button', { class: 'btn primary', type: 'button', text: 'CAST MY VOTE' });
      voteBtn.addEventListener('click', () => {
        const choice = picked.get(p.id);
        if (!choice) return toast('Pick an option first.', 'err');
        busy(voteBtn, async () => {
          try {
            await rpc('cast_vote', { p_poll: p.id, p_option: choice });
            picked.delete(p.id);
            toast('Vote counted. Arigatou!', 'ok');
          } catch (e) { toast(e.message, 'err'); }
          await loadPolls();
        });
      });
      card.append(h('div', { class: 'row', style: 'margin-bottom:12px' }, voteBtn, h('span', { class: 'hint', text: 'You can vote once. Results show after you vote.' })));
    } else if (reason === 'sign-in') {
      card.append(h('div', { class: 'row', style: 'margin-bottom:12px' }, C.googleButton('Sign in to vote'), h('span', { class: 'hint', text: 'Results show after you vote.' })));
    } else if (reason) {
      card.append(h('div', { class: 'note', style: 'margin-bottom:12px', text: reason }));
    }
    card.append(foot);
    return card;
  }

  function renderPolls() {
    const box = $('#pollList');
    if (!polls.length) {
      box.replaceChildren(h('div', { class: 'state' }, h('span', { class: 'big', text: 'No polls right now' }),
        'When the club asks what to do next, the poll shows up here.'));
      return;
    }
    // don't rebuild while someone is mid-click on a radio
    const focusId = document.activeElement?.name;
    box.replaceChildren(...polls.map(renderPoll));
    if (focusId) document.querySelector(`input[name="${CSS.escape(focusId)}"]:checked`)?.focus();
  }

  async function loadPolls(quiet) {
    if (!C.configured) { $('#pollList').replaceChildren(h('div', { class: 'state', text: 'Polls will appear here once the members area is set up.' })); return; }
    try {
      polls = (await rpc('get_polls', { p_include_drafts: false })) || [];
      renderPolls();
    } catch (e) {
      if (!quiet) $('#pollList').replaceChildren(h('div', { class: 'state err' }, h('span', { class: 'big', text: 'Polls could not load' }), e.message,
        h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' }, h('button', { class: 'btn small', type: 'button', text: 'Try again', onclick: () => loadPolls() }))));
    }
  }

  // ======================= events =======================
  let events = [];
  let counts = {};
  let tab = 'up';
  const open = new Set();
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const endOf = (e) => new Date(e.ends_at || new Date(new Date(e.starts_at).getTime() + 3 * 3600e3));

  function eventCard(e) {
    const s = new Date(e.starts_at);
    const past = endOf(e) < Date.now();
    const time = C.isMidnightIst(e.starts_at) ? 'Time to be announced' : C.fmtTime(e.starts_at) + (e.ends_at ? ' – ' + C.fmtTime(e.ends_at) : '');
    const statusTag = { postponed: ['POSTPONED', 'warn'], cancelled: ['CANCELLED', ''], completed: ['DONE', 'dim'] }[e.status];
    const n = counts[e.id] || 0;
    const toggle = h('button', { class: 'btn small cm-toggle', type: 'button', 'aria-expanded': 'false', text: n ? `💬 COMMENTS (${n})` : '💬 COMMENTS' });
    const panel = h('div', { class: 'comments', hidden: true });
    toggle.addEventListener('click', () => {
      const on = panel.hidden;
      panel.hidden = !on; toggle.setAttribute('aria-expanded', String(on));
      if (on) { open.add(e.id); loadComments(e, panel); } else open.delete(e.id);
    });
    const img = e.image_url && /^https:\/\//.test(e.image_url)
      ? h('img', { class: 'ev-img', src: e.image_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (x) => x.currentTarget.remove() }) : null;
    const card = h('article', { class: `card ev${past ? ' past' : ''}${e.status === 'cancelled' ? ' cancelled' : ''}`, id: 'event-' + e.id },
      h('div', { class: 'ev-date' },
        h('div', { class: 'd', text: C.fmt(s, { day: '2-digit' }) }),
        h('div', { class: 'm', text: MON[+C.fmt(s, { month: 'numeric' }) - 1] }),
        h('div', { class: 'y', text: C.fmt(s, { year: 'numeric' }) })),
      h('div', null,
        h('div', { class: 'row' }, e.category ? h('span', { class: 'tag', text: e.category }) : null, statusTag ? h('span', { class: 'tag ' + statusTag[1], text: statusTag[0] }) : null),
        h('h3', { text: e.title }),
        h('div', { class: 'meta', text: [C.fmt(s, { weekday: 'long', day: 'numeric', month: 'long' }), time, e.venue].filter(Boolean).join(' · ') }),
        e.description ? h('div', { class: 'desc', text: e.description }) : null,
        img, toggle, panel));
    if (open.has(e.id)) { panel.hidden = false; toggle.setAttribute('aria-expanded', 'true'); loadComments(e, panel); }
    return card;
  }

  function renderEvents() {
    const box = $('#eventList');
    $('#tabUp').setAttribute('aria-selected', String(tab === 'up'));
    $('#tabPast').setAttribute('aria-selected', String(tab === 'past'));
    const now = Date.now();
    const list = tab === 'up'
      ? events.filter((e) => endOf(e) >= now)
      : events.filter((e) => endOf(e) < now && now - endOf(e) < 120 * 86400e3).reverse().slice(0, 20);
    if (!list.length) {
      box.replaceChildren(h('div', { class: 'state' },
        h('span', { class: 'big', text: tab === 'up' ? 'No upcoming events yet' : 'No recent events' }),
        tab === 'up' ? 'New events are added every week. We also meet every Tuesday: check the WhatsApp community for the room.' : 'Past events from the last few months show here.',
        tab === 'up' && events.length ? h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' },
          h('button', { class: 'btn small', type: 'button', text: 'See recent events', onclick: () => { tab = 'past'; renderEvents(); } })) : null));
      return;
    }
    box.replaceChildren(...list.map(eventCard));
  }

  async function loadEvents() {
    if (!C.configured) { $('#eventList').replaceChildren(h('div', { class: 'state', text: 'Events will appear here once the members area is set up.' })); return; }
    try {
      const [{ data, error }, cnt, st] = await Promise.all([
        C.sb.from('events').select('id,title,starts_at,ends_at,venue,description,image_url,category,status').neq('status', 'hidden').order('starts_at', { ascending: true }).limit(400),
        rpc('event_comment_counts').catch(() => []),
        C.sb.from('club_settings').select('comment_premoderation').maybeSingle(),
      ]);
      if (error) throw new Error(C.friendly(error));
      events = data || [];
      counts = Object.fromEntries((cnt || []).map((r) => [r.event_id, r.comments]));
      premod = st?.data?.comment_premoderation ?? true;
      if (tab === 'up' && !events.some((e) => endOf(e) >= Date.now()) && events.length) tab = 'past';
      renderEvents();
      // deep link: /members#event-<id>
      const m = /^#event-([\w-]+)/.exec(location.hash);
      if (m) {
        const ev = events.find((e) => e.id === m[1]);
        if (ev) {
          tab = endOf(ev) >= Date.now() ? 'up' : 'past'; open.add(ev.id); renderEvents();
          document.getElementById('event-' + ev.id)?.scrollIntoView({ block: 'start' });
        }
      }
    } catch (e) {
      $('#eventList').replaceChildren(h('div', { class: 'state err' }, h('span', { class: 'big', text: 'Events could not load' }), e.message,
        h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' }, h('button', { class: 'btn small', type: 'button', text: 'Try again', onclick: loadEvents }))));
    }
  }
  $('#tabUp').addEventListener('click', () => { tab = 'up'; renderEvents(); });
  $('#tabPast').addEventListener('click', () => { tab = 'past'; renderEvents(); });

  // ======================= comments =======================
  function counter(field) {
    const c = h('span', { class: 'count', text: '0 / 500' });
    const upd = () => { const n = field.value.trim().length; c.textContent = `${n} / 500`; c.classList.toggle('over', n > 500); };
    field.addEventListener('input', upd); upd();
    return c;
  }

  function commentRow(c, ev, panel) {
    const flag = c.is_mine && {
      pending: 'Waiting for an admin to approve this comment. Only you can see it for now.',
      hidden: 'Hidden by a moderator' + (c.moderation_reason ? `: ${c.moderation_reason}` : '.'),
      removed: 'Removed by a moderator' + (c.moderation_reason ? `: ${c.moderation_reason}` : '.'),
    }[c.status];
    const text = h('div', { class: 't', text: c.body });
    const row = h('div', { class: 'cm ' + c.status },
      C.avatar(c.author_avatar, c.author_name),
      h('div', { class: 'b' },
        h('div', { class: 'h' }, h('strong', { text: c.author_name }), c.is_mine ? h('span', { class: 'tag gold', text: 'YOU' }) : null,
          h('time', { datetime: c.created_at, title: C.fmtDateTime(c.created_at), text: C.ago(c.created_at) }),
          c.edited_at ? h('span', { class: 'ed', text: '· edited' }) : null),
        text, flag ? h('div', { class: 'flag', text: flag }) : null));
    if (c.is_mine && isMember() && (c.status === 'pending' || c.status === 'visible')) {
      const acts = h('div', { class: 'acts' },
        h('button', { type: 'button', text: 'EDIT', onclick: () => {
          const ta = h('textarea', { class: 'input', maxlength: 500, rows: 3 }); ta.value = c.body;
          const save = h('button', { class: 'btn small primary', type: 'button', text: 'SAVE' });
          const ed = h('div', { class: 'cm-form' }, ta, h('div', { class: 'row' }, save,
            h('button', { class: 'btn small ghost', type: 'button', text: 'CANCEL', onclick: () => ed.replaceWith(text, acts) }), counter(ta)));
          save.addEventListener('click', () => busy(save, async () => {
            try {
              const r = await rpc('edit_my_comment', { p_id: c.id, p_body: ta.value });
              toast(r.status === 'pending' ? 'Saved. It will show again after an admin checks it.' : 'Comment updated.', 'ok');
              await loadComments(ev, panel); refreshCount();
            } catch (e) { toast(e.message, 'err'); }
          }));
          text.replaceWith(ed); acts.remove(); ta.focus();
        } }),
        h('button', { type: 'button', text: 'DELETE', onclick: async () => {
          if (!(await ask({ title: 'Delete your comment?', text: 'It will disappear from the event.', confirm: 'Delete', danger: true }))) return;
          try { await rpc('delete_my_comment', { p_id: c.id }); toast('Comment deleted.'); await loadComments(ev, panel); refreshCount(); }
          catch (e) { toast(e.message, 'err'); }
        } }));
      row.querySelector('.b').append(acts);
    }
    return row;
  }

  function commentForm(ev, panel) {
    const s = status();
    if (s === 'signed_out') return h('div', { class: 'row cm-form' }, C.googleButton('Sign in to comment'));
    if (s === 'suspended') return h('div', { class: 'note cm-form', text: 'Commenting is paused while your account is suspended.' });
    if (s !== 'approved') return h('div', { class: 'note cm-form', text: 'You can comment once an admin approves your membership.' });
    const ta = h('textarea', { class: 'input', maxlength: 500, rows: 3, placeholder: 'Say something about this event…', 'aria-label': 'Your comment' });
    const post = h('button', { class: 'btn small primary', type: 'button', text: 'POST' });
    post.addEventListener('click', () => {
      if (ta.value.trim().length < 2) return toast('Write a little more first.', 'err');
      busy(post, async () => {
        try {
          const r = await rpc('post_comment', { p_event: ev.id, p_body: ta.value });
          ta.value = ''; ta.dispatchEvent(new Event('input'));
          toast(r.status === 'pending' ? 'Posted! It will appear for everyone after an admin approves it.' : 'Comment posted.', 'ok');
          await loadComments(ev, panel); refreshCount();
        } catch (e) { toast(e.message, 'err'); }
      });
    });
    return h('div', { class: 'cm-form' }, ta, h('div', { class: 'row' }, post, counter(ta),
      premod ? h('span', { class: 'hint', text: 'Comments appear after a quick check by an admin.' }) : null));
  }

  async function loadComments(ev, panel) {
    if (!panel.childElementCount) panel.append(h('div', { class: 'hint', text: 'Loading comments…' }));
    try {
      const list = await rpc('list_event_comments', { p_event: ev.id });
      panel.replaceChildren(
        list.length ? h('div', null, list.map((c) => commentRow(c, ev, panel))) : h('div', { class: 'hint', text: 'No comments yet. Be the first!' }),
        commentForm(ev, panel));
    } catch (e) {
      panel.replaceChildren(h('div', { class: 'note err' }, e.message, ' ', h('button', { class: 'btn small', type: 'button', text: 'Retry', onclick: () => loadComments(ev, panel) })));
    }
  }
  async function refreshCount() {
    try { counts = Object.fromEntries(((await rpc('event_comment_counts')) || []).map((r) => [r.event_id, r.comments])); } catch { /* keep old */ }
    document.querySelectorAll('.ev').forEach((card) => {
      const id = card.id.replace('event-', ''); const b = card.querySelector('.cm-toggle');
      if (b) b.textContent = counts[id] ? `💬 COMMENTS (${counts[id]})` : '💬 COMMENTS';
    });
  }

  // ======================= start =======================
  C.mountAccount($('#acctSlot'));
  let first = true, who = null;
  C.on(() => {
    renderAccount();
    if (!state.ready) return;
    const now = (state.user?.id || '') + '|' + (state.profile?.membership_status || '');
    if (now !== who) { who = now; loadPolls(); }   // results visibility depends on who is signed in
    if (first) { first = false; loadEvents(); } else renderEvents();
  });
  renderAccount();
  C.init().catch((e) => { console.error(e); toast(C.friendly(e), 'err'); });
  C.every(20000, () => { if (state.ready) loadPolls(true); });
})();
