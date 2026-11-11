import { useSyncExternalStore } from "react";

export type QuestionDraft = {
  chosen: readonly (readonly string[])[];
  other: readonly string[];
};
const empty: QuestionDraft = { chosen: [], other: [] };
// An unanswered request can move between the Host, a member panel and a
// responsive overlay. Keep its unsent answer in this window's memory.
const drafts = new Map<
  string,
  { teamId: string; revision: number; value: QuestionDraft }
>();
let revision = 0;
export const questionDraftRevision = () => revision;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useQuestionDraft(id: string) {
  return useSyncExternalStore(subscribe, () => drafts.get(id)?.value ?? empty);
}
export function updateQuestionDraft(
  id: string,
  teamId: string,
  change: (old: QuestionDraft) => QuestionDraft,
) {
  drafts.set(id, {
    teamId,
    revision: ++revision,
    value: change(drafts.get(id)?.value ?? empty),
  });
  notify();
}
export function discardQuestionDraft(id: string) {
  if (drafts.delete(id)) notify();
}
export function retainPendingQuestionDrafts(
  teamId: string,
  ids: Set<string>,
  observedRevision: number,
) {
  let changed = false;
  for (const [id, draft] of drafts) {
    if (
      draft.teamId === teamId &&
      draft.revision <= observedRevision &&
      !ids.has(id)
    ) {
      drafts.delete(id);
      changed = true;
    }
  }
  if (changed) notify();
}
