import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { Server } from "node:http";
import express from "express";
import { createWebhookRouter } from "../src/webhooks";

type Call = [string, ...unknown[]];

let calls: Call[] = [];
let server: Server;
let baseUrl: string;
let eventId = 0;

const chatbot = {
  async onNewConnection(connectionId: string) {
    calls.push(["onNewConnection", connectionId]);
  },
  async onTextMessage(connectionId: string, text: string) {
    calls.push(["onTextMessage", connectionId, text]);
  },
  async onMenuSelect(connectionId: string, menuId: string) {
    calls.push(["onMenuSelect", connectionId, menuId]);
  },
  async onMenuRequest(connectionId: string) {
    calls.push(["onMenuRequest", connectionId]);
  },
  async onMediaMessage(connectionId: string, uri: string, mimeType: string, ciphering?: unknown) {
    calls.push(["onMediaMessage", connectionId, uri, mimeType, ciphering]);
  },
};

const client = {
  resolveAnswer(threadId: string, response: string): string {
    return threadId === "q-1" && response === "Yes" ? "confirm_yes" : response;
  },
};

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/", createWebhookRouter(chatbot, client));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  calls = [];
});

async function post(type: string, data: unknown, id = `evt-${++eventId}`): Promise<number> {
  const res = await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, type, timestamp: new Date().toISOString(), data }),
  });
  return res.status;
}

test("a connection that reaches completed starts the chat, once", async () => {
  assert.equal(
    await post("didcomm.connections.state-updated", { id: "c1", state: "completed", previousState: "response-sent" }),
    204
  );
  await post("didcomm.connections.state-updated", { id: "c1", state: "completed", previousState: "completed" });
  await post("didcomm.connections.state-updated", { id: "c2", state: "request-received", previousState: null });

  assert.deepEqual(calls, [["onNewConnection", "c1"]]);
});

test("basic messages, menu performs and menu requests reach the chatbot", async () => {
  await post("didcomm.basic-messages.message-received", {
    id: "rec-1",
    connectionId: "c1",
    role: "receiver",
    content: "/list",
    sentTime: "",
    createdAt: "",
  });
  await post("didcomm.action-menu.perform-received", { connectionId: "c1", threadId: "m-1", name: "new_avatar" });
  await post("didcomm.action-menu.menu-request-received", { connectionId: "c1", threadId: "m-2" });

  assert.deepEqual(calls, [
    ["onTextMessage", "c1", "/list"],
    ["onMenuSelect", "c1", "new_avatar"],
    ["onMenuRequest", "c1"],
  ]);
});

test("an answer is resolved to the option id of its question", async () => {
  await post("didcomm.question-answer.answer-received", { connectionId: "c1", threadId: "q-1", response: "Yes" });

  assert.deepEqual(calls, [["onMenuSelect", "c1", "confirm_yes"]]);
});

test("a shared image reaches the chatbot with its ciphering; other media is ignored", async () => {
  const ciphering = { algorithm: "aes-256-cbc", parameters: { key: "00", iv: "00" } };
  await post("didcomm.media-sharing.share-media-received", {
    connectionId: "c1",
    threadId: "t-1",
    items: [{ id: "i1", uri: "https://media.example/x", mimeType: "image/jpeg", ciphering }],
  });
  await post("didcomm.media-sharing.share-media-received", {
    connectionId: "c1",
    threadId: "t-2",
    items: [{ id: "i2", uri: "https://media.example/y", mimeType: "audio/m4a" }],
  });

  assert.deepEqual(calls, [["onMediaMessage", "c1", "https://media.example/x", "image/jpeg", ciphering]]);
});

test("a redelivered event id is discarded and unknown types are accepted", async () => {
  const data = { connectionId: "c1", threadId: "m-1", name: "list" };
  assert.equal(await post("didcomm.action-menu.perform-received", data, "dup-1"), 204);
  assert.equal(await post("didcomm.action-menu.perform-received", data, "dup-1"), 204);
  assert.equal(await post("vpr.notification", {}), 204);

  assert.deepEqual(calls, [["onMenuSelect", "c1", "list"]]);
});

test("a body that is no event envelope is refused", async () => {
  const res = await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId: "c1", state: "completed" }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
});
