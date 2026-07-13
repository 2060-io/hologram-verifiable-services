import { test, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Chatbot } from "../src/chatbot";
import { Db } from "../src/db";
import { SessionStore } from "../src/session-store";
import { VsAgentClient, ContextualMenu } from "../src/vs-agent-client";
import { SchemaInfo } from "../src/schema-reader";
import { Config } from "../src/config";
import { MediaStore } from "../src/media-store";

/** Records outbound VS Agent calls instead of performing HTTP requests. */
class FakeClient {
  messages: { connectionId: string; content: string; contextualMenu?: ContextualMenu }[] = [];
  questions: {
    connectionId: string;
    prompt: string;
    options: { id: string; title: string }[];
    contextualMenu?: ContextualMenu;
  }[] = [];
  issued: {
    connectionId: string;
    credentialDefinitionId: string;
    claims: { name: string; value: string }[];
  }[] = [];
  /** Contextual menus in send order, across messages and questions. */
  menus: (ContextualMenu | undefined)[] = [];

  async sendMessage(req: {
    connectionId: string;
    content: string;
    contextualMenu?: ContextualMenu;
  }): Promise<void> {
    this.messages.push(req);
    this.menus.push(req.contextualMenu);
  }

  async sendQuestionMessage(
    connectionId: string,
    prompt: string,
    options: { id: string; title: string }[],
    contextualMenu?: ContextualMenu
  ): Promise<void> {
    this.questions.push({ connectionId, prompt, options, contextualMenu });
    this.menus.push(contextualMenu);
  }

  async sendReceipts(): Promise<void> {}

  async sendMediaImage(): Promise<void> {}

  async issueCredentialOverConnection(
    connectionId: string,
    credentialDefinitionId: string,
    claims: { name: string; value: string }[]
  ): Promise<void> {
    this.issued.push({ connectionId, credentialDefinitionId, claims });
  }

  lastMenuIds(): string[] {
    const menu = this.menus[this.menus.length - 1];
    return (menu?.options ?? []).map((o) => o.id);
  }
}

const schema: SchemaInfo = {
  vtjscId: "vtjsc-1",
  schemaId: "schema-1",
  title: "Avatar",
  attributes: [{ name: "name" }, { name: "avatar" }] as SchemaInfo["attributes"],
  nameMinLength: 3,
  nameMaxLength: 32,
  credentialDefinitionId: "cred-def-1",
};

let dbDir: string;
let db: Db;
let client: FakeClient;
let chatbot: Chatbot;
let conn = 0;

before(async () => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-chatbot-test-"));
  db = await Db.create(`sqlite:${path.join(dbDir, "test.db")}`);
});

after(async () => {
  await db.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(() => {
  client = new FakeClient();
  chatbot = new Chatbot(
    client as unknown as VsAgentClient,
    new SessionStore(),
    db,
    schema,
    {} as Config,
    {} as MediaStore
  );
  conn++;
});

test("contextual menu hides Reissue/Delete when the connection owns no avatars", async () => {
  const id = `conn-${conn}`;
  await chatbot.onTextMessage(id, "/list");

  const ids = client.lastMenuIds();
  assert.ok(ids.includes("new_avatar"));
  assert.ok(ids.includes("list"));
  assert.ok(!ids.includes("reissue"));
  assert.ok(!ids.includes("delete_avatar"));
});

test("contextual menu shows Reissue/Delete when the connection owns an avatar", async () => {
  const id = `conn-${conn}`;
  await db.ensureAccount(id);
  await db.createAvatar(`@owner${conn}`, id);

  await chatbot.onTextMessage(id, "/list");

  const ids = client.lastMenuIds();
  assert.ok(ids.includes("reissue"));
  assert.ok(ids.includes("delete_avatar"));
});

test("/issue without a name and no avatars explains /new and starts no flow", async () => {
  const id = `conn-${conn}`;
  await chatbot.onTextMessage(id, "/issue");

  const last = client.messages[client.messages.length - 1];
  assert.match(last.content, /no avatars yet/i);
  // No flow started: the menu is the regular one, not "Abort current flow"
  assert.ok(!client.lastMenuIds().includes("abort"));
});

test("reissue from the menu offers a tap-to-pick avatar list and reissues on skip", async () => {
  const id = `conn-${conn}`;
  const name = `@pick${conn}`;
  await db.ensureAccount(id);
  await db.createAvatar(name, id);

  // Tap "Reissue Credential" in the contextual menu
  await chatbot.onMenuSelect(id, "reissue");

  const question = client.questions[client.questions.length - 1];
  assert.match(question.prompt, /which avatar/i);
  assert.deepEqual(
    question.options.map((o) => o.id),
    [name]
  );
  // A flow is now active, so the menu offers Abort
  assert.deepEqual(client.lastMenuIds(), ["abort"]);

  // Tap the avatar in the pick list
  await chatbot.onMenuSelect(id, name);
  const prompt = client.messages[client.messages.length - 1];
  assert.match(prompt.content, /send an image/i);

  // Skip the image: credential is reissued with an empty avatar attribute
  await chatbot.onMenuSelect(id, "skip_image");
  assert.equal(client.issued.length, 1);
  assert.equal(client.issued[0].credentialDefinitionId, "cred-def-1");
  assert.deepEqual(client.issued[0].claims, [
    { name: "name", value: name },
    { name: "avatar", value: "" },
  ]);
  const done = client.messages[client.messages.length - 1];
  assert.match(done.content, /issued successfully/i);
});

test("reissue of an avatar owned by another connection is refused", async () => {
  const id = `conn-${conn}`;
  const other = `other-${conn}`;
  const name = `@stranger${conn}`;
  await db.ensureAccount(other);
  await db.createAvatar(name, other);

  await chatbot.onTextMessage(id, `/issue ${name}`);

  const last = client.messages[client.messages.length - 1];
  assert.match(last.content, /not the owner/i);
  assert.equal(client.issued.length, 0);
});

test("delete via the menu entry prompts for a name and deletes the avatar", async () => {
  const id = `conn-${conn}`;
  const name = `@gone${conn}`;
  await db.ensureAccount(id);
  await db.createAvatar(name, id);

  await chatbot.onMenuSelect(id, "delete_avatar");
  const prompt = client.messages[client.messages.length - 1];
  assert.match(prompt.content, /name of the avatar to delete/i);

  await chatbot.onTextMessage(id, name);
  const done = client.messages[client.messages.length - 1];
  assert.match(done.content, /deleted/i);
  assert.equal(await db.hasAvatars(id), false);
  // Menu no longer offers Reissue/Delete
  const ids = client.lastMenuIds();
  assert.ok(!ids.includes("reissue"));
  assert.ok(!ids.includes("delete_avatar"));
});
