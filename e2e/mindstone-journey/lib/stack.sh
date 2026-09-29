# The harness's stack mode (UAT_INSTALL=stack, MindStone-Agent #171): the whole stack (the gateway, the Console and
# MongoDB) installed by MindStone-Agent's install-stack.sh, into one Docker Compose project, exactly as a person runs
# it: `curl -fsSL <raw>/<msa-ref>/install-stack.sh | bash -s -- …` (MindStone-Agent README, install guide path A).
#
# Sourced by run-journey.sh after its own helpers, and only in stack mode. It replaces the native install (S* and C*)
# with the stack's steps under the same row ids, so the gate and the DEMO SUBSET are unchanged, and points the helpers
# that run MindStone-Agent commands (msa_env, mindstone, gateway_cmd) at the gateway container. Everything here uses
# run-journey.sh's globals (record, die, deviation, finding, the dirs and ports).
#
# The installer never prints a secret, and neither does this file: values are read from the stack's 600 env files
# into the harness's own 600 files (stack_secret_to_file), and only compared or counted in the shell.

STACK_DIR="${SCRATCH}/stack"                     # install-stack.sh --dir
STACK_MIRROR="${SCRATCH}/stack-mirror"           # the gateway's files, copied out for the journey (lib/stack-files.js)
STACK_INSTALLER_COPY="${SCRATCH}/install-stack.sh" # the installer exactly as it was piped to bash (for --uninstall)
# The refs the stack is installed at: by default (UAT_STACK_PIN, 1) the commits <msa-ref> and <console-ref> name when
# the run starts, so what is installed is exactly what the evidence records, even if a branch moves during the run
# (and raw.githubusercontent.com's cache of a branch can't serve an older installer). Set by stack_pin_refs.
STACK_PIN="${UAT_STACK_PIN:-1}"
STACK_MSA_INSTALL_REF="${MSA_REF}"
STACK_CONSOLE_INSTALL_REF="${CONSOLE_REF}"
STACK_INSTALLER_URL="${MSA_RAW}/${MSA_REF}/install-stack.sh"
STACK_INSTALLER_FILE="${UAT_STACK_INSTALLER_FILE:-}" # a local install-stack.sh instead of the raw URL (raw caches for minutes)
# Ollama as the gateway container reaches it: the stack's own default unless UAT_STACK_OLLAMA_BASE_URL says otherwise
# (then passed to the installer as OLLAMA_BASE_URL). The harness's own probes keep using OLLAMA_URL, on this host.
STACK_OLLAMA_BASE_URL="${UAT_STACK_OLLAMA_BASE_URL:-http://host.docker.internal:11434/v1}"
STACK_GATEWAY_DATA_DIR=""     # MINDSTONE_AGENT_DATA_DIR inside the gateway container (read from it after the install)
STACK_GATEWAY_SESSIONS_DIR="" # PI_CODING_AGENT_SESSION_DIR inside it
STACK_CA_FILE=""              # J11: the per-run CA the gateway trusts for the stub (NODE_EXTRA_CA_CERTS)
STACK_STUB_CERT=""
STACK_STUB_KEY=""
STACK_CA_IN_GATEWAY="/run/uat-j11/ca.pem" # where compose.override.yml mounts J11's CA in the gateway container
# The stack's images, as Compose names built images (<project>-<service>).
HARNESS_IMAGES="${PROJECT}-gateway ${PROJECT}-console"
CONSOLE_IMAGE="${PROJECT}-console"
GW_TOKEN_FILE="${SECRETS_DIR}/gateway-token"
# What teardown may run against the stack's own compose file. install-stack.sh --uninstall takes the project from the
# install folder's .env (no -p), and `down -v` removes what the file names, so both run only when the installer used
# this run's project (STACK_PROJECT_OK: .env's COMPOSE_PROJECT_NAME is PROJECT) and the file it used is the one the
# guard passed (STACK_COMPOSE_OK). Otherwise teardown skips both, says why (STACK_TEARDOWN_SKIP), and leaves the
# cleanup to run-journey.sh's sweep of what carries this project's label.
STACK_PROJECT_OK=0
STACK_COMPOSE_OK=0
STACK_TEARDOWN_SKIP="the install didn't get far enough to check its project and compose file"
STACK_PREFLIGHT="${SCRATCH}/stack-preflight" # the compose file the guard passed before the install, kept to compare
STACK_INSTALLER_NOTE=""

# Variables Compose would read from the harness's own environment ahead of the stack's .env (interpolation), or that
# would change what the installer does. Unset for every stack command, so the stack's .env alone decides.
STACK_UNSET=(-u MINDSTONE_BUILD_CONTEXT -u CONSOLE_BUILD_CONTEXT -u OLLAMA_BASE_URL -u COMPOSE_PROFILES -u COMPOSE_FILE
  -u COMPOSE_PROJECT_NAME -u MINDSTONE_DIR -u MINDSTONE_REF -u CONSOLE_REF -u CONSOLE_PORT -u MINDSTONE_GATEWAY_PORT
  -u MINDSTONE_PROJECT -u MINDSTONE_OLLAMA_BASE_URL -u COMPOSE_PATH_SEPARATOR)

# stack_guard <dir> <log>: compose-guard.mjs on <dir>'s compose.yml (and compose.override.yml), resolved the way
# install-stack.sh runs compose: no -p, so the project comes from <dir>/.env as it does for the installer.
stack_guard() {
  local files=(-f "$1/compose.yml")
  [[ -f "$1/compose.override.yml" ]] && files+=(-f "$1/compose.override.yml")
  env "${STACK_UNSET[@]}" docker compose --project-directory "$1" "${files[@]}" config --format json 2>>"$2" \
    | node "${HERE}/lib/compose-guard.mjs" "${PROJECT}" "$1" >>"$2" 2>&1
}

