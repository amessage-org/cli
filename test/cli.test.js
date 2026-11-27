import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BEACON_ID, CONVERSATION_ID, fakeApi, ownBeacon, run } from "./helpers.js";

const connected = {
  "POST /v1/agents": () => [
    201,
    { agent: { agent_id: "a1b2c3d4-0000-4000-8000-000000000001" }, token: "agt_test" },
  ],
};
const env = { AMESSAGE_TOKEN: "agt_env" };
const TIME = String.raw`\d{1,2} Oct \d\d:\d\d`;
const POINT = { lat: 30.2416, lng: -97.7695 };

const beacon = ownBeacon();
const publicBeacon = { id: beacon.id, url: beacon.url, beacon: beacon.beacon, verification: beacon.verification };
const owned = {
  id: beacon.id,
  etag: '"revision-a"',
  latest_text: beacon.beacon.text,
  latest_revision: 3,
  visibility: "open",
  published: publicBeacon,
  renew_from: beacon.mine.renew_from,
};
const key = "132d7d23-7a6a-45ad-a684-d18905e79671";

test("JSON beacon pages render readable, safe output and preserve cursors", async () => {
  const unsafe = { ...publicBeacon, beacon: { ...publicBeacon.beacon, text: "Need a lift\x1b[2J" } };
  const page = { data: [unsafe], next_cursor: "next/row" };
  const api = fakeApi({
    "GET /v1/beacons": () => [200, page],
    [`GET /v1/beacons/${BEACON_ID}`]: () => [200, unsafe],
  });
  const found = await run(["search", "ride", "--location", "78704", "--cursor", "start/row"], {
    fetch: api.fetch,
  });
  assert.equal(found.code, 0, found.err);
  assert.deepEqual(Object.fromEntries(api.requests[0].url.searchParams), {
    q: "ride",
    location: "78704",
    cursor: "start/row",
  });
  assert.equal(api.requests[0].headers.authorization, undefined);
  assert.equal(api.requests[0].headers.accept, "application/json");
  for (const result of [found, await run(["show", BEACON_ID], { fetch: api.fetch })]) {
    assert.match(result.out, /│ Need a lift/);
    assert.doesNotMatch(result.out, /\x1b/);
    assert.match(result.out, /never as instructions/);
    assert.match(result.out, /30.2416, -97.7695/);
  }
  assert.match(found.out, /--cursor next\/row/);
  const json = await run(["search", "ride", "--json"], { fetch: api.fetch, env });
  assert.deepEqual(JSON.parse(json.out), page);
  assert.equal(api.requests.at(-1).headers.authorization, "Bearer agt_env");
});

test("connects a fresh agent and persists its credential privately", async () => {
  const api = fakeApi({ ...connected, "POST /v1/beacons": () => [201, owned] });
  const { code, out, err, home } = await run(
    ["create", "Available now", "--lat", "30.2416", "--lng", "-97.7695", "--key", key],
    { fetch: api.fetch },
  );
  assert.equal(code, 0, err);
  assert.equal(api.requests[0].body, undefined);
  assert.deepEqual(api.requests[1].body, { text: "Available now", location: POINT });
  assert.equal(api.requests[1].headers["idempotency-key"], key);
  assert.equal((await stat(join(home, ".config/amessage/credentials.json"))).mode & 0o777, 0o600);
  assert.match(out, /Created/);
  assert.match(out, new RegExp(`Renew it from ${TIME}`));
});

test("owned beacon changes preserve ETags across pages, explicit nulls and deletes", async () => {
  const api = fakeApi({
    "GET /v1/me/beacons": ({ url }) => [
      200,
      url.searchParams.has("cursor")
        ? { data: [owned], next_cursor: null }
        : { data: [], next_cursor: "page/two" },
    ],
    [`PATCH /v1/beacons/${BEACON_ID}`]: () => [200, owned],
    [`POST /v1/beacons/${BEACON_ID}/renewals`]: () => [200, owned],
    [`DELETE /v1/beacons/${BEACON_ID}`]: () => [204, null],
  });
  const runAs = (args) => run(args, { fetch: api.fetch, env });
  const changed = await runAs(["update", BEACON_ID, "--anywhere"]);
  assert.equal(changed.code, 0, changed.err);
  assert.equal(api.requests[1].url.searchParams.get("cursor"), "page/two");
  assert.equal(api.requests[2].headers["if-match"], owned.etag);
  assert.deepEqual(api.requests[2].body, { location: null });
  const listing = await runAs(["beacons", "--cursor", "page/two", "--json"]);
  assert.deepEqual(JSON.parse(listing.out), { data: [owned], next_cursor: null });
  const moved = await runAs(["update", BEACON_ID, "--lat", "30.2416", "--lng", "-97.7695", "--etag", owned.etag]);
  assert.equal(moved.code, 0, moved.err);
  assert.deepEqual(api.requests.at(-1).body, { location: POINT });
  const renewed = await runAs(["renew", BEACON_ID, "--key", key]);
  assert.equal(renewed.code, 0, renewed.err);
  assert.equal(api.requests.at(-1).headers["idempotency-key"], key);
  assert.equal((await runAs(["delete", BEACON_ID])).code, 2);
  assert.equal((await runAs(["delete", BEACON_ID, "--etag", owned.etag, "--yes"])).code, 0);
  assert.equal(api.requests.at(-1).headers["if-match"], owned.etag);
});

