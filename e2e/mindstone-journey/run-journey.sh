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
set -Eeuo pipefail

if [[ $# -lt 2 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  echo "See e2e/mindstone-journey/README.md for the environment variables."
  exit 2
fi

MSA_REF="$1"
CONSOLE_REF="$2"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONSOLE_HARNESS_ROOT="$(cd "${HERE}/../.." && pwd)"

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
SECRETS_DIR="${SCRATCH}/harness-secrets" # admin password, curl header files; never printed
OVERRIDE_FILE="${SCRATCH}/compose.uat-override.yml"
REAL_NPM_CACHE="${npm_config_cache:-${HOME}/.npm}"
INSTALL_STATUS_TMP="/tmp/mindstone-agent-install-status.txt" # install.sh's fixed path (F-MSA-1)

STEPS_TSV="${EVIDENCE}/harness-steps.tsv"
LOG_DIR="${EVIDENCE}/logs"
# Every row the gate needs, each exactly once and each PASS.
REQUIRED_STEPS="S0 S1 S2 S3 S5 C0 C1 C2 C3 C4 J1 J2 J3 J4 J5 J6 J7 J8 X1"
T0=$(date +%s)
GW_PORT=""
CONSOLE_PORT=""
COMPOSE_STARTED=0
CURRENT_STEP=""
FATAL=""
PW_RC="not run"
TMP_STATUS_PREEXISTED=1
STARTED=0

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

# record <id> <STATUS> <title> <evidence> [note]
record() {
  local id="$1" status="$2" title="$3" ev="${4:-}" note="${5:-}"
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

pick_port() {
  local p
  for ((p = PORT_MIN; p <= PORT_MAX; p++)); do
    [[ "$p" == "${1:-}" ]] && continue
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

# Compose, as the README runs it (from mindstone/), in our own project with the port override.
compose() { (cd "${COMPOSE_DIR}" && COMPOSE_PROJECT_NAME="${PROJECT}" COMPOSE_FILE="docker-compose.yml:${OVERRIDE_FILE}" docker compose "$@"); }

tail_to() { # tail_to <src> <dest> [lines]
  [[ -f "$1" ]] && tail -n "${3:-200}" "$1" >"$2" 2>/dev/null || true
}

elapsed() { local s=$(( $(date +%s) - $1 )); printf '%dm%02ds' $((s / 60)) $((s % 60)); }

# Curl header files, so no token is ever on a command line (ps shows argv).
write_header_files() {
  (
    umask 077
    printf 'Authorization: Bearer %s\n' "$(cat "${MSA_DIR}/.runtime/mindstone/secrets/gateway-token")" >"${SECRETS_DIR}/h-auth"
    printf 'x-mindstone-admin-token: %s\n' "$(cat "${SECRETS_DIR}/admin-credential")" >"${SECRETS_DIR}/h-admin"
  )
}

secret_sources() {
  printf '%s\n' "${SECRETS_DIR}" "${MSA_DIR}/.runtime/mindstone/secrets" "${COMPOSE_DIR}/.env"
  [[ -n "${UAT_PROVIDER_KEY_FILE:-}" ]] && printf '%s\n' "${UAT_PROVIDER_KEY_FILE}"
  return 0
}

# ---------------------------------------------------------------- teardown ----
teardown() {
  local rc=$?
  set +eu
  # Nothing interrupts cleanup: a second Ctrl-C (or a closed terminal) is ignored until it's done.
  trap '' INT TERM HUP
  trap - EXIT
  echo
  log "${c_bold}cleaning up, please wait${c_reset} (Ctrl-C is ignored until teardown finishes; exit ${rc}${FATAL:+: ${FATAL}})"
  if [[ -n "${CURRENT_STEP}" ]] && ! grep -q "^${CURRENT_STEP}	FAIL" "${STEPS_TSV}" 2>/dev/null; then
    record "${CURRENT_STEP}" FAIL "(interrupted in this step)" "${LOG_DIR}" "${FATAL:-exit ${rc}}"
  fi

  if [[ "${COMPOSE_STARTED}" == 1 || -d "${COMPOSE_DIR}" ]] && [[ -f "${OVERRIDE_FILE}" ]]; then
    compose logs --no-color --timestamps console >"${LOG_DIR}/console.log" 2>&1
    compose logs --no-color --timestamps mongodb >"${LOG_DIR}/mongodb.log" 2>&1
    compose down -v --remove-orphans --timeout 10 >>"${LOG_DIR}/teardown.log" 2>&1
  fi
  # Belt and braces: anything still labelled with our project, and only that.
  local ids
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null)
  [[ -n "${ids}" ]] && docker rm -f ${ids} >>"${LOG_DIR}/teardown.log" 2>&1
  ids=$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null)
  [[ -n "${ids}" ]] && docker volume rm ${ids} >>"${LOG_DIR}/teardown.log" 2>&1
  docker network rm "${PROJECT}_default" >/dev/null 2>&1
  if [[ "${UAT_KEEP_IMAGE:-0}" != 1 ]]; then
    docker image rm "${PROJECT}-console:local" >>"${LOG_DIR}/teardown.log" 2>&1
  fi

  if [[ -d "${MSA_DIR}" ]]; then
    cp "${MSA_DIR}/.runtime/mindstone/gateway/gateway.log" "${LOG_DIR}/gateway.log" 2>/dev/null
    if [[ -x "${MSA_DIR}/node_modules/.bin/mindstone" ]]; then
      mindstone gateway stop >>"${LOG_DIR}/teardown.log" 2>&1
    fi
    local pidfile="${MSA_DIR}/.runtime/mindstone/gateway/gateway.pid" pid
    if [[ -f "${pidfile}" ]]; then
      pid=$(cat "${pidfile}" 2>/dev/null)
      [[ "${pid}" =~ ^[0-9]+$ ]] && kill "${pid}" 2>/dev/null
    fi
  fi
  # Any gateway still on our port that runs out of our scratch dir (a Console restart can respawn it).
  if [[ -n "${GW_PORT}" ]] && command -v lsof >/dev/null 2>&1; then
    for pid in $(lsof -nP -t -iTCP:"${GW_PORT}" -sTCP:LISTEN 2>/dev/null); do
      if ps -o command= -p "${pid}" 2>/dev/null | grep -qF "${SCRATCH}"; then kill "${pid}" 2>/dev/null; fi
    done
  fi
  # install.sh's fixed-path status file: removed only if this run created it.
  if [[ "${TMP_STATUS_PREEXISTED}" == 0 && -f "${INSTALL_STATUS_TMP}" ]]; then
    rm -f "${INSTALL_STATUS_TMP}" && echo "removed ${INSTALL_STATUS_TMP} (created by this run)" >>"${LOG_DIR}/teardown.log"
  fi

  # The secret gate: nothing generated may appear anywhere in the evidence,
  # plain, base64, or inside a zip. Checked before scrubbing, so a leak is a FAIL, not hidden.
  if [[ "${STARTED}" == 1 && -d "${EVIDENCE}" ]]; then
    local sources=() line
    while IFS= read -r line; do sources+=("$line"); done < <(secret_sources)
    node "${HERE}/lib/secret-check.mjs" "${EVIDENCE}" "${sources[@]}" >"${SCRATCH}/secret-check.out" 2>&1
    local sc_rc=$?
    cp "${SCRATCH}/secret-check.out" "${LOG_DIR}/secret-check.log" 2>/dev/null
    case "${sc_rc}" in
      0) record X1 PASS "no secret in the evidence (plain, base64, or inside zips)" "${LOG_DIR}/secret-check.log" "$(tail -n 1 "${SCRATCH}/secret-check.out")" ;;
      1) record X1 FAIL "a secret was found in the evidence" "${LOG_DIR}/secret-check.log" "$(head -n 4 "${SCRATCH}/secret-check.out" | tr '\n' ' ')" ;;
      *) record X1 FAIL "the secret check couldn't run" "${LOG_DIR}/secret-check.log" "$(tail -n 1 "${SCRATCH}/secret-check.out")" ;;
    esac
    node "${HERE}/lib/scrub.mjs" "${EVIDENCE}" "${sources[@]}" >>"${LOG_DIR}/teardown.log" 2>&1
  fi

  if [[ "${UAT_KEEP_SCRATCH:-0}" == 1 ]]; then
    log "UAT_KEEP_SCRATCH=1: scratch kept at ${SCRATCH}"
  elif [[ -n "${SCRATCH}" && -d "${SCRATCH}" ]]; then
    rm -rf "${SCRATCH}" 2>/dev/null || { chmod -R u+w "${SCRATCH}" 2>/dev/null; rm -rf "${SCRATCH}"; }
  fi

  if [[ "${STARTED}" == 1 ]]; then
    {
      echo "containers: $(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null | wc -l | tr -d ' ')"
      echo "volumes: $(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null | wc -l | tr -d ' ')"
      echo "image ${PROJECT}-console:local: $(docker image inspect "${PROJECT}-console:local" >/dev/null 2>&1 && echo present || echo removed)"
      echo "scratch exists: $([[ -e "${SCRATCH}" ]] && echo yes || echo no)"
      echo "gateway port ${GW_PORT:-none} listening: $([[ -n "${GW_PORT}" ]] && ! port_free "${GW_PORT}" && echo yes || echo no)"
    } >"${EVIDENCE}/cleanup.txt" 2>/dev/null
    summary "${rc}"
    rc=$?
  fi
  exit "${rc}"
}

