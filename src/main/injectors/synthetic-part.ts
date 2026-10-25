import type { TextPart } from "@opencode-ai/sdk"

export function createSyntheticTextPart(args: {
  sessionID: string
  messageID: string
  partKey: string
  text: string
}): TextPart {
  return {
    id: `prt_sn_${args.sessionID}_${args.partKey}`,
    sessionID: args.sessionID,
    messageID: args.messageID,
    type: "text",
    text: args.text,
    synthetic: true,
  }
}

export function insertSyntheticPart(
  parts: Array<{ type: string }>,
  part: TextPart,
  position: "start" | "end",
): void {
  if (position === "start") {
    parts.unshift(part)
  } else {
    parts.push(part)
  }
}
