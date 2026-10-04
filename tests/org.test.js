/* Core parser/model tests. Run: node tests/org.test.js */
'use strict';
const assert = require('assert');
const O = require('../js/org.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

t('parses headings with levels', function () {
  const d = O.parse('* One\n** Two\n*** Three\n');
  assert.strictEqual(d.root.children.length, 1);
  assert.strictEqual(d.root.children[0].children[0].children[0].headline, 'Three');
});

t('parses TODO keyword and tags', function () {
  const d = O.parse('** TODO Buy milk       :shopping:errand:\n');
  const n = d.root.children[0];
  assert.strictEqual(n.state, 'TODO');
  assert.strictEqual(n.headline, 'Buy milk');
  assert.deepStrictEqual(n.tags, ['shopping', 'errand']);
});

t('parses priority', function () {
  const d = O.parse('*** TODO [#A] Fix thing :work:\n');
  const n = d.root.children[0];
  assert.strictEqual(n.state, 'TODO');
  assert.strictEqual(n.priority, 'A');
  assert.strictEqual(n.headline, 'Fix thing');
  assert.deepStrictEqual(n.tags, ['work']);
});

t('priority survives without keyword', function () {
  const d = O.parse('** [#C] Plain headline\n');
  const n = d.root.children[0];
  assert.strictEqual(n.priority, 'C');
  assert.strictEqual(n.headline, 'Plain headline');
});

t('parses deadline/scheduled/closed', function () {
  const d = O.parse([
    '* TODO Task',
    '  DEADLINE: <2026-10-05> +1w',
    '  SCHEDULED: <2026-10-01>',
    '  CLOSED: <2026-09-30>',
    'body line',
  ].join('\n'));
  const n = d.root.children[0];
  assert.strictEqual(n.deadline, '2026-10-05');
  assert.strictEqual(n.scheduled, '2026-10-01');
  assert.strictEqual(n.closed, '2026-09-30');
  assert.deepStrictEqual(n.content, ['body line']);
});

t('unknown ALLCAPS is not eaten as TODO state', function () {
  const d = O.parse('* NOODLE weird state line\n');
  const n = d.root.children[0];
  assert.strictEqual(n.state, null);
  assert.strictEqual(n.headline, 'NOODLE weird state line');
});

t('TITLE line extracted', function () {
  const d = O.parse('#+TITLE: MY DOC\n* x\n');
  assert.strictEqual(d.docTitle, 'MY DOC');
});

t('serialize round-trip', function () {
  const src = [
    '#+TITLE: RT',
    '* TODO Parent       :tag1:',
    '  DEADLINE: <2026-11-01>',
    '  some body',
    '** DONE [#B] Child  :a:b:',
    '   CLOSED: <2026-10-02>',
    '   more',
  ].join('\n');
  const d = O.parse(src);
  const out = O.serialize(d.root, d.docTitle);
  const d2 = O.parse(out);
  const p = d2.root.children[0];
  assert.strictEqual(p.headline, 'Parent');
  assert.strictEqual(p.deadline, '2026-11-01');
  assert.deepStrictEqual(p.tags, ['tag1']);
  const c = p.children[0];
  assert.strictEqual(c.state, 'DONE');
  assert.strictEqual(c.priority, 'B');
  assert.strictEqual(c.closed, '2026-10-02');
  assert.deepStrictEqual(c.tags, ['a', 'b']);
  assert.ok(out.includes('some body'), 'body preserved');
});

t('flatten respects collapsed state', function () {
  const d = O.parse('* A\n  body a\n** B\n** C\n');
  const all = O.flatten(d.root);
  assert.strictEqual(all.length, 4); // A headline, body, B, C
  d.root.children[0].collapsed = true;
  const folded = O.flatten(d.root);
  assert.strictEqual(folded.length, 1);
});

t('cycleState walks TODO→STARTED→WAITING→DONE→nil', function () {
  const d = O.parse('* x\n');
  const n = d.root.children[0];
  assert.strictEqual(O.cycleState(n), 'TODO');
  assert.strictEqual(O.cycleState(n), 'STARTED');
  assert.strictEqual(O.cycleState(n), 'WAITING');
  assert.strictEqual(O.cycleState(n), 'DONE');
  assert.ok(n.closed, 'closed stamped on DONE');
  assert.strictEqual(O.cycleState(n), null);
  assert.strictEqual(n.closed, null);
});

t('addTag/removeTag sanitize colons', function () {
  const n = O.makeNode({ headline: 'x' });
  O.addTag(n, 'pro:j:ect');
  assert.deepStrictEqual(n.tags, ['project']);
  O.addTag(n, 'project');
  assert.strictEqual(n.tags.length, 1, 'no dupes');
  O.removeTag(n, 'project');
  assert.strictEqual(n.tags.length, 0);
});

t('deadline nudge with addDays across month', function () {
  assert.strictEqual(O.addDays('2026-10-31', 1), '2026-11-01');
  assert.strictEqual(O.addDays('2026-01-01', -1), '2025-12-31');
});

t('agenda lists upcoming + overdue, done excluded', function () {
  const today = O.todayStr();
  const soon = O.addDays(today, 2);
  const late = O.addDays(today, 20);   // beyond 14d window
  const past = O.addDays(today, -2);
  const d = O.parse([
    '* TODO Due soon',
    '  DEADLINE: <' + soon + '>',
    '* TODO Way out',
    '  DEADLINE: <' + late + '>',
    '* TODO Overdue',
    '  DEADLINE: <' + past + '>',
    '* DONE Overdue done',
    '  DEADLINE: <' + past + '>',
  ].join('\n'));
  const items = O.agenda(d.root, 14);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].node.headline, 'Overdue'); // overdue first
  assert.strictEqual(items[0].overdue, true);
  assert.strictEqual(items[1].node.headline, 'Due soon');
});

