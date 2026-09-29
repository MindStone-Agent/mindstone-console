#!/usr/bin/env bash
# MindStone fresh-install journey UAT (MindStone-Agent #106).
#
#   e2e/mindstone-journey/run-journey.sh <msa-ref> <console-ref>
#
# Does what a new user does: installs MindStone-Agent with install.sh into a
# fresh scratch dir, follows both READMEs' "Install guide for AI agents"
# literally (deviations are labelled and listed in the summary), brings up
# the Console with docker compose, creates the admin, then drives the rest of
# the journey through the UI only (journey.spec.ts). Every step prints PASS,
# FAIL, PENDING or MOCK with evidence. Everything it creates is torn down on
# exit; the evidence dir is kept, checked for secrets, and scrubbed.
# UAT_INSTALL=stack installs the whole stack in Docker with install-stack.sh
# instead (MindStone-Agent #171, lib/stack.sh); the journey is the same.
set -Eeuo pipefail

if [[ $# -lt 2 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  echo "See e2e/mindstone-journey/README.md for the environment variables."
  exit 2
fi

MSA_REF="$1"
CONSOLE_REF="$2"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLE_HARNESS_ROOT="$(cd "${HERE}/../.." && pwd)"
HARNESS_REL="e2e/mindstone-journey"

MSA_REPO_DEFAULT="https://github.com/MindStone-Agent/MindStone-Agent.git"
MSA_REPO="${UAT_MSA_REPO:-${MSA_REPO_DEFAULT}}"
MSA_RAW="${UAT_MSA_RAW:-https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent}"
CONSOLE_REPO="${UAT_CONSOLE_REPO:-https://github.com/MindStone-Agent/mindstone-console.git}"
OLLAMA_URL="${UAT_OLLAMA_URL:-http://127.0.0.1:11434}"
OLLAMA_URL="${OLLAMA_URL%/}"

RUN_ID="${UAT_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
RUN_ID="$(printf '%s' "${RUN_ID}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-')"
PROJECT="uat-journey-${RUN_ID}"
SCRATCH_ROOT="${UAT_SCRATCH_ROOT:-${TMPDIR:-/tmp}}"
SCRATCH="${SCRATCH_ROOT%/}/${PROJECT}"
EVIDENCE="${UAT_EVIDENCE_DIR:-${HERE}/evidence/${RUN_ID}}"
PORT_MIN="${UAT_PORT_MIN:-26900}"
PORT_MAX="${UAT_PORT_MAX:-26999}"

MSA_DIR="${SCRATCH}/MindStone-Agent"
CONSOLE_DIR="${SCRATCH}/mindstone-console"
COMPOSE_DIR="${CONSOLE_DIR}/mindstone"
SCRATCH_HOME="${SCRATCH}/home"           # HOME for everything MindStone-Agent does
SECRETS_DIR="${SCRATCH}/harness-secrets" # generated secrets, curl header files; never printed
OVERRIDE_FILE="${SCRATCH}/compose.uat-override.yml"
REAL_NPM_CACHE="${npm_config_cache:-${HOME}/.npm}"
INSTALL_STATUS_TMP="/tmp/mindstone-agent-install-status.txt" # older install.sh's fixed path (F-MSA-1)
# How MindStone is installed: native (install.sh, then the Console from mindstone/docker-compose.yml) or stack (the
# gateway, the Console and MongoDB in one Compose project, from install-stack.sh: lib/stack.sh, which also sets the
# stack's own values of the three below).
INSTALL_MODE="${UAT_INSTALL:-native}"
GW_TOKEN_FILE="${MSA_DIR}/.runtime/mindstone/secrets/gateway-token" # the gateway token (stack: a 0600 copy)
HARNESS_IMAGES="${PROJECT}-console:local"                          # the images this run builds, removed on exit
CONSOLE_IMAGE="${PROJECT}-console:local"                           # the Console image X2 checks
STACK_STARTED=0

STEPS_TSV="${EVIDENCE}/harness-steps.tsv"
LOG_DIR="${EVIDENCE}/logs"
# The gate's step lists and the J10/J11/J12 wiring live in lib/gate.sh (self-tested by lib/enterprise.selftest.mjs,
# lib/persona-builder.selftest.mjs and lib/settings-parity.selftest.mjs).
# shellcheck source=lib/gate.sh
source "${HERE}/lib/gate.sh"
# J10 (the persona builder in the Console, MindStone-Agent #125) is in the gate only with
# UAT_EXPECT_PERSONA_BUILDER=1, J11 (an enterprise Azure OpenAI endpoint, MindStone-Agent #126) only with
# UAT_EXPECT_ENTERPRISE=1, and J12 (settings parity, MindStone-Agent #140) only with UAT_EXPECT_SETTINGS_PARITY=1
# (like UAT_EXPECT_FLOW for J2). None of them is ever in the DEMO SUBSET.
EXPECT_ENTERPRISE="${UAT_EXPECT_ENTERPRISE:-0}"
EXPECT_PERSONA_BUILDER="${UAT_EXPECT_PERSONA_BUILDER:-0}"
EXPECT_SETTINGS_PARITY="${UAT_EXPECT_SETTINGS_PARITY:-0}"
# Every row the gate needs, each exactly once and each PASS.
REQUIRED_STEPS="$(gate_required_steps "${EXPECT_ENTERPRISE}" "${EXPECT_PERSONA_BUILDER}" "${EXPECT_SETTINGS_PARITY}")"
# The demo subset: everything but the features still being built (J7 Skill Builder, J8 persona drafting).
# J9 (memory recall across chats) is on the demo path, so it stays in: while it is PENDING, the subset is NOT PASSED.
DEMO_STEPS="$(gate_demo_steps)"
OPTIONAL_STEPS="${GATE_OPTIONAL_STEPS}"
# The steps each verdict leaves out, Playwright's exit and stalls included.
GATE_UNCOUNTED="$(gate_uncounted "${EXPECT_ENTERPRISE}" "${EXPECT_PERSONA_BUILDER}" "${EXPECT_SETTINGS_PARITY}")"
DEMO_UNCOUNTED="${GATE_DEMO_UNCOUNTED}"
T0=$(date +%s)
GW_PORT=""
CONSOLE_PORT=""
ENT_STUB_PORT=""
ENT_STUB_PID=""
COMPOSE_STARTED=0
CURRENT_STEP=""
FATAL=""
PW_RC="not run"
TMP_STATUS_PREEXISTED=1
STARTED=0
HARNESS_DIRTY=0
HARNESS_HASH_START=""
EMBED_MODEL=""

# ---------------------------------------------------------------- output ----
c_reset=$'\033[0m'; c_green=$'\033[32m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'; c_dim=$'\033[2m'; c_gold=$'\033[38;5;214m'; c_bold=$'\033[1m'
[[ -t 1 ]] || { c_reset=""; c_green=""; c_red=""; c_yellow=""; c_dim=""; c_gold=""; c_bold=""; }

log() { printf '%s[uat %s]%s %s\n' "${c_gold}" "$(date +%H:%M:%S)" "${c_reset}" "$*"; }

colour_for() {
  case "$1" in
    PASS) printf '%s' "${c_green}" ;;
    FAIL|MISSING) printf '%s' "${c_red}" ;;
    PENDING|MOCK|SKIPPED) printf '%s' "${c_yellow}" ;;
    *) printf '%s' "${c_dim}" ;;
  esac
}

# rel <path>: the path relative to the evidence dir (evidence rows never carry host paths).
rel() { local p="${1:-}"; [[ -z "$p" ]] && return 0; printf '%s' "${p#"${EVIDENCE}"/}"; }

