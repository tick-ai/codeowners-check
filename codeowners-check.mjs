#!/usr/bin/env node
// codeowners-check: who owns what, and the CODEOWNERS lines that do nothing.
// One file, Node 22, built-in modules only, no network.
import { readFileSync, statSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL = 'codeowners-check';
const VERSION = '0.1.0';
const USAGE =
  'usage: codeowners-check [dir] [--file <path>] [--files <file|->] [--json | --github] ' +
  '[--fail-on error|warning|none] [--require-owner] [--owner <owner>] [--who <path>...]';
const CANDIDATES = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

class UsageError extends Error {}
const usage = (message) => {
  throw new UsageError(message);
};

// ---------------------------------------------------------------- owners

const USER = '@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?';
const RE_USER = new RegExp(`^${USER}$`);
const RE_TEAM = new RegExp(`^${USER}/[A-Za-z0-9_.-]{1,100}$`);
const RE_EMAIL = /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;
const isOwner = (s) => RE_USER.test(s) || RE_TEAM.test(s) || RE_EMAIL.test(s);
const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

// ---------------------------------------------------------------- arguments

function findHelp(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return true;
    if (a === '--file' || a === '--files' || a === '--fail-on' || a === '--owner') i++;
    else if (a === '--who') while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) i++;
  }
  return false;
}

function parseArgs(argv) {
  const o = {
    dir: undefined, file: undefined, files: undefined, json: false, github: false,
    failOn: 'error', requireOwner: false, owner: undefined, who: undefined,
  };
  const seen = new Set();
  const once = (name) => {
    if (seen.has(name)) usage(`option ${name} given twice`);
    seen.add(name);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': once(a); o.json = true; break;
      case '--github': once(a); o.github = true; break;
      case '--require-owner': once(a); o.requireOwner = true; break;
      case '--file':
      case '--files':
      case '--fail-on':
      case '--owner': {
        once(a);
        if (i + 1 >= argv.length) usage(`option ${a} needs a value`);
        const v = argv[++i];
        if (a === '--file') o.file = v;
        else if (a === '--files') o.files = v;
        else if (a === '--fail-on') {
          if (v !== 'error' && v !== 'warning' && v !== 'none') usage(`--fail-on must be error, warning or none, not "${v}"`);
          o.failOn = v;
        } else {
          if (!isOwner(v)) usage(`--owner value "${v}" is not a valid owner`);
          o.owner = v;
        }
        break;
      }
      case '--who': {
        once(a);
        const list = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) list.push(argv[++i]);
        if (list.length === 0) usage('--who needs at least one path');
        if (list.includes('')) usage('--who paths must not be empty');
        o.who = list;
        break;
      }
      default:
        if (a.startsWith('-')) usage(`unknown option ${a}`);
        if (o.dir !== undefined) usage('more than one dir given');
        o.dir = a;
    }
  }
  if (o.json && o.github) usage('--json and --github cannot be combined');
  if (o.owner !== undefined && o.github) usage('--owner and --github cannot be combined');
  if (o.who) {
    for (const s of seen) if (s !== '--who' && s !== '--file' && s !== '--json') usage(`--who cannot be combined with ${s}`);
  }
  return o;
}

// ---------------------------------------------------------------- input