t('indent/outdent re-levels subtree', function () {
  const d = O.parse('* A\n* B\n** B1\n');
  O.linkParents(d.root);
  const A = d.root.children[0], B = d.root.children[1];
  // move B under A: emulate via app's indentNode logic on model level
  // (direct model op): remove B from root, push into A
  d.root.children.splice(1, 1);
  A.children.push(B);
  B.level = 2; B.children[0].level = 3;
  const out = O.serialize(d.root);
  assert.ok(/\* A\n\*\* B\n\*\*\* B1/.test(out), out);
});

t('insertSiblingAfter keeps tree consistent', function () {
  const d = O.parse('* A\n* C\n');
  O.linkParents(d.root);
  const sib = O.insertSiblingAfter(d.root.children[0]);
  sib.headline = 'B';
  const out = O.serialize(d.root);
  assert.ok(out.includes('* A\n* B\n* C'), out);
});

t('blank body lines preserved within node content', function () {
  const d = O.parse('* A\nfirst\n\nsecond\n* B\n');
  const a = d.root.children[0];
  assert.deepStrictEqual(a.content, ['first', '', 'second']);
});

t('moveNodeAmongSiblings swaps neighbours (M-down/M-up)', function () {
  const d = O.parse('* A\n* B\n* C\n');
  const A = d.root.children[0], B = d.root.children[1];
  assert.strictEqual(O.moveNodeAmongSiblings(d.root, A, 1), true);   // A down
  const out = O.serialize(d.root);
  assert.ok(/^\* B\n\* A\n\* C/m.test(out), out);
  assert.strictEqual(O.moveNodeAmongSiblings(d.root, A, -1), true);   // back up
  assert.strictEqual(O.moveNodeAmongSiblings(d.root, d.root.children[0], -1), false); // at top
});

t('moveNodeAmongSiblings carries subtree as a unit', function () {
  const d = O.parse('* A\n** A1\n* B\n');
  const A = d.root.children[0];
  assert.strictEqual(O.moveNodeAmongSiblings(d.root, A, 1), true);
  const out = O.serialize(d.root);
  assert.ok(/^\* B\n\* A\n\*\* A1/m.test(out), out);
});

