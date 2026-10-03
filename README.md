# weborg

A tiny org-mode clone that runs entirely in your browser.

Zero dependencies, no build step, no scripts to run: three plain files
(`index.html`, `css/style.css`, `js/org.js` + `js/app.js`). Open
`index.html` directly in any browser — it also works over `file://`.

Persists to `localStorage`, and `:e` imports / `:q` exports plain `.org`
files, so your data is never locked in.

## What's implemented

- `*` / `**` / `***` headline trees with TODO / STARTED / WAITING / DONE
- Tags (`:work:home:`), priorities (`[#A]`), DEADLINE / SCHEDULED / CLOSED
- Folding: `TAB` cycles a subtree, `zo/zc/zm/zr/zA` (`h`/`l` are plain movement)
- Plain-text editing: `i` on a heading edits the whole org line —
  type `TODO`, `[#A]`, `:tags:` directly as text
- Agenda side panel (`` ` ``) with overdue items flagged, click-to-jump
- Org-style structure editing: `M-↑/↓` and `M-k/j` move sections among
  siblings, `M-←/→` and `M-h/l` promote/demote, `M-RET` new heading
- Dates are typed, org-style: `2026-10-05`, `5.10`, `today`, `+3d`, `-1w`
- Org-ish plain-text format: everything round-trips through parse/serialize

## Bindings (summary)

Press `?` in the app for the full cheat sheet.

| keys | what |
|---|---|
| `h j k l` / arrows | left / down / up / right (caret on the line) |
| `w b W B` | next/prev heading, next/prev same-level |
| `gg G` 3j | top, bottom, counts everywhere |
| `i I a A o O` | insert at/after caret, line start/end; `o`/`O` create siblings |
| `jk` Esc | leave insert mode (classic) |
| `dd x y p` | kill subtree, delete body line, yank, paste |
| `>> <<` | indent / outdent subtree |
| `J K` | move subtree down / up |
| `M-↑/↓` `M-k/j` | move section among siblings (org M-arrows) |
| `M-←/→` `M-h/l` | promote / demote section |
| `M-RET` | new heading below (also from insert mode) |
| `T` (or `S-TAB`) | cycle TODO -> STARTED -> WAITING -> DONE |
| `D` | straight to DONE |
| `t t` | tags via minibuffer |
| `t d` / `t s` / `t x` | deadline / scheduled (typed date), clear dates |
| `+ -` | nudge deadline by days (counts work: `3+`) |
| `[ ]` | priority A/B/C |
| `` ` `` | agenda view |
| `?` | help overlay |
| `:w :e :q :t` | save / import .org / export .org / cycle TODO |
| `u  Ctrl-R` | undo / redo |

## Layout

    index.html          shell + help overlay
    css/style.css       plain text-first dark theme
    js/org.js           parser/model/agenda — pure, DOM-free, Node-testable
    js/app.js           rendering + keymap + minibuffer
    tests/org.test.js   core tests — plain node, zero dependencies

## Tests

    node tests/org.test.js

No npm, no jsdom — the test suite is plain `assert` over the pure model.
