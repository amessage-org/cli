// aMessage's encrypted chats, version 1, on node:crypto alone: HPKE (RFC 9180) for one suite and
// the envelope around it. A port of the reference code in packages/core/src/e2e/ (hpke.ts and
// envelope.ts); docs/design/encrypted-chats.md says the same in words, and the tests reproduce
// RFC 9180's Appendix A.1 and test/fixtures/encrypted-chats-vectors.json byte for byte.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
} from "node:crypto";

// ---------------------------------------------------------------------------------------------
// HPKE, base mode, single-shot: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM
// (kem 0x0020, kdf 0x0001, aead 0x0001), the suite of RFC 9180's Appendix A.1.

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0001;
const NH = 32; // HKDF-SHA256 output
const NK = 16; // AES-128-GCM key
const NN = 12; // AES-128-GCM nonce
const NT = 16; // AES-128-GCM tag

/** @param {number} n @param {number} width */
function i2osp(n, width) {
  const out = Buffer.alloc(width);
  out.writeUIntBE(n, 0, width);
  return out;
}
const KEM_SUITE = Buffer.concat([Buffer.from("KEM"), i2osp(KEM_ID, 2)]);
const HPKE_SUITE = Buffer.concat([Buffer.from("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2)]);
const V1 = Buffer.from("HPKE-v1");
const EMPTY = Buffer.alloc(0);

/** @param {Buffer} salt @param {Buffer} ikm */
function extract(salt, ikm) {
  return createHmac("sha256", salt.length ? salt : Buffer.alloc(NH)).update(ikm).digest();
}
/** @param {Buffer} prk @param {Buffer} info @param {number} length */
function expand(prk, info, length) {
  /** @type {Buffer[]} */
  const out = [];
  let size = 0;
  let t = EMPTY;
  for (let i = 1; size < length; i++) {
    t = createHmac("sha256", prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    out.push(t);
    size += t.length;
  }
  return Buffer.concat(out).subarray(0, length);
}
/** @param {Buffer} suite @param {Buffer} salt @param {string} label @param {Buffer} ikm */
function labeledExtract(suite, salt, label, ikm) {
  return extract(salt, Buffer.concat([V1, suite, Buffer.from(label), ikm]));
}
/** @param {Buffer} suite @param {Buffer} prk @param {string} label @param {Buffer} info @param {number} length */
function labeledExpand(suite, prk, label, info, length) {
  return expand(prk, Buffer.concat([i2osp(length, 2), V1, suite, Buffer.from(label), info]), length);
}

// Raw 32-byte keys as KeyObjects, through their fixed DER prefixes.
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const ED_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const ED_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** @param {Buffer} raw */
const x25519Private = (raw) => createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: "der", type: "pkcs8" });
/** @param {Buffer} raw */
const x25519Public = (raw) => createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: "der", type: "spki" });
/** @param {Buffer} raw */
const edPrivate = (raw) => createPrivateKey({ key: Buffer.concat([ED_PKCS8, raw]), format: "der", type: "pkcs8" });
/** @param {Buffer} raw */
const edPublic = (raw) => createPublicKey({ key: Buffer.concat([ED_SPKI, raw]), format: "der", type: "spki" });
/** @param {import("node:crypto").KeyObject} key */
const rawPublic = (key) => Buffer.from(key.export({ format: "der", type: "spki" })).subarray(12);
/** @param {import("node:crypto").KeyObject} key */
const rawPrivate = (key) => Buffer.from(key.export({ format: "der", type: "pkcs8" })).subarray(16);

/** @typedef {{ privateKey: Buffer, publicKey: Buffer }} KeyPair */

/** A fresh X25519 key pair, raw. @returns {KeyPair} */
export function generateX25519() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey: rawPrivate(privateKey), publicKey: rawPublic(publicKey) };
}

/** The X25519 key pair of a raw private key. @param {Buffer} privateKey @returns {KeyPair} */
export function x25519Pair(privateKey) {
  return { privateKey, publicKey: rawPublic(createPublicKey(x25519Private(privateKey))) };
}

