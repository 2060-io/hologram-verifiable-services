import {
  ApiClient,
  ApiError,
  CredentialDefinition,
} from "@verana-labs/vs-agent-client";

// Avatar name length bounds of the Avatar Credential schema
// (credentialSubject.name in organization/avatar-schema.json).
export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 256;

export interface CredentialInfo {
  /** VTJSC that governs the credential definition. */
  jsonSchemaCredentialId: string;
  credentialDefinitionId: string;
  /** Every attribute of the AnonCreds schema; each issuance sends a claim for all of them. */
  attributes: string[];
  nameMinLength: number;
  nameMaxLength: number;
}

async function findCredentialDefinition(
  api: ApiClient,
  jsonSchemaCredentialId: string
): Promise<CredentialDefinition | undefined> {
  let cursor: string | undefined;
  do {
    const page = await api.anoncreds.listCredentialDefinitions({ cursor });
    const match = page.items.find(
      (cd) => cd.relatedJsonSchemaCredentialId === jsonSchemaCredentialId
    );
    if (match) return match;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return undefined;
}

/**
 * Returns the AnonCreds credential definition of this agent for the VTJSC, and
 * creates it when none exists yet (idempotent across restarts). The agent reads the
 * schema name, version and attributes from the VTJSC.
 */
export async function ensureCredentialDefinition(
  api: ApiClient,
  jsonSchemaCredentialId: string
): Promise<CredentialInfo> {
  let definition = await findCredentialDefinition(api, jsonSchemaCredentialId);
  if (definition) {
    console.log(`Using existing credential definition: ${definition.id}`);
  } else {
    console.log(
      `Creating AnonCreds credential definition for VTJSC ${jsonSchemaCredentialId}...`
    );
    try {
      definition = await api.anoncreds.createCredentialDefinition({
        relatedJsonSchemaCredentialId: jsonSchemaCredentialId,
        supportRevocation: false,
      });
      console.log(`Created credential definition: ${definition.id}`);
    } catch (error) {
      // 409: another instance created it meanwhile, or the registry of the VTJSC
      // issuer lists no AnonCreds schema for it yet. Only the first is recoverable.
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      definition = await findCredentialDefinition(api, jsonSchemaCredentialId);
      if (!definition) throw error;
      console.log(`Using concurrently created credential definition: ${definition.id}`);
    }
  }

  const attributes = definition.attributes.filter((name) => name !== "id");
  if (attributes.length === 0) {
    throw new Error(
      `Credential definition ${definition.id} has no attributes`
    );
  }
  console.log(
    `Credential "${definition.name}" ${definition.version} attributes: ${attributes.join(", ")}`
  );

  return {
    jsonSchemaCredentialId,
    credentialDefinitionId: definition.id,
    attributes,
    nameMinLength: NAME_MIN_LENGTH,
    nameMaxLength: NAME_MAX_LENGTH,
  };
}