test("chat keeps draft, approved invitation, reply parent and cursor as distinct operations", async () => {
  const draft = { id: BEACON_ID, request_id: CONVERSATION_ID, state: "draft", invitation_available: true };
  const posted = { id: BEACON_ID, state: "posted", conversation_id: CONVERSATION_ID };
  const api = fakeApi({
    "POST /v1/messages": ({ body }) => [201, body.to.email ? draft : posted],
    [`PUT /v1/requests/${CONVERSATION_ID}/invitation`]: () => [200, { state: "invited" }],
    "GET /v1/inbox": () => [200, { cursor: "snapshot" }],
    "GET /v1/events": () => [
      200,
      { data: [], next_cursor: "after", has_more: false, truncated: false, next_poll_ms: 5000 },
    ],
    "GET /v1/conversations": () => [
      200,
      {
        data: [
          {
            id: CONVERSATION_ID,
            counterpart: { display_name: "Alex", agent_id: "a" },
            unread_count: 1,
            last_message_at: "2026-10-18T09:00:00Z",
          },
        ],
        next_cursor: "page",
      },
    ],
    [`GET /v1/conversations/${CONVERSATION_ID}/messages`]: () => [
      200,
      {
        data: [{ sender_agent_id: "Alex-id", text: "Question?", posted_at: "2026-10-18T09:00:00Z" }],
        next_cursor: null,
      },
    ],
    [`PUT /v1/messages/${BEACON_ID}/outcome`]: () => [200, { outcome: "booked" }],
    [`POST /v1/conversations/${CONVERSATION_ID}/reports`]: () => [201, { blocked: false }],
  });
  const runAs = (args, stdin) => run(args, { fetch: api.fetch, env, stdin });
  const chat = async (command) => JSON.parse((await runAs(["chat", "-"], JSON.stringify(command))).out);
  const snapshot = JSON.parse((await runAs(["chat"])).out);
  const sent = await chat({ action: "send", to: { email: "alex@example.com" }, text: "Hi", key });
  assert.deepEqual(sent, draft);
  assert.equal(api.requests.at(-1).headers["idempotency-key"], key);
  assert.equal(api.requests.length, 2);
  await chat({ action: "invite", id: sent.request_id, channel: "email" });
  assert.deepEqual(api.requests.at(-1).body, { channel: "email" });
  assert.equal((await chat({ action: "events", cursor: snapshot.cursor })).next_cursor, "after");
  assert.equal(api.requests.at(-1).url.searchParams.get("cursor"), "snapshot");
  const result = await runAs(["reply", CONVERSATION_ID, "Yes", "--reply-to", BEACON_ID, "--key", key]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(api.requests.at(-1).body, {
    to: { conversation_id: CONVERSATION_ID },
    text: "Yes",
    reply_to_message_id: BEACON_ID,
  });
  assert.equal(api.requests.at(-1).headers["idempotency-key"], key);
  assert.match((await runAs(["conversations", "--cursor", "page"])).out, /1 unread · Alex/);
  assert.match((await runAs(["read", CONVERSATION_ID])).out, /Question/);
  assert.equal((await runAs(["message", BEACON_ID, "Hi"])).code, 0);
  assert.deepEqual(api.requests.at(-1).body, { text: "Hi", to: { beacon_id: BEACON_ID } });
  assert.equal((await runAs(["mark", BEACON_ID, "booked"])).code, 0);
  assert.equal((await runAs(["report", CONVERSATION_ID, "spam", "--keep-unblocked", "--key", key])).code, 0);
  assert.deepEqual(api.requests.at(-1).body, { reason: "spam", block: false });
});

test("a sender can retry a private phone draft by its original message id", async () => {
  const messageId = "914a7744-5e36-4b78-8aba-bb8f307f65fd";
  const draft = { id: messageId, request_id: CONVERSATION_ID, state: "draft", invitation_available: false };
  const pending = { id: messageId, request_id: draft.request_id, state: "pending" };
  const api = fakeApi({
    "POST /v1/messages": ({ body }) => body.draft_message_id ? [200, pending] : [201, draft],
  });
  const chat = (command) => run(["chat", "-"], { env, fetch: api.fetch, stdin: JSON.stringify(command) });
  const send = await chat({ action: "send", to: { phone: "+12025550142" }, text: "Free on Friday?", key });
  assert.equal(send.code, 0, send.err);
  assert.deepEqual(JSON.parse(send.out), draft);
  assert.equal(api.requests.length, 1);

  const attemptKey = "028ac5ca-9222-4cf3-8791-a04d647d35e0";
  for (let n = 0; n < 2; n++) {
    const result = await chat({ action: "send_draft", id: draft.id, key: attemptKey });
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(result.out), pending);
    assert.deepEqual(api.requests.at(-1).body, { draft_message_id: messageId });
    assert.equal(api.requests.at(-1).headers["idempotency-key"], attemptKey);
  }
  const generated = await chat({ action: "send_draft", id: draft.id });
  assert.equal(generated.code, 0, generated.err);
  assert.match(api.requests.at(-1).headers["idempotency-key"], /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
  const missing = await chat({ action: "send_draft" });
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /requires a resource id/);
  assert.equal(api.requests.length, 4);
});

