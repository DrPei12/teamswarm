export {};
declare global {
  interface Window {
    teamswarmDesktop?: {
      platform: "windows";
      chooseDirectory: () => Promise<string | null>;
      setTheme: (dark: boolean) => void;
      returnFromChatGPT: () => void;
      storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    };
  }
}
