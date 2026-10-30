import { randomBytes } from "node:crypto";

export type SignInPresentation = {
  returnUrl: string;
  language?: "en" | "zh-CN";
  theme?: "light" | "dark";
  desktop?: boolean;
};

export function signInPresentation(value?: SignInPresentation): SignInPresentation | undefined {
  if (!value) return;
  const url = new URL(value.returnUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password)
    throw new Error("Return to a local TeamSwarm window.");
  return { ...value, returnUrl: url.href };
}

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function signInResultPage(input: {
  id: string; receipt: string; complete: boolean; email?: string; presentation?: SignInPresentation;
}) {
  const nonce = randomBytes(24).toString("base64");
  const zh = input.presentation?.language !== "en";
  const title = input.complete ? (zh ? "ChatGPT 已连接" : "ChatGPT connected") : (zh ? "连接未完成" : "Connection not completed");
  const detail = input.complete
    ? (zh ? "返回 TeamSwarm，选择模型并继续工作。" : "Return to TeamSwarm to choose a model and continue your work.")
    : (zh ? "请返回 TeamSwarm，重新开始登录。" : "Return to TeamSwarm and start sign-in again.");
  const button = zh ? "返回 TeamSwarm" : "Return to TeamSwarm";
  const returning = zh ? "正在返回 TeamSwarm…" : "Returning to TeamSwarm…";
  const ready = zh ? "连接已就绪。也可以点击按钮返回。" : "Your connection is ready. You can also use the button to return.";
  const config = JSON.stringify({ ...input, email: undefined, returning, ready }).replace(/</g, "\\u003c");
  const target = input.presentation?.returnUrl;
  return {
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
    html: `<!doctype html><html lang="${zh ? "zh-CN" : "en"}"${input.presentation?.theme ? ` data-theme="${input.presentation.theme}"` : ""}><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · TeamSwarm</title>
<style nonce="${nonce}">
:root{color-scheme:light;--bg:#f5f5f3;--panel:#fcfcfb;--text:#252523;--muted:#62625d;--line:#1515151a;--accent:#b65335;--success:#33745b}
:root[data-theme=dark]{color-scheme:dark;--bg:#151514;--panel:#1b1b19;--text:#ecece7;--muted:#b4b4aa;--line:#ffffff1a;--accent:#d97757;--success:#8ac6a8}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--bg:#151514;--panel:#1b1b19;--text:#ecece7;--muted:#b4b4aa;--line:#ffffff1a;--accent:#d97757;--success:#8ac6a8}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;background:var(--bg);color:var(--text);font-family:system-ui,"Segoe UI","Noto Sans SC",sans-serif;display:grid;grid-template-rows:auto 1fr auto;padding:clamp(20px,5vw,48px)}
header,footer{font-size:13px;color:var(--muted)}header{display:flex;gap:10px;align-items:center}header strong{font-size:16px;font-weight:600;color:var(--text)}header span{border-left:1px solid var(--line);padding-left:10px}
main{width:min(100%,460px);align-self:center;justify-self:center;padding:clamp(28px,5vw,40px);margin:32px 0;background:var(--panel);border:1px solid var(--line);border-radius:16px}
.status{width:44px;height:44px;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center;color:${input.complete ? "var(--success)" : "var(--accent)"};margin-bottom:24px}.status svg{width:23px;height:23px}
h1{margin:0;font-size:26px;line-height:1.35;letter-spacing:-.03em;font-weight:600}p{color:var(--muted);font-size:14px;line-height:1.75;margin:12px 0 24px}.account{margin:24px 0;padding:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);display:grid;gap:7px;overflow-wrap:anywhere}.account span{font-size:12px;color:var(--muted)}.account strong{font-size:14px;font-weight:500}
.button{display:flex;align-items:center;justify-content:center;min-height:44px;padding:12px 18px;background:var(--accent);color:white;text-decoration:none;border:0;border-radius:8px;font:inherit;font-size:14px;font-weight:600;width:100%;cursor:pointer}.button:hover{filter:brightness(.94)}.button:focus-visible{outline:3px solid var(--accent);outline-offset:4px}#return-status{font-size:12px;text-align:center;margin:14px 0 0;min-height:21px}footer{text-align:center;font-size:12px}
</style></head><body><header><strong>TeamSwarm</strong><span>${zh ? "模型连接" : "Model connection"}</span></header>
<main><div class="status" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${input.complete ? '<path d="m5 12 4 4 10-10"/>' : '<path d="M12 7v6m0 4h.01"/>'}</svg></div><h1>${title}</h1><p>${detail}</p>
${input.complete && input.email ? `<div class="account"><span>${zh ? "已连接的账号" : "Connected account"}</span><strong>${escape(input.email)}</strong></div>` : ""}
${target ? `<a class="button" id="return" href="${escape(target)}">${button}</a>` : ""}
<p id="return-status" role="status" aria-live="polite">${input.complete && target ? ready : zh ? "可以关闭此窗口。" : "You can close this window."}</p></main><footer>TeamSwarm</footer>
<script nonce="${nonce}">
const c=${config};const status=document.getElementById('return-status');
history.replaceState(null,'','/auth/result?receipt='+encodeURIComponent(c.receipt));
const target=c.presentation?.returnUrl;const origin=target?new URL(target).origin:null;let acknowledged=false;let fallback;
window.addEventListener('message',event=>{if(event.origin===origin&&event.source===window.opener&&event.data?.type==='teamswarm:chatgpt-login-received'&&event.data.id===c.id){acknowledged=true;clearTimeout(fallback);window.close();}});
function navigate(){const url=new URL(target);url.searchParams.set('chatgpt_sign_in',c.id);location.replace(url.href);}
async function back(){if(!target)return;status.textContent=c.returning;
 if(c.presentation.desktop){try{const r=await fetch('/auth/return?receipt='+encodeURIComponent(c.receipt),{method:'POST'});if(!r.ok)throw new Error('return');status.textContent=${JSON.stringify(zh ? "已返回 TeamSwarm，可以关闭此页。" : "Returned to TeamSwarm. You can close this page.")};}catch{status.textContent=${JSON.stringify(zh ? "请切换到 TeamSwarm 窗口继续。" : "Switch to the TeamSwarm window to continue.")};}return;}
 if(!acknowledged&&window.opener&&!window.opener.closed){try{window.opener.postMessage({type:'teamswarm:chatgpt-login',id:c.id},origin);window.opener.focus();clearTimeout(fallback);fallback=setTimeout(()=>{if(!acknowledged)navigate();},1500);return;}catch{}}
 navigate();
}
document.getElementById('return')?.addEventListener('click',event=>{event.preventDefault();void back();});
if(c.complete&&target)setTimeout(()=>void back(),1200);
</script></body></html>`,
  };
}