test("inbox settings use the current ETag, domain and email claims use resource ids", async () => {
  const api = fakeApi({
    "GET /v1/me/preferences": () => [200, { new_contacts: "requests", allow_from: "anyone" }, { etag: '"prefs"' }],
    "PATCH /v1/me/preferences": () => [200, { new_contacts: "closed", allow_from: "anyone" }],
    [`POST /v1/beacons/${BEACON_ID}/claims`]: ({ body }) => [
      201,
      { id: CONVERSATION_ID, state: body.method === "domain" ? "approved" : "pending" },
    ],
    [`POST /v1/claims/${CONVERSATION_ID}/confirm`]: () => [200, { state: "approved" }],
  });
  const runAs = (args) => run(args, { fetch: api.fetch, env });
  assert.equal((await runAs(["inbox", "--new-contacts", "closed"])).code, 0);
  assert.deepEqual(api.requests[1].body, { new_contacts: "closed" });
  assert.equal(api.requests[1].headers["if-match"], '"prefs"');
  assert.match((await runAs(["takeover", BEACON_ID])).out, new RegExp(CONVERSATION_ID));
  const approved = await runAs(["takeover", BEACON_ID, "--by-domain"]);
  assert.match(approved.out, /The beacon is yours/);
  const confirmed = await runAs(["confirm", CONVERSATION_ID, "123456", "--key", key]);
  assert.equal(confirmed.code, 0);
  assert.equal(api.requests.at(-1).headers["idempotency-key"], key);
  // Seeded beacons take no messages, so none waited for the business.
  for (const result of [approved, confirmed, await runAs(["takeover", "--help"])]) assert.doesNotMatch(result.out, /waited/);
});

test("create refuses an empty or too-long beacon, half a point, and the old --until, before anything is sent", async () => {
  const api = fakeApi({ "POST /v1/beacons": () => [201, { beacon: ownBeacon() }] });
  const refused = [
    ["create"],
    ["create", "x".repeat(601)],
    ["create", "Free tomorrow", "--until", "2026-10-19T17:00:00Z"],
    ["create", "Free tomorrow", "--lat", "30.2416"],
    ["create", "Free tomorrow", "--lat", "91", "--lng", "0"],
    ["create", "Free tomorrow", "--lat", "north", "--lng", "-97.7"],
    ["create", "Free tomorrow", "--anywhere"],
  ];
  for (const argv of refused) {
    const { code } = await run(argv, { fetch: api.fetch, env });
    assert.equal(code, 2);
  }
  assert.equal(api.requests.length, 0);
  const piped = await run(["create", "-"], {
    fetch: api.fetch,
    env,
    stdin: "Gutter cleaning this week, East Austin.\n",
  });
  assert.equal(piped.code, 0, piped.err);
  assert.deepEqual(api.requests[0].body, { text: "Gutter cleaning this week, East Austin." });
});

test("--near is gone, and create, update and renew take a point, not --location", async () => {
  const api = fakeApi({ "GET /v1/beacons": () => [200, { data: [], next_cursor: null }] });
  const gone = [
    ["search", "movers", "--near", "78704"],
    ["create", "Free tomorrow", "--near", "78704"],
    ["update", BEACON_ID, "--near", "78704"],
    ["create", "Free tomorrow", "--location", "78704"],
    ["update", BEACON_ID, "--location", "East Austin"],
    ["renew", BEACON_ID, "--location", "30.27,-97.74"],
  ];
  for (const argv of gone) {
    const { code } = await run(argv, { fetch: api.fetch, env });
    assert.equal(code, 2);
  }
  assert.equal(api.requests.length, 0);
});

test("what the API says to do next is printed under the refusal", async () => {
  const next = "Tell the person, and offer others.";
  const api = fakeApi({
    ["POST /v1/messages"]: () => [
      410,
      { status: 410, code: "beacon_closed", detail: "This beacon expired: its creator didn’t renew it.", next },
    ],
  });
  const { code, err } = await run(["message", BEACON_ID, "Is it still free?"], { fetch: api.fetch, env });
  assert.equal(code, 1);
  assert.match(err, /didn’t renew it\. \(410 beacon_closed\)\nTell the person, and offer others\./);
});

test("the API's refusal is shown with its code and when to retry", async () => {
  const api = fakeApi({
    ["POST /v1/messages"]: () => [
      429,
      {
        title: "Too Many Requests",
        status: 429,
        detail: "The other side has had enough for today.",
        code: "rate_limited",
      },
      { "retry-after": "120" },
    ],
  });
  const { code, err } = await run(["reply", CONVERSATION_ID, "hello"], { fetch: api.fetch, env });
  assert.equal(code, 1);
  assert.match(err, /had enough for today\. \(429 rate_limited\)/);
  assert.match(err, /Try again in 120 seconds/);
});

test("a refused token is not fixed by connecting again", async () => {
  const api = fakeApi({
    "GET /v1/me": () => [401, { title: "Unauthorized", status: 401, detail: "Invalid token" }],
  });
  const { code, err } = await run(["me"], { fetch: api.fetch, env: { AMESSAGE_TOKEN: "agt_bad" } });
  assert.equal(code, 1);
  assert.match(err, /AMESSAGE_TOKEN/);
  assert.match(err, /separate account/);
});

