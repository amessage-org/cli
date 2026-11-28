import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  associatedData,
  b64,
  dayKeyProblem,
  dayStart,
  ENC_BYTES,
  envelopeStatement,
  fingerprint,
  generateIdentity,
  generateXWing,
  hpkeInspect,
  hpkeOpen,
  hpkeOpenAt,
  hpkeSeal,
  identityPublicOf,
  isEnvelope,
  keyId,
  keysProblem,
  MAX_ENVELOPE_BYTES,
  messageKeyFor,
  messageKeyStatement,
  newMessageKeys,
  openExport,
  openMessage,
  PUBLIC_BYTES,
  revealMatches,
  sealExport,
  sealMessage,
  signWith,
  unb64,
  verifyWith,
  xwingPublicKey,
} from "../src/e2e.js";

// docs/design/encrypted-chats-vectors.json, copied: draft-ietf-hpke-pq's appendix A.5 vector, two
// identities and Bob's day key from fixed seeds, and one envelope from Alice to Bob.
const V = JSON.parse(readFileSync(new URL("./fixtures/encrypted-chats-vectors.json", import.meta.url), "utf8"));
const hex = (/** @type {string} */ s) => Buffer.from(s, "hex");
const EMPTY = Buffer.alloc(0);

test("HPKE matches draft-ietf-hpke-pq A.5: the X-Wing public key, shared secret, key schedule and each message", () => {
  const h = V.hpke;
  assert.equal(xwingPublicKey(hex(h.skRm)).toString("hex"), h.pkRm);
  assert.equal(hex(h.pkRm).length, PUBLIC_BYTES);
  assert.equal(hex(h.enc).length, ENC_BYTES);
  const schedule = hpkeInspect(hex(h.skRm), hex(h.enc), hex(h.info));
  assert.equal(schedule.shared.toString("hex"), h.shared_secret);
  assert.equal(schedule.key.toString("hex"), h.key);
  assert.equal(schedule.nonce.toString("hex"), h.base_nonce);
  assert.ok(h.encryptions.length >= 2);
  for (const e of h.encryptions) {
    assert.equal(hpkeOpenAt(hex(h.skRm), hex(h.enc), hex(h.info), hex(e.aad), hex(e.ct), hex(e.nonce)).toString("hex"), e.pt, `seq ${e.seq}`);
  }
  // The first message is single-shot HPKE: it opens with the base nonce.
  const first = h.encryptions[0];
  assert.equal(first.nonce, h.base_nonce);
  assert.equal(hpkeOpen(hex(h.skRm), hex(h.enc), hex(h.info), hex(first.aad), hex(first.ct)).toString("hex"), first.pt);
  const tampered = hex(first.ct);
  tampered[0] ^= 1;
  assert.throws(() => hpkeOpen(hex(h.skRm), hex(h.enc), hex(h.info), hex(first.aad), tampered));
  assert.throws(() => hpkeOpen(hex(h.skRm), hex(h.enc), hex(h.info), Buffer.from("other"), hex(first.ct)));
  assert.throws(() => hpkeOpen(hex(h.skRm), hex(h.enc).subarray(1), hex(h.info), hex(first.aad), hex(first.ct)), /X-Wing ciphertext/);
});

test("HPKE seals with fresh randomness to a new X-Wing key, and only that key opens it", () => {
  const r = generateXWing();
  assert.equal(r.privateKey.length, 32);
  assert.deepEqual(xwingPublicKey(r.privateKey), r.publicKey);
  const info = Buffer.from("amessage e2e v2");
  const one = hpkeSeal(r.publicKey, info, Buffer.from("aad"), Buffer.from("hello"));
  const two = hpkeSeal(r.publicKey, info, Buffer.from("aad"), Buffer.from("hello"));
  assert.equal(one.enc.length, ENC_BYTES);
  assert.equal(one.ct.length, 5 + 16);
  assert.notDeepEqual(one.enc, two.enc);
  assert.equal(hpkeOpen(r.privateKey, one.enc, info, Buffer.from("aad"), one.ct).toString(), "hello");
  assert.throws(() => hpkeOpen(generateXWing().privateKey, one.enc, info, Buffer.from("aad"), one.ct));
  assert.throws(() => hpkeOpen(r.privateKey, one.enc, Buffer.from("amessage e2e v1"), Buffer.from("aad"), one.ct));
  assert.throws(() => hpkeSeal(r.publicKey.subarray(1), info, EMPTY, EMPTY), /1,216 bytes/);
});

