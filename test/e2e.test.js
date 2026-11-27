import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  b64,
  deriveX25519,
  envelopeStatement,
  fingerprint,
  generateIdentity,
  hpkeInspect,
  hpkeOpen,
  hpkeSeal,
  identityPublicOf,
  isEnvelope,
  keyId,
  keysProblem,
  messageKeyStatement,
  newMessageKey,
  openExport,
  openMessage,
  revealMatches,
  sealExport,
  sealMessage,
  signWith,
  unb64,
  verifyWith,
  x25519Pair,
} from "../src/e2e.js";

const hex = (/** @type {string} */ s) => Buffer.from(s.replace(/\s/g, ""), "hex");

// RFC 9180, Appendix A.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode.
const A1 = {
  info: hex("4f6465206f6e2061204772656369616e2055726e"),
  ikmE: hex("7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234"),
  pkEm: "37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431",
  skEm: "52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736",
  ikmR: hex("6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037"),
  pkRm: "3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d",
  skRm: "4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8",
  sharedSecret: "fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc",
  key: "4531685d41d65f03dc48f6b8302c05b0",
  baseNonce: "56d890e5accaaf011cff4b7d",
  pt: hex("4265617574792069732074727574682c20747275746820626561757479"),
  aad: hex("436f756e742d30"),
  ct: "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a",
};

const VECTORS = JSON.parse(readFileSync(new URL("./fixtures/encrypted-chats-vectors.json", import.meta.url), "utf8"));

test("HPKE matches RFC 9180 A.1: derived keys, shared secret, key schedule and the first seal", () => {
  const e = deriveX25519(A1.ikmE);
  const r = deriveX25519(A1.ikmR);
  assert.equal(e.publicKey.toString("hex"), A1.pkEm);
  assert.equal(e.privateKey.toString("hex"), A1.skEm);
  assert.equal(r.publicKey.toString("hex"), A1.pkRm);
  assert.equal(r.privateKey.toString("hex"), A1.skRm);
  const sealed = hpkeSeal(r.publicKey, A1.info, A1.aad, A1.pt, e);
  assert.equal(sealed.enc.toString("hex"), A1.pkEm);
  const schedule = hpkeInspect(sealed.enc, r.privateKey, A1.info);
  assert.equal(schedule.shared.toString("hex"), A1.sharedSecret);
  assert.equal(schedule.key.toString("hex"), A1.key);
  assert.equal(schedule.nonce.toString("hex"), A1.baseNonce);
  assert.equal(sealed.ct.toString("hex"), A1.ct);
  assert.deepEqual(hpkeOpen(r.privateKey, sealed.enc, A1.info, A1.aad, sealed.ct), A1.pt);
  const tampered = Buffer.from(sealed.ct);
  tampered[0] ^= 1;
  assert.throws(() => hpkeOpen(r.privateKey, sealed.enc, A1.info, A1.aad, tampered));
  assert.throws(() => hpkeOpen(r.privateKey, sealed.enc, A1.info, Buffer.from("other"), sealed.ct));
});

test("sealing the spec's fixed inputs gives its envelope exactly, and opening it gives the payload", () => {
  const v = VECTORS;
  const alice = { privateKey: unb64(v.alice_identity.private), publicKey: unb64(v.alice_identity.public) };
  const bob = { privateKey: unb64(v.bob_identity.private), publicKey: unb64(v.bob_identity.public) };
  assert.deepEqual(identityPublicOf(alice.privateKey), alice.publicKey);
  assert.deepEqual(identityPublicOf(bob.privateKey), bob.publicKey);
  assert.equal(fingerprint(alice.publicKey), v.alice_identity.fingerprint);
  assert.equal(fingerprint(bob.publicKey), v.bob_identity.fingerprint);
  // Bob's message key: its id, its public half, and the identity key's signature on it.
  const bobKey = v.bob_message_key;
  assert.deepEqual(x25519Pair(unb64(bobKey.private)).publicKey, unb64(bobKey.public_key));
  assert.equal(keyId(unb64(bobKey.public_key)), bobKey.key_id);
  assert.equal(verifyWith(bob.publicKey, messageKeyStatement(bobKey.public_key, bobKey.expires_at), bobKey.signature), true);
  const published = { identity_key: v.bob_identity.public, fingerprint: v.bob_identity.fingerprint, message_key: bobKey };
  assert.equal(keysProblem(published, new Date(v.sent_at)), null);
  assert.equal(keysProblem(published, new Date(bobKey.expires_at)), "the message key has ended");
  assert.equal(keysProblem({ ...published, fingerprint: v.alice_identity.fingerprint }, new Date(v.sent_at)), "the fingerprint isn't the identity key's");

  const payload = JSON.parse(v.plaintext_payload);
  const envelope = sealMessage({
    text: payload.text,
    from: payload.from,
    to: payload.to,
    identityPrivate: alice.privateKey,
    identityPublic: alice.publicKey,
    recipientKey: bobKey,
    now: new Date(v.sent_at),
    ephemeral: x25519Pair(unb64(v.ephemeral_private)),
    frankingKey: unb64(v.franking_key),
  });
  assert.equal(JSON.stringify(envelope), JSON.stringify(v.envelope));
  assert.equal(isEnvelope(envelope), true);
  const opened = openMessage({
    envelope: v.envelope,
    messagePrivate: unb64(bobKey.private),
    senderIdentityPublic: alice.publicKey,
    me: payload.to,
    sender: payload.from,
  });
  assert.equal(JSON.stringify(opened), v.plaintext_payload);
  assert.equal(revealMatches(opened.franking_key, opened.text, v.envelope.commitment), true);
});