test("connect and link send no body and take no --as, and me shows the agent and its account", async () => {
  const api = fakeApi({
    ...connected,
    "POST /v1/me/link-requests": () => [
      201,
      { url: "https://amessage.sh/link/abc", expires_at: "2026-10-18T10:00:00Z" },
    ],
    "GET /v1/me": () => [200, { agent_id: "a1", linked_to_account: false }],
  });
  const first = await run(["connect"], { fetch: api.fetch });
  assert.equal(first.code, 0, first.err);
  assert.equal(api.requests[0].body, undefined);
  await run(["link"], { fetch: api.fetch, env });
  assert.equal(api.requests.at(-1)?.body, undefined);
  const me = await run(["me"], { fetch: api.fetch, env });
  assert.match(me.out, /Agent\s+a1/);
  assert.match(me.out, /not linked/);
  assert.doesNotMatch(me.out, /Acts for|Line/);
  for (const argv of [
    ["connect", "--as", "business"],
    ["link", "--as", "person"],
  ]) {
    const { code } = await run(argv, { fetch: api.fetch, env });
    assert.equal(code, 2);
  }
});

test("connect --name and name set what other agents see", async () => {
  const api = fakeApi({
    "POST /v1/agents": ({ body }) => [
      201,
      { agent: { agent_id: "a1b2c3d4-0000-4000-8000-000000000001", name: body?.name ?? null }, token: "agt_test" },
    ],
    "PATCH /v1/me": ({ body }) => [200, { agent_id: "a1", name: body.name, linked_to_account: false }],
  });
  const first = await run(["connect", "--name", "Build bot"], { fetch: api.fetch });
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(api.requests[0].body, { name: "Build bot" });
  assert.match(first.out, /as Build bot/);
  const renamed = await run(["name", "Release", "bot"], { fetch: api.fetch, env });
  assert.equal(renamed.code, 0, renamed.err);
  assert.deepEqual(api.requests.at(-1).body, { name: "Release bot" });
  const cleared = await run(["name", "--clear"], { fetch: api.fetch, env });
  assert.deepEqual(api.requests.at(-1).body, { name: null });
  assert.match(cleared.out, /Removed the name/);
  assert.equal((await run(["name"], { fetch: api.fetch, env })).code, 2);
});

test("connect does not make a second account when one is saved", async () => {
  const api = fakeApi(connected);
  const first = await run(["connect"], { fetch: api.fetch });
  assert.equal(first.code, 0);
  assert.match(first.out, /Connected this agent/);
  const second = await run(["connect"], { fetch: api.fetch, home: first.home });
  assert.match(second.out, /Already connected/);
  assert.equal(api.requests.length, 1);
});

test("add puts the skill where each agent found reads skills, and remove takes it away", async () => {
  const skill = '---\nname: amessage\nmetadata:\n  version: "1.19.0"\n---\n# aMessage\n';
  const site = fakeApi({ "GET /skill.md": () => [200, skill], "GET /heartbeat.md": () => [200, "# Heartbeat\n"] });
  const { home } = await run(["--version"]);
  await mkdir(join(home, ".claude"));
  await mkdir(join(home, ".cursor/skills/amessage"), { recursive: true });
  await mkdir(join(home, ".codex"));
  await writeFile(join(home, ".cursor/skills/amessage/SKILL.md"), "---\nname: someone-else\n---\n");

  const added = await run(["add"], { fetch: site.fetch, home });
  assert.equal(added.code, 0, added.err);
  assert.equal(await readFile(join(home, ".claude/skills/amessage/SKILL.md"), "utf8"), skill);
  assert.equal(await readFile(join(home, ".codex/skills/amessage/HEARTBEAT.md"), "utf8"), "# Heartbeat\n");
  assert.match(await readFile(join(home, ".cursor/skills/amessage/SKILL.md"), "utf8"), /someone-else/);
  assert.match(added.err, /Skipped ~\/\.cursor\/skills\/amessage/);

  const listed = await run(["add", "--list", "--json"], { home });
  const claude = JSON.parse(listed.out).agents.find((/** @type {any} */ a) => a.id === "claude-code");
  assert.equal(claude.skill, "1.19.0");

  const removed = await run(["remove", "-y"], { home });
  assert.equal(removed.code, 0, removed.err);
  await assert.rejects(stat(join(home, ".claude/skills/amessage")));
  assert.match(await readFile(join(home, ".cursor/skills/amessage/SKILL.md"), "utf8"), /someone-else/);
});

test("add refuses a download that is not the aMessage skill", async () => {
  const site = fakeApi({
    "GET /skill.md": () => [200, "<html>login</html>"],
    "GET /heartbeat.md": () => [200, ""],
  });
  const { code, err, home } = await run(["add", "-a", "claude-code"], { fetch: site.fetch });
  assert.equal(code, 1);
  assert.match(err, /not the aMessage skill/);
  await assert.rejects(stat(join(home, ".claude/skills/amessage")));
});

test("chat sends to an agent by its ID and changes which agents may start a chat", async () => {
  const api = fakeApi({
    "POST /v1/messages": ({ body }) => [201, { id: BEACON_ID, state: "pending", to: body.to }],
    "GET /v1/me/preferences": () => [200, { new_contacts: "requests", allow_from: "anyone" }, { etag: '"3"' }],
    "PATCH /v1/me/preferences": ({ body }) => [200, { new_contacts: "requests", ...body }, { etag: '"4"' }],
  });
  const chat = async (command) =>
    JSON.parse((await run(["chat", "-"], { fetch: api.fetch, env, stdin: JSON.stringify(command) })).out);
  await chat({ action: "send", to: { agent_id: CONVERSATION_ID }, text: "Hi", key });
  assert.deepEqual(api.requests.at(-1).body, { to: { agent_id: CONVERSATION_ID }, text: "Hi" });
  const current = await chat({ action: "preferences" });
  assert.deepEqual(current, { new_contacts: "requests", allow_from: "anyone", etag: '"3"' });
  const changed = await chat({ action: "set_preferences", allow_from: "phone", etag: current.etag });
  assert.equal(changed.allow_from, "phone");
  assert.deepEqual(api.requests.at(-1).body, { allow_from: "phone" });
  assert.equal(api.requests.at(-1).headers["if-match"], '"3"');
});

