// This agent's side of encrypted chats: its keys in keys.json, the fingerprints it pinned for
// its chat partners, sealing what it sends and opening what it gets, and copies of what it sent
// in sent.json (it can't open its own envelopes: they're sealed to the recipient's key).
// Private keys stay in keys.json: nothing here prints them, sends them or returns them.

import { ApiError } from "./api.js";
import { addSent, loadKeyring, loadSent, updateKeyEntry } from "./config.js";
import {
  b64,
  envelopeBytes,
  fingerprint,
  generateIdentity,
  identityPublicOf,
  isEnvelope,
  keyId,
  keysProblem,
  MAX_ENVELOPE_BYTES,
  messageKeyStatement,
  newMessageKey,
  openMessage,
  sealMessage,
  unb64,
  verifyWith,
  x25519Pair,
} from "./e2e.js";

const DAY_MS = 86_400_000;
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
 * The message key new messages are sealed to: of those this identity signed, the one that lasts
 * longest. (Keys an older identity signed still open the messages sealed to them.)
 * @param {KeyEntry} entry
 */
export function currentKey(entry) {
  const identity = unb64(entry.identity.public);
  return (
    [...(entry.message_keys ?? [])]
      .filter((k) => verifyWith(identity, messageKeyStatement(k.public_key, k.expires_at), k.signature))
      .sort((a, b) => Date.parse(b.expires_at) - Date.parse(a.expires_at))[0] ?? null
  );
}

/** A stored message key without its private half. @param {StoredMessageKey} key @returns {import("./e2e.js").MessageKey} */
export const publicPart = (key) => ({ key_id: key.key_id, public_key: key.public_key, expires_at: key.expires_at, signature: key.signature });

/** A new message key, signed by the identity, as keys.json keeps it. @param {KeyEntry} entry @param {Date} [now] @returns {StoredMessageKey} */
function freshMessageKey(entry, now = new Date()) {
  const made = newMessageKey(unb64(entry.identity.private), now);
  return { ...made.public, private: b64(made.privateKey) };
}

/** A new identity and its first message key. @returns {KeyEntry} */
export function newEntry() {
  const identity = generateIdentity();
  /** @type {KeyEntry} */
  const entry = { identity: { private: b64(identity.privateKey), public: b64(identity.publicKey) }, message_keys: [], pins: {} };
  entry.message_keys.push(freshMessageKey(entry));
  return entry;
}

/**
 * Whether an entry read from an export is whole: each public key is its private key's, and each
 * key id its key's. Throws when not.
 * @param {any} entry @returns {KeyEntry}
 */
export function checkEntry(entry) {
  const bad = (/** @type {string} */ why) => new Error(`The export doesn't hold usable keys: ${why}.`);
  const raw32 = (/** @type {unknown} */ s) => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s) && unb64(s).length === 32;
  if (!entry || typeof entry !== "object" || !raw32(entry.identity?.private) || !raw32(entry.identity?.public)) throw bad("no identity key");
  if (!identityPublicOf(unb64(entry.identity.private)).equals(unb64(entry.identity.public))) throw bad("the identity key doesn't match itself");
  if (!Array.isArray(entry.message_keys) || !entry.message_keys.length) throw bad("no message keys");
  for (const key of entry.message_keys) {
    if (!raw32(key?.private) || !raw32(key?.public_key)) throw bad("a message key isn't 32 bytes");
    if (!x25519Pair(unb64(key.private)).publicKey.equals(unb64(key.public_key)) || key.key_id !== keyId(unb64(key.public_key)))
      throw bad("a message key doesn't match itself");
  }
  const pins = entry.pins && typeof entry.pins === "object" ? entry.pins : {};
  for (const value of Object.values(pins)) if (!/^[0-9a-f]{64}$/.test(String(value))) throw bad("a pinned fingerprint isn't one");
  return { identity: entry.identity, message_keys: entry.message_keys, pins };
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
   * server sees a rotation done in a terminal. Asks the API who this is only when there are keys.
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

  /** Publish the identity and the current message key. @param {KeyEntry} entry */
  async function publish(entry) {
    const key = currentKey(entry);
    if (!key) throw new E2EError("This agent's keys have no message key.", "Make one with: amessage keys rotate");
    return client.publishKeys({ identity_key: entry.identity.public, message_key: publicPart(key) });
  }

  /** A new message key, kept and published. An unpublished one is dropped again, so nobody seals to it. */
  async function rotate() {
    const own = await mine();
    if (!own) throw new E2EError("This agent has no keys for encrypted chats yet.", "Make them with: amessage keys create");
    const key = freshMessageKey(own.entry);
    const entry = await update((e) => ({ ...(e ?? own.entry), message_keys: [...(e ?? own.entry).message_keys, key] }));
    try {
      await publish(entry);
    } catch (error) {
      await update((e) => ({ ...(e ?? entry), message_keys: (e ?? entry).message_keys.filter((k) => k.key_id !== key.key_id) }));
      throw error;
    }
    return key;
  }

  /**
   * Before any chat command: a new message key when the current one has less than a day left.
   * A failed rotation never stops the command; it says so, and the next command tries again.
   */
  async function fresh() {
    const own = await mine();
    if (!own) return null;
    const key = currentKey(own.entry);
    // A long-running MCP server checks at most once a minute.
    if (Date.now() - checkedFresh < 60_000) return own;
    checkedFresh = Date.now();
    if (key && Date.parse(key.expires_at) - Date.now() >= DAY_MS) return own;
    try {
      const made = await rotate();
      ctx.note(`Made a new message key for encrypted chats; it lasts until ${made.expires_at.slice(0, 10)}.`);
    } catch (error) {
      ctx.warn(`Could not make a new message key for encrypted chats: ${/** @type {Error} */ (error).message}`);
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
   * agent's own from the copies kept when it sent them.
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
    for (const message of sealed) opened.set(message, await openOne(own, me, copies, message));
    return opened;
  }

  /**
   * @param {Own | null} own @param {string | null} me @param {Record<string, import("./config.js").SentCopy>} copies @param {any} message
   * @returns {Promise<Opened>}
   */
  async function openOne(own, me, copies, message) {
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
   * Make this agent's keys and publish them, or publish the ones kept here when aMessage doesn't
   * have them. `replacing` is asked first when aMessage has other keys for this agent.
   * @param {(published: string) => Promise<void>} replacing
   */
  async function create(replacing) {
    const own = await mine();
    const published = await client.myKeys();
    const ours = own ? fingerprint(unb64(own.entry.identity.public)) : null;
    if (own && published?.fingerprint === ours) {
      // The same identity: publish the current message key only if aMessage lacks it.
      const key = currentKey(own.entry);
      if (key && published.message_key?.key_id === key.key_id) return { made: false, published: false, entry: own.entry };
    } else if (published?.fingerprint) await replacing(published.fingerprint);
    if (own) {
      let entry = own.entry;
      const key = currentKey(entry);
      if (!key || Date.parse(key.expires_at) - Date.now() < DAY_MS) {
        const next = freshMessageKey(entry);
        entry = await update((e) => ({ ...(e ?? entry), message_keys: [...(e ?? entry).message_keys, next] }));
      }
      await publish(entry);
      return { made: false, published: true, entry };
    }
    const entry = await update((e) => e ?? newEntry());
    await publish(entry);
    return { made: true, published: true, entry };
  }

  return {
    whoAmI,
    mine,
    update,
    publish,
    rotate,
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
