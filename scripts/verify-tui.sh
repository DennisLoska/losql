#!/usr/bin/env bash
# Drives the compiled losql binary in tmux and checks what is on screen.
#   scripts/verify-tui.sh            checks on the demo database
#   LOSQL_VERIFY_PG_URL=postgres://… scripts/verify-tui.sh    also checks a Postgres connection
# Needs: tmux, perl, and ./losql built with `bun run build`.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/losql"
SESSION="losql-verify-$$"
PANE="=$SESSION:"            # exact match: never a session whose name merely begins with ours
PASTE="losql-verify-paste-$$"
WORK=""
FAILED=0

[ -x "$BIN" ] || { echo "missing $BIN: run 'bun run build' first" >&2; exit 2; }
command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 2; }
command -v perl >/dev/null || { echo "perl is required" >&2; exit 2; }

cleanup() {
  tmux kill-session -t "=$SESSION" 2>/dev/null
  tmux delete-buffer -b "$PASTE" 2>/dev/null
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
WORK="$(mktemp -d "${TMPDIR:-/tmp}/losql-verify.XXXXXX")" || exit 2

screen() { tmux capture-pane -p -t "$PANE"; }
keys() { tmux send-keys -t "$PANE" "$@"; sleep 0.4; }
type_text() { tmux send-keys -t "$PANE" -l -- "$1"; sleep 0.4; }
# A bracketed paste, as a terminal delivers one.
paste_text() { tmux set-buffer -b "$PASTE" "$1" && tmux paste-buffer -p -r -d -b "$PASTE" -t "$PANE"; sleep 0.4; }

# check "<description>" "<what is expected>" <command...>: passes as soon as the command succeeds, within 5 seconds
check() {
  local what="$1" wanted="$2" tries=25
  shift 2
  while [ "$tries" -gt 0 ]; do
    if "$@"; then echo "PASS  $what"; return 0; fi
    sleep 0.2; tries=$((tries - 1))
  done
  echo "FAIL  $what (expected: $wanted)"; screen | sed 's/^/      | /'; FAILED=1; return 1
}
on_screen() { screen | grep -qF -- "$1"; }
on_screen_re() { screen | grep -qE -- "$1"; }

# expect "<description>" "<text that must be on screen>"
expect() { check "$1" "to see: $2" on_screen "$2"; }
# expect_re "<description>" "<extended regular expression a line of the screen must match>"
expect_re() { check "$1" "a line matching: $2" on_screen_re "$2"; }

# The cells of the screen per background colour ("R;G;B", or "default" where none is painted), most first.
background_cells() {
  tmux capture-pane -p -e -N -t "$PANE" | perl -CS -ne '
    BEGIN { $bg = "default" }
    chomp;
    while (/\G(?:\e\[([0-9;]*)m|(.))/gcs) {
      if (defined $1) {
        my @p = split /;/, ($1 eq "" ? "0" : $1);
        while (@p) {
          my $c = shift @p;
          if ($c eq "0" || $c eq "49") { $bg = "default" }
          elsif ($c eq "48" || $c eq "38") {
            my $t = shift(@p) // "";
            my @v = $t eq "2" ? splice(@p, 0, 3) : $t eq "5" ? (shift(@p) // "") : ();
            $bg = ($t eq "5" ? "5;" : "") . join(";", @v) if $c eq "48";
          }
          elsif ($c =~ /^(?:4[0-7]|10[0-7])$/) { $bg = "c$c" }
        }
      } else { $n{$bg}++ }
    }
    END { print "$_ $n{$_}\n" for sort { $n{$b} <=> $n{$a} } keys %n }'
}
cells_on() { background_cells | awk -v bg="$1" '$1 == bg { n = $2 } END { print n + 0 }'; }
all_cells() { background_cells | awk '{ n += $2 } END { print n + 0 }'; }

NORD0="46;52;64"   # nord's background
NORD1="59;66;82"   # nord's panel background
# The screen is painted in nord (most cells on nord0 or nord1) and no cell keeps the previous Theme's background.
painted_in_nord() {
  local before="$1"
  case "$before" in default | "$NORD0" | "$NORD1") return 1 ;; esac
  local nord=$(( $(cells_on "$NORD0") + $(cells_on "$NORD1") ))
  [ $((nord * 2)) -gt "$(all_cells)" ] && [ "$(cells_on "$before")" -eq 0 ]
}
# The base background is not painted: no cell on nord0 or nord1, most cells on the terminal's own.
base_unpainted() {
  [ "$(cells_on "$NORD0")" -eq 0 ] && [ "$(cells_on "$NORD1")" -eq 0 ] &&
    [ $(( $(cells_on default) * 2 )) -gt "$(all_cells)" ]
}

start() { # start <connection> [columns rows]
  local connection="$1" width="${2:-140}" height="${3:-40}" command
  tmux kill-session -t "=$SESSION" 2>/dev/null
  command="$(printf 'env LOSQL_CONFIG_DIR=%q LOSQL_STATE_DIR=%q LOSQL_NO_ANIMATIONS=1 %q %q' \
    "$WORK/config" "$WORK/state" "$BIN" "$connection")"
  tmux new-session -d -s "$SESSION" -x "$width" -y "$height" "$command"
  sleep 1
}

echo "== first start on the demo database =="
start demo
expect "welcome screen" "get started"
keys Enter
expect "agent step lists providers" "Choose your agent"
expect "agent step shows Claude Code" "Claude Code"
type_text "continue"; keys Enter
expect "look step" "Pick a look"
keys Enter
expect "workspace: schema pane" "SCHEMA"
expect "workspace: demo relations" "customers"
expect "workspace: statusline" "demo · sqlite"

echo "== editing and running =="
keys g g d G
keys i
type_text "select * from cu"
keys C-n
# Only the popup's row shows the name next to its kind (the Schema Pane shows the name alone).
expect_re "completion popup opens in insert mode" "customers +table"
keys Escape
keys Escape
keys g g d G
keys i
type_text "select name, country from customers order by id;"
expect "insert mode is shown" "INSERT"
keys Escape
expect "normal mode is shown" "NORMAL"
keys Enter
expect "the table shows eight rows" "8 rows"
expect "column headers" "country"

echo "== statement error =="
keys g g d G
keys i
type_text "select * from missing_table;"
keys Escape
keys Enter
expect "error is shown" "no such table: missing_table"
keys u
keys u
keys Enter
expect "the table shows eight rows again" "8 rows"

echo "== result views =="
keys C-w j
keys Tab
expect "JSON view" '"name":'
keys Tab
expect "Record view" "row 1 of 8"
keys Tab

echo "== schema pane =="
keys C-w k
keys C-w h
# orders (12 rows), not customers: the 8 rows of the Run before are on screen already.
keys j j j Enter
expect "peeking at a relation shows its rows" "12 rows"
keys C-w l

echo "== agent pane and provider dialog =="
keys Space a a
expect "agent pane is reachable" "AGENT"
expect "agent pane says no agent is configured" "No agent is set up."
keys Space p
expect "provider dialog lists Claude Code" "Claude Code"
expect "provider dialog lists Codex" "Codex"
expect "provider dialog lists OpenCode" "OpenCode"
expect "provider dialog lists Antigravity" "Antigravity"
keys Escape
keys Space a a

echo "== themes =="
before_theme="$(background_cells | awk 'NR == 1 { print $1 }')"
keys ":"; type_text "theme nord"; keys Enter
check "a theme change repaints the screen in nord" \
  "most cells on nord's $NORD0 or $NORD1, none on the previous Theme's ${before_theme:-?}" painted_in_nord "${before_theme:-default}"
keys ":"; type_text "set transparent"; keys Enter
check "going transparent leaves the base background unpainted" \
  "no cell on $NORD0 or $NORD1, most on the terminal's own background" base_unpainted
keys Space
expect "key menu" "Help"
keys Escape
keys F1
expect "help dialog" "ctrl+w"
keys q

echo "== second start skips onboarding and restores the buffer =="
keys ":"; type_text "q"; keys Enter
sleep 0.5
if tmux has-session -t "=$SESSION" 2>/dev/null; then echo "FAIL  :q quits"; FAILED=1; else echo "PASS  :q quits"; fi
start demo
expect "no onboarding the second time" "SCHEMA"
expect "the buffer was restored" "select name, country from customers"
keys C-c; keys C-c
sleep 0.5
if tmux has-session -t "=$SESSION" 2>/dev/null; then echo "FAIL  ctrl+c twice quits"; FAILED=1; else echo "PASS  ctrl+c twice quits"; fi

echo "== pastes and the completion popup at 80 by 24 =="
start demo 80 24
expect "the workspace at 80 by 24" "SCHEMA"
# The Editor holds 12 and the line reads exactly so; nothing pasted elsewhere is in it.
buffer_is_12_without() { on_screen_re ' 1 12( |$)' && ! on_screen "$1"; }

keys g g d G
keys i; type_text "12"; keys Escape
keys i
paste_text "xyz"
expect_re "a paste into the Editor arrives once" ' 1 1xyz2( |$)'
keys Escape

keys g g d G
keys i; type_text "12"; keys Escape
keys ":"
paste_text "qqq"
expect "the command line takes a paste" ":qqq"
keys Escape
check "a paste into the command line leaves the Buffer unchanged" "line 1 reads 12, no qqq" buffer_is_12_without "qqq"

keys g g d G
keys i; type_text "12"; keys Escape
keys Space c
expect "the Connections dialog opens" "Explore the demo database"
paste_text "zqz"
expect "the Connections filter takes a paste" "zqz"
keys Escape
check "a paste into the Connections filter leaves the Buffer unchanged" "line 1 reads 12, no zqz" buffer_is_12_without "zqz"

# A Statement on line 7, in the middle of the Editor Pane (which ends above the Results Pane's header).
keys g g d G
keys i
keys Enter Enter Enter Enter Enter Enter
type_text "select * from c"
keys C-n
keys C-n C-n C-n C-n C-n C-n C-n C-n C-n C-n
before_accept="$(screen)"
keys Enter
accepted=""
# The name <CR> inserted was on a row above the Results Pane's header before the <CR>, and not on the cursor's row.
selection_was_visible() {
  accepted="$(screen | grep -oE ' 7 select \* from [A-Za-z_]+' | head -n 1 | sed 's/.* //')"
  [ -n "$accepted" ] && [ "$accepted" != "c" ] || return 1
  printf '%s\n' "$before_accept" | awk -v name="$accepted" '
    /RESULTS/ { exit }
    index($0, "select * from") == 0 && index($0, " " name " ") > 0 { found = 1 }
    END { exit found ? 0 : 1 }'
}
check "the item the eleventh ctrl+n selects is on screen above the Results Pane" \
  "the accepted name on a popup row above RESULTS before the <CR>" selection_was_visible
echo "      (accepted: ${accepted:-nothing})"

if [ -n "${LOSQL_VERIFY_PG_URL:-}" ]; then
  echo "== Postgres =="
  start "$LOSQL_VERIFY_PG_URL"
  # The status line's own text once connected (the URL itself is not on screen).
  expect "connected to Postgres" "· postgres"
  keys g g d G
  keys i
  type_text "select 40 + 2 as answer, now() as at;"
  keys Escape
  keys Enter
  # The Result's row: 42 next to the date now() gave (the Statement in the editor has neither).
  expect_re "a Postgres result" '42 +[0-9]{4}-[0-9]{2}-[0-9]{2}'
  expect "one row" "1 row"
  keys C-w j
  keys Tab
  expect "Postgres result in JSON view" '"answer": 42'
  keys ":"; type_text "q"; keys Enter
fi

echo
if [ "$FAILED" -eq 0 ]; then echo "all checks passed"; else echo "some checks FAILED"; fi
exit "$FAILED"
