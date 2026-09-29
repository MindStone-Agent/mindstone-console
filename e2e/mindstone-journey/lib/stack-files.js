'use strict';
// The gateway's files in the harness's stack mode (run-journey.sh with UAT_INSTALL=stack, MindStone-Agent #171).
//
// Natively the gateway's data dir, transcripts, Pi sessions and log are files on this host, and the journey reads
// them in place. In the stack they live in the gateway container's Docker volumes, so before a step reads them,
// refresh() copies them out with `docker compose cp` (the log with `docker compose logs`) into a host mirror in the
// scratch dir, and the step reads the mirror as it would the native files. The container is only read, except for
// removeInGateway (J12's USER.md restore), which removes one file inside it with `docker compose exec`.
//
// Without UAT_INSTALL=stack every function here is a no-op (refresh returns false, hostPath returns its input), so
// the native path is unchanged.
//
// Set by run-journey.sh in stack mode:
//   UAT_STACK_PROJECT               the Compose project (the harness's own, never another one)
//   UAT_STACK_DIR                   the stack's install dir (compose.yml and its env files)
//   UAT_STACK_MIRROR                the host mirror, in the scratch dir
//   UAT_STACK_GATEWAY_DATA_DIR      the gateway's data dir in its container (MINDSTONE_AGENT_DATA_DIR there)
//   UAT_STACK_GATEWAY_SESSIONS_DIR  Pi's session dir in the gateway container (PI_CODING_AGENT_SESSION_DIR there)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const KEYS = ['UAT_STACK_PROJECT', 'UAT_STACK_DIR', 'UAT_STACK_MIRROR', 'UAT_STACK_GATEWAY_DATA_DIR', 'UAT_STACK_GATEWAY_SESSIONS_DIR'];
/** A copy younger than this is reused: a step often reads the same files several times in a row. */
const MIN_INTERVAL_MS = 500;
const fresh = new Map();

function stack(env = process.env) {
  if (env.UAT_INSTALL !== 'stack') return undefined;
  const missing = KEYS.filter((key) => !env[key]);
  if (missing.length) throw new Error(`stack mode without ${missing.join(', ')} (run through run-journey.sh)`);
  return {
    project: env.UAT_STACK_PROJECT,
    dir: env.UAT_STACK_DIR,
    mirror: env.UAT_STACK_MIRROR,
    dataDir: env.UAT_STACK_GATEWAY_DATA_DIR.replace(/\/+$/, ''),
    sessionsDir: env.UAT_STACK_GATEWAY_SESSIONS_DIR.replace(/\/+$/, ''),
  };
}

/** `docker compose` for the harness's project only (-p and the stack's own compose files, never a default). */
function compose(s, args) {
  const files = ['-f', path.join(s.dir, 'compose.yml')];
  // The stack's own local changes, as install-stack.sh and run-journey.sh include them.
  if (fs.existsSync(path.join(s.dir, 'compose.override.yml'))) files.push('-f', path.join(s.dir, 'compose.override.yml'));
  return execFileSync('docker', ['compose', '-p', s.project, '--project-directory', s.dir, ...files, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Copies a folder out of the gateway container, replacing the mirror's copy whole (a file removed there goes here too). */
function copyOut(s, from, to) {
  const tmp = `${to}.copy-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    compose(s, ['cp', `gateway:${from}/.`, tmp]);
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const detail = String(error.stderr || error.message).trim().split('\n').pop();
    throw new Error(`stack mode: couldn't copy ${from} out of the gateway container (${detail})`);
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(tmp, to);
}

/**
 * Brings the mirror up to date: 'data' (the data dir: config, transcripts, records, the recall index), 'sessions'
 * (Pi's session files) or 'log' (the gateway container's log). False when not in stack mode.
 */
function refresh(what) {
  const s = stack();
  if (!s) return false;
  if (Date.now() - (fresh.get(what) ?? 0) < MIN_INTERVAL_MS) return true;
  fs.mkdirSync(s.mirror, { recursive: true, mode: 0o700 });
  if (what === 'data') copyOut(s, s.dataDir, path.join(s.mirror, 'data'));
  else if (what === 'sessions') copyOut(s, s.sessionsDir, path.join(s.mirror, 'pi-sessions'));
  else if (what === 'log') fs.writeFileSync(path.join(s.mirror, 'gateway.log'), compose(s, ['logs', '--no-color', '--no-log-prefix', 'gateway']));
  else throw new Error(`stack-files: nothing called ${what}`);
  fresh.set(what, Date.now());
  return true;
}

/** A path the gateway recorded (inside its container) as the mirror's copy of it; natively, the path itself. */
function hostPath(file) {
  const s = stack();
  if (!s || typeof file !== 'string') return file;
  if (file === s.sessionsDir || file.startsWith(`${s.sessionsDir}/`)) {
    refresh('sessions');
    return path.join(s.mirror, 'pi-sessions', file.slice(s.sessionsDir.length));
  }
  if (file === s.dataDir || file.startsWith(`${s.dataDir}/`)) {
    refresh('data');
    return path.join(s.mirror, 'data', file.slice(s.dataDir.length));
  }
  return file;
}

/**
 * Removes one file, given relative to the data dir, inside the gateway container (and from the mirror). The caller
 * has already checked the path (J12: a USER.md under agents/). False when not in stack mode.
 */
function removeInGateway(relative) {
  const s = stack();
  if (!s) return false;
  const rel = path.posix.normalize(String(relative).split(path.sep).join('/'));
  if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel)) throw new Error(`stack-files: refusing to remove ${relative}`);
  compose(s, ['exec', '-T', 'gateway', 'rm', '-f', '--', `${s.dataDir}/${rel}`]);
  fs.rmSync(path.join(s.mirror, 'data', rel), { force: true });
  fresh.delete('data');
  return true;
}

module.exports = { refresh, hostPath, removeInGateway, stackMode: () => Boolean(stack()) };
