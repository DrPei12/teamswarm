export function executionFeedback(text: string): string {
  if (
    /^Execution resource .+ (changed to version .+ after assignment|no longer exists); reassign this work before it runs\.$/.test(
      text,
    )
  )
    return "Execution configuration changed. Select the member's Harness and model, then retry this message.";
  if (
    /^(The run work limit was reached\.|This run has reached its work limit\.)/.test(
      text,
    )
  )
    return "This run has reached its work limit. Retry the failed message or ask Host to continue the work.";
  return text;
}