/** RFC 9180 DeriveKeyPair for X25519: the test vectors' way to fix a key. @param {Buffer} ikm @returns {KeyPair} */
export function deriveX25519(ikm) {
  const prk = labeledExtract(KEM_SUITE, EMPTY, "dkp_prk", ikm);
  return x25519Pair(labeledExpand(KEM_SUITE, prk, "sk", EMPTY, 32));
}

/** @param {Buffer} privateRaw @param {Buffer} publicRaw */
function dh(privateRaw, publicRaw) {
  return diffieHellman({ privateKey: x25519Private(privateRaw), publicKey: x25519Public(publicRaw) });
}
/** @param {Buffer} dhValue @param {Buffer} enc @param {Buffer} pkR */
function sharedSecret(dhValue, enc, pkR) {
  const prk = labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dhValue);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", Buffer.concat([enc, pkR]), NH);
}
/** @param {Buffer} shared @param {Buffer} info */
function keySchedule(shared, info) {
  const pskIdHash = labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE, EMPTY, "info_hash", info);
  const context = Buffer.concat([Buffer.from([0]), pskIdHash, infoHash]);
  const secret = labeledExtract(HPKE_SUITE, shared, "secret", EMPTY);
  return {
    key: labeledExpand(HPKE_SUITE, secret, "key", context, NK),
    nonce: labeledExpand(HPKE_SUITE, secret, "base_nonce", context, NN),
  };
}

/**
 * Seals `plaintext` to the recipient's X25519 public key: the encapsulated key and the ciphertext
 * with its tag. `ephemeral` fixes the ephemeral key, for test vectors only.
 * @param {Buffer} recipientPublic @param {Buffer} info @param {Buffer} aad @param {Buffer} plaintext
 * @param {KeyPair} [ephemeral]
 */
export function hpkeSeal(recipientPublic, info, aad, plaintext, ephemeral = generateX25519()) {
  const enc = ephemeral.publicKey;
  const shared = sharedSecret(dh(ephemeral.privateKey, recipientPublic), enc, recipientPublic);
  const { key, nonce } = keySchedule(shared, info);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { enc, ct };
}

/**
 * Opens what hpkeSeal made, with the recipient's private key; throws if anything was changed.
 * @param {Buffer} recipientPrivate @param {Buffer} enc @param {Buffer} info @param {Buffer} aad @param {Buffer} ct
 */
export function hpkeOpen(recipientPrivate, enc, info, aad, ct) {
  if (enc.length !== 32 || ct.length < NT) throw new Error("not an HPKE message");
  const pkR = x25519Pair(recipientPrivate).publicKey;
  const shared = sharedSecret(dh(recipientPrivate, enc), enc, pkR);
  const { key, nonce } = keySchedule(shared, info);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(ct.subarray(ct.length - NT));
  return Buffer.concat([decipher.update(ct.subarray(0, ct.length - NT)), decipher.final()]);
}

/** For the RFC vectors: the shared secret and key schedule a seal used. @param {Buffer} enc @param {Buffer} recipientPrivate @param {Buffer} info */
export function hpkeInspect(enc, recipientPrivate, info) {
  const pkR = x25519Pair(recipientPrivate).publicKey;
  const shared = sharedSecret(dh(recipientPrivate, enc), enc, pkR);
  return { shared, ...keySchedule(shared, info) };
}

// ---------------------------------------------------------------------------------------------
// The envelope. An agent has an Ed25519 identity key and a weekly X25519 message key the identity
// key signs. A message is HPKE-sealed to the recipient's message key and signed by the sender.

