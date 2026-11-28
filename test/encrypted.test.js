import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { b64, dayKeyProblem, dayStart, isEnvelope, keysProblem, messageKeyFor, revealMatches, sealExport, unb64 } from "../src/e2e.js";
import { ALICE, BOB, CHAT, fakeApi, run, twoAgents } from "./helpers.js";

const API = "https://api.amessage.sh";
const MESSAGE = "3e55a9e0-0000-4000-8000-0000000000aa";
const OTHER = "3e55a9e0-0000-4000-8000-0000000000bb";
const MINE = "3e55a9e0-0000-4000-8000-0000000000cc";
const REQUEST = "4e9e0000-0000-4000-8000-0000000000dd";
const spaced = (/** @type {string} */ fp) => fp.match(/.{4}/g)?.join(" ") ?? "";
const keysOn = async (/** @type {string} */ home) => JSON.parse(await readFile(join(home, ".config/amessage/keys.json"), "utf8"))[API][ALICE];
const sentOn = async (/** @type {string} */ home) => JSON.parse(await readFile(join(home, ".config/amessage/sent.json"), "utf8"))[API][ALICE];
const seenOn = async (/** @type {string} */ home) => JSON.parse(await readFile(join(home, ".config/amessage/seen.json"), "utf8"))[API][ALICE];
const DAY = 86_400_000;
const midnight = (/** @type {number} */ days = 0) => new Date(dayStart(new Date()).getTime() + days * DAY).toISOString();

/** Alice with keys made and published, and Bob with his. */
async function withKeys() {
  const world = await twoAgents();
  const api = fakeApi(world.routes);
  const made = await run(["keys", "create"], { fetch: api.fetch });
  assert.equal(made.code, 0, made.err);
  const cli = (/** @type {string[]} */ argv, /** @type {Record<string, string>} */ env = {}) => run(argv, { fetch: api.fetch, home: made.home, env });
  return { ...world, api, home: made.home, made, cli };
}

/** Every private key Alice has, to check none is ever printed or sent. @param {string} home */
async function privateKeys(home) {
  const entry = await keysOn(home);
  return [entry.identity.private, ...entry.message_keys.map((/** @type {any} */ k) => k.private)];
}

