// Turns raw sheet rows (array of arrays, first row = headers) into clean
// event rows for apply_event_sync(). Pure functions, no network: easy to test.
import { createHash } from 'node:crypto';

// Accepted column names (case and spacing don't matter).
const COLUMNS = {
  external_id: ['id', 'event id', 'eventid', 'event_id', 'key'],
  title:       ['title', 'event', 'event title', 'event name', 'name'],
  date:        ['date', 'event date', 'day'],
  start_time:  ['start time', 'time', 'from', 'starts'],
  start:       ['start', 'starts at', 'start date', 'start datetime', 'begins'],
  end:         ['end', 'ends at', 'end datetime', 'end date'],
  end_time:    ['end time', 'to', 'until', 'ends'],
  venue:       ['venue', 'location', 'room', 'place', 'where'],
  description: ['description', 'details', 'desc', 'about', 'notes'],
  image_url:   ['image', 'image url', 'image link', 'poster', 'poster url', 'media', 'media url', 'banner'],
  category:    ['category', 'type', 'tag', 'kind'],
  status:      ['status', 'state'],
};

const STATUS = {
  scheduled: 'scheduled', upcoming: 'scheduled', confirmed: 'scheduled', open: 'scheduled', on: 'scheduled', yes: 'scheduled',
  postponed: 'postponed', delayed: 'postponed', rescheduled: 'postponed',
  cancelled: 'cancelled', canceled: 'cancelled', off: 'cancelled',
  completed: 'completed', done: 'completed', finished: 'completed', past: 'completed',
  hidden: 'hidden', draft: 'hidden', private: 'hidden', hide: 'hidden',
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const cleanMultiline = (v) => String(v ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

export function mapHeaders(headerRow) {
  const idx = {};
  (headerRow || []).forEach((h, i) => {
    const key = clean(h).toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s*\(.*\)\s*$/, '');
    for (const [field, names] of Object.entries(COLUMNS)) {
      if (idx[field] === undefined && names.includes(key)) idx[field] = i;
    }
  });
  return idx;
}

// Date part -> {y,m,d}. Day-first for numeric dates (India).
export function parseDate(s) {
  s = clean(s);
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) return ymd(year(+m[3]), +m[2], +m[1]);
  if ((m = s.match(/^(?:[a-z]+,?\s+)?(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})\.?,?[\s-]+(\d{2,4})/i))) return ymd(year(+m[3]), MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  if ((m = s.match(/^(?:[a-z]+,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})/i))) return ymd(year(+m[3]), MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  return null;
}
const year = (y) => (y < 100 ? 2000 + y : y);
function ymd(y, m, d) {
  if (!m || m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return null;          // 31 Feb etc.
  return { y, m, d };
}

// Time part -> {h,mi}. Accepts 15:30, 3:30 PM, 3pm, 15.30, 1530.
export function parseTime(s) {
  s = clean(s).toLowerCase();
  if (!s) return null;
  let m = s.match(/(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/);
  if (!m) return null;
  let h = +m[1]; const mi = +(m[2] || 0); const ap = m[3]?.replace(/\./g, '');
  if (!m[2] && !ap) return null;                        // a bare "3" is ambiguous
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

// Date (+ optional time) in India time -> ISO string with +05:30.
export function toIstIso(dateStr, timeStr) {
  const s = clean(dateStr);
  if (!s) return null;
  // full ISO with zone: trust it
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = new Date(s);
    return isNaN(t) ? null : t.toISOString();
  }
  const d = parseDate(s);
  if (!d) return null;
  // time may be inside the date cell ("2026-11-14 15:30", "14/11/2026 3:30 PM")
  const rest = s.replace(/^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|(?:[a-z]+,?\s+)?\d{1,2}(?:st|nd|rd|th)?[\s-]+[a-z]{3,9}\.?,?[\s-]+\d{2,4}|(?:[a-z]+,?\s+)?[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4})/i, '').replace(/^[T,\s]+/i, '');
  const t = parseTime(timeStr) || parseTime(rest) || { h: 0, mi: 0 };
  return `${d.y}-${pad(d.m)}-${pad(d.d)}T${pad(t.h)}:${pad(t.mi)}:00+05:30`;
}

// Google Drive share links -> a direct image link; anything not https is dropped.
export function normalizeImageUrl(u) {
  u = clean(u);
  if (!u) return '';
  let m = u.match(/drive\.google\.com\/file\/d\/([\w-]{10,})/) || u.match(/drive\.google\.com\/(?:open|uc)\?(?:.*&)?id=([\w-]{10,})/);
  if (m) return `https://lh3.googleusercontent.com/d/${m[1]}`;
  if (/^https:\/\/[^\s]+$/i.test(u)) return u.slice(0, 1000);
  return null;   // invalid
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

export function normalizeRows(values) {
  const warnings = [];
  if (!Array.isArray(values) || values.length === 0) {
    return { rows: [], skipped: 0, rowsRead: 0, warnings: ['The sheet is empty.'] };
  }
  const idx = mapHeaders(values[0]);
  if (idx.title === undefined || (idx.date === undefined && idx.start === undefined)) {
    return { rows: [], skipped: 0, rowsRead: Math.max(values.length - 1, 0),
      warnings: ['The first row must be headers with at least a "Title" column and a "Date" (or "Start") column.'] };
  }
  const get = (r, f) => (idx[f] === undefined ? '' : r[idx[f]] ?? '');
  const rows = []; const seen = new Set(); let skipped = 0; let rowsRead = 0;

  values.slice(1).forEach((r, i) => {
    const line = i + 2;   // sheet row number
    if (!r || r.every((c) => clean(c) === '')) return;    // blank line
    rowsRead++;
    const title = clean(get(r, 'title')).slice(0, 140);
    if (title.length < 2) { skipped++; warnings.push(`Row ${line}: no title, skipped.`); return; }

    const dateCell = clean(get(r, 'start')) || clean(get(r, 'date'));
    const starts_at = toIstIso(dateCell, get(r, 'start_time'));
    if (!starts_at) { skipped++; warnings.push(`Row ${line} ("${title}"): could not read the date "${dateCell}", skipped.`); return; }

    let ends_at = '';
    const endCell = clean(get(r, 'end'));
    const endTime = clean(get(r, 'end_time'));
    if (endCell || endTime) {
      // "End" may hold a date (+time); a lone "End time" belongs to the start date
      const startDay = new Date(new Date(starts_at).getTime() + 19800e3).toISOString().slice(0, 10);
      ends_at = (endCell ? toIstIso(endCell, endTime) : toIstIso(startDay, endTime)) || '';
      if (!ends_at) warnings.push(`Row ${line} ("${title}"): could not read the end time, ignored it.`);
      if (ends_at && new Date(ends_at) < new Date(starts_at)) {
        warnings.push(`Row ${line} ("${title}"): end is before start, ignored the end.`); ends_at = '';
      }
    }

    let image_url = normalizeImageUrl(get(r, 'image_url'));
    if (image_url === null) { warnings.push(`Row ${line} ("${title}"): image link must start with https://, ignored it.`); image_url = ''; }

    const rawStatus = clean(get(r, 'status')).toLowerCase();
    let status = rawStatus ? STATUS[rawStatus] : 'scheduled';
    if (!status) { warnings.push(`Row ${line} ("${title}"): unknown status "${rawStatus}", using "scheduled".`); status = 'scheduled'; }

    const given = clean(get(r, 'external_id')).slice(0, 80);
    const external_id = given || 'auto-' + sha(`${title.toLowerCase()}|${starts_at.slice(0, 10)}`).slice(0, 16);
    if (seen.has(external_id)) { skipped++; warnings.push(`Row ${line} ("${title}"): duplicate id "${external_id}", skipped.`); return; }
    seen.add(external_id);

    const ev = {
      external_id, title, starts_at, ends_at,
      venue: clean(get(r, 'venue')).slice(0, 140),
      description: cleanMultiline(get(r, 'description')).slice(0, 2000),
      image_url,
      category: clean(get(r, 'category')).toUpperCase().slice(0, 40),
      status,
    };
    ev.hash = sha(JSON.stringify(ev));
    rows.push(ev);
  });
  return { rows, skipped, rowsRead, warnings };
}

// Small RFC 4180 CSV parser (quoted fields, commas and newlines inside quotes).
export function parseCsv(text) {
  const out = []; let row = []; let f = ''; let q = false;
  text = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); out.push(row); row = []; f = '';
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); out.push(row); }
  return out;
}