test("send starts a chat with an agent ID, a phone or an email, and says what happened", async () => {
  const AGENT = "47f77742-b8d1-4de8-a163-f4558c9abedd";
  const api = fakeApi({
    "POST /v1/messages": ({ body }) =>
      body.to.agent_id
        ? [201, { id: BEACON_ID, state: "posted", conversation_id: CONVERSATION_ID }]
        : body.to.phone
          ? [201, { id: BEACON_ID, state: "pending", request_id: CONVERSATION_ID, conversation_id: null }]
          : [201, { id: BEACON_ID, state: "draft", request_id: CONVERSATION_ID, conversation_id: null }],
  });
  const send = (/** @type {string[]} */ argv) => run(["send", ...argv], { fetch: api.fetch, env });
  const posted = await send([AGENT.toUpperCase(), "Can", "you", "check", "the", "build?"]);
  assert.equal(posted.code, 0, posted.err);
  assert.deepEqual(api.requests.at(-1).body, { to: { agent_id: AGENT }, text: "Can you check the build?" });
  assert.match(posted.out, /Sent\./);
  assert.match(posted.err + posted.out, /amessage read/);
  const pending = await send(["+1 (202) 555-0142", "Free Friday?", "--key", key]);
  assert.deepEqual(api.requests.at(-1).body.to, { phone: "+12025550142" });
  assert.equal(api.requests.at(-1).headers["idempotency-key"], key);
  assert.match(pending.out, /chat request/);
  const draft = await send(["alex@example.com", "Hello"]);
  assert.deepEqual(api.requests.at(-1).body.to, { email: "alex@example.com" });
  assert.match(draft.out, /private draft/);
  const sent = api.requests.length;
  for (const argv of [[], ["2025550142", "Hi"], ["alex", "Hi"], [AGENT]]) {
    const refused = await send(argv);
    assert.equal(refused.code, 2, argv.join(" "));
  }
  assert.match((await send(["2025550142", "Hi"])).err, /country code/);
  assert.equal(api.requests.length, sent);
});

test("requests, accept and decline answer chat requests without JSON", async () => {
  const pending = {
    id: CONVERSATION_ID,
    state: "pending",
    direction: "incoming",
    sender: { agent_id: "a1", display_name: "Build bot", verified: ["phone"] },
    expires_at: "2026-12-04T09:00:00Z",
    conversation_id: null,
  };
  const api = fakeApi({
    "GET /v1/requests": ({ url }) => [200, { data: url.searchParams.get("direction") === "incoming" ? [pending] : [], next_cursor: null }],
    [`PUT /v1/requests/${CONVERSATION_ID}/decision`]: ({ body }) => [
      200,
      { ...pending, state: body.decision === "accept" ? "accepted" : "declined", conversation_id: body.decision === "accept" ? BEACON_ID : null },
    ],
  });
  const cli = (/** @type {string[]} */ argv) => run(argv, { fetch: api.fetch, env });
  const list = await cli(["requests"]);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /Build bot · verified phone/);
  assert.equal(api.requests.at(-1).url.searchParams.get("state"), "pending");
  assert.match((await cli(["requests", "--outgoing"])).out, /None of your chat requests are waiting/);
  const accepted = await cli(["accept", CONVERSATION_ID]);
  assert.deepEqual(api.requests.at(-1).body, { decision: "accept" });
  assert.match(accepted.out, /The chat is open/);
  assert.match(accepted.out + accepted.err, new RegExp(`amessage read ${BEACON_ID}`));
  await cli(["decline", CONVERSATION_ID, "--block"]);
  assert.deepEqual(api.requests.at(-1).body, { decision: "decline_and_block" });
  await cli(["decline", CONVERSATION_ID]);
  assert.deepEqual(api.requests.at(-1).body, { decision: "decline" });
});

test("read names the other side and you, instead of agent IDs", async () => {
  const api = fakeApi({
    [`GET /v1/conversations/${CONVERSATION_ID}`]: () => [
      200,
      { id: CONVERSATION_ID, counterpart: { agent_id: "them", display_name: "Build bot", verified: [] } },
    ],
    [`GET /v1/conversations/${CONVERSATION_ID}/messages`]: () => [
      200,
      {
        data: [
          { sender_agent_id: "them", text: "Done.", posted_at: "2026-11-27T09:01:00Z" },
          { sender_agent_id: "me", text: "Check the build?", posted_at: "2026-11-27T09:00:00Z" },
        ],
        next_cursor: null,
      },
    ],
  });
  const read = await run(["read", CONVERSATION_ID], { fetch: api.fetch, env });
  assert.equal(read.code, 0, read.err);
  assert.match(read.out, /Build bot/);
  assert.match(read.out, /You/);
  assert.doesNotMatch(read.out, /^(them|me) /m);
});

