/* weborg core — TEXT IS THE SOURCE OF TRUTH.
 *
 * A document is literally the lines of an org buffer, plus the line numbers
 * of folded headings (fold state is view state, not file state — org-mode
 * keeps it out of the file too). There is no shadow object model: every
 * feature (folding, agenda, TODO cycling, deadlines, sparse views) derives
 * itself from the text on demand, and every edit writes raw text back.
 * What you see, edit, store and export is always exactly a valid .org file.
 *
 * Timestamp syntax follows the Org manual:
 *   <2004-02-29 Sun>                      active, plain (event/appointment)
 *   <2006-11-02 Thu 10:00-12:00>          with time / time range
 *   <2007-05-16 Wed 12:30 +1w>            repeater (h d w m y)
 *   DEADLINE: <2004-02-29 Sun -5d>        per-entry warning lead
 *   SCHEDULED: <2004-12-25 Sat -2d>       display delay (--2d = first only)
 *   [2006-11-01 Wed]                      inactive — not on the agenda
 *   CLOSED: [2026-10-04 Sun 09:12]        inactive stamp on DONE
 *
 * Pure logic — no DOM. Works in browser (window.Org) and Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Org = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TODO_STATES = ['TODO', 'STARTED', 'WAITING', 'DONE'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const DEADLINE_WARNING_DAYS = 14;   // org-deadline-warning-days equivalent

  // ---------------------------------------------------------------- dates
  // All dates are 'YYYY-MM-DD' strings; local-midnight arithmetic only.
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function nowTimeStr() {
    const d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function parseDate(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]) - 1, da = Number(m[3]);
    const d = new Date(y, mo, da);
    if (isNaN(d)) return null;
    // round-trip check: new Date(2026,1,30) silently rolls to Mar 2
    if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== da) return null;
    return d;
  }
  function addDays(s, n) {
    const d = parseDate(s); if (!d) return null;
    d.setDate(d.getDate() + n);
    return s && d ? d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) : null;
  }
  function addUnits(s, n, unit) {
    const d = parseDate(s); if (!d) return null;
    if (unit === 'h') return s;                       // hours don't move the day
    if (unit === 'w') d.setDate(d.getDate() + 7 * n);
    else if (unit === 'm') d.setMonth(d.getMonth() + n);
    else if (unit === 'y') d.setFullYear(d.getFullYear() + n);
    else d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function daysBetween(a, b) {
    const da = parseDate(a), db = parseDate(b);
    if (!da || !db) return null;
    return Math.round((db - da) / 86400000);
  }
  function dayName(s) { const d = parseDate(s); return d ? WEEKDAYS[d.getDay()] : ''; }

  // Free-form date entry (minibuffer): 'YYYY-MM-DD', 'DD.MM.YYYY', 'today',
  // '+3d'/'-1w' relative. Returns {date}, {clear:true}, or null if garbage.
  function parseDateInput(s) {
    s = String(s == null ? '' : s).trim().toLowerCase();
    if (!s || s === 'clear' || s === 'none') return { clear: true };
    if (s === 'today' || s === 't' || s === '.') return { date: todayStr() };
    let m = /^([+-])\s*(\d+)\s*(d|w)?$/.exec(s);
    if (m) {
      const n = Number(m[2]) * (m[3] === 'w' ? 7 : 1) * (m[1] === '-' ? -1 : 1);
      return { date: addDays(todayStr(), n) };
    }
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return parseDate(s) ? { date: s } : null;
    m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/.exec(s);
    if (m) {
      const y = m[3] ? Number(m[3]) : new Date().getFullYear();
      const cand = y + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[1]));
      return parseDate(cand) ? { date: cand } : null;
    }
    return null;
  }

  // ---------------------------------------------------------------- doc
  // The document IS its text. Only two things exist: the lines, and which
  // heading lines are folded.
  function makeDoc(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    // a file ending in '\n' yields one trailing empty element — drop it
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) lines.push('');
    return { lines: lines, folded: {} };
  }
  function textOf(doc) { return doc.lines.join('\n') + '\n'; }

  // ------------------------------------------------------------- timestamps
  const TS_RE = /([<\[])(\d{4})-(\d{2})-(\d{2})(?:\s+([A-Za-z]{3}))?(?:\s+(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?)?(?:\s+(-{1,2}|\+)(\d+)([hdwmy]))?(?:\s+(\d{1,2}:\d{2}))?\s*([>\]])/g;

  // Every timestamp in `text`, with exact [start,end) offsets INTO text —
  // decorations slice the raw string at these spans, they never rebuild it.
  function findTimestamps(text) {
    const out = [];
    TS_RE.lastIndex = 0;
    let m;
    while ((m = TS_RE.exec(text))) {
      const date = m[2] + '-' + m[3] + '-' + m[4];
      if (!parseDate(date)) continue;      // reject 2026-02-30 & co.
      // sign '+' = repeater, '-'/'--' = warning/delay cookie
      const sign = m[8] || null;
      out.push({
        start: m.index, end: m.index + m[0].length, raw: m[0],
        date: date, weekday: m[5] || null,
        time: m[6] || null, timeEnd: m[7] || null,
        repeater: sign === '+' ? { n: Number(m[9]), unit: m[10] } : null,
        delay: sign && sign !== '+' ? { sign: sign, n: Number(m[9]), unit: m[10] } : null,
        timeAfter: m[11] || null,
        active: m[1] === '<',
      });
    }
    return out;
  }
  function firstTimestamp(text) { const a = findTimestamps(text); return a.length ? a[0] : null; }

  // Canonical timestamp text (correct weekday always added, like org does
  // when a date is inserted or modified). Only used when WRITING new text.
  function tsText(date, opts) {
    opts = opts || {};
    let s = (opts.active === false ? '[' : '<') + date + ' ' + dayName(date);
    if (opts.time) s += ' ' + opts.time + (opts.timeEnd ? '-' + opts.timeEnd : '');
    if (opts.repeater) s += ' +' + opts.repeater;
    if (opts.delay) s += ' ' + opts.delay;
    s += (opts.active === false ? ']' : '>');
    return s;
  }
  // Nearest occurrence >= today for a repeating timestamp.
  function effectiveDate(ts, today) {
    let d = ts.date;
    if (ts.repeater) {
      let guard = 0;
      while (d < today && guard++ < 5000) d = addUnits(d, ts.repeater.n, ts.repeater.unit);
    }
    return d;
  }

  // ------------------------------------------------------------- headings
  // Parse WITHOUT normalizing anything: we return the raw line plus exact
  // column spans, because the renderer decorates those spans in place.
  function parseHeadingLine(raw) {
    const m = /^(\*+)(?:[ \t]|$)/.exec(raw);
    if (!m) return null;
    const starsLen = m[1].length;
    let p = raw.charAt(starsLen) === ' ' || raw.charAt(starsLen) === '\t' ? starsLen + 1 : starsLen;
    const spans = { stars: [0, starsLen] };
    let state = null, priority = null, tags = [];
    const sm = new RegExp('^(' + TODO_STATES.join('|') + ')(?:[ \t]|$)').exec(raw.slice(p));
    if (sm) { spans.state = [p, p + sm[1].length]; state = sm[1]; p += sm[1].length + 1; }
    const pm = /^\[#([A-Za-z])\]/.exec(raw.slice(p));
    if (pm) {
      spans.priority = [p, p + 4];        // '[#X]' is exactly 4 chars
      priority = pm[1]; p += 5;           // skip the following space
    }
    let titleStart = p;
    let titleEnd = raw.length;
    const tgm = /\s(:[A-Za-z0-9_@#]+(?::[A-Za-z0-9_@#]+)*:)[ \t]*$/.exec(raw);
    if (tgm && tgm.index >= p - 1) {
      tags = tgm[1].split(':').filter(Boolean);
      spans.tags = [tgm.index + 1, tgm.index + 1 + tgm[1].length];
      titleEnd = tgm.index;
    }
    spans.title = [titleStart, titleEnd];
    return {
      level: starsLen, raw: raw,
      state: state, priority: priority, tags: tags,
      title: raw.slice(titleStart, titleEnd).replace(/[ \t]+$/, ''),
      spans: spans,
    };
  }

  // Rebuild one heading line from fields — used only by keyword ops (T, [,
  // t t). Layout follows org convention: '* TODO [#A] title  :tags:'.
  function rebuildHeading(f) {
    let s = '*'.repeat(f.level) + ' ';
    if (f.state) s += f.state + ' ';
    if (f.priority) s += '[#' + f.priority + '] ';
    s += f.title == null ? '' : f.title;
    if (f.tags && f.tags.length) s += '  :' + f.tags.join(':') + ':';
    return s;
  }

  // ------------------------------------------------------------- properties
  const PROP_RE = /^([ \t]*)(DEADLINE|SCHEDULED|CLOSED):[ \t]*(.*)$/;

  // ------------------------------------------------------------- scan
  // Derive structure from the text. Cheap enough to run per op; nothing is
  // cached because the text may change between any two calls.
  // s.headings: lineIdx -> info {level, raw, state, priority, tags, title,
  //   spans, deadline/scheduled/closed: {line, ts} | null,
  //   events: [{line, ts} for plain timestamps in heading/body]}
  // s.order: heading line indices in buffer order; s.pos: lineIdx -> k.
  function scan(doc) {
    const lines = doc.lines;
    const headings = {};
    const order = [];
    const pos = {};

    for (let i = 0; i < lines.length; i++) {
      const h = parseHeadingLine(lines[i]);
      if (!h) continue;
      Object.assign(h, { line: i, deadline: null, scheduled: null, closed: null, events: [] });
      headings[i] = h; pos[i] = order.length; order.push(i);
    }

    // Planning lines: consecutive KEY: lines directly below the heading.
    for (let k = 0; k < order.length; k++) {
      const info = headings[order[k]];
      let i = info.line + 1;
      while (i < lines.length) {
        const pm = PROP_RE.exec(lines[i]);
        if (!pm) break;
        const rec = { line: i, ts: firstTimestamp(pm[3]) };
        if (pm[2] === 'DEADLINE') info.deadline = rec;
        else if (pm[2] === 'SCHEDULED') info.scheduled = rec;
        else info.closed = rec;
        i++;
      }
    }

    // Plain timestamps -> agenda events. Heading lines and body lines;
    // planning lines are covered by deadline/scheduled/closed.
    const isPropLine = {};
    for (const idx in headings) {
      const h = headings[idx];
      [h.deadline, h.scheduled, h.closed].forEach(function (r) { if (r) isPropLine[r.line] = true; });
    }
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      if (headings[i]) cur = headings[i];
      if (!cur || isPropLine[i]) continue;
      // any timestamp in a heading title or body line is an event stamp
      findTimestamps(lines[i]).forEach(function (ts) {
        cur.events.push({ line: i, ts: ts });
      });
    }
    return { headings: headings, order: order, pos: pos, lines: lines };
  }

  // End (exclusive) of the section starting at heading line i: everything
  // up to the next heading of the same or shallower level.
  function blockEnd(s, doc, i) {
    const h = s.headings[i];
    if (!h) return i + 1;
    const k = s.pos[i];
    for (let j = k + 1; j < s.order.length; j++) {
      if (s.headings[s.order[j]].level <= h.level) return s.order[j];
    }
    return doc.lines.length;
  }

  // Nearest heading line at or above line i (for T/dates/etc. on body lines).
  function headingLineOf(s, i) {
    let best = -1;
    for (const idx in s.headings) { const k = Number(idx); if (k <= i && (best < 0 || k > best)) best = k; }
    return best < 0 ? null : best;
  }

  // ------------------------------------------------------------- visibility
  function visibleLines(doc) {
    const s = scan(doc);
    const res = [];
    let hideLevel = -1;
    for (let i = 0; i < doc.lines.length; i++) {
      const h = s.headings[i];
      if (h) {
        if (hideLevel >= 0 && h.level > hideLevel) continue;
        hideLevel = -1;
        res.push(i);
        if (doc.folded[i]) hideLevel = h.level;
      } else {
        if (hideLevel >= 0) continue;
        res.push(i);
      }
    }
    return res;
  }

  // ------------------------------------------------------------- line ops
  // Every op keeps fold keys pointing at the right headings afterwards.
  function mapFolds(doc, fn) {
    const nf = {};
    for (const k in doc.folded) { const ni = fn(Number(k)); if (ni != null && ni >= 0) nf[ni] = true; }
    doc.folded = nf;
  }
  function insertLine(doc, i, text) {
    doc.lines.splice(i, 0, text);
    mapFolds(doc, function (ki) { return ki >= i ? ki + 1 : ki; });
  }
  function insertBlock(doc, i, lines) {
    doc.lines.splice(i, 0, ...lines);
    const n = lines.length;
    mapFolds(doc, function (ki) { return ki >= i ? ki + n : ki; });
  }
  function deleteLine(doc, i) {
    doc.lines.splice(i, 1);
    mapFolds(doc, function (ki) {
      if (ki === i) return null;
      return ki > i ? ki - 1 : ki;
    });
  }
  function deleteBlock(doc, start, end) {
    const removed = doc.lines.slice(start, end);
    doc.lines.splice(start, end - start);
    const n = end - start;
    mapFolds(doc, function (ki) {
      if (ki >= start && ki < end) return null;
      return ki >= end ? ki - n : ki;
    });
    return removed;
  }
  // Move lines [start,end) before index `target` (index in the CURRENT
  // array; must not be inside the moved range).
  function moveBlock(doc, start, end, target) {
    if (target >= start && target < end) return false;
    const n = end - start;
    const t = target > end ? target - n : target;   // insertion point post-removal
    const block = doc.lines.splice(start, n);
    doc.lines.splice(t, 0, ...block);
    mapFolds(doc, function (ki) {
      if (ki >= start && ki < end) return t + (ki - start);
      const base = ki >= end ? ki - n : ki;
      return base >= t ? base + n : base;
    });
    return true;
  }

  // ------------------------------------------------------------- heading ops
  function editHeading(doc, i, mut) {
    const f = parseHeadingLine(doc.lines[i]);
    if (!f) return null;
    mut(f);
    doc.lines[i] = rebuildHeading(f);
    return f;
  }

  function findPropLine(s, i, key) {
    const h = s.headings[i]; if (!h) return null;
    const rec = h[key];
    return rec ? rec.line : null;
  }
  // Write (replace or insert) a planning line for the section at heading i.
  // Returns the line index used. Insertion keeps org order CLOSED, SCHEDULED,
  // DEADLINE directly below the heading.
  function setPropLine(doc, i, key, tsRaw) {
    const s = scan(doc);
    const h = s.headings[i]; if (!h) return -1;
    const existing = findPropLine(s, i, key.toLowerCase());
    if (existing != null) { doc.lines[existing] = '  ' + key + ': ' + tsRaw; return existing; }
    let at = h.line + 1;
    ['closed', 'scheduled', 'deadline'].forEach(function (k) {
      const l = findPropLine(s, i, k);
      if (l != null && l >= at) at = l + 1;
    });
    insertLine(doc, at, '  ' + key + ': ' + tsRaw);
    return at;
  }
  function removeProp(doc, i, key) {
    const s = scan(doc);
    const l = findPropLine(s, i, key.toLowerCase());
    if (l == null) return false;
    deleteLine(doc, l);
    return true;
  }
  function stampClosed(doc, i) {
    return setPropLine(doc, i, 'CLOSED', tsText(todayStr(), { time: nowTimeStr(), active: false }));
  }

  function cycleState(doc, i) {
    const s = scan(doc);
    const h = s.headings[i];
    if (!h) return null;
    const seq = [null].concat(TODO_STATES);
    const prev = h.state;
    const next = seq[(seq.indexOf(prev) + 1) % seq.length];
    editHeading(doc, i, function (f) { f.state = next; });
    if (next === 'DONE') stampClosed(doc, i);
    else if (prev === 'DONE') removeProp(doc, i, 'closed');
    return next;
  }
  // After the user retyped a heading line: keep CLOSED consistent,
  // like org-todo does. prevH may be null (was body line).
  function syncClosedOnHeadingEdit(doc, i, prevState, newState) {
    if (newState === 'DONE' && prevState !== 'DONE') stampClosed(doc, i);
    else if (newState !== 'DONE' && prevState === 'DONE') removeProp(doc, i, 'closed');
  }

  // Set DEADLINE / SCHEDULED ('deadline'|'scheduled') to 'YYYY-MM-DD'
  // (null clears). Preserves time / repeater / cookie of the old stamp.
  function setDate(doc, i, field, date) {
    const key = field === 'deadline' ? 'DEADLINE' : 'SCHEDULED';
    if (date == null) return removeProp(doc, i, key.toLowerCase()) ? -2 : -1;
    const s = scan(doc);
    const l = findPropLine(s, i, key.toLowerCase());
    const old = l != null ? firstTimestamp(doc.lines[l]) : null;
    const ts = tsText(date, {
      time: old ? old.time : null, timeEnd: old ? old.timeEnd : null,
      repeater: old && old.repeater ? old.repeater.n + old.repeater.unit : null,
      delay: old && old.delay ? old.delay.sign + old.delay.n + old.delay.unit : null,
    });
    return setPropLine(doc, i, key, ts);
  }
  // Nudge a section's DEADLINE/SCHEDULED by n days (the `+`/`-` keys).
  // Rewrites only the timestamp span in place — the rest of the line text
  // (including anything the user typed there) survives untouched.
  function nudgeDate(doc, i, field, n) {
    const s = scan(doc);
    const l = findPropLine(s, i, field === 'scheduled' ? 'scheduled' : 'deadline');
    if (l == null) return false;
    const ts = firstTimestamp(doc.lines[l]);
    if (!ts) return false;
    const d = addDays(ts.date, n); if (!d) return false;
    const rest = tsText(d, {
      active: ts.active, time: ts.time, timeEnd: ts.timeEnd,
      repeater: ts.repeater ? ts.repeater.n + ts.repeater.unit : null,
      delay: ts.delay ? ts.delay.sign + ts.delay.n + ts.delay.unit : null,
    });
    doc.lines[l] = doc.lines[l].slice(0, ts.start) + rest + doc.lines[l].slice(ts.end);
    return true;
  }
  function clearDates(doc, i) {
    const s = scan(doc);
    const ls = [findPropLine(s, i, 'deadline'), findPropLine(s, i, 'scheduled')]
      .filter(function (v) { return v != null; })
      .sort(function (a, b) { return b - a; });
    ls.forEach(function (l) { deleteLine(doc, l); });
    return ls.length > 0;
  }

  function setTags(doc, i, tags) {
    return editHeading(doc, i, function (f) {
      f.tags = Array.from(new Set(
        (tags || []).map(function (t) { return String(t).trim().replace(/:/g, ''); }).filter(Boolean)));
    });
  }
  function setPriority(doc, i, p) {
    return editHeading(doc, i, function (f) {
      f.priority = f.priority === p ? null : p;
    });
  }

  // ------------------------------------------------------------- structure
  // New heading after the current section (org M-RET / C-S-RET style).
  // asChild: inserted inside the section at the end, one level deeper.
  function insertHeadingBelow(doc, i, asChild) {
    const s = scan(doc);
    const h = s.headings[i];
    let level, at;
    if (h) {
      level = asChild ? h.level + 1 : h.level;
      at = blockEnd(s, doc, i);
      delete doc.folded[i];                 // show what we just made
    } else {
      level = 1; at = i + 1;
    }
    insertLine(doc, at, '*'.repeat(level) + ' ');
    return at;
  }

  // M-down / M-up: swap section with next/previous SAME-LEVEL sibling.
  // (org-promote/demote-style reorder; textwise it's one block move.)
  function moveSection(doc, i, dir) {
    const s = scan(doc);
    const h = s.headings[i]; if (!h) return false;
    const k = s.pos[i];
    const end = blockEnd(s, doc, i);
    if (dir > 0) {
      // next sibling = first following heading with level <= ours
      for (let j = k + 1; j < s.order.length; j++) {
        const nk = s.order[j];
        const nl = s.headings[nk].level;
        if (nl < h.level) return false;               // left the parent: blocked
        if (nl === h.level) return moveBlock(doc, i, end, blockEnd(s, doc, nk));
      }
      return false;
    }
    // dir < 0: previous sibling, walking back over deeper headings
    for (let j = k - 1; j >= 0; j--) {
      const pk = s.order[j];
      const pl = s.headings[pk].level;
      if (pl < h.level) return false;                 // parent above: blocked
      if (pl === h.level) return moveBlock(doc, i, end, pk);
    }
    return false;
  }

  // org-demote/promote-subtree: exactly what the manual does — add/remove
  // a star on the heading and every heading in its subtree. No reordering
  // needed: in text, parenthood IS the surrounding star levels.
  function changeLevel(doc, i, delta) {
    const s = scan(doc);
    const h = s.headings[i]; if (!h) return false;
    if (delta < 0 && h.level <= 1) return false;
    if (delta > 0 && !s.order.some(function (pk) { return pk < i && s.headings[pk].level <= h.level; })) return false; // nothing to hang under
    const end = blockEnd(s, doc, i);
    for (let j = i; j < end; j++) {
      const hh = parseHeadingLine(doc.lines[j]);
      if (!hh) continue;
      hh.level = hh.level + delta;
      doc.lines[j] = rebuildHeading(hh);
    }
    // line indices don't move, so fold keys stay valid untouched
    return true;
  }

  // ------------------------------------------------------------- agenda
  // items: {line, headline, kind:'deadline'|'scheduled'|'event', ts, date,
  //         overdue} — overdue first, then by date.
  // Rules from the manual: deadline shows ON its date + warning before it
  // (org-deadline-warning-days, per-entry lead '-5d' overrides), until DONE;
  // scheduled reminds from its date until DONE (display delay shifts it);
  // plain timestamps show exactly on (the effective occurrence of) their day.
  function agenda(doc, days) {
    days = days == null ? 14 : days;
    const today = todayStr();
    const horizon = addDays(today, days);
    const s = scan(doc);
    const items = [];
    function push(h, kind, ts) {
      if (!ts || !ts.active) return;                  // inactive: not on agenda
      const eff = effectiveDate(ts, today);
      const done = h.state === 'DONE';
      // display delay on SCHEDULED shifts when it starts showing
      const showFrom = kind === 'scheduled' && ts.delay ? addUnits(eff, ts.delay.n, ts.delay.unit) : eff;
      const warnFrom = kind === 'deadline'
        ? addDays(eff, -(ts.delay ? ts.delay.n : DEADLINE_WARNING_DAYS))
        : showFrom;
      const inWindow = showFrom <= horizon || warnFrom <= horizon;
      if (!inWindow) return;
      if (eff < today) {
        if (!done) items.push({ line: h.line, headline: h.title, kind: kind, ts: ts, date: eff, overdue: true });
      } else {
        if (done && kind !== 'event') return;         // finished tasks drop off
        items.push({ line: h.line, headline: h.title, kind: kind, ts: ts, date: eff, overdue: false });
      }
    }
    for (const idx in s.headings) {
      const h = s.headings[idx];
      if (h.deadline) push(h, 'deadline', h.deadline.ts);
      if (h.scheduled) push(h, 'scheduled', h.scheduled.ts);
      h.events.forEach(function (e) { push(h, 'event', e.ts); });
    }
    items.sort(function (a, b) {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const rank = { deadline: 0, scheduled: 1, event: 2 };
      return rank[a.kind] - rank[b.kind];
    });
    return items;
  }

  function countStats(doc) {
    const s = scan(doc);
    let total = 0, done = 0;
    for (const idx in s.headings) { total++; if (s.headings[idx].state === 'DONE') done++; }
    return { total: total, done: done };
  }

  // Sparse tags view (org's tags-view): kept lines = every match's FULL
  // section, plus the ancestor heading lines that hold matches. Fold state
  // ignored. Returns sorted array of line indices.
  function tagViewLines(doc, matchFn) {
    const s = scan(doc);
    const keep = {};
    for (const idx in s.headings) {
      const h = s.headings[idx];
      if (!matchFn(h)) continue;
      const end = blockEnd(s, doc, h.line);
      for (let j = h.line; j < end; j++) keep[j] = true;
      // ancestors
      let curLevel = h.level;
      const k = s.pos[h.line];
      for (let m = k - 1; m >= 0 && curLevel > 1; m--) {
        const a = s.headings[s.order[m]];
        if (a.level < curLevel) { keep[a.line] = true; curLevel = a.level; }
      }
    }
    return Object.keys(keep).map(Number).sort(function (a, b) { return a - b; });
  }

  return {
    TODO_STATES: TODO_STATES, WEEKDAYS: WEEKDAYS,
    DEADLINE_WARNING_DAYS: DEADLINE_WARNING_DAYS,
    todayStr: todayStr, parseDate: parseDate, addDays: addDays, addUnits: addUnits,
    daysBetween: daysBetween, dayName: dayName, parseDateInput: parseDateInput,
    makeDoc: makeDoc, textOf: textOf,
    TS_RE: TS_RE, findTimestamps: findTimestamps, firstTimestamp: firstTimestamp,
    tsText: tsText, effectiveDate: effectiveDate,
    parseHeadingLine: parseHeadingLine, rebuildHeading: rebuildHeading,
    PROP_RE: PROP_RE, scan: scan, blockEnd: blockEnd, headingLineOf: headingLineOf,
    visibleLines: visibleLines,
    insertLine: insertLine, insertBlock: insertBlock, deleteLine: deleteLine,
    deleteBlock: deleteBlock, moveBlock: moveBlock,
    editHeading: editHeading, cycleState: cycleState, syncClosedOnHeadingEdit: syncClosedOnHeadingEdit,
    stampClosed: stampClosed, setPropLine: setPropLine, removeProp: removeProp,
    setDate: setDate, nudgeDate: nudgeDate, clearDates: clearDates,
    setTags: setTags, setPriority: setPriority,
    insertHeadingBelow: insertHeadingBelow, moveSection: moveSection, changeLevel: changeLevel,
    agenda: agenda, countStats: countStats, tagViewLines: tagViewLines,
  };
});