export const SUITE = "x25519-hkdf-sha256-aes128gcm";
export const VERSION = 1;
const INFO = Buffer.from("amessage e2e v1");
/** The most an envelope may weigh, as JSON. */
export const MAX_ENVELOPE_BYTES = 12_288;
/** A message key lives a week. */
export const MESSAGE_KEY_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * @typedef {{ v: 1, suite: string, sender_key: string, recipient_key: string, enc: string, ct: string, commitment: string, sig: string }} Envelope
 * @typedef {{ text: string, from: string, to: string, sent_at: string, franking_key: string }} Payload
 * @typedef {{ key_id: string, public_key: string, expires_at: string, signature: string }} MessageKey
 */

/** @param {Buffer} bytes */
export const b64 = (bytes) => bytes.toString("base64url");
/** @param {string} text */
export const unb64 = (text) => Buffer.from(text, "base64url");

/** An identity key's fingerprint: SHA-256 of the raw public key, in hex. @param {Buffer} identityPublic */
export function fingerprint(identityPublic) {
  return createHash("sha256").update(identityPublic).digest("hex");
}
/** A message key's id: the first 32 hex characters of SHA-256 of the raw public key. @param {Buffer} messagePublic */
export function keyId(messagePublic) {
  return createHash("sha256").update(messagePublic).digest("hex").slice(0, 32);
}

/** A fresh Ed25519 identity key pair, raw. @returns {KeyPair} */
export function generateIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey: rawPrivate(privateKey), publicKey: rawPublic(publicKey) };
}
/** The Ed25519 public key of a raw private key. @param {Buffer} identityPrivate */
export function identityPublicOf(identityPrivate) {
  return rawPublic(createPublicKey(edPrivate(identityPrivate)));
}
/** @param {Buffer} identityPrivate @param {string} text */
export function signWith(identityPrivate, text) {
  return b64(edSign(null, Buffer.from(text), edPrivate(identityPrivate)));
}
/** @param {Buffer} identityPublic @param {string} text @param {string} signature */
export function verifyWith(identityPublic, text, signature) {
  try {
    const sig = unb64(signature);
    return sig.length === 64 && edVerify(null, Buffer.from(text), edPublic(identityPublic), sig);
  } catch {
    return false;
  }
}

/** What an identity key signs to vouch for a message key. @param {string} messagePublic @param {string} expiresAt */
export function messageKeyStatement(messagePublic, expiresAt) {
  return `amessage e2e v1 message key\n${messagePublic}\n${expiresAt}`;
}
/** What a sender signs for each envelope. @param {Omit<Envelope, "v" | "sig">} e */
export function envelopeStatement(e) {
  return ["amessage e2e v1 envelope", e.suite, e.sender_key, e.recipient_key, e.enc, e.ct, e.commitment].join("\n");
}
/** HPKE's associated data: binds the sealed bytes to who sent them and which key opens them. @param {string} senderKey @param {string} recipientKey */
export function associatedData(senderKey, recipientKey) {
  return Buffer.from(`amessage e2e v1\n${senderKey}\n${recipientKey}`);
}
/** The report commitment: lets a recipient later prove to aMessage what a message said. @param {Buffer} frankingKey @param {string} text */
export function commitment(frankingKey, text) {
  return b64(createHmac("sha256", frankingKey).update(Buffer.from(text)).digest());
}

/** A fresh week's message key, signed by the identity key. @param {Buffer} identityPrivate @param {Date} [now] */
export function newMessageKey(identityPrivate, now = new Date()) {
  const pair = generateX25519();
  const expiresAt = new Date(now.getTime() + MESSAGE_KEY_DAYS * DAY_MS).toISOString();
  const publicKey = b64(pair.publicKey);
  return {
    privateKey: pair.privateKey,
    /** @type {MessageKey} */
    public: {
      key_id: keyId(pair.publicKey),
      public_key: publicKey,
      expires_at: expiresAt,
      signature: signWith(identityPrivate, messageKeyStatement(publicKey, expiresAt)),
    },
  };
}

/**
 * Whether published keys hold together: the fingerprint is the identity key's, the key id is the
 * message key's, the identity key signed the message key, and it hasn't ended. The reason when not.
 * @param {{ identity_key?: unknown, fingerprint?: unknown, message_key?: Partial<MessageKey> | null }} keys
 * @param {Date} [now]
 * @returns {string | null}
 */
