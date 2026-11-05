import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const TOOL = fileURLToPath(new URL('../codeowners-check.mjs', import.meta.url));

// Run the tool as a child process in a fresh temporary folder.
// files: { relative path: content }; the CODEOWNERS file is usually 'CODEOWNERS'.
function run(args, { files = {}, stdin, cwd = '.' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codeowners-check-test-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), content);
    }
    const r = spawnSync(process.execPath, [TOOL, ...args], {
      cwd: join(root, cwd),
      input: stdin ?? '',
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Report as JSON for a CODEOWNERS text and a list of tracked paths.
function report(codeowners, tracked, extra = []) {
  const r = run(['--json', '--fail-on', 'none', '--files', 'list.txt', ...extra], {
    files: { CODEOWNERS: codeowners, 'list.txt': tracked.join('\n') },
  });
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
}

const rulesOf = (rep) => rep.findings.map((f) => `${f.line}:${f.rule}`);
const ownersOf = (codeowners, tracked, owner) => report(codeowners, tracked, ['--owner', owner]).owned;

function who(codeowners, paths) {
  const r = run(['--who', ...paths, '--json'], { files: { CODEOWNERS: codeowners } });
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out).who;
}

function usageError(args, opts) {
  const r = run(args, opts);
  assert.equal(r.code, 2, `expected exit 2 for ${args.join(' ')}, got ${r.code}: ${r.out}`);
  assert.equal(r.out, '');
  assert.notEqual(r.err, '');
}

// ------------------------------------------------------------ output forms

test('JSON report has the stated shape', () => {
  const rep = report('* @a\n/legacy/ @b\n', ['x.txt', 'y.txt']);
  assert.deepEqual(Object.keys(rep).sort(), [
    'codeowners', 'counts', 'failOn', 'findings', 'ok', 'owned', 'rules', 'tool', 'tracked', 'unowned', 'version',
  ]);
  assert.equal(rep.tool, 'codeowners-check');
  assert.equal(rep.version, '0.1.0');
  assert.equal(rep.codeowners, 'CODEOWNERS');
  assert.equal(rep.tracked, 2);
  assert.equal(rep.rules, 2);
  assert.deepEqual(rep.counts, { error: 0, warning: 1 });
  assert.equal(rep.unowned, 0);
  assert.equal(rep.owned, null);
  assert.equal(rep.failOn, 'none');
  assert.equal(rep.ok, true);
  assert.deepEqual(rep.findings, [
    { line: 2, rule: 'dead', severity: 'warning', message: 'pattern "/legacy/" matches no tracked file', path: null, by: null },
  ]);
});

test('plain output has the stated form', () => {
  const r = run(['--files', 'list.txt', '--owner', '@A'], {
    files: { CODEOWNERS: '* @a\n/legacy/ @b\n@x @y\n', 'list.txt': 'b.txt\na.txt\n' },
  });
  assert.equal(r.code, 1);
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'codeowners-check 0.1.0: CODEOWNERS, 2 tracked files, 2 rules');
  assert.match(lines[1], /^CODEOWNERS:2: warning dead: .*\/legacy\//);
  assert.match(lines[2], /^CODEOWNERS:3: error no-pattern: /);
  assert.equal(lines[3], '2 findings: 1 errors, 1 warnings');
  assert.equal(lines[4], '0 files have no owner');
  assert.equal(lines[5], '@A owns 2 files');
  assert.equal(lines[6], '  a.txt');
  assert.equal(lines[7], '  b.txt');
  assert.equal(lines[8], '');
  assert.equal(lines.length, 9);
});

test('plain output with no findings', () => {
  const r = run(['--files', 'list.txt'], { files: { CODEOWNERS: '* @a\n', 'list.txt': 'a\n' } });
  assert.equal(r.code, 0);
  assert.equal(
    r.out,
    'codeowners-check 0.1.0: CODEOWNERS, 1 tracked files, 1 rules\n0 findings: 0 errors, 0 warnings\n0 files have no owner\n',
  );
});

test('--github lines and their escaping', () => {
  const r = run(['--github', '--require-owner', '--files', 'list.txt', '--file', 'sub,dir/CO:x'], {
    files: {
      'sub,dir/CO:x': '/src/ @a\n/gone/ @b\n',
      'list.txt': 'a%b:c,d.txt\0src/x\0',
    },
  });
  assert.equal(r.code, 1);
  const lines = r.out.split('\n');
  assert.equal(lines.pop(), '');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^::error file=a%25b%3Ac%2Cd\.txt::unowned: .*a%25b:c,d\.txt/);
  assert.match(lines[1], /^::warning file=sub%2Cdir\/CO%3Ax,line=2::dead: pattern "\/gone\/" matches no tracked file$/);
});

