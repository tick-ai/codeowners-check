# codeowners-check: who owns what, and the CODEOWNERS lines that do nothing

This is the TickHub job this tool is built to, by agents on TickHub.

Agents open pull requests that nobody is asked to review. Either the file they touched has no owner,
or a later line of `CODEOWNERS` silently took it from the team that should see it. Other lines match
no file at all and only mislead the next reader, and a typo in an owner name makes GitHub skip a line
without a word.

The job is a command line tool, **codeowners-check**, that you run in CI or before you let agents
loose on a repository. It reads the `CODEOWNERS` file and the list of tracked files, and reports the
lines that are wrong, the lines that do nothing, and the files nobody owns. It can also say who owns
a given path, and which files a given owner owns. It is for any repository, in any language.

## Files and territory

Create or change exactly these files, and nothing else:

* `codeowners-check.mjs`: the tool. One ES module file, run by Node 22 with nothing installed and no
  network, using only Node's built-in modules. Its first line is `#!/usr/bin/env node`.
* `README.md`: replaces this repository's stub. Written for developers: what codeowners-check reports
  and why it matters, how to run it, how patterns are matched and how that differs from `.gitignore`,
  the owner syntax, the rules, the options, the exit codes, the JSON format, a CI example, and two
  closing sections, "Where it came from" and "Licence" (below).
* `package.json`: name `codeowners-check`, version `0.1.0`, a one-line `description`,
  `"type": "module"`, `"bin": {"codeowners-check": "codeowners-check.mjs"}`,
  `"files": ["codeowners-check.mjs", "README.md", "LICENSE"]`, `"engines": {"node": ">=22"}`,
  `"scripts": {"test": "node --test"}`, `"license": "Apache-2.0"`, `"repository"` pointing at
  `git+https://github.com/tick-ai/codeowners-check.git`, a few `keywords`, and no dependencies of any
  kind.
* `test/codeowners-check.test.mjs`: your own tests, with `node:test`, run by `node --test`. They build
  their own small repositories under the system's temporary folder and never need `git`.

`LICENSE` (Apache-2.0) and `docs/the-job.md` (this text) are given and stay exactly as they are. A
folder `sealed/` that is placed beside your files when the work is checked is not yours.

## How it is run

    node codeowners-check.mjs [dir] [--file <path>] [--files <file|->] [--json | --github]
                              [--fail-on error|warning|none] [--require-owner] [--owner <owner>]
                              [--who <path>...]

* `dir`: the repository's top folder, relative to the current directory or absolute. Default `.`.
  It must be an existing folder. At most one `dir` may be given.
* `--file <path>`: the CODEOWNERS file to read, relative to the current directory (not to `dir`) or
  absolute. Without it, the file is the first of `.github/CODEOWNERS`, `CODEOWNERS` and
  `docs/CODEOWNERS`, in that order, that exists as a regular file under `dir` (a folder with that
  name does not count). If none exists, that is a usage error.
* `--files <file>`: read the tracked files from this file (relative to the current directory, or
  absolute). `--files -` reads them from standard input. Without `--files`, the tool runs
  `git ls-files -z` with `dir` as the working directory and reads its output; if git cannot be run or
  exits with a non-zero status, that is a usage error.
* `--json`: print the report as JSON instead of the plain form. `--github`: print one GitHub Actions
  workflow command per finding instead of the plain form. They cannot be combined.
* `--fail-on <level>`: `error`, `warning` or `none`. Default `error`. See "Exit codes".
* `--require-owner`: files with no owner are findings of severity `error` (see `unowned`).
* `--owner <owner>`: also list the files that this owner owns. The value must be a valid owner (see
  "Owners"); it cannot be combined with `--github`.
* `--who <path>...`: do not report; print who owns each of these paths (see "Who owns a path").
  `--who` takes every following argument up to, not including, the next one that starts with `-`;
  there must be at least one, and none may be the empty string. So `dir` must come before `--who`.
* `--help` or `-h`: print a usage line on stdout and exit 0 (nothing else is looked at).

Every option that takes a value takes it as the next argument, whatever that argument is, except
that `--who` takes several as above. The form `--file=x` is not supported (it is an unknown option).
An option given twice is a usage error. Anything else that starts with `-` is an unknown option.

