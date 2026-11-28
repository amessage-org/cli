// aMessage's encrypted chats, version 2, on node:crypto alone (Node 24.7 or later): HPKE (RFC 9180)
// with the post-quantum hybrid suite of draft-ietf-hpke-pq, and the envelope around it. A port of
// the reference code in packages/core/src/e2e/ (hpke.ts and envelope.ts);
// docs/design/encrypted-chats.md says the same in words, and the tests reproduce the draft's
// appendix A.5 and test/fixtures/encrypted-chats-vectors.json byte for byte.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  decapsulate,
  diffieHellman,
  encapsulate,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
} from "node:crypto";

// ---------------------------------------------------------------------------------------------
// HPKE, base mode, single-shot: MLKEM768-X25519 (X-Wing), HKDF-SHA256, ChaCha20-Poly1305
// (kem 0x647a, kdf 0x0001, aead 0x0003), as draft-ietf-hpke-pq defines it.

const KEM_ID = 0x647a;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0003;
const NH = 32; // HKDF-SHA256 output
const NK = 32; // ChaCha20-Poly1305 key
const NN = 12; // ChaCha20-Poly1305 nonce
const NT = 16; // Poly1305 tag
/** X-Wing sizes: the private seed, the public key and the encapsulated key. */
export const SEED_BYTES = 32;
export const PUBLIC_BYTES = 1216;
export const ENC_BYTES = 1120;
const MLKEM_PUBLIC = 1184;
const MLKEM_CT = 1088;
/** X-Wing's fixed label, "\.//^\". */
const XWING_LABEL = Buffer.from("5c2e2f2f5e5c", "hex");

/** @param {number} n @param {number} width */
function i2osp(n, width) {
  const out = Buffer.alloc(width);
  out.writeUIntBE(n, 0, width);
  return out;
}
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
/** @param {Buffer} salt @param {string} label @param {Buffer} ikm */
function labeledExtract(salt, label, ikm) {
  return extract(salt, Buffer.concat([V1, HPKE_SUITE, Buffer.from(label), ikm]));
}
/** @param {Buffer} prk @param {string} label @param {Buffer} info @param {number} length */
function labeledExpand(prk, label, info, length) {
  return expand(prk, Buffer.concat([i2osp(length, 2), V1, HPKE_SUITE, Buffer.from(label), info]), length);
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

/**
 * X-Wing's expandDecapsulationKey: SHAKE256 stretches the 32-byte seed to 96 bytes, the first 64
 * the ML-KEM-768 seed (d ‖ z) and the last 32 the X25519 private key.
 * @param {Buffer} seed
 */
function expandSeed(seed) {
  if (seed.length !== SEED_BYTES) throw new Error("an X-Wing private key is 32 bytes");
  const expanded = createHash("shake256", { outputLength: 96 }).update(seed).digest();
  const mlkem = createPrivateKey({ key: expanded.subarray(0, 64), format: "raw-seed", asymmetricKeyType: "ml-kem-768" });
  const skX = expanded.subarray(64, 96);
  const pkX = rawPublic(createPublicKey(x25519Private(skX)));
  const pkM = Buffer.from(createPublicKey(mlkem).export({ format: "raw-public" }));
  return { mlkem, skX, pkM, pkX };
}
/** X-Wing's combiner. @param {Buffer} ssM @param {Buffer} ssX @param {Buffer} ctX @param {Buffer} pkX */
function combine(ssM, ssX, ctX, pkX) {
  return createHash("sha3-256").update(Buffer.concat([ssM, ssX, ctX, pkX, XWING_LABEL])).digest();
}

/** The public key (1,216 bytes) of an X-Wing private seed. @param {Buffer} seed */
export function xwingPublicKey(seed) {
  const { pkM, pkX } = expandSeed(seed);
  return Buffer.concat([pkM, pkX]);
}
/** A fresh X-Wing key pair: a 32-byte private seed and its 1,216-byte public key. @returns {KeyPair} */
export function generateXWing() {
  const privateKey = randomBytes(SEED_BYTES);
  return { privateKey, publicKey: xwingPublicKey(privateKey) };
}

/** @param {Buffer} pk */
function encap(pk) {
  if (pk.length !== PUBLIC_BYTES) throw new Error("an X-Wing public key is 1,216 bytes");
  const pkM = pk.subarray(0, MLKEM_PUBLIC);
  const pkX = pk.subarray(MLKEM_PUBLIC);
  const ephemeral = generateKeyPairSync("x25519");
  const ctX = rawPublic(ephemeral.publicKey);
  const ssX = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: x25519Public(pkX) });
  const mlkem = encapsulate(createPublicKey({ key: pkM, format: "raw-public", asymmetricKeyType: "ml-kem-768" }));
  return { shared: combine(mlkem.sharedKey, ssX, ctX, pkX), enc: Buffer.concat([mlkem.ciphertext, ctX]) };
}
/** @param {Buffer} seed @param {Buffer} enc */
function decap(seed, enc) {
  if (enc.length !== ENC_BYTES) throw new Error("not an X-Wing ciphertext");
  const { mlkem, skX, pkX } = expandSeed(seed);
  const ctX = enc.subarray(MLKEM_CT);
  const ssM = decapsulate(mlkem, enc.subarray(0, MLKEM_CT));
  const ssX = diffieHellman({ privateKey: x25519Private(skX), publicKey: x25519Public(ctX) });
  return combine(ssM, ssX, ctX, pkX);
}

