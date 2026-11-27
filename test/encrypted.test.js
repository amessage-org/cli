import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { b64, isEnvelope, keysProblem, messageKeyStatement, revealMatches, signWith, unb64 } from "../src/e2e.js";
import { ALICE, BOB, CHAT, fakeApi, run, twoAgents } from "./helpers.js";

const API = "https://api.amessage.sh";
const MESSAGE = "3e55a9e0-0000-4000-8000-0000000000aa";
const OTHER = "3e55a9e0-0000-4000-8000-0000000000bb";
const MINE = "3e55a9e0-0000-4000-8000-0000000000cc";
const REQUEST = "4e9e0000-0000-4000-8000-0000000000dd";
const spaced = (/** @type {string} */ fp) => fp.match(/.{4}/g)?.join(" ") ?? "";
const keysOn = async (/** @type {string} */ home) => JSON.parse(await readFile(join(home, ".config/amessage/keys.json"), "utf8"))[API][ALICE];
const sentOn = async (/** @type {string} */ home) => JSON.parse(await readFile(join(home, ".config/amessage/sent.json"), "utf8"))[API][ALICE];

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

test("keys create makes the keys, publishes the public half and keeps the private half owner-only", async () => {
  const { state, api, home, made, cli } = await withKeys();
  // It connected on the way, looked for published keys, then published.
  assert.deepEqual(api.requests.map((r) => `${r.method} ${r.url.pathname}`), ["POST /v1/agents", "GET /v1/me", "GET /v1/me/keys", "PUT /v1/me/keys"]);
  const put = api.requests[3].body;
  assert.deepEqual(Object.keys(put), ["identity_key", "message_key"]);
  assert.deepEqual(Object.keys(put.message_key), ["key_id", "public_key", "expires_at", "signature"]);
  assert.equal(keysProblem({ ...put, fingerprint: state.alice.fingerprint }), null);
  const week = Date.parse(put.message_key.expires_at) - Date.now();
  assert.ok(week > 6.9 * 86_400_000 && week <= 7 * 86_400_000);

  const file = join(home, ".config/amessage/keys.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const entry = await keysOn(home);
  assert.deepEqual(Object.keys(entry), ["identity", "message_keys", "pins"]);
  assert.deepEqual(Object.keys(entry.identity), ["private", "public"]);
  assert.deepEqual(Object.keys(entry.message_keys[0]).sort(), ["expires_at", "key_id", "private", "public_key", "signature"]);
  assert.equal(entry.identity.public, put.identity_key);
  assert.match(made.out, /Made this agent's keys and published them/);
  assert.ok(made.out.includes(spaced(state.alice.fingerprint)));

  const status = await cli(["keys"]);
  assert.equal(status.code, 0, status.err);
  assert.ok(status.out.includes(spaced(state.alice.fingerprint)));
  assert.match(status.out, /On aMessage\s+published/);
  const json = JSON.parse((await cli(["keys", "--json"])).out);
  assert.deepEqual(json, {
    agent_id: ALICE,
    has_keys: true,
    fingerprint: state.alice.fingerprint,
    message_key: put.message_key,
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

test("the message key is renewed when it has less than a day left, and every old one is kept", async () => {
  const { state, api, home, cli } = await withKeys();
  // Make the current key end in twelve hours, signed as such.
  const file = join(home, ".config/amessage/keys.json");
  const all = JSON.parse(await readFile(file, "utf8"));
  const entry = all[API][ALICE];
  const old = entry.message_keys[0];
  old.expires_at = new Date(Date.now() + 12 * 3_600_000).toISOString();
  old.signature = signWith(unb64(entry.identity.private), messageKeyStatement(old.public_key, old.expires_at));
  await writeFile(file, JSON.stringify(all));

  const sent = await cli(["send", BOB, "After the rotation"]);
  assert.equal(sent.code, 0, sent.err);
  assert.match(sent.err, /Made a new message key for encrypted chats/);
  const order = api.requests.map((r) => `${r.method} ${r.url.pathname}`);
  assert.ok(order.lastIndexOf("PUT /v1/me/keys") < order.lastIndexOf("POST /v1/messages"));
  const kept = (await keysOn(home)).message_keys;
  assert.equal(kept.length, 2);
  assert.equal(kept[0].key_id, old.key_id);
  assert.equal(state.alice.message_key.key_id, kept[1].key_id);
  assert.notEqual(kept[1].key_id, old.key_id);

  // Messages sealed to the old key still open.
  const published = state.alice;
  state.alice = { ...published, message_key: { key_id: old.key_id, public_key: old.public_key } };
  state.chat = [{ id: MESSAGE, sender_agent_id: BOB, text: null, encrypted: state.fromBob("To the old key"), posted_at: "2026-11-27T09:00:00Z" }];
  state.alice = published;
  assert.match((await cli(["read", CHAT])).out, /│ To the old key/);

  const rotated = await cli(["keys", "rotate"]);
  assert.equal(rotated.code, 0, rotated.err);
  assert.match(rotated.out, /Made a new message key and published it/);
  assert.equal((await keysOn(home)).message_keys.length, 3);
  assert.equal(state.alice.message_key.key_id, (await keysOn(home)).message_keys[2].key_id);
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

test("chat takes the key actions and passes an envelope through on send", async () => {
  const { state, api, home, cli } = await withKeys();
  const chat = (/** @type {unknown} */ command) => run(["chat", "-"], { fetch: api.fetch, home, stdin: JSON.stringify(command) });
  assert.deepEqual(JSON.parse((await chat({ action: "keys" })).out), state.alice);
  assert.equal(api.requests.at(-1).url.pathname, "/v1/me/keys");
  assert.equal(JSON.parse((await chat({ action: "agent_keys", agent_id: BOB })).out).fingerprint, state.bob.published.fingerprint);
  assert.equal(api.requests.at(-1).url.pathname, `/v1/agents/${BOB}/keys`);
  await chat({ action: "key_lookup", to: { email: "bob@example.com" } });
  assert.deepEqual(api.requests.at(-1).body, { to: { email: "bob@example.com" } });
  await chat({ action: "publish_keys", identity_key: state.alice.identity_key, message_key: state.alice.message_key });
  assert.equal(api.requests.at(-1).method, "PUT");
  assert.deepEqual(api.requests.at(-1).body, { identity_key: state.alice.identity_key, message_key: state.alice.message_key });
  const envelope = JSON.parse((await cli(["seal", BOB, "Through chat"])).out);
  await chat({ action: "send", to: { agent_id: BOB }, encrypted: envelope });
  assert.deepEqual(state.posted.at(-1), { to: { agent_id: BOB }, encrypted: envelope });
  assert.equal(api.requests.filter((r) => r.url.pathname === "/v1/messages").length, 1);
  const missing = await chat({ action: "agent_keys" });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /agent_keys requires agent_id/);
});
