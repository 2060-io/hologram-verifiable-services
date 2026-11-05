import type {
  AgentInfo,
  ApiClient,
  Claim,
  SharedMediaItem,
} from "@verana-labs/vs-agent-client";

// Chat helpers over the official VS Agent v2 client (@verana-labs/vs-agent-client).
// The chatbot talks in menu entries and questions with option ids; this class maps
// them to the v2 Action Menu and Question Answer modules, and maps an answer (which
// v2 reports as the text of the selected response) back to the option id.

export interface ContextualMenuEntry {
  id: string;
  title: string;
}

export interface ContextualMenu {
  title: string;
  description: string;
  options: ContextualMenuEntry[];
}

export interface SendMessageRequest {
  connectionId: string;
  content: string;
  contextualMenu?: ContextualMenu;
}

export type CredentialIssuanceClaim = Claim;

export interface QuestionOption {
  id: string;
  title: string;
}

/** Questions kept for answer resolution; the oldest are dropped past this count. */
const MAX_PENDING_QUESTIONS = 1000;

export class VsAgentClient {
  private readonly api: ApiClient;
  /** Options of each sent question, by the thread id the answer arrives on. */
  private readonly questions = new Map<string, QuestionOption[]>();

  constructor(api: ApiClient) {
    this.api = api;
  }

  async issueCredentialOverConnection(
    connectionId: string,
    credentialDefinitionId: string,
    claims: CredentialIssuanceClaim[]
  ): Promise<void> {
    await this.api.didcomm.createCredentialOffer({
      credentialDefinitionId,
      claims,
      connectionId,
      // The agent issues on request-received, with no acceptCredentialRequest call
      autoAccept: true,
    });
  }

  async sendMediaImage(
    connectionId: string,
    uri: string,
    mimeType: string,
    width: number,
    height: number,
    byteCount: number,
    description?: string,
    preview?: string
  ): Promise<void> {
    const metadata: Record<string, unknown> = { width, height };
    if (preview) {
      metadata.preview = preview;
    }
    const item: SharedMediaItem = {
      uri,
      mimeType,
      byteCount,
      description: description || "Avatar image",
      metadata,
    };
    await this.api.didcomm.shareMedia({
      connectionId,
      description: description || "Avatar image",
      items: [item],
    });
  }

  async sendMessage(params: SendMessageRequest): Promise<void> {
    await this.api.didcomm.sendBasicMessage({
      connectionId: params.connectionId,
      content: params.content,
    });
    if (params.contextualMenu) {
      await this.sendMenuUpdate(params.connectionId, params.contextualMenu);
    }
  }

  async sendQuestionMessage(
    connectionId: string,
    question: string,
    options: QuestionOption[],
    contextualMenu?: ContextualMenu
  ): Promise<void> {
    const { id: threadId } = await this.api.didcomm.sendQuestion({
      connectionId,
      question,
      validResponses: options.map((o) => ({ text: o.title })),
    });
    this.rememberQuestion(threadId, options);
    if (contextualMenu) {
      await this.sendMenuUpdate(connectionId, contextualMenu);
    }
  }

  async sendMenuUpdate(
    connectionId: string,
    menu: ContextualMenu
  ): Promise<void> {
    await this.api.didcomm.sendMenu({
      connectionId,
      menu: {
        title: menu.title,
        description: menu.description,
        options: menu.options.map((o) => ({
          name: o.id,
          title: o.title,
          description: "",
        })),
      },
    });
  }

  /**
   * Maps an answer to the id of the option the user selected. Falls back to the
   * response text when the question is unknown (for example after a restart), so
   * the chatbot treats it as typed input.
   */
  resolveAnswer(threadId: string, response: string): string {
    const options = this.questions.get(threadId);
    const option = options?.find((o) => o.title === response);
    return option ? option.id : response;
  }

  async waitForReady(
    maxRetries: number = 30,
    intervalMs: number = 2000
  ): Promise<AgentInfo> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.api.agent.getReadiness();
        return await this.api.agent.getAgentInfo();
      } catch {
        if (i < maxRetries - 1) {
          console.log(`Waiting for VS-Agent... (${i + 1}/${maxRetries})`);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }
    }
    throw new Error(`VS-Agent not ready after ${maxRetries} retries`);
  }

  private rememberQuestion(threadId: string, options: QuestionOption[]): void {
    this.questions.set(threadId, options);
    if (this.questions.size > MAX_PENDING_QUESTIONS) {
      const oldest = this.questions.keys().next().value;
      if (oldest !== undefined) this.questions.delete(oldest);
    }
  }
}