function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        continue;
      }
      if (e.code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

function readFileOrUsage(path, what) {
  try {
    return readFileSync(path);
  } catch (e) {
    return usage(`cannot read ${what} "${path}": ${e.code || e.message}`);
  }
}

function parseTracked(buf) {
  const text = buf.toString('utf8');
  let entries;
  if (buf.includes(0)) entries = text.split('\0');
  else entries = text.split('\n').map((e) => (e.endsWith('\r') ? e.slice(0, -1) : e));
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (e === '' || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

function loadTracked(o, dir) {
  if (o.files === '-') return parseTracked(readStdinOrUsage());
  if (o.files !== undefined) return parseTracked(readFileOrUsage(o.files, '--files file'));
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: dir, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) usage(`cannot run git: ${r.error.message}`);
  if (r.status !== 0) usage(`git ls-files failed with status ${r.status}: ${String(r.stderr || '').trim()}`);
  return parseTracked(r.stdout);
}

function readStdinOrUsage() {
  try {
    return readStdin();
  } catch (e) {
    return usage(`cannot read standard input: ${e.code || e.message}`);
  }
}

// ---------------------------------------------------------------- patterns

const STAR = { star: true };
const ANY = { any: true };

function badPattern(pattern, why) {
  return { error: { rule: 'bad-pattern', message: `pattern "${pattern}" is not supported: ${why}` } };
}

function compileSegment(raw, anchored) {
  // returns null when the segment ends with a lone backslash
  if (anchored && raw === '**') return { globstar: true };
  const toks = [];
  let hasWildcard = false;
  const cps = Array.from(raw);
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c === '\\') {
      if (i + 1 >= cps.length) return null;
      toks.push(cps[++i]);
    } else if (c === '*') {
      hasWildcard = true;
      if (toks[toks.length - 1] !== STAR) toks.push(STAR);
    } else if (c === '?') {
      hasWildcard = true;
      toks.push(ANY);
    } else toks.push(c);
  }
  if (!hasWildcard) return { lit: toks.join('') };
  return { toks };
}

function compilePattern(p) {
  if (p.startsWith('!')) return badPattern(p, 'negation with ! does not work in CODEOWNERS');
  if (p.startsWith('\\#')) return badPattern(p, 'escaping a leading # does not work in CODEOWNERS (a leading # starts a comment)');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\') i++;
    else if (p[i] === '[') return badPattern(p, '[ ] character classes do not work in CODEOWNERS');
  }
  let t = p;
  let folderOnly = false;
  if (t.endsWith('/')) {
    folderOnly = true;
    t = t.slice(0, -1);
  }
  const anchored = t.includes('/');
  if (anchored && t.startsWith('/')) t = t.slice(1);
  const rawSegs = t.split('/').filter((s) => s !== '');
  if (rawSegs.length === 0) return badPattern(p, 'it names nothing');
  const segs = [];
  for (const r of rawSegs) {
    const s = compileSegment(r, anchored);
    if (s === null) return badPattern(p, 'a segment ends with a lone backslash');
    segs.push(s);
  }
  const last = segs[segs.length - 1];
  const claims = folderOnly || (!last.globstar && last.lit !== undefined);
  return { folderOnly, anchored, segs, claims };
}

function globMatch(toks, s) {
  let t = 0;
  let i = 0;
  let starT = -1;
  let starI = 0;
  while (i < s.length) {
    if (t < toks.length && toks[t] === STAR) {
      starT = t++;
      starI = i;
    } else if (t < toks.length && (toks[t] === ANY || toks[t] === s[i])) {
      t++;
      i++;
    } else if (starT >= 0) {
      t = starT + 1;
      i = ++starI;
    } else return false;
  }
  while (t < toks.length && toks[t] === STAR) t++;
  return t === toks.length;
}

const cpCache = new Map();
function segMatch(seg, part) {
  if (seg.lit !== undefined) return seg.lit === part;
  let cps = cpCache.get(part);
  if (cps === undefined) {
    cps = Array.from(part);
    cpCache.set(part, cps);
  }
  return globMatch(seg.toks, cps);
}