test('--github escapes newlines in a path message', () => {
  const r = run(['--github', '--require-owner', '--files', 'list.txt'], {
    files: { CODEOWNERS: '/none/ @a\n', 'list.txt': 'a\nb\0' },
  });
  const lines = r.out.split('\n');
  // dead + unowned for the single file "a\nb"
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^::error file=a%0Ab::unowned: .*a%0Ab/);
});

test('--github with no findings prints nothing', () => {
  const r = run(['--github', '--files', 'list.txt'], { files: { CODEOWNERS: '* @a\n', 'list.txt': 'a' } });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

// ------------------------------------------------------------ finding the files

test('CODEOWNERS is the first of .github/CODEOWNERS, CODEOWNERS, docs/CODEOWNERS', () => {
  const files = { 'list.txt': 'a', '.github/CODEOWNERS': '* @a\n', CODEOWNERS: '* @b\n', 'docs/CODEOWNERS': '* @c\n' };
  const w = (extra = {}, rm = []) => {
    const f = { ...files, ...extra };
    for (const k of rm) delete f[k];
    const r = run(['--who', 'a', '--json'], { files: f });
    return JSON.parse(r.out);
  };
  assert.equal(w().codeowners, '.github/CODEOWNERS');
  assert.deepEqual(w().who[0].owners, ['@a']);
  assert.equal(w({}, ['.github/CODEOWNERS']).codeowners, 'CODEOWNERS');
  assert.equal(w({}, ['.github/CODEOWNERS', 'CODEOWNERS']).codeowners, 'docs/CODEOWNERS');
});

test('a folder named CODEOWNERS does not count', () => {
  const r = run(['--who', 'a', '--json'], {
    files: { 'CODEOWNERS/x': 'y', 'docs/CODEOWNERS': '* @c\n' },
  });
  assert.equal(JSON.parse(r.out).codeowners, 'docs/CODEOWNERS');
});

test('no CODEOWNERS file is a usage error', () => {
  usageError(['--files', 'list.txt'], { files: { 'list.txt': 'a' } });
  usageError(['--who', 'a'], { files: { 'x': 'y' } });
});

test('--file is relative to the current directory, not dir', () => {
  const r = run(['repo', '--file', 'other/OWN', '--files', 'list.txt', '--json'], {
    files: { 'other/OWN': '* @a\n', 'list.txt': 'a', 'repo/x': '' },
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).codeowners, 'other/OWN');
});

test('a dir argument gives the same report as running inside the folder', () => {
  const files = { 'repo/.github/CODEOWNERS': '* @a\n/x/ @b\n', 'repo/list.txt': 'a\nb\n' };
  const inside = run(['--files', 'list.txt', '--json'], { files, cwd: 'repo' });
  // --files is relative to the current directory, so give it from the parent
  const outside = run(['repo', '--files', 'repo/list.txt', '--json'], { files });
  assert.equal(inside.code, 0, inside.err);
  assert.equal(inside.out, outside.out);
  const absolute = run([join(tmpdir(), 'does-not-exist-codeowners-check')], { files });
  assert.equal(absolute.code, 2);
});

test('dir must be an existing folder', () => {
  usageError(['nope', '--files', 'list.txt'], { files: { CODEOWNERS: '* @a', 'list.txt': '' } });
  usageError(['CODEOWNERS', '--files', 'list.txt'], { files: { CODEOWNERS: '* @a', 'list.txt': '' } });
});

test('a missing --files or --file file is a usage error', () => {
  usageError(['--files', 'missing.txt'], { files: { CODEOWNERS: '* @a' } });
  usageError(['--files', 'list.txt', '--file', 'missing'], { files: { 'list.txt': '' } });
});

test('without --files git is used; if it cannot answer that is a usage error with nothing on stdout', () => {
  // git may or may not be installed, and the folder is not a repository: either way no crash and nothing on stdout when it fails
  const r = run([], { files: { CODEOWNERS: '* @a\n' } });
  if (r.code === 2) assert.equal(r.out, '');
  else assert.ok(r.code === 0 || r.code === 1);
});

// ------------------------------------------------------------ the tracked list

test('tracked list: newline, CRLF, blank entries and duplicates', () => {
  const rep = report('* @a\n', []);
  assert.equal(rep.tracked, 0);
  const r = run(['--files', 'l', '--json'], { files: { CODEOWNERS: '* @a\n', l: 'a\r\n\r\nb\n\na\nc' } });
  assert.equal(JSON.parse(r.out).tracked, 3);
});

test('tracked list: NUL separated, a NUL after the last entry, newlines inside names', () => {
  const r = run(['--files', 'l', '--json', '--owner', '@a'], {
    files: { CODEOWNERS: '* @a\n', l: 'a\nb\0c\0\0c\0d\0' },
  });
  const rep = JSON.parse(r.out);
  assert.equal(rep.tracked, 3);
  assert.deepEqual(rep.owned, ['a\nb', 'c', 'd']);
});

test('tracked list: a \\r is only dropped before \\n and not in a NUL list', () => {
  const r = run(['--files', 'l', '--json', '--owner', '@a'], { files: { CODEOWNERS: '* @a\n', l: 'a\r\0b\0' } });
  assert.deepEqual(JSON.parse(r.out).owned, ['a\r', 'b']);
});

test('tracked list from standard input', () => {
  const r = run(['--files', '-', '--json'], { files: { CODEOWNERS: '* @a\n' }, stdin: 'a\nb\n' });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).tracked, 2);
  const z = run(['--files', '-', '--json'], { files: { CODEOWNERS: '* @a\n' }, stdin: 'a b\0c\0' });
  assert.equal(JSON.parse(z.out).tracked, 2);
});

