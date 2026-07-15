import type { proto } from "@whiskeysockets/baileys";

export interface ExtractedContent {
  text: string;
  type: string;
}

/**
 * WhatsApp message payloads come in many nested shapes.
 * Unwrap the wrappers, then pull out human-readable text.
 * Returns null for protocol noise (key distribution, deletions, etc.).
 */
export function extractContent(message: proto.IMessage | null | undefined): ExtractedContent | null {
  if (!message) return null;

  // Unwrap container types
  const m =
    message.ephemeralMessage?.message ??
    message.viewOnceMessage?.message ??
    message.viewOnceMessageV2?.message ??
    message.documentWithCaptionMessage?.message ??
    message.editedMessage?.message?.protocolMessage?.editedMessage ??
    message;

  if (m.conversation) return { text: m.conversation, type: "text" };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, type: "text" };
  if (m.imageMessage) return { text: m.imageMessage.caption || "[image]", type: "image" };
  if (m.videoMessage) return { text: m.videoMessage.caption || "[video]", type: "video" };
  if (m.documentMessage)
    return { text: m.documentMessage.caption || `[document: ${m.documentMessage.fileName || "file"}]`, type: "document" };
  if (m.audioMessage) return { text: m.audioMessage.ptt ? "[voice message]" : "[audio]", type: "audio" };
  if (m.stickerMessage) return { text: "[sticker]", type: "sticker" };
  if (m.locationMessage)
    return {
      text: `[location: ${m.locationMessage.degreesLatitude}, ${m.locationMessage.degreesLongitude}]`,
      type: "location",
    };
  if (m.liveLocationMessage) return { text: "[live location]", type: "location" };
  if (m.contactMessage) return { text: `[contact: ${m.contactMessage.displayName || ""}]`, type: "contact" };
  if (m.contactsArrayMessage) return { text: "[contacts]", type: "contact" };
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) {
    const poll = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3;
    return { text: `[poll: ${poll?.name || ""}]`, type: "poll" };
  }
  if (m.reactionMessage) return null; // reactions are noise for chat history
  if (m.protocolMessage) return null; // deletions, key changes, etc.

  return null;
}