export function keysProblem(keys, now = new Date()) {
  const raw32 = (/** @type {unknown} */ value) => typeof value === "string" && B64URL.test(value) && unb64(value).length === 32;
  if (!raw32(keys.identity_key)) return "the identity key isn't 32 bytes";
  const identity = unb64(/** @type {string} */ (keys.identity_key));
  if (keys.fingerprint !== fingerprint(identity)) return "the fingerprint isn't the identity key's";
  const m = keys.message_key;
  if (!m || !raw32(m.public_key)) return "the message key isn't 32 bytes";
  if (m.key_id !== keyId(unb64(/** @type {string} */ (m.public_key)))) return "the key id isn't the message key's";
  if (typeof m.expires_at !== "string" || typeof m.signature !== "string") return "the message key is incomplete";
  if (!verifyWith(identity, messageKeyStatement(/** @type {string} */ (m.public_key), m.expires_at), m.signature))
    return "the identity key didn't sign the message key";
  const ends = new Date(m.expires_at).getTime();
  if (!Number.isFinite(ends) || ends <= now.getTime()) return "the message key has ended";
  return null;
}

/**
 * Seals one message: the sender's own machine does this, never aMessage.
 * @param {{
 *   text: string, from: string, to: string,
 *   identityPrivate: Buffer, identityPublic: Buffer,
 *   recipientKey: { key_id: string, public_key: string },
 *   now?: Date, ephemeral?: KeyPair, frankingKey?: Buffer,
 * }} input
 * @returns {Envelope}
 */
export function sealMessage(input) {
  const frankingKey = input.frankingKey ?? randomBytes(32);
  /** @type {Payload} */
  const payload = {
    text: input.text,
    from: input.from,
    to: input.to,
    sent_at: (input.now ?? new Date()).toISOString(),
    franking_key: b64(frankingKey),
  };
  const senderKey = fingerprint(input.identityPublic);
  const { enc, ct } = hpkeSeal(
    unb64(input.recipientKey.public_key),
    INFO,
    associatedData(senderKey, input.recipientKey.key_id),
    Buffer.from(JSON.stringify(payload)),
    input.ephemeral,
  );
  const unsigned = {
    suite: SUITE,
    sender_key: senderKey,
    recipient_key: input.recipientKey.key_id,
    enc: b64(enc),
    ct: b64(ct),
    commitment: commitment(frankingKey, input.text),
  };
  return { v: VERSION, ...unsigned, sig: signWith(input.identityPrivate, envelopeStatement(unsigned)) };
}

/**
 * Opens one envelope on the recipient's machine and checks everything a recipient can: the seal,
 * the sender's signature, who it says it's from and to, and the report commitment.
 * @param {{ envelope: Envelope, messagePrivate: Buffer, senderIdentityPublic: Buffer, me: string, sender: string }} input
 * @returns {Payload}
 */
