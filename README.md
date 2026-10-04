# weborg

A tiny org-mode clone that runs entirely in your browser.

**Text is the source of truth.** The document *is* the lines of an org
buffer (plus which headings are folded — view state, not file state, just
like org keeps it out of the file). There is no shadow object model: every
feature — folding, agenda, TODO cycling, deadlines, sparse tag views —
derives itself from the raw text on demand, and every edit writes raw text
back. Decorations (colors for keywords, tags, timestamps) are spans over
exactly the same characters, so the caret, the insert-mode textarea, and
the exported file are always the identical text. Anything weborg shows you
is a valid, Emacs-compatible `.org` file — including things typed by hand:
`TODO`, `[#A]`, `:tags:`, `DEADLINE: <2026-10-05 Mon -5d>`, repeaters
`+1w`, inactive stamps `[...]`.

Zero dependencies, no build step. Open `index.html` in any browser — it
also works over `file://`. Persists to `localStorage`; `:e` imports and
`:q` exports plain `.org` files.

## What's implemented

- `*` / `**` / ... heading trees with TODO / STARTED / WAITING / DONE
- Tags (`:work:home:`), priorities (`[#A]`), planning lines
  DEADLINE / SCHEDULED / CLOSED — all as text, all round-trip untouched
- Full org timestamp syntax ([manual §3.2.7](https://orgmode.org/manual/Timestamps.html)):
  active `<...>` / inactive `[...]`, weekday, time, time ranges,
  repeaters `+1w` (agenda resolves to the nearest occurrence),
  warning/delay cookies `-5d` / `--2d`
- Manual-correct agenda semantics
  ([Deadlines and Scheduling](https://orgmode.org/manual/Deadlines-and-Scheduling.html)):
  deadline shows on its day + warns 14 days before (org-deadline-warning-days)
  until DONE, per-entry `-Nd` lead overrides; scheduled reminds from its day
  until DONE, `-Nd` delays display; plain timestamps are events shown
  exactly on their day
- DONE stamps `CLOSED: [date time]` (inactive), removed when un-DONE —
  including when you *type* the keyword change into the line
- Folding: `TAB` on a heading, `zo/zc/zm/zr`; fold state survives every
  text edit (insert/delete/move remap the fold line numbers)
- Editing is raw-line editing: `i` puts a textarea over the whole line,
  stars included; `Enter` splits at the caret; `o/O` open lines;
  `x`/`dd`/`y`/`p` operate on lines/subtrees as text
- Org-style structure: `M-RET`/`C-RET` new heading after the section,
  `C-S-RET` child, `M-↑/↓` move section among siblings,
  `M-←/→` promote/demote (stars ±1 on the whole subtree — exactly what
  org does), `>>`/`<<`, `J`/`K`
- Search (`/`, `n`/`N`) over raw text; sparse tag view (`\`,
  space=AND, `|`=OR) keeping ancestors + matched sections
- `+`/`-` nudge DEADLINE in place (only the timestamp span is rewritten —
  the rest of the line, cookies and all, survives)
- Undo/redo = text snapshots; export/import = the text itself

## Bindings (summary)

Press `?` in the app for the full cheat sheet.

| keys | what |
|---|---|
| `h j k l` / arrows | caret in the RAW line / visible lines |
| `w b` / `W B` | words / headings |
| `g g` `G` `0` `$` | top, bottom, line start, line end |
| `i I a A` | edit whole raw line (stars included) |
| `Enter` (insert) | split line at caret |
| `o O` | new line below / above |
| `jk` `Esc` | leave insert (commits text) |
| `x` / `X` | delete char (EOL joins lines; `X` at col 0 joins up) |
| `dw` `d$` / `cw` `c$` `cc` | delete / change word, to EOL / clear line |
| `dd y p` | kill line or subtree / yank / paste |
| `Ctrl-V` | paste system clipboard as real lines (both modes) |
| `TAB` | fold/unfold heading |
| `zo zc zm zr` | fold ops |
| `T` / `S-TAB` | cycle TODO → STARTED → WAITING → DONE |
| `D` | straight to DONE (+ inactive CLOSED stamp) |
| `t t` / `t d` / `t s` / `t x` | tags / deadline / scheduled / clear dates |
| `+ -` | nudge deadline ±n days (counts work) |
| `[ ]` | priority A/B/C |
| `M-↑↓` `M-←→` `>>` `<<` `J` `K` | section moves (org-style) |
| `M-RET` `C-RET` `C-S-RET` | new sibling / child heading |
| `/` `n` `N` | search raw text |
| `\` | sparse tag view; `Esc` restores |
| `` ` `` | agenda panel (click to jump) |
| `:w :e :q` `u` `C-r` `?` | save / import / export / undo / redo / help |

## Layout

    index.html          shell + help overlay
    css/style.css       color-only decorations; never changes the char grid
    js/org.js           text model: doc = lines + folds; scan/ops —
                        pure, DOM-free, Node-testable
    js/app.js           rendering (span decoration), keymap, minibuffer
    tests/org.test.js   core tests — plain node, zero dependencies

## Tests

    node tests/org.test.js

No npm, no jsdom — the suite asserts on exact buffer text before and after
every operation.