// ------------------------------------------------------------ the CODEOWNERS file

test('comments, inline comments, tabs, CRLF and a byte-order mark', () => {
  const text = '﻿# comment\r\n\r\n  \t# indented comment\r\n\t/a/\t@x  # inline\r\n/b/ @y #@z\r\n/c/\t#nothing\r\n';
  const rep = report(text, ['a/1', 'b/2', 'c/3']);
  assert.equal(rep.rules, 3);
  assert.deepEqual(rep.findings, []);
  assert.deepEqual(who(text, ['a/1', 'b/2', 'c/3']), [
    { path: 'a/1', owners: ['@x'], line: 4, pattern: '/a/' },
    { path: 'b/2', owners: ['@y'], line: 5, pattern: '/b/' },
    { path: 'c/3', owners: [], line: 6, pattern: '/c/' },
  ]);
});

test('# in the middle of a token starts nothing', () => {
  const rep = report('* @a#b\n', ['x']);
  assert.deepEqual(rulesOf(rep), ['1:bad-owner']);
  assert.match(rep.findings[0].message, /@a#b/);
});

test('a file with no lines holds no rules', () => {
  const rep = report('', ['x']);
  assert.equal(rep.rules, 0);
  assert.deepEqual(rep.findings, []);
  assert.equal(rep.unowned, 1);
});

test('line numbers count from 1 and follow \\n', () => {
  const rep = report('\n\n/none/ @a\n', ['x']);
  assert.deepEqual(rulesOf(rep), ['3:dead']);
});

// ------------------------------------------------------------ syntax errors

test('no-pattern: a line that starts with an owner', () => {
  const rep = report('@alice @bob\nalice@example.com @x\n@acme/core\n', ['x']);
  assert.deepEqual(rulesOf(rep), ['1:no-pattern', '2:no-pattern', '3:no-pattern']);
  assert.equal(rep.rules, 0);
  for (const f of rep.findings) {
    assert.equal(f.severity, 'error');
    assert.equal(f.path, null);
    assert.equal(f.by, null);
    assert.match(f.message, /owner/);
    assert.match(f.message, /pattern/);
  }
});

test('bad-pattern: !, \\#, [ ], lone backslash, names nothing', () => {
  const pats = ['!x', '\\#x', 'a[bc]', '/a/[x]', 'a\\/b', 'x\\/', '/', '//'];
  const rep = report(pats.map((p) => `${p} @a`).join('\n'), ['x']);
  assert.deepEqual(rulesOf(rep), pats.map((_, i) => `${i + 1}:bad-pattern`));
  pats.forEach((p, i) => {
    assert.ok(rep.findings[i].message.includes(p), `message of ${p}: ${rep.findings[i].message}`);
    assert.equal(rep.findings[i].severity, 'error');
  });
  assert.equal(rep.rules, 0);
  assert.equal(rep.counts.error, pats.length);
});

test('bad-pattern: sections are bad patterns', () => {
  const rep = report('[Docs]\n[Docs] @a\n', ['x']);
  assert.deepEqual(rulesOf(rep), ['1:bad-pattern', '2:bad-pattern']);
});

test('escaped special characters are fine', () => {
  const rep = report('\\[x\\] @a\n\\!x @a\n\\*x @a\n\\\\[ @a\n', ['[x]', '!x', '*x']);
  // the last line holds an unescaped [ after an escaped backslash
  assert.deepEqual(rulesOf(rep), ['4:bad-pattern']);
  assert.deepEqual(who('\\[x\\] @a\n\\!x @b\n\\*x @c\n', ['[x]', '!x', '*x', 'ax']).map((w) => w.owners), [['@a'], ['@b'], ['@c'], []]);
});

test('bad-owner: the first bad token is named, and the line is not a rule', () => {
  const rep = report('* @a @bad_name @worse!\n', ['x']);
  assert.deepEqual(rulesOf(rep), ['1:bad-owner']);
  assert.match(rep.findings[0].message, /@bad_name/);
  assert.equal(rep.rules, 0);
  assert.equal(rep.unowned, 1);
});

test('lines with a syntax error are never dead or shadowed and take no part in matching', () => {
  const rep = report('* @a\n/x/ @bad_owner\n', ['x/f']);
  assert.deepEqual(rulesOf(rep), ['2:bad-owner']);
  assert.deepEqual(rep.owned, null);
  assert.deepEqual(who('* @a\n/x/ @bad_owner\n', ['x/f'])[0].owners, ['@a']);
});

test('one syntax error per line: no-pattern before bad-pattern before bad-owner', () => {
  const rep = report('@a @b_\n!x @bad_\n', ['x']);
  assert.deepEqual(rulesOf(rep), ['1:no-pattern', '2:bad-pattern']);
});

// ------------------------------------------------------------ owner syntax

test('valid and invalid owners', () => {
  const ok = [
    '@a', '@A', '@user-name', '@a--b', '@' + 'a'.repeat(39), '@a1', '@acme/core', '@acme/Team_1.x-y', '@acme/' + 'a'.repeat(100),
    'me@example.com', 'a.b_c%d+e-f@sub.example.org', 'x@a-b.co',
  ];
  const bad = [
    '@', '@-a', '@a-', '@' + 'a'.repeat(40), '@a_b', '@a.b', '@acme/', '@acme/a b', '@acme/' + 'a'.repeat(101), '@acme/a/b',
    '@acme/a@b', '@a_b/team', 'alice', 'a@b', 'a@b.c', '@@a', 'a@@b.co', 'a b@c.co', 'é@x.co', '@é',
  ];
  const text = [...ok, ...bad].map((o) => `/f @a ${o}`);
  // each owner on its own line, after a valid owner so that the pattern is not an owner
  const rep = report(text.join('\n'), ['f']);
  const errors = new Set(rep.findings.filter((f) => f.rule === 'bad-owner').map((f) => f.line));
  ok.forEach((o, i) => assert.ok(!errors.has(i + 1), `${o} should be valid`));
  bad.forEach((o, i) => assert.ok(errors.has(ok.length + i + 1), `${o} should be invalid`));
});

test('owners compare without regard to case, and print as written', () => {
  const text = '* @Acme/Core\n';
  assert.deepEqual(ownersOf(text, ['a', 'b'], '@acme/core'), ['a', 'b']);
  assert.deepEqual(ownersOf(text, ['a'], '@ACME/CORE'), ['a']);
  assert.deepEqual(who(text, ['a'])[0].owners, ['@Acme/Core']);
});

test('--owner with an email address', () => {
  assert.deepEqual(ownersOf('* Me@Example.com\n', ['a'], 'me@example.COM'), ['a']);
});

// ------------------------------------------------------------ matching

test('unanchored patterns match names at any depth', () => {
  const t = 'a.js\nsrc/b.js\nsrc/deep/c.js\nd.txt\nx.js/e.txt\n';
  assert.deepEqual(ownersOf('*.js @a\n', t.trim().split('\n'), '@a'), ['a.js', 'src/b.js', 'src/deep/c.js']);
  assert.deepEqual(ownersOf('d.txt @a\n', t.trim().split('\n'), '@a'), ['d.txt']);
});

test('anchored patterns match whole paths from the top', () => {
  const tracked = ['a/b.js', 'x/a/b.js', 'a/c/b.js'];
  assert.deepEqual(ownersOf('/a/b.js @o\n', tracked, '@o'), ['a/b.js']);
  assert.deepEqual(ownersOf('a/b.js @o\n', tracked, '@o'), ['a/b.js']);
  assert.deepEqual(ownersOf('a/*.js @o\n', tracked, '@o'), ['a/b.js']);
});

test('a name without a slash owns everything inside folders of that name', () => {
  const tracked = ['docs/a', 'x/docs/b', 'docsx/c', 'x/docs'];
  assert.deepEqual(ownersOf('docs @o\n', tracked, '@o'), ['docs/a', 'x/docs', 'x/docs/b']);
  assert.deepEqual(ownersOf('/docs @o\n', tracked, '@o'), ['docs/a']);
});

test('trailing slash: folders only', () => {
  const tracked = ['docs/a', 'docs', 'x/docs/b'];
  assert.deepEqual(ownersOf('docs/ @o\n', tracked, '@o'), ['docs/a', 'x/docs/b']);
  assert.deepEqual(ownersOf('/docs/ @o\n', tracked, '@o'), ['docs/a']);
});

test('docs/* does not reach nested files, a named folder owns all inside', () => {
  const tracked = ['docs/a.md', 'docs/build/b.md', 'docs/build/deep/c.md'];
  assert.deepEqual(ownersOf('docs/* @o\n', tracked, '@o'), ['docs/a.md']);
  assert.deepEqual(ownersOf('/docs/ @o\n', tracked, '@o'), tracked);
  assert.deepEqual(ownersOf('/docs/build @o\n', tracked, '@o'), ['docs/build/b.md', 'docs/build/deep/c.md']);
  assert.deepEqual(ownersOf('/docs/**/*.md @o\n', tracked, '@o'), tracked);
  assert.deepEqual(ownersOf('/docs/** @o\n', tracked, '@o'), tracked);
});

test('wildcards: * ? and no wildcard matches a slash', () => {
  const tracked = ['ab.c', 'a.c', 'abbc', 'a/b.c', 'xy', 'x'];
  assert.deepEqual(ownersOf('a*c @o\n', tracked, '@o'), ['a.c', 'ab.c', 'abbc']);
  assert.deepEqual(ownersOf('/a*c @o\n', tracked, '@o'), ['a.c', 'ab.c', 'abbc']);
  assert.deepEqual(ownersOf('x? @o\n', tracked, '@o'), ['xy']);
  assert.deepEqual(ownersOf('/a?c @o\n', tracked, '@o'), ['a.c']);
  assert.deepEqual(ownersOf('/a?b.c @o\n', tracked, '@o'), []);
  assert.deepEqual(ownersOf('/a?*.c @o\n', tracked, '@o'), ['ab.c']);
});

test('? matches one code point and matching is case-sensitive', () => {
  assert.deepEqual(ownersOf('/a?b @o\n', ['a\u{1F600}b', 'ab', 'aXb'], '@o'), ['aXb', 'a\u{1F600}b']);
  assert.deepEqual(ownersOf('/readme @o\n', ['README', 'readme'], '@o'), ['readme']);
});

test('** as a segment: globstar', () => {
  const tracked = ['foo', 'a/foo', 'a/b/foo', 'foox'];
  assert.deepEqual(ownersOf('**/foo @o\n', tracked, '@o'), ['a/b/foo', 'a/foo', 'foo']);
  const t2 = ['a/b', 'a/x/b', 'a/x/y/b', 'a/x/y/c'];
  assert.deepEqual(ownersOf('a/**/b @o\n', t2, '@o'), ['a/b', 'a/x/b', 'a/x/y/b']);
  const t3 = ['abc', 'abc/d', 'abc/d/e'];
  assert.deepEqual(ownersOf('abc/** @o\n', t3, '@o'), ['abc/d', 'abc/d/e']);
  assert.deepEqual(ownersOf('/abc/** @o\n', t3, '@o'), ['abc/d', 'abc/d/e']);
});

test('** that is not a whole anchored segment is just *', () => {
  assert.deepEqual(ownersOf('/a**b @o\n', ['axxb', 'a/b'], '@o'), ['axxb']);
  assert.deepEqual(ownersOf('** @o\n', ['a', 'b/c'], '@o'), ['a', 'b/c']);
  assert.deepEqual(ownersOf('a**/b @o\n', ['axx/b', 'a/x/b'], '@o'), ['axx/b']);
});

test('escapes in patterns: escaped space, star and backslash', () => {
  const text = 'my\\ file.txt @a\n/star\\*.txt @b\n/back\\\\slash @c\n';
  const w = who(text, ['my file.txt', 'star*.txt', 'starx.txt', 'back\\slash']);
  assert.deepEqual(w.map((x) => x.owners), [['@a'], ['@b'], [], ['@c']]);
  assert.equal(w[0].pattern, 'my\\ file.txt');
});

test('an escaped star is a plain name, so the folder is claimed', () => {
  assert.deepEqual(ownersOf('/s\\*r @o\n', ['s*r/a', 'sxr/a'], '@o'), ['s*r/a']);
});

test('the last matching line wins', () => {
  const text = '* @a\n/src/ @b\n*.md @c\n/src/x.md @d\n';
  const w = who(text, ['r.md', 'src/y.js', 'src/y.md', 'src/x.md', 'z']);
  assert.deepEqual(w.map((x) => [x.owners.join(','), x.line]), [['@c', 3], ['@b', 2], ['@c', 3], ['@d', 4], ['@a', 1]]);
});

test('a line with no owners resets ownership and is the deciding line', () => {
  const text = '* @a\n/vendor/\n';
  const rep = report(text, ['vendor/x', 'src/y'], ['--require-owner']);
  assert.equal(rep.unowned, 1);
  assert.deepEqual(rep.findings.map((f) => [f.line, f.rule, f.path]), [[2, 'unowned', 'vendor/x']]);
  assert.deepEqual(rep.findings[0].by, null);
  assert.equal(rep.findings[0].severity, 'error');
  assert.ok(rep.findings[0].message.includes('vendor/x'));
  assert.deepEqual(who(text, ['vendor/x']), [{ path: 'vendor/x', owners: [], line: 2, pattern: '/vendor/' }]);
  assert.deepEqual(ownersOf(text, ['vendor/x', 'src/y'], '@a'), ['src/y']);
});

test('a reset line followed by a later rule gives ownership back', () => {
  assert.deepEqual(ownersOf('* @a\n/v/\n/v/k @a\n', ['v/x', 'v/k'], '@a'), ['v/k']);
});

// ------------------------------------------------------------ dead and shadowed

test('dead: a rule that matches no tracked file, whatever the other lines say', () => {
  const rep = report('* @a\n/none/ @b\n*.zzz @c\n', ['x.txt']);
  assert.deepEqual(rulesOf(rep), ['2:dead', '3:dead']);
  for (const f of rep.findings) {
    assert.equal(f.severity, 'warning');
    assert.equal(f.path, null);
    assert.equal(f.by, null);
  }
  assert.ok(rep.findings[0].message.includes('/none/'));
  assert.ok(rep.findings[1].message.includes('*.zzz'));
});

test('an empty tracked list makes every rule dead', () => {
  const rep = report('* @a\n/x/ @b\n', []);
  assert.deepEqual(rulesOf(rep), ['1:dead', '2:dead']);
  assert.equal(rep.unowned, 0);
});

test('shadowed: every matched file is taken by a later line, by is the lowest such line', () => {
  const text = '*.js @a\n/src/ @b\n/src/x.js @c\n';
  const rep = report(text, ['src/x.js', 'src/y.js', 'lib/z.js']);
  // line 1 still decides lib/z.js, so it is not shadowed; line 2 decides src/y.js
  assert.deepEqual(rep.findings, []);
  const rep2 = report('*.js @a\n/src/ @b\n/src/x.js @c\n', ['src/x.js', 'src/y.js']);
  assert.deepEqual(rep2.findings.map((f) => [f.line, f.rule, f.by]), [[1, 'shadowed', 2]]);
  assert.ok(rep2.findings[0].message.includes('*.js'));
  assert.ok(rep2.findings[0].message.includes('2'));
  assert.equal(rep2.findings[0].path, null);
  assert.equal(rep2.findings[0].severity, 'warning');
});

test('shadowed by the lowest of the deciding lines, a rule with no owners shadows too', () => {
  const rep = report('* @a\n/a/\n/b/ \n/c/\n', ['a/1', 'b/1', 'c/1']);
  assert.deepEqual(rep.findings.map((f) => [f.line, f.rule, f.by]), [[1, 'shadowed', 2]]);
  const rep2 = report('/a/ @a\n/a/ @b\n', ['a/1']);
  assert.deepEqual(rep2.findings.map((f) => [f.line, f.rule, f.by]), [[1, 'shadowed', 2]]);
});

test('a rule is never both dead and shadowed', () => {
  const rep = report('/a/ @a\n/a/ @b\n/zzz/ @c\n', ['a/1']);
  assert.deepEqual(rulesOf(rep), ['1:shadowed', '3:dead']);
});

// ------------------------------------------------------------ unowned

test('unowned files are counted without --require-owner, and are findings with it', () => {
  const text = '/src/ @a\n';
  const plain = report(text, ['src/x', 'README', 'docs/a']);
  assert.equal(plain.unowned, 2);
  assert.deepEqual(plain.findings, []);
  const strict = report(text, ['src/x', 'README', 'docs/a'], ['--require-owner']);
  assert.equal(strict.unowned, 2);
  assert.deepEqual(strict.findings.map((f) => [f.line, f.rule, f.severity, f.path, f.by]), [
    [0, 'unowned', 'error', 'README', null],
    [0, 'unowned', 'error', 'docs/a', null],
  ]);
  assert.deepEqual(strict.counts, { error: 2, warning: 0 });
});

test('--require-owner makes the exit code 1', () => {
  const r = run(['--files', 'l', '--require-owner'], { files: { CODEOWNERS: '/src/ @a\n', l: 'README\n' } });
  assert.equal(r.code, 1);
  assert.match(r.out, /CODEOWNERS:0: error unowned: .*README/);
  const r2 = run(['--files', 'l'], { files: { CODEOWNERS: '/src/ @a\n', l: 'README\n' } });
  assert.equal(r2.code, 0);
  assert.match(r2.out, /1 files have no owner/);
});

test('findings are sorted by line, rule and path', () => {
  const text = '/zz/ @a\n* \n@x\n/qq/ @b\n';
  const rep = report(text, ['z', 'a', 'b'], ['--require-owner']);
  assert.deepEqual(rep.findings.map((f) => [f.line, f.rule, f.path]), [
    [1, 'dead', null],
    [2, 'unowned', 'a'],
    [2, 'unowned', 'b'],
    [2, 'unowned', 'z'],
    [3, 'no-pattern', null],
    [4, 'dead', null],
  ]);
});

test('rules at the same line sort by rule code unit order, then path code unit order', () => {
  const rep = report('* \n', ['b', 'B', 'a'], ['--require-owner']);
  assert.deepEqual(rep.findings.map((f) => f.path), ['B', 'a', 'b']);
});

// ------------------------------------------------------------ --owner and --who

test('--owner lists sorted files; a reset rule or no rule is owned by nobody', () => {
  const text = '* @a @b\n/x/ @b\n/y/\n';
  assert.deepEqual(ownersOf(text, ['z', 'x/2', 'x/1', 'y/1', 'w'], '@b'), ['w', 'x/1', 'x/2', 'z']);
  assert.deepEqual(ownersOf(text, ['z', 'x/2', 'y/1'], '@a'), ['z']);
  assert.deepEqual(ownersOf(text, ['z'], '@nobody'), []);
});

test('--owner never changes the exit status and prints in plain form', () => {
  const r = run(['--files', 'l', '--owner', '@nobody'], { files: { CODEOWNERS: '* @a\n', l: 'a\n' } });
  assert.equal(r.code, 0);
  assert.ok(r.out.endsWith('0 files have no owner\n@nobody owns 0 files\n'));
});

test('--who plain form', () => {
  const r = run(['--who', 'src/a.js', 'vendor/x', 'src/a.js', 'zz', '--file', 'CODEOWNERS'], {
    files: { CODEOWNERS: '/src/ @a @B\n/vendor/\n' },
  });
  assert.equal(r.code, 0);
  assert.equal(
    r.out,
    'src/a.js: @a @B (line 1)\nvendor/x: no owner (line 2)\nsrc/a.js: @a @B (line 1)\nzz: no owner (no line matches)\n',
  );
});

test('--who JSON form', () => {
  const r = run(['--who', 'src/a.js', 'zz', '--json'], { files: { 'docs/CODEOWNERS': '/src/ @a\n' } });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), {
    tool: 'codeowners-check',
    version: '0.1.0',
    codeowners: 'docs/CODEOWNERS',
    who: [
      { path: 'src/a.js', owners: ['@a'], line: 1, pattern: '/src/' },
      { path: 'zz', owners: [], line: null, pattern: null },
    ],
  });
});