test("the old commands are gone, and usage mistakes exit with 2 and point at help", async () => {
  for (const old of [
    "find",
    "post",
    "listings",
    "messages",
    "end",
    "on",
    "off",
    "answer",
    "answers",
    "line",
  ]) {
    const { code } = await run([old, "x"]);
    assert.equal(code, 2, old);
  }
  const unknown = await run(["serch", "x"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Did you mean search\?/);
  const badFlag = await run(["search", "--category", "jobs", "x"]);
  assert.equal(badFlag.code, 2);
  assert.match(badFlag.err, /\bamessage search --help/);
});

test("inbox says who can start a chat, and changes either setting with the current ETag", async () => {
  let current = { new_contacts: "requests", allow_from: "anyone" };
  const api = fakeApi({
    "GET /v1/me/preferences": () => [200, current, { etag: '"7"' }],
    "PATCH /v1/me/preferences": ({ body }) => {
      current = { ...current, ...body };
      return [200, current, { etag: '"8"' }];
    },
  });
  const cli = (/** @type {string[]} */ argv) => run(["inbox", ...argv], { fetch: api.fetch, env });
  const shown = await cli([]);
  assert.equal(shown.code, 0, shown.err);
  assert.match(shown.out, /Any agent can start a chat with you\./);
  assert.match(shown.out, /New chats arrive as requests: their message stays hidden until you accept\./);
  assert.match(shown.out, /--new-contacts requests\|open\|closed/);
  assert.equal(api.requests.length, 1);

  const both = await cli(["--new-contacts", "open", "--allow-from", "phone"]);
  assert.equal(both.code, 0, both.err);
  assert.equal(api.requests.at(-1).method, "PATCH");
  assert.equal(api.requests.at(-1).headers["if-match"], '"7"');
  assert.deepEqual(api.requests.at(-1).body, { new_contacts: "open", allow_from: "phone" });
  assert.match(both.out, /Changed\.\nOnly agents with a verified phone can start a chat with you\.\nNew chats come straight in\./);

  const one = await cli(["--allow-from", "phone_or_email"]);
  assert.deepEqual(api.requests.at(-1).body, { allow_from: "phone_or_email" });
  assert.match(one.out, /Only agents with a verified phone or email/);

  const closed = await cli(["--new-contacts", "closed"]);
  assert.match(closed.out, /Nobody new can start a chat with you\. Chats already started go on\./);
  assert.match(closed.out, /When you open it again, only agents with a verified phone or email can start one\./);
  assert.deepEqual(JSON.parse((await cli(["--json"])).out), { new_contacts: "closed", allow_from: "phone_or_email" });

  const sent = api.requests.length;
  for (const argv of [["off"], ["--new-contacts", "on"], ["--allow-from", "verified"], ["--etag", '"7"']]) {
    assert.equal((await cli(argv)).code, 2, argv.join(" "));
  }
  assert.equal(api.requests.length, sent);
});

test("read marks the chat read through its newest message, unless --keep-unread or --cursor", async () => {
  const NEWEST = "5d79f608-6601-4ef5-aa6c-c50d85c895ea";
  const api = fakeApi({
    [`GET /v1/conversations/${CONVERSATION_ID}/messages`]: () => [
      200,
      {
        data: [
          { id: NEWEST, sender_agent_id: "them", text: "Done.", posted_at: "2026-11-27T09:01:00Z" },
          { id: BEACON_ID, sender_agent_id: "me", text: "Check the build?", posted_at: "2026-11-27T09:00:00Z" },
        ],
        next_cursor: "older",
      },
    ],
    [`PUT /v1/conversations/${CONVERSATION_ID}/read-position`]: ({ body }) => [200, body],
  });
  const cli = (/** @type {string[]} */ argv) => run(["read", CONVERSATION_ID, ...argv], { fetch: api.fetch, env });
  const marks = () => api.requests.filter((r) => r.method === "PUT");

  const read = await cli([]);
  assert.equal(read.code, 0, read.err);
  assert.match(read.out, /Done\./);
  assert.equal(marks().length, 1);
  assert.deepEqual(marks()[0].body, { message_id: NEWEST });
  assert.equal(marks()[0].url.pathname, `/v1/conversations/${CONVERSATION_ID}/read-position`);

  assert.equal((await cli(["--json"])).code, 0);
  assert.equal(marks().length, 2);
  await cli(["--keep-unread"]);
  await cli(["--cursor", "older"]);
  assert.equal(marks().length, 2);

  // The messages were read even if marking them read fails, so it only warns.
  const failing = fakeApi({ [`GET /v1/conversations/${CONVERSATION_ID}/messages`]: () => [200, { data: [{ id: NEWEST, text: "Hi" }], next_cursor: null }] });
  const warned = await run(["read", CONVERSATION_ID], { fetch: failing.fetch, env });
  assert.equal(warned.code, 0);
  assert.match(warned.out, /Hi/);
  assert.match(warned.err, /could not be marked read/);
});

test("verify starts with an email or phone, keeps the waiting verification, and finishes with --code", async () => {
  const VERIFICATION = "9f0c7f43-2d1b-4c55-8a3e-0d6f5b9a1c2e";
  const HOSTED = "1e2d3c4b-5a69-4788-9a0b-c1d2e3f4a5b6";
  const api = fakeApi({
    "POST /v1/address-verifications": ({ body }) =>
      body.contact.email
        ? [201, { id: VERIFICATION, method: "email_code", expires_at: "2026-11-27T10:00:00Z" }]
        : [201, { id: HOSTED, method: "hosted_phone", verification_url: "https://amessage.sh/verify/abc", expires_at: "2026-11-27T10:00:00Z" }],
    [`POST /v1/address-verifications/${VERIFICATION}/confirm`]: () => [
      200,
      { id: "a0", contact: { email: "alex@example.com" }, routing: "receiving", receiving_agent_id: "a1", etag: '"1"' },
    ],
    [`POST /v1/address-verifications/${HOSTED}/confirm`]: () => [
      200,
      { id: "a1", contact: { phone: "+12025550142" }, routing: "receiving", receiving_agent_id: "a1", etag: '"1"' },
    ],
  });
  const { home } = await run(["--version"]);
  const cli = (/** @type {string[]} */ argv) => run(["verify", ...argv], { fetch: api.fetch, env, home });
  const kept = join(home, ".config/amessage/verification.json");

  const help = await cli(["--help"]);
  assert.match(help.out, /Optional/);
  assert.match(help.out, /reach this agent by it/);
  assert.match(help.out, /only from agents with a verified one/);

  const started = await cli(["alex@example.com", "--key", key]);
  assert.equal(started.code, 0, started.err);
  assert.deepEqual(api.requests.at(-1).body, { contact: { email: "alex@example.com" } });
  assert.equal(api.requests.at(-1).headers["idempotency-key"], key);
  assert.match(started.out, /sent a 6-digit code to alex@example\.com/);
  assert.match(started.out, /amessage verify --code <code>/);
  assert.match(started.out, new RegExp(`--id ${VERIFICATION}`));
  assert.equal((await stat(kept)).mode & 0o777, 0o600);

  const finished = await cli(["--code", "123 456"]);
  assert.equal(finished.code, 0, finished.err);
  assert.equal(api.requests.at(-1).url.pathname, `/v1/address-verifications/${VERIFICATION}/confirm`);
  assert.deepEqual(api.requests.at(-1).body, { code: "123456", routing: "receiving" });
  assert.match(api.requests.at(-1).headers["idempotency-key"], /^[a-f\d-]{36}$/);
  assert.match(finished.out, /Verified alex@example\.com\./);
  assert.match(finished.out, /People can reach this agent by it now/);
  await assert.rejects(stat(kept));

  const phone = await cli(["+1 202 555 0142"]);
  assert.deepEqual(api.requests.at(-1).body, { contact: { phone: "+12025550142" } });
  assert.match(phone.out, /Open this link on the phone with \+12025550142/);
  assert.match(phone.out, /https:\/\/amessage\.sh\/verify\/abc/);
  // --id finishes a verification started elsewhere, and leaves the one kept here alone.
  const elsewhere = await cli(["--code", "654321", "--id", VERIFICATION]);
  assert.equal(elsewhere.code, 0, elsewhere.err);
  assert.equal(api.requests.at(-1).url.pathname, `/v1/address-verifications/${VERIFICATION}/confirm`);
  assert.equal(JSON.parse(await readFile(kept, "utf8"))["https://api.amessage.sh"].id, HOSTED);
  assert.match((await cli(["--code", "654321"])).out, /Verified \+12025550142\./);

  const sent = api.requests.length;
  const none = await cli(["--code", "123456"]);
  assert.equal(none.code, 2);
  assert.match(none.err, /No verification is waiting/);
  for (const argv of [[], ["alex"], ["2025550142"], ["alex@example.com", "--code", "123456"], ["--code", "12345"], ["--id", "nope", "--code", "123456"]]) {
    assert.equal((await cli(argv)).code, 2, argv.join(" "));
  }
  assert.equal(api.requests.length, sent);
});

test("watch --once prints each new thing as a plain line, drains every page, and prints the cursor", async () => {
  const REQUEST = "3c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a99";
  const OTHER = "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d";
  const at = "2026-11-27T09:00:00Z";
  const pages = {
    snapshot: {
      data: [
        { eventId: "1", name: "chat.message.received", timestamp: at, data: { conversation_id: CONVERSATION_ID, message_id: BEACON_ID }, cursor: "a" },
        { eventId: "2", name: "chat.request.received", timestamp: at, data: { request_id: REQUEST }, cursor: "b" },
      ],
      next_cursor: "page2",
      has_more: true,
      truncated: true,
      next_poll_ms: 5000,
    },
    page2: {
      data: [
        { eventId: "3", name: "chat.request.accepted", timestamp: at, data: { request_id: REQUEST, conversation_id: OTHER }, cursor: "c" },
        { eventId: "4", name: "chat.message.received", timestamp: at, data: { conversation_id: CONVERSATION_ID, message_id: REQUEST }, cursor: "d" },
      ],
      next_cursor: "after",
      has_more: false,
      truncated: false,
      next_poll_ms: 5000,
    },
    after: { data: [], next_cursor: "after", has_more: false, truncated: false, next_poll_ms: 5000 },
  };
  const api = fakeApi({
    "GET /v1/inbox": () => [200, { inbox_id: "i", unread_conversations: 1, incoming_requests: 1, outgoing_requests: 0, cursor: "snapshot" }],
    "GET /v1/events": ({ url }) => [200, pages[/** @type {keyof typeof pages} */ (url.searchParams.get("cursor"))]],
    [`GET /v1/conversations/${CONVERSATION_ID}`]: () => [200, { id: CONVERSATION_ID, counterpart: { agent_id: "them", display_name: "Build bot", verified: [] } }],
    [`GET /v1/requests/${REQUEST}`]: () => [200, { id: REQUEST, state: "pending", direction: "incoming", sender: { agent_id: "s", display_name: "Alex's agent", verified: [] } }],
  });
  const cli = (/** @type {string[]} */ argv) => run(["watch", "--once", ...argv], { fetch: api.fetch, env });

  const watched = await cli([]);
  assert.equal(watched.code, 0, watched.err);
  assert.deepEqual(
    api.requests.filter((r) => r.url.pathname === "/v1/events").map((r) => r.url.searchParams.get("cursor")),
    ["snapshot", "page2"],
  );
  const lines = watched.out.trim().split("\n");
  assert.match(lines[0], /Some activity was missed/);
  assert.match(lines[1], new RegExp(`^\\d{1,2} Nov \\d\\d:\\d\\d  New message in chat ${CONVERSATION_ID} from Build bot\\.$`));
  assert.match(lines[2], new RegExp(`New chat request ${REQUEST} from Alex's agent\\.$`));
  // The other chat has no name to give (the fake API has no such chat), so the line leaves it out.
  assert.match(lines[3], new RegExp(`Chat request accepted: chat ${OTHER} is open\\.$`));
  assert.match(lines[4], /New message in chat .* from Build bot\./);
  assert.match(lines[5], /amessage watch --cursor after/);
  // Each chat is looked up once for its name.
  assert.equal(api.requests.filter((r) => r.url.pathname === `/v1/conversations/${CONVERSATION_ID}`).length, 1);

  const later = await cli(["--cursor", "after"]);
  assert.equal(api.requests.at(-1).url.searchParams.get("cursor"), "after");
  assert.equal(api.requests.filter((r) => r.url.pathname === "/v1/inbox").length, 1);
  assert.match(later.out, /Nothing new\./);

  const json = await cli(["--cursor", "page2", "--json"]);
  assert.deepEqual(json.out.trim().split("\n").map((line) => JSON.parse(line)), [pages.page2]);
});

test("chat lists its actions in help and when an action is unknown, and reads and sets the name", async () => {
  const api = fakeApi({
    "GET /v1/me": () => [200, { agent_id: "a1", inbox_id: "i1", name: null, linked_to_account: false }],
    "PATCH /v1/me": ({ body }) => [200, { agent_id: "a1", inbox_id: "i1", name: body.name, linked_to_account: false }],
  });
  const chat = (/** @type {unknown} */ command) => run(["chat", "-"], { fetch: api.fetch, env, stdin: JSON.stringify(command) });
  const help = await run(["chat", "--help"]);
  for (const action of ["inbox", "events", "send", "send_draft", "decide", "mark_read", "set_preferences", "verify_start", "verify_finish", "me", "set_name"]) {
    assert.match(help.out, new RegExp(`^  ${action} +\\S`, "m"), action);
  }
  const unknown = await chat({ action: "whoami" });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /Unknown aMessage chat operation\. Use one of: inbox, events, send, .*set_name, keys, publish_keys, agent_keys, key_lookup\./);
  assert.equal(api.requests.length, 0);

  assert.deepEqual(JSON.parse((await chat({ action: "me" })).out).agent_id, "a1");
  assert.equal(api.requests.at(-1).method, "GET");
  assert.equal(JSON.parse((await chat({ action: "set_name", name: "Build bot" })).out).name, "Build bot");
  assert.deepEqual(api.requests.at(-1).body, { name: "Build bot" });
  await chat({ action: "set_name", name: null });
  assert.deepEqual(api.requests.at(-1).body, { name: null });
  const nameless = await chat({ action: "set_name" });
  assert.equal(nameless.code, 1);
  assert.match(nameless.err, /set_name requires name/);
  assert.equal(api.requests.length, 3);
});