test("the vector file's identities, day key, statements and signatures come out byte for byte, and its envelope opens", () => {
  const alice = unb64(V.alice_identity.private);
  const bob = unb64(V.bob_identity.private);
  assert.equal(b64(identityPublicOf(alice)), V.alice_identity.public);
  assert.equal(b64(identityPublicOf(bob)), V.bob_identity.public);
  assert.equal(fingerprint(unb64(V.alice_identity.public)), V.alice_identity.fingerprint);
  assert.equal(fingerprint(unb64(V.bob_identity.public)), V.bob_identity.fingerprint);

  // Bob's day key for 2026-12-01, from its seed: public key, key id, both dates and the signature.
  const { private_seed, statement, ...published } = V.bob_day_key;
  const day = messageKeyFor(bob, unb64(private_seed), new Date("2026-12-01T18:00:00Z"));
  assert.equal(JSON.stringify(day.public), JSON.stringify(published));
  assert.equal(keyId(unb64(published.public_key)), published.key_id);
  assert.equal(messageKeyStatement(published.public_key, published.valid_from, published.expires_at), statement);
  assert.equal(signWith(bob, statement), published.signature);
  assert.equal(verifyWith(unb64(V.bob_identity.public), statement, published.signature), true);
  assert.equal(dayKeyProblem(unb64(V.bob_identity.public), published), null);

  // The keys as aMessage gives them hold together on their day, give or take a day of clock skew.
  const keys = { identity_key: V.bob_identity.public, fingerprint: V.bob_identity.fingerprint, message_key: published };
  assert.equal(keysProblem(keys, new Date(V.sent_at)), null);
  assert.equal(keysProblem(keys, new Date("2026-12-02T23:59:00Z")), null);
  assert.equal(keysProblem(keys, new Date("2026-12-03T00:00:00Z")), "the day key has ended");
  assert.equal(keysProblem(keys, new Date("2026-11-29T23:59:00Z")), "the day key's day hasn't come");
  assert.equal(keysProblem({ ...keys, fingerprint: V.alice_identity.fingerprint }, new Date(V.sent_at)), "the fingerprint isn't the identity key's");
  assert.equal(keysProblem({ ...keys, identity_key: V.alice_identity.public, fingerprint: V.alice_identity.fingerprint }, new Date(V.sent_at)), "the identity key didn't sign the day key");
  assert.equal(keysProblem({ ...keys, message_key: { ...published, expires_at: "2026-12-03T00:00:00.000Z" } }, new Date(V.sent_at)), "the day key doesn't cover one UTC day");
  assert.equal(keysProblem({ ...keys, message_key: { ...published, public_key: b64(Buffer.alloc(32)) } }, new Date(V.sent_at)), "the day key isn't 1,216 bytes");

  // The envelope: its signed statement, its associated data, its signature, and what it opens to.
  const e = V.envelope;
  assert.equal(isEnvelope(e), true);
  assert.equal(envelopeStatement(e), V.envelope_statement);
  assert.equal(associatedData(e.sender_key, e.recipient_key).toString(), V.associated_data);
  assert.equal(verifyWith(unb64(V.alice_identity.public), V.envelope_statement, e.sig), true);
  const payload = JSON.parse(V.plaintext_payload);
  const opened = openMessage({
    envelope: e,
    messagePrivate: unb64(private_seed),
    senderIdentityPublic: unb64(V.alice_identity.public),
    me: payload.to,
    sender: payload.from,
  });
  assert.equal(JSON.stringify(opened), V.plaintext_payload);
  assert.equal(opened.franking_key, V.franking_key);
  assert.equal(opened.sent_at, V.sent_at);
  assert.equal(revealMatches(opened.franking_key, opened.text, e.commitment), true);
  assert.equal(revealMatches(opened.franking_key, `${opened.text}!`, e.commitment), false);
});