t('demoteNode hangs under previous sibling (M-right)', function () {
  const d = O.parse('* A\n* B\n** B1\n');
  const B = d.root.children[1];
  assert.strictEqual(O.demoteNode(d.root, B), true);
  const A = d.root.children[0];
  assert.strictEqual(d.root.children.length, 1);
  assert.strictEqual(A.children.length, 1);
  assert.strictEqual(B.level, 2);
  assert.strictEqual(B.children[0].level, 3);
  // first child cannot be demoted
  assert.strictEqual(O.demoteNode(d.root, A), false);
});

t('promoteNode moves up next to parent (M-left)', function () {
  const d = O.parse('* A\n** B\n*** B1\n');
  const B = d.root.children[0].children[0];
  assert.strictEqual(O.promoteNode(d.root, B), true);
  assert.strictEqual(d.root.children.length, 2);
  assert.strictEqual(B.level, 1);
  assert.strictEqual(B.children[0].level, 2);
  // top-level node cannot be promoted further
  assert.strictEqual(O.promoteNode(d.root, d.root.children[0]), false);
});

t('parseDateInput accepts ISO, dotted, today, relative', function () {
  const d = O.parseDateInput('2026-10-05');
  assert.deepStrictEqual(d, { date: '2026-10-05' });
  const curYear = O.todayStr().slice(0, 4);
  assert.deepStrictEqual(O.parseDateInput('5.10'), { date: curYear + '-10-05' });
  assert.deepStrictEqual(O.parseDateInput('05.10.2027'), { date: '2027-10-05' });
  assert.deepStrictEqual(O.parseDateInput('today'), { date: O.todayStr() });
  assert.deepStrictEqual(O.parseDateInput('+3d'), { date: O.addDays(O.todayStr(), 3) });
  assert.deepStrictEqual(O.parseDateInput('-1'), { date: O.addDays(O.todayStr(), -1) });
  assert.deepStrictEqual(O.parseDateInput('+2w'), { date: O.addDays(O.todayStr(), 14) });
  assert.deepStrictEqual(O.parseDateInput('clear'), { clear: true });
  assert.strictEqual(O.parseDateInput('garbage'), null);
  assert.strictEqual(O.parseDateInput('2026-02-30'), null, 'invalid calendar date rejected');
});

t('sparseRows keeps ancestor chain + match subtree, drops the rest', function () {
  const d = O.parse(
    '* Project A          :work:\n' +
    '** Alpha             :urgent:\n' +
    '   body of alpha\n' +
    '*** AlphaChild       :urgent:\n' +
    '** Beta\n' +
    '* Project B          :home:\n' +
    '** Gamma             :urgent:\n'
  );
  const isUrgent = function (n) { return n.tags.indexOf('urgent') >= 0; };
  const rs = O.sparseRows(d.root, isUrgent);
  const heads = rs.filter(function (r) { return r.kind === 'headline'; }).map(function (r) { return r.node.headline; });
  // Alpha matches; its ancestor Project A is kept for structure; Alpha's subtree
  // (body + AlphaChild) is shown. Beta (no match) is hidden. Project B kept as
  // ancestor of Gamma; Gamma matches.
  assert.deepStrictEqual(heads, ['Project A', 'Alpha', 'AlphaChild', 'Project B', 'Gamma']);
  // Alpha's body line is present (match => show subtree content)
  const bodies = rs.filter(function (r) { return r.kind === 'content'; }).map(function (r) { return r.text; });
  assert.deepStrictEqual(bodies, ['   body of alpha']);
  // Project A itself does NOT match -> its own body/content would be omitted,
  // and Beta (sibling, non-matching, no matching descendant) is gone.
  assert.ok(heads.indexOf('Beta') === -1, 'non-matching sibling excluded');
});

t('sparseRows with no matches returns empty', function () {
  const d = O.parse('* A :x:\n* B :y:\n');
  const none = function (n) { return n.tags.indexOf('zzz') >= 0; };
  assert.strictEqual(O.sparseRows(d.root, none).length, 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
