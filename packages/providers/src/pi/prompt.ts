import { readFileSync } from "node:fs";
import type { UserInput } from "@codeden/contracts";
import type { PiImageContent } from "./protocol";

/**
 * A message for Pi: images it takes go inline; images it can't take (a text-only model), and
 * files, are named by path so the agent can read them with its own tools instead.
 */
export function promptFor(
  input: UserInput,
  images: boolean,
): { message: string; images: PiImageContent[] } {
  const sent: PiImageContent[] = [];
  const named: string[] = [];
  for (const attachment of input.attachments) {
    if (attachment.type === "file") {
      named.push(attachment.path);
      continue;
    }
    if (!images) {
      if (attachment.source.type === "path") named.push(attachment.source.path);
      else named.push(attachment.name ?? "an attached image");
      continue;
    }
    if (attachment.source.type === "artifact") {
      throw new Error("Artifact attachments must be resolved to a path or base64 before sending");
    }
    sent.push({
      type: "image",
      data:
        attachment.source.type === "base64"
          ? attachment.source.data
          : readFileSync(attachment.source.path).toString("base64"),
      mimeType: attachment.mediaType,
    });
  }
  if (!named.length) return { message: input.text, images: sent };
  const list = named.map((path) => `- ${path}`).join("\n");
  return { message: `${input.text}\n\nFiles in this message:\n${list}`, images: sent };
}
