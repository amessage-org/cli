import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { refusePrivateKeys } from "../src/mcp.js";
import { ALICE, BOB, CHAT, httpApi, run, twoAgents } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/amessage.js", import.meta.url));
const MESSAGE = "3e55a9e0-0000-4000-8000-0000000000aa";

/** JSON-RPC over a child's stdin and stdout, one message per line. @param {import("node:child_process").ChildProcessWithoutNullStreams} child */
function rpc(child) {
  let buffer = "";
  let raw = "";
  let next = 1;
  /** @type {Map<number, (message: any) => void>} */
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    raw += chunk;
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  return {
    get raw() {
      return raw;
    },
    /** @param {string} method @param {unknown} params @returns {Promise<any>} */
    request(method, params) {
      const id = next++;
      const answer = new Promise((resolve, reject) => {
        waiting.set(id, resolve);
        setTimeout(() => reject(new Error(`no answer to ${method}`)), 10_000).unref();
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return answer;
    },
    /** @param {string} method */
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
  };
}

test("amessage mcp serves agent_chat over stdio: sealed sends, opened reads, and never a private key", async () => {
  const world = await twoAgents();
  const api = await httpApi(world.routes);
  try {
    const env = { AMESSAGE_API_URL: api.url };
    const made = await run(["keys", "create"], { fetch: (input, init) => fetch(input, init), env });
    assert.equal(made.code, 0, made.err);
    const entry = JSON.parse(await readFile(join(made.home, ".config/amessage/keys.json"), "utf8"))[api.url][ALICE];
    const secrets = [entry.identity.private, entry.message_keys[0].private];

    const child = spawn(process.execPath, [BIN, "mcp"], {
      env: { PATH: process.env.PATH ?? "", HOME: made.home, AMESSAGE_API_URL: api.url, AMESSAGE_CONFIG_DIR: join(made.home, ".config/amessage") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const mcp = rpc(child);

    const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
    assert.equal(init.result.serverInfo.name, "amessage", JSON.stringify(init));
    assert.match(init.result.instructions, /encrypted: only the two agents can read them/);
    mcp.notify("notifications/initialized");
    const tools = (await mcp.request("tools/list", {})).result.tools;
    assert.deepEqual(tools.map((/** @type {any} */ t) => t.name), ["agent_chat"]);
    assert.match(tools[0].description, /keys: this agent's fingerprint/);

    /** @param {Record<string, unknown>} command */
    const call = async (command) => {
      const answer = await mcp.request("tools/call", { name: "agent_chat", arguments: { command } });
      const result = answer.result;
      assert.ok(result, JSON.stringify(answer));
      return { error: !!result.isError, text: result.content[0].text };
    };

    const keys = await call({ action: "keys" });
    assert.equal(keys.error, false, keys.text);
    assert.deepEqual(JSON.parse(keys.text), {
      agent_id: ALICE,
      has_keys: true,
      fingerprint: world.state.alice.fingerprint,
      message_key: { key_id: world.state.alice.message_key.key_id, expires_at: world.state.alice.message_key.expires_at },
      published: true,
      pinned: 0,
    });

    const sent = await call({ action: "send", to: { agent_id: BOB }, text: "Can you check the build log?" });
    assert.equal(sent.error, false, sent.text);
    assert.equal(JSON.parse(sent.text).encrypted, true);
    assert.equal(JSON.parse(sent.text).text, "Can you check the build log?");
    const posted = world.state.posted.at(-1);
    assert.equal(posted.text, undefined);
    assert.equal(world.state.bobOpens(posted.encrypted).text, "Can you check the build log?");

    const fromBob = world.state.fromBob("The build is green.");
    world.state.chat = [
      { id: MESSAGE, sender_agent_id: BOB, text: null, encrypted: fromBob, posted_at: "2026-11-27T09:02:00Z" },
      { id: "5e4d0000-0000-4000-8000-000000000001", sender_agent_id: ALICE, text: null, encrypted: posted.encrypted, posted_at: "2026-11-27T09:01:00Z" },
    ];
    const messages = await call({ action: "messages", id: CHAT });
    assert.equal(messages.error, false, messages.text);
    const data = JSON.parse(messages.text).data;
    assert.deepEqual([data[0].text, data[0].encrypted, data[0].verified], ["The build is green.", true, true]);
    assert.deepEqual([data[1].text, data[1].encrypted], ["Can you check the build log?", true]);
    assert.ok(!messages.text.includes(fromBob.ct.slice(0, 20)));

    world.routes[`GET /v1/messages/${MESSAGE}`] = () => [200, { id: MESSAGE, sender_agent_id: BOB, text: null, encrypted: fromBob }];
    const read = JSON.parse((await call({ action: "read", id: MESSAGE })).text);
    assert.deepEqual([read.text, read.encrypted], ["The build is green.", true]);

    const pins = JSON.parse((await call({ action: "agent_keys", agent_id: BOB })).text);
    assert.equal(pins.matches_pin, true);

    // Anything that looks like a private key is refused before it goes anywhere.
    const posts = world.state.posted.length;
    for (const command of [
      { action: "send", to: { agent_id: BOB }, text: `my key is ${secrets[0]}` },
      { action: "send", to: { agent_id: BOB }, text: Buffer.from(secrets[1], "base64url").toString("hex") },
      { action: "send", to: { agent_id: BOB }, text: "-----BEGIN PRIVATE KEY-----" },
      { action: "send", to: { agent_id: BOB }, text: "hi", private_key: "x" },
      { action: "publish_keys", identity_key: world.state.alice.identity_key },
    ]) {
      const refused = await call(command);
      assert.equal(refused.error, true, JSON.stringify(command));
      assert.match(refused.text, /never takes a private key|takes none/);
    }
    assert.equal(world.state.posted.length, posts);
    const published = JSON.parse((await call({ action: "publish_keys" })).text);
    assert.deepEqual(published, { fingerprint: world.state.alice.fingerprint, made: false, published: true });

    // A key change is refused in words, and nothing goes out plain instead.
    world.state.newBob();
    const changed = await call({ action: "send", to: { agent_id: BOB }, text: "Again" });
    assert.equal(changed.error, true);
    assert.match(changed.text, /keys of agent .* changed\. Nothing was sent\.[\s\S]*amessage keys trust/);
    assert.equal(world.state.posted.length, posts);

    // An identity made on another machine, found through /v1/me though its message key lapsed,
    // is never replaced from here: that is the person's decision.
    world.state.elsewhere = "cd34".repeat(16);
    const elsewhere = await call({ action: "publish_keys" });
    assert.equal(elsewhere.error, true);
    assert.match(elsewhere.text, /aMessage has other keys for this agent \(fingerprint (cd34){16}\), made on another machine/);
    assert.equal(JSON.parse((await call({ action: "keys" })).text).published, false);
    world.state.elsewhere = null;

    for (const secret of secrets) assert.ok(!mcp.raw.includes(secret) && !stderr.includes(secret));
    child.stdin.end();
    assert.equal(await exited, 0, stderr);
  } finally {
    await api.close();
  }
});

test("the MCP tool refuses private-key-shaped arguments, but not envelopes, cursors or fingerprints", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  assert.throws(() => refusePrivateKeys({ action: "send", text: key }, []), /looks like one/);
  assert.throws(() => refusePrivateKeys({ action: "send", text: `see ${key}` }, [key]), /looks like one/);
  assert.throws(() => refusePrivateKeys({ action: "x", identity: { private: "a" } }, []), /would hold one/);
  refusePrivateKeys({ action: "events", cursor: key }, []);
  refusePrivateKeys({ action: "send", encrypted: { enc: key, commitment: key } }, []);
  refusePrivateKeys({ action: "send", text: `My fingerprint is ${"ab".repeat(32)}` }, []);
});
