// Where this machine keeps the agent token aMessage issued on connect, and a
// phone or email verification waiting for its code.
// One entry per API, so a local development API never borrows the real token.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A setting from the environment, always named `AMESSAGE_<NAME>`. Empty when unset.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 */
export function setting(env, name) {
  return env[`AMESSAGE_${name}`]?.trim() || "";
}

/**
 * @typedef {{ agent_id: string, token: string, connected_at: string }} Credentials
 * @typedef {{ id: string, contact: { email: string } | { phone: string }, method: string, expires_at: string }} Verification
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
export function configDir(env, home) {
  const chosen = setting(env, "CONFIG_DIR");
  if (chosen) return chosen;
  if (process.platform === "win32" && env.APPDATA?.trim()) return join(env.APPDATA.trim(), "amessage");
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "amessage");
}

/** @param {NodeJS.ProcessEnv} env @param {string} home */
export function credentialsFile(env, home) {
  return join(configDir(env, home), "credentials.json");
}

/** The phone or email verification this agent started and has not finished. @param {NodeJS.ProcessEnv} env @param {string} home */
export function verificationFile(env, home) {
  return join(configDir(env, home), "verification.json");
}

/** @param {string} file @returns {Promise<Record<string, any>>} */
async function readAll(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return {};
    throw new Error(`Could not read ${file}. Fix or delete it, then try again.`);
  }
}

/** @param {string} file @param {Record<string, any>} all */
async function writeAll(file, all) {
  const dir = join(file, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** @param {string} file @param {string} api @param {unknown} entry */
async function saveEntry(file, api, entry) {
  const all = await readAll(file);
  all[api] = entry;
  await writeAll(file, all);
}

/** @param {string} file @param {string} api */
async function forgetEntry(file, api) {
  const all = await readAll(file);
  if (!all[api]) return false;
  delete all[api];
  if (Object.keys(all).length) await writeAll(file, all);
  else await rm(file, { force: true });
  return true;
}

/** @param {string} file @param {string} api @returns {Promise<Credentials | null>} */
export async function loadCredentials(file, api) {
  const entry = (await readAll(file))[api];
  return entry?.token ? entry : null;
}

/** @param {string} file @param {string} api @param {Credentials} credentials */
export const saveCredentials = (file, api, credentials) => saveEntry(file, api, credentials);

/** @param {string} file @param {string} api */
export const forgetCredentials = (file, api) => forgetEntry(file, api);

/** @param {string} file @param {string} api @returns {Promise<Verification | null>} */
export async function loadVerification(file, api) {
  const entry = (await readAll(file))[api];
  return entry?.id ? entry : null;
}

/** @param {string} file @param {string} api @param {Verification} verification */
export const saveVerification = (file, api, verification) => saveEntry(file, api, verification);

/** @param {string} file @param {string} api */
export const forgetVerification = (file, api) => forgetEntry(file, api);

// Keys for encrypted chats, shared with the aMessage SDKs: one entry per API and agent, with the
// private keys that never leave this machine. Owner-only, like the token.

/**
 * @typedef {{ key_id: string, private: string, public_key: string, expires_at: string, signature: string }} StoredMessageKey
 * @typedef {{ text: string, sent_at: string }} SentCopy
 * @typedef {{ identity: { private: string, public: string }, message_keys: StoredMessageKey[], pins: Record<string, string> }} KeyEntry
 */

/** @param {NodeJS.ProcessEnv} env @param {string} home */
export function keysFile(env, home) {
  return join(configDir(env, home), "keys.json");
}

/** What this machine sent encrypted, since a sender can't open its own envelopes. @param {NodeJS.ProcessEnv} env @param {string} home */
export function sentFile(env, home) {
  return join(configDir(env, home), "sent.json");
}

/** Every agent's keys for this API, by agent id. @param {string} file @param {string} api @returns {Promise<Record<string, KeyEntry>>} */
export async function loadKeyring(file, api) {
  const entry = (await readAll(file))[api];
  return entry && typeof entry === "object" ? entry : {};
}

/**
 * Change one agent's keys as they are on disk now, so two commands at once never undo each
 * other's keys. `change` gets the entry (or null) and returns the new one.
 * @param {string} file @param {string} api @param {string} agentId
 * @param {(entry: KeyEntry | null) => KeyEntry} change
 */
export async function updateKeyEntry(file, api, agentId, change) {
  const all = await readAll(file);
  const ring = all[api] && typeof all[api] === "object" ? all[api] : {};
  const entry = change(ring[agentId] ?? null);
  all[api] = { ...ring, [agentId]: entry };
  await writeAll(file, all);
  return entry;
}

/** @param {string} file @param {string} api @param {string} agentId @returns {Promise<Record<string, SentCopy>>} */
export async function loadSent(file, api, agentId) {
  const entry = (await readAll(file))[api]?.[agentId];
  return entry && typeof entry === "object" ? entry : {};
}

/** Copies are kept as long as aMessage keeps the messages: 180 days. */
const KEEP_SENT_MS = 180 * 86_400_000;

/**
 * Keep copies of messages sent encrypted, by message id, and drop those older than 180 days.
 * @param {string} file @param {string} api @param {string} agentId @param {Record<string, SentCopy>} copies @param {Date} [now]
 */
export async function addSent(file, api, agentId, copies, now = new Date()) {
  const all = await readAll(file);
  all[api] ??= {};
  /** @type {Record<string, SentCopy>} */
  const kept = {};
  for (const [id, copy] of Object.entries({ ...(all[api][agentId] ?? {}), ...copies })) {
    const at = new Date(copy?.sent_at).getTime();
    if (typeof copy?.text === "string" && Number.isFinite(at) && now.getTime() - at < KEEP_SENT_MS) kept[id] = copy;
  }
  all[api][agentId] = kept;
  await writeAll(file, all);
}
