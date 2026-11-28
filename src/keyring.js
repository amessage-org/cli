// This agent's side of encrypted chats: its keys in keys.json (an identity key, and a key for
// each UTC day, published a week at a time), the fingerprints it pinned for its chat partners,
// sealing what it sends and opening what it gets, copies of what it sent in sent.json (it can't
// open its own envelopes: they're sealed to the recipient's key), and the commitments it opened
// in seen.json, to drop replays. Private keys stay in keys.json: nothing here prints them, sends
// them or returns them.

import { ApiError } from "./api.js";
import { addSeen, addSent, loadKeyring, loadSeen, loadSent, updateKeyEntry } from "./config.js";
import {
  b64,
  DAY_MS,
  DAYS_AHEAD,
  dayStart,
  envelopeBytes,
  fingerprint,
  generateIdentity,
  generateXWing,
  identityPublicOf,
  isBytes,
  isEnvelope,
  isOneDay,
  keyId,
  keysProblem,
  MAX_DAYS,
  MAX_ENVELOPE_BYTES,
  messageKeyFor,
  messageKeyStatement,
  openMessage,
  PUBLIC_BYTES,
  sealMessage,
  unb64,
  verifyWith,
  xwingPublicKey,
} from "./e2e.js";

/** Day keys are published again when fewer than this many days of them are left. */
export const PUBLISH_BELOW_DAYS = 3;
/** Private day keys are kept as long as aMessage keeps the messages sealed to them. */
const KEEP_KEYS_MS = 180 * DAY_MS;
export const COULD_NOT_OPEN = "(couldn't open this encrypted message)";
export const NO_COPY = "(sent encrypted; no copy on this machine)";

/** Something about encrypted chats that stops a command, with what to do next. */
export class E2EError extends Error {
  /** @param {string} message @param {string | null} [next] */
  constructor(message, next = null) {
    super(message);
    this.next = next;
  }
}

/** A chat partner's fingerprint isn't the one pinned: nothing goes to them encrypted until it's accepted. */
export class KeyChanged extends E2EError {
  /** @param {string} agent @param {string} pinned @param {string} now */
  constructor(agent, pinned, now) {
    super(
      [
        `The keys of agent ${agent} changed. Nothing was sent.`,
        `Their fingerprint was ${spaced(pinned)}`,
        `and aMessage now gives ${spaced(now)}.`,
        "They may have made new keys, on a new machine for example. Or someone may be trying to read the chat.",
      ].join("\n"),
      `Check the new fingerprint with them some other way, then accept it with: amessage keys trust ${agent}`,
    );
    this.agent = agent;
  }
}

/** A fingerprint in groups of four, easier to compare by eye. @param {string} value */
export function spaced(value) {
  return String(value).match(/.{1,4}/g)?.join(" ") ?? "";
}

/**
 * @typedef {import("./config.js").KeyEntry} KeyEntry
 * @typedef {import("./config.js").StoredMessageKey} StoredMessageKey
 * @typedef {import("./api.js").AgentKeys} AgentKeys
 * @typedef {import("./api.js").Recipient} Recipient
 * @typedef {{ agentId: string, entry: KeyEntry }} Own
 * @typedef {{ ok: true, text: string, verified: boolean, mine: boolean, franking_key: string | null }
 *   | { ok: false, reason: string, mine: boolean }} Opened
 */

/**
 * The day keys this identity signed, by day. (Keys an older identity signed still open the
 * messages sealed to them, but aren't published again.)
 * @param {KeyEntry} entry
 */
function signedDayKeys(entry) {
  const identity = unb64(entry.identity.public);
  return (entry.message_keys ?? [])
    .filter((k) => isOneDay(k.valid_from, k.expires_at) && verifyWith(identity, messageKeyStatement(k.public_key, k.valid_from, k.expires_at), k.signature))
    .sort((a, b) => Date.parse(a.valid_from) - Date.parse(b.valid_from));
}

/** The day key messages are sealed to on the day `at` falls in, or null. @param {KeyEntry} entry @param {Date} [at] */
export function currentKey(entry, at = new Date()) {
  const t = at.getTime();
  return signedDayKeys(entry).find((k) => Date.parse(k.valid_from) <= t && t < Date.parse(k.expires_at)) ?? null;
}

