// Tests for the template-based release-notes generator (pure logic, NO LLM).
// Written FIRST, before src/release-notes.js existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateReleaseNotes, groupIssuesByType } from '../src/release-notes.js';

const issues = [
  { key: 'SHIP-1', type: 'Story', status: 'Done', summary: 'Add dark mode toggle' },
  { key: 'SHIP-2', type: 'Bug', status: 'Done', summary: 'Fix login crash on iOS' },
  { key: 'SHIP-3', type: 'Task', status: 'Done', summary: 'Update dependencies' },
  { key: 'SHIP-4', type: 'Story', status: 'In Progress', summary: 'Not done yet' },
];

test('groups Done issues by type; excludes non-Done issues', () => {
  const groups = groupIssuesByType(issues);
  assert.equal(groups.features.length, 1);
  assert.equal(groups.features[0].key, 'SHIP-1');
  assert.equal(groups.fixes.length, 1);
  assert.equal(groups.fixes[0].key, 'SHIP-2');
  assert.equal(groups.other.length, 1);
  assert.ok(!JSON.stringify(groups).includes('SHIP-4'));
});

test('markdown output contains version, sections and every Done issue', () => {
  const md = generateReleaseNotes({ version: '1.4.0', issues, format: 'markdown' });
  assert.ok(md.includes('1.4.0'));
  assert.ok(md.includes('SHIP-1'));
  assert.ok(md.includes('Add dark mode toggle'));
  assert.ok(md.includes('SHIP-2'));
  assert.ok(md.includes('Fix login crash'));
  assert.ok(!md.includes('SHIP-4'));
  assert.ok(md.includes('Features') && md.includes('Bug Fixes'));
});

test('markdown omits empty sections (no Tasks done => no Other section)', () => {
  const onlyBugs = [
    { key: 'B-1', type: 'Bug', status: 'Done', summary: 'Crash fix' },
  ];
  const md = generateReleaseNotes({ version: '0.1.0', issues: onlyBugs, format: 'markdown' });
  assert.ok(md.includes('Bug Fixes'));
  assert.ok(!md.includes('Features'));
});

test('empty Done list produces a valid note stating nothing shipped', () => {
  const md = generateReleaseNotes({ version: '0.0.1', issues: [], format: 'markdown' });
  assert.ok(md.includes('0.0.1'));
  assert.ok(/no .*shipped|nothing/i.test(md));
});

test('ADF output is valid JSON with a version heading and bullet lists', () => {
  const adf = generateReleaseNotes({ version: '1.4.0', issues, format: 'adf' });
  const doc = JSON.parse(adf);
  assert.equal(doc.type, 'doc');
  assert.equal(doc.version, 1);
  assert.ok(Array.isArray(doc.content) && doc.content.length > 0);
  assert.ok(adf.includes('1.4.0'));
  assert.ok(adf.includes('SHIP-2'));
});

test('unsupported format throws a clear error', () => {
  assert.throws(
    () => generateReleaseNotes({ version: '1.0.0', issues, format: 'pdf' }),
    /unsupported format/i,
  );
});

test('missing version throws', () => {
  assert.throws(() => generateReleaseNotes({ issues, format: 'markdown' }), /version/i);
});

test('output is deterministic', () => {
  const a = generateReleaseNotes({ version: '1.4.0', issues, format: 'markdown' });
  const b = generateReleaseNotes({ version: '1.4.0', issues, format: 'markdown' });
  assert.equal(a, b);
});