# stack_check_installed: after install-stack.sh ran (whether it succeeded or not), whether it used this run's project
# and the compose file the guard passed. Sets STACK_PROJECT_OK, STACK_COMPOSE_OK and STACK_TEARDOWN_SKIP; prints the
# problems, one per line (none: both hold).
stack_check_installed() {
  local used reasons=()
  used=$(stack_env_value "${STACK_DIR}/.env" COMPOSE_PROJECT_NAME) || used="" # no .env: the installer failed early
  if [[ "${used}" == "${PROJECT}" ]]; then STACK_PROJECT_OK=1; else
    STACK_PROJECT_OK=0
    reasons+=("the install folder's .env has COMPOSE_PROJECT_NAME=${used:-(none)}, not ${PROJECT} (MINDSTONE_PROJECT): the installer ran another project")
  fi
  if [[ ! -f "${STACK_DIR}/compose.yml" ]]; then
    STACK_COMPOSE_OK=0; reasons+=("the installer left no compose.yml")
  elif ! cmp -s "${STACK_PREFLIGHT}/compose.yml" "${STACK_DIR}/compose.yml"; then
    STACK_COMPOSE_OK=0; reasons+=("the installer's compose.yml isn't the file the guard passed before the install")
  fi
  if [[ ${#reasons[@]} -eq 0 ]]; then STACK_TEARDOWN_SKIP=""; else STACK_TEARDOWN_SKIP="$(IFS=';'; echo "${reasons[*]}")"; fi
  [[ ${#reasons[@]} -eq 0 ]] || printf '%s\n' "${reasons[@]}"
}

# stack_compose <args…>: docker compose for this run's project only: -p, and the stack's own compose file, plus its
# compose.override.yml when there is one (as install-stack.sh and a plain `docker compose` in the folder use it).
stack_compose() {
  local files=(-f "${STACK_DIR}/compose.yml")
  [[ -f "${STACK_DIR}/compose.override.yml" ]] && files+=(-f "${STACK_DIR}/compose.override.yml")
  env "${STACK_UNSET[@]}" docker compose -p "${PROJECT}" --project-directory "${STACK_DIR}" "${files[@]}" "$@"
}

# The MindStone-Agent helpers, against the gateway container (README A4: `docker compose exec gateway
# ./scripts/mindstone <command>`). Gateway start, stop and restart go through the container.
msa_env() { stack_compose exec -T gateway env "$@"; }
mindstone() { stack_compose exec -T gateway ./scripts/mindstone "$@"; }
gateway_cmd() {
  case "${1:-}" in
    start | stop | restart) stack_compose "$1" gateway ;;
    *) mindstone gateway "$@" ;;
  esac
}

# stack_secret_to_file <env file> <key> <dest>: KEY's value into a 0600 file, never printed (awk reads the key name
# from its environment; the value only goes to the file). Fails when the value is missing or short.
stack_secret_to_file() {
  (umask 077; K="$2" awk -F= '$1 == ENVIRON["K"] { sub(/^[^=]*=/, ""); v = $0 } END { printf "%s\n", v }' "$1" >"$3") || return 1
  [[ "$(wc -c <"$3" | tr -d ' ')" -gt 16 ]]
}

# stack_env_value <env file> <key>: a NON-secret setting's value (for the checks and the log).
stack_env_value() { K="$2" awk -F= '$1 == ENVIRON["K"] { sub(/^[^=]*=/, ""); v = $0 } END { printf "%s", v }' "$1" 2>/dev/null; }

# stack_mode_of <file>: its permission bits as ls shows them (README A2: `ls -l … | cut -c1-10`).
stack_mode_of() { ls -l "$1" 2>/dev/null | cut -c1-10; }

# stack_run_installer <args…>: the README's command. The installer is piped to bash (from the raw URL at <msa-ref>,
# or UAT_STACK_INSTALLER_FILE), with the ports and project on bash's environment, as the README sets them. The
# caller adds --ollama-url only with UAT_STACK_OLLAMA_BASE_URL.
stack_run_installer() {
  local fetch
  if [[ -n "${STACK_INSTALLER_FILE}" ]]; then fetch=(cat "${STACK_INSTALLER_FILE}"); else fetch=(curl -fsSL "${STACK_INSTALLER_URL}"); fi
  "${fetch[@]}" | tee "${STACK_INSTALLER_COPY}" | env "${STACK_UNSET[@]}" \
    CONSOLE_PORT="${CONSOLE_PORT}" MINDSTONE_GATEWAY_PORT="${GW_PORT}" MINDSTONE_PROJECT="${PROJECT}" \
    bash -s -- "$@"
}

# stack_ls_remote <repo> <ref>: the full commit a ref names now (a full SHA is its own answer); empty if it can't be read.
stack_ls_remote() {
  if [[ "$2" =~ ^[0-9a-f]{40}$ ]]; then printf '%s' "$2"; return 0; fi
  # A branch, else a tag's commit (the peeled ^{} line of an annotated tag wins over the tag object).
  git ls-remote "$1" "refs/heads/$2" "refs/tags/$2" "refs/tags/$2^{}" 2>/dev/null \
    | awk '$2 ~ /^refs\/heads\// { head = $1 } $2 ~ /\^\{\}$/ { peeled = $1 } $2 !~ /\^\{\}$/ && $2 ~ /^refs\/tags\// { tag = $1 }
           END { v = head; if (v == "") v = peeled; if (v == "") v = tag; printf "%s", v }'
}

# stack_pin_refs: resolves <msa-ref> and <console-ref> to their commits now, before anything is installed, and (with
# UAT_STACK_PIN=1, the default) installs at exactly those: the installer's raw URL, --ref and --console-ref. MSA_SHA
# and CONSOLE_SHA (the evidence's) are those commits. UAT_STACK_PIN=0 passes the refs as given; the commits recorded
# are then what the refs named at the start, which a push during the build could change.
stack_pin_refs() {
  local msa console
  msa=$(stack_ls_remote "${MSA_REPO}" "${MSA_REF}")
  console=$(stack_ls_remote "${CONSOLE_REPO}" "${CONSOLE_REF}")
  if [[ "${STACK_PIN}" != 0 ]]; then
    [[ "${msa}" =~ ^[0-9a-f]{40}$ ]] || die "stack mode: couldn't resolve MindStone-Agent ${MSA_REF} to a commit (git ls-remote; UAT_STACK_PIN=0 installs the ref as given)"
    [[ "${console}" =~ ^[0-9a-f]{40}$ ]] || die "stack mode: couldn't resolve mindstone-console ${CONSOLE_REF} to a commit (git ls-remote; UAT_STACK_PIN=0 installs the ref as given)"
    STACK_MSA_INSTALL_REF="${msa}"
    STACK_CONSOLE_INSTALL_REF="${console}"
  fi
  STACK_INSTALLER_URL="${MSA_RAW}/${STACK_MSA_INSTALL_REF}/install-stack.sh"
  MSA_SHA="${msa:0:7}"; MSA_SHA="${MSA_SHA:-unknown}"
  CONSOLE_SHA="${console:0:7}"; CONSOLE_SHA="${CONSOLE_SHA:-unknown}"
}

# stack_wait_health <seconds>: until the gateway's /health answers on the host port.
stack_wait_health() {
  local i
  for ((i = 0; i < $1; i++)); do
    curl -sf -m 2 "${GW_URL}/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# stack_make_tls: J11's per-run CA and the stub's server certificate (host.docker.internal, localhost, 127.0.0.1), in
# the 0600 secrets dir. The gateway container trusts the CA (NODE_EXTRA_CA_CERTS); nothing else does.
stack_make_tls() {
  local d="${SECRETS_DIR}/j11-tls"
  (umask 077; mkdir -p "${d}")
  cat >"${d}/openssl.cnf" <<'CNF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = MindStone journey UAT J11 test CA (one run only)
[ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[server]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:host.docker.internal, DNS:localhost, IP:127.0.0.1
CNF
  (
    umask 077
    openssl req -x509 -new -newkey rsa:2048 -nodes -keyout "${d}/ca.key" -out "${d}/ca.pem" -days 2 -config "${d}/openssl.cnf" -extensions ca &&
      openssl req -new -newkey rsa:2048 -nodes -keyout "${d}/stub.key" -out "${d}/stub.csr" -subj "/CN=host.docker.internal" &&
      openssl x509 -req -in "${d}/stub.csr" -CA "${d}/ca.pem" -CAkey "${d}/ca.key" -CAcreateserial -out "${d}/stub.pem" -days 2 \
        -extfile "${d}/openssl.cnf" -extensions server
  ) >"${LOG_DIR}/j11-tls.log" 2>&1 || return 1
  chmod 644 "${d}/ca.pem" # the CA's certificate is public; its key stays 0600 here and never leaves this dir
  # The private keys' bodies as one-line files, so X1 and the scrub look for them (they skip multi-line files).
  (umask 077; for k in ca stub; do grep -v '^-----' "${d}/${k}.key" | tr -d '\n' >"${d}/${k}.key.body"; done)
  STACK_CA_FILE="${d}/ca.pem"
  STACK_STUB_CERT="${d}/stub.pem"
  STACK_STUB_KEY="${d}/stub.key"
}

# =============================================================================
# The stack install: MindStone-Agent README, install guide path A (rows S0-S5, C0-C3)
# =============================================================================
stack_install_steps() {
  local t out problems ps running with without admin_status onboarded code count
  log "MindStone-Agent: README install guide path A (the whole stack in Docker)"
  # install-stack.sh lowercases the admin's email; so does the harness, for its checks and the sign-in.
  ADMIN_EMAIL=$(printf '%s' "${UAT_ADMIN_EMAIL:-uat-admin@example.com}" | tr '[:upper:]' '[:lower:]')

  # --- A0: requirements --------------------------------------------------------------
  CURRENT_STEP=S0
  problems=()
  {
    echo "\$ docker info >/dev/null && docker compose version"
    docker info >/dev/null 2>&1 && echo "docker info: ok" || { echo "docker info: failed"; problems+=("Docker isn't running (docker info failed)"); }
    out=$(docker compose version 2>&1) || true
    echo "${out}"
    # Compose 2 or newer, as install-stack.sh checks it (MindStone-Agent #182): Docker Desktop ships 5.x.
    if ! [[ "$(docker compose version --short 2>/dev/null)" =~ ^v?([0-9]+)\. ]] || (( BASH_REMATCH[1] < 2 )); then
      problems+=("no Docker Compose v2 or newer (${out:-none})")
    fi
    for p in "${CONSOLE_PORT}" "${GW_PORT}"; do
      code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:${p}" 2>/dev/null || true)
      echo "\$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${p}  ->  ${code}"
      [[ "${code}" == 000 ]] || problems+=("port ${p} already answers (${code})")
    done
  } >"${LOG_DIR}/stack-requirements.log" 2>&1
  if [[ ${#problems[@]} -eq 0 ]]; then
    record S0 PASS "Stack A0: requirements (Docker running, Compose v2 or newer; nothing answers on the Console or gateway port)" "${LOG_DIR}/stack-requirements.log" \
      "$(docker compose version --short 2>/dev/null); ports ${CONSOLE_PORT} and ${GW_PORT} print 000"
  else
    record S0 FAIL "Stack A0: requirements" "${LOG_DIR}/stack-requirements.log" "$(IFS=';'; echo "${problems[*]}")"
    die "stack requirements"
  fi
  CURRENT_STEP=""

  # --- A1: install ---------------------------------------------------------------------
  CURRENT_STEP=S1
  # Before the installer brings anything up: the compose file at <msa-ref> must resolve to this run's project, with
  # only its own names and binds inside its own dir (teardown removes what it names). Checked the way the installer
  # will run it (the project name from .env, no -p), with empty placeholder env files.
  local pre="${STACK_PREFLIGHT}"
  mkdir -p "${pre}"
  if ! curl -fsSL "${MSA_RAW}/${STACK_MSA_INSTALL_REF}/deploy/docker/compose.yml" -o "${pre}/compose.yml" 2>"${LOG_DIR}/compose-guard.log"; then
    record S1 FAIL "Stack A1: deploy/docker/compose.yml at ${MSA_REF}" "${LOG_DIR}/compose-guard.log" "couldn't download it"
    die "no stack compose file at ${MSA_REF}"
  fi
  printf 'COMPOSE_PROJECT_NAME=%s\nMINDSTONE_REF=%s\nCONSOLE_REF=%s\nCONSOLE_PORT=%s\nMINDSTONE_GATEWAY_PORT=%s\nUID=%s\nGID=%s\n' \
    "${PROJECT}" "${STACK_MSA_INSTALL_REF}" "${STACK_CONSOLE_INSTALL_REF}" "${CONSOLE_PORT}" "${GW_PORT}" "$(id -u)" "$(id -g)" >"${pre}/.env"
  : >"${pre}/gateway.env"; : >"${pre}/console.env"; : >"${pre}/librechat.yaml"
  if ! stack_guard "${pre}" "${LOG_DIR}/compose-guard.log"; then
    record S1 FAIL "Stack A1: the stack's compose project isn't safe to run and tear down" "${LOG_DIR}/compose-guard.log" \
      "$(grep -v '^compose-guard' "${LOG_DIR}/compose-guard.log" | head -3 | tr '\n' ' ')"
    die "compose-guard refused the stack's compose file"
  fi
  STACK_COMPOSE_OK=1 # this file only: after the install, the installer's copy must be the same (stack_check_installed)
  { echo "msa_sha=${MSA_SHA}"; echo "console_sha=${CONSOLE_SHA}"; echo "stack_msa_install_ref=${STACK_MSA_INSTALL_REF}"; echo "stack_console_install_ref=${STACK_CONSOLE_INSTALL_REF}"; } >>"${EVIDENCE}/run.env"
  curl -fsSL "${MSA_RAW}/${STACK_MSA_INSTALL_REF}/README.md" -o "${EVIDENCE}/msa-README.md" 2>/dev/null || : >"${EVIDENCE}/msa-README.md"
  MSA_README="${EVIDENCE}/msa-README.md"
  log "  install-stack.sh: building and starting the stack (the first build takes 10 to 20 minutes)"
  t=$(date +%s)
  STACK_STARTED=1
  local install_rc=0
  interruptible stack_run_installer --dir "${STACK_DIR}" --ref "${STACK_MSA_INSTALL_REF}" --console-ref "${STACK_CONSOLE_INSTALL_REF}" \
    --admin-email "${ADMIN_EMAIL}" --admin-name "UAT Admin" ${UAT_STACK_OLLAMA_BASE_URL:+--ollama-url "${STACK_OLLAMA_BASE_URL}"} \
    >"${LOG_DIR}/stack-install.log" 2>&1 || install_rc=$?
  [[ -s "${STACK_INSTALLER_COPY}" ]] && cp "${STACK_INSTALLER_COPY}" "${EVIDENCE}/msa-install-stack.sh"
  # First, whatever the exit: the project and compose file the installer actually used (teardown depends on both).
  # (Not in $(...): it sets the flags teardown reads.)
  stack_check_installed >"${LOG_DIR}/stack-installed-check.log"
  # A failed install reports as one (with the checks' notes), not as a project/compose mismatch.
  if [[ "${install_rc}" != 0 ]]; then
    tail_to "${LOG_DIR}/stack-install.log" "${LOG_DIR}/stack-install.tail.log" 80
    [[ -s "${LOG_DIR}/stack-installed-check.log" ]] && { echo "---"; cat "${LOG_DIR}/stack-installed-check.log"; } >>"${LOG_DIR}/stack-install.tail.log"
    record S1 FAIL "Stack A1: install-stack.sh exited ${install_rc}" "${LOG_DIR}/stack-install.tail.log"
    die "install-stack.sh failed"
  fi
  if [[ -s "${LOG_DIR}/stack-installed-check.log" ]]; then
    record S1 FAIL "Stack A1: install-stack.sh didn't install this run's project from the guarded compose file" "${LOG_DIR}/stack-installed-check.log" \
      "$(tr '\n' ';' <"${LOG_DIR}/stack-installed-check.log")"
    log "${c_red}${c_bold}the installer used another project or compose file: teardown won't run --uninstall or down -v on it${c_reset}"
    die "install-stack.sh didn't install this run's project from the guarded compose file"
  fi
  stack_compose ps --format '{{.Service}} {{.Status}}' >"${LOG_DIR}/stack-ps.txt" 2>&1 || true
  # The installer is the thing under test: from a local file, it's compared with the one at the pinned commit.
  local exactly=""
  if [[ -n "${STACK_INSTALLER_FILE}" ]]; then
    local mine theirs
    mine=$({ shasum -a 256 2>/dev/null || sha256sum; } <"${STACK_INSTALLER_COPY}" | cut -c1-64)
    theirs=$(curl -fsSL "${MSA_RAW}/${STACK_MSA_INSTALL_REF}/install-stack.sh" 2>/dev/null | { shasum -a 256 2>/dev/null || sha256sum; } | cut -c1-64) || theirs="(couldn't download)"
    if [[ "${mine}" == "${theirs}" ]]; then
      STACK_INSTALLER_NOTE="installer: a local file (UAT_STACK_INSTALLER_FILE), sha256 ${mine:0:12}…, the same as install-stack.sh at ${MSA_SHA}"
      [[ "${STACK_PIN}" != 0 ]] && exactly=", installed at exactly those commits"
    else
      STACK_INSTALLER_NOTE="installer: a local file (UAT_STACK_INSTALLER_FILE), sha256 ${mine:0:12}…, NOT install-stack.sh at ${MSA_SHA} (${theirs:0:12}…)"
    fi
    echo "stack_installer_sha256=${mine}" >>"${EVIDENCE}/run.env"
  elif [[ "${STACK_PIN}" != 0 ]]; then
    exactly=", installed at exactly those commits"
  fi
  problems=()
  grep -qF "Open http://localhost:${CONSOLE_PORT}" "${LOG_DIR}/stack-install.log" || problems+=("no \"Open http://localhost:${CONSOLE_PORT}\"")
  grep -qE '^gateway Up .*\(healthy\)' "${LOG_DIR}/stack-ps.txt" || problems+=("gateway isn't Up (healthy)")
  grep -qE '^console Up' "${LOG_DIR}/stack-ps.txt" || problems+=("console isn't Up")
  grep -qE '^mongodb Up' "${LOG_DIR}/stack-ps.txt" || problems+=("mongodb isn't Up")
  if [[ ${#problems[@]} -eq 0 ]]; then
    record S1 PASS "Stack A1: \`curl -fsSL …/<ref>/install-stack.sh | bash -s -- --dir --ref --console-ref --admin-email\`, MindStone-Agent ${MSA_REF} (${MSA_SHA}) and Console ${CONSOLE_REF} (${CONSOLE_SHA})${exactly}; project ${PROJECT} in .env; the guarded compose file; \`docker compose ps\`: gateway healthy, console and mongodb up" \
      "${LOG_DIR}/stack-install.log" "$(elapsed "$t"); $(tail -n 1 "${LOG_DIR}/compose-guard.log")${STACK_INSTALLER_NOTE:+; ${STACK_INSTALLER_NOTE}}"
  else
    record S1 FAIL "Stack A1: install-stack.sh checks" "${LOG_DIR}/stack-ps.txt" "$(IFS=';'; echo "${problems[*]}")"
    die "the stack didn't come up as the README says"
  fi
  CURRENT_STEP=""

  # Where the gateway keeps its files inside its container (the journey reads copies of them, lib/stack-files.js).
  STACK_GATEWAY_DATA_DIR=$(stack_compose exec -T gateway printenv MINDSTONE_AGENT_DATA_DIR 2>/dev/null | tr -d '\r')
  STACK_GATEWAY_SESSIONS_DIR=$(stack_compose exec -T gateway printenv PI_CODING_AGENT_SESSION_DIR 2>/dev/null | tr -d '\r')
  [[ "${STACK_GATEWAY_DATA_DIR}" == /* && "${STACK_GATEWAY_SESSIONS_DIR}" == /* ]] || die "couldn't read the gateway container's data and session dirs"
  { echo "stack_gateway_data_dir=${STACK_GATEWAY_DATA_DIR}"; echo "stack_gateway_sessions_dir=${STACK_GATEWAY_SESSIONS_DIR}"; } >>"${EVIDENCE}/run.env"

  # --- not onboarded: setup is left to the Console (README A4) ---------------------------------
  CURRENT_STEP=S2
  problems=()
  awk '/^### A\. /{on=1} on && /^### B\. /{exit} on' "${MSA_README}" >"${LOG_DIR}/msa-readme-pathA.txt"
  grep -q 'install-stack.sh' "${LOG_DIR}/msa-readme-pathA.txt" || problems+=("the README has no path A with install-stack.sh")
  grep -qi 'Finish setup in the Console' "${LOG_DIR}/msa-readme-pathA.txt" || problems+=("the README's path A doesn't finish setup in the Console")
  local routing_mode
  routing_mode=$(stack_compose exec -T gateway node -e 'try{const c=require(process.argv[1]);process.stdout.write(String(c.routing&&c.routing.mode||"(unset)"))}catch{process.stdout.write("(unreadable)")}' \
    "${STACK_GATEWAY_DATA_DIR}/config.json" 2>/dev/null | tr -d '\r')
  [[ "${routing_mode}" == placeholder ]] || problems+=("the fresh config's routing.mode is ${routing_mode:-(none)}, not placeholder")
  mindstone doctor >"${LOG_DIR}/msa-doctor.log" 2>&1 || true
  grep -q 'Result: ok' "${LOG_DIR}/msa-doctor.log" || problems+=("\`mindstone doctor\` in the container doesn't end with Result: ok")
  if [[ ${#problems[@]} -eq 0 ]]; then
    record S2 PASS "Stack A4 (before setup): not onboarded (routing.mode placeholder); \`docker compose exec gateway ./scripts/mindstone doctor\` ends with Result: ok" \
      "${LOG_DIR}/msa-doctor.log" "$(grep -i 'routing' "${LOG_DIR}/msa-doctor.log" | head -n 1 | tr -s ' ')"
  else
    record S2 FAIL "Stack A4 (before setup): not onboarded, doctor ok" "${LOG_DIR}/msa-doctor.log" "$(IFS=';'; echo "${problems[*]}")"
  fi
  CURRENT_STEP=""

  # --- the gateway: healthy, then J11's host settings the way an operator adds them -----------------
  # MindStone-Agent #126 lets an enterprise endpoint be a private host only with MINDSTONE_ENTERPRISE_PRIVATE_HOSTS=1 in
  # the gateway's own environment, and plain http only to loopback. J11's stub runs on this host; the gateway's
  # container reaches it as host.docker.internal, which isn't loopback, so the stub speaks https with a per-run CA
  # the gateway trusts (NODE_EXTRA_CA_CERTS). Both go in the stack's own place for local changes, compose.override.yml
  # in the install folder (install-stack.sh includes it and never overwrites it), with the CA mounted from beside it;
  # then `docker compose up -d gateway` recreates the gateway with them.
  CURRENT_STEP=S3
  problems=()
  local health
  health=$(curl -s -m 5 "${GW_URL}/health" 2>/dev/null || true)
  printf '%s\n' "${health}" >"${LOG_DIR}/gateway-health.json"
  printf '%s' "${health}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).ok===true?0:1)}catch{process.exit(1)}})' \
    || problems+=("/health on ${GW_PORT} didn't answer ok: true")
  {
    stack_make_tls || echo "couldn't make J11's CA and certificate (logs/j11-tls.log)"
    if [[ -n "${STACK_CA_FILE}" ]]; then
      cp "${STACK_CA_FILE}" "${STACK_DIR}/uat-j11-ca.pem" && chmod 644 "${STACK_DIR}/uat-j11-ca.pem"
      cat >"${STACK_DIR}/compose.override.yml" <<YAML
# Added by the MindStone journey UAT (run-journey.sh, J11): the gateway may register an enterprise endpoint on a
# private host (MindStone-Agent #126), and trusts the run's test CA, for the stub endpoint on this machine.
services:
  gateway:
    environment:
      MINDSTONE_ENTERPRISE_PRIVATE_HOSTS: "1"
      NODE_EXTRA_CA_CERTS: ${STACK_CA_IN_GATEWAY}
    volumes:
      - ./uat-j11-ca.pem:${STACK_CA_IN_GATEWAY}:ro
YAML
      cp "${STACK_DIR}/compose.override.yml" "${EVIDENCE}/stack-compose.override.yml"
      echo "wrote compose.override.yml (evidence: stack-compose.override.yml) and uat-j11-ca.pem in the install folder"
      stack_compose up -d --no-build --no-deps gateway
    fi
  } >"${LOG_DIR}/gateway-j11-settings.log" 2>&1
  [[ -n "${STACK_CA_FILE}" ]] || problems+=("no J11 CA (logs/j11-tls.log)")
  if stack_wait_health 120; then
    curl -s -m 5 "${GW_URL}/health" >>"${LOG_DIR}/gateway-health.json" 2>/dev/null
  else
    problems+=("the gateway didn't answer /health after \`docker compose up -d gateway\`")
  fi
  stack_compose exec -T gateway sh -c 'test "$MINDSTONE_ENTERPRISE_PRIVATE_HOSTS" = 1 && test -r "$NODE_EXTRA_CA_CERTS"' >/dev/null 2>&1 \
    || problems+=("the recreated gateway doesn't have J11's settings")
  if [[ ${#problems[@]} -eq 0 ]]; then
    record S3 PASS "Stack: the gateway answers /health on 127.0.0.1:${GW_PORT}; J11's host settings in compose.override.yml, \`docker compose up -d gateway\` recreated it, healthy again" \
      "${LOG_DIR}/gateway-j11-settings.log" "gateway /health on port ${GW_PORT}"
  else
    stack_compose logs --no-color --tail 80 gateway >"${LOG_DIR}/gateway.tail.log" 2>&1
    record S3 FAIL "Stack: gateway /health, J11 settings" "${LOG_DIR}/gateway.tail.log" "$(IFS=';'; echo "${problems[*]}")"
    die "the stack's gateway isn't healthy"
  fi
  CURRENT_STEP=""
  if ! grep -q 'compose.override.yml' "${STACK_INSTALLER_COPY}" 2>/dev/null; then
    finding F-STACK-1 "This \`install-stack.sh\` doesn't include a \`compose.override.yml\` from the install folder (it runs \`docker compose -f compose.yml\`), so a change of one's own to the stack, such as J11's gateway settings (\`MINDSTONE_ENTERPRISE_PRIVATE_HOSTS=1\`, a CA for a private endpoint), is dropped on the next update."
  fi

  # --- A2: the secrets and the gateway, then a restart through the container (A5) ----------------------
  CURRENT_STEP=S5
  problems=()
  count=$(grep -cE '^(CREDS_KEY|CREDS_IV|JWT_SECRET|JWT_REFRESH_SECRET|MINDSTONE_GATEWAY_TOKEN|MINDSTONE_ADMIN_TOKEN)=.+' "${STACK_DIR}/console.env" || true)
  [[ "${count}" == 6 ]] || problems+=("console.env's grep count is ${count}, want 6")
  for f in gateway.env console.env; do
    [[ "$(stack_mode_of "${STACK_DIR}/${f}")" == "-rw-------" ]] || problems+=("${f} is $(stack_mode_of "${STACK_DIR}/${f}"), want -rw-------")
  done
  stack_secret_to_file "${STACK_DIR}/gateway.env" MINDSTONE_AGENT_GATEWAY_TOKEN "${GW_TOKEN_FILE}" || problems+=("no gateway token in gateway.env")
  stack_secret_to_file "${STACK_DIR}/console.env" MINDSTONE_ADMIN_TOKEN "${SECRETS_DIR}/admin-credential" || problems+=("no admin credential in console.env")
  write_header_files
  # A5: "Restart the gateway: … docker compose restart gateway".
  gateway_cmd restart >"${LOG_DIR}/gateway-restart.log" 2>&1 || problems+=("\`docker compose restart gateway\` failed")
  stack_wait_health 120 || problems+=("no /health after the restart")
  with=$(curl -s -o /dev/null -w '%{http_code}' -H @"${SECRETS_DIR}/h-auth" "${GW_URL}/v1/models")
  without=$(curl -s -o /dev/null -w '%{http_code}' "${GW_URL}/v1/models")
  [[ "${with}" == 200 && "${without}" == 401 ]] || problems+=("/v1/models with the token ${with} (want 200), without ${without} (want 401)")
  admin_status=$(curl -s -o "${SCRATCH}/admin-status.json" -w '%{http_code}' \
    -H @"${SECRETS_DIR}/h-auth" -H @"${SECRETS_DIR}/h-admin" \
    -H "x-mindstone-user-id: uat-harness" -H "x-mindstone-user-role: admin" \
    "${GW_URL}/admin/status" 2>/dev/null || true)
  onboarded=$(node -e 'try{const s=require(process.argv[1]);process.stdout.write(String(s.onboarded))}catch{process.stdout.write("unknown")}' "${SCRATCH}/admin-status.json" 2>/dev/null)
  echo "gateway_onboarded_before_console=${onboarded}" >>"${EVIDENCE}/run.env"
  if [[ ${#problems[@]} -eq 0 ]]; then
    record S5 PASS "Stack A2: console.env has the 6 secrets, gateway.env and console.env are -rw-------; \`docker compose restart gateway\` (A5); /v1/models 200 with the token, 401 without" \
      "${LOG_DIR}/gateway-restart.log" "admin /status ${admin_status}, onboarded=${onboarded}"
  else
    stack_compose logs --no-color --tail 80 gateway >"${LOG_DIR}/gateway.tail.log" 2>&1
    record S5 FAIL "Stack A2: secrets and gateway checks" "${LOG_DIR}/gateway.tail.log" "$(IFS=';'; echo "${problems[*]}")"
    die "stack A2 checks failed"
  fi
  CURRENT_STEP=""

  # =============================================================================
  # The Console, as the stack runs it (rows C0-C3)
  # =============================================================================
  log "mindstone-console: in the stack"
  # --- the Console reaches the gateway on the stack's network; the gateway reaches Ollama (A4) ---
  CURRENT_STEP=C0
  problems=()
  code=$(stack_compose exec -T console node -e 'fetch(process.env.MINDSTONE_GATEWAY_URL.replace(/\/v1\/?$/,"")+"/health").then(r=>process.stdout.write(String(r.status)),()=>process.stdout.write("000"))' 2>/dev/null | tr -d '\r')
  [[ "${code}" == 200 ]] || problems+=("the console container got ${code:-nothing} from the gateway's /health (MINDSTONE_GATEWAY_URL)")
  local ollama_code="not checked (provider ${PROVIDER})"
  if [[ "${PROVIDER}" == ollama ]]; then
    ollama_code=$(stack_compose exec -T gateway curl -s -o /dev/null -w '%{http_code}' -m 10 "${STACK_OLLAMA_BASE_URL%/v1}/api/tags" 2>/dev/null | tr -d '\r')
    [[ "${ollama_code}" == 200 ]] || problems+=("the gateway container got ${ollama_code:-nothing} from Ollama at ${STACK_OLLAMA_BASE_URL%/v1}/api/tags")
  fi
  if [[ ${#problems[@]} -eq 0 ]]; then
    record C0 PASS "Console in the stack: the console container reaches the gateway at http://gateway:19789; the gateway container reaches Ollama (A4 check prints 200)" "" \
      "console -> gateway /health ${code}; gateway -> ${STACK_OLLAMA_BASE_URL%/v1}/api/tags ${ollama_code}"
  else
    record C0 FAIL "Console in the stack: network checks" "" "$(IFS=';'; echo "${problems[*]}")"
    die "stack network checks"
  fi
  CURRENT_STEP=""

  # --- the Console's files, pinned to <console-ref> ---
  CURRENT_STEP=C1
  curl -fsSL "https://raw.githubusercontent.com/MindStone-Agent/mindstone-console/${STACK_CONSOLE_INSTALL_REF}/README.md" -o "${EVIDENCE}/console-README.md" 2>/dev/null || true
  if [[ -s "${STACK_DIR}/librechat.yaml" && -s "${STACK_DIR}/console.env.example" ]]; then
    record C1 PASS "Console in the stack: built from ${CONSOLE_REF} (${CONSOLE_SHA}); librechat.yaml and .env.example downloaded at that commit" "${EVIDENCE}/console-README.md"
  else
    record C1 FAIL "Console in the stack: librechat.yaml or console.env.example missing from the stack dir" ""; die "stack Console files"
  fi
  CURRENT_STEP=""

  # --- console.env ---
  CURRENT_STEP=C2
  problems=()
  local gurl reg digest want_digest
  gurl=$(stack_env_value "${STACK_DIR}/console.env" MINDSTONE_GATEWAY_URL)
  reg=$(stack_env_value "${STACK_DIR}/console.env" ALLOW_REGISTRATION)
  [[ "${gurl}" == "http://gateway:19789/v1" ]] || problems+=("MINDSTONE_GATEWAY_URL is ${gurl}")
  [[ "${reg}" == false ]] || problems+=("ALLOW_REGISTRATION is ${reg:-unset}, not false")
  # The gateway token is the same in both files; the gateway holds only the admin credential's sha256 (compared in
  # the shell, never printed).
  [[ "$(K=MINDSTONE_GATEWAY_TOKEN awk -F= '$1 == ENVIRON["K"] { sub(/^[^=]*=/, ""); v = $0 } END { printf "%s", v }' "${STACK_DIR}/console.env")" == "$(head -n 1 "${GW_TOKEN_FILE}")" ]] \
    || problems+=("console.env's gateway token isn't gateway.env's")
  digest=$(stack_env_value "${STACK_DIR}/gateway.env" MINDSTONE_ADMIN_TOKEN_SHA256)
  want_digest=$(printf %s "$(head -n 1 "${SECRETS_DIR}/admin-credential")" | { shasum -a 256 2>/dev/null || sha256sum; } | cut -d' ' -f1)
  [[ -n "${digest}" && "${digest}" == "${want_digest}" ]] || problems+=("gateway.env's MINDSTONE_ADMIN_TOKEN_SHA256 isn't the sha256 of console.env's MINDSTONE_ADMIN_TOKEN")
  grep -q '^MINDSTONE_ADMIN_TOKEN=' "${STACK_DIR}/gateway.env" && problems+=("gateway.env holds the admin credential itself")
  if [[ ${#problems[@]} -eq 0 ]]; then
    record C2 PASS "Console in the stack: console.env (600) with the gateway token from gateway.env, MINDSTONE_GATEWAY_URL http://gateway:19789/v1, registration off; the gateway has only the admin credential's sha256" "" \
      "grep count 6 (S5)"
  else
    record C2 FAIL "Console in the stack: console.env" "" "$(IFS=';'; echo "${problems[*]}")"; die "console.env checks"
  fi
  CURRENT_STEP=""

  # --- the running stack ---
  CURRENT_STEP=C3
  # The installed files (compose.yml and the harness's compose.override.yml), resolved as the installer resolves them.
  if ! stack_guard "${STACK_DIR}" "${LOG_DIR}/compose-guard-installed.log"; then
    STACK_COMPOSE_OK=0
    STACK_TEARDOWN_SKIP="compose-guard refused the installed compose files (C3)"
    record C3 FAIL "Console in the stack: the installed compose project isn't this run's alone" "${LOG_DIR}/compose-guard-installed.log" \
      "$(grep -v '^compose-guard' "${LOG_DIR}/compose-guard-installed.log" | head -3 | tr '\n' ' ')"
    die "compose-guard refused the installed stack"
  fi
  stack_compose ps >"${LOG_DIR}/compose-ps.txt" 2>&1
  running=$(stack_compose ps --status running --services 2>/dev/null | sort | tr '\n' ' ')
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:${CONSOLE_PORT}")
  if [[ "${code}" == 200 && "${running}" == *console* && "${running}" == *gateway* && "${running}" == *mongodb* ]]; then
    record C3 PASS "Console in the stack: gateway, console and mongodb running; / answers 200 (A3)" "${LOG_DIR}/compose-ps.txt" "$(tail -n 1 "${LOG_DIR}/compose-guard-installed.log")"
  else
    stack_compose logs --no-color --tail 80 console >"${LOG_DIR}/console.tail.log" 2>&1
    record C3 FAIL "Console in the stack: running services [${running}], / ${code}" "${LOG_DIR}/console.tail.log"; die "the stack's Console isn't up"
  fi
  CURRENT_STEP=""
}

# --- A3: sign in as the admin install-stack.sh created (row C4) ---------------------------------
stack_admin_step() {
  local code mode problems=()
  CURRENT_STEP=C4
  mode=$(stack_mode_of "${STACK_DIR}/admin-password") || true
  [[ "${mode}" == "-rw-------" ]] || problems+=("admin-password is ${mode:-missing}, want -rw-------")
  (umask 077; head -n 1 "${STACK_DIR}/admin-password" >"${SECRETS_DIR}/admin-password" 2>/dev/null) || : >"${SECRETS_DIR}/admin-password"
  grep -qF "Admin account created: ${ADMIN_EMAIL}" "${LOG_DIR}/stack-install.log" || problems+=("the installer didn't say \"Admin account created: ${ADMIN_EMAIL}\"")
  # README A3, as written: the request comes from stdin, so the password is in no argv; only the status is printed.
  code=$(printf '{"email":"%s","password":"%s"}' "${ADMIN_EMAIL}" "$(head -n 1 "${SECRETS_DIR}/admin-password")" \
    | curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data @- "http://127.0.0.1:${CONSOLE_PORT}/api/auth/login")
  [[ "${code}" == 200 ]] || problems+=("the login check printed ${code}, want 200")
  if [[ ${#problems[@]} -eq 0 ]]; then
    record C4 PASS "Stack A3: install-stack.sh created the admin (--admin-email; password in admin-password, 600); the README's login check prints 200" "${LOG_DIR}/stack-install.log"
  else
    record C4 FAIL "Stack A3: the admin account" "${LOG_DIR}/stack-install.log" "$(IFS=';'; echo "${problems[*]}")"; die "stack admin sign-in"
  fi
  CURRENT_STEP=""
}

# stack_teardown: the stack's logs, then `install-stack.sh --uninstall` for this dir (as the README's A5), then only
# this project's volumes and images (the installer keeps them on purpose; the run must leave nothing). Never prunes;
# never touches another project's containers, volumes or images. run-journey.sh's label sweep runs after this.
stack_teardown() {
  [[ "${STACK_STARTED}" == 1 || -f "${STACK_DIR}/compose.yml" ]] || return 0
  if [[ -f "${STACK_DIR}/compose.yml" ]]; then
    # Read only, and named by project (-p): safe whatever the installer did.
    stack_compose logs --no-color --timestamps gateway >"${LOG_DIR}/gateway.log" 2>&1
    stack_compose logs --no-color --timestamps console >"${LOG_DIR}/console.log" 2>&1
    stack_compose logs --no-color --timestamps mongodb >"${LOG_DIR}/mongodb.log" 2>&1
  fi
  if [[ "${STACK_PROJECT_OK}" != 1 || "${STACK_COMPOSE_OK}" != 1 ]]; then
    echo "stack teardown: install-stack.sh --uninstall and down -v SKIPPED: ${STACK_TEARDOWN_SKIP:-unchecked}; only what carries the label com.docker.compose.project=${PROJECT} is removed" >>"${LOG_DIR}/teardown.log"
    return 0
  fi
  # The installer's own uninstall (README A5). It takes the project from .env, which was checked to be ${PROJECT}.
  if [[ -s "${STACK_INSTALLER_COPY}" ]]; then
    echo "\$ install-stack.sh --dir <scratch>/stack --uninstall" >>"${LOG_DIR}/teardown.log"
    env "${STACK_UNSET[@]}" bash "${STACK_INSTALLER_COPY}" --dir "${STACK_DIR}" --uninstall >>"${LOG_DIR}/teardown.log" 2>&1 \
      || echo "install-stack.sh --uninstall exited $?" >>"${LOG_DIR}/teardown.log"
  fi
  # What --uninstall keeps on purpose (the volumes), for this project only (-p) and the guarded file only.
  stack_compose --profile ollama down -v --remove-orphans --timeout 10 >>"${LOG_DIR}/teardown.log" 2>&1
  return 0
}
