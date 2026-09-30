# The gate's step lists and the wiring of its flag-gated steps, sourced by run-journey.sh and
# exercised by lib/enterprise.selftest.mjs (J11), lib/persona-builder.selftest.mjs (J10) and
# lib/settings-parity.selftest.mjs (J12), so a change here that lets any of them leak into, or out of, a
# verdict fails a self-test, and X5 with it.
#
# Three steps always run and always have their row, but are in the gate only with their flag, and never
# in the DEMO SUBSET:
# - J10, the persona builder in the Console (MindStone-Agent #125): UAT_EXPECT_PERSONA_BUILDER=1;
# - J11, an enterprise Azure OpenAI endpoint (MindStone-Agent #126): UAT_EXPECT_ENTERPRISE=1;
# - J12, settings parity: every setup choice changed from Settings (MindStone-Agent #140): UAT_EXPECT_SETTINGS_PARITY=1.
# Where one isn't counted, nothing of it counts: not its row, not Playwright's exit code when only
# uncounted steps failed (on their own errors: lib/gate-rows.mjs), not a stall in it.

# Every row the gate needs without any of the flags, each exactly once and each PASS.
GATE_BASE_STEPS="S0 S1 S2 S3 S5 C0 C1 C2 C3 C4 J1 J2 J3 J4 J5 J6 J7 J8 J9 J13 X1 X2 X3 X4 X5"
# Rows that are always known (never "unknown row"), whether or not the gate counts them.
GATE_OPTIONAL_STEPS="J10 J11 J12"
# The DEMO SUBSET leaves J10, J11 and J12 out, always.
GATE_DEMO_UNCOUNTED="J10 J11 J12"

# gate_required_steps <expect_enterprise 0|1> [<expect_persona_builder 0|1>] [<expect_settings_parity 0|1>]:
# the gate's required rows.
gate_required_steps() {
  printf '%s' "${GATE_BASE_STEPS}"
  [[ "${2:-0}" == 1 ]] && printf ' J10'
  [[ "$1" == 1 ]] && printf ' J11'
  [[ "${3:-0}" == 1 ]] && printf ' J12'
  return 0
}

# gate_demo_steps: the demo subset, everything but the features still being built (J7 Skill Builder, J8
# persona drafting). J9 (memory recall across chats) and J13 (MindStone navigation, console #53) are on the
# demo path, so they stay in. Never J10, J11 or J12.
gate_demo_steps() {
  printf '%s' "${GATE_BASE_STEPS/ J7 J8/}"
}

# gate_uncounted <expect_enterprise 0|1> [<expect_persona_builder 0|1>] [<expect_settings_parity 0|1>]: the
# steps the gate leaves out (J10 without its flag, J11 without its, J12 without its).
gate_uncounted() {
  local out=()
  [[ "${2:-0}" == 1 ]] || out+=(J10)
  [[ "$1" == 1 ]] || out+=(J11)
  [[ "${3:-0}" == 1 ]] || out+=(J12)
  printf '%s' "${out[*]:-}"
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

# restore_failures <restore-failures.tsv>: the steps that could not put back what they changed (J10's active
# persona, J12's default model, memory setting and USER.md), one "<step>: <what>" line each. Each one counts
# against the gate AND the DEMO SUBSET, whatever that step's own verdict: an uncounted step must not silently
# change what the counted steps after it run on.
restore_failures() {
  [[ -s "$1" ]] || return 0
  awk -F'\t' 'NF { printf "%s: %s\n", $1, $2 }' "$1"
}
