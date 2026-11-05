# codeowners-check

codeowners-check reads your `CODEOWNERS` file and your tracked files, and tells you which lines are wrong, which lines do nothing, and which files nobody owns.

```sh
npx github:tick-ai/codeowners-check
```

For a repository whose `.github/CODEOWNERS` is

```text
*          @acme/core
/docs/     @acme/docs
*.md       @alice
/legacy/   @acme/old
@bob       @carol
```

and that tracks `README.md`, `docs/guide.md`, `src/app.js` and `src/util.js`, this is its real output:

```text
codeowners-check 0.1.0: .github/CODEOWNERS, 4 tracked files, 4 rules
.github/CODEOWNERS:2: warning shadowed: pattern "/docs/" is shadowed: line 3 takes every file it matches
.github/CODEOWNERS:4: warning dead: pattern "/legacy/" matches no tracked file
.github/CODEOWNERS:5: error no-pattern: line starts with the owner @bob: the owners were written without a pattern (a rule is a pattern, then its owners)
3 findings: 1 errors, 2 warnings
0 files have no owner
```

It exits 1 here, because there is an error. It is one Node file: nothing to install, no network, and it only reads the CODEOWNERS file and the list of tracked files.

## Why it matters

Agents (and people) open pull requests that nobody is asked to review. Either the file they touched has no owner, or a later line of `CODEOWNERS` silently took it from the team that should see it. Other lines match no file at all and only mislead the next reader, and a typo in an owner name makes GitHub skip a line without a word. codeowners-check finds all of these, in any repository, in any language, and can say who owns a given path and which files a given owner owns.

## Run it

```sh
# in the top folder of a repository (the tracked files come from `git ls-files -z`)
npx github:tick-ai/codeowners-check

# another folder, failing on warnings too
npx github:tick-ai/codeowners-check path/to/repo --fail-on warning

# who owns these paths?
npx github:tick-ai/codeowners-check --who src/app.js docs/guide.md

# which files does this owner own?
npx github:tick-ai/codeowners-check --owner @acme/core

# from a clone of this repository
node codeowners-check.mjs
```

It is not on npm yet: use `npx github:tick-ai/codeowners-check`, not `npx codeowners-check`. It needs Node 22 and, unless you give `--files`, `git`.

## How patterns are matched

Matching follows the rules of `.gitignore` as GitHub documents them for CODEOWNERS, with the differences below. Matching is case-sensitive and compares Unicode code points.

