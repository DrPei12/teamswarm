export const maxSideChats = 8;
export const maxSideQuestion = 4000;
export const maxSideAnswer = 65536;
const maxAnswers = 5;
const maxSavedChars = 3 * 1024 * 1024;

export type SideAnswer = { question: string; text: string };
export type SideChatTab = {
  id: string;
  number: number;
  draft: string;
  answers: SideAnswer[];
  attempt?: SideAnswer & { error?: string; cancelled?: boolean };
};
export type SideChats = { active: string | null; tabs: SideChatTab[] };

export function newSideChat(tabs: SideChatTab[]): SideChatTab | undefined {
  const used = new Set(tabs.map((tab) => tab.number));
  for (let n = 1; n <= maxSideChats; n++) {
    if (!used.has(n))
      return { id: crypto.randomUUID(), number: n, draft: "", answers: [] };
  }
}

export const sideChatKey = (team: string, chat: string) =>
  `teamswarm.side-chats.v1:${team}:${chat}`;
function storage() {
  return window.teamswarmDesktop?.storage ?? window.localStorage;
}
function boundedString(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit;
}
export function loadSideChats(key: string): SideChats {
  const empty = { active: null, tabs: [] };
  try {
    const saved = storage().getItem(key);
    if (!saved || saved.length > maxSavedChars) return empty;
    const value = JSON.parse(saved);
    if (!Array.isArray(value?.tabs)) return empty;
    const tabs: SideChatTab[] = [];
    for (const item of value.tabs.slice(0, maxSideChats)) {
      if (
        !item ||
        typeof item.id !== "string" ||
        !/^[\da-f-]{36}$/i.test(item.id) ||
        !Number.isInteger(item.number) ||
        item.number < 1 ||
        item.number > maxSideChats ||
        tabs.some((tab) => tab.id === item.id || tab.number === item.number)
      )
        continue;
      const answers: SideAnswer[] = Array.isArray(item.answers)
        ? item.answers
            .slice(-maxAnswers)
            .filter((answer: unknown): answer is SideAnswer => {
              const entry = answer as Partial<SideAnswer> | null;
              return (
                !!entry &&
                boundedString(entry.question, maxSideQuestion) &&
                boundedString(entry.text, maxSideAnswer)
              );
            })
            .map(({ question, text }: SideAnswer) => ({ question, text }))
        : [];
      tabs.push({
        id: item.id,
        number: item.number,
        answers,
        draft: boundedString(item.draft, maxSideQuestion) ? item.draft : "",
      });
    }
    return {
      active: tabs.some((tab) => tab.id === value.active)
        ? value.active
        : (tabs[0]?.id ?? null),
      tabs,
    };
  } catch {
    return empty;
  }
}
export function saveSideChats(key: string, state: SideChats) {
  if (!state.tabs.length) {
    storage().removeItem(key);
    return;
  }
  const value = JSON.stringify({
    active: state.active,
    tabs: state.tabs.map(({ id, number, draft, answers, attempt }) => ({
      id,
      number,
      draft: draft || attempt?.question || "",
      answers: answers.slice(-maxAnswers),
    })),
  });
  if (value.length > maxSavedChars)
    throw Error("Side chat history exceeds its storage limit.");
  storage().setItem(key, value);
}