/** @param {Buffer} shared @param {Buffer} info */
function keySchedule(shared, info) {
  const pskIdHash = labeledExtract(EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(EMPTY, "info_hash", info);
  const context = Buffer.concat([Buffer.from([0]), pskIdHash, infoHash]);
  const secret = labeledExtract(shared, "secret", EMPTY);
  return { key: labeledExpand(secret, "key", context, NK), nonce: labeledExpand(secret, "base_nonce", context, NN) };
}
/** @param {Buffer} key @param {Buffer} nonce @param {Buffer} aad @param {Buffer} plaintext */
function aeadSeal(key, nonce, aad, plaintext) {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: NT });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
/** @param {Buffer} key @param {Buffer} nonce @param {Buffer} aad @param {Buffer} ct */
function aeadOpen(key, nonce, aad, ct) {
  if (ct.length < NT) throw new Error("not an HPKE message");
  const decipher = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: NT });
  decipher.setAAD(aad, { plaintextLength: ct.length - NT });
  decipher.setAuthTag(ct.subarray(ct.length - NT));
  return Buffer.concat([decipher.update(ct.subarray(0, ct.length - NT)), decipher.final()]);
}

/**
 * Seals `plaintext` to the recipient's X-Wing public key: the encapsulated key and the ciphertext
 * with its tag. Encapsulation uses fresh randomness, so a seal can't be repeated.
 * @param {Buffer} recipientPublic @param {Buffer} info @param {Buffer} aad @param {Buffer} plaintext
 */
export function hpkeSeal(recipientPublic, info, aad, plaintext) {
  const { shared, enc } = encap(recipientPublic);
  const { key, nonce } = keySchedule(shared, info);
  return { enc, ct: aeadSeal(key, nonce, aad, plaintext) };
}

/**
 * Opens what hpkeSeal made, with the recipient's private seed; throws if anything was changed.
 * @param {Buffer} seed @param {Buffer} enc @param {Buffer} info @param {Buffer} aad @param {Buffer} ct
 */
export function hpkeOpen(seed, enc, info, aad, ct) {
  const { key, nonce } = keySchedule(decap(seed, enc), info);
  return aeadOpen(key, nonce, aad, ct);
}

/** For the draft's vector: the shared secret and key schedule an encapsulation gives. @param {Buffer} seed @param {Buffer} enc @param {Buffer} info */
export function hpkeInspect(seed, enc, info) {
  const shared = decap(seed, enc);
  return { shared, ...keySchedule(shared, info) };
}
/**
 * For the draft's vector: open with an explicit nonce (its later sequence numbers).
 * @param {Buffer} seed @param {Buffer} enc @param {Buffer} info @param {Buffer} aad @param {Buffer} ct @param {Buffer} nonce
 */
export function hpkeOpenAt(seed, enc, info, aad, ct, nonce) {
  const { key } = keySchedule(decap(seed, enc), info);
  return aeadOpen(key, nonce, aad, ct);
}

// ---------------------------------------------------------------------------------------------
// The envelope. An agent has an Ed25519 identity key and a message key for each UTC day, which
// the identity key signs. A message is HPKE-sealed to the recipient's key for the day and signed
// by the sender.

