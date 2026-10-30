export const chatGPTSignInChannel = "teamswarm-chatgpt-sign-in";

// OpenAI may sever window.opener. The return tab can still reach its original
// TeamSwarm window on the same origin without sharing account credentials.
export function relayChatGPTSignIn() {
  const url = new URL(location.href);
  const id = url.searchParams.get("chatgpt_sign_in");
  if (!id) return;
  url.searchParams.delete("chatgpt_sign_in");
  history.replaceState(history.state, "", url.href);
  if (
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id) ||
    typeof BroadcastChannel === "undefined"
  )
    return;
  const channel = new BroadcastChannel(chatGPTSignInChannel);
  const message = { type: "teamswarm:chatgpt-login", id };
  channel.onmessage = (event) => {
    if (
      event.data?.type === "teamswarm:chatgpt-login-received" &&
      event.data.id === id
    )
      window.close();
  };
  channel.postMessage(message);
  const retry = setTimeout(() => channel.postMessage(message), 500);
  setTimeout(() => {
    clearTimeout(retry);
    channel.close();
  }, 2500);
}
