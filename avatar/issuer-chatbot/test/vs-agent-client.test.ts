import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ApiClient } from "@verana-labs/vs-agent-client";
import { VsAgentClient } from "../src/vs-agent-client";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let nextId = 0;

/** Stubs fetch so the real v2 ApiClient runs against a fake Admin API. */
function stubAdminApi(): VsAgentClient {
  calls = [];
  nextId = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    let response: unknown = { id: `msg-${++nextId}` };
    if (url.pathname === "/v2/didcomm/credential-offer") {
      response = { credentialExchangeId: "cx-1" };
    } else if (url.pathname === "/v2/agent/info") {
      response = { did: "did:webvh:avatar.example", version: "2.0.0-dev.105" };
    } else if (url.pathname === "/v2/agent/health/ready") {
      response = { status: "ready" };
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return new VsAgentClient(new ApiClient("http://vs-agent:3000/"));
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const menu = {
  title: "Avatar Issuer",
  description: "Not Authenticated",
  options: [
    { id: "new_avatar", title: "New Avatar" },
    { id: "help", title: "Help" },
  ],
};

test("sendMessage sends a basic message, then the action menu", async () => {
  const client = stubAdminApi();
  await client.sendMessage({ connectionId: "c1", content: "Hello", contextualMenu: menu });

  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/v2/didcomm/basic-messages",
      body: { connectionId: "c1", content: "Hello" },
    },
    {
      method: "POST",
      path: "/v2/didcomm/action-menu",
      body: {
        connectionId: "c1",
        menu: {
          title: "Avatar Issuer",
          description: "Not Authenticated",
          options: [
            { name: "new_avatar", title: "New Avatar", description: "" },
            { name: "help", title: "Help", description: "" },
          ],
        },
      },
    },
  ]);
});

test("sendQuestionMessage sends a question and resolves its answer to the option id", async () => {
  const client = stubAdminApi();
  await client.sendQuestionMessage("c1", "Avatar name: @a. Confirm?", [
    { id: "confirm_yes", title: "Yes" },
    { id: "confirm_no", title: "No" },
  ]);
  await client.sendQuestionMessage("c1", "Confirm this avatar?", [
    { id: "image_yes", title: "Yes" },
    { id: "image_no", title: "No" },
  ]);

  assert.deepEqual(calls[0], {
    method: "POST",
    path: "/v2/didcomm/question-answer",
    body: {
      connectionId: "c1",
      question: "Avatar name: @a. Confirm?",
      validResponses: [{ text: "Yes" }, { text: "No" }],
    },
  });
  // The question id is the thread its answer arrives on; same titles, different ids
  assert.equal(client.resolveAnswer("msg-1", "Yes"), "confirm_yes");
  assert.equal(client.resolveAnswer("msg-2", "Yes"), "image_yes");
  assert.equal(client.resolveAnswer("msg-2", "No"), "image_no");
  // Unknown thread: the response text is handed on as typed input
  assert.equal(client.resolveAnswer("unknown", "Skip"), "Skip");
});

test("sendMediaImage shares the image with its dimensions and preview as metadata", async () => {
  const client = stubAdminApi();
  await client.sendMediaImage(
    "c1",
    "https://media.example/a.png",
    "image/png",
    512,
    512,
    1234,
    "Your processed avatar",
    "data:image/png;base64,AAAA"
  );

  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/v2/didcomm/media-sharing",
      body: {
        connectionId: "c1",
        description: "Your processed avatar",
        items: [
          {
            uri: "https://media.example/a.png",
            mimeType: "image/png",
            byteCount: 1234,
            description: "Your processed avatar",
            metadata: { width: 512, height: 512, preview: "data:image/png;base64,AAAA" },
          },
        ],
      },
    },
  ]);
});

test("issueCredentialOverConnection creates an auto-accepted offer on the connection", async () => {
  const client = stubAdminApi();
  await client.issueCredentialOverConnection("c1", "cred-def-1", [
    { name: "name", value: "@a" },
    { name: "avatar", value: "" },
  ]);

  assert.deepEqual(calls, [
    {
      method: "POST",
      path: "/v2/didcomm/credential-offer",
      body: {
        credentialDefinitionId: "cred-def-1",
        claims: [
          { name: "name", value: "@a" },
          { name: "avatar", value: "" },
        ],
        connectionId: "c1",
        autoAccept: true,
      },
    },
  ]);
});

test("waitForReady checks readiness and returns the agent info", async () => {
  const client = stubAdminApi();
  const info = await client.waitForReady(1, 0);

  assert.equal(info.did, "did:webvh:avatar.example");
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/v2/agent/health/ready", "/v2/agent/info"]
  );
});