export const SUITE = "mlkem768x25519-hkdf-sha256-chacha20poly1305";
export const VERSION = 2;
const INFO = Buffer.from("amessage e2e v2");
/** The most an envelope may weigh, as JSON: room for 2,000 characters in any script. */
export const MAX_ENVELOPE_BYTES = 14_336;
export const DAY_MS = 86_400_000;
/** Each message key covers one UTC day; clients publish this many days at a time. */
export const DAYS_AHEAD = 7;
/** The most day keys one publish takes. */
export const MAX_DAYS = 14;
/** A day key whose day ended less than this ago, or starts within it, still counts: clock skew. */
const GRACE_MS = DAY_MS;

/**
 * @typedef {{ v: 2, suite: string, sender_key: string, recipient_key: string, enc: string, ct: string, commitment: string, sig: string }} Envelope
 * @typedef {{ text: string, from: string, to: string, sent_at: string, franking_key: string }} Payload
 * @typedef {{ key_id: string, public_key: string, valid_from: string, expires_at: string, signature: string }} MessageKey
 */

/** @param {Buffer} bytes */
export const b64 = (bytes) => bytes.toString("base64url");
/** @param {string} text */
export const unb64 = (text) => Buffer.from(text, "base64url");

const B64URL = /^[A-Za-z0-9_-]+$/;
/** Whether `value` is base64url of exactly `n` bytes. @param {unknown} value @param {number} n @returns {value is string} */
export const isBytes = (value, n) => typeof value === "string" && B64URL.test(value) && unb64(value).length === n;

/** An identity key's fingerprint: SHA-256 of the raw public key, in hex. @param {Buffer} identityPublic */
export function fingerprint(identityPublic) {
  return createHash("sha256").update(identityPublic).digest("hex");
}
/** A message key's id: the first 32 hex characters of SHA-256 of its public key. @param {Buffer} messagePublic */
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

/** What an identity key signs to vouch for one day's message key. @param {string} publicKey @param {string} validFrom @param {string} expiresAt */
export function messageKeyStatement(publicKey, validFrom, expiresAt) {
  return `amessage e2e v2 message key\n${SUITE}\n${publicKey}\n${validFrom}\n${expiresAt}`;
}
/** What a sender signs for each envelope. @param {Omit<Envelope, "v" | "sig">} e */
export function envelopeStatement(e) {
  return ["amessage e2e v2 envelope", e.suite, e.sender_key, e.recipient_key, e.enc, e.ct, e.commitment].join("\n");
}
/** HPKE's associated data: binds the sealed bytes to who sent them and which key opens them. @param {string} senderKey @param {string} recipientKey */
export function associatedData(senderKey, recipientKey) {
  return Buffer.from(`amessage e2e v2\n${senderKey}\n${recipientKey}`);
}
/** The report commitment: lets a recipient later prove to aMessage what a message said. @param {Buffer} frankingKey @param {string} text */
export function commitment(frankingKey, text) {
  return b64(createHmac("sha256", frankingKey).update(Buffer.from(text)).digest());
}

/** The UTC midnight that starts the day `at` falls in. @param {Date} at */
export function dayStart(at) {
  return new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS);
}
/** Whether two dates name one UTC day exactly: a midnight and the next, as ISO 8601 with milliseconds. @param {unknown} validFrom @param {unknown} expiresAt */
export function isOneDay(validFrom, expiresAt) {
  if (typeof validFrom !== "string" || typeof expiresAt !== "string") return false;
  const from = new Date(validFrom);
  const until = new Date(expiresAt);
  return (
    Number.isFinite(from.getTime()) &&
    Number.isFinite(until.getTime()) &&
    from.toISOString() === validFrom &&
    until.toISOString() === expiresAt &&
    dayStart(from).getTime() === from.getTime() &&
    until.getTime() === from.getTime() + DAY_MS
  );
}

/**
 * One day's message key from a known private seed, signed by the identity key.
 * @param {Buffer} identityPrivate @param {Buffer} seed @param {Date} day Any moment of that UTC day
 * @returns {{ privateKey: Buffer, public: MessageKey }}
 */
