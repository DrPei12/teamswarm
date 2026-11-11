/**
 * Older runtimes wrote scheduler notices as assistant messages. Keep the
 * stored receipts available for provenance, outside the dialogue and its
 * history cursors. Match the runtime identity, never user-visible wording.
 */
export const conversationMessageSql = `(
  role <> 'assistant' OR client_request_id IS NULL OR (
    client_request_id NOT GLOB 'runtime:resource-wait:*' AND
    client_request_id NOT GLOB 'runtime:resource-resumed:*' AND
    client_request_id NOT GLOB 'runtime:cpu-wait:*' AND
    client_request_id NOT GLOB 'runtime:cpu-resumed:*'
  )
)`;
