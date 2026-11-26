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

test("account preferences use current ETag, domain and email claims use resource ids", async () => {
  const api = fakeApi({
    "GET /v1/me/preferences": () => [200, { new_contacts: "requests" }, { etag: '"prefs"' }],
    "PATCH /v1/me/preferences": () => [200, { new_contacts: "closed" }],
    [`POST /v1/beacons/${BEACON_ID}/claims`]: ({ body }) => [
      201,
      { id: CONVERSATION_ID, state: body.method === "domain" ? "approved" : "pending" },
    ],
    [`POST /v1/claims/${CONVERSATION_ID}/confirm`]: () => [200, { state: "approved" }],
  });
  const runAs = (args) => run(args, { fetch: api.fetch, env });
  assert.equal((await runAs(["messages", "off"])).code, 0);
  assert.deepEqual(api.requests[1].body, { new_contacts: "closed" });
  assert.equal(api.requests[1].headers["if-match"], '"prefs"');
  assert.match((await runAs(["takeover", BEACON_ID])).out, new RegExp(CONVERSATION_ID));
  assert.match((await runAs(["takeover", BEACON_ID, "--by-domain"])).out, /The beacon is yours/);
  assert.equal((await runAs(["confirm", CONVERSATION_ID, "123456", "--key", key])).code, 0);
  assert.equal(api.requests.at(-1).headers["idempotency-key"], key);
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

test("the old commands are gone, and usage mistakes exit with 2 and point at help", async () => {
  for (const old of [
    "find",
    "post",
    "listings",
    "send",
    "inbox",
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