function matchAnchored(segs, parts) {
  const n = parts.length;
  const lastIdx = segs.length - 1;
  const memo = new Map();
  const m = (i, j) => {
    if (i === segs.length) return j === n;
    const key = i * (n + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const seg = segs[i];
    let res = false;
    if (seg.globstar) {
      if (i === lastIdx) res = j < n;
      else for (let k = j; k <= n && !res; k++) res = m(i + 1, k);
    } else res = j < n && segMatch(seg, parts[j]) && m(i + 1, j + 1);
    memo.set(key, res);
    return res;
  };
  return m(0, 0);
}

// does the pattern match the path made of `parts` (as a path, folder or file)?
function matchPath(rule, parts) {
  if (!rule.anchored) return segMatch(rule.segs[0], parts[parts.length - 1]);
  return matchAnchored(rule.segs, parts);
}

function ruleMatchesFile(rule, parts) {
  if (!rule.folderOnly && matchPath(rule, parts)) return true;
  if (rule.claims) {
    for (let k = 1; k < parts.length; k++) if (matchPath(rule, parts.slice(0, k))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- CODEOWNERS

function parseCodeowners(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rules = [];
  const findings = [];
  const lines = text.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    let line = lines[ln];
    const lineNo = ln + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const n = line.length;
    let i = 0;
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= n || line[i] === '#') continue;
    let j = i;
    while (j < n) {
      const c = line[j];
      if (c === ' ' || c === '\t') break;
      if (c === '\\' && j + 1 < n) j += 2;
      else j++;
    }
    const pattern = line.slice(i, j);
    const owners = [];
    for (const tok of line.slice(j).split(/[ \t]+/)) {
      if (tok === '') continue;
      if (tok.startsWith('#')) break;
      owners.push(tok);
    }
    const syntax = (rule, message) => findings.push({ line: lineNo, rule, severity: 'error', message, path: null, by: null });
    if (isOwner(pattern)) {
      syntax('no-pattern', `line starts with the owner ${pattern}: the owners were written without a pattern (a rule is a pattern, then its owners)`);
      continue;
    }
    const compiled = compilePattern(pattern);
    if (compiled.error) {
      syntax(compiled.error.rule, compiled.error.message);
      continue;
    }
    const bad = owners.find((t) => !isOwner(t));
    if (bad !== undefined) {
      syntax('bad-owner', `invalid owner "${bad}": GitHub would skip this line (use @user, @org/team or an email address)`);
      continue;
    }
    rules.push({ line: lineNo, pattern, owners, ...compiled });
  }
  return { rules, findings };
}

function decidingRule(rules, path) {
  const parts = path.split('/');
  for (let r = rules.length - 1; r >= 0; r--) if (ruleMatchesFile(rules[r], parts)) return rules[r];
  return null;
}

// ---------------------------------------------------------------- report

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function analyse(rules, tracked, requireOwner, ownerArg) {
  const nr = rules.length;
  const matched = new Uint8Array(nr);
  const decides = new Uint8Array(nr);
  const minBy = new Array(nr).fill(Infinity);
  const findings = [];
  let unowned = 0;
  const owned = ownerArg === undefined ? null : [];
  const want = ownerArg === undefined ? null : lower(ownerArg);
  for (const path of tracked) {
    const parts = path.split('/');
    const ms = [];
    for (let r = 0; r < nr; r++) if (ruleMatchesFile(rules[r], parts)) ms.push(r);
    const last = ms.length ? ms[ms.length - 1] : -1;
    if (last >= 0) {
      const decider = rules[last];
      for (const r of ms) {
        matched[r] = 1;
        if (r !== last && decider.line < minBy[r]) minBy[r] = decider.line;
      }
      decides[last] = 1;
      if (want !== null && decider.owners.some((o) => lower(o) === want)) owned.push(path);
    }
    if (last < 0 || rules[last].owners.length === 0) {
      unowned++;
      if (requireOwner) {
        const line = last < 0 ? 0 : rules[last].line;
        const why = last < 0 ? 'no line matches it' : `line ${line} gives it no owners`;
        findings.push({ line, rule: 'unowned', severity: 'error', message: `file "${path}" has no owner (${why})`, path, by: null });
      }
    }
  }
  for (let r = 0; r < nr; r++) {
    const rule = rules[r];
    if (!matched[r]) {
      findings.push({ line: rule.line, rule: 'dead', severity: 'warning', message: `pattern "${rule.pattern}" matches no tracked file`, path: null, by: null });
    } else if (!decides[r]) {
      findings.push({
        line: rule.line, rule: 'shadowed', severity: 'warning',
        message: `pattern "${rule.pattern}" is shadowed: line ${minBy[r]} takes every file it matches`,
        path: null, by: minBy[r],
      });
    }
  }
  if (owned) owned.sort();
  return { findings, unowned, owned };
}

function sortFindings(findings) {
  findings.sort((a, b) => a.line - b.line || cmp(a.rule, b.rule) || cmp(a.path ?? '', b.path ?? ''));
}

const escData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// ---------------------------------------------------------------- main

function findCodeowners(o, dir) {
  if (o.file !== undefined) return { name: o.file, buf: readFileOrUsage(o.file, '--file file') };
  for (const c of CANDIDATES) {
    let st;
    try {
      st = statSync(join(dir, c));
    } catch {
      continue;
    }
    if (st.isFile()) return { name: c, buf: readFileOrUsage(join(dir, c), 'CODEOWNERS file') };
  }
  return usage(`no CODEOWNERS file under "${dir}" (looked for ${CANDIDATES.join(', ')}); use --file`);
}

function run(argv) {
  if (findHelp(argv)) return { out: USAGE + '\n', code: 0 };
  const o = parseArgs(argv);
  const dir = o.dir === undefined ? '.' : o.dir;
  let st;
  try {
    st = statSync(dir);
  } catch {
    usage(`dir "${dir}" is not an existing folder`);
  }
  if (!st.isDirectory()) usage(`dir "${dir}" is not an existing folder`);

  const co = findCodeowners(o, dir);
  const { rules, findings } = parseCodeowners(co.buf);

  if (o.who) {
    const answers = o.who.map((path) => {
      const r = decidingRule(rules, path);
      return { path, owners: r ? r.owners : [], line: r ? r.line : null, pattern: r ? r.pattern : null };
    });
    if (o.json) {
      return { out: JSON.stringify({ tool: TOOL, version: VERSION, codeowners: co.name, who: answers }, null, 2) + '\n', code: 0 };
    }
    let out = '';
    for (const a of answers) {
      if (a.line === null) out += `${a.path}: no owner (no line matches)\n`;
      else if (a.owners.length === 0) out += `${a.path}: no owner (line ${a.line})\n`;
      else out += `${a.path}: ${a.owners.join(' ')} (line ${a.line})\n`;
    }
    return { out, code: 0 };
  }

  const tracked = loadTracked(o, dir);
  const a = analyse(rules, tracked, o.requireOwner, o.owner);
  findings.push(...a.findings);
  sortFindings(findings);
  const counts = { error: 0, warning: 0 };
  for (const f of findings) counts[f.severity]++;
  const failed = o.failOn === 'none' ? false : o.failOn === 'warning' ? counts.error + counts.warning > 0 : counts.error > 0;
  const code = failed ? 1 : 0;

  let out = '';
  if (o.json) {
    out = JSON.stringify({
      tool: TOOL, version: VERSION, codeowners: co.name, tracked: tracked.length, rules: rules.length,
      findings, counts, unowned: a.unowned, owned: a.owned, failOn: o.failOn, ok: !failed,
    }, null, 2) + '\n';
  } else if (o.github) {
    for (const f of findings) {
      const where = f.path !== null ? `file=${escProp(f.path)}` : `file=${escProp(co.name)},line=${f.line}`;
      out += `::${f.severity} ${where}::${f.rule}: ${escData(f.message)}\n`;
    }
  } else {
    out += `${TOOL} ${VERSION}: ${co.name}, ${tracked.length} tracked files, ${rules.length} rules\n`;
    for (const f of findings) out += `${co.name}:${f.line}: ${f.severity} ${f.rule}: ${f.message}\n`;
    out += `${findings.length} findings: ${counts.error} errors, ${counts.warning} warnings\n`;
    out += `${a.unowned} files have no owner\n`;
    if (a.owned) {
      out += `${o.owner} owns ${a.owned.length} files\n`;
      for (const p of a.owned) out += `  ${p}\n`;
    }
  }
  return { out, code };
}

try {
  const { out, code } = run(process.argv.slice(2));
  process.stdout.on('error', () => {});
  process.stdout.write(out);
  process.exitCode = code;
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  process.stderr.write(`${TOOL}: ${e.message}\n${USAGE}\n`);
  process.exitCode = 2;
}