/** The end of the last day this identity has a key for here, or null. @param {KeyEntry} entry @returns {string | null} */
export function keysUntil(entry) {
  return signedDayKeys(entry).at(-1)?.expires_at ?? null;
}

/** Whether day keys that last until `until` are enough, or it is time to publish more. @param {unknown} until @param {number} [now] */
export function enoughLeft(until, now = Date.now()) {
  const end = typeof until === "string" ? Date.parse(until) : NaN;
  return Number.isFinite(end) && end - now >= PUBLISH_BELOW_DAYS * DAY_MS;
}

/** A stored day key without its private half. @param {StoredMessageKey} key @returns {import("./e2e.js").MessageKey} */
export const publicPart = (key) => ({ key_id: key.key_id, public_key: key.public_key, valid_from: key.valid_from, expires_at: key.expires_at, signature: key.signature });

/**
 * The entry with a day key for each of the next 7 days from today, made where one is missing,
 * and without the day keys whose day ended more than 180 days ago. Also the keys it made.
 * @param {KeyEntry} entry @param {Date} [now] @returns {{ entry: KeyEntry, made: StoredMessageKey[] }}
 */
export function withWeekAhead(entry, now = new Date()) {
  const have = new Set(signedDayKeys(entry).map((k) => k.valid_from));
  const identityPrivate = unb64(entry.identity.private);
  /** @type {StoredMessageKey[]} */
  const made = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const day = new Date(dayStart(now).getTime() + i * DAY_MS);
    if (have.has(day.toISOString())) continue;
    const key = messageKeyFor(identityPrivate, generateXWing().privateKey, day);
    // In the order keys.json keeps them.
    made.push({
      key_id: key.public.key_id,
      private: b64(key.privateKey),
      public_key: key.public.public_key,
      valid_from: key.public.valid_from,
      expires_at: key.public.expires_at,
      signature: key.public.signature,
    });
  }
  const kept = (entry.message_keys ?? []).filter((k) => now.getTime() - Date.parse(k.expires_at) < KEEP_KEYS_MS);
  return { entry: { ...entry, message_keys: [...kept, ...made] }, made };
}

/** A new identity and its day keys for the next 7 days. @param {Date} [now] @returns {KeyEntry} */
export function newEntry(now = new Date()) {
  const identity = generateIdentity();
  /** @type {KeyEntry} */
  const entry = { identity: { private: b64(identity.privateKey), public: b64(identity.publicKey) }, message_keys: [], pins: {} };
  return withWeekAhead(entry, now).entry;
}

/**
 * Whether an entry read from an export is whole: each public key is its private key's, each key
 * id its key's, and each day key covers one UTC day. Version 1 message keys (without valid_from)
 * are dropped, as from keys.json. Throws when not.
 * @param {any} entry @returns {KeyEntry}
 */
export function checkEntry(entry) {
  const bad = (/** @type {string} */ why) => new Error(`The export doesn't hold usable keys: ${why}.`);
  if (!entry || typeof entry !== "object" || !isBytes(entry.identity?.private, 32) || !isBytes(entry.identity?.public, 32)) throw bad("no identity key");
  if (!identityPublicOf(unb64(entry.identity.private)).equals(unb64(entry.identity.public))) throw bad("the identity key doesn't match itself");
  if (!Array.isArray(entry.message_keys)) throw bad("no day keys");
  const keys = entry.message_keys.filter((/** @type {any} */ key) => typeof key?.valid_from === "string");
  for (const key of keys) {
    if (!isBytes(key.private, 32) || !isBytes(key.public_key, PUBLIC_BYTES)) throw bad("a day key isn't the right size");
    if (!xwingPublicKey(unb64(key.private)).equals(unb64(key.public_key)) || key.key_id !== keyId(unb64(key.public_key)))
      throw bad("a day key doesn't match itself");
    if (!isOneDay(key.valid_from, key.expires_at) || typeof key.signature !== "string") throw bad("a day key doesn't cover one UTC day");
  }
  const pins = entry.pins && typeof entry.pins === "object" ? entry.pins : {};
  for (const value of Object.values(pins)) if (!/^[0-9a-f]{64}$/.test(String(value))) throw bad("a pinned fingerprint isn't one");
  /** @type {StoredMessageKey[]} */
  const message_keys = keys.map((/** @type {StoredMessageKey} */ k) => ({
    key_id: k.key_id,
    private: k.private,
    public_key: k.public_key,
    valid_from: k.valid_from,
    expires_at: k.expires_at,
    signature: k.signature,
  }));
  return { identity: { private: entry.identity.private, public: entry.identity.public }, message_keys, pins };
}

