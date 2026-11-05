import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiClient,
  ApiError,
  CredentialDefinition,
  CreateCredentialDefinitionBody,
  Page,
  PaginationQuery,
} from "@verana-labs/vs-agent-client";
import { ensureCredentialDefinition } from "../src/credential-definition";

const VTJSC = "https://ecosystem.example/vt/schemas-avatar-jsc.json";

function definition(id: string, vtjsc: string): CredentialDefinition {
  return {
    id,
    name: "Avatar Credential",
    version: "1",
    attributes: ["avatar", "name"],
    supportRevocation: false,
    relatedJsonSchemaCredentialId: vtjsc,
  };
}

/** A fake v2 anoncreds API that serves the given pages and records creations. */
function fakeApi(
  pages: CredentialDefinition[][],
  onCreate: (body: CreateCredentialDefinitionBody) => Promise<CredentialDefinition>
) {
  const created: CreateCredentialDefinitionBody[] = [];
  const listed: (string | undefined)[] = [];
  const api = {
    anoncreds: {
      async listCredentialDefinitions(query?: PaginationQuery): Promise<Page<CredentialDefinition>> {
        listed.push(query?.cursor);
        const index = query?.cursor ? Number(query.cursor) : 0;
        return {
          items: pages[index] ?? [],
          nextCursor: index + 1 < pages.length ? String(index + 1) : null,
        };
      },
      async createCredentialDefinition(body: CreateCredentialDefinitionBody) {
        created.push(body);
        return onCreate(body);
      },
    },
  } as unknown as ApiClient;
  return { api, created, listed };
}

test("reuses the credential definition of the VTJSC found on a later page", async () => {
  const { api, created, listed } = fakeApi(
    [[definition("cd-other", "https://other.example/jsc.json")], [definition("cd-avatar", VTJSC)]],
    async () => assert.fail("must not create")
  );

  const info = await ensureCredentialDefinition(api, VTJSC);

  assert.equal(info.credentialDefinitionId, "cd-avatar");
  assert.deepEqual(info.attributes, ["avatar", "name"]);
  assert.equal(created.length, 0);
  assert.deepEqual(listed, [undefined, "1"]);
});

test("creates the credential definition when the agent has none for the VTJSC", async () => {
  const { api, created } = fakeApi([[]], async () => definition("cd-new", VTJSC));

  const info = await ensureCredentialDefinition(api, VTJSC);

  assert.equal(info.credentialDefinitionId, "cd-new");
  assert.deepEqual(created, [{ relatedJsonSchemaCredentialId: VTJSC, supportRevocation: false }]);
});

test("a 409 from a concurrent creation falls back to the existing definition", async () => {
  const pages: CredentialDefinition[][] = [[]];
  const { api } = fakeApi(pages, async () => {
    pages[0] = [definition("cd-race", VTJSC)];
    throw new ApiError("INVALID_STATE", 409, "already exists");
  });

  const info = await ensureCredentialDefinition(api, VTJSC);

  assert.equal(info.credentialDefinitionId, "cd-race");
});

test("a 409 with no definition afterwards (no AnonCreds schema yet) is rethrown", async () => {
  const { api } = fakeApi([[]], async () => {
    throw new ApiError("INVALID_STATE", 409, "the registry lists no AnonCreds schema yet");
  });

  await assert.rejects(ensureCredentialDefinition(api, VTJSC), /no AnonCreds schema/);
});
