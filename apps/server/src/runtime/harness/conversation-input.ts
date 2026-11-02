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
  const { history, conversationHistory, incomingMessages, ...context } = value;
  // The readable conversation must retain routing facts. Dropping the incoming
  // envelope leaves native workers unable to address an actual reply to Host.
  const routes = direct ? incoming.filter((m: any) => m.senderId !== "user" && typeof m.id === "string" && typeof m.senderId === "string")
    .map((m: any) => ({ messageId: m.id, senderId: m.senderId, replyExpected: m.replyExpected !== false })) : [];
  if (routes.length) context.currentMessageRoutes = routes;
  const earlier = (direct ? conversationHistory : history) ?? [];
  const messages = Array.isArray(earlier) ? earlier
    .filter((message: any) => typeof message.content === "string")
    .map((message: any) => ({
      role: message.role ?? (message.senderId === value.work.memberId ? "assistant" : message.senderId === "user" ? "user" : "member"),
      content: message.content,
      ...(message.partial ? { partial: true } : {}),
    })) : [];
  const messageText = (message: { role: string; content: string; partial?: boolean }) =>
    `${message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "Member"}${message.partial ? " (excerpt)" : ""}:\n${message.content}`;
  return [
    "Answer the current message below. Earlier messages are actual conversation history. Previous assignments are background, not a new request.",
    ...(routes.length ? ["For a current member message with replyExpected=true, send one factual answer using team_message(recipientId=senderId, replyTo=messageId, replyExpected=false). A final answer alone does not notify the sender. For replyExpected=false, do not send an acknowledgement."] : []),
    "Background context:", JSON.stringify(context),
    ...(messages.length > 2 ? ["Earlier messages (oldest first):", messages.slice(0, -2).map(messageText).join("\n\n")] : []),
    ...(messages.length ? ["Most recent messages (oldest first):", messages.slice(-2).map(messageText).join("\n\n")] : []),
    "Current message:", current.map(messageText).join("\n\n"),
  ].join("\n\n");
}