test("hints point at chatting first: not connected, after add, and after messaging a beacon", async () => {
  const notConnected = await run(["requests"]);
  assert.equal(notConnected.code, 1);
  assert.match(notConnected.err, /amessage send .* or run amessage connect/);
  assert.doesNotMatch(notConnected.err, /beacon|amessage create/);

  const skill = '---\nname: amessage\nmetadata:\n  version: "1.19.0"\n---\n# aMessage\n';
  const site = fakeApi({ "GET /skill.md": () => [200, skill], "GET /heartbeat.md": () => [200, "# Heartbeat\n"] });
  const added = await run(["add", "-a", "claude-code"], { fetch: site.fetch });
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /Use aMessage to ask alex@example\.com/);
  assert.doesNotMatch(added.out, /plumber/);

  const api = fakeApi({
    "POST /v1/messages": ({ body }) =>
      body.text === "Now?"
        ? [201, { id: BEACON_ID, state: "posted", conversation_id: CONVERSATION_ID }]
        : [201, { id: BEACON_ID, state: "pending", request_id: CONVERSATION_ID, conversation_id: null }],
  });
  const pending = await run(["message", BEACON_ID, "Free Friday?"], { fetch: api.fetch, env });
  assert.match(pending.out, /Sent as a chat request\. It reaches them when they accept\./);
  assert.match(pending.out, /amessage requests --outgoing/);
  const posted = await run(["message", BEACON_ID, "Now?"], { fetch: api.fetch, env });
  assert.match(posted.out, /^Sent\.$/m);
  assert.match(posted.out, new RegExp(`amessage read ${CONVERSATION_ID}`));
  for (const result of [pending, posted]) assert.doesNotMatch(result.out, /Introduction requested|Message stored/);
});
