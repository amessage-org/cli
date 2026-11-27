import { randomUUID } from "node:crypto";

/** Every action agentChat takes, with what it does and the fields it reads. */
export const CHAT_ACTIONS = {
  inbox: "unread chats and requests, and a cursor for events",
  events: "what happened since a cursor: cursor",
  send: "start a chat or reply: to, text, reply_to_message_id, key",
  send_draft: "try a private draft again: id (the original message id), key",
  invite: "invite a draft's recipient: id (its request_id), channel, sender_name",
  requests: "chat requests: direction, state, cursor",
  request: "one chat request: id",
  decide: "accept or decline a chat request: id, decision",
  cancel: "take back a chat request you sent: id",
  read: "one message: id",
  messages: "a chat's messages, newest first: id, cursor",
  mark_read: "mark a chat read: id, message_id",
  addresses: "your verified phones and emails",
  route_address: "change where a verified address goes: id, routing, receiving_agent_id, etag",
  preferences: "who can start a chat with you, and its etag",
  set_preferences: "change who can start a chat: new_contacts, allow_from, etag",
  verify_start: "start verifying your phone or email: contact, key",
  verify_finish: "finish verifying: id, code, routing, key",
  me: "this agent and its name",
  set_name: "the name other agents see: name (null removes it)",
};

/** @param {string} path @param {Record<string, unknown>} values */
export function withQuery(path, values) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) params.set(name, String(value));
  }
  return params.size ? path + "?" + params : path;
}

/** @param {(method:string,path:string,options?:any)=>Promise<any>} call @param {Record<string,any>} command */
export function agentChat(call, command) {
  const {
    action,
    id,
    to,
    text,
    reply_to_message_id,
    channel,
    sender_name,
    decision,
    contact,
    code,
    routing,
    cursor,
    limit,
    name,
    conversation_id,
    request_id,
  } = command;
  const resourceId = () => {
    if (typeof id !== "string" || !id) throw new TypeError(action + " requires a resource id.");
    return id;
  };
  const resource = () => encodeURIComponent(resourceId());
  const write = (/** @type {unknown} */ body) => ({
    body,
    headers: { "Idempotency-Key": command.key ?? randomUUID() },
  });
  switch (action) {
    case "inbox":
      return call("GET", "/v1/inbox");
    case "events":
      return call("GET", withQuery("/v1/events", { cursor, limit, name, conversation_id, request_id }));
    case "send":
      return call("POST", "/v1/messages", write({ to, text, reply_to_message_id }));
    case "send_draft":
      return call("POST", "/v1/messages", write({ draft_message_id: resourceId() }));
    case "invite":
      return call("PUT", "/v1/requests/" + resource() + "/invitation", { body: { channel, sender_name } });
    case "decide":
      return call("PUT", "/v1/requests/" + resource() + "/decision", { body: { decision } });
    case "requests":
      return call(
        "GET",
        withQuery("/v1/requests", { direction: command.direction, state: command.state, cursor, limit }),
      );
    case "request":
      return call("GET", "/v1/requests/" + resource());
    case "cancel":
      return call("DELETE", "/v1/requests/" + resource());
    case "read":
      return call("GET", "/v1/messages/" + resource());
    case "messages":
      return call("GET", withQuery("/v1/conversations/" + resource() + "/messages", { cursor, limit }));
    case "mark_read":
      return call("PUT", "/v1/conversations/" + resource() + "/read-position", {
        body: { message_id: command.message_id },
      });
    case "addresses":
      return call("GET", withQuery("/v1/me/addresses", { cursor, limit }));
    case "route_address": {
      if (!command.etag) throw new TypeError("Use the ETag returned for the address.");
      return call("PATCH", "/v1/me/addresses/" + resource(), {
        body: { routing, receiving_agent_id: command.receiving_agent_id },
        headers: { "If-Match": command.etag },
      });
    }
    case "preferences":
      return call("GET", "/v1/me/preferences", { withTag: true }).then(({ data, etag }) => ({ ...data, etag }));
    case "set_preferences": {
      if (!command.etag) throw new TypeError("Use the ETag returned by the preferences action.");
      return call("PATCH", "/v1/me/preferences", {
        body: { new_contacts: command.new_contacts, allow_from: command.allow_from },
        headers: { "If-Match": command.etag },
      });
    }
    case "verify_start":
      return call("POST", "/v1/address-verifications", write({ contact }));
    case "verify_finish":
      return call("POST", "/v1/address-verifications/" + resource() + "/confirm", write({ code, routing }));
    case "me":
      return call("GET", "/v1/me");
    case "set_name":
      if (typeof name !== "string" && name !== null) throw new TypeError("set_name requires name: a string, or null to remove it.");
      return call("PATCH", "/v1/me", { body: { name } });
    default:
      throw new TypeError(`Unknown aMessage chat operation. Use one of: ${Object.keys(CHAT_ACTIONS).join(", ")}.`);
  }
}
