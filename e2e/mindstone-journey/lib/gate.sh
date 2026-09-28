# The gate's step lists and its J11 wiring, sourced by run-journey.sh and
# exercised by lib/enterprise.selftest.mjs (so a change here that lets J11 leak
# into, or out of, a verdict fails the self-test, and X5 with it).
#
# J11 (an enterprise Azure OpenAI endpoint, MindStone-Agent #126) always runs
# and always has its row, but it is in the gate only with
# UAT_EXPECT_ENTERPRISE=1, and never in the DEMO SUBSET. Where it isn't
# counted, nothing of it counts: not its row, not Playwright's exit code when
# only J11 failed (on its own errors: lib/gate-rows.mjs), not a stall in J11.

# Every row the gate needs without the flag, each exactly once and each PASS.
GATE_BASE_STEPS="S0 S1 S2 S3 S5 C0 C1 C2 C3 C4 J1 J2 J3 J4 J5 J6 J7 J8 J9 X1 X2 X3 X4 X5"
# Rows that are always known (never "unknown row"), whether or not the gate counts them.
GATE_OPTIONAL_STEPS="J11"
# The DEMO SUBSET leaves J11 out, always.
GATE_DEMO_UNCOUNTED="J11"

# gate_required_steps <expect_enterprise 0|1>: the gate's required rows.
gate_required_steps() {
  if [[ "$1" == 1 ]]; then printf '%s J11' "${GATE_BASE_STEPS}"; else printf '%s' "${GATE_BASE_STEPS}"; fi
}

# gate_demo_steps: the demo subset, everything but the features still being built (J7 Skill Builder, J8
# persona drafting). J9 (memory recall across chats) is on the demo path, so it stays in. Never J11.
gate_demo_steps() {
  printf '%s' "${GATE_BASE_STEPS/ J7 J8/}"
}

# gate_uncounted <expect_enterprise 0|1>: the steps the gate leaves out (J11 without the flag).
gate_uncounted() {
  [[ "$1" == 1 ]] || printf 'J11'
}

# pw_explained_by <playwright exit> <results.json> <log> [step ...]: 0 when Playwright's non-zero exit is
# explained by failures of those steps only, on their own errors. Exit 0 needs no excuse and is not
# "explained"; with no steps, nothing is explained.
pw_explained_by() {
  local rc="$1" report="$2" log="$3"
  shift 3
  [[ $# -gt 0 && "${rc}" == 1 ]] || return 1
  node "$(dirname "${BASH_SOURCE[0]}")/gate-rows.mjs" "${report}" "$@" >>"${log}" 2>&1
}

# stalls_counted <stalls.tsv> [step ...]: how many stall lines are from steps other than those.
stalls_counted() {
  local file="$1"
  shift
  [[ -s "${file}" ]] || { printf '0'; return 0; }
  awk -F'\t' -v skip=" $* " 'NF && index(skip, " " $1 " ") == 0' "${file}" | wc -l | tr -d ' '
}
