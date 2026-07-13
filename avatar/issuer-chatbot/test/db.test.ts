import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Db } from "../src/db";

let db: Db;
let raw: Database.Database;
let dbFile: string;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-db-test-"));
  dbFile = path.join(dir, "test.db");
  db = await Db.create(`sqlite:${dbFile}`);
  raw = new Database(dbFile);
});

after(async () => {
  raw.close();
  await db.close();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

test("hasAvatars reflects avatar ownership", async () => {
  await db.ensureAccount("conn-1");
  assert.equal(await db.hasAvatars("conn-1"), false);

  await db.createAvatar("@alice", "conn-1");
  assert.equal(await db.hasAvatars("conn-1"), true);
  assert.equal(await db.hasAvatars("conn-other"), false);

  await db.deleteAvatar("@alice");
  assert.equal(await db.hasAvatars("conn-1"), false);
});

test("passwords are stored as salted scrypt and verify correctly", async () => {
  await db.ensureAccount("conn-2");
  await db.setPassword("conn-2", "s3cret!");

  const account = await db.getAccount("conn-2");
  assert.ok(account?.passwordHash?.startsWith("scrypt$"));

  assert.equal(await db.verifyPassword("conn-2", "s3cret!"), true);
  assert.equal(await db.verifyPassword("conn-2", "wrong"), false);
});

test("same password yields different hashes (random salt)", async () => {
  await db.ensureAccount("conn-3");
  await db.setPassword("conn-3", "same-password");
  const first = (await db.getAccount("conn-3"))!.passwordHash;
  await db.setPassword("conn-3", "same-password");
  const second = (await db.getAccount("conn-3"))!.passwordHash;
  assert.notEqual(first, second);
});

test("legacy unsalted SHA-256 hashes verify and are upgraded to scrypt", async () => {
  await db.ensureAccount("conn-4");
  const legacy = crypto.createHash("sha256").update("old-pass").digest("hex");
  raw
    .prepare(`UPDATE accounts SET "passwordHash" = ? WHERE "connectionId" = ?`)
    .run(legacy, "conn-4");

  // Wrong password does not verify and does not upgrade
  assert.equal(await db.verifyPassword("conn-4", "nope"), false);
  assert.equal((await db.getAccount("conn-4"))!.passwordHash, legacy);

  // Correct password verifies and upgrades the stored hash to scrypt
  assert.equal(await db.verifyPassword("conn-4", "old-pass"), true);
  const upgraded = (await db.getAccount("conn-4"))!.passwordHash!;
  assert.ok(upgraded.startsWith("scrypt$"));

  // Still verifies after the upgrade
  assert.equal(await db.verifyPassword("conn-4", "old-pass"), true);
  assert.equal(await db.verifyPassword("conn-4", "nope"), false);
});