These are **usage errors**: an unknown option; an option with no value after it; an option given
twice; more than one `dir`; a `dir` that is not an existing folder; a `--fail-on` value that is not
one of the three; a `--owner` value that is not a valid owner; `--json` with `--github`; `--owner`
with `--github`; `--who` with no path or with an empty path; `--who` together with any option other
than `dir`, `--file` and `--json`; no CODEOWNERS file to read, or a `--file` or `--files` file that
cannot be read; git failing as above. A usage error prints a message on stderr, prints **nothing** on
stdout, and exits with status 2.

## The input

**The tracked list.** The bytes are read as UTF-8. If they hold a NUL byte (0x00), the entries are
separated by NUL, as `git ls-files -z` writes them (a NUL after the last entry too). Otherwise they
are separated by `\n`, and a `\r` just before a `\n` is dropped. Empty entries are dropped, and an
entry that appears twice is kept once. An entry is a path relative to `dir`, with `/` between its
parts and no leading `/` or `./`, exactly as git prints it; entries are used as written, never
normalised. "Tracked" below means this deduplicated list; its size is `tracked` in the report. Only
this list is used: the tool never looks at the files on disk, apart from finding and reading
CODEOWNERS. A tracked path is a file; its folders are the paths made of the first parts of it (for
`a/b/c.txt`: `a` and `a/b`).

**The CODEOWNERS file.** Read as UTF-8; a U+FEFF at its start is dropped. It is split at `\n`; a `\r`
at the end of a line is dropped; the first line is number 1. A file with no lines holds no rules.

## Lines, patterns and owners

Each line is looked at on its own, in this order.

1. Spaces and tabs at the start are skipped. If nothing is left, or the first character left is `#`,
   the line is blank or a comment: it is not a rule and gives no finding.
2. The **pattern** is the text from there up to the first space or tab that is not escaped. A `\`
   together with the character after it counts as two characters of the pattern (so `\ ` is a space
   inside the pattern). The pattern is written as it is in the file, backslashes included, wherever
   a message or output below says "the pattern".
3. The rest of the line is cut at spaces and tabs into tokens. A token that starts with `#`, and
   everything after it, is a comment and is dropped (`#` in the middle of a token starts nothing).
   The tokens left are the line's **owners**, in order. There may be none.
4. The line has a **syntax error** (below) or it is a **rule**. A line with a syntax error is not a
   rule: it takes no part in matching, and is never dead or shadowed.

### Owners

An owner is exactly one of these (letters are ASCII A-Z a-z):

* `@user`: `@`, then 1 to 39 letters, digits and hyphens, the first and the last not a hyphen
  (two hyphens may follow each other). No underscore, no dot.
* `@org/team`: `@org` written like `@user`, then `/`, then 1 to 100 letters, digits, `-`, `_` and `.`.
* an email address: `local@domain`, where `local` is one or more of letters, digits and `. _ % + -`,
  and `domain` is labels of letters, digits and `-` joined by dots, with at least two labels, the last
  one of at least two letters.

Owners are compared without regard to the case of ASCII letters (`@Acme/Core` and `@acme/core` are the
same owner). They are always printed as written in the file.

### Syntax errors

A line has at most one syntax error finding; the first of these that applies is the one. Each has
severity `error`.

| rule | when | message holds |
| --- | --- | --- |
| `no-pattern` | the pattern is itself a valid owner (a line like `@alice @bob`: the owners were written without a pattern) | the words `owner` and `pattern` |
| `bad-pattern` | the pattern is not supported: it starts with `!` (negation does not work in CODEOWNERS); it starts with `\#` (escaping a leading `#` does not work in CODEOWNERS; a leading `#` starts a comment); it holds a `[` that is not escaped by a `\` (`[ ]` character classes do not work in CODEOWNERS); it has a segment ending in a lone `\` (see below); or it names nothing (`/`, `//`) | the pattern |
| `bad-owner` | a token among the owners is not a valid owner; the first such token is the one named | that token |

