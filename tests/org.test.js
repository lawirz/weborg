/* Core tests — the document is TEXT. Run: node tests/org.test.js
 * Every assertion either checks the exact buffer text or the view derived
 * from it. If a feature can't be expressed in .org text, it can't exist. */
'use strict';
const assert = require('assert');
const O = require('../js/org.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
function doc(src) { return O.makeDoc(src); }
function text(d) { return O.textOf(d); }

// ------------------------------------------------------------------ doc = text
t('makeDoc/textOf is lossless', function () {
  const src = '#+TITLE: X\n* A\nbody\n\n** B\n';
  const d = doc(src);
  assert.strictEqual(O.textOf(d), src);
  assert.strictEqual(d.lines.length, 5);
});
t('CRLF normalized, empty buffer keeps one line', function () {
  assert.deepStrictEqual(doc('a\r\nb\n').lines, ['a', 'b']);
  const e = doc('');
  assert.strictEqual(e.lines.length, 1);
  assert.strictEqual(text(e), '\n');
});

// ------------------------------------------------------------------ headings
t('parseHeadingLine keeps raw text + spans, changes nothing', function () {
  const raw = '** TODO [#A] Buy milk       :shopping:errand:';
  const h = O.parseHeadingLine(raw);
  assert.strictEqual(h.raw, raw);
  assert.strictEqual(h.level, 2);
  assert.strictEqual(h.state, 'TODO');
  assert.strictEqual(h.priority, 'A');
  assert.strictEqual(h.tags.join(','), 'shopping,errand');
  assert.strictEqual(h.title, 'Buy milk');
  // the spans slice the ORIGINAL line — decorations never touch the text
  assert.strictEqual(raw.slice(h.spans.stars[0], h.spans.stars[1]), '**');
  assert.strictEqual(raw.slice(h.spans.state[0], h.spans.state[1]), 'TODO');
  assert.strictEqual(raw.slice(h.spans.priority[0], h.spans.priority[1]), '[#A]');
  assert.strictEqual(raw.slice(h.spans.tags[0], h.spans.tags[1]), ':shopping:errand:');
  assert.ok(h.spans.title[0] <= raw.indexOf('Buy') && raw.indexOf('milk') < h.spans.title[1]);
});
t('bare stars, no trailing space, still a heading', function () {
  assert.strictEqual(O.parseHeadingLine('***').level, 3);
  assert.strictEqual(O.parseHeadingLine('**** x').level, 4);
});
t('unknown ALLCAPS is not a TODO state', function () {
  const h = O.parseHeadingLine('* NOODLE weird line');
  assert.strictEqual(h.state, null);
  assert.strictEqual(h.title, 'NOODLE weird line');
});
t('body line is not a heading; indented stars are not headings', function () {
  assert.strictEqual(O.parseHeadingLine('regular text'), null);
  assert.strictEqual(O.parseHeadingLine('  * fake'), null);
});

// ------------------------------------------------------------------ timestamps
t('plain active timestamp parsed with all decorations', function () {
  const line = 'DEADLINE: <2004-02-29 Sun -5d>';
  const ts = O.firstTimestamp(line);
  assert.strictEqual(ts.date, '2004-02-29');
  assert.strictEqual(ts.weekday, 'Sun');
  assert.strictEqual(ts.active, true);
  assert.strictEqual(ts.delay.n, 5);
  assert.strictEqual(ts.delay.unit, 'd');
  // exact span back into the line
  assert.strictEqual(line.slice(ts.start, ts.end), '<2004-02-29 Sun -5d>');
});
t('time and time-range timestamps', function () {
  const a = O.firstTimestamp('meet <2006-11-01 Wed 19:15> ok');
  assert.strictEqual(a.time, '19:15');
  const b = O.firstTimestamp('<2006-11-02 Thu 10:00-12:00>');
  assert.strictEqual(b.time, '10:00');
  assert.strictEqual(b.timeEnd, '12:00');
});
t('repeater parsed and effective date advances', function () {
  const ts = O.firstTimestamp('<2007-05-16 Wed 12:30 +1w>');
  assert.deepStrictEqual(ts.repeater, { n: 1, unit: 'w' });
  assert.strictEqual(ts.date, '2007-05-16');
  // nearest occurrence on-or-after the reference day (2007-06-13 IS an occurrence)
  assert.strictEqual(O.effectiveDate(ts, '2007-06-13'), '2007-06-13');
  assert.strictEqual(O.effectiveDate(ts, '2007-06-14'), '2007-06-20');
});
t('inactive [..] timestamp is flagged inactive', function () {
  const ts = O.firstTimestamp('note [2006-11-01 Wed] here');
  assert.strictEqual(ts.active, false);
});
t('double-dash delay cookie parses', function () {
  const ts = O.firstTimestamp('SCHEDULED: <2004-12-25 Sat --2d>');
  assert.strictEqual(ts.delay.sign, '--');
  assert.strictEqual(ts.delay.n, 2);
});
t('invalid calendar date rejected', function () {
  assert.strictEqual(O.firstTimestamp('<2026-02-30 Mon>'), null);
});
t('tsText always writes the weekday (org convention)', function () {
  assert.strictEqual(O.tsText('2026-10-04'), '<2026-10-04 Sun>');
});

// ------------------------------------------------------------------ properties
t('scan finds DEADLINE/SCHEDULED/CLOSED under a heading', function () {
  const d = doc([
    '* TODO Task',
    '  DEADLINE: <2026-10-05 Mon +1w>',
    '  SCHEDULED: <2026-10-01 Thu>',
    '  CLOSED: [2026-09-30 Wed]',
    'body line',
  ].join('\n'));
  const s = O.scan(d);
  const h = s.headings[0];
  assert.strictEqual(h.deadline.line, 1);
  assert.strictEqual(h.deadline.ts.date, '2026-10-05');
  assert.strictEqual(h.deadline.ts.repeater.n, 1);
  assert.strictEqual(h.scheduled.line, 2);
  assert.strictEqual(h.closed.line, 3);
});
t('scan collects plain timestamps as events', function () {
  const d = doc('* Meet Peter\n  <2026-11-01 Sun 19:15>\n  off days:\n  <2026-11-06 Fri>\n').lines.join('\n');
  const s = O.scan(O.makeDoc(d));
  const evs = s.headings[0].events;
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(evs[0].ts.time, '19:15');
  assert.strictEqual(evs[1].line, 3);
});

// ------------------------------------------------------------------ folding
t('fold hides the section, keeps the heading line', function () {
  const d = doc('* A\n  body a\n** B\n** C\n');
  assert.strictEqual(O.visibleLines(d).length, 4);
  d.folded[0] = true;
  assert.deepStrictEqual(O.visibleLines(d), [0]);
  d.folded[0] = false;
  assert.strictEqual(O.visibleLines(d).length, 4);
});
t('fold keys survive insert/delete', function () {
  const d = doc('* A\n* B\n  x\n* C\n');
  d.folded[1] = true;                       // fold B (heading at line 1)
  assert.deepStrictEqual(O.visibleLines(d), [0, 1, 3]);
  O.insertLine(d, 0, 'intro');              // everything shifts down (intro is a visible body line)
  assert.deepStrictEqual(O.visibleLines(d), [0, 1, 2, 4]);
  O.deleteLine(d, 0);
  assert.deepStrictEqual(O.visibleLines(d), [0, 1, 3]);
});
t('deleteBlock drops fold keys inside the removed range', function () {
  const d = doc('* A\n** A1\n* B\n');
  d.folded[1] = true;                       // fold A1
  O.deleteBlock(d, 1, 2);                   // remove A1 section
  assert.deepStrictEqual(Object.keys(d.folded), []);
});

// ------------------------------------------------------------------ ops write text
t('cycleState rewrites the heading line and stamps/removes CLOSED', function () {
  const d = doc('* x\n');
  assert.strictEqual(O.cycleState(d, 0), 'TODO');
  assert.strictEqual(d.lines[0], '* TODO x');
  O.cycleState(d, 0); O.cycleState(d, 0);
  assert.strictEqual(O.cycleState(d, 0), 'DONE');
  assert.ok(/^  CLOSED: \[\d{4}-\d{2}-\d{2} \w{3}( \d{2}:\d{2})?\]$/.test(d.lines[1]), text(d));
  O.cycleState(d, 0);                        // DONE -> nil
  assert.strictEqual(d.lines.length, 1);
  assert.strictEqual(d.lines[0], '* x');
});
t('setDate inserts planning line, preserves time+repeater on change', function () {
  const d = doc('* t\n  DEADLINE: <2026-10-05 Mon 09:00 +1w>\nbody\n');
  O.setDate(d, 0, 'deadline', '2026-10-20');
  assert.strictEqual(d.lines[1], '  DEADLINE: <2026-10-20 Tue 09:00 +1w>');
  O.setDate(d, 0, 'deadline', null);
  assert.strictEqual(d.lines.length, 2);
  O.setDate(d, 0, 'scheduled', '2026-10-21');
  assert.strictEqual(d.lines[1], '  SCHEDULED: <2026-10-21 Wed>');
});
t('nudgeDate edits only the timestamp span', function () {
  const d = doc('* t\n  DEADLINE: <2026-10-05 Mon 09:00-09:30> extra\n');
  O.nudgeDate(d, 0, 'deadline', 3);
  assert.strictEqual(d.lines[1], '  DEADLINE: <2026-10-08 Thu 09:00-09:30> extra');
});
t('setTags/setPriority rewrite heading only', function () {
  const d = doc('*** TODO [#B] Task name\n');
  O.setTags(d, 0, ['work', 'deep:focus', 'work']);
  assert.strictEqual(d.lines[0], '*** TODO [#B] Task name  :work:deepfocus:');
  O.setPriority(d, 0, 'A');
  assert.strictEqual(d.lines[0], '*** TODO [#A] Task name  :work:deepfocus:');
  O.setPriority(d, 0, 'A');   // toggle off
  assert.ok(d.lines[0].indexOf('[#') === -1);
});

// ------------------------------------------------------------------ structure
t('insertHeadingBelow: sibling after whole section (M-RET)', function () {
  const d = doc('* A\n** A1\nbody\n* Z\n');
  const at = O.insertHeadingBelow(d, 0, false);
  assert.strictEqual(at, 3);
  assert.strictEqual(text(d), '* A\n** A1\nbody\n* \n* Z\n');
  const c = O.insertHeadingBelow(d, 0, true);   // child at section end
  assert.strictEqual(c, 3);
  assert.strictEqual(d.lines[3], '** ');
  assert.strictEqual(text(d), '* A\n** A1\nbody\n** \n* \n* Z\n');
});
t('moveSection swaps sibling sections whole', function () {
  const d = doc('* A\n  a-body\n* B\n** B1\n* C\n');
  O.moveSection(d, 0, 1);
  assert.strictEqual(text(d), '* B\n** B1\n* A\n  a-body\n* C\n');
  O.moveSection(d, 3, -1);
  assert.strictEqual(text(d), '* B\n** B1\n* A\n  a-body\n* C\n');
});
t('moveSection blocks at boundary', function () {
  const d = doc('* A\n** A1\n* B\n');
  assert.strictEqual(O.moveSection(d, 2, 1), false);   // last top-level
  assert.strictEqual(O.moveSection(d, 1, -1), false);  // A1 above is parent
});
t('changeLevel rewrites every star in the subtree', function () {
  const d = doc('* A\n* B\n** B1\n');
  O.changeLevel(d, 1, 1);                              // demote B subtree
  assert.strictEqual(text(d), '* A\n** B\n*** B1\n');
  O.changeLevel(d, 1, -1);
  assert.strictEqual(text(d), '* A\n* B\n** B1\n');
  const d2 = doc('* Top\n');
  assert.strictEqual(O.changeLevel(d2, 0, 1), false);   // nothing to hang under
});

// ------------------------------------------------------------------ agenda
t('agenda: overdue first, horizon, done excluded', function () {
  const today = O.todayStr();
  const d = doc([
    '* TODO Due soon',
    '  DEADLINE: <' + O.addDays(today, 2) + '>',
    '* TODO Way out',
    '  DEADLINE: <' + O.addDays(today, 40) + '>',
    '* TODO Overdue',
    '  DEADLINE: <' + O.addDays(today, -2) + '>',
    '* DONE Overdue done',
    '  DEADLINE: <' + O.addDays(today, -2) + '>',
  ].join('\n'));
  const items = O.agenda(d, 14);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].headline, 'Overdue');
  assert.strictEqual(items[0].overdue, true);
  assert.strictEqual(items[1].headline, 'Due soon');
});
t('agenda: plain timestamp event shows exactly on its day', function () {
  const today = O.todayStr();
  const d = doc('* Meet\n  <' + today + ' ' + O.dayName(today) + ' 19:15>\n' +
                '* Far\n  <' + O.addDays(today, 30) + '>\n').lines.join('\n');
  const items = O.agenda(O.makeDoc(d), 14);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'event');
});
t('agenda: inactive timestamps never appear', function () {
  const today = O.todayStr();
  const d = doc('* note\n  [' + today + ' ' + O.dayName(today) + ']\n');
  assert.strictEqual(O.agenda(d, 14).length, 0);
});
t('agenda: repeating event resolves to nearest occurrence', function () {
  const d = doc('* Pick up Sam\n  <2007-05-16 Wed 12:30 +1w>\n');
  const items = O.agenda(d, 7);   // today is any date; repeater advances past it
  assert.strictEqual(items.length, 1);
  assert.ok(items[0].date >= O.todayStr());
});