test("day keys cover one UTC day each, seven at a time, and only today's opens what was sealed to it", () => {
  const alice = generateIdentity();
  const bob = generateIdentity();
  const keys = newMessageKeys(bob.privateKey, new Date("2026-12-03T10:00:00Z"));
  assert.equal(keys.length, 7);
  assert.deepEqual(
    keys.map((k) => k.public.valid_from),
    Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 11, 3 + i)).toISOString()),
  );
  for (const k of keys) {
    assert.equal(Date.parse(k.public.expires_at) - Date.parse(k.public.valid_from), 86_400_000);
    assert.equal(dayKeyProblem(bob.publicKey, k.public), null);
    assert.equal(dayKeyProblem(alice.publicKey, k.public), "the identity key didn't sign the day key");
  }
  assert.equal(new Set(keys.map((k) => k.public.key_id)).size, 7);
  assert.equal(dayStart(new Date("2026-12-03T23:59:59.999Z")).toISOString(), "2026-12-03T00:00:00.000Z");
  const today = keys[0];

  const envelope = sealMessage({
    text: "Can you check the build log?",
    from: "alice-id",
    to: "bob-id",
    identityPrivate: alice.privateKey,
    identityPublic: alice.publicKey,
    recipientKey: today.public,
  });
  assert.equal(isEnvelope(envelope), true);
  assert.deepEqual(Object.keys(envelope), ["v", "suite", "sender_key", "recipient_key", "enc", "ct", "commitment", "sig"]);
  assert.equal(envelope.v, 2);
  assert.equal(envelope.suite, "mlkem768x25519-hkdf-sha256-chacha20poly1305");
  assert.equal(envelope.sender_key, fingerprint(alice.publicKey));
  assert.equal(envelope.recipient_key, today.public.key_id);
  const read = (e = envelope, me = "bob-id", sender = "alice-id", from = alice.publicKey, key = today.privateKey) =>
    openMessage({ envelope: e, messagePrivate: key, senderIdentityPublic: from, me, sender });
  const payload = read();
  assert.equal(payload.text, "Can you check the build log?");
  assert.equal(revealMatches(payload.franking_key, payload.text, envelope.commitment), true);
  assert.throws(() => read(envelope, "bob-id", "alice-id", alice.publicKey, keys[1].privateKey));

  const flip = (/** @type {string} */ s) => b64(Buffer.from(unb64(s).map((byte, i) => (i === 0 ? byte ^ 1 : byte))));
  assert.throws(() => read({ ...envelope, ct: flip(envelope.ct) }));
  assert.throws(() => read({ ...envelope, enc: flip(envelope.enc) }));
  assert.throws(() => read({ ...envelope, commitment: flip(envelope.commitment) }), /signature/);
  assert.throws(() => read({ ...envelope, v: /** @type {any} */ (1) }), /unknown envelope version/);
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
  assert.match(envelopeStatement(envelope), new RegExp(`^amessage e2e v2 envelope\n${envelope.suite}\n`));
  assert.equal(isEnvelope({ ...envelope, extra: 1 }), false);
  assert.equal(isEnvelope({ ...envelope, v: 1 }), false);
  assert.equal(isEnvelope({ ...envelope, suite: "x25519-hkdf-sha256-aes128gcm" }), false);
  assert.equal(isEnvelope({ ...envelope, enc: b64(Buffer.alloc(32)) }), false);

  // 2,000 characters in any script fit under the limit.
  const wide = sealMessage({
    text: "界".repeat(2000),
    from: "alice-id",
    to: "bob-id",
    identityPrivate: alice.privateKey,
    identityPublic: alice.publicKey,
    recipientKey: today.public,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(wide)) < MAX_ENVELOPE_BYTES);
  assert.equal(MAX_ENVELOPE_BYTES, 14_336);
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