1. A trailing `/` is removed and makes the pattern **folders-only**.
2. If the text that is left still holds a `/` (including at its start), the pattern is **anchored**: it is matched against whole paths from the top of the repository (the folder `dir`, wherever the CODEOWNERS file sits); a leading `/` is then removed. Otherwise it is matched against the **name** of a path (its last part), at any depth.
3. The text is cut at every `/` into segments; empty segments are dropped. If none is left, the line is a `bad-pattern` error ("names nothing": `/`, `//`).
4. A segment matches one part of a path: `*` matches any run of characters (also none); `?` any one character (one code point); `\` makes the next character plain (a segment that ends with a lone `\` is a `bad-pattern` error). No wildcard matches a `/`. There are no `[ ]` classes. A segment that is exactly `**` is a **globstar**: in an anchored pattern it matches zero or more parts of the path, except as the last segment, where it matches one or more (`abc/**` matches what is inside `abc`, not `abc`). Any other `**`, and an unanchored `**`, is just `*`. So `**/foo` matches `foo` at any depth, and `a/**/b` matches `a/b`, `a/x/b` and `a/x/y/b`.
5. An anchored pattern matches a path when its segments match all the parts of the path, one for one (the globstar aside). An unanchored pattern matches a path when its one segment matches the path's last part.
6. A rule **matches a tracked file** when it matches the file's own path (not for a folders-only rule), or when it **claims folders** and matches one of the file's folders. A rule claims folders when it is folders-only, or when its last segment holds no wildcard. So `/docs/`, `docs`, `/apps/github` and `**/logs` own everything inside the folders they name, while `docs/*`, `*.js`, `/src/*` and `/docs/**/*.md` match only paths whose own last part fits the wildcard: `docs/*` matches `docs/a.md` but not `docs/build/b.md`.
7. **The last rule that matches a file decides it**, taking the rules in line order. The deciding rule's owners are the file's owners. A rule with **no owners** that decides a file leaves it with no owner: it resets ownership.

### How this differs from `.gitignore`

- No `!` negation.
- No `[ ]` classes.
- `\#` does not escape a leading `#` (a leading `#` starts a comment).
- Each line carries owners.
- The last matching line decides; there is no "a folder once excluded stays excluded".
- A pattern with a wildcard in its last segment does not take the folders it matches (`docs/*` does not own `docs/build/b.md`).
- The base is always the top of the repository.
- `\` escapes a space in the pattern, because a space ends the pattern.

### Not implemented

The CODEOWNERS size limit; checking that a user or team exists or has write access; sections (`[Section]` lines are a `bad-pattern` error); case-insensitive matching.

## Reading the files

**The CODEOWNERS file** is the first of `.github/CODEOWNERS`, `CODEOWNERS` and `docs/CODEOWNERS` that exists as a regular file under `dir`, or the one given with `--file`. It is read as UTF-8; a byte-order mark at its start is dropped; lines end at `\n` and a `\r` before it is dropped (CRLF files work). On each line, leading spaces and tabs are skipped; a blank line or one starting with `#` is a comment. The pattern runs to the first space or tab that is not escaped; after it come the owners, separated by spaces and tabs; a token starting with `#` and everything after it is a comment.

**The tracked list** comes from `git ls-files -z` run in `dir`, or from `--files <file>` / `--files -` (standard input). The bytes are read as UTF-8. If they hold a NUL byte, entries are separated by NUL (as `git ls-files -z` writes them); otherwise by newlines, a `\r` before a `\n` being dropped. Empty entries and duplicates are dropped. Entries are paths relative to `dir`, with `/` between parts and no leading `/` or `./`; they are used as written. The files on disk are never looked at.

## Owners

An owner is exactly one of:

- `@user`: `@`, then 1 to 39 letters, digits and hyphens, the first and last not a hyphen (no underscore, no dot);
- `@org/team`: `@org` written like `@user`, `/`, then 1 to 100 letters, digits, `-`, `_` and `.`;
- an email address `local@domain`: `local` is one or more of letters, digits and `. _ % + -`; `domain` is labels of letters, digits and `-` joined by dots, at least two labels, the last one of at least two letters.

Letters are ASCII. Owners are compared without regard to the case of ASCII letters (`@Acme/Core` and `@acme/core` are the same owner) and are always printed as written in the file.

## The rules

Every finding has a `line`, a `rule`, a `severity`, a `message`, a `path` and a `by`. A line has at most one syntax error, and a line with a syntax error is not a rule: it takes no part in matching and is never dead or shadowed.

| rule | severity | when |
| --- | --- | --- |
| `no-pattern` | error | the pattern is itself a valid owner (`@alice @bob`: the owners were written without a pattern) |
| `bad-pattern` | error | the pattern starts with `!`; starts with `\#`; holds a `[` not escaped by `\`; has a segment ending in a lone `\`; or names nothing |
| `bad-owner` | error | a token among the owners is not a valid owner (the first such token is named) |
| `dead` | warning | a rule matches no tracked file at all (an empty tracked list makes every rule dead) |
| `shadowed` | warning | a rule matches at least one tracked file but decides none, because a later rule matches each of them too; `by` is the lowest line among the rules that decide the files it matches |
| `unowned` | error | with `--require-owner` only: a tracked file has no owner (no rule matches it, or the deciding rule has no owners); `path` is the file, `line` the deciding rule's line or 0 when no rule matches |

Without `--require-owner` there is no `unowned` finding, only the count of such files. Findings are sorted by `line`, then `rule`, then `path`.

## Options

```text
codeowners-check [dir] [--file <path>] [--files <file|->] [--json | --github]
                 [--fail-on error|warning|none] [--require-owner] [--owner <owner>]
                 [--who <path>...]
```

| option | meaning |
| --- | --- |
| `dir` | the repository's top folder (default `.`); must be an existing folder; at most one |
| `--file <path>` | the CODEOWNERS file, relative to the current directory (not to `dir`) or absolute |
| `--files <file>` | read the tracked files from this file; `--files -` reads standard input; without it, `git ls-files -z` runs in `dir` |
| `--json` | print the report as JSON |
| `--github` | print one GitHub Actions workflow command per finding; cannot be combined with `--json` or `--owner` |
| `--fail-on <level>` | `error` (default), `warning` or `none`; see exit codes |
| `--require-owner` | files with no owner are findings of severity `error` |
| `--owner <owner>` | also list the files this owner owns (a valid owner, compared without case); the files whose deciding rule has this owner, sorted |
| `--who <path>...` | print who owns each path instead of reporting; takes every following argument up to the next one starting with `-`, so `dir` must come before it; works with `dir`, `--file` and `--json` only |
| `--help`, `-h` | print a usage line and exit 0 |

An option that takes a value takes the next argument, whatever it is. `--file=x` is not supported. An option given twice is a usage error, and so is any other argument that starts with `-`.

### Who owns a path

`--who` does not read the tracked list; the paths need not be tracked, and are written like tracked ones (`/` between parts, no leading `/` or `./`). The plain form has one line per path, in the order given:

```text
<path>: <owner> <owner> (line <n>)       the deciding rule has owners
<path>: no owner (line <n>)              the deciding rule has no owners
<path>: no owner (no line matches)       no rule matches
```

For the example at the top, `--who docs/guide.md src/app.js` prints `docs/guide.md: @alice (line 3)` and `src/app.js: @acme/core (line 1)`.

With `--json` it is `{"tool", "version", "codeowners", "who": [{"path", "owners", "line", "pattern"}]}`; `line` and `pattern` are `null` when no rule matches. It exits 0.

### `--github`

One line per finding and nothing else: `::<level> file=<path>::<rule>: <message>` for a finding with a path, otherwise `::<level> file=<codeowners>,line=<line>::<rule>: <message>`. `level` is `error` or `warning`. In the message `%` is written `%25`, a carriage return `%0D`, a line feed `%0A`; in the path and the CODEOWNERS name also `:` is `%3A` and `,` is `%2C`.

### The plain form

```text
codeowners-check 0.1.0: <codeowners>, <tracked> tracked files, <rules> rules
<codeowners>:<line>: <severity> <rule>: <message>      (one per finding)
<k> findings: <e> errors, <w> warnings
<u> files have no owner
<owner> owns <n> files                                  (only with --owner)
  <path>                                                (only with --owner, one per file)
```

## Exit codes

- `0`: no finding has the severity named by `--fail-on` or a higher one (`error` is higher than `warning`), or `--fail-on none`; also every `--who` run and `--help`.
- `1`: at least one does. The default is `--fail-on error`, so warnings alone exit 0.
- `2`: a usage error (unknown option, missing value, option twice, bad `dir`, bad `--fail-on` or `--owner`, incompatible options, no CODEOWNERS file, an unreadable `--file` or `--files` file, git failing). A message goes to stderr and nothing to stdout.

`--owner` and the `unowned` count never change the exit status.

## JSON format

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

`codeowners` is the file used (with `--file`, the value as given); `tracked` the number of tracked paths; `rules` the number of lines that are rules; `unowned` the number of tracked files with no owner (always present); `owned` is `null` without `--owner`, otherwise the sorted array of paths; `ok` is `true` exactly when the exit code is 0. Every finding has exactly the six fields shown.

## In CI

```yaml
name: codeowners
on: [pull_request]
jobs:
  codeowners-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx github:tick-ai/codeowners-check --require-owner --github
```

`--github` turns every finding into an annotation on the CODEOWNERS file (or on the unowned file). Add `--fail-on warning` to fail on dead and shadowed lines too.

## Tests

`node --test` (or `npm test`) runs the tests in `test/`; they build small repositories in temporary folders and never need `git`.

## Where it came from

Built by agents on TickHub, as TickHub job `28fcd972-6f94-4497-bb4a-18fb04a91abb`. The job, the hand-ins and the receipt are on TickHub's public log: https://tick.company/hub/#/job/28fcd972-6f94-4497-bb4a-18fb04a91abb. `docs/the-job.md` is the job as it was given.

AI does the work. Tick makes it trustworthy. https://tick.company

## Licence

Apache-2.0. Copyright 2026 Parsa Esmaeili. See `LICENSE`.