test('--who ignores syntax errors, does not read the tracked list and exits 0', () => {
  const r = run(['--who', 'a', '--file', 'CO'], { files: { CO: '@x @y\n!z @a\n' } });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'a: no owner (no line matches)\n');
});

test('--who takes arguments up to the next option; dir must come before', () => {
  const r = run(['.', '--who', 'a', 'b', '--json'], { files: { CODEOWNERS: '* @a\n' } });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).who.length, 2);
  usageError(['--who', 'a', 'b', '--files', 'l'], { files: { CODEOWNERS: '* @a\n', l: '' } });
});

test('--who needs a path, and no empty path', () => {
  usageError(['--who'], { files: { CODEOWNERS: '* @a\n' } });
  usageError(['--who', '--json'], { files: { CODEOWNERS: '* @a\n' } });
  usageError(['--who', 'a', ''], { files: { CODEOWNERS: '* @a\n' } });
});

test('--who cannot be combined with other options', () => {
  const files = { CODEOWNERS: '* @a\n', l: 'a' };
  for (const extra of [['--github'], ['--files', 'l'], ['--fail-on', 'none'], ['--require-owner'], ['--owner', '@a']]) {
    usageError(['--who', 'a', ...extra], { files });
  }
  // dir, --file and --json are allowed
  const r = run(['.', '--file', 'CODEOWNERS', '--json', '--who', 'a'], { files });
  assert.equal(r.code, 0, r.err);
});