test("a sealed message opens only for its recipient, and every kind of tampering is refused", () => {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const bobKey = newMessageKey(bob.privateKey);
  assert.equal(verifyWith(bob.publicKey, messageKeyStatement(bobKey.public.public_key, bobKey.public.expires_at), bobKey.public.signature), true);
  const envelope = sealMessage({
    text: "Can you check the build log?",
    from: "alice-id",
    to: "bob-id",
    identityPrivate: alice.privateKey,
    identityPublic: alice.publicKey,
    recipientKey: bobKey.public,
  });
  assert.equal(isEnvelope(envelope), true);
  assert.equal(envelope.sender_key, fingerprint(alice.publicKey));
  const read = (e = envelope, me = "bob-id", sender = "alice-id", from = alice.publicKey) =>
    openMessage({ envelope: e, messagePrivate: bobKey.privateKey, senderIdentityPublic: from, me, sender });
  const payload = read();
  assert.equal(payload.text, "Can you check the build log?");
  assert.equal(revealMatches(payload.franking_key, payload.text, envelope.commitment), true);
  assert.equal(revealMatches(payload.franking_key, "Something else", envelope.commitment), false);

  const flip = (/** @type {string} */ s) => b64(Buffer.from(unb64(s).map((byte, i) => (i === 0 ? byte ^ 1 : byte))));
  assert.throws(() => read({ ...envelope, ct: flip(envelope.ct) }));
  assert.throws(() => read({ ...envelope, commitment: flip(envelope.commitment) }), /signature/);
  assert.throws(() => read(envelope, "carol-id"), /other agents/);
  assert.throws(() => read(envelope, "bob-id", "mallory-id"), /other agents/);
  assert.throws(() => read(envelope, "bob-id", "alice-id", bob.publicKey), /sender's key/);
  const mallory = generateIdentity();
  const resigned = { ...envelope, sender_key: fingerprint(mallory.publicKey), sig: b64(Buffer.alloc(64)) };
  assert.throws(() => read(resigned, "bob-id", "alice-id", mallory.publicKey), /signature/);
  // Properly re-signed by Mallory, the seal still names Alice's key in its associated data.
  const forged = { ...envelope, sender_key: fingerprint(mallory.publicKey) };
  const signed = { ...forged, sig: signWith(mallory.privateKey, envelopeStatement(forged)) };
  assert.throws(() => read(signed, "bob-id", "alice-id", mallory.publicKey), /unable to authenticate|Unsupported state/);
  assert.match(envelopeStatement(envelope), new RegExp(envelope.ct));
  assert.equal(isEnvelope({ ...envelope, extra: 1 }), false);
  assert.equal(isEnvelope({ ...envelope, v: 2 }), false);
  assert.equal(isEnvelope({ ...envelope, enc: "short" }), false);
});

test("an export opens with its passphrase only, and a changed one doesn't open", () => {
  const entry = { identity: { private: "a", public: "b" }, message_keys: [], pins: {}, sent: { m: { text: "hi", sent_at: "2026-11-27T12:00:00.000Z" } } };
  const sealed = sealExport(entry, "correct horse battery");
  assert.deepEqual(Object.keys(sealed), ["v", "kdf", "n", "r", "p", "salt", "nonce", "ct"]);
  assert.deepEqual([sealed.v, sealed.kdf, sealed.n, sealed.r, sealed.p], [1, "scrypt", 32768, 8, 1]);
  assert.equal(unb64(sealed.salt).length, 16);
  assert.equal(unb64(sealed.nonce).length, 12);
  assert.deepEqual(openExport(sealed, "correct horse battery"), entry);
  assert.throws(() => openExport(sealed, "wrong horse battery"), /passphrase is wrong/);
  const flipped = { ...sealed, ct: b64(Buffer.from(unb64(sealed.ct).map((byte, i) => (i === 3 ? byte ^ 1 : byte)))) };
  assert.throws(() => openExport(flipped, "correct horse battery"), /passphrase is wrong/);
  assert.throws(() => openExport({ ...sealed, n: 1 << 30 }, "correct horse battery"), /not an aMessage keys export/);
  assert.throws(() => openExport({ v: 2 }, "x"), /not an aMessage keys export/);
});
