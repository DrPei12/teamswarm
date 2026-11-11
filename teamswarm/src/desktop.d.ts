export {};
declare global {
  interface Window {
    teamswarmDesktop?: {
      platform: "windows";
      chooseDirectory: () => Promise<string | null>;
      setTheme: (dark: boolean, surface?: string) => void;
      saveAppearanceFont?: (bytes: Uint8Array) => Promise<string>;
      readAppearanceFont?: (id: string) => Promise<Uint8Array>;
      returnFromChatGPT: () => void;
      storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    };
  }
}