/** @type {WeakMap<object, ReturnType<typeof keyring>>} */
const rings = new WeakMap();

/**
 * The keyring of the agent a command runs as, made once per command.
 * @param {import("./main.js").Context} ctx @param {import("./api.js").Client} client
 */
export function keyringOf(ctx, client) {
  let ring = rings.get(ctx);
  if (!ring) rings.set(ctx, (ring = keyring(ctx, client)));
  return ring;
}

/** @param {import("./main.js").Context} ctx @param {import("./api.js").Client} client */
function keyring(ctx, client) {
  let agentId = /** @type {string | null} */ (null);
  /** @type {Map<string, { at: number, keys: Promise<AgentKeys | null> }>} */
  const senders = new Map();
  let checkedFresh = 0;

  async function whoAmI() {
    if (agentId) return agentId;
    const saved = await ctx.credentials();
    agentId = saved?.agent_id ?? (await client.me()).agent_id;
    if (!agentId) throw new Error("aMessage did not say which agent this is.");
    return agentId;
  }

  /**
   * This agent's keys on this machine, or null. Read from disk every time, so a long-running MCP
   * server sees keys published from a terminal. Asks the API who this is only when there are keys.
   * @returns {Promise<Own | null>}
   */
  async function mine() {
    const ring = await loadKeyring(ctx.keysFile, ctx.api);
    if (!Object.keys(ring).length) return null;
    const id = await whoAmI();
    return ring[id] ? { agentId: id, entry: ring[id] } : null;
  }

  /** @param {(entry: KeyEntry | null) => KeyEntry} change */
  async function update(change) {
    return updateKeyEntry(ctx.keysFile, ctx.api, await whoAmI(), change);
  }

  /**
   * Publish the identity and its day keys that haven't ended, today's among them: PUT /v1/me/keys
   * takes them as a list.
   * @param {KeyEntry} entry
   */
  async function publish(entry) {
    if (!currentKey(entry)) throw new E2EError("This agent's keys have no day key for today.", "Make one with: amessage keys create");
    const now = Date.now();
    const keys = signedDayKeys(entry).filter((k) => Date.parse(k.expires_at) > now);
    return client.publishKeys({ identity_key: entry.identity.public, message_keys: keys.slice(0, MAX_DAYS).map(publicPart) });
  }

  /**
   * Day keys for each of the next 7 days, made where missing, kept and published. Keys made here
   * that the publish didn't take are dropped again, so the next command tries anew. Unless
   * `replacing` (the person said yes), it never publishes over an identity another machine holds:
   * GET /v1/me names it even when its day keys ran out.
   * @param {boolean} [replacing]
   */
  async function renew(replacing = false) {
    const own = await mine();
    if (!own) throw new E2EError("This agent has no keys for encrypted chats yet.", "Make them with: amessage keys create");
    if (!replacing) {
      const there = (await client.me())?.encryption?.fingerprint;
      if (there && there !== fingerprint(unb64(own.entry.identity.public)))
        throw new E2EError(
          `aMessage has other keys for this agent (fingerprint ${spaced(there)}), made on another machine, so none were published from here.`,
          "Publish the keys on this machine in their place with: amessage keys create, or bring the others here with: amessage keys import <file>",
        );
    }
    /** @type {StoredMessageKey[]} */
    let made = [];
    const entry = await update((e) => {
      const next = withWeekAhead(e ?? own.entry);
      made = next.made;
      return next.entry;
    });
    try {
      await publish(entry);
    } catch (error) {
      const unpublished = new Set(made.map((k) => k.key_id));
      if (unpublished.size) await update((e) => ({ ...(e ?? entry), message_keys: (e ?? entry).message_keys.filter((k) => !unpublished.has(k.key_id)) }));
      throw error;
    }
    return entry;
  }

  /**
   * Before any chat command: the next week's day keys, published when fewer than 3 days of them
   * are left. A failed publish never stops the command; it says so, and the next command tries again.
   */
  async function fresh() {
    const own = await mine();
    if (!own) return null;
    // A long-running MCP server checks at most once a minute.
    if (Date.now() - checkedFresh < 60_000) return own;
    checkedFresh = Date.now();
    if (enoughLeft(keysUntil(own.entry))) return own;
    try {
      const entry = await renew();
      ctx.note(`Published new keys for encrypted chats; they last until ${String(keysUntil(entry)).slice(0, 10)}.`);
    } catch (error) {
      ctx.warn(`Could not publish new keys for encrypted chats: ${/** @type {Error} */ (error).message}`);
    }
    return mine();
  }

  /**
   * The keys a message to `to` is sealed with, checked, or null when they have none.
   * @param {Recipient} to
   * @returns {Promise<AgentKeys | null>}
   */
  async function recipientKeys(to) {
    /** @type {AgentKeys | null} */
    let keys = null;
    let expected = /** @type {string | null} */ (null);
    if ("conversation_id" in to) {
      const chat = await client.conversation(to.conversation_id);
      expected = chat?.counterpart?.agent_id ?? null;
      if (!expected || chat?.counterpart?.encryption === null) return null;
      keys = await client.agentKeys(expected);
    } else if ("agent_id" in to) {
      expected = to.agent_id;
      keys = await client.agentKeys(to.agent_id);
    } else if ("phone" in to || "email" in to) {
      keys = await client.keyLookup(to);
    } else {
      return null;
    }
    if (!keys) return null;
    const problem = keysProblem(keys) ?? (expected && keys.agent_id !== expected ? "they belong to another agent" : null);
    if (problem) throw new E2EError(`aMessage gave keys for agent ${keys.agent_id ?? expected} that don't hold together: ${problem}. Nothing was sent.`);
    return keys;
  }

  /** Pin their fingerprint the first time; refuse a changed one. @param {AgentKeys} theirs */
  async function checkPin(theirs) {
    const own = await mine();
    const pinned = own?.entry.pins?.[theirs.agent_id];
    if (pinned && pinned !== theirs.fingerprint) throw new KeyChanged(theirs.agent_id, pinned, theirs.fingerprint);
    if (!pinned) await pin(theirs.agent_id, theirs.fingerprint);
  }

  /** @param {string} agent @param {string} value */
  async function pin(agent, value) {
    await update((e) => {
      if (!e) throw new E2EError("This agent has no keys for encrypted chats yet.", "Make them with: amessage keys create");
      return { ...e, pins: { ...(e.pins ?? {}), [agent]: value } };
    });
  }

  /** Seal `text` to them. @param {Own} own @param {AgentKeys} theirs @param {string} text */
  function seal(own, theirs, text) {
    const envelope = sealMessage({
      text,
      from: own.agentId,
      to: theirs.agent_id,
      identityPrivate: unb64(own.entry.identity.private),
      identityPublic: unb64(own.entry.identity.public),
      recipientKey: theirs.message_key,
    });
    const size = envelopeBytes(envelope);
    if (size > MAX_ENVELOPE_BYTES)
      throw new E2EError(`This message is too long to send encrypted: sealed, it is ${size.toLocaleString("en-US")} bytes, and the most is ${MAX_ENVELOPE_BYTES.toLocaleString("en-US")}. Shorten it.`);
    return envelope;
  }

  /**
   * What to send to `to`: sealed when both sides have keys (or refused, with `encrypted`), else plain.
   * @param {Recipient} to @param {string} text @param {"auto" | "encrypted" | "plain"} mode @param {string} who How to name them
   * @param {string | null} [instead] What to do instead when they have no keys
   * @returns {Promise<{ body: { text: string } | { encrypted: import("./e2e.js").Envelope }, theirs: AgentKeys | null }>}
   */
  async function prepare(to, text, mode, who, instead = "Leave out --encrypted to send it plain.") {
    const plain = { body: { text }, theirs: null };
    if (mode === "plain") return plain;
    const own = await fresh();
    if (!own) {
      if (mode === "auto") return plain;
      throw new E2EError("This agent has no keys for encrypted chats yet, so nothing was sent.", "Make them with: amessage keys create");
    }
    const theirs = await recipientKeys(to);
    if (!theirs) {
      if (mode === "auto") return plain;
      throw new E2EError(`${who} has no keys for encrypted chats yet, so nothing was sent.`, instead);
    }
    await checkPin(theirs);
    return { body: { encrypted: seal(own, theirs, text) }, theirs };
  }

  /**
   * Send one message, sealed when it can be (see prepare). A stale key gets their keys again and
   * seals once more. Keeps a copy of what was sent encrypted.
   * @param {Recipient} to @param {string} text @param {"auto" | "encrypted" | "plain"} mode
   * @param {{ who: string, replyTo?: string, key?: string }} options
   */
  async function send(to, text, mode, { who, replyTo, key }) {
    let prepared = await prepare(to, text, mode, who);
    let sent;
    try {
      sent = await client.send(to, prepared.body, { replyTo, key });
    } catch (error) {
      if (!("encrypted" in prepared.body) || !(error instanceof ApiError) || error.code !== "stale_key") throw error;
      prepared = await prepare(to, text, "encrypted", who);
      sent = await client.send(to, prepared.body, { replyTo, key });
    }
    const encrypted = "encrypted" in prepared.body;
    if (encrypted) await remember(sent, text);
    return { sent, encrypted };
  }

  /** Keep a copy of a message sent encrypted, by its message id. @param {any} sent @param {string} text */
  async function remember(sent, text) {
    const id = sent?.message_id ?? sent?.id;
    if (typeof id !== "string") return;
    try {
      await addSent(ctx.sentFile, ctx.api, await whoAmI(), { [id]: { text, sent_at: new Date().toISOString() } });
    } catch (error) {
      ctx.warn(`Sent, but no copy is kept on this machine: ${/** @type {Error} */ (error).message}`);
    }
  }

  /** A sender's published keys, asked for at most once a minute (amessage mcp and watch run long). @param {string} agent */
  function senderKeys(agent) {
    const known = senders.get(agent);
    if (known && Date.now() - known.at < 60_000) return known.keys;
    const keys = client.agentKeys(agent).catch(() => null);
    senders.set(agent, { at: Date.now(), keys });
    return keys;
  }

  /**
   * Open the envelope of every message given that has one: theirs with this machine's keys, this
   * agent's own from the copies kept when it sent them. An envelope whose commitment was opened
   * before under another message id is a replay, and isn't opened; the same message read again is.
   * @param {any[]} messages
   * @returns {Promise<Map<any, Opened>>}
   */
  async function openAll(messages) {
    /** @type {Map<any, Opened>} */
    const opened = new Map();
    const sealed = messages.filter((m) => m && m.encrypted);
    if (!sealed.length) return opened;
    const own = await mine().catch(() => null);
    const me = own?.agentId ?? (await whoAmI().catch(() => null));
    const copies = me ? await loadSent(ctx.sentFile, ctx.api, me) : {};
    const seen = { before: me ? await loadSeen(ctx.seenFile, ctx.api, me) : {}, added: /** @type {Record<string, import("./config.js").SeenCommitment>} */ ({}) };
    // Oldest first, so of two messages with the same commitment, the later one is the replay.
    const when = (/** @type {any} */ m) => {
      const at = Date.parse(m.posted_at);
      return Number.isFinite(at) ? at : Infinity;
    };
    for (const message of [...sealed].sort((a, b) => when(a) - when(b) || 0)) opened.set(message, await openOne(own, me, copies, seen, message));
    if (me && Object.keys(seen.added).length) {
      try {
        await addSeen(ctx.seenFile, ctx.api, me, seen.added);
      } catch (error) {
        ctx.warn(`Could not keep what was opened, to drop replays: ${/** @type {Error} */ (error).message}`);
      }
    }
    return opened;
  }

  /**
   * @param {Own | null} own @param {string | null} me @param {Record<string, import("./config.js").SentCopy>} copies
   * @param {{ before: Record<string, import("./config.js").SeenCommitment>, added: Record<string, import("./config.js").SeenCommitment> }} seen
   * @param {any} message
   * @returns {Promise<Opened>}
   */
  async function openOne(own, me, copies, seen, message) {
    const sender = message.sender_agent_id;
    if (me && sender === me) {
      const copy = copies[message.id];
      return copy ? { ok: true, text: copy.text, verified: true, mine: true, franking_key: null } : { ok: false, reason: "sent encrypted; no copy on this machine", mine: true };
    }
    const fail = (/** @type {string} */ reason) => /** @type {Opened} */ ({ ok: false, reason, mine: false });
    const envelope = message.encrypted;
    if (!own) return fail("this agent has no keys on this machine");
    if (!isEnvelope(envelope)) return fail("it isn't an envelope this version reads");
    const key = own.entry.message_keys.find((k) => k.key_id === envelope.recipient_key);
    if (!key) return fail("it was sealed to a key this machine doesn't have");
    const theirs = typeof sender === "string" ? await senderKeys(sender) : null;
    if (!theirs || theirs.fingerprint !== envelope.sender_key || fingerprint(unb64(theirs.identity_key)) !== theirs.fingerprint)
      return fail("the sender's key isn't the one aMessage has for them");
    try {
      const payload = openMessage({
        envelope,
        messagePrivate: unb64(key.private),
        senderIdentityPublic: unb64(theirs.identity_key),
        me: own.agentId,
        sender,
      });
      // A message with no id can't be told apart from a replay of one already opened.
      const id = typeof message.id === "string" ? message.id : null;
      const before = seen.before[envelope.commitment];
      if (before && before.message_id !== id) return fail("it repeats a message opened before (a replay)");
      if (!before && id) seen.before[envelope.commitment] = seen.added[envelope.commitment] = { message_id: id, opened_at: new Date().toISOString() };
      const pinned = own.entry.pins?.[sender];
      if (!pinned) {
        await pin(sender, envelope.sender_key);
        own.entry.pins = { ...own.entry.pins, [sender]: envelope.sender_key };
      }
      return { ok: true, text: payload.text, verified: !pinned || pinned === envelope.sender_key, mine: false, franking_key: payload.franking_key };
    } catch (error) {
      return fail(/** @type {Error} */ (error).message);
    }
  }

  /**
   * A message as the API gave it, with `opened` added when it is encrypted: {text, verified}, or
   * null and `open_error` when it couldn't be opened.
   * @param {any} message @param {Opened | undefined} result
   */
  function withOpened(message, result) {
    if (!message?.encrypted || !result) return message;
    if (result.ok) return { ...message, opened: { text: result.text, verified: result.verified } };
    return { ...message, opened: null, open_error: result.reason };
  }

  /** Every private key this agent has here, in the encodings one might be pasted in. */
  async function secrets() {
    const own = await mine().catch(() => null);
    if (!own) return [];
    const raw = [own.entry.identity.private, ...own.entry.message_keys.map((k) => k.private)].map(unb64);
    return raw.flatMap((bytes) => [b64(bytes), bytes.toString("base64").replace(/=+$/, ""), bytes.toString("hex")]);
  }

  /**
   * What aMessage has for this agent: its identity's fingerprint, from GET /v1/me, which gives it
   * even after its day keys ran out (when GET /v1/me/keys says 404), and its keys for today, with
   * keys_until, when it has them.
   * @returns {Promise<{ fingerprint: string | null, keys: import("./api.js").MyKeys | null }>}
   */
  async function published() {
    const [me, keys] = await Promise.all([client.me(), client.myKeys()]);
    // A server without `encryption` on /v1/me: its keys are the only answer.
    const fp = me?.encryption === undefined ? (keys?.fingerprint ?? null) : (me.encryption?.fingerprint ?? null);
    return { fingerprint: fp, keys: fp && keys?.fingerprint === fp ? keys : null };
  }

  /**
   * Make this agent's keys and publish them, or publish the ones kept here when aMessage doesn't
   * have them. `replacing` is asked first when aMessage has other keys for this agent.
   * @param {(published: string) => Promise<void>} replacing
   */
  async function create(replacing) {
    const own = await mine();
    const there = await published();
    const ours = own ? fingerprint(unb64(own.entry.identity.public)) : null;
    if (own && there.fingerprint === ours) {
      // The same identity: publish only if aMessage lacks today's key, or has fewer than 3 days left.
      const key = currentKey(own.entry);
      if (key && there.keys?.message_key?.key_id === key.key_id && enoughLeft(there.keys.keys_until) && enoughLeft(keysUntil(own.entry)))
        return { made: false, published: false, entry: own.entry };
    } else if (there.fingerprint) await replacing(there.fingerprint);
    if (own) return { made: false, published: true, entry: await renew(true) };
    const entry = await update((e) => e ?? newEntry());
    await publish(entry);
    return { made: true, published: true, entry };
  }

  return {
    whoAmI,
    mine,
    update,
    published,
    publish,
    renew,
    fresh,
    recipientKeys,
    pin,
    prepare,
    send,
    remember,
    openAll,
    withOpened,
    secrets,
    create,
  };
}