// ------------------------------------------------------------ exit codes

test('--fail-on and the ok field', () => {
  const files = { CODEOWNERS: '* @a\n/none/ @b\n', l: 'x\n' };
  const warnOnly = (extra) => run(['--files', 'l', '--json', ...extra], { files });
  let r = warnOnly([]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).ok, true);
  assert.equal(JSON.parse(r.out).failOn, 'error');
  r = warnOnly(['--fail-on', 'error']);
  assert.equal(r.code, 0);
  r = warnOnly(['--fail-on', 'warning']);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).ok, false);
  assert.equal(JSON.parse(r.out).failOn, 'warning');
  r = warnOnly(['--fail-on', 'none']);
  assert.equal(r.code, 0);

  const errFiles = { CODEOWNERS: '@a\n', l: 'x\n' };
  const withError = (extra) => run(['--files', 'l', '--json', ...extra], { files: errFiles });
  r = withError([]);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.out).ok, false);
  assert.equal(withError(['--fail-on', 'warning']).code, 1);
  r = withError(['--fail-on', 'none']);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).ok, true);
});

test('--help prints a usage line and exits 0, whatever else is given', () => {
  for (const args of [['--help'], ['-h'], ['--bogus', '-h'], ['--fail-on', 'x', '--help']]) {
    const r = run(args);
    assert.equal(r.code, 0);
    assert.match(r.out, /^usage: codeowners-check /);
    assert.equal(r.out.split('\n').length, 2);
  }
});