// ------------------------------------------------------------------ views/stats
t('tagViewLines keeps ancestors + full match sections', function () {
  const d = doc(
    '* Project A          :work:\n' +
    '** Alpha             :urgent:\n' +
    '   body of alpha\n' +
    '*** AlphaChild       :urgent:\n' +
    '** Beta\n' +
    '* Project B          :home:\n' +
    '** Gamma             :urgent:\n');
  const isUrgent = function (h) { return h.tags.indexOf('urgent') >= 0; };
  const keep = O.tagViewLines(d, isUrgent);
  const s = O.scan(d);
  const shown = keep.map(function (i) { return d.lines[i]; });
  assert.ok(shown.some(function (l) { return /Project A/.test(l); }), 'ancestor kept');
  assert.ok(shown.some(function (l) { return /body of alpha/.test(l); }), 'match section body kept');
  assert.ok(!shown.some(function (l) { return /Beta/.test(l); }), 'non-matching sibling dropped');
  assert.ok(shown.some(function (l) { return /Gamma/.test(l); }));
});
t('countStats scans the text', function () {
  const d = doc('* TODO a\n* DONE b\n** c\n');
  assert.deepStrictEqual(O.countStats(d), { total: 3, done: 1 });
});

// ------------------------------------------------------------------ round-trip
t('everything survives: type text -> scan -> edit -> text', function () {
  const src = '# notes buffer\n* TODO [#A] Ship it    :release:\n' +
              '  SCHEDULED: <2026-10-06 Tue>\n  - step one\n';
  const d = doc(src);
  const before = text(d);
  // structural edit through the API...
  O.cycleState(d, 1);
  // ...and a raw keystroke edit
  d.lines[3] = '  - step one (done)';
  assert.notStrictEqual(text(d), before);
  // reparse fresh from exported text gives same structure
  const d2 = doc(text(d));
  assert.strictEqual(O.scan(d2).headings[1].state, 'STARTED');
  assert.strictEqual(O.scan(d2).headings[1].scheduled.ts.date, '2026-10-06');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
