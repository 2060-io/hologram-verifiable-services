import { Router, Request, Response } from "express";
import {
  EventDispatcher,
  EventEnvelope,
  UnknownEventEnvelope,
} from "@verana-labs/vs-agent-client";
import { Chatbot } from "./chatbot";
import { VsAgentClient } from "./vs-agent-client";

/** Event ids remembered to discard a redelivered event. */
const MAX_SEEN_EVENTS = 1000;

type ChatbotHandlers = Pick<
  Chatbot,
  "onNewConnection" | "onTextMessage" | "onMenuSelect" | "onMenuRequest" | "onMediaMessage"
>;

/**
 * VS Agent v2 Events API: the agent POSTs every event envelope
 * ({ id, type, timestamp, data }) to one URL, its EVENTS_WEBHOOK_URL.
 * Point it at POST /events of this server.
 */
export function createWebhookRouter(
  chatbot: ChatbotHandlers,
  client: Pick<VsAgentClient, "resolveAnswer">
): Router {
  const router = Router();
  const seen = new Set<string>();

  const events = new EventDispatcher()
    .on("didcomm.connections.state-updated", async (data) => {
      console.log(
        `Event: connection ${data.id} ${data.previousState ?? "-"} → ${data.state}`
      );
      if (data.state === "completed" && data.previousState !== "completed") {
        await chatbot.onNewConnection(data.id);
      }
    })
    .on("didcomm.basic-messages.message-received", async (data) => {
      if (data.content) {
        await chatbot.onTextMessage(data.connectionId, data.content);
      }
    })
    .on("didcomm.action-menu.perform-received", async (data) => {
      await chatbot.onMenuSelect(data.connectionId, data.name);
    })
    .on("didcomm.action-menu.menu-request-received", async (data) => {
      await chatbot.onMenuRequest(data.connectionId);
    })
    .on("didcomm.question-answer.answer-received", async (data) => {
      const selectionId = client.resolveAnswer(data.threadId, data.response);
      await chatbot.onMenuSelect(data.connectionId, selectionId);
    })
    .on("didcomm.media-sharing.share-media-received", async (data) => {
      const firstItem = data.items?.[0];
      console.log(`Media item payload: ${JSON.stringify(firstItem)}`);
      if (firstItem?.uri && firstItem.mimeType?.startsWith("image/")) {
        await chatbot.onMediaMessage(
          data.connectionId,
          firstItem.uri,
          firstItem.mimeType,
          firstItem.ciphering
        );
      } else {
        console.log(`Ignoring media message without image item`);
      }
    });

  router.post("/events", async (req: Request, res: Response) => {
    const envelope = req.body as EventEnvelope | UnknownEventEnvelope;
    if (!envelope || typeof envelope.type !== "string") {
      res.status(400).json({ error: "Not an event envelope" });
      return;
    }
    if (envelope.id && seen.has(envelope.id)) {
      res.sendStatus(204);
      return;
    }
    try {
      await events.dispatch(envelope);
      if (envelope.id) {
        seen.add(envelope.id);
        if (seen.size > MAX_SEEN_EVENTS) {
          const oldest = seen.values().next().value;
          if (oldest !== undefined) seen.delete(oldest);
        }
      }
      res.sendStatus(204);
    } catch (error) {
      console.error(`Error handling event ${envelope.type}:`, error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Health check
  router.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  return router;
}