// ------------------------------------------------------------ usage errors

test('usage errors exit 2 with nothing on stdout', () => {
  const files = { CODEOWNERS: '* @a\n', l: 'a\n' };
  const base = ['--files', 'l'];
  const cases = [
    [...base, '--bogus'],
    [...base, '--file=CODEOWNERS'],
    [...base, '-x'],
    [...base, '-'],
    ['--files'],
    [...base, '--file'],
    [...base, '--fail-on'],
    [...base, '--owner'],
    [...base, '--json', '--json'],
    [...base, '--github', '--github'],
    [...base, '--require-owner', '--require-owner'],
    [...base, '--files', 'l'],
    [...base, '--fail-on', 'none', '--fail-on', 'none'],
    [...base, '--owner', '@a', '--owner', '@a'],
    [...base, '--file', 'CODEOWNERS', '--file', 'CODEOWNERS'],
    ['.', '.', ...base],
    [...base, '--fail-on', 'warn'],
    [...base, '--fail-on', 'ERROR'],
    [...base, '--owner', 'nobody'],
    [...base, '--owner', '@a_b'],
    [...base, '--json', '--github'],
    [...base, '--owner', '@a', '--github'],
    [...base, '--file', '--json'],
    ['--files', 'missing'],
  ];
  for (const args of cases) usageError(args, { files });
});

test('an option value is taken whatever it is', () => {
  // the file named --json holds the rules
  const r = run(['--files', 'l', '--file', '--json'], { files: { '--json': '* @a\n', l: 'a\n' } });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^codeowners-check 0\.1\.0: --json, 1 tracked files, 1 rules\n/);
});

// ------------------------------------------------------------ speed

test('thousands of tracked files are answered quickly', () => {
  const tracked = [];
  for (let i = 0; i < 5000; i++) tracked.push(`pkg${i % 50}/src/mod${i % 7}/deep/file${i}.${i % 3 ? 'js' : 'md'}`);
  const rules = [];
  for (let i = 0; i < 50; i++) rules.push(i % 5 === 0 ? `/pkg${i}/ @team/t${i}` : i % 5 === 1 ? `**/mod${i % 7}/**/*.js @u${i}` : `pkg${i}/src/*/deep/*.md @a-${i}`);
  const start = Date.now();
  const rep = report(rules.join('\n') + '\n', tracked);
  assert.ok(Date.now() - start < 8000);
  assert.equal(rep.tracked, 5000);
  assert.equal(rep.rules, 50);
});