# record <id> <STATUS> <title> <evidence> [note]
record() {
  local id="$1" status="$2" title="$3" ev note="${5:-}"
  ev="$(rel "${4:-}")"
  printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$status" "$title" "$ev" "${note//$'\t'/ }" >>"${STEPS_TSV}"
  printf '  %s%-7s%s %-4s %s\n' "$(colour_for "$status")" "$status" "${c_reset}" "$id" "$title"
  [[ -n "$note" ]] && printf '               %s%s%s\n' "${c_dim}" "$note" "${c_reset}"
  [[ -n "$ev" ]] && printf '               %sevidence: %s%s\n' "${c_dim}" "$ev" "${c_reset}"
  return 0
}

# finding <id> <text>: a place the READMEs were wrong or incomplete when followed literally.
finding() {
  printf -- '- **%s** %s\n' "$1" "$2" >>"${EVIDENCE}/findings.md"
  printf '  %sFINDING%s %-4s %s\n' "${c_yellow}" "${c_reset}" "$1" "$2"
}

# deviation <text>: something the harness does that the READMEs don't say.
deviation() {
  printf -- '- %s\n' "$1" >>"${EVIDENCE}/deviations.md"
}

die() {
  FATAL="$1"
  log "${c_red}stopping:${c_reset} $1"
  exit 1
}

# ------------------------------------------------------------ safety rails ----
[[ "${PORT_MIN}" =~ ^[0-9]+$ && "${PORT_MAX}" =~ ^[0-9]+$ ]] || die "UAT_PORT_MIN/MAX must be numbers"
if (( PORT_MIN <= 18999 && PORT_MAX >= 18000 )); then
  die "the port range ${PORT_MIN}-${PORT_MAX} overlaps 18000-18999, which is reserved for live gateways"
fi
case "${SCRATCH}" in
  "${HOME}"/Projects/*|"${HOME}/.mindstone"*|"${HOME}/.openclaw"*|"${HOME}/.pi"*) die "refusing scratch dir ${SCRATCH}" ;;
esac
[[ -e "${SCRATCH}" ]] && die "scratch dir already exists: ${SCRATCH} (set UAT_RUN_ID to something new)"
[[ "${EXPECT_ENTERPRISE}" == 0 || "${EXPECT_ENTERPRISE}" == 1 ]] || die "UAT_EXPECT_ENTERPRISE must be 0 or 1, not ${EXPECT_ENTERPRISE}"
[[ "${EXPECT_PERSONA_BUILDER}" == 0 || "${EXPECT_PERSONA_BUILDER}" == 1 ]] || die "UAT_EXPECT_PERSONA_BUILDER must be 0 or 1, not ${EXPECT_PERSONA_BUILDER}"
[[ "${EXPECT_SETTINGS_PARITY}" == 0 || "${EXPECT_SETTINGS_PARITY}" == 1 ]] || die "UAT_EXPECT_SETTINGS_PARITY must be 0 or 1, not ${EXPECT_SETTINGS_PARITY}"
[[ "${INSTALL_MODE}" == native || "${INSTALL_MODE}" == stack ]] || die "UAT_INSTALL must be native or stack, not ${INSTALL_MODE}"
if [[ "${INSTALL_MODE}" == stack ]]; then
  # The stack's own defaults are a live install's ports: a harness range must never reach them.
  if (( PORT_MIN <= 3080 && PORT_MAX >= 3080 )) || (( PORT_MIN <= 19789 && PORT_MAX >= 19789 )); then
    die "stack mode: the port range ${PORT_MIN}-${PORT_MAX} includes 3080 or 19789, the stack's defaults"
  fi
  # install-stack.sh and its compose file build from the MindStone-Agent GitHub repos by URL: a fork can't be swapped in.
  [[ -z "${UAT_MSA_REPO:-}" && -z "${UAT_CONSOLE_REPO:-}" ]] || die "stack mode builds from the MindStone-Agent GitHub repos: unset UAT_MSA_REPO and UAT_CONSOLE_REPO"
  [[ -z "${UAT_STACK_INSTALLER_FILE:-}" || -r "${UAT_STACK_INSTALLER_FILE}" ]] || die "UAT_STACK_INSTALLER_FILE isn't a readable file: ${UAT_STACK_INSTALLER_FILE}"
fi
# NODE_OPTIONS can preload code into every node process the harness starts (the spec, the
# checks, the gateway): a run with it set proves nothing. Recorded in provenance as empty.
if [[ -n "${NODE_OPTIONS:-}" ]]; then
  die "NODE_OPTIONS is set; unset it (the harness refuses to run with preloaded code)"
fi
# Each run gets its own, empty evidence dir: stale results must never count.
if [[ -e "${EVIDENCE}" ]] && [[ -n "$(ls -A "${EVIDENCE}" 2>/dev/null)" ]]; then
  die "evidence dir is not empty: ${EVIDENCE} (use a new UAT_RUN_ID or UAT_EVIDENCE_DIR)"
fi

port_free() {
  local p="$1"
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then return 1; fi
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then return 1; fi
  return 0
}

pick_port() { # pick_port [port to skip ...]
  local p
  for ((p = PORT_MIN; p <= PORT_MAX; p++)); do
    [[ " $* " == *" $p "* ]] && continue
    if port_free "$p"; then printf '%s' "$p"; return 0; fi
  done
  return 1
}

need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

# The environment every MindStone-Agent command runs in: a scratch HOME (so
# nothing reaches ~/.mindstone*, ~/.pi or ~/.openclaw), no inherited
# MINDSTONE_*/PI_* variables (so nothing points at a live gateway), and the
# harness port. npm keeps using the real download cache, so installs stay fast.
msa_env() {
  env -i \
    HOME="${SCRATCH_HOME}" \
    PATH="${PATH}" \
    USER="${USER:-uat}" LOGNAME="${LOGNAME:-uat}" SHELL=/bin/bash \
    LANG="${LANG:-en_US.UTF-8}" TERM=dumb \
    TMPDIR="${SCRATCH}/tmp" \
    npm_config_cache="${REAL_NPM_CACHE}" \
    npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
    GIT_TERMINAL_PROMPT=0 \
    MINDSTONE_AGENT_GATEWAY_PORT="${GW_PORT}" \
    ${MINDSTONE_AGENT_GATEWAY_HOST_OVERRIDE:+MINDSTONE_AGENT_GATEWAY_HOST="${MINDSTONE_AGENT_GATEWAY_HOST_OVERRIDE}"} \
    "$@"
}

mindstone() { (cd "${MSA_DIR}" && msa_env ./node_modules/.bin/mindstone "$@"); }

# `mindstone gateway start|restart`, with one addition for J11: MindStone-Agent #126 lets an enterprise
# endpoint be a loopback or private host (plain http on loopback only) only when the gateway's own
# environment has MINDSTONE_ENTERPRISE_PRIVATE_HOSTS=1, never from the Console. J11's stub Azure endpoint is
# on 127.0.0.1, so the gateway the harness starts has it; no other command gets it. The CLI passes its
# environment to the gateway it spawns. (A gateway without #126 ignores it.)
gateway_cmd() { (cd "${MSA_DIR}" && msa_env MINDSTONE_ENTERPRISE_PRIVATE_HOSTS=1 ./node_modules/.bin/mindstone gateway "$@"); }

# stop_ent_stub: stops J11's stub Azure endpoint, if this run started it (only that process: its PID, and only
# while that PID is still the stub from this checkout), then anything left listening on its port that is.
stop_ent_stub() {
  local pid
  if [[ "${ENT_STUB_PID}" =~ ^[0-9]+$ ]] && ps -o command= -p "${ENT_STUB_PID}" 2>/dev/null | grep -qF "${HERE}/lib/azure-stub.mjs"; then
    kill "${ENT_STUB_PID}" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "${ENT_STUB_PID}" 2>/dev/null || break; sleep 0.3; done
  fi
  if [[ -n "${ENT_STUB_PORT}" ]] && command -v lsof >/dev/null 2>&1; then
    for pid in $(lsof -nP -t -iTCP:"${ENT_STUB_PORT}" -sTCP:LISTEN 2>/dev/null); do
      if ps -o command= -p "${pid}" 2>/dev/null | grep -qF "${HERE}/lib/azure-stub.mjs"; then kill "${pid}" 2>/dev/null; fi
    done
  fi
  return 0
}

# Compose, as the README runs it (from mindstone/), in our own project with the port override.
compose() { (cd "${COMPOSE_DIR}" && COMPOSE_PROJECT_NAME="${PROJECT}" COMPOSE_FILE="docker-compose.yml:${OVERRIDE_FILE}" docker compose "$@"); }

tail_to() { # tail_to <src> <dest> [lines]
  [[ -f "$1" ]] && tail -n "${3:-200}" "$1" >"$2" 2>/dev/null || true
}

# interruptible <cmd...>: runs a long child. Ctrl-C reaches the whole process group; a child
# that catches it (docker compose, npm) exits 130 instead of dying on the signal, and then bash
# doesn't run its own INT trap. So a 129/130/143 exit is treated as the interrupt it is.
interruptible() {
  local rc=0
  "$@" || rc=$?
  if [[ "${rc}" == 129 || "${rc}" == 130 || "${rc}" == 143 ]]; then
    FATAL="interrupted"
    exit 130
  fi
  return "${rc}"
}

elapsed() { local s=$(( $(date +%s) - $1 )); printf '%dm%02ds' $((s / 60)) $((s % 60)); }

# new_secret <name> <openssl rand args...>: a generated secret, written straight to a 0600 file.
new_secret() { local name="$1"; shift; (umask 077; openssl rand "$@" >"${SECRETS_DIR}/${name}"); }

# Curl header files, so no token is ever on a command line (ps shows argv).
write_header_files() {
  (
    umask 077
    printf 'Authorization: Bearer %s\n' "$(cat "${GW_TOKEN_FILE}")" >"${SECRETS_DIR}/h-auth"
    printf 'x-mindstone-admin-token: %s\n' "$(cat "${SECRETS_DIR}/admin-credential")" >"${SECRETS_DIR}/h-admin"
  )
}

secret_sources() {
  if [[ "${INSTALL_MODE}" == stack ]]; then
    # The stack's generated secrets: console.env and gateway.env (600), the admin password, and the harness's copies.
    printf '%s\n' "${SECRETS_DIR}" "${STACK_DIR}/console.env" "${STACK_DIR}/gateway.env" "${STACK_DIR}/admin-password"
  else
    printf '%s\n' "${SECRETS_DIR}" "${MSA_DIR}/.runtime/mindstone/secrets" "${COMPOSE_DIR}/.env"
  fi
  [[ -n "${UAT_PROVIDER_KEY_FILE:-}" ]] && printf '%s\n' "${UAT_PROVIDER_KEY_FILE}"
  return 0
}

# The harness's own provenance: commit, git status of its dir, and a hash of its files.
harness_hash() { node "${HERE}/lib/harness-hash.mjs" "${CONSOLE_HARNESS_ROOT}" "${HARNESS_REL}" 2>/dev/null | cut -d' ' -f1; }

# Host details the posted evidence must not carry: paths and names -> labels.
write_redaction_pairs() {
  local out="$1" p real
  {
    for p in "${SCRATCH}:<scratch>" "${EVIDENCE}:<evidence>" "${HERE}:<harness>" "${CONSOLE_HARNESS_ROOT}:<repo>" \
             "${TMPDIR:-/nonexistent}:<tmp>" "${HOME}:~"; do
      local value="${p%:*}" label="${p##*:}"
      [[ -n "${value}" && "${value}" != / ]] || continue
      printf '%s\t%s\n' "${value%/}" "${label}"
      # macOS spells /tmp and /var as /private/tmp and /private/var too.
      case "${value}" in /private/*) printf '%s\t%s\n' "${value#/private}" "${label}" ;; /tmp/*|/var/*) printf '/private%s\t%s\n' "${value%/}" "${label}" ;; esac
      real=$(cd "${value}" 2>/dev/null && pwd -P) && [[ "${real}" != "${value}" ]] && printf '%s\t%s\n' "${real}" "${label}"
    done
    printf '%s\t%s\n' "$(hostname 2>/dev/null)" "<host>"
    printf '%s\t%s\n' "$(hostname -s 2>/dev/null)" "<host>"
    printf '%s\t%s\n' "${USER:-}" "<user>"
    [[ "${LOGNAME:-}" != "${USER:-}" ]] && printf '%s\t%s\n' "${LOGNAME:-}" "<user>"
  } | awk -F'\t' 'length($1) >= 3' >"${out}"
}

# Stack mode: the stack's install steps, and msa_env, mindstone and gateway_cmd against the gateway container.
if [[ "${INSTALL_MODE}" == stack ]]; then
  # shellcheck source=lib/stack.sh
  source "${HERE}/lib/stack.sh"
fi

# ---------------------------------------------------------------- teardown ----
teardown() {
  local rc=$?
  set +eu
  # Back to the terminal: an exit inside a redirected command (interruptible) would otherwise
  # send teardown's output into that command's log.
  exec 1>&7 2>&8
  # Nothing interrupts cleanup: a second Ctrl-C (or a closed terminal) is ignored until it's done.
  trap '' INT TERM HUP
  trap - EXIT
  echo
  log "${c_bold}cleaning up, please wait${c_reset} (Ctrl-C is ignored until teardown finishes; exit ${rc}${FATAL:+: ${FATAL}})"
  if [[ -n "${CURRENT_STEP}" ]] && ! grep -q "^${CURRENT_STEP}	FAIL" "${STEPS_TSV}" 2>/dev/null; then
    record "${CURRENT_STEP}" FAIL "(interrupted in this step)" "${LOG_DIR}" "${FATAL:-exit ${rc}}"
  fi

  stop_ent_stub
  if [[ "${COMPOSE_STARTED}" == 1 || -d "${COMPOSE_DIR}" ]] && [[ -f "${OVERRIDE_FILE}" ]]; then
    compose logs --no-color --timestamps console >"${LOG_DIR}/console.log" 2>&1
    compose logs --no-color --timestamps mongodb >"${LOG_DIR}/mongodb.log" 2>&1
    compose down -v --remove-orphans --timeout 10 >>"${LOG_DIR}/teardown.log" 2>&1
  fi
  # Stack mode: the logs, `install-stack.sh --uninstall`, then this project's volumes (lib/stack.sh).
  [[ "${INSTALL_MODE}" == stack ]] && stack_teardown
  # Belt and braces: anything still labelled with our project (the X2 image check's container too), and only that.
  local ids
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null)
  [[ -n "${ids}" ]] && docker rm -f ${ids} >>"${LOG_DIR}/teardown.log" 2>&1
  ids=$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null)
  [[ -n "${ids}" ]] && docker volume rm ${ids} >>"${LOG_DIR}/teardown.log" 2>&1
  docker network rm "${PROJECT}_default" >/dev/null 2>&1
  if [[ "${UAT_KEEP_IMAGE:-0}" != 1 ]]; then
    for img in ${HARNESS_IMAGES}; do
      docker image inspect "${img}" >/dev/null 2>&1 && docker image rm "${img}" >>"${LOG_DIR}/teardown.log" 2>&1
    done
  fi

  if [[ -d "${MSA_DIR}" ]]; then
    cp "${MSA_DIR}/.runtime/mindstone/gateway/gateway.log" "${LOG_DIR}/gateway.log" 2>/dev/null
    if [[ -x "${MSA_DIR}/node_modules/.bin/mindstone" ]]; then
      mindstone gateway stop >>"${LOG_DIR}/teardown.log" 2>&1
    fi
    local pidfile="${MSA_DIR}/.runtime/mindstone/gateway/gateway.pid" pid
    if [[ -f "${pidfile}" ]]; then
      pid=$(cat "${pidfile}" 2>/dev/null)
      # Only if that PID is still our gateway: a stale file's PID may belong to anything by now.
      if [[ "${pid}" =~ ^[0-9]+$ ]] && ps -o command= -p "${pid}" 2>/dev/null | grep -qF "${MSA_DIR}"; then
        kill "${pid}" 2>/dev/null
      fi
    fi
  fi
  # Any gateway still on our port that runs out of our scratch dir (a Console restart can respawn it).
  if [[ -n "${GW_PORT}" ]] && command -v lsof >/dev/null 2>&1; then
    for pid in $(lsof -nP -t -iTCP:"${GW_PORT}" -sTCP:LISTEN 2>/dev/null); do
      if ps -o command= -p "${pid}" 2>/dev/null | grep -qF "${SCRATCH}"; then kill "${pid}" 2>/dev/null; fi
    done
  fi
  # COMPATIBILITY (MSA refs whose install.sh writes a fixed /tmp status file, F-MSA-1):
  # removed only if this run created it.
  if [[ "${TMP_STATUS_PREEXISTED}" == 0 && -f "${INSTALL_STATUS_TMP}" ]]; then
    rm -f "${INSTALL_STATUS_TMP}" && echo "removed ${INSTALL_STATUS_TMP} (created by this run)" >>"${LOG_DIR}/teardown.log"
  fi

  if [[ "${STARTED}" == 1 && -d "${EVIDENCE}" ]]; then
    # X1, the secret gate: first the checker's own positive controls (a checker that can't find a
    # planted secret can't vouch for anything), then the evidence, before scrubbing, so a leak is a
    # FAIL, not hidden.
    local sources=() line
    while IFS= read -r line; do sources+=("$line"); done < <(secret_sources)
    node "${HERE}/lib/secret-check.selftest.mjs" >"${LOG_DIR}/secret-check-selftest.log" 2>&1
    local st_rc=$?
    node "${HERE}/lib/secret-check.mjs" "${EVIDENCE}" "${sources[@]}" >"${SCRATCH}/secret-check.out" 2>&1
    local sc_rc=$?
    cp "${SCRATCH}/secret-check.out" "${LOG_DIR}/secret-check.log" 2>/dev/null
    if [[ "${st_rc}" != 0 ]]; then
      record X1 FAIL "the secret checker failed its own self-test" "${LOG_DIR}/secret-check-selftest.log" "$(tail -n 1 "${LOG_DIR}/secret-check-selftest.log")"
    else
      case "${sc_rc}" in
        0) record X1 PASS "no secret in the evidence (self-test controls all found; evidence clean)" "${LOG_DIR}/secret-check.log" \
             "$(tail -n 1 "${LOG_DIR}/secret-check-selftest.log"); $(tail -n 1 "${SCRATCH}/secret-check.out")" ;;
        1) record X1 FAIL "a secret was found in the evidence" "${LOG_DIR}/secret-check.log" "$(head -n 4 "${SCRATCH}/secret-check.out" | tr '\n' ' ')" ;;
        *) record X1 FAIL "the secret check couldn't run" "${LOG_DIR}/secret-check.log" "$(tail -n 1 "${SCRATCH}/secret-check.out")" ;;
      esac
    fi
    node "${HERE}/lib/scrub.mjs" "${EVIDENCE}" "${sources[@]}" >>"${LOG_DIR}/teardown.log" 2>&1
  fi

  if [[ "${UAT_KEEP_SCRATCH:-0}" == 1 ]]; then
    log "UAT_KEEP_SCRATCH=1: scratch kept at ${SCRATCH}"
  elif [[ -n "${SCRATCH}" && -d "${SCRATCH}" ]]; then
    rm -rf "${SCRATCH}" 2>/dev/null || { chmod -R u+w "${SCRATCH}" 2>/dev/null; rm -rf "${SCRATCH}"; }
  fi

  if [[ "${STARTED}" == 1 ]]; then
    # X4: nothing left behind (what the run was asked to keep doesn't count).
    local n_cont n_vol img one scratch_left port_left stub_left console_left=no leftovers=()
    n_cont=$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null | wc -l | tr -d ' ')
    n_vol=$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null | wc -l | tr -d ' ')
    img=removed
    for one in ${HARNESS_IMAGES}; do docker image inspect "${one}" >/dev/null 2>&1 && img=present; done
    scratch_left=$([[ -e "${SCRATCH}" ]] && echo yes || echo no)
    port_left=$([[ -n "${GW_PORT}" ]] && ! port_free "${GW_PORT}" && echo yes || echo no)
    stub_left=$({ [[ -n "${ENT_STUB_PORT}" ]] && ! port_free "${ENT_STUB_PORT}"; } || { [[ "${ENT_STUB_PID}" =~ ^[0-9]+$ ]] && kill -0 "${ENT_STUB_PID}" 2>/dev/null; } && echo yes || echo no)
    # The stack publishes the Console's port itself (natively compose down frees it with the containers, as above).
    [[ "${INSTALL_MODE}" == stack && -n "${CONSOLE_PORT}" ]] && ! port_free "${CONSOLE_PORT}" && console_left=yes
    {
      echo "containers: ${n_cont}"; echo "volumes: ${n_vol}"; echo "image ${HARNESS_IMAGES// /, }: ${img}"
      echo "scratch exists: ${scratch_left}"; echo "gateway port ${GW_PORT:-none} listening: ${port_left}"
      [[ "${INSTALL_MODE}" == stack ]] && echo "Console port ${CONSOLE_PORT:-none} listening: ${console_left}"
      echo "J11 stub (port ${ENT_STUB_PORT:-none}) still running: ${stub_left}"
    } >"${EVIDENCE}/cleanup.txt" 2>/dev/null
    [[ "${n_cont}" == 0 ]] || leftovers+=("${n_cont} containers")
    [[ "${n_vol}" == 0 ]] || leftovers+=("${n_vol} volumes")
    [[ "${img}" == removed || "${UAT_KEEP_IMAGE:-0}" == 1 ]] || leftovers+=("the image")
    [[ "${scratch_left}" == no || "${UAT_KEEP_SCRATCH:-0}" == 1 ]] || leftovers+=("the scratch dir")
    [[ "${port_left}" == no ]] || leftovers+=("a listener on ${GW_PORT}")
    [[ "${console_left}" == no ]] || leftovers+=("a listener on ${CONSOLE_PORT}")
    [[ "${stub_left}" == no ]] || leftovers+=("the J11 stub Azure endpoint (port ${ENT_STUB_PORT})")
    if [[ ${#leftovers[@]} -eq 0 ]]; then
      record X4 PASS "cleanup: nothing left behind" "${EVIDENCE}/cleanup.txt" "$(tr '\n' ';' <"${EVIDENCE}/cleanup.txt")"
    else
      record X4 FAIL "cleanup left: ${leftovers[*]}" "${EVIDENCE}/cleanup.txt"
    fi

    # X3: no host paths, user name or host name in the posted evidence.
    local pairs
    pairs=$(mktemp "${TMPDIR:-/tmp}/uat-redact.XXXXXX")
    write_redaction_pairs "${pairs}"
    if node "${HERE}/lib/redact-host.mjs" "${EVIDENCE}" "${pairs}" >"${LOG_DIR}/redact-host.log" 2>&1; then
      record X3 PASS "no host paths, user or host name in the evidence (redacted)" "${LOG_DIR}/redact-host.log" "$(tail -n 1 "${LOG_DIR}/redact-host.log")"
    else
      record X3 FAIL "host details left in the evidence" "${LOG_DIR}/redact-host.log"
    fi
    summary "${rc}"
    local gate_rc=$?
    # The summary itself goes through the same redaction (its rows already did).
    node "${HERE}/lib/redact-host.mjs" "${EVIDENCE}" "${pairs}" >>"${LOG_DIR}/teardown.log" 2>&1
    rm -f "${pairs}"
    # An interrupted run exits 130, whatever the gate says.
    [[ "${rc}" == 130 || "${FATAL}" == interrupted* ]] && exit 130
    exit "${gate_rc}"
  fi
  exit "${rc}"
}

# summary <rc>: prints every row and the gate; returns 0 only if the gate passed.
summary() {
  local rc="$1" id status title ev note reasons=() count row_status
  echo
  log "summary: MindStone-Agent@${MSA_REF}  mindstone-console@${CONSOLE_REF}  install ${INSTALL_MODE}  (run ${RUN_ID}, $(elapsed "${T0}"))"
  echo
  printf '  %-7s %-4s %s\n' STATUS ID STEP
  if [[ -f "${STEPS_TSV}" ]]; then
    while IFS=$'\t' read -r id status title ev note || [[ -n "${id}" ]]; do
      printf '  %s%-7s%s %-4s %s\n' "$(colour_for "$status")" "$status" "${c_reset}" "$id" "$title"
      [[ -n "$note" ]] && printf '               %s%s%s\n' "${c_dim}" "$note" "${c_reset}"
      [[ -n "$ev" ]] && printf '               %s%s%s\n' "${c_dim}" "$ev" "${c_reset}"
    done <"${STEPS_TSV}"
  fi
  # The gate: every required row exactly once and PASS; no unknown rows; Playwright exit 0; run exit 0;
  # an unmodified harness (or an explicit, flagged override); no self-test sabotage.
  # row_reasons <steps...>: why those rows don't all pass (missing, duplicated, or not PASS).
  row_reasons() {
    local rid cnt st
    for rid in "$@"; do
      cnt=$(awk -F'\t' -v id="$rid" '$1==id' "${STEPS_TSV}" 2>/dev/null | wc -l | tr -d ' ')
      st=$(awk -F'\t' -v id="$rid" '$1==id{print $2; exit}' "${STEPS_TSV}" 2>/dev/null)
      if [[ "${cnt}" == 0 ]]; then printf '%s\n' "${rid} MISSING"
      elif [[ "${cnt}" != 1 ]]; then printf '%s\n' "${rid} x${cnt}"
      elif [[ "${st}" != PASS ]]; then printf '%s\n' "${rid} ${st}"
      fi
    done
  }
  local common=() gate_only=() demo_only=() line
  while IFS=$'\t' read -r id _ || [[ -n "${id}" ]]; do
    [[ -z "${id}" ]] && continue
    [[ " ${REQUIRED_STEPS} ${OPTIONAL_STEPS} " == *" ${id} "* ]] || common+=("unknown row ${id}")
  done <"${STEPS_TSV}"
  # Playwright's exit: a non-zero exit counts against a verdict unless every failed test is a step that verdict
  # leaves out, failed on its own errors (J10, J11 and J12 for the DEMO SUBSET; for the gate, J10 without
  # UAT_EXPECT_PERSONA_BUILDER=1, J11 without UAT_EXPECT_ENTERPRISE=1 and J12 without UAT_EXPECT_SETTINGS_PARITY=1).
  if [[ "${PW_RC}" != 0 ]]; then
    pw_explained_by "${PW_RC}" "${EVIDENCE}/playwright/results.json" "${LOG_DIR}/gate-rows.log" ${GATE_UNCOUNTED} || gate_only+=("playwright exit ${PW_RC}")
    pw_explained_by "${PW_RC}" "${EVIDENCE}/playwright/results.json" "${LOG_DIR}/gate-rows.log" ${DEMO_UNCOUNTED} || demo_only+=("playwright exit ${PW_RC}")
  fi
  [[ "${rc}" == 0 ]] || common+=("harness exit ${rc}${FATAL:+ (${FATAL})}")
  # A step that couldn't put back what it changed (lib/journey.ts recordRestoreFailure) fails both verdicts, even
  # when that step itself is uncounted: the steps after it ran on changed settings.
  while IFS= read -r line; do [[ -n "${line}" ]] && common+=("not put back by ${line}"); done < <(restore_failures "${EVIDENCE}/restore-failures.tsv")
  [[ -n "${UAT_SELFTEST_BLANK_MESSAGES:-}" && "${UAT_SELFTEST_BLANK_MESSAGES}" != 0 ]] && common+=("self-test sabotage on (UAT_SELFTEST_BLANK_MESSAGES=${UAT_SELFTEST_BLANK_MESSAGES})")
  # Stalls (lib/journey.ts recordStall): a request or page load that never answered. Their steps are
  # FAIL already; this says, at a glance, that the run hit the environment, and never lets it pass.
  # A stall in a step a verdict leaves out (J10, J11 or J12, see above) is listed, but doesn't count against that verdict.
  local stalls_n=0 stalls_line="none" n
  if [[ -s "${EVIDENCE}/stalls.tsv" ]]; then
    stalls_n=$(grep -c . "${EVIDENCE}/stalls.tsv")
    stalls_line="${stalls_n}: $(awk -F'\t' '{printf "%s%s %s", (NR>1 ? "; " : ""), $1, $2}' "${EVIDENCE}/stalls.tsv")"
    n=$(stalls_counted "${EVIDENCE}/stalls.tsv" ${GATE_UNCOUNTED})
    [[ "${n}" == 0 ]] || gate_only+=("${n} stall(s)")
    n=$(stalls_counted "${EVIDENCE}/stalls.tsv" ${DEMO_UNCOUNTED})
    [[ "${n}" == 0 ]] || demo_only+=("${n} stall(s)")
  fi

  # Provenance, checked again at the end: the harness must not change during the run either.
  local hash_end status_end
  hash_end=$(harness_hash)
  status_end=$(git -C "${CONSOLE_HARNESS_ROOT}" status --porcelain -- "${HARNESS_REL}" 2>/dev/null || echo "not a git checkout")
  [[ -n "${status_end}" ]] && HARNESS_DIRTY=1
  [[ "${hash_end}" == "${HARNESS_HASH_START}" ]] || { HARNESS_DIRTY=1; status_end="${status_end}${status_end:+$'\n'}(harness files changed during the run)"; }
  if [[ "${HARNESS_DIRTY}" == 1 && "${UAT_ALLOW_DIRTY_HARNESS:-0}" != 1 ]]; then
    common+=("harness tree dirty (set UAT_ALLOW_DIRTY_HARNESS=1 to override, flagged in SUMMARY)")
  fi
  local demo_reasons=()
  while IFS= read -r line; do [[ -n "${line}" ]] && reasons+=("${line}"); done < <(row_reasons ${REQUIRED_STEPS})
  while IFS= read -r line; do [[ -n "${line}" ]] && demo_reasons+=("${line}"); done < <(row_reasons ${DEMO_STEPS})
  if [[ ${#common[@]} -gt 0 ]]; then reasons+=("${common[@]}"); demo_reasons+=("${common[@]}"); fi
  if [[ ${#gate_only[@]} -gt 0 ]]; then reasons+=("${gate_only[@]}"); fi
  if [[ ${#demo_only[@]} -gt 0 ]]; then demo_reasons+=("${demo_only[@]}"); fi
  # J10, J11 and J12, each on its own line: its row, and whether this run's gate counts it.
  local j10_status j10_line
  j10_status=$(awk -F'\t' '$1=="J10"{print $2; exit}' "${STEPS_TSV}" 2>/dev/null)
  j10_line="J10 persona builder (Console): ${j10_status:-MISSING}; $([[ "${EXPECT_PERSONA_BUILDER}" == 1 ]] && echo "in the gate (UAT_EXPECT_PERSONA_BUILDER=1)" || echo "not in the gate (set UAT_EXPECT_PERSONA_BUILDER=1 to require it)"); never in the DEMO SUBSET"
  local j11_status j11_line
  j11_status=$(awk -F'\t' '$1=="J11"{print $2; exit}' "${STEPS_TSV}" 2>/dev/null)
  j11_line="J11 enterprise endpoint (Azure OpenAI / Foundry): ${j11_status:-MISSING}; $([[ "${EXPECT_ENTERPRISE}" == 1 ]] && echo "in the gate (UAT_EXPECT_ENTERPRISE=1)" || echo "not in the gate (set UAT_EXPECT_ENTERPRISE=1 to require it)"); never in the DEMO SUBSET"
  local j12_status j12_line
  j12_status=$(awk -F'\t' '$1=="J12"{print $2; exit}' "${STEPS_TSV}" 2>/dev/null)
  j12_line="J12 settings parity (every setup choice on Settings): ${j12_status:-MISSING}; $([[ "${EXPECT_SETTINGS_PARITY}" == 1 ]] && echo "in the gate (UAT_EXPECT_SETTINGS_PARITY=1)" || echo "not in the gate (set UAT_EXPECT_SETTINGS_PARITY=1 to require it)"); never in the DEMO SUBSET"

  if [[ -f "${EVIDENCE}/findings.md" ]]; then
    echo; log "findings (the READMEs followed literally, and product findings the journey recorded):"; sed 's/^/  /' "${EVIDENCE}/findings.md"
  fi
  if [[ -f "${EVIDENCE}/deviations.md" ]]; then
    echo; log "harness deviations from the READMEs:"; sed 's/^/  /' "${EVIDENCE}/deviations.md"
  fi
  echo
  log "cleanup: $(tr '\n' ';' <"${EVIDENCE}/cleanup.txt" 2>/dev/null)"
  log "setup flow: $(cut -f2 "${EVIDENCE}/journey-flow.txt" 2>/dev/null || echo 'not detected')"
  if [[ "${stalls_n}" == 0 ]]; then
    log "stalls: none"
  else
    log "${c_red}stalls: ${stalls_line}${c_reset} (environment stalls, not wrong answers; each is still a FAIL)"
  fi
  log "harness: $(git -C "${CONSOLE_HARNESS_ROOT}" rev-parse --short HEAD 2>/dev/null) sha256 ${hash_end:0:16}… $([[ "${HARNESS_DIRTY}" == 1 ]] && echo DIRTY || echo clean)"
  log "evidence: ${EVIDENCE}"
  local gate demo override=""
  [[ "${HARNESS_DIRTY}" == 1 && "${UAT_ALLOW_DIRTY_HARNESS:-0}" == 1 ]] && override=" (DIRTY HARNESS OVERRIDE)"
  if [[ ${#reasons[@]} -eq 0 ]]; then
    gate="PASS${override}"
    log "${c_green}GATE: PASS${override}${c_reset} (all ${REQUIRED_STEPS// /, } passed)"
  else
    gate="NOT PASSED${override}: ${reasons[*]}"
    log "${c_red}GATE: NOT PASSED${override}${c_reset} (${reasons[*]})"
  fi
  # The demo subset, on its own line: a J3/J5/J9 regression can't hide behind J7/J8.
  if [[ ${#demo_reasons[@]} -eq 0 ]]; then
    demo="PASS${override}"
    log "${c_green}DEMO SUBSET (J1–J6, J9 + S/C/X): PASS${override}${c_reset}"
  else
    demo="NOT PASSED${override}: ${demo_reasons[*]}"
    log "${c_red}DEMO SUBSET (J1–J6, J9 + S/C/X): NOT PASSED${override}${c_reset} (${demo_reasons[*]})"
  fi
  log "$(colour_for "${j10_status:-MISSING}")${j10_line}${c_reset}"
  log "$(colour_for "${j11_status:-MISSING}")${j11_line}${c_reset}"
  log "$(colour_for "${j12_status:-MISSING}")${j12_line}${c_reset}"
  local ran_by="${UAT_RAN_BY:-unnamed (set UAT_RAN_BY)}"
  local fingerprint
  fingerprint=$(printf '%s@%s' "${USER:-?}" "$(hostname 2>/dev/null)" | shasum -a 256 2>/dev/null | cut -c1-12)
  {
    echo "# Journey UAT ${RUN_ID}"
    echo
    echo "MindStone-Agent \`${MSA_REF}\` ($(grep '^msa_sha=' "${EVIDENCE}/run.env" 2>/dev/null | cut -d= -f2)), mindstone-console \`${CONSOLE_REF}\` ($(grep '^console_sha=' "${EVIDENCE}/run.env" 2>/dev/null | cut -d= -f2)); provider $(grep '^provider=' "${EVIDENCE}/run.env" 2>/dev/null | cut -d= -f2) $(grep '^provider_model=' "${EVIDENCE}/run.env" 2>/dev/null | cut -d= -f2); duration $(elapsed "${T0}")."
    echo
    if [[ "${INSTALL_MODE}" == stack ]]; then
      echo "Install mode: **stack** (\`UAT_INSTALL=stack\`): MindStone-Agent's \`install-stack.sh\` $([[ -n "${UAT_STACK_INSTALLER_FILE:-}" ]] && echo "from a local file (\`UAT_STACK_INSTALLER_FILE\`), not the raw URL" || echo "from \`${STACK_INSTALLER_URL}\`") with \`--ref ${STACK_MSA_INSTALL_REF} --console-ref ${STACK_CONSOLE_INSTALL_REF}\`$([[ "${STACK_PIN}" != 0 ]] && echo " (\`${MSA_REF}\` and \`${CONSOLE_REF}\` as the run started: installed at exactly these commits)"): the gateway, the Console and MongoDB in one Compose project (\`${PROJECT}\`), MindStone-Agent README install guide path A."
    else
      echo "Install mode: **native** (\`UAT_INSTALL\` unset): MindStone-Agent's \`install.sh\` at \`${MSA_REF}\` on this host, and the Console at \`${CONSOLE_REF}\` from \`mindstone/docker-compose.yml\`."
    fi
    echo
    echo "**GATE: ${gate}**"
    echo
    echo "**DEMO SUBSET (J1–J6, J9 + S/C/X): ${demo}**"
    echo
    echo "**${j10_line}.**"
    echo
    echo "**${j11_line}.**"
    echo
    echo "**${j12_line}.**"
    echo
    echo "Setup flow driven: **$(cut -f2 "${EVIDENCE}/journey-flow.txt" 2>/dev/null || echo 'not detected (J2 did not get that far)')** (\`$(cut -f1 "${EVIDENCE}/journey-flow.txt" 2>/dev/null || echo none)\`)."
    echo
    if [[ "${stalls_n}" == 0 ]]; then
      echo "Stalls: none."
    else
      echo "**Stalls: ${stalls_line}** (a request or page load that never answered: an environment stall, not a wrong answer; each is still a FAIL)"
    fi
    if [[ "${HARNESS_DIRTY}" == 1 && "${UAT_ALLOW_DIRTY_HARNESS:-0}" == 1 ]]; then
      echo
      echo "**UAT_ALLOW_DIRTY_HARNESS=1: this run used a MODIFIED harness (see Provenance). Its result is not evidence for #106.**"
    fi
    if [[ -n "${UAT_SELFTEST_BLANK_MESSAGES:-}" && "${UAT_SELFTEST_BLANK_MESSAGES}" != 0 ]]; then
      echo
      echo "**UAT_SELFTEST_BLANK_MESSAGES=${UAT_SELFTEST_BLANK_MESSAGES}: harness self-test run; message bodies were blanked on purpose.**"
    fi
    echo
    echo "## Provenance"
    echo
    echo "- harness commit: \`$(git -C "${CONSOLE_HARNESS_ROOT}" rev-parse HEAD 2>/dev/null || echo unknown)\`"
    echo "- NODE_OPTIONS: empty (the harness refuses to run with it set)"
    [[ -n "${UAT_EXPECT_FLOW:-}" ]] && echo "- expected setup flow: \`${UAT_EXPECT_FLOW}\` (UAT_EXPECT_FLOW; J2 fails on a mismatch)"
    echo "- persona builder expected: $([[ "${EXPECT_PERSONA_BUILDER}" == 1 ]] && echo '**yes** (`UAT_EXPECT_PERSONA_BUILDER=1`: J10 is in the gate and FAILs without "Build a persona")' || echo 'no (`UAT_EXPECT_PERSONA_BUILDER` unset: J10 is PENDING without "Build a persona", and not in the gate)')"
    echo "- enterprise endpoint expected:  $([[ "${EXPECT_ENTERPRISE}" == 1 ]] && echo '**yes** (`UAT_EXPECT_ENTERPRISE=1`: J11 is in the gate and FAILs without the enterprise form)' || echo 'no (`UAT_EXPECT_ENTERPRISE` unset: J11 is PENDING without the enterprise form, and not in the gate)')"
    echo "- settings parity expected: $([[ "${EXPECT_SETTINGS_PARITY}" == 1 ]] && echo '**yes** (`UAT_EXPECT_SETTINGS_PARITY=1`: J12 is in the gate and FAILs without "Your setup" on Settings)' || echo 'no (`UAT_EXPECT_SETTINGS_PARITY` unset: J12 is PENDING without "Your setup" on Settings, and not in the gate)')"
    [[ "${MSA_REPO}" != "${MSA_REPO_DEFAULT}" ]] && echo "- **MindStone-Agent repo overridden:** \`${MSA_REPO}\` (install.sh from \`${MSA_RAW}\`)"
    [[ "${MSA_RAW}" != "https://raw.githubusercontent.com/MindStone-Agent/MindStone-Agent" && "${MSA_REPO}" == "${MSA_REPO_DEFAULT}" ]] && echo "- **install.sh source overridden:** \`${MSA_RAW}\`"
    [[ "${CONSOLE_REPO}" != "https://github.com/MindStone-Agent/mindstone-console.git" ]] && echo "- **mindstone-console repo overridden:** \`${CONSOLE_REPO}\`"
    echo "- harness sha256 (${HARNESS_REL}): \`${HARNESS_HASH_START}\` at start, \`${hash_end}\` at end"
    if [[ "${HARNESS_DIRTY}" == 1 ]]; then
      echo "- harness tree: **DIRTY**. \`git status --porcelain -- ${HARNESS_REL}\`:"
      echo; echo '```'; printf '%s\n' "${HARNESS_STATUS_START}" "${status_end}" | awk 'NF && !seen[$0]++'; echo '```'
    else
      echo "- harness tree: clean (\`git status --porcelain -- ${HARNESS_REL}\` is empty)"
    fi
    echo "- ran by: ${ran_by}; user@host fingerprint \`${fingerprint}\` (sha256 prefix; the user and host names are redacted from the evidence)"
    echo
    echo "| Status | ID | Step | Evidence | Note |"
    echo "|---|---|---|---|---|"
    awk -F'\t' '{printf "| %s | %s | %s | %s | %s |\n", $2, $1, $3, $4, $5}' "${STEPS_TSV}" 2>/dev/null
    [[ -f "${EVIDENCE}/findings.md" ]] && { echo; echo "## Findings (READMEs and product)"; echo; cat "${EVIDENCE}/findings.md"; }
    [[ -f "${EVIDENCE}/deviations.md" ]] && { echo; echo "## Harness deviations"; echo; cat "${EVIDENCE}/deviations.md"; }
    echo; echo "## Cleanup"; echo; sed 's/^/- /' "${EVIDENCE}/cleanup.txt" 2>/dev/null
  } >"${EVIDENCE}/SUMMARY.md"
  [[ "${gate}" == PASS ]]
}

# ------------------------------------------------------------------ start ----
need git; need node; need npm; need docker; need curl; need openssl
exec 7>&1 8>&2 # the original stdout/stderr, for teardown
mkdir -p "${EVIDENCE}" "${LOG_DIR}" "${EVIDENCE}/screens"
: >"${STEPS_TSV}"
STARTED=1
trap teardown EXIT
trap 'FATAL="interrupted"; exit 130' INT TERM HUP
mkdir -p "${SCRATCH}" "${SCRATCH_HOME}" "${SCRATCH}/tmp"
(umask 077; mkdir -p "${SECRETS_DIR}")

# Provenance first: what harness is this?
HARNESS_STATUS_START=$(git -C "${CONSOLE_HARNESS_ROOT}" status --porcelain -- "${HARNESS_REL}" 2>/dev/null || echo "not a git checkout")
HARNESS_HASH_START=$(harness_hash)
[[ -n "${HARNESS_STATUS_START}" ]] && HARNESS_DIRTY=1
if [[ "${HARNESS_DIRTY}" == 1 ]]; then
  if [[ "${UAT_ALLOW_DIRTY_HARNESS:-0}" == 1 ]]; then
    log "${c_yellow}${c_bold}the harness has local changes; UAT_ALLOW_DIRTY_HARNESS=1, so the run goes on, flagged in SUMMARY${c_reset}"
  else
    log "${c_red}${c_bold}the harness has local changes: this run can't reach GATE: PASS (UAT_ALLOW_DIRTY_HARNESS=1 overrides, flagged)${c_reset}"
  fi
fi

GW_PORT="$(pick_port)" || die "no free port in ${PORT_MIN}-${PORT_MAX}"
CONSOLE_PORT="$(pick_port "${GW_PORT}")" || die "no second free port in ${PORT_MIN}-${PORT_MAX}"
if [[ "$(uname -s)" == Linux && "${INSTALL_MODE}" == native ]]; then # the stack publishes the gateway on 127.0.0.1 itself
  MINDSTONE_AGENT_GATEWAY_HOST_OVERRIDE="${UAT_GATEWAY_BRIDGE_HOST:-172.17.0.1}"
  GW_HOST="${MINDSTONE_AGENT_GATEWAY_HOST_OVERRIDE}"
else
  MINDSTONE_AGENT_GATEWAY_HOST_OVERRIDE=""
  GW_HOST="127.0.0.1"
fi
GW_URL="http://${GW_HOST}:${GW_PORT}"
# Stack mode: the commits the stack is installed at, resolved now (lib/stack.sh).
[[ "${INSTALL_MODE}" == stack ]] && stack_pin_refs
CONSOLE_URL="http://localhost:${CONSOLE_PORT}"

{
  echo "run_id=${RUN_ID}"; echo "msa_ref=${MSA_REF}"; echo "console_ref=${CONSOLE_REF}"
  echo "install_mode=${INSTALL_MODE}"
  [[ "${INSTALL_MODE}" == stack ]] && { echo "stack_installer=${UAT_STACK_INSTALLER_FILE:-${STACK_INSTALLER_URL}}"; echo "stack_dir=${STACK_DIR}"; echo "stack_ollama_base_url=${STACK_OLLAMA_BASE_URL}"; }
  echo "msa_repo=${MSA_REPO}"; echo "console_repo=${CONSOLE_REPO}"
  echo "compose_project=${PROJECT}"; echo "scratch=${SCRATCH}"
  echo "gateway=${GW_URL}"; echo "console=${CONSOLE_URL}"
  echo "harness_commit=$(git -C "${CONSOLE_HARNESS_ROOT}" rev-parse HEAD 2>/dev/null)"
  echo "harness_sha256=${HARNESS_HASH_START}"
  echo "harness_dirty=${HARNESS_DIRTY}"
  echo "node_options=${NODE_OPTIONS:-}"
  echo "expect_flow=${UAT_EXPECT_FLOW:-}"
  echo "expect_enterprise=${EXPECT_ENTERPRISE}"
  echo "expect_persona_builder=${EXPECT_PERSONA_BUILDER}"
  echo "expect_settings_parity=${EXPECT_SETTINGS_PARITY}"
  echo "node=$(node --version)"; echo "docker=$(docker --version 2>/dev/null)"; echo "os=$(uname -sm)"
  echo "started=$(date -u +%FT%TZ)"
} >"${EVIDENCE}/run.env"

log "journey UAT ${RUN_ID}: MindStone-Agent@${MSA_REF}, mindstone-console@${CONSOLE_REF} (install: ${INSTALL_MODE})"
log "gateway port ${GW_PORT}, Console port ${CONSOLE_PORT}, compose project ${PROJECT}"
log "scratch ${SCRATCH}"
log "evidence ${EVIDENCE}"
if [[ -n "${UAT_SELFTEST_BLANK_MESSAGES:-}" && "${UAT_SELFTEST_BLANK_MESSAGES}" != 0 ]]; then
  log "${c_red}${c_bold}SELF-TEST: message bodies will be blanked on purpose (UAT_SELFTEST_BLANK_MESSAGES=${UAT_SELFTEST_BLANK_MESSAGES}); J4 must FAIL${c_reset}"
  deviation "SELF-TEST: \`UAT_SELFTEST_BLANK_MESSAGES=${UAT_SELFTEST_BLANK_MESSAGES}\` hides $([[ "${UAT_SELFTEST_BLANK_MESSAGES}" == assistant ]] && echo "the agent's rendered replies (the user's bubbles stay)" || echo 'every rendered message body'), to prove J4/J6's on-screen checks fire. This run can't pass."
fi
if [[ "${INSTALL_MODE}" == native ]]; then
  deviation "Ports: the gateway listens on ${GW_PORT} (\`MINDSTONE_AGENT_GATEWAY_PORT\` in its environment, plus \`gateway.port\` **and \`gateway.host\` (${GW_HOST})** written to config.json so the CLI's health checks agree) and the Console on ${CONSOLE_PORT} (a compose override with its own container names and image tag), not 19789/3080; \`MINDSTONE_GATEWAY_URL\` in the Console's \`.env\` points at ${GW_PORT}."
  deviation "HOME is a scratch dir for every MindStone-Agent command, so the README's \`\$HOME/.mindstone-admin-credential\` lands in scratch; inherited MINDSTONE_*/PI_* variables are dropped."
  deviation "The README's \`curl … | bash\` runs \`install.sh\` downloaded from ${MSA_RAW}/${MSA_REF} with \`--dir <scratch> --no-link --branch ${MSA_REF} --repo ${MSA_REPO}\`$([[ "${MSA_REPO}" == "${MSA_REPO_DEFAULT}" ]] && echo ' (the default repo, passed explicitly)')."
  deviation "The READMEs put secrets on command lines (\`curl -H \"Authorization: Bearer \$(cat …)\"\`; the Console's \`sed \"s|^KEY=.*|KEY=\$(…)|\"\`). The harness sends curl headers from 0600 files (\`curl -H @file\`) and writes each \`.env\` secret with \`lib/env-set.mjs\`, which reads the value from a 0600 file, so no secret is in any process's argv."
  if [[ "$(uname -s)" == Linux ]]; then
    deviation "Linux: the gateway runs with \`MINDSTONE_AGENT_GATEWAY_HOST=${GW_HOST}\` (MSA README 5.5; \`UAT_GATEWAY_BRIDGE_HOST\`), on every start and restart."
  fi
else
  deviation "Stack mode (\`UAT_INSTALL=stack\`, MindStone-Agent README install guide path A): the README's \`curl -fsSL …/install-stack.sh | bash -s -- …\` runs $([[ -n "${UAT_STACK_INSTALLER_FILE:-}" ]] && echo "a local install-stack.sh (\`UAT_STACK_INSTALLER_FILE\`) piped to bash" || echo "the installer from ${STACK_INSTALLER_URL}")$([[ "${STACK_PIN}" != 0 ]] && echo ", pinned to the commits ${MSA_REF} and ${CONSOLE_REF} named at the start of the run (\`UAT_STACK_PIN=0\` passes the refs as given)") with \`--dir <scratch>/stack --ref ${STACK_MSA_INSTALL_REF} --console-ref ${STACK_CONSOLE_INSTALL_REF} --admin-email ${UAT_ADMIN_EMAIL:-uat-admin@example.com} --admin-name \"UAT Admin\"\` and, on bash's environment, \`CONSOLE_PORT=${CONSOLE_PORT} MINDSTONE_GATEWAY_PORT=${GW_PORT} MINDSTONE_PROJECT=${PROJECT}\` (not 3080/19789/mindstone)$([[ -n "${UAT_STACK_OLLAMA_BASE_URL:-}" ]] && echo " and \`OLLAMA_BASE_URL=${STACK_OLLAMA_BASE_URL}\`")."
  deviation "Stack mode: every \`docker compose\` the harness runs names its project and file (\`-p ${PROJECT} --project-directory <scratch>/stack -f <scratch>/stack/compose.yml\`) instead of the README's \`cd ~/.mindstone && docker compose …\`; the CLI runs as the README's \`docker compose exec gateway ./scripts/mindstone <command>\`, and gateway restarts are \`docker compose restart gateway\`."
  deviation "Stack mode: the gateway's data, transcripts, Pi sessions and log are in its container's volumes, so the journey reads copies, taken with \`docker compose cp\` and \`docker compose logs\` just before each read (\`lib/stack-files.js\`); J12's USER.md restore removes the file with \`docker compose exec\`."
  deviation "Stack mode, J11: the gateway's container reaches the stub as host.docker.internal, not loopback, and MindStone-Agent #126 allows plain http to loopback only. So the stub speaks https with a per-run test CA, and the harness adds \`MINDSTONE_ENTERPRISE_PRIVATE_HOSTS=1\` and \`NODE_EXTRA_CA_CERTS\` (that CA, copied into the gateway's runtime volume) to the stack's gateway.env, then \`docker compose up -d gateway\` (S3). The Playwright process trusts the same CA for its own stub checks."
  deviation "Stack mode: the Console's secrets, the gateway token, the admin credential (only its sha256 on the gateway) and the admin password are generated by install-stack.sh; the harness reads them from the stack's 600 files into its own 600 files, never printed, for its probes and the secret check (X1)."
fi

# ------------------------------------------------- the model provider ------
# Decided before anything is built, so a misconfiguration fails in seconds.
PROVIDER="${UAT_PROVIDER:-auto}"
PROVIDER_MODEL="${UAT_PROVIDER_MODEL:-}"
ollama_tags() { curl -sf -m 5 "${OLLAMA_URL}/api/tags" 2>/dev/null; }
tags="$(ollama_tags || true)"
if [[ "${PROVIDER}" == auto ]]; then
  if [[ -n "${tags}" ]]; then
    picked=$(printf '%s' "${tags}" | node "${HERE}/lib/pick-ollama-model.mjs" chat "${UAT_OLLAMA_ALLOW_LOCAL:-0}" "${UAT_OLLAMA_MAX_LOCAL_GB:-8}" 2>>"${LOG_DIR}/provider.log") || picked=""
    if [[ -n "${picked}" ]]; then PROVIDER=ollama; PROVIDER_MODEL="${PROVIDER_MODEL:-${picked}}"; fi
  fi
  if [[ "${PROVIDER}" == auto ]]; then
    PROVIDER=mock
    echo
    log "${c_red}${c_bold}!!! NO MODEL PROVIDER: FALLING BACK TO THE GATEWAY'S MOCK ROUTE !!!${c_reset}"
    log "${c_red}${c_bold}!!! J2, J4 and J6 will be MOCK, and a MOCK run can never pass the gate. !!!${c_reset}"
    log "${c_red}(no :cloud model at ${OLLAMA_URL}; set UAT_PROVIDER, or UAT_OLLAMA_ALLOW_LOCAL=1 to use a local model)${c_reset}"
    echo
  fi
fi
case "${PROVIDER}" in
  ollama)
    [[ -n "${PROVIDER_MODEL}" ]] || die "UAT_PROVIDER=ollama needs UAT_PROVIDER_MODEL (auto picks one; an explicit provider doesn't)"
    [[ -n "${tags}" ]] || die "no Ollama answering at ${OLLAMA_URL} (UAT_OLLAMA_URL)"
    printf '%s' "${tags}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s).models||[];process.exit(m.some(x=>x.name===process.argv[1])?0:1)})' "${PROVIDER_MODEL}" \
      || die "Ollama at ${OLLAMA_URL} doesn't list ${PROVIDER_MODEL}; the harness never pulls models"
    ;;
  ollama-cloud)
    [[ -n "${UAT_PROVIDER_KEY_FILE:-}" && -r "${UAT_PROVIDER_KEY_FILE}" ]] || die "UAT_PROVIDER=ollama-cloud needs UAT_PROVIDER_KEY_FILE (a readable file holding the key)"
    [[ -n "${PROVIDER_MODEL}" ]] || die "UAT_PROVIDER=ollama-cloud needs UAT_PROVIDER_MODEL" ;;
  mock)
    PROVIDER_MODEL="mindstone/mock"
    deviation "MOCK: no model provider, so the gateway's mock route is set through the Console's admin API (PATCH /api/mindstone/admin/config/routing), not the UI; J2, J4 and J6 report MOCK and the gate can't pass." ;;
  *) die "unknown UAT_PROVIDER ${PROVIDER} (auto | ollama | ollama-cloud | mock)" ;;
esac
if [[ "${PROVIDER}" == ollama && "${OLLAMA_URL}" != "http://127.0.0.1:11434" && "${OLLAMA_URL}" != "http://localhost:11434" ]]; then
  deviation "Ollama: the provider step's Server address is set to ${OLLAMA_URL}/v1 (UAT_OLLAMA_URL), not the preset's default."
fi

# The embedding model the #102 memory step will use: one that's already pulled (small,
# read-only use, so no UAT_OLLAMA_ALLOW_LOCAL). Never pulled unless UAT_OLLAMA_ALLOW_PULL=1.
pick_embed() { printf '%s' "${tags}" | node "${HERE}/lib/pick-ollama-model.mjs" embed 2>>"${LOG_DIR}/provider.log" || true; }
if [[ -n "${UAT_OLLAMA_EMBED_MODEL:-}" ]]; then
  EMBED_MODEL="${UAT_OLLAMA_EMBED_MODEL}"
  printf '%s' "${tags}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s||"{}").models||[];process.exit(m.some(x=>x.name===process.argv[1]||x.name===process.argv[1]+":latest")?0:1)})' "${EMBED_MODEL}" \
    || { log "UAT_OLLAMA_EMBED_MODEL=${EMBED_MODEL} isn't pulled in ${OLLAMA_URL}"; EMBED_MODEL=""; }
elif [[ -n "${tags}" ]]; then
  EMBED_MODEL="$(pick_embed)"
fi
if [[ -z "${EMBED_MODEL}" && "${UAT_OLLAMA_ALLOW_PULL:-0}" == 1 && -n "${tags}" ]]; then
  log "no embedding model pulled; UAT_OLLAMA_ALLOW_PULL=1, so pulling nomic-embed-text into ${OLLAMA_URL}"
  deviation "UAT_OLLAMA_ALLOW_PULL=1: the harness pulled nomic-embed-text into the Ollama at ${OLLAMA_URL}."
  curl -sf -m 900 -X POST "${OLLAMA_URL}/api/pull" -H 'Content-Type: application/json' -d '{"model":"nomic-embed-text","stream":false}' >>"${LOG_DIR}/provider.log" 2>&1 || true
  tags="$(ollama_tags || true)"
  EMBED_MODEL="$(pick_embed)"
fi
[[ -n "${EMBED_MODEL}" ]] || log "${c_yellow}no embedding model in Ollama: J3 will FAIL (pull nomic-embed-text first, or set UAT_OLLAMA_ALLOW_PULL=1)${c_reset}"

# The other default model J12 switches to on Settings: a cloud model Ollama lists that actually answers (a listed
# cloud model can be retired upstream). Each candidate, smallest first, gets one short chat; the first reply with
# text wins. "none" when none answers, so J12 keeps the model and says so; unset for other providers (J12 then
# picks another cloud model the Model step offers). UAT_ALT_MODEL names the one candidate instead (probed the same
# way; "none" skips the probe).
# probe_chat <model>: "ok" when the model answers one short chat with text, else why not (the body is built by
# node, so no model name is ever spliced into JSON).
probe_chat() {
  node -e 'process.stdout.write(JSON.stringify({model:process.argv[1],stream:false,messages:[{role:"user",content:"Say hello in one short sentence."}]}))' "$1" \
    | curl -s -m 60 "${OLLAMA_URL}/api/chat" -H 'Content-Type: application/json' --data-binary @- 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.message&&j.message.content?"ok":`no text: ${String(j.error||"empty reply").slice(0,160)}`)}catch{process.stdout.write("no JSON answer")}})' 2>/dev/null || true
}
ALT_MODEL="${UAT_ALT_MODEL:-}"
if [[ "${PROVIDER}" == ollama && "${ALT_MODEL}" != none ]]; then
  if [[ -n "${ALT_MODEL}" ]]; then alt_candidates="${ALT_MODEL}"; alt_from="UAT_ALT_MODEL"; else
    alt_candidates=$(printf '%s' "${tags}" | node "${HERE}/lib/pick-ollama-model.mjs" alt "${PROVIDER_MODEL}" 2>>"${LOG_DIR}/provider.log" || true)
    alt_from="each other \`:cloud\` model Ollama lists, smallest first"
  fi
  ALT_MODEL=none
  while IFS= read -r candidate; do
    [[ -n "${candidate}" ]] || continue
    answer=$(probe_chat "${candidate}")
    echo "J12 alternate model ${candidate}: ${answer:-no answer}" >>"${LOG_DIR}/provider.log"
    if [[ "${answer}" == ok ]]; then ALT_MODEL="${candidate}"; break; fi
  done <<<"${alt_candidates}"
  deviation "J12: to pick the other default model it switches to on Settings, the harness sent one short chat (\"Say hello in one short sentence.\") to ${alt_from}, until one answered: ${ALT_MODEL} (\`logs/provider.log\`)."
fi
[[ "${PROVIDER}" == ollama ]] && deviation "J12: when the memory step's Test times out on a pulled embedding model that isn't loaded yet (the product finding F-MSA-147, MindStone-Agent #147: the gateway's 10 s embed timeout is shorter than the load, and its abort cancels it), the harness loads that model through Ollama's own \`/api/embed\` (read-only; nothing is pulled) and presses Test again. The finding is recorded when it happens."
# J12 changes the embedding model to another one that is pulled: the embedding models Ollama lists (a Test that
# fails for one of these is the product's failure, not a missing model).
EMBED_MODELS_PULLED=""
[[ -n "${tags}" ]] && EMBED_MODELS_PULLED=$(printf '%s' "${tags}" | node "${HERE}/lib/pick-ollama-model.mjs" embeds 2>>"${LOG_DIR}/provider.log" | tr '\n' ' ' | sed 's/ *$//' || true)
{ echo "provider=${PROVIDER}"; echo "provider_model=${PROVIDER_MODEL}"; echo "embed_model=${EMBED_MODEL:-none}"; echo "embed_models_pulled=${EMBED_MODELS_PULLED}"; echo "alt_model=${ALT_MODEL:-unset}"; } >>"${EVIDENCE}/run.env"
log "model provider: ${PROVIDER}${PROVIDER_MODEL:+ (${PROVIDER_MODEL})}; embedding model: ${EMBED_MODEL:-none}; J12's other model: ${ALT_MODEL:-unset}"

if [[ "${INSTALL_MODE}" == stack ]]; then
  # The whole stack from install-stack.sh (MindStone-Agent README path A): rows S0-S5 and C0-C3 (lib/stack.sh).
  stack_install_steps
fi
# The native install, rows S0-S5 and C0-C3 (MindStone-Agent #106). Not indented, to keep its history readable.
if [[ "${INSTALL_MODE}" == native ]]; then
# =============================================================================
# MindStone-Agent README, "Install guide for AI agents"
# =============================================================================
log "MindStone-Agent: README steps 0-5"

# --- step 0: requirements -----------------------------------------------------
CURRENT_STEP=S0
if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)'; then
  record S0 PASS "MSA step 0: requirements (git, Node >= 22.19, Docker)" "" "node $(node --version)"
else
  record S0 FAIL "MSA step 0: requirements" "" "Node $(node --version) is older than 22.19"; die "Node too old"
fi
CURRENT_STEP=""

# --- step 1: install ----------------------------------------------------------
CURRENT_STEP=S1
t=$(date +%s)
curl -fsSL "${MSA_RAW}/${MSA_REF}/install.sh" -o "${SCRATCH}/install.sh" \
  || { record S1 FAIL "MSA step 1: install" "" "couldn't download install.sh at ${MSA_REF}"; die "no install.sh"; }
cp "${SCRATCH}/install.sh" "${EVIDENCE}/msa-install.sh"
[[ -e "${INSTALL_STATUS_TMP}" ]] || TMP_STATUS_PREEXISTED=0
log "  installing MindStone-Agent (npm install, Pi build, CLI build) - several minutes"
if ! interruptible msa_env bash "${SCRATCH}/install.sh" --dir "${MSA_DIR}" --repo "${MSA_REPO}" --no-link --branch "${MSA_REF}" \
     >"${LOG_DIR}/msa-install.log" 2>&1; then
  tail_to "${LOG_DIR}/msa-install.log" "${LOG_DIR}/msa-install.tail.log" 60
  record S1 FAIL "MSA step 1: install.sh --dir --no-link --branch ${MSA_REF}" "${LOG_DIR}/msa-install.tail.log"
  die "install.sh failed"
fi
MSA_SHA=$(git -C "${MSA_DIR}" rev-parse --short HEAD)
echo "msa_sha=${MSA_SHA}" >>"${EVIDENCE}/run.env"
cp "${MSA_DIR}/README.md" "${EVIDENCE}/msa-README.md"
MSA_README="${EVIDENCE}/msa-README.md"
if grep -q "${INSTALL_STATUS_TMP}" "${SCRATCH}/install.sh"; then
  finding F-MSA-1 "MindStone-Agent \`install.sh\` writes its status check to the fixed path \`${INSTALL_STATUS_TMP}\` (not \`\$TMPDIR\`, not the install dir): two installs at once overwrite each other's output, and on a shared host another user's file blocks it."
fi
# README check: `mindstone status` exits 0 and prints paths under <checkout>/.runtime/
if mindstone status >"${LOG_DIR}/msa-status.log" 2>&1 && grep -qF "${MSA_DIR}/.runtime/" "${LOG_DIR}/msa-status.log"; then
  record S1 PASS "MSA step 1: install.sh --dir --no-link --branch ${MSA_REF} (${MSA_SHA}); \`mindstone status\` shows <checkout>/.runtime/" "${LOG_DIR}/msa-install.log" "$(elapsed "$t")"
else
  record S1 FAIL "MSA step 1: \`mindstone status\` check" "${LOG_DIR}/msa-status.log"
  die "mindstone status failed"
fi
CURRENT_STEP=""

# --- step 2: onboard, or skip it for the Console (#108) ---------------------------
# The demo path is Console-first: no `mindstone onboard`. Since #108 the README's
# step 2 offers two paths, (a) `mindstone onboard` in a terminal and (b) skip it
# and do guided setup in the Console, and install.sh creates a not-onboarded
# runtime config (routing.mode placeholder). S2 checks exactly that: step 2(b)
# exists, and the fresh config says placeholder.
CURRENT_STEP=S2
CONFIG="${MSA_DIR}/.runtime/mindstone/config.json"
step2=$(awk '/^### 2\./{on=1; print; next} on && /^### /{exit} on' "${MSA_README}")
printf '%s\n' "${step2}" >"${LOG_DIR}/msa-readme-step2.txt"
s2_problems=()
if printf '%s' "${step2}" | grep -q '(b)' && printf '%s' "${step2}" | grep -qi 'console'; then has_2b=1; else has_2b=0; s2_problems+=("README step 2 has no (b) Console-first path"); fi
routing_mode="(no config)"
if [[ -f "${CONFIG}" ]]; then
  routing_mode=$(node -e 'try{const c=require(process.argv[1]);process.stdout.write(String(c.routing&&c.routing.mode||"(unset)"))}catch{process.stdout.write("(unreadable)")}' "${CONFIG}")
  [[ "${routing_mode}" == placeholder ]] || s2_problems+=("the fresh config's routing.mode is ${routing_mode}, not placeholder")
else
  s2_problems+=("install.sh left no .runtime/mindstone/config.json")
fi
if [[ ${#s2_problems[@]} -eq 0 ]]; then
  record S2 PASS "MSA step 2(b): skip onboarding for the Console; install.sh made a not-onboarded config (routing.mode placeholder)" "${LOG_DIR}/msa-readme-step2.txt"
else
  record S2 FAIL "MSA step 2(b): no Console-first path without \`mindstone onboard\`" "${LOG_DIR}/msa-readme-step2.txt" "$(IFS=';'; echo "${s2_problems[*]}")"
  finding F-MSA-2 "MindStone-Agent README step 2 and install.sh don't give a Console-first install (MindStone-Agent #108): $(IFS=';'; echo "${s2_problems[*]}"). The README should offer step 2(b), skip \`mindstone onboard\` and do guided setup in the Console, and install.sh should create \`.runtime/mindstone/config.json\` with \`routing.mode: placeholder\`, so step 5.3's merge has a file to read."
fi
if [[ ! -f "${CONFIG}" ]]; then
  # COMPATIBILITY (MSA refs before #108): install.sh made no config, so step 5.3 would fail.
  # scripts/init-runtime.sh (not in those READMEs) creates the same not-onboarded config.
  log "  COMPAT: running scripts/init-runtime.sh (MSA refs before #108) to create a not-onboarded runtime"
  init_runtime() { (cd "${MSA_DIR}" && msa_env ./scripts/init-runtime.sh); }
  interruptible init_runtime >"${LOG_DIR}/msa-init-runtime.log" 2>&1 \
    || die "scripts/init-runtime.sh failed"
  [[ -f "${CONFIG}" ]] || die "scripts/init-runtime.sh made no config.json"
  deviation "COMPATIBILITY (MSA refs before #108): install.sh made no runtime config, so the harness ran \`scripts/init-runtime.sh\` (not in the README) to get the same not-onboarded config (routing placeholder) and do setup in the Console."
fi
CURRENT_STEP=""

# --- step 3: start the gateway -------------------------------------------------
CURRENT_STEP=S3
# The README only knows 19789. The listener port comes from the env
# (MINDSTONE_AGENT_GATEWAY_PORT, set by msa_env); gateway.port and gateway.host keep the CLI's health checks honest.
(cd "$(dirname "${CONFIG}")" && GW_PORT="${GW_PORT}" GW_HOST="${GW_HOST}" node -e '
  const fs = require("fs"), f = "config.json", c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.gateway = { ...(c.gateway || {}), port: Number(process.env.GW_PORT), host: process.env.GW_HOST };
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");')
if grep -q 19789 "${MSA_README}" && ! grep -q MINDSTONE_AGENT_GATEWAY_PORT "${MSA_README}"; then
  finding F-MSA-3 "MindStone-Agent README hard-codes port 19789 (steps 3 and 5) and never says how to change it. The listener takes \`MINDSTONE_AGENT_GATEWAY_PORT\` from the environment (and \`mindstone gateway restart\` needs the same variable every time), while \`status\`/\`restart\` health checks read \`gateway.port\` from config.json; both have to agree."
fi
deviation "The gateway is started (and restarted) with \`MINDSTONE_ENTERPRISE_PRIVATE_HOSTS=1\` in its environment: the gateway host's own switch (MindStone-Agent #126) that lets an enterprise endpoint be a loopback or private host, which J11's stub Azure endpoint on 127.0.0.1 needs. A gateway without #126 ignores it."
gateway_cmd start >"${LOG_DIR}/gateway-start.log" 2>&1 || true
ok=0
for _ in $(seq 1 60); do
  if curl -sf -m 2 "${GW_URL}/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [[ "${ok}" == 1 ]]; then
  record S3 PASS "MSA step 3: \`mindstone gateway start\`; /health answers" "${LOG_DIR}/gateway-start.log" "gateway /health on port ${GW_PORT}"
else
  tail_to "${MSA_DIR}/.runtime/mindstone/gateway/gateway.log" "${LOG_DIR}/gateway.tail.log" 80
  record S3 FAIL "MSA step 3: gateway /health" "${LOG_DIR}/gateway.tail.log"
  die "gateway didn't come up"
fi
CURRENT_STEP=""

# --- step 5: set up for the Console --------------------------------------------
CURRENT_STEP=S5
s5_notes=""
(
  set -e
  cd "${MSA_DIR}/.runtime/mindstone"
  # 5.1 the gateway token
  mkdir -p -m 700 secrets
  (umask 077; openssl rand -hex 32 > secrets/gateway-token)
  # 5.2 the admin credential, outside .runtime (HOME is the scratch home)
  export HOME="${SCRATCH_HOME}"
  [ -e "$HOME/.mindstone-admin-credential" ] || (umask 077; openssl rand -hex 32 > "$HOME/.mindstone-admin-credential")
  # 5.3 merge the settings into config.json, exactly as the README has it
  SHA="shasum -a 256"; command -v shasum >/dev/null 2>&1 || SHA="sha256sum"
  HASH=$(printf %s "$(cat "$HOME/.mindstone-admin-credential")" | ${SHA} | cut -d' ' -f1) \
  node -e '
    const h = process.env.HASH || "";
    if (!/^[0-9a-f]{64}$/.test(h) || h.startsWith("e3b0c442")) throw new Error("no admin credential hash: check the credential file and shasum");
    const fs = require("fs"), f = "config.json", c = JSON.parse(fs.readFileSync(f, "utf8"));
    c.gateway = c.gateway || {};
    c.gateway.auth = { mode: "token", tokenFile: "secrets/gateway-token" };
    c.gateway.http = { ...(c.gateway.http || {}), chatCompletions: { enabled: true } };
    c.gateway.admin = { ...(c.gateway.admin || {}), tokenSha256: h };
    fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");'
) >"${LOG_DIR}/msa-step5.log" 2>&1 || { record S5 FAIL "MSA step 5.1-5.3: token, admin credential, config merge" "${LOG_DIR}/msa-step5.log"; die "step 5 failed"; }
(umask 077; cp "${SCRATCH_HOME}/.mindstone-admin-credential" "${SECRETS_DIR}/admin-credential") # for probes and scrubbing; README deletes the original later
write_header_files

# 5.4 check the route. The finding is about the README's step 5.4 text only.
mindstone doctor >"${LOG_DIR}/msa-doctor.log" 2>&1 || true
if grep -i routing "${LOG_DIR}/msa-doctor.log" | grep -qi placeholder; then
  s5_notes="doctor shows routing.mode placeholder, as expected before Console setup"
fi
step54=$(awk '/^### 5\./{on=1; next} on && /^### /{exit} on' "${MSA_README}" | awk '/^4\. /{on=1} on && /^5\. /{exit} on')
printf '%s\n' "${step54}" >"${LOG_DIR}/msa-readme-step5.4.txt"
if printf '%s' "${step54}" | grep -q 'mindstone config --section routing' \
   && ! printf '%s' "${step54}" | grep -qiE 'console-first|expected'; then
  finding F-MSA-4 "MindStone-Agent README step 5.4 says that if \`mindstone doctor\` shows \`routing.mode\` \`placeholder\`, run \`mindstone config --section routing\` (interactive), and doesn't say that placeholder is expected on a Console-first install, where the Console's guided setup sets the route."
fi
# 5.5 macOS: host.docker.internal needs nothing; Linux: bridge address (handled by msa_env).
# 5.6 restart, since the gateway was started with `gateway start`
gateway_cmd restart >"${LOG_DIR}/gateway-restart.log" 2>&1 || true
for _ in $(seq 1 60); do curl -sf -m 2 "${GW_URL}/health" >/dev/null 2>&1 && break; sleep 1; done
# The README's checks: with the token 200, without 401 (headers from files, not argv).
with=$(curl -s -o /dev/null -w '%{http_code}' -H @"${SECRETS_DIR}/h-auth" "${GW_URL}/v1/models")
without=$(curl -s -o /dev/null -w '%{http_code}' "${GW_URL}/v1/models")
# HARNESS probe (not in the README): the admin API is on and reports "not onboarded".
admin_status=$(curl -s -o "${SCRATCH}/admin-status.json" -w '%{http_code}' \
  -H @"${SECRETS_DIR}/h-auth" -H @"${SECRETS_DIR}/h-admin" \
  -H "x-mindstone-user-id: uat-harness" -H "x-mindstone-user-role: admin" \
  "${GW_URL}/admin/status" 2>/dev/null || true)
deviation "An extra check the README doesn't have: \`GET /admin/status\` on the gateway (as a harness admin), to record that the gateway starts *not onboarded*. J7 and J8 also probe gateway admin routes that #104/#105 will add (GET only) and require 404."
onboarded=$(node -e 'try{const s=require(process.argv[1]);process.stdout.write(String(s.onboarded))}catch{process.stdout.write("unknown")}' "${SCRATCH}/admin-status.json" 2>/dev/null)
if [[ "${with}" == 200 && "${without}" == 401 ]]; then
  record S5 PASS "MSA step 5: token file, admin credential outside .runtime, config merge, restart; /v1/models 200 with token, 401 without" "${LOG_DIR}/msa-step5.log" \
    "admin /status ${admin_status}, onboarded=${onboarded}${s5_notes:+; ${s5_notes}}"
else
  tail_to "${MSA_DIR}/.runtime/mindstone/gateway/gateway.log" "${LOG_DIR}/gateway.tail.log" 80
  record S5 FAIL "MSA step 5 checks: /v1/models with token ${with} (want 200), without ${without} (want 401)" "${LOG_DIR}/gateway.tail.log"
  die "step 5 checks failed"
fi
echo "gateway_onboarded_before_console=${onboarded}" >>"${EVIDENCE}/run.env"
CURRENT_STEP=""

# =============================================================================
# mindstone-console README, "Install guide for AI agents"
# =============================================================================
log "mindstone-console: README steps 0-4"
CURRENT_STEP=C0
docker compose version >/dev/null 2>&1 || { record C0 FAIL "Console step 0: Docker Compose v2" ""; die "no docker compose"; }
code=$(curl -s -o /dev/null -w '%{http_code}' -H @"${SECRETS_DIR}/h-auth" "${GW_URL}/v1/models")
if [[ "${code}" == 200 ]]; then
  record C0 PASS "Console step 0: requirements; the gateway check prints 200" ""
else
  record C0 FAIL "Console step 0: gateway check printed ${code}" ""; die "gateway check"
fi
CURRENT_STEP=""

# --- step 1: get the code --------------------------------------------------------
CURRENT_STEP=C1
if ! git clone --quiet --branch "${CONSOLE_REF}" "${CONSOLE_REPO}" "${CONSOLE_DIR}" >"${LOG_DIR}/console-clone.log" 2>&1; then
  record C1 FAIL "Console step 1: git clone --branch ${CONSOLE_REF}" "${LOG_DIR}/console-clone.log"; die "clone failed"
fi
CONSOLE_SHA=$(git -C "${CONSOLE_DIR}" rev-parse --short HEAD)
echo "console_sha=${CONSOLE_SHA}" >>"${EVIDENCE}/run.env"
cp "${CONSOLE_DIR}/README.md" "${EVIDENCE}/console-README.md"
record C1 PASS "Console step 1: clone ${CONSOLE_REF} (${CONSOLE_SHA}); use only mindstone/" "${EVIDENCE}/console-README.md"
if grep -q '3080' "${EVIDENCE}/console-README.md" && grep -q 'container_name' "${COMPOSE_DIR}/docker-compose.yml" \
   && ! grep -qiE 'override|COMPOSE_PROJECT_NAME' "${EVIDENCE}/console-README.md"; then
  finding F-CON-1 "The Console README and \`mindstone/docker-compose.yml\` fix the port (127.0.0.1:3080), the container names (\`mindstone-console\`, \`mindstone-console-mongo\`) and the image tag, and the README never says how to change them; a second Console on one host (or a UAT next to a real one) needs an undocumented compose override. The README's step 3 check also names those fixed containers."
fi
CURRENT_STEP=""

# --- step 2: configure ------------------------------------------------------------
# As the README, except that every secret is written from a 0600 file by env-set.mjs
# instead of on sed's command line (see deviations).
CURRENT_STEP=C2
(
  set -e
  cd "${COMPOSE_DIR}"
  cp .env.example .env
  chmod 600 .env
  for k in CREDS_KEY JWT_SECRET JWT_REFRESH_SECRET; do
    new_secret "env-${k}" -hex 32
    node "${HERE}/lib/env-set.mjs" .env "${k}" "${SECRETS_DIR}/env-${k}"
  done
  new_secret env-CREDS_IV -hex 16
  node "${HERE}/lib/env-set.mjs" .env CREDS_IV "${SECRETS_DIR}/env-CREDS_IV"
  node "${HERE}/lib/env-set.mjs" .env MINDSTONE_GATEWAY_TOKEN "${MSA_DIR}/.runtime/mindstone/secrets/gateway-token"
  node "${HERE}/lib/env-set.mjs" .env MINDSTONE_ADMIN_TOKEN "${SCRATCH_HOME}/.mindstone-admin-credential"
  # 2.1 MINDSTONE_GATEWAY_URL (not a secret): the harness port, or the Linux bridge address.
  sed -i.bak "s|^MINDSTONE_GATEWAY_URL=.*|MINDSTONE_GATEWAY_URL=http://$([[ "$(uname -s)" == Linux ]] && echo "${GW_HOST}" || echo host.docker.internal):${GW_PORT}/v1|" .env
  rm -f .env.bak
  # 2.2 UID and GID, so the containers can write their data folders.
  printf 'UID=%s\nGID=%s\n' "$(id -u)" "$(id -g)" >>.env
) >"${LOG_DIR}/console-step2.log" 2>&1 || { record C2 FAIL "Console step 2: configure .env" "${LOG_DIR}/console-step2.log"; die ".env"; }
[[ "$(uname -s)" == Linux ]] || deviation "Console step 2.2 says UID/GID are for Linux only; the harness sets them on macOS too (it's what the compose file reads)."
count=$(grep -cE '^(CREDS_KEY|CREDS_IV|JWT_SECRET|JWT_REFRESH_SECRET|MINDSTONE_GATEWAY_TOKEN|MINDSTONE_ADMIN_TOKEN)=.+' "${COMPOSE_DIR}/.env" || true)
if [[ "${count}" == 6 ]]; then
  record C2 PASS "Console step 2: .env from .env.example, secrets generated, gateway values from files, UID/GID; the grep check prints 6" "${LOG_DIR}/console-step2.log"
else
  record C2 FAIL "Console step 2: the grep check printed ${count}, want 6" "${LOG_DIR}/console-step2.log"; die ".env check"
fi
CURRENT_STEP=""

# --- step 3: start it ---------------------------------------------------------------
CURRENT_STEP=C3
cat >"${OVERRIDE_FILE}" <<YAML
# HARNESS override (not a tracked file): its own container names, image tag and
# port, so it never collides with a real Console on this host.
services:
  console:
    container_name: ${PROJECT}-console
    image: ${PROJECT}-console:local
    ports: !override
      - "127.0.0.1:${CONSOLE_PORT}:3080"
  mongodb:
    container_name: ${PROJECT}-mongo
YAML
cp "${OVERRIDE_FILE}" "${EVIDENCE}/compose.uat-override.yml"
# The compose file comes from the ref under test, and teardown's `compose down -v` removes what it
# names: refuse anything that isn't this project's before bringing it up.
if ! compose config --format json 2>"${LOG_DIR}/compose-config.err" | node "${HERE}/lib/compose-guard.mjs" "${PROJECT}" "${CONSOLE_DIR}" >"${LOG_DIR}/compose-guard.log" 2>&1; then
  record C3 FAIL "Console step 3: the compose project isn't safe to run and tear down" "${LOG_DIR}/compose-guard.log" "$(grep -v '^compose-guard' "${LOG_DIR}/compose-guard.log" | head -3 | tr '\n' ' ')"
  die "compose-guard refused the compose file"
fi
log "  docker compose up -d --build (the first build takes several minutes)"
t=$(date +%s)
(cd "${COMPOSE_DIR}" && mkdir -p data-node uploads logs)
COMPOSE_STARTED=1
if ! interruptible compose up -d --build >"${LOG_DIR}/console-build.log" 2>&1; then
  tail_to "${LOG_DIR}/console-build.log" "${LOG_DIR}/console-build.tail.log" 80
  record C3 FAIL "Console step 3: docker compose up -d --build" "${LOG_DIR}/console-build.tail.log"
  die "compose up failed"
fi
build_time=$(elapsed "$t")
ok=0
for _ in $(seq 1 180); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:${CONSOLE_PORT}")" == 200 ]] && { ok=1; break; }
  sleep 2
done
compose ps >"${LOG_DIR}/compose-ps.txt" 2>&1
running=$(compose ps --status running --services 2>/dev/null | sort | tr '\n' ' ')
if [[ "${ok}" == 1 && "${running}" == *console* && "${running}" == *mongodb* ]]; then
  record C3 PASS "Console step 3: docker compose up -d --build; both services running; / answers 200" "${LOG_DIR}/compose-ps.txt" "build+start ${build_time}; $(tail -n 1 "${LOG_DIR}/compose-guard.log")"
else
  compose logs --no-color console 2>&1 | tail -n 80 >"${LOG_DIR}/console.tail.log"
  record C3 FAIL "Console step 3: running services [${running}], / 200: ${ok}" "${LOG_DIR}/console.tail.log"
  die "Console didn't start"
fi
CURRENT_STEP=""
fi # the native install, S0-C3

# X2: the built image carries no secrets: no /app/mindstone (its .env), /app/.env empty or
# absent, no non-empty .env files anywhere under /app. A throwaway container, labelled with
# our project so teardown removes it if anything goes wrong; no network.
CURRENT_STEP=X2
# Stack mode (X2_GIT_CONTEXT=1): the image is built from the Console's git URL, a clean clone, and BuildKit doesn't
# apply .dockerignore to a git context, so /app/mindstone is there with the tracked files only (finding F-STACK-2).
# There, what that .dockerignore rule keeps out is checked instead: mindstone/'s .env and its live data.
if docker run --rm --network none --label "com.docker.compose.project=${PROJECT}" --entrypoint sh \
  -e X2_GIT_CONTEXT="$([[ "${INSTALL_MODE}" == stack ]] && echo 1 || echo 0)" "${CONSOLE_IMAGE}" -c '
  fail=0
  if [ "$X2_GIT_CONTEXT" = 1 ] && [ -d /app/mindstone ]; then
    echo "present: /app/mindstone (git-URL build context; .dockerignore not applied): $(ls -A /app/mindstone | tr "\n" " ")"
    for f in .env data-node uploads logs; do
      if [ -e "/app/mindstone/$f" ]; then echo "FOUND: /app/mindstone/$f"; fail=1; else echo "absent: /app/mindstone/$f"; fi
    done
  elif [ -e /app/mindstone ]; then echo "FOUND: /app/mindstone"; fail=1; else echo "absent: /app/mindstone"; fi
  if [ -s /app/.env ]; then echo "FOUND: /app/.env is not empty"; fail=1; else echo "empty or absent: /app/.env"; fi
  found=$(find /app -name node_modules -prune -o -type f \( -name ".env" -o -name ".env.*" \) ! -name "*.example" -size +0c -print 2>/dev/null)
  if [ -n "$found" ]; then echo "FOUND non-empty env files:"; echo "$found"; fail=1; else echo "no non-empty .env files under /app (node_modules skipped)"; fi
  exit $fail' >"${LOG_DIR}/image-check.log" 2>&1; then
  if grep -q '^present: /app/mindstone' "${LOG_DIR}/image-check.log"; then
    record X2 PASS "the Console image holds no secrets (stack: /app/mindstone from the git clone has no .env, data-node, uploads or logs; /app/.env empty or absent)" "${LOG_DIR}/image-check.log" \
      "$(grep '^present:' "${LOG_DIR}/image-check.log")"
    finding F-STACK-2 "The stack builds the Console from its git URL (\`deploy/docker/compose.yml\`, \`CONSOLE_BUILD_CONTEXT\` unset), and BuildKit doesn't apply the Console's \`.dockerignore\` to a git context, so its image has what that file keeps out of the native image: \`/app/mindstone\` (tracked files only: $(grep '^present:' "${LOG_DIR}/image-check.log" | sed 's/^.*: //')), and \`docs\`, \`e2e\`, hidden files, \`Dockerfile\`. A git clone has no \`.env\` or live data, so no secret is baked in (X2 checks that), but the image isn't the one the \`.dockerignore\` describes."
  else
    record X2 PASS "the Console image holds no secrets (/app/mindstone absent, /app/.env empty or absent)" "${LOG_DIR}/image-check.log"
  fi
else
  record X2 FAIL "the Console image may hold secrets" "${LOG_DIR}/image-check.log" "$(grep FOUND "${LOG_DIR}/image-check.log" | head -3 | tr '\n' ' ')"
fi
CURRENT_STEP=""

# --- step 4: create the admin account ------------------------------------------------
if [[ "${INSTALL_MODE}" == stack ]]; then
  stack_admin_step # install-stack.sh made the admin; README A3's sign-in check (lib/stack.sh)
else
CURRENT_STEP=C4
ADMIN_EMAIL="${UAT_ADMIN_EMAIL:-uat-admin@example.com}"
(umask 077; openssl rand -base64 24 | tr -d '/+=' | cut -c1-24 >"${SECRETS_DIR}/admin-password")
# The password reaches create-user on stdin (printf is a shell builtin: never in argv).
if printf '%s\n' "$(cat "${SECRETS_DIR}/admin-password")" | compose exec -T console npm run create-user -- "${ADMIN_EMAIL}" "UAT Admin" uat-admin --email-verified=true \
     >"${LOG_DIR}/create-user.log" 2>&1 && grep -qi 'created' "${LOG_DIR}/create-user.log"; then
  record C4 PASS "Console step 4: create-user on stdin with -T, -- and --email-verified=true" "${LOG_DIR}/create-user.log"
else
  record C4 FAIL "Console step 4: create-user" "${LOG_DIR}/create-user.log"; die "create-user failed"
fi
# Console step 2: once the Console runs, delete the admin credential; .env is then the only copy.
rm -f "${SCRATCH_HOME}/.mindstone-admin-credential"
CURRENT_STEP=""
fi # the native C4

# =============================================================================
# The journey, in the UI only (journey.spec.ts)
# =============================================================================
log "journey: Playwright, UI only"
CURRENT_STEP=J
PW_DIR="${HERE}"
PW_NODE_PATH=""
if [[ -d "${CONSOLE_HARNESS_ROOT}/node_modules/@playwright/test" ]]; then
  PW_BIN="${CONSOLE_HARNESS_ROOT}/node_modules/.bin/playwright"
else
  # No repo install (a fresh clone): a private copy of the repo's pinned
  # @playwright/test in .pw/, found through NODE_PATH. Never touches the repo's node_modules.
  PW_VERSION=$(node -e 'try{const l=require(process.argv[1]);process.stdout.write(l.packages["node_modules/@playwright/test"].version)}catch{process.stdout.write("1.62.1")}' "${CONSOLE_HARNESS_ROOT}/package-lock.json")
  if [[ ! -d "${HERE}/.pw/node_modules/@playwright/test" ]] || \
     [[ "$(node -p 'require(process.argv[1]).version' "${HERE}/.pw/node_modules/@playwright/test/package.json" 2>/dev/null)" != "${PW_VERSION}" ]]; then
    log "  installing @playwright/test@${PW_VERSION} into ${HERE}/.pw (once)"
    mkdir -p "${HERE}/.pw"
    printf '{ "private": true }\n' >"${HERE}/.pw/package.json"
    interruptible npm --prefix "${HERE}/.pw" install --no-save --no-package-lock --no-audit --no-fund "@playwright/test@${PW_VERSION}" >"${LOG_DIR}/playwright-install.log" 2>&1 \
      || die "couldn't install @playwright/test (${LOG_DIR}/playwright-install.log)"
  fi
  PW_BIN="${HERE}/.pw/node_modules/.bin/playwright"
  PW_NODE_PATH="${HERE}/.pw/node_modules"
fi
PW_INSTALL_ARGS=(install chromium)
if [[ "$(uname -s)" == Linux ]] && { [[ "$(id -u)" == 0 ]] || sudo -n true 2>/dev/null; }; then
  PW_INSTALL_ARGS=(install --with-deps chromium) # the browser's system libraries too (CI)
fi
interruptible env NODE_PATH="${PW_NODE_PATH}" "${PW_BIN}" "${PW_INSTALL_ARGS[@]}" >>"${LOG_DIR}/playwright-install.log" 2>&1 \
  || die "playwright ${PW_INSTALL_ARGS[*]} failed (${LOG_DIR}/playwright-install.log)"

# X5: the on-screen check's own controls, in a real Chromium page (no Console needed), and the
# stall detection's (console #30): a request or page load that never answers must fail as a named STALL.
CURRENT_STEP=X5
# J11's own pieces too (offline): the stub Azure endpoint's key check and redaction, the stub-log proof, the
# PENDING decision, and the gate's rule that an ungated step's failure doesn't count (lib/enterprise.selftest.mjs).
# And J10's: its PENDING decision, the transcript judging (a private-KB hit under its persona, none under another,
# only its skill in the prompt), the persona restore and its flag's gate wiring (lib/persona-builder.selftest.mjs).
# And J12's: its PENDING decision, the parity table rule, the model pick and match, the embedding-change judgement,
# the recall index's vector sizes and its flag's gate wiring (lib/settings-parity.selftest.mjs).
x5_screen=0; x5_stall=0; x5_ent=0; x5_pb=0; x5_sp=0
NODE_PATH="${PW_NODE_PATH}" node "${HERE}/lib/screen-check.selftest.mjs" >"${LOG_DIR}/screen-check-selftest.log" 2>&1 || x5_screen=$?
NODE_PATH="${PW_NODE_PATH}" UAT_PORT_MIN="${PORT_MIN}" UAT_PORT_MAX="${PORT_MAX}" \
  node "${HERE}/lib/stall.selftest.mjs" >"${LOG_DIR}/stall-selftest.log" 2>&1 || x5_stall=$?
UAT_PORT_MIN="${PORT_MIN}" UAT_PORT_MAX="${PORT_MAX}" \
  node "${HERE}/lib/enterprise.selftest.mjs" >"${LOG_DIR}/enterprise-selftest.log" 2>&1 || x5_ent=$?
node "${HERE}/lib/persona-builder.selftest.mjs" >"${LOG_DIR}/persona-builder-selftest.log" 2>&1 || x5_pb=$?
node "${HERE}/lib/settings-parity.selftest.mjs" >"${LOG_DIR}/settings-parity-selftest.log" 2>&1 || x5_sp=$?
x5_notes="$(tail -n 1 "${LOG_DIR}/screen-check-selftest.log"); $(tail -n 1 "${LOG_DIR}/stall-selftest.log"); $(tail -n 1 "${LOG_DIR}/enterprise-selftest.log"); $(tail -n 1 "${LOG_DIR}/persona-builder-selftest.log"); $(tail -n 1 "${LOG_DIR}/settings-parity-selftest.log")"
x5_evidence="$(rel "${LOG_DIR}/screen-check-selftest.log"), $(rel "${LOG_DIR}/stall-selftest.log"), $(rel "${LOG_DIR}/enterprise-selftest.log"), $(rel "${LOG_DIR}/persona-builder-selftest.log"), $(rel "${LOG_DIR}/settings-parity-selftest.log")"
if [[ "${x5_screen}" == 0 && "${x5_stall}" == 0 && "${x5_ent}" == 0 && "${x5_pb}" == 0 && "${x5_sp}" == 0 ]]; then
  record X5 PASS "the on-screen check's self-test (a reply only in the user's bubble, or hidden, is not found), the stall self-test (no answer is a named STALL, within its timeout), J11's (the stub endpoint takes only its key, and logs none), J10's (a private KB recalled under another persona fails the isolation check) and J12's (old vectors left behind by a silent embedding change fail; the chat must run on the model chosen on Settings)" \
    "${x5_evidence}" "${x5_notes}"
else
  x5_failed=()
  [[ "${x5_screen}" == 0 ]] || x5_failed+=("the on-screen check failed its self-test")
  [[ "${x5_stall}" == 0 ]] || x5_failed+=("the stall detection failed its self-test")
  [[ "${x5_ent}" == 0 ]] || x5_failed+=("J11's pieces failed their self-test")
  [[ "${x5_pb}" == 0 ]] || x5_failed+=("J10's pieces failed their self-test")
  [[ "${x5_sp}" == 0 ]] || x5_failed+=("J12's pieces failed their self-test")
  record X5 FAIL "$(IFS=';'; echo "${x5_failed[*]}" | sed 's/;/; /g')" "${x5_evidence}" "${x5_notes}"
fi
CURRENT_STEP=J

provider_key_file=""
[[ "${PROVIDER}" == ollama-cloud ]] && provider_key_file="${UAT_PROVIDER_KEY_FILE}"

# J11: the stub Azure OpenAI endpoint (lib/azure-stub.mjs) on a port of our own range, on 127.0.0.1. It takes a
# FAKE per-run key (generated here into a 0600 file, so X1 treats it as a secret and fails the run if it reaches
# the evidence) and answers with a per-run token. Its request log (key redacted) goes to the evidence. It is
# watched as a forbidden destination for the gateway's own token and the admin credential. Stopped on exit.
# A stub that can't start doesn't stop the run: J11 says so (or is PENDING anyway without the enterprise form).
ENT_TOKEN="$(printf 'quartz-heron-%s' "$(openssl rand -hex 5)")"
ENT_DEPLOYMENT="uat-gpt-4o"
ENT_STUB_URL=""
ENT_STUB_GATEWAY_URL="" # the stub as the gateway reaches it, where that isn't ENT_STUB_URL (stack mode)
# Stack mode: https, with the per-run CA the gateway container trusts (S3, lib/stack.sh); natively plain http.
ENT_STUB_SCHEME=http
[[ "${INSTALL_MODE}" == stack ]] && ENT_STUB_SCHEME=https
(umask 077; printf 'uat-fake-azure-key-%s\n' "$(openssl rand -hex 16)" >"${SECRETS_DIR}/ent-azure-key")
if ENT_STUB_PORT="$(pick_port "${GW_PORT}" "${CONSOLE_PORT}")"; then
  UAT_ENT_STUB_PORT="${ENT_STUB_PORT}" UAT_ENT_KEY_FILE="${SECRETS_DIR}/ent-azure-key" UAT_ENT_TOKEN="${ENT_TOKEN}" \
    UAT_ENT_STUB_LOG="${LOG_DIR}/j11-azure-stub-requests.jsonl" UAT_ENT_STUB_PARENT_PID="$$" \
    UAT_ENT_FORBIDDEN_FILES="${GW_TOKEN_FILE}:${SECRETS_DIR}/admin-credential" \
    UAT_ENT_STUB_TLS_CERT="${STACK_STUB_CERT:-}" UAT_ENT_STUB_TLS_KEY="${STACK_STUB_KEY:-}" \
    node "${HERE}/lib/azure-stub.mjs" >"${LOG_DIR}/j11-azure-stub.log" 2>&1 &
  ENT_STUB_PID=$!
  for _ in $(seq 1 20); do
    curl -sf -m 2 ${STACK_CA_FILE:+--cacert "${STACK_CA_FILE}"} "${ENT_STUB_SCHEME}://127.0.0.1:${ENT_STUB_PORT}/__stub/health" >/dev/null 2>&1 \
      && { ENT_STUB_URL="${ENT_STUB_SCHEME}://127.0.0.1:${ENT_STUB_PORT}"; break; }
    kill -0 "${ENT_STUB_PID}" 2>/dev/null || break
    sleep 0.5
  done
fi
if [[ -n "${ENT_STUB_URL}" ]]; then
  log "  J11 stub Azure endpoint on port ${ENT_STUB_PORT} (fake per-run key; token ${ENT_TOKEN})"
  deviation "J11: a stub Azure OpenAI endpoint (\`lib/azure-stub.mjs\`, not part of either README) listens on 127.0.0.1:${ENT_STUB_PORT} with a fake per-run key and stands in for the enterprise's Azure resource. Its request log, key redacted, is \`logs/j11-azure-stub-requests.jsonl\`."
  if [[ "${INSTALL_MODE}" == stack ]]; then
    ENT_STUB_GATEWAY_URL="https://host.docker.internal:${ENT_STUB_PORT}"
    deviation "J11 in stack mode: the Endpoint typed in the UI is ${ENT_STUB_GATEWAY_URL}/openai/v1 (the stub over https, as the gateway's container reaches this host)."
  fi
else
  log "  ${c_yellow}J11 stub Azure endpoint didn't start (${LOG_DIR}/j11-azure-stub.log)${c_reset}"
  stop_ent_stub
fi
{ echo "ent_stub_port=${ENT_STUB_PORT}"; echo "ent_token=${ENT_TOKEN}"; } >>"${EVIDENCE}/run.env"
# Where the journey finds the gateway's files and Ollama. Stack mode: copies of the container's files
# (lib/stack-files.js), and Ollama as the gateway's container reaches it (the harness's own probes use OLLAMA_URL).
if [[ "${INSTALL_MODE}" == stack ]]; then
  PW_GATEWAY_LOG="${STACK_MIRROR}/gateway.log"
  PW_DATA_DIR="${STACK_MIRROR}/data"
  PW_OLLAMA_BASE_URL="${STACK_OLLAMA_BASE_URL}"
else
  PW_GATEWAY_LOG="${MSA_DIR}/.runtime/mindstone/gateway/gateway.log"
  PW_DATA_DIR="${MSA_DIR}/.runtime/mindstone"
  PW_OLLAMA_BASE_URL="${OLLAMA_URL}/v1"
fi
rm -f "${EVIDENCE}/journey-results.tsv" "${EVIDENCE}/journey-state.json" "${EVIDENCE}/journey-flow.txt" "${EVIDENCE}/stalls.tsv" "${EVIDENCE}/restore-failures.tsv"
set +e
(cd "${PW_DIR}" && \
  { [[ -z "${STACK_CA_FILE:-}" ]] || export NODE_EXTRA_CA_CERTS="${STACK_CA_FILE}"; } && \
  UAT_INSTALL="${INSTALL_MODE}" \
  UAT_STACK_PROJECT="$([[ "${INSTALL_MODE}" == stack ]] && echo "${PROJECT}")" \
  UAT_STACK_DIR="${STACK_DIR:-}" \
  UAT_STACK_MIRROR="${STACK_MIRROR:-}" \
  UAT_STACK_GATEWAY_DATA_DIR="${STACK_GATEWAY_DATA_DIR:-}" \
  UAT_STACK_GATEWAY_SESSIONS_DIR="${STACK_GATEWAY_SESSIONS_DIR:-}" \
  UAT_OLLAMA_HOST_URL="${OLLAMA_URL}/v1" \
  UAT_ENT_STUB_GATEWAY_URL="${ENT_STUB_GATEWAY_URL}" \
  UAT_CONSOLE_URL="${CONSOLE_URL}" \
  UAT_EVIDENCE_DIR="${EVIDENCE}" \
  UAT_ADMIN_EMAIL="${ADMIN_EMAIL}" \
  UAT_ADMIN_PASSWORD_FILE="${SECRETS_DIR}/admin-password" \
  UAT_PROVIDER="${PROVIDER}" \
  UAT_PROVIDER_MODEL="${PROVIDER_MODEL}" \
  UAT_PROVIDER_KEY_FILE="${provider_key_file}" \
  UAT_OLLAMA_BASE_URL="${PW_OLLAMA_BASE_URL}" \
  UAT_OLLAMA_EMBED_MODEL="${EMBED_MODEL}" \
  UAT_ALT_MODEL="${ALT_MODEL}" \
  UAT_OLLAMA_EMBED_MODELS="${EMBED_MODELS_PULLED}" \
  UAT_GATEWAY_URL="${GW_URL}" \
  UAT_GATEWAY_AUTH_HEADER_FILE="${SECRETS_DIR}/h-auth" \
  UAT_GATEWAY_ADMIN_HEADER_FILE="${SECRETS_DIR}/h-admin" \
  UAT_GATEWAY_LOG="${PW_GATEWAY_LOG}" \
  UAT_TRANSCRIPT_DIR="${PW_DATA_DIR}/transcripts" \
  UAT_DATA_DIR="${PW_DATA_DIR}" \
  UAT_EXPECT_ENTERPRISE="${EXPECT_ENTERPRISE}" \
  UAT_EXPECT_PERSONA_BUILDER="${EXPECT_PERSONA_BUILDER}" \
  UAT_EXPECT_SETTINGS_PARITY="${EXPECT_SETTINGS_PARITY}" \
  UAT_ENT_STUB_URL="${ENT_STUB_URL}" \
  UAT_ENT_TOKEN="${ENT_TOKEN}" \
  UAT_ENT_DEPLOYMENT="${ENT_DEPLOYMENT}" \
  UAT_ENT_KEY_FILE="${SECRETS_DIR}/ent-azure-key" \
  UAT_ENT_STUB_LOG="${LOG_DIR}/j11-azure-stub-requests.jsonl" \
  NODE_PATH="${PW_NODE_PATH}" \
  "${PW_BIN}" test --config "${PW_DIR}/playwright.config.ts") 2>&1 | tee "${LOG_DIR}/playwright.log"
PW_RC=${PIPESTATUS[0]}
set -e
stop_ent_stub
if [[ -f "${EVIDENCE}/journey-results.tsv" ]]; then
  cat "${EVIDENCE}/journey-results.tsv" >>"${STEPS_TSV}"
  [[ -z "$(tail -c 1 "${STEPS_TSV}")" ]] || echo >>"${STEPS_TSV}" # an unterminated last row stays a row
else
  record J FAIL "Playwright journey produced no results" "${LOG_DIR}/playwright.log" "exit ${PW_RC}"
fi
CURRENT_STEP=""
# Ctrl-C reaches Playwright too; when it exits on the signal, bash may not run its own INT trap.
if [[ "${PW_RC}" == 130 || "${PW_RC}" == 143 || "${PW_RC}" == 129 ]]; then
  FATAL="interrupted during the journey"
  exit 130
fi
echo "playwright_exit=${PW_RC}" >>"${EVIDENCE}/run.env"
echo "setup_flow=$(cut -f1 "${EVIDENCE}/journey-flow.txt" 2>/dev/null || echo unknown)" >>"${EVIDENCE}/run.env"
echo "finished=$(date -u +%FT%TZ)" >>"${EVIDENCE}/run.env"
echo "duration=$(elapsed "${T0}")" >>"${EVIDENCE}/run.env"
# The gate (and the exit code) is decided in teardown's summary, after the secret check.
exit 0