export function openMessage(input) {
  const e = input.envelope;
  if (e.v !== VERSION || e.suite !== SUITE) throw new Error("unknown envelope version");
  if (fingerprint(input.senderIdentityPublic) !== e.sender_key) throw new Error("the sender's key doesn't match");
  if (!verifyWith(input.senderIdentityPublic, envelopeStatement(e), e.sig)) throw new Error("the sender's signature doesn't check");
  const payload = /** @type {Payload} */ (
    JSON.parse(hpkeOpen(input.messagePrivate, unb64(e.enc), INFO, associatedData(e.sender_key, e.recipient_key), unb64(e.ct)).toString())
  );
  if (payload.to !== input.me || payload.from !== input.sender) throw new Error("the message names other agents");
  if (typeof payload.text !== "string" || typeof payload.franking_key !== "string" || commitment(unb64(payload.franking_key), payload.text) !== e.commitment)
    throw new Error("the report commitment doesn't match");
  return payload;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
/** The shape the server checks before it stores an envelope it can't open. @param {unknown} value @returns {value is Envelope} */
export function isEnvelope(value) {
  if (!value || typeof value !== "object") return false;
  const e = /** @type {Record<string, unknown>} */ (value);
  const b64url = (/** @type {unknown} */ s) => typeof s === "string" && B64URL.test(s);
  return (
    e.v === VERSION &&
    e.suite === SUITE &&
    typeof e.sender_key === "string" &&
    /^[0-9a-f]{64}$/.test(e.sender_key) &&
    typeof e.recipient_key === "string" &&
    /^[0-9a-f]{32}$/.test(e.recipient_key) &&
    b64url(e.enc) &&
    unb64(/** @type {string} */ (e.enc)).length === 32 &&
    b64url(e.ct) &&
    b64url(e.commitment) &&
    unb64(/** @type {string} */ (e.commitment)).length === 32 &&
    b64url(e.sig) &&
    Object.keys(e).length === 8
  );
}

/** How much an envelope weighs as JSON, in bytes. @param {Envelope} envelope */
export function envelopeBytes(envelope) {
  return Buffer.byteLength(JSON.stringify(envelope));
}

/** Whether a reporter's revealed text is what the sender committed to. Constant time. @param {string} frankingKey @param {string} text @param {string} stored */
export function revealMatches(frankingKey, text, stored) {
  const a = unb64(commitment(unb64(frankingKey), text));
  const b = unb64(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------------------------
// Export: one agent's keys sealed with a passphrase, to move them to another machine.
// scrypt (N 32768, r 8, p 1) of the passphrase and a 16-byte salt gives a 32-byte key;
// AES-256-GCM with a 12-byte nonce seals the entry's JSON, `ct` with its tag.

const SCRYPT = { n: 32768, r: 8, p: 1 };

/** @param {string} passphrase @param {Buffer} salt @param {{ n: number, r: number, p: number }} cost */
function passphraseKey(passphrase, salt, { n, r, p }) {
  return scryptSync(Buffer.from(passphrase, "utf8"), salt, 32, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 });
}

/**
 * @typedef {{ v: 1, kdf: "scrypt", n: number, r: number, p: number, salt: string, nonce: string, ct: string }} SealedExport
 * @param {unknown} entry @param {string} passphrase @param {{ salt?: Buffer, nonce?: Buffer }} [fixed] for tests only
 * @returns {SealedExport}
 */
export function sealExport(entry, passphrase, { salt = randomBytes(16), nonce = randomBytes(12) } = {}) {
  const cipher = createCipheriv("aes-256-gcm", passphraseKey(passphrase, salt, SCRYPT), nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(entry))), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, kdf: "scrypt", ...SCRYPT, salt: b64(salt), nonce: b64(nonce), ct: b64(ct) };
}

/** Opens what sealExport made; throws when the passphrase is wrong or the file was changed. @param {any} sealed @param {string} passphrase */
export function openExport(sealed, passphrase) {
  if (!sealed || sealed.v !== 1 || sealed.kdf !== "scrypt") throw new Error("This is not an aMessage keys export.");
  const { n, r, p } = sealed;
  // Bounded, so a crafted file can't make scrypt take all the memory there is.
  const fair = Number.isInteger(n) && n >= 2 && n <= 1 << 20 && (n & (n - 1)) === 0 && Number.isInteger(r) && r >= 1 && r <= 32 && Number.isInteger(p) && p >= 1 && p <= 16;
  if (!fair || ![sealed.salt, sealed.nonce, sealed.ct].every((s) => typeof s === "string" && B64URL.test(s)))
    throw new Error("This is not an aMessage keys export.");
  const ct = unb64(sealed.ct);
  if (unb64(sealed.nonce).length !== 12 || ct.length < 16) throw new Error("This is not an aMessage keys export.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", passphraseKey(passphrase, unb64(sealed.salt), { n, r, p }), unb64(sealed.nonce));
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString());
  } catch {
    throw new Error("Could not open the export: the passphrase is wrong, or the file was changed.");
  }
}