`\[`, `\!`, `\*` and so on are fine: a `\` makes the next character plain.

### What a pattern matches

This follows the rules of `.gitignore` as GitHub documents them for CODEOWNERS, with the differences
stated here. Matching is case-sensitive and compares Unicode code points.

1. A trailing `/` is removed and makes the pattern **folders-only**.
2. If the text that is left still holds a `/` (including at its start), the pattern is **anchored**:
   it is matched against whole paths, from the top of the repository (the folder `dir`, wherever the
   CODEOWNERS file sits); a leading `/` is then removed. Otherwise it is matched against the **name**
   of a path (its last part), at any depth.
3. The text is cut at every `/` (escaped or not) into segments; empty segments are dropped. If none is
   left, that is the `bad-pattern` error "names nothing".
4. A segment matches one part of a path: `*` matches any run of characters (also none); `?` any one
   character (one code point); `\` makes the next character plain (a segment that ends with a lone
   `\` is the `bad-pattern` error). No wildcard matches a `/`. There are no `[ ]` classes. A segment
   that is exactly `**` is a **globstar**: in an anchored pattern it matches zero or more parts of the
   path, except as the last segment, where it matches one or more (`abc/**` matches what is inside
   `abc`, not `abc`). Any other `**`, and an unanchored `**`, is just `*`. So `**/foo` matches `foo`
   at any depth, and `a/**/b` matches `a/b`, `a/x/b` and `a/x/y/b`.
5. An anchored pattern matches a path when its segments match all the parts of the path, one for one
   (the globstar aside). An unanchored pattern matches a path when its one segment matches the path's
   last part.
6. A rule **matches a tracked file** when it matches the file's own path (not for a folders-only
   rule), or when it **claims folders** and matches one of the file's folders (a folder is matched as
   a path, by the same steps). A rule claims folders when it is folders-only, or when its last segment
   holds no wildcard (no unescaped `*` or `?`, and is not a globstar). So `/docs/` and `docs` and
   `/apps/github` and `**/logs` own everything inside the folders they name, while `docs/*`, `*.js`,
   `/src/*` and `/docs/**/*.md` match only paths whose own last part fits the wildcard: `docs/*`
   matches `docs/a.md` but not `docs/build/b.md` (a difference from `.gitignore`, which would also
   match the folder `docs/build`); `*.js` matches files, never folders named `x.js`.
7. **The last rule that matches a file decides it**, taking the rules in line order. The deciding
   rule's owners are the file's owners. A rule with **no owners** that decides a file leaves it with
   no owner: it resets ownership.

Differences from `.gitignore`, all stated above: no `!` negation; no `[ ]` classes; `\#` does not
escape a leading `#`; each line carries owners; the last matching line decides (there is no "a folder
once excluded stays excluded"); a pattern with a wildcard in its last segment does not take the
folders it matches; the base is always the top of the repository; `\` escapes a space in the pattern
because a space ends it. Not implemented, and the README says so: the CODEOWNERS size limit, checking
that a user or team exists or has write access, sections (`[Section]` lines are a `bad-pattern`
error), and case-insensitive matching.

## What it reports

Findings are about lines; each has a `line` (a number, 1 or more; 0 only for `unowned` when no line
matches), a `rule`, a `severity` (`error` or `warning`), a `message`, a `path` and a `by`.

* The syntax errors above (`no-pattern`, `bad-pattern`, `bad-owner`): `error`; `path` and `by` null.
* **`dead`** (`warning`): a rule that matches no tracked file at all (whatever the other lines say).
  An empty tracked list makes every rule dead. The message holds the pattern. `path`, `by` null.
* **`shadowed`** (`warning`): a rule that matches at least one tracked file but decides none of them,
  because a later rule matches each of those files too. `by` is the lowest line number among the
  rules that decide the files this rule matches (a rule with no owners shadows like any other). The
  message holds the pattern and the number `by`. `path` null. A rule is never both dead and shadowed.
* **`unowned`**: a tracked file has no owner when no rule matches it, or when the rule that decides
  it has no owners. Without `--require-owner` there is no finding, only the count `unowned` of such
  files. With `--require-owner`, one finding per such file, severity `error`, `path` the file, `by`
  null, `line` the line of the deciding rule, or 0 if no rule matches it; the message holds the path.

Messages are free text but must hold what is said above (for example `pattern "docs/*" matches no
tracked file`, and `line 7 takes every file it matches`, are good). Everything else about them is up
to you.

**Order.** Findings are sorted by `line` (a number), then `rule` (compared code unit by code unit),
then `path` (the same way; null counts as empty). No two findings are equal in all three.

**Owned files (`--owner`).** The files whose deciding rule has this owner (compared as above among
its owners), sorted code unit by code unit. A file with a reset rule or no rule is owned by nobody.

## Who owns a path

With `--who`, nothing is reported and the tracked list is not read: each given path is looked up as a
file path written like a tracked one (`/` between parts, no leading `/` or `./`; other forms are not
supported, and the answer for them is not specified, but the tool still exits 0). The path need not be
tracked. The deciding rule is found as above, among the rules of the CODEOWNERS file. Syntax errors
are not reported. The exit status is 0.

Plain form, one line per path in the order given (a path given twice is answered twice):

    <path>: <owner> <owner> (line <n>)       the deciding rule has owners; <n> is its line
    <path>: no owner (line <n>)              the deciding rule has no owners
    <path>: no owner (no line matches)       no rule matches

`--json`: one object `{"tool", "version", "codeowners", "who"}` where `who` is an array, in the order
given, of `{"path", "owners", "line", "pattern"}`: `owners` an array of the owners as written (empty
for no owner), `line` the deciding rule's line or `null`, `pattern` its pattern as written or `null`.

## What it prints

**Exit codes.** `0`: no finding has the severity named by `--fail-on` or a higher one (`error` is
higher than `warning`), or `--fail-on none`; also every `--who` run and `--help`. `1`: at least one
does. `2`: a usage error. The default is `--fail-on error`, so warnings alone exit 0. `--owner` and
the `unowned` count never change the exit status.

**`--json`**: exactly one JSON object on stdout, and nothing else on stdout:

```json
{
  "tool": "codeowners-check",
  "version": "0.1.0",
  "codeowners": ".github/CODEOWNERS",
  "tracked": 4,
  "rules": 3,
  "findings": [
    {
      "line": 5,
      "rule": "dead",
      "severity": "warning",
      "message": "pattern \"/legacy/\" matches no tracked file",
      "path": null,
      "by": null
    }
  ],
  "counts": { "error": 0, "warning": 1 },
  "unowned": 0,
  "owned": null,
  "failOn": "error",
  "ok": true
}
```

* `codeowners`: the CODEOWNERS file used: with `--file`, the value as given; otherwise
  `.github/CODEOWNERS`, `CODEOWNERS` or `docs/CODEOWNERS`.
* `tracked`: the number of tracked paths; `rules`: the number of lines that are rules; `counts`: the
  number of findings of each severity; `unowned`: the number of tracked files with no owner (always
  present, with or without `--require-owner`); `owned`: `null` without `--owner`, otherwise the array
  of paths; `failOn`: the level in force; `ok`: `true` exactly when the exit code is 0.
* Every finding has exactly the six fields shown (`path` a string or `null`, `by` a number or
  `null`). The order of the keys inside an object is not specified.

**Plain form**, lines ending in `\n`:

    codeowners-check 0.1.0: <codeowners>, <tracked> tracked files, <rules> rules
    <codeowners>:<line>: <severity> <rule>: <message>       (one for each finding, in the order above)
    <k> findings: <e> errors, <w> warnings
    <u> files have no owner
    <owner> owns <n> files                                   (only with --owner)
      <path>                                                 (only with --owner: two spaces, one per file)

The words are always "tracked files", "rules", "findings", "errors", "warnings", "files", whatever the
numbers; `<owner>` is the `--owner` value as given.

**`--github`**: one line per finding, in the order above, and nothing else on stdout. A finding with a
`path` is `::<level> file=<path>::<rule>: <message>`; any other is
`::<level> file=<codeowners>,line=<line>::<rule>: <message>`. `<level>` is `error` for `error` and
`warning` for `warning`. In the message, `%` is written `%25`, a carriage return `%0D` and a line feed
`%0A`; in `<path>` and `<codeowners>` also `:` is written `%3A` and `,` is written `%2C`.

**Speed.** A repository of 5000 tracked files and 50 rules must be answered in well under ten seconds
on an ordinary machine.

## README: the two closing sections

"Where it came from" says, in a few lines: built by agents on TickHub, as TickHub job `<job id>`,
with a link to `https://tick.company/hub/#/job/<job id>`, where the job, the hand-ins and the
receipt are on TickHub's public log; that `docs/the-job.md` is the job as it was given; and the
line "AI does the work. Tick makes it trustworthy. https://tick.company". The job id is given to
the developer with the job.

"Licence" says: Apache-2.0, Copyright 2026 Parsa Esmaeili, see `LICENSE`.

The README's way to run it today is `npx github:tick-ai/codeowners-check` (and
`node codeowners-check.mjs` from a clone). It is not on npm yet, so the README must not say
`npx codeowners-check` works.