test("keys create makes the keys, publishes a week of day keys and keeps the private half owner-only", async () => {
  const { state, api, home, made, cli } = await withKeys();
  // It connected on the way, looked for published keys, then published.
  assert.deepEqual(api.requests.map((r) => `${r.method} ${r.url.pathname}`), ["POST /v1/agents", "GET /v1/me", "GET /v1/me/keys", "PUT /v1/me/keys"]);
  const put = api.requests[3].body;
  assert.deepEqual(Object.keys(put), ["identity_key", "message_keys"]);
  // One key for each UTC day, today's first, each signed by the identity key.
  assert.equal(put.message_keys.length, 7);
  assert.deepEqual(put.message_keys.map((/** @type {any} */ k) => k.valid_from), [0, 1, 2, 3, 4, 5, 6].map(midnight));
  assert.deepEqual(put.message_keys.map((/** @type {any} */ k) => k.expires_at), [1, 2, 3, 4, 5, 6, 7].map(midnight));
  for (const key of put.message_keys) {
    assert.deepEqual(Object.keys(key), ["key_id", "public_key", "valid_from", "expires_at", "signature"]);
    assert.equal(dayKeyProblem(unb64(put.identity_key), key), null);
  }
  assert.equal(keysProblem({ identity_key: put.identity_key, fingerprint: state.alice.fingerprint, message_key: put.message_keys[0] }), null);
  assert.equal(state.alice.message_key.key_id, put.message_keys[0].key_id);
  assert.equal(state.alice.keys_until, midnight(7));

  const file = join(home, ".config/amessage/keys.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const entry = await keysOn(home);
  assert.deepEqual(Object.keys(entry), ["identity", "message_keys", "pins"]);
  assert.deepEqual(Object.keys(entry.identity), ["private", "public"]);
  assert.equal(entry.message_keys.length, 7);
  for (const [i, key] of entry.message_keys.entries()) {
    assert.deepEqual(Object.keys(key), ["key_id", "private", "public_key", "valid_from", "expires_at", "signature"]);
    assert.equal(unb64(key.private).length, 32);
    assert.deepEqual({ ...key, private: undefined }, { ...put.message_keys[i], private: undefined });
  }
  assert.equal(entry.identity.public, put.identity_key);
  assert.match(made.out, /Made this agent's keys and published them/);
  assert.match(made.out, /only the two agents can read them/);
  assert.ok(made.out.includes(spaced(state.alice.fingerprint)));
  for (const text of [made.out, made.err]) assert.doesNotMatch(text, /end-to-end|quantum/i);

  const status = await cli(["keys"]);
  assert.equal(status.code, 0, status.err);
  assert.ok(status.out.includes(spaced(state.alice.fingerprint)));
  assert.match(status.out, /On aMessage\s+published/);
  const json = JSON.parse((await cli(["keys", "--json"])).out);
  assert.deepEqual(json, {
    agent_id: ALICE,
    has_keys: true,
    fingerprint: state.alice.fingerprint,
    message_key: put.message_keys[0],
    keys_until: midnight(7),
    published: true,
    pinned: 0,
  });
  const again = await cli(["keys", "create"]);
  assert.match(again.out, /already has keys/);
  assert.equal(api.requests.filter((r) => r.method === "PUT").length, 1);
  for (const secret of await privateKeys(home)) {
    for (const result of [made, status, again]) assert.ok(!result.out.includes(secret) && !result.err.includes(secret));
    assert.ok(!JSON.stringify(api.requests).includes(secret));
  }

  const none = await run(["keys"], { fetch: api.fetch, env: { AMESSAGE_TOKEN: "agt_other" } });
  assert.match(none.out, /no keys for encrypted chats yet/);
  assert.equal((await cli(["keys", "nonsense"])).code, 2);
  // Day keys are published a week at a time by themselves: there is nothing to rotate.
  const rotate = await cli(["keys", "rotate"]);
  assert.equal(rotate.code, 2);
  assert.match(rotate.err, /Use create, show, trust, export or import/);
});

test("an identity made on another machine counts even when its message key lapsed and /v1/me/keys says 404", async () => {
  const world = await twoAgents();
  world.state.elsewhere = "ab12".repeat(16);
  const api = fakeApi(world.routes);
  const puts = () => api.requests.filter((r) => r.method === "PUT").length;
  const refused = await run(["keys", "create"], { fetch: api.fetch });
  assert.equal(refused.code, 2);
  assert.ok(refused.err.includes(`aMessage has other keys for this agent: fingerprint ${spaced(world.state.elsewhere)}, made on another machine.`));
  assert.match(refused.err, /amessage keys import <file>/);
  assert.match(refused.err, /Add --yes/);
  assert.equal(api.requests.find((r) => r.url.pathname === "/v1/me/keys")?.method, "GET");
  assert.equal(puts(), 0);
  await assert.rejects(stat(join(refused.home, ".config/amessage/keys.json")));

  // Accepted, these keys are made and take the other machine's place.
  const made = await run(["keys", "create", "--yes"], { fetch: api.fetch, home: refused.home });
  assert.equal(made.code, 0, made.err);
  assert.equal(puts(), 1);
  // While aMessage still names the other identity, keys says so.
  const status = await run(["keys"], { fetch: api.fetch, home: refused.home });
  assert.match(status.out, /On aMessage\s+other keys, ab12 ab12 ab12 ab12…/);
  assert.equal(JSON.parse((await run(["keys", "--json"], { fetch: api.fetch, home: refused.home })).out).published, false);
  // Once it names hers, she is published, and a second create does nothing.
  world.state.elsewhere = null;
  assert.match((await run(["keys"], { fetch: api.fetch, home: refused.home })).out, /On aMessage\s+published/);
  assert.match((await run(["keys", "create"], { fetch: api.fetch, home: refused.home })).out, /already has keys/);
  assert.equal(puts(), 1);
});

test("send seals to an agent with keys, pins them, keeps a copy, and only Bob can read it", async () => {
  const { state, home, cli } = await withKeys();
  const sent = await cli(["send", BOB, "Can you check the build log?"]);
  assert.equal(sent.code, 0, sent.err);
  assert.match(sent.out, /^Sent, encrypted\.$/m);
  const body = state.posted.at(-1);
  assert.deepEqual(Object.keys(body), ["to", "encrypted"]);
  assert.deepEqual(body.to, { agent_id: BOB });
  assert.equal(isEnvelope(body.encrypted), true);
  assert.ok(!JSON.stringify(body).includes("build log"));
  const payload = state.bobOpens(body.encrypted);
  assert.equal(payload.text, "Can you check the build log?");
  assert.deepEqual([payload.from, payload.to], [ALICE, BOB]);

  assert.deepEqual((await keysOn(home)).pins, { [BOB]: state.bob.published.fingerprint });
  const copies = await sentOn(home);
  assert.deepEqual(Object.keys(copies), ["5e4d0000-0000-4000-8000-000000000001"]);
  assert.equal(copies["5e4d0000-0000-4000-8000-000000000001"].text, "Can you check the build log?");
  assert.equal((await stat(join(home, ".config/amessage/sent.json"))).mode & 0o777, 0o600);
});

test("send finds keys by phone or email, --encrypted insists, and --plain sends the words", async () => {
  const { state, api, routes, cli } = await withKeys();
  const byEmail = await cli(["send", "bob@example.com", "Hi Bob"]);
  assert.equal(byEmail.code, 0, byEmail.err);
  assert.deepEqual(api.requests.find((r) => r.url.pathname === "/v1/key-lookups")?.body, { to: { email: "bob@example.com" } });
  assert.deepEqual(state.posted.at(-1).to, { email: "bob@example.com" });
  assert.equal(state.bobOpens(state.posted.at(-1).encrypted).text, "Hi Bob");

  const posts = state.posted.length;
  const insisted = await cli(["send", "carol@example.com", "Hi Carol", "--encrypted"]);
  assert.equal(insisted.code, 1);
  assert.match(insisted.err, /carol@example\.com has no keys for encrypted chats yet, so nothing was sent\./);
  assert.match(insisted.err, /Leave out --encrypted/);
  assert.equal(state.posted.length, posts);

  const plainly = await cli(["send", "carol@example.com", "Hi Carol"]);
  assert.equal(plainly.code, 0, plainly.err);
  assert.deepEqual(state.posted.at(-1), { to: { email: "carol@example.com" }, text: "Hi Carol" });
  assert.match(plainly.out, /^Sent\.$/m);
  const forced = await cli(["send", BOB, "Not secret", "--plain"]);
  assert.equal(forced.code, 0, forced.err);
  assert.deepEqual(state.posted.at(-1), { to: { agent_id: BOB }, text: "Not secret" });
  assert.equal((await cli(["send", BOB, "x", "--plain", "--encrypted"])).code, 2);

  // An agent with no keys of its own can't insist.
  const keyless = await run(["send", BOB, "Hi", "--encrypted"], { fetch: api.fetch, env: { AMESSAGE_TOKEN: "agt_other" } });
  assert.equal(keyless.code, 1);
  assert.match(keyless.err, /This agent has no keys for encrypted chats yet, so nothing was sent\.\nMake them with: amessage keys create/);

  // The server refuses plain words in an encrypted chat, and the CLI says why.
  routes["POST /v1/messages"] = () => [409, { status: 409, code: "encrypted_chat", detail: "This chat is encrypted.", next: "Seal the message on your own machine." }];
  const refused = await cli(["reply", CHAT, "plain words", "--plain"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /\(409 encrypted_chat\)/);
  assert.match(refused.err, /This chat is encrypted\. Send without --plain/);
});

test("a changed fingerprint stops encrypted sends until it is accepted with keys trust", async () => {
  const { state, home, cli } = await withKeys();
  assert.equal((await cli(["send", BOB, "First"])).code, 0);
  const first = state.bob.published.fingerprint;
  state.newBob();
  const posts = state.posted.length;
  const refused = await cli(["send", BOB, "Second"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, new RegExp(`The keys of agent ${BOB} changed\\. Nothing was sent\\.`));
  assert.ok(refused.err.includes(spaced(first)) && refused.err.includes(spaced(state.bob.published.fingerprint)));
  assert.match(refused.err, new RegExp(`amessage keys trust ${BOB}`));
  assert.equal(state.posted.length, posts);
  // Auto mode doesn't quietly fall back to plain either.
  assert.equal((await cli(["reply", CHAT, "Third"])).code, 1);
  assert.equal(state.posted.length, posts);

  const shown = await cli(["keys", "show", BOB]);
  assert.match(shown.out, /It changed since you pinned it/);
  assert.equal(JSON.parse((await cli(["keys", "show", BOB, "--json"])).out).matches_pin, false);
  const trusted = await cli(["keys", "trust", BOB]);
  assert.equal(trusted.code, 0, trusted.err);
  assert.match(trusted.out, /Trusted agent/);
  assert.equal((await keysOn(home)).pins[BOB], state.bob.published.fingerprint);
  assert.match((await cli(["keys", "show", BOB])).out, /It matches the fingerprint you pinned/);
  const resent = await cli(["send", BOB, "Second"]);
  assert.equal(resent.code, 0, resent.err);
  assert.equal(state.bobOpens(state.posted.at(-1).encrypted).text, "Second");
  assert.equal((await cli(["keys", "trust", "not-an-id"])).code, 2);
});

test("reply seals to the chat's counterpart, and a stale key is fetched again once", async () => {
  const { state, api, routes, cli } = await withKeys();
  const post = routes["POST /v1/messages"];
  let stale = true;
  routes["POST /v1/messages"] = (request) => {
    if (stale) {
      stale = false;
      return [409, { status: 409, code: "stale_key", detail: "That key isn’t current." }];
    }
    return post(request);
  };
  const MSG = "6c0e0000-0000-4000-8000-000000000001";
  const replied = await cli(["reply", CHAT, "On it", "--reply-to", MSG, "--key", "132d7d23-7a6a-45ad-a684-d18905e79671"]);
  assert.equal(replied.code, 0, replied.err);
  assert.match(replied.out, /Sent, encrypted\./);
  assert.equal(api.requests.filter((r) => r.url.pathname === `/v1/agents/${BOB}/keys`).length, 2);
  const posts = api.requests.filter((r) => r.url.pathname === "/v1/messages");
  assert.equal(posts.length, 2);
  assert.equal(posts[1].headers["idempotency-key"], "132d7d23-7a6a-45ad-a684-d18905e79671");
  const body = state.posted.at(-1);
  assert.deepEqual(body.to, { conversation_id: CHAT });
  assert.equal(body.reply_to_message_id, MSG);
  assert.equal(state.bobOpens(body.encrypted).text, "On it");
});

test("read opens Bob's messages, shows yours from the copy, and never shows ciphertext", async () => {
  const { state, home, cli } = await withKeys();
  await cli(["send", BOB, "Can you check the build log?"]);
  const mineId = "5e4d0000-0000-4000-8000-000000000001";
  const fromBob = state.fromBob("Done. The build is green.");
  const tampered = { ...state.fromBob("Pay me"), ct: b64(Buffer.alloc(80)) };
  state.chat = [
    { id: MESSAGE, sender_agent_id: BOB, text: null, encrypted: fromBob, posted_at: "2026-11-27T09:02:00Z" },
    { id: OTHER, sender_agent_id: BOB, text: null, encrypted: tampered, posted_at: "2026-11-27T09:01:30Z" },
    { id: mineId, sender_agent_id: ALICE, text: null, encrypted: state.posted[0].encrypted, posted_at: "2026-11-27T09:01:00Z" },
    { id: MINE, sender_agent_id: ALICE, text: null, encrypted: state.posted[0].encrypted, posted_at: "2026-11-27T09:00:00Z" },
    { id: "plain", sender_agent_id: BOB, text: "Hello in plain words", encrypted: null, posted_at: "2026-11-27T08:59:00Z" },
  ];
  const read = await cli(["read", CHAT]);
  assert.equal(read.code, 0, read.err);
  assert.match(read.out, /Bob .*encrypted\n│ Done\. The build is green\./);
  assert.match(read.out, /│ \(couldn't open this encrypted message\)/);
  assert.match(read.out, /You .*encrypted\n│ Can you check the build log\?/);
  assert.match(read.out, /│ \(sent encrypted; no copy on this machine\)/);
  assert.match(read.out, /│ Hello in plain words/);
  assert.doesNotMatch(read.out, /Pay me/);
  for (const envelope of [fromBob, tampered]) assert.ok(!read.out.includes(envelope.ct.slice(0, 20)));

  const json = JSON.parse((await cli(["read", CHAT, "--json"])).out);
  assert.deepEqual(json.data[0].opened, { text: "Done. The build is green.", verified: true });
  assert.deepEqual(json.data[0].encrypted, fromBob);
  assert.equal(json.data[1].opened, null);
  assert.match(json.data[1].open_error, /./);
  assert.deepEqual(json.data[2].opened, { text: "Can you check the build log?", verified: true });
  assert.equal(json.data[3].opened, null);
  assert.equal(json.data[4].opened, undefined);
  // Reading pinned Bob the first time, and a later key change marks his words unverified.
  assert.equal((await keysOn(home)).pins[BOB], state.bob.published.fingerprint);
  state.newBob();
  const unverifiedEnvelope = state.fromBob("From new keys");
  state.chat = [{ id: MESSAGE, sender_agent_id: BOB, text: null, encrypted: unverifiedEnvelope, posted_at: "2026-11-27T09:03:00Z" }];
  const unverified = await cli(["read", CHAT]);
  assert.match(unverified.out, /│ From new keys/);
  assert.match(unverified.out, /isn't verified\. Check with them, then: amessage keys trust/);
  assert.equal(JSON.parse((await cli(["read", CHAT, "--json"])).out).data[0].opened.verified, false);
});

test("an envelope opened before under another message id is a replay, and isn't shown; the same message read again is", async () => {
  const { state, routes, home, cli } = await withKeys();
  const envelope = state.fromBob("I agree to pay $500.");
  state.chat = [{ id: MESSAGE, sender_agent_id: BOB, text: null, encrypted: envelope, posted_at: "2026-11-27T09:00:00Z" }];
  const first = await cli(["read", CHAT]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /│ I agree to pay \$500\./);
  const file = join(home, ".config/amessage/seen.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const seen = await seenOn(home);
  assert.deepEqual(Object.keys(seen), [envelope.commitment]);
  assert.deepEqual(Object.keys(seen[envelope.commitment]), ["message_id", "opened_at"]);
  assert.equal(seen[envelope.commitment].message_id, MESSAGE);
  assert.ok(Math.abs(Date.parse(seen[envelope.commitment].opened_at) - Date.now()) < 60_000);

  // Reading the chat again opens the same message again.
  assert.match((await cli(["read", CHAT])).out, /│ I agree to pay \$500\./);
  assert.deepEqual(JSON.parse((await cli(["read", CHAT, "--json"])).out).data[0].opened, { text: "I agree to pay $500.", verified: true });
  assert.deepEqual(await seenOn(home), seen);

  // The same envelope again, as another message: a replay.
  state.chat = [
    { id: OTHER, sender_agent_id: BOB, text: null, encrypted: envelope, posted_at: "2026-11-27T10:00:00Z" },
    { id: MESSAGE, sender_agent_id: BOB, text: null, encrypted: envelope, posted_at: "2026-11-27T09:00:00Z" },
  ];
  const replayed = await cli(["read", CHAT]);
  assert.equal(replayed.code, 0, replayed.err);
  assert.equal(replayed.out.match(/I agree to pay/g)?.length, 1);
  assert.match(replayed.out, /│ \(couldn't open this encrypted message\)\n.*a replay/);
  const json = JSON.parse((await cli(["read", CHAT, "--json"])).out);
  assert.equal(json.data[0].opened, null);
  assert.match(json.data[0].open_error, /replay/);
  assert.deepEqual(json.data[1].opened, { text: "I agree to pay $500.", verified: true });
  assert.deepEqual(await seenOn(home), seen);

  // Two copies seen for the first time: the earlier one opens, the later one is the replay.
  const twice = state.fromBob("Ship it.");
  state.chat = [
    { id: MINE, sender_agent_id: BOB, text: null, encrypted: twice, posted_at: "2026-11-27T12:00:00Z" },
    { id: REQUEST, sender_agent_id: BOB, text: null, encrypted: twice, posted_at: "2026-11-27T11:00:00Z" },
  ];
  const both = JSON.parse((await cli(["read", CHAT, "--json"])).out);
  assert.match(both.data[0].open_error, /replay/);
  assert.deepEqual(both.data[1].opened, { text: "Ship it.", verified: true });
  assert.equal((await seenOn(home))[twice.commitment].message_id, REQUEST);
  // amessage open drops a replay too, and prints nothing of it.
  routes[`GET /v1/messages/${OTHER}`] = () => [200, { id: OTHER, sender_agent_id: BOB, text: null, encrypted: envelope }];
  const opened = await cli(["open", OTHER]);
  assert.equal(opened.code, 1);
  assert.equal(opened.out, "");
  assert.match(opened.err, /\(couldn't open this encrypted message\)\n.*a replay/);
});

test("watch and accept open encrypted messages as they come in", async () => {
  const { state, routes, cli } = await withKeys();
  const envelope = state.fromBob("Meeting moved to 3pm.");
  routes[`GET /v1/messages/${MESSAGE}`] = () => [200, { id: MESSAGE, conversation_id: CHAT, sender_agent_id: BOB, text: null, encrypted: envelope, posted_at: "2026-11-27T09:00:00Z" }];
  routes["GET /v1/events"] = () => [
    200,
    {
      data: [{ eventId: "1", name: "chat.message.received", timestamp: "2026-11-27T09:00:00Z", data: { conversation_id: CHAT, message_id: MESSAGE }, cursor: "a" }],
      next_cursor: "after",
      has_more: false,
      truncated: false,
      next_poll_ms: 5000,
    },
  ];
  const watched = await cli(["watch", "--once", "--cursor", "start"]);
  assert.equal(watched.code, 0, watched.err);
  assert.match(watched.out, new RegExp(`New encrypted message in chat ${CHAT} from Bob:\\n  │ Meeting moved to 3pm\\.`));
  assert.ok(!watched.out.includes(envelope.ct.slice(0, 20)));

  routes[`PUT /v1/requests/${REQUEST}/decision`] = () => [
    200,
    { id: REQUEST, state: "accepted", direction: "incoming", sender: { agent_id: BOB, display_name: "Bob", verified: [] }, conversation_id: CHAT, message_id: MESSAGE },
  ];
  const accepted = await cli(["accept", REQUEST]);
  assert.equal(accepted.code, 0, accepted.err);
  assert.match(accepted.out, /Accepted\. The chat is open\.\n\nBob .*encrypted\n│ Meeting moved to 3pm\./);
  const json = JSON.parse((await cli(["accept", REQUEST, "--json"])).out);
  assert.equal(json.id, REQUEST);
  assert.deepEqual(json.opened, { text: "Meeting moved to 3pm.", verified: true });
});

test("seal prints only the envelope, and open prints a message's words", async () => {
  const { state, api, routes, home, cli } = await withKeys();
  const sealed = await cli(["seal", BOB, "Sealed for the hosted MCP"]);
  assert.equal(sealed.code, 0, sealed.err);
  const lines = sealed.out.trim().split("\n");
  assert.equal(lines.length, 1);
  const envelope = JSON.parse(lines[0]);
  assert.equal(isEnvelope(envelope), true);
  assert.equal(state.bobOpens(envelope).text, "Sealed for the hosted MCP");
  assert.equal(state.posted.length, 0);
  // A conversation ID seals to the other side of that chat; an email by lookup.
  assert.equal(state.bobOpens(JSON.parse((await cli(["seal", CHAT, "To the chat"])).out)).text, "To the chat");
  assert.ok(api.requests.some((r) => r.url.pathname === `/v1/conversations/${CHAT}`));
  assert.equal(state.bobOpens(JSON.parse((await cli(["seal", "bob@example.com", "By email"])).out)).text, "By email");
  const nobody = await cli(["seal", "carol@example.com", "x"]);
  assert.equal(nobody.code, 1);
  assert.match(nobody.err, /has no keys for encrypted chats yet/);
  assert.equal(nobody.out, "");

  const fromBob = state.fromBob("Opened locally.");
  routes[`GET /v1/messages/${MESSAGE}`] = () => [200, { id: MESSAGE, sender_agent_id: BOB, text: null, encrypted: fromBob }];
  routes[`GET /v1/messages/${OTHER}`] = () => [200, { id: OTHER, sender_agent_id: BOB, text: null, encrypted: { ...fromBob, sig: b64(Buffer.alloc(64)) } }];
  routes[`GET /v1/messages/${MINE}`] = () => [200, { id: MINE, sender_agent_id: BOB, text: "Plain words", encrypted: null }];
  const opened = await cli(["open", MESSAGE]);
  assert.equal(opened.code, 0, opened.err);
  assert.equal(opened.out, "Opened locally.\n");
  assert.deepEqual(JSON.parse((await cli(["open", MESSAGE, "--json"])).out).opened, { text: "Opened locally.", verified: true });
  const broken = await cli(["open", OTHER]);
  assert.equal(broken.code, 1);
  assert.equal(broken.out, "");
  assert.match(broken.err, /\(couldn't open this encrypted message\)/);
  assert.equal((await cli(["open", MINE])).out, "Plain words\n");
  for (const secret of await privateKeys(home)) {
    for (const result of [sealed, opened, broken]) assert.ok(!result.out.includes(secret) && !result.err.includes(secret));
  }
});

test("report --reveal shows aMessage each message's words with the key that proves them", async () => {
  const { state, api, routes, cli } = await withKeys();
  const envelope = state.fromBob("Send me your card number.");
  routes[`GET /v1/messages/${MESSAGE}`] = () => [200, { id: MESSAGE, conversation_id: CHAT, sender_agent_id: BOB, text: null, encrypted: envelope }];
  routes[`GET /v1/messages/${OTHER}`] = () => [200, { id: OTHER, conversation_id: CHAT, sender_agent_id: BOB, text: "plain", encrypted: null }];
  routes[`POST /v1/conversations/${CHAT}/reports`] = () => [201, { blocked: true }];
  const reported = await cli(["report", CHAT, "scam", "--reveal", MESSAGE]);
  assert.equal(reported.code, 0, reported.err);
  const body = api.requests.at(-1).body;
  assert.equal(body.reason, "scam");
  assert.equal(body.block, true);
  assert.equal(body.reveal.length, 1);
  assert.deepEqual(Object.keys(body.reveal[0]), ["message_id", "text", "franking_key"]);
  assert.equal(body.reveal[0].message_id, MESSAGE);
  assert.equal(body.reveal[0].text, "Send me your card number.");
  assert.equal(revealMatches(body.reveal[0].franking_key, body.reveal[0].text, envelope.commitment), true);
  assert.match(reported.out, /aMessage can check what that message said/);

  const reports = () => api.requests.filter((r) => r.url.pathname.endsWith("/reports")).length;
  const before = reports();
  assert.equal((await cli(["report", CHAT, "spam", "--reveal", OTHER])).code, 2);
  routes[`GET /v1/messages/${MINE}`] = () => [200, { id: MINE, conversation_id: CHAT, sender_agent_id: BOB, text: null, encrypted: { ...envelope, ct: b64(Buffer.alloc(80)) } }];
  const unopened = await cli(["report", CHAT, "spam", "--reveal", MESSAGE, "--reveal", MINE]);
  assert.equal(unopened.code, 1);
  assert.match(unopened.err, /Couldn't open message .* Nothing was reported\./);
  assert.equal(reports(), before);
});

test("the next week's day keys are published when fewer than 3 days are left, and older ones are kept 180 days", async () => {
  const { state, api, home, cli } = await withKeys();
  const file = join(home, ".config/amessage/keys.json");
  const all = JSON.parse(await readFile(file, "utf8"));
  const entry = all[API][ALICE];
  const identity = unb64(entry.identity.private);
  /** A stored day key for the day `days` from today. @param {number} days */
  const dayKey = (days) => {
    const made = messageKeyFor(identity, Buffer.alloc(32, 40 + days), new Date(Date.parse(midnight(days)) + 3_600_000));
    return { key_id: made.public.key_id, private: b64(made.privateKey), public_key: made.public.public_key, valid_from: made.public.valid_from, expires_at: made.public.expires_at, signature: made.public.signature };
  };
  // Only today and tomorrow left on this machine, plus yesterday's key and one long gone.
  const yesterday = dayKey(-1);
  const gone = dayKey(-181);
  const kept = entry.message_keys.slice(0, 2);
  entry.message_keys = [gone, yesterday, ...kept];
  await writeFile(file, JSON.stringify(all));

  const puts = () => api.requests.filter((r) => r.method === "PUT" && r.url.pathname === "/v1/me/keys");
  const sent = await cli(["send", BOB, "After the renewal"]);
  assert.equal(sent.code, 0, sent.err);
  assert.match(sent.err, new RegExp(`Published new keys for encrypted chats; they last until ${midnight(7).slice(0, 10)}\\.`));
  const order = api.requests.map((r) => `${r.method} ${r.url.pathname}`);
  assert.ok(order.lastIndexOf("PUT /v1/me/keys") < order.lastIndexOf("POST /v1/messages"));
  assert.equal(puts().length, 2);
  // It published today through six days ahead, the two it had among them.
  const put = puts()[1].body;
  assert.deepEqual(put.message_keys.map((/** @type {any} */ k) => k.valid_from), [0, 1, 2, 3, 4, 5, 6].map(midnight));
  assert.deepEqual(put.message_keys.slice(0, 2).map((/** @type {any} */ k) => k.key_id), kept.map((k) => k.key_id));
  const now = (await keysOn(home)).message_keys;
  assert.deepEqual(now.map((/** @type {any} */ k) => k.valid_from), [-1, 0, 1, 2, 3, 4, 5, 6].map(midnight));
  assert.ok(!now.some((/** @type {any} */ k) => k.key_id === gone.key_id));
  assert.equal(state.alice.keys_until, midnight(7));

  // A message sealed to yesterday's key still opens.
  state.chat = [{ id: MESSAGE, sender_agent_id: BOB, text: null, encrypted: state.fromBob("To yesterday's key", yesterday), posted_at: "2026-11-27T09:00:00Z" }];
  assert.match((await cli(["read", CHAT])).out, /│ To yesterday's key/);
  // With a week ahead again, nothing more is published.
  assert.equal((await cli(["send", BOB, "Again"])).code, 0);
  assert.equal(puts().length, 2);
});

test("a failed publish keeps none of the day keys it made, so the next command tries again", async () => {
  const { api, routes, home, cli } = await withKeys();
  const file = join(home, ".config/amessage/keys.json");
  const all = JSON.parse(await readFile(file, "utf8"));
  all[API][ALICE].message_keys = all[API][ALICE].message_keys.slice(0, 1);
  await writeFile(file, JSON.stringify(all));
  const put = routes["PUT /v1/me/keys"];
  routes["PUT /v1/me/keys"] = () => [503, { status: 503, detail: "Try again later." }];
  const sent = await cli(["send", BOB, "Still goes"]);
  assert.equal(sent.code, 0, sent.err);
  assert.match(sent.err, /Could not publish new keys for encrypted chats: Try again later\./);
  assert.equal((await keysOn(home)).message_keys.length, 1);
  routes["PUT /v1/me/keys"] = put;
  const again = await cli(["send", BOB, "Next"]);
  assert.match(again.err, /Published new keys for encrypted chats/);
  assert.equal((await keysOn(home)).message_keys.length, 7);
  assert.equal(api.requests.filter((r) => r.method === "PUT").length, 3);
});

test("new day keys are never published over an identity another machine holds", async () => {
  const { state, api, home, cli } = await withKeys();
  const file = join(home, ".config/amessage/keys.json");
  const all = JSON.parse(await readFile(file, "utf8"));
  all[API][ALICE].message_keys = all[API][ALICE].message_keys.slice(0, 1);
  await writeFile(file, JSON.stringify(all));
  state.elsewhere = "ab12".repeat(16);
  const puts = () => api.requests.filter((r) => r.method === "PUT").length;
  const before = puts();
  const sent = await cli(["send", BOB, "Hello"]);
  assert.match(sent.err, /Could not publish new keys for encrypted chats: aMessage has other keys for this agent \(fingerprint ab12 ab12/);
  assert.equal(puts(), before);
  assert.equal((await keysOn(home)).message_keys.length, 1);
  // Said yes to, keys create publishes them in the other machine's place.
  const replaced = await cli(["keys", "create", "--yes"]);
  assert.equal(replaced.code, 0, replaced.err);
  assert.equal(puts(), before + 1);
  assert.equal((await keysOn(home)).message_keys.length, 7);
});

test("the first run drops version 1 message keys and keeps the identity, pins and sent copies", async () => {
  const { state, api, home, cli } = await withKeys();
  await cli(["send", BOB, "Before the update"]);
  const file = join(home, ".config/amessage/keys.json");
  const all = JSON.parse(await readFile(file, "utf8"));
  const before = all[API][ALICE];
  const identity = before.identity;
  // keys.json as version 0.5 left it: a weekly X25519 key, without valid_from.
  const v1 = { key_id: "ab".repeat(16), private: b64(Buffer.alloc(32, 1)), public_key: b64(Buffer.alloc(32, 2)), expires_at: midnight(5), signature: b64(Buffer.alloc(64)) };
  all[API][ALICE] = { identity, message_keys: [v1], pins: before.pins };
  all[API]["0be00000-0000-4000-8000-000000000009"] = { identity, message_keys: [v1], pins: {} };
  await writeFile(file, JSON.stringify(all));
  const copies = await sentOn(home);

  const sent = await cli(["send", BOB, "After the update"]);
  assert.equal(sent.code, 0, sent.err);
  assert.match(sent.out, /Sent, encrypted\./);
  const after = await keysOn(home);
  assert.deepEqual(after.identity, identity);
  assert.deepEqual(after.pins, before.pins);
  assert.ok(after.message_keys.every((/** @type {any} */ k) => typeof k.valid_from === "string"));
  assert.ok(!after.message_keys.some((/** @type {any} */ k) => k.key_id === v1.key_id));
  assert.equal(after.message_keys.length, 7);
  // Every agent's entry lost its version 1 keys, not just this one's.
  assert.deepEqual(JSON.parse(await readFile(file, "utf8"))[API]["0be00000-0000-4000-8000-000000000009"].message_keys, []);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(await sentOn(home)).slice(0, 1), Object.keys(copies));
  // The same identity published its new day keys, and Bob reads the message.
  assert.equal(api.requests.filter((r) => r.method === "PUT").at(-1)?.body.identity_key, identity.public);
  assert.equal(state.bobOpens(state.posted.at(-1).encrypted).text, "After the update");
});

test("keys export and import move the keys and sent copies, sealed with a passphrase", async () => {
  const { state, api, home, cli } = await withKeys();
  await cli(["send", BOB, "Copied along"]);
  const passphrase = { AMESSAGE_KEYS_PASSPHRASE: "correct horse battery staple" };
  assert.equal((await cli(["keys", "export"])).code, 2);
  assert.equal((await cli(["keys", "export", "--out", "keys.export"], { AMESSAGE_KEYS_PASSPHRASE: "short" })).code, 2);
  const typed = await cli(["keys", "export", "--out", "keys.export"]);
  assert.equal(typed.code, 2);
  assert.match(typed.err, /AMESSAGE_KEYS_PASSPHRASE/);

  const exported = await cli(["keys", "export", "--out", "keys.export"], passphrase);
  assert.equal(exported.code, 0, exported.err);
  const file = join(home, "keys.export");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const text = await readFile(file, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(text)), ["v", "kdf", "n", "r", "p", "salt", "nonce", "ct"]);
  for (const secret of await privateKeys(home)) assert.ok(!text.includes(secret));
  assert.ok(!text.includes("Copied along"));
  assert.equal((await cli(["keys", "export", "--out", "keys.export"], passphrase)).code, 2);

  // A second machine, signed in as the same agent.
  const other = await run(["connect"], { fetch: api.fetch });
  const there = (/** @type {string[]} */ argv, /** @type {Record<string, string>} */ env = {}) => run(argv, { fetch: api.fetch, home: other.home, env });
  await writeFile(join(other.home, "keys.export"), text);
  const wrong = await there(["keys", "import", "keys.export"], { AMESSAGE_KEYS_PASSPHRASE: "wrong horse battery staple" });
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /passphrase is wrong/);
  const puts = api.requests.filter((r) => r.method === "PUT").length;
  const imported = await there(["keys", "import", "keys.export"], passphrase);
  assert.equal(imported.code, 0, imported.err);
  assert.ok(imported.out.includes(spaced(state.alice.fingerprint)));
  assert.equal(api.requests.filter((r) => r.method === "PUT").length, puts);
  assert.deepEqual(await keysOn(other.home), await keysOn(home));
  assert.deepEqual(await sentOn(other.home), await sentOn(home));
  state.chat = [
    { id: "5e4d0000-0000-4000-8000-000000000001", sender_agent_id: ALICE, text: null, encrypted: state.posted[0].encrypted, posted_at: "2026-11-27T09:00:00Z" },
    { id: MESSAGE, sender_agent_id: BOB, text: null, encrypted: state.fromBob("Welcome to the new machine"), posted_at: "2026-11-27T09:01:00Z" },
  ];
  const read = await there(["read", CHAT]);
  assert.match(read.out, /│ Copied along/);
  assert.match(read.out, /│ Welcome to the new machine/);
});

test("an export from version 0.5 imports without its version 1 message keys, and new day keys are published", async () => {
  const { state, api, home, cli } = await withKeys();
  const entry = await keysOn(home);
  const v1 = { key_id: "cd".repeat(16), private: b64(Buffer.alloc(32, 3)), public_key: b64(Buffer.alloc(32, 4)), expires_at: midnight(5), signature: b64(Buffer.alloc(64)) };
  const passphrase = { AMESSAGE_KEYS_PASSPHRASE: "correct horse battery staple" };
  // As after the update: aMessage still has the identity, and its tidy forgot the version 1 keys.
  state.aliceDays = [];
  const other = await run(["connect"], { fetch: api.fetch });
  await writeFile(join(other.home, "old.export"), JSON.stringify(sealExport({ identity: entry.identity, message_keys: [v1], pins: { [BOB]: "ef".repeat(32) }, sent: {} }, passphrase.AMESSAGE_KEYS_PASSPHRASE)));
  const imported = await run(["keys", "import", "old.export"], { fetch: api.fetch, home: other.home, env: passphrase });
  assert.equal(imported.code, 0, imported.err);
  assert.match(imported.out, /Published them on aMessage/);
  const there = await keysOn(other.home);
  assert.deepEqual(there.identity, entry.identity);
  assert.deepEqual(there.pins, { [BOB]: "ef".repeat(32) });
  assert.equal(there.message_keys.length, 7);
  assert.ok(!there.message_keys.some((/** @type {any} */ k) => k.key_id === v1.key_id));
  const status = JSON.parse((await run(["keys", "--json"], { fetch: api.fetch, home: other.home })).out);
  assert.equal(status.fingerprint, state.alice.fingerprint);
  assert.equal(status.published, true);
  assert.equal(state.alice.message_key.key_id, status.message_key.key_id);
});

test("chat takes the key actions and passes an envelope through on send", async () => {
  const { state, api, home, cli } = await withKeys();
  const chat = (/** @type {unknown} */ command) => run(["chat", "-"], { fetch: api.fetch, home, stdin: JSON.stringify(command) });
  const mine = JSON.parse((await chat({ action: "keys" })).out);
  assert.deepEqual(mine, state.alice);
  assert.equal(mine.keys_until, midnight(7));
  assert.equal(api.requests.at(-1).url.pathname, "/v1/me/keys");
  assert.equal(JSON.parse((await chat({ action: "agent_keys", agent_id: BOB })).out).fingerprint, state.bob.published.fingerprint);
  assert.equal(api.requests.at(-1).url.pathname, `/v1/agents/${BOB}/keys`);
  await chat({ action: "key_lookup", to: { email: "bob@example.com" } });
  assert.deepEqual(api.requests.at(-1).body, { to: { email: "bob@example.com" } });
  const days = { identity_key: state.alice.identity_key, message_keys: [state.alice.message_key] };
  const republished = await chat({ action: "publish_keys", ...days });
  assert.equal(republished.code, 0, republished.err);
  assert.equal(api.requests.at(-1).method, "PUT");
  assert.deepEqual(api.requests.at(-1).body, days);
  const envelope = JSON.parse((await cli(["seal", BOB, "Through chat"])).out);
  await chat({ action: "send", to: { agent_id: BOB }, encrypted: envelope });
  assert.deepEqual(state.posted.at(-1), { to: { agent_id: BOB }, encrypted: envelope });
  assert.equal(api.requests.filter((r) => r.url.pathname === "/v1/messages").length, 1);
  const missing = await chat({ action: "agent_keys" });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /agent_keys requires agent_id/);
});
