/** Keep a direct message distinct from the older assignment in its context. */
export function conversationInput(input: string): string {
  let value: any;
  try { value = JSON.parse(input); } catch { return input; }
  if (!value || typeof value !== "object" || !value.work) return input;
  const direct = !!value.work.interaction;
  if (!direct && value.turnPurpose !== "dialogue") return input;
  const incoming = Array.isArray(value.incomingMessages) ? value.incomingMessages : [];
  const current = direct
    ? incoming.filter((message: any) => typeof message.content === "string")
        .map((message: any) => ({ role: message.senderId === "user" ? "user" : "member", content: message.content }))
    : typeof value.work.instructions === "string"
      ? [{ role: "user", content: value.work.instructions }] : [];
  if (!current.length) return input;
  const { history, conversationHistory, ...context } = value;
  const earlier = (direct ? conversationHistory : history) ?? [];
  const messages = Array.isArray(earlier) ? earlier
    .filter((message: any) => typeof message.content === "string")
    .map((message: any) => ({
      role: message.role ?? (message.senderId === value.work.memberId ? "assistant" : message.senderId === "user" ? "user" : "member"),
      content: message.content,
      ...(message.partial ? { partial: true } : {}),
    })) : [];
  return [
    "Answer the current message below. Earlier messages are actual conversation history. Previous assignments are background, not a new request.",
    "Background context:", JSON.stringify(context),
    "Earlier messages:", JSON.stringify(messages),
    "Current message:", JSON.stringify(current),
  ].join("\n\n");
}