# summary <rc>: prints every row and the gate; returns 0 only if the gate passed.
summary() {
  local rc="$1" id status title ev note reasons=() count row_status
  echo
  log "summary: MindStone-Agent@${MSA_REF}  mindstone-console@${CONSOLE_REF}  (run ${RUN_ID}, $(elapsed "${T0}"))"
  echo
  printf '  %-7s %-4s %s\n' STATUS ID STEP
  if [[ -f "${STEPS_TSV}" ]]; then
    while IFS=$'\t' read -r id status title ev note; do
      printf '  %s%-7s%s %-4s %s\n' "$(colour_for "$status")" "$status" "${c_reset}" "$id" "$title"
      [[ -n "$note" ]] && printf '               %s%s%s\n' "${c_dim}" "$note" "${c_reset}"
      [[ -n "$ev" ]] && printf '               %s%s%s\n' "${c_dim}" "$ev" "${c_reset}"
    done <"${STEPS_TSV}"
  fi
  # The gate: every required row exactly once and PASS; no unknown rows; Playwright exit 0; run exit 0.
  for id in ${REQUIRED_STEPS}; do
    count=$(awk -F'\t' -v id="$id" '$1==id' "${STEPS_TSV}" 2>/dev/null | wc -l | tr -d ' ')
    row_status=$(awk -F'\t' -v id="$id" '$1==id{print $2; exit}' "${STEPS_TSV}" 2>/dev/null)
    if [[ "${count}" == 0 ]]; then reasons+=("${id} MISSING")
    elif [[ "${count}" != 1 ]]; then reasons+=("${id} x${count}")
    elif [[ "${row_status}" != PASS ]]; then reasons+=("${id} ${row_status}")
    fi
  done
  while IFS=$'\t' read -r id _; do
    [[ " ${REQUIRED_STEPS} " == *" ${id} "* ]] || reasons+=("unknown row ${id}")
  done <"${STEPS_TSV}"
  [[ "${PW_RC}" == 0 ]] || reasons+=("playwright exit ${PW_RC}")
  [[ "${rc}" == 0 ]] || reasons+=("harness exit ${rc}${FATAL:+ (${FATAL})}")

  if [[ -f "${EVIDENCE}/findings.md" ]]; then
    echo; log "README findings (followed literally):"; sed 's/^/  /' "${EVIDENCE}/findings.md"
  fi
  if [[ -f "${EVIDENCE}/deviations.md" ]]; then
    echo; log "harness deviations from the READMEs:"; sed 's/^/  /' "${EVIDENCE}/deviations.md"
  fi
  echo
  log "cleanup: $(tr '\n' ';' <"${EVIDENCE}/cleanup.txt" 2>/dev/null)"
  log "evidence: ${EVIDENCE}"
  local gate
  if [[ ${#reasons[@]} -eq 0 ]]; then
    gate="PASS"
    log "${c_green}GATE: PASS${c_reset} (all ${REQUIRED_STEPS// /, } passed)"
  else
    gate="NOT PASSED: ${reasons[*]}"
    log "${c_red}GATE: NOT PASSED${c_reset} (${reasons[*]})"
  fi
  {
    echo "# Journey UAT ${RUN_ID}"
    echo
    echo "MindStone-Agent \`${MSA_REF}\` ($(grep '^msa_sha=' "${EVIDENCE}/run.env" 2>/dev/null | cut -d= -f2)), mindstone-console \`${CONSOLE_REF}\` ($(grep '^console_sha=' "${EVIDENCE}/run.env" 2>/dev/null | cut -d= -f2)); provider $(grep '^provider=' "${EVIDENCE}/run.env" 2>/dev/null | cut -d= -f2) $(grep '^provider_model=' "${EVIDENCE}/run.env" 2>/dev/null | cut -d= -f2); duration $(elapsed "${T0}")."
    echo
    echo "**GATE: ${gate}**"
    echo
    echo "| Status | ID | Step | Evidence | Note |"
    echo "|---|---|---|---|---|"
    awk -F'\t' '{printf "| %s | %s | %s | %s | %s |\n", $2, $1, $3, $4, $5}' "${STEPS_TSV}" 2>/dev/null
    [[ -f "${EVIDENCE}/findings.md" ]] && { echo; echo "## README findings"; echo; cat "${EVIDENCE}/findings.md"; }
    [[ -f "${EVIDENCE}/deviations.md" ]] && { echo; echo "## Harness deviations"; echo; cat "${EVIDENCE}/deviations.md"; }
    echo; echo "## Cleanup"; echo; sed 's/^/- /' "${EVIDENCE}/cleanup.txt" 2>/dev/null
  } >"${EVIDENCE}/SUMMARY.md"
  [[ "${gate}" == PASS ]]
}

# ------------------------------------------------------------------ start ----
need git; need node; need npm; need docker; need curl; need openssl
mkdir -p "${EVIDENCE}" "${LOG_DIR}" "${EVIDENCE}/screens"
: >"${STEPS_TSV}"
STARTED=1
trap teardown EXIT
trap 'FATAL="interrupted"; exit 130' INT TERM HUP
mkdir -p "${SCRATCH}" "${SCRATCH_HOME}" "${SCRATCH}/tmp"
(umask 077; mkdir -p "${SECRETS_DIR}")

GW_PORT="$(pick_port)" || die "no free port in ${PORT_MIN}-${PORT_MAX}"
CONSOLE_PORT="$(pick_port "${GW_PORT}")" || die "no second free port in ${PORT_MIN}-${PORT_MAX}"
if [[ "$(uname -s)" == Linux ]]; then
  MINDSTONE_AGENT_GATEWAY_HOST_OVERRIDE="${UAT_GATEWAY_BRIDGE_HOST:-172.17.0.1}"
  GW_HOST="${MINDSTONE_AGENT_GATEWAY_HOST_OVERRIDE}"
else
  MINDSTONE_AGENT_GATEWAY_HOST_OVERRIDE=""
  GW_HOST="127.0.0.1"
fi
GW_URL="http://${GW_HOST}:${GW_PORT}"
CONSOLE_URL="http://localhost:${CONSOLE_PORT}"

{
  echo "run_id=${RUN_ID}"; echo "msa_ref=${MSA_REF}"; echo "console_ref=${CONSOLE_REF}"
  echo "msa_repo=${MSA_REPO}"; echo "console_repo=${CONSOLE_REPO}"
  echo "compose_project=${PROJECT}"; echo "scratch=${SCRATCH}"
  echo "gateway=${GW_URL}"; echo "console=${CONSOLE_URL}"
  echo "harness_commit=$(git -C "${CONSOLE_HARNESS_ROOT}" rev-parse --short HEAD 2>/dev/null)"
  echo "node=$(node --version)"; echo "docker=$(docker --version 2>/dev/null)"; echo "os=$(uname -sm)"
  echo "started=$(date -u +%FT%TZ)"
} >"${EVIDENCE}/run.env"

log "journey UAT ${RUN_ID}: MindStone-Agent@${MSA_REF}, mindstone-console@${CONSOLE_REF}"
log "gateway port ${GW_PORT}, Console port ${CONSOLE_PORT}, compose project ${PROJECT}"
log "scratch ${SCRATCH}"
log "evidence ${EVIDENCE}"
deviation "Ports: the gateway listens on ${GW_PORT} (\`MINDSTONE_AGENT_GATEWAY_PORT\` in its environment, plus \`gateway.port\` **and \`gateway.host\` (${GW_HOST})** written to config.json so the CLI's health checks agree) and the Console on ${CONSOLE_PORT} (a compose override with its own container names and image tag), not 19789/3080; \`MINDSTONE_GATEWAY_URL\` in the Console's \`.env\` points at ${GW_PORT}."
deviation "HOME is a scratch dir for every MindStone-Agent command, so the README's \`\$HOME/.mindstone-admin-credential\` lands in scratch; inherited MINDSTONE_*/PI_* variables are dropped."
deviation "The README's \`curl … | bash\` runs \`install.sh\` downloaded from ${MSA_RAW}/${MSA_REF} with \`--dir <scratch> --no-link --branch ${MSA_REF} --repo ${MSA_REPO}\`$([[ "${MSA_REPO}" == "${MSA_REPO_DEFAULT}" ]] && echo ' (the default repo, passed explicitly)')."
deviation "The README's curl checks put the token on the command line (\`-H \"Authorization: Bearer \$(cat …)\"\`); the harness sends the same headers from 0600 files (\`curl -H @file\`), so no token is in any process's argv."
if [[ "$(uname -s)" == Linux ]]; then
  deviation "Linux: the gateway runs with \`MINDSTONE_AGENT_GATEWAY_HOST=${GW_HOST}\` (MSA README 5.5; \`UAT_GATEWAY_BRIDGE_HOST\`), on every start and restart."
fi

# ------------------------------------------------- the model provider ------
# Decided before anything is built, so a misconfiguration fails in seconds.
PROVIDER="${UAT_PROVIDER:-auto}"
PROVIDER_MODEL="${UAT_PROVIDER_MODEL:-}"
ollama_tags() { curl -sf -m 5 "${OLLAMA_URL}/api/tags" 2>/dev/null; }
if [[ "${PROVIDER}" == auto ]]; then
  if tags=$(ollama_tags) && [[ -n "${tags}" ]]; then
    picked=$(printf '%s' "${tags}" | node "${HERE}/lib/pick-ollama-model.mjs" "${UAT_OLLAMA_ALLOW_LOCAL:-0}" "${UAT_OLLAMA_MAX_LOCAL_GB:-8}" 2>>"${LOG_DIR}/provider.log") || picked=""
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
    tags="${tags:-$(ollama_tags || true)}"
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
echo "provider=${PROVIDER}" >>"${EVIDENCE}/run.env"; echo "provider_model=${PROVIDER_MODEL}" >>"${EVIDENCE}/run.env"
log "model provider: ${PROVIDER}${PROVIDER_MODEL:+ (${PROVIDER_MODEL})}"

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
if ! msa_env bash "${SCRATCH}/install.sh" --dir "${MSA_DIR}" --repo "${MSA_REPO}" --no-link --branch "${MSA_REF}" \
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

# --- step 2: onboard (interactive) ---------------------------------------------
# A demo user onboards in the Console, so the harness must reach a gateway that
# is NOT onboarded without `mindstone onboard`. The README says step 5 needs
# step 2 first; if it does, that's a FAIL finding, reported, not hidden.
CURRENT_STEP=S2
CONFIG="${MSA_DIR}/.runtime/mindstone/config.json"
if [[ -f "${CONFIG}" ]]; then
  record S2 PASS "MSA step 2: a config exists without interactive onboarding" "${CONFIG#${SCRATCH}/}"
else
  record S2 FAIL "MSA step 2: the README requires interactive \`mindstone onboard\` (a TTY) before step 5 can work" "${LOG_DIR}/msa-status.log" \
    "install.sh leaves no .runtime/mindstone/config.json, and README step 5.3 reads it; only onboarding creates it per the README"
  finding F-MSA-2 "MindStone-Agent README step 2 says an agent without a TTY must *stop and ask the human* to run \`mindstone onboard\`, and step 5 says the gateway side needs step 2 finished first. For a Console-only install (the #106 demo) there is no documented non-interactive path: \`install.sh\` does not create \`.runtime/mindstone/config.json\`, so step 5.3's \`node -e\` merge fails with ENOENT. The harness uses \`scripts/init-runtime.sh\` (undocumented in the README) to get a not-onboarded runtime."
  log "  HARNESS: running scripts/init-runtime.sh (undocumented) to create a not-onboarded runtime"
  (cd "${MSA_DIR}" && msa_env ./scripts/init-runtime.sh) >"${LOG_DIR}/msa-init-runtime.log" 2>&1 \
    || die "scripts/init-runtime.sh failed"
  [[ -f "${CONFIG}" ]] || die "scripts/init-runtime.sh made no config.json"
  deviation "MSA README step 2 (\`mindstone onboard\`, interactive) is replaced by \`scripts/init-runtime.sh\`, so the gateway starts *not onboarded* (routing placeholder) and setup happens in the Console."
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
mindstone gateway start >"${LOG_DIR}/gateway-start.log" 2>&1 || true
ok=0
for _ in $(seq 1 60); do
  if curl -sf -m 2 "${GW_URL}/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [[ "${ok}" == 1 ]]; then
  record S3 PASS "MSA step 3: \`mindstone gateway start\`; /health answers" "${LOG_DIR}/gateway-start.log" "${GW_URL}/health"
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

# 5.4 check the route
mindstone doctor >"${LOG_DIR}/msa-doctor.log" 2>&1 || true
if grep -i routing "${LOG_DIR}/msa-doctor.log" | grep -qi placeholder; then
  s5_notes="doctor shows routing.mode placeholder, as expected before Console setup"
  if grep -q 'mindstone config --section routing' "${MSA_README}"; then
    finding F-MSA-4 "MindStone-Agent README step 5.4 says that if \`mindstone doctor\` shows \`routing.mode\` \`placeholder\`, run \`mindstone config --section routing\` (interactive) because Console chat fails without a route. On a Console-first install that is the expected state: the Console's guided setup sets the route. The README doesn't say so."
  fi
fi
# 5.5 macOS: host.docker.internal needs nothing; Linux: bridge address (handled by msa_env).
# 5.6 restart, since the gateway was started with `gateway start`
mindstone gateway restart >"${LOG_DIR}/gateway-restart.log" 2>&1 || true
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
CURRENT_STEP=C2
(
  set -e
  cd "${COMPOSE_DIR}"
  cp .env.example .env
  chmod 600 .env
  for k in CREDS_KEY JWT_SECRET JWT_REFRESH_SECRET; do
    sed -i.bak "s|^$k=.*|$k=$(openssl rand -hex 32)|" .env
  done
  sed -i.bak "s|^CREDS_IV=.*|CREDS_IV=$(openssl rand -hex 16)|" .env
  rm -f .env.bak
  GW="${MSA_DIR}/.runtime/mindstone/secrets"
  ADMIN="${SCRATCH_HOME}/.mindstone-admin-credential"
  sed -i.bak "s|^MINDSTONE_GATEWAY_TOKEN=.*|MINDSTONE_GATEWAY_TOKEN=$(cat "$GW/gateway-token")|" .env
  sed -i.bak "s|^MINDSTONE_ADMIN_TOKEN=.*|MINDSTONE_ADMIN_TOKEN=$(cat "$ADMIN")|" .env
  rm -f .env.bak
  # 2.1 MINDSTONE_GATEWAY_URL: the harness port, or the Linux bridge address.
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
log "  docker compose up -d --build (the first build takes several minutes)"
t=$(date +%s)
(cd "${COMPOSE_DIR}" && mkdir -p data-node uploads logs)
COMPOSE_STARTED=1
if ! compose up -d --build >"${LOG_DIR}/console-build.log" 2>&1; then
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
  record C3 PASS "Console step 3: docker compose up -d --build; both services running; / answers 200" "${LOG_DIR}/compose-ps.txt" "build+start ${build_time}"
else
  compose logs --no-color console 2>&1 | tail -n 80 >"${LOG_DIR}/console.tail.log"
  record C3 FAIL "Console step 3: running services [${running}], / 200: ${ok}" "${LOG_DIR}/console.tail.log"
  die "Console didn't start"
fi
CURRENT_STEP=""

# --- step 4: create the admin account ------------------------------------------------
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
    (cd "${HERE}/.pw" && npm install --no-save --no-package-lock --no-audit --no-fund "@playwright/test@${PW_VERSION}") >"${LOG_DIR}/playwright-install.log" 2>&1 \
      || die "couldn't install @playwright/test (${LOG_DIR}/playwright-install.log)"
  fi
  PW_BIN="${HERE}/.pw/node_modules/.bin/playwright"
  PW_NODE_PATH="${HERE}/.pw/node_modules"
fi
PW_INSTALL_ARGS=(install chromium)
if [[ "$(uname -s)" == Linux ]] && { [[ "$(id -u)" == 0 ]] || sudo -n true 2>/dev/null; }; then
  PW_INSTALL_ARGS=(install --with-deps chromium) # the browser's system libraries too (CI)
fi
NODE_PATH="${PW_NODE_PATH}" "${PW_BIN}" "${PW_INSTALL_ARGS[@]}" >>"${LOG_DIR}/playwright-install.log" 2>&1 \
  || die "playwright ${PW_INSTALL_ARGS[*]} failed (${LOG_DIR}/playwright-install.log)"

provider_key_file=""
[[ "${PROVIDER}" == ollama-cloud ]] && provider_key_file="${UAT_PROVIDER_KEY_FILE}"
rm -f "${EVIDENCE}/journey-results.tsv" "${EVIDENCE}/journey-state.json"
set +e
(cd "${PW_DIR}" && \
  UAT_CONSOLE_URL="${CONSOLE_URL}" \
  UAT_EVIDENCE_DIR="${EVIDENCE}" \
  UAT_ADMIN_EMAIL="${ADMIN_EMAIL}" \
  UAT_ADMIN_PASSWORD_FILE="${SECRETS_DIR}/admin-password" \
  UAT_PROVIDER="${PROVIDER}" \
  UAT_PROVIDER_MODEL="${PROVIDER_MODEL}" \
  UAT_PROVIDER_KEY_FILE="${provider_key_file}" \
  UAT_OLLAMA_BASE_URL="${OLLAMA_URL}/v1" \
  UAT_GATEWAY_URL="${GW_URL}" \
  UAT_GATEWAY_AUTH_HEADER_FILE="${SECRETS_DIR}/h-auth" \
  UAT_GATEWAY_ADMIN_HEADER_FILE="${SECRETS_DIR}/h-admin" \
  UAT_GATEWAY_LOG="${MSA_DIR}/.runtime/mindstone/gateway/gateway.log" \
  UAT_TRANSCRIPT_DIR="${MSA_DIR}/.runtime/mindstone/transcripts" \
  NODE_PATH="${PW_NODE_PATH}" \
  "${PW_BIN}" test --config "${PW_DIR}/playwright.config.ts") 2>&1 | tee "${LOG_DIR}/playwright.log"
PW_RC=${PIPESTATUS[0]}
set -e
if [[ -f "${EVIDENCE}/journey-results.tsv" ]]; then
  cat "${EVIDENCE}/journey-results.tsv" >>"${STEPS_TSV}"
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
echo "finished=$(date -u +%FT%TZ)" >>"${EVIDENCE}/run.env"
echo "duration=$(elapsed "${T0}")" >>"${EVIDENCE}/run.env"
# The gate (and the exit code) is decided in teardown's summary, after the secret check.
exit 0
