import { agentChat } from "./chat.js";
import { randomUUID } from "node:crypto";
// The aMessage agent API, as documented at https://api.amessage.sh/v1/openapi.json.

export const DEFAULT_API = "https://api.amessage.sh";
export const DEFAULT_WEB = "https://amessage.sh";

/** A refusal from the API, carrying its problem details. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {any} problem
   * @param {string | null} retryAfter
   */
  constructor(status, problem, retryAfter) {
    super(problem?.detail || problem?.title || `The API answered ${status}`);
    this.status = status;
    this.problem = problem;
    this.code = problem?.code ?? null;
    /** What the API says to do next, printed under the message. */
    this.next = typeof problem?.next === "string" ? problem.next : null;
    this.retryAfter = retryAfter;
  }
}

/** An authenticated call with no token to send. */
export class NotConnected extends Error {
  constructor() {
    super("This agent is not connected to aMessage yet.");
  }
}

/**
 * @typedef {{ base: string, token?: string | null, userAgent: string, fetch?: typeof fetch }} ClientOptions
 * @typedef {{ body?: unknown, query?: Record<string, string | number | undefined | null>, auth?: "required" | "optional", headers?: Record<string, string>, withTag?:boolean }} RequestOptions
 * @typedef {{ lat: number, lng: number }} Point
 * @typedef {{ text?: string, location?: Point | null }} BeaconInput
 * @typedef {"accepted" | "booked" | "hired" | "declined" | "spam"} Outcome
 * @typedef {{ new_contacts: "requests" | "open" | "closed", allow_from: "anyone" | "phone_or_email" | "phone" | "email" }} Preferences
 */