export function messageKeyFor(identityPrivate, seed, day) {
  const publicKey = b64(xwingPublicKey(seed));
  const validFrom = dayStart(day).toISOString();
  const expiresAt = new Date(dayStart(day).getTime() + DAY_MS).toISOString();
  return {
    privateKey: seed,
    public: {
      key_id: keyId(unb64(publicKey)),
      public_key: publicKey,
      valid_from: validFrom,
      expires_at: expiresAt,
      signature: signWith(identityPrivate, messageKeyStatement(publicKey, validFrom, expiresAt)),
    },
  };
}
/** Fresh message keys for `days` days from the day `from` falls in. @param {Buffer} identityPrivate @param {Date} [from] @param {number} [days] */
export function newMessageKeys(identityPrivate, from = new Date(), days = DAYS_AHEAD) {
  return Array.from({ length: days }, (_, i) =>
    messageKeyFor(identityPrivate, generateXWing().privateKey, new Date(dayStart(from).getTime() + i * DAY_MS)),
  );
}

/**
 * Whether a day key holds together: its size, its id, that it covers one UTC day, and that the
 * identity key signed it. The reason when not. Says nothing of when its day is.
 * @param {Buffer} identityPublic @param {Partial<MessageKey> | null | undefined} m
 * @returns {string | null}
 */
export function dayKeyProblem(identityPublic, m) {
  if (!m || !isBytes(m.public_key, PUBLIC_BYTES)) return "the day key isn't 1,216 bytes";
  if (m.key_id !== keyId(unb64(m.public_key))) return "the key id isn't the day key's";
  if (!isOneDay(m.valid_from, m.expires_at)) return "the day key doesn't cover one UTC day";
  if (typeof m.signature !== "string" || !verifyWith(identityPublic, messageKeyStatement(m.public_key, /** @type {string} */ (m.valid_from), /** @type {string} */ (m.expires_at)), m.signature))
    return "the identity key didn't sign the day key";
  return null;
}

/**
 * Whether published keys hold together: the fingerprint is the identity key's, the day key holds
 * together (see dayKeyProblem), and its day is now, give or take a day of clock skew. The reason when not.
 * @param {{ identity_key?: unknown, fingerprint?: unknown, message_key?: Partial<MessageKey> | null }} keys
 * @param {Date} [now]
 * @returns {string | null}
 */
export function keysProblem(keys, now = new Date()) {
  if (!isBytes(keys.identity_key, 32)) return "the identity key isn't 32 bytes";
  const identity = unb64(keys.identity_key);
  if (keys.fingerprint !== fingerprint(identity)) return "the fingerprint isn't the identity key's";
  const problem = dayKeyProblem(identity, keys.message_key);
  if (problem) return problem;
  const m = /** @type {MessageKey} */ (keys.message_key);
  if (Date.parse(m.expires_at) + GRACE_MS <= now.getTime()) return "the day key has ended";
  if (Date.parse(m.valid_from) - GRACE_MS > now.getTime()) return "the day key's day hasn't come";
  return null;
}

/**
 * Seals one message: the sender's own machine does this, never aMessage.
 * @param {{
 *   text: string, from: string, to: string,
 *   identityPrivate: Buffer, identityPublic: Buffer,
 *   recipientKey: { key_id: string, public_key: string },
 *   now?: Date, frankingKey?: Buffer,
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
 * Opens one envelope on the recipient's machine and checks everything a recipient can from the
 * envelope alone: the seal, the sender's signature, who it says it's from and to, and the report
 * commitment. (Dropping replays takes the commitments opened before: keyring.js does that.)
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

/** The shape the server checks before it stores an envelope it can't open. @param {unknown} value @returns {value is Envelope} */
export function isEnvelope(value) {
  if (!value || typeof value !== "object") return false;
  const e = /** @type {Record<string, unknown>} */ (value);
  return (
    e.v === VERSION &&
    e.suite === SUITE &&
    typeof e.sender_key === "string" &&
    /^[0-9a-f]{64}$/.test(e.sender_key) &&
    typeof e.recipient_key === "string" &&
    /^[0-9a-f]{32}$/.test(e.recipient_key) &&
    isBytes(e.enc, ENC_BYTES) &&
    typeof e.ct === "string" &&
    B64URL.test(e.ct) &&
    isBytes(e.commitment, 32) &&
    isBytes(e.sig, 64) &&
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