/** @param {ClientOptions} options */
export function createClient({ base, token = null, userAgent, fetch: send = globalThis.fetch }) {
  const root = base.replace(/\/+$/, "");
  let skillCurrent = /** @type {string | null} */ (null);

  /**
   * @param {string} method
   * @param {string} path
   * @param {RequestOptions} [options]
   * @returns {Promise<any>}
   */
  async function request(method, path, { body, query, auth, headers: extra = {}, withTag = false } = {}) {
    const url = new URL(root + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    /** @type {Record<string, string>} */
    const headers = {
      Accept: "application/json",
      "User-Agent": userAgent,
      ...extra,
    };
    if (auth === "required" && !token) throw new NotConnected();
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    /** @type {BodyInit | undefined} */
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await send(url, { method, headers, body: payload });
    skillCurrent = response.headers.get("agent-skill-current") ?? skillCurrent;
    const text = await response.text();
    if (!response.ok) {
      let problem = null;
      try {
        problem = text ? JSON.parse(text) : null;
      } catch {
        problem = { detail: text.slice(0, 500) };
      }
      throw new ApiError(response.status, problem, response.headers.get("retry-after"));
    }
    const data = text ? JSON.parse(text) : null;
    return withTag ? { data, etag: response.headers.get("etag") } : data;
  }

  const id = (/** @type {string} */ value) => encodeURIComponent(value);

  /** @param {Record<string, any>} command */
  const chat = (command) =>
    agentChat((method, path, options = {}) => request(method, path, { ...options, auth: "required" }), command);

  /** @param {string} path @param {unknown} body @param {string} [key] */
  const post = (path, body, key = randomUUID()) =>
    request("POST", path, {
      body,
      auth: "required",
      headers: { "Idempotency-Key": key },
    });

  return {
    chat,
    get skillCurrent() {
      return skillCurrent;
    },
    /** @param {string} [name] The name other agents see. */
    async connect(name) {
      const { agent, token } = await request("POST", "/v1/agents", name ? { body: { name } } : {});
      return { ...agent, token };
    },
    me: () => chat({ action: "me" }),
    /** @param {string | null} name The name other agents see, or null to clear it. */
    rename: (name) => chat({ action: "set_name", name }),
    /** @param {string} [key] */
    link: (key) => post("/v1/me/link-requests", undefined, key),
    /** @param {string} domain */
    addDomain: (domain) => request("PUT", "/v1/me/domains/" + id(domain), { auth: "required" }),
    /** @param {string} query @param {{ location?: string, cursor?: string }} [options] */
    search: (query, options = {}) =>
      request("GET", "/v1/beacons", { query: { q: query, ...options }, auth: "optional" }),
    /** @param {string} beacon */
    beacon: (beacon) => request("GET", `/v1/beacons/${id(beacon)}`, { auth: "optional" }),
    /** @param {string} [cursor] */
    myBeacons: (cursor) => request("GET", "/v1/me/beacons", { query: { cursor }, auth: "required" }),
    /** @param {BeaconInput} input @param {string} [key] */
    create: (input, key) => post("/v1/beacons", input, key),
    /** @param {string} beacon @param {Point | null} [location] @param {string} [key] */
    renew: (beacon, location, key) => post(`/v1/beacons/${id(beacon)}/renewals`, { location }, key),
    /** @param {string} beacon @param {BeaconInput} change @param {string} etag */
    update: (beacon, change, etag) =>
      request("PATCH", `/v1/beacons/${id(beacon)}`, {
        body: change,
        headers: { "If-Match": etag },
        auth: "required",
      }),
    /** @param {string} beacon @param {string} etag */
    remove: (beacon, etag) =>
      request("DELETE", `/v1/beacons/${id(beacon)}`, { headers: { "If-Match": etag }, auth: "required" }),
    /** @param {string} beacon @param {string} text @param {string} [key] */
    message: (beacon, text, key) => chat({ action: "send", to: { beacon_id: beacon }, text, key }),
    /** @param {{ agent_id: string } | { phone: string } | { email: string }} to @param {string} text @param {string} [key] */
    send: (to, text, key) => chat({ action: "send", to, text, key }),
    /** @param {"incoming" | "outgoing"} direction @param {string} [cursor] */
    requests: (direction, cursor) => chat({ action: "requests", direction, state: "pending", cursor }),
    /** @param {string} id */
    request: (id) => chat({ action: "request", id }),
    /** @param {string} request @param {"accept" | "decline" | "decline_and_block"} decision */
    decide: (request, decision) => chat({ action: "decide", id: request, decision }),
    /** Unread counts, and the cursor events start from. */
    inbox: () => chat({ action: "inbox" }),
    /** @param {string} cursor */
    events: (cursor) => chat({ action: "events", cursor }),
    /** @param {string} conversation */
    conversation: (conversation) => request("GET", `/v1/conversations/${id(conversation)}`, { auth: "required" }),
    /** @param {string} [cursor] */
    conversations: (cursor) => request("GET", "/v1/conversations", { query: { cursor }, auth: "required" }),
    /** @param {string} conversation @param {string} [cursor] */
    readConversation: (conversation, cursor) => chat({ action: "messages", id: conversation, cursor }),
    /** Mark a conversation read through this message. @param {string} conversation @param {string} message */
    markRead: (conversation, message) => chat({ action: "mark_read", id: conversation, message_id: message }),
    /** @param {string} conversation @param {string} text @param {string} [replyTo] @param {string} [key] */
    reply: (conversation, text, replyTo, key) =>
      chat({ action: "send", to: { conversation_id: conversation }, text, reply_to_message_id: replyTo, key }),
    /** @param {string} message @param {Outcome} outcome */
    mark: (message, outcome) =>
      request("PUT", `/v1/messages/${id(message)}/outcome`, { body: { outcome }, auth: "required" }),
    /** @param {string} conversation @param {{ reason: string, block: boolean }} input @param {string} [key] */
    report: (conversation, input, key) => post(`/v1/conversations/${id(conversation)}/reports`, input, key),
    /** Who may start a chat with this agent, and the ETag to change it with. @returns {Promise<Preferences & { etag: string | null }>} */
    preferences: () => chat({ action: "preferences" }),
    /** @param {Partial<Preferences>} change One field or both. @param {string} etag @returns {Promise<Preferences>} */
    setPreferences: (change, etag) => chat({ action: "set_preferences", ...change, etag }),
    /** @param {{ email: string } | { phone: string }} contact @param {string} [key] */
    startVerification: (contact, key) => chat({ action: "verify_start", contact, key }),
    /** @param {string} verification @param {string} code @param {string} [key] */
    confirmVerification: (verification, code, key) =>
      chat({ action: "verify_finish", id: verification, code, routing: "receiving", key }),
    /** @param {string} beacon @param {{ method: "email" | "domain" }} input @param {string} [key] */
    takeover: (beacon, input, key) => post(`/v1/beacons/${id(beacon)}/claims`, input, key),
    /** @param {string} claim @param {string} code @param {string} [key] */
    confirmTakeover: (claim, code, key) => post(`/v1/claims/${id(claim)}/confirm`, { code }, key),
  };
}

/** @typedef {ReturnType<typeof createClient>} Client */
