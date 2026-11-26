// Test-only: count modules actually loaded before real ACP consumes its first packet.
const fs = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
if (process.argv[1] && path.resolve(process.argv[1]) === process.env.TEAM_DEEPSEEK_HARNESS_BIN) {
  const start = Date.now(), optional = new Set();
  let loads = 0;
  const hook = registerHooks({load(url, context, next) {
    const result = next(url, context);
    loads++;
    const name = /\/(@deepseek-ai\/dsh-(?:llm-pi-ai|llm-deepseek-account|deepseek-account-platform|plugin-manager|otel|session-telemetry-otel))\/lib\//.exec(url)?.[1];
    if (name) optional.add(name);
    return result;
  }});
  // Attaching a data listener before DSH does would consume the initialize packet.
  const emit = process.stdin.emit;
  process.stdin.emit = function (event, ...args) {
    if (event === 'data') {
      process.stdin.emit = emit;
      hook.deregister();
      fs.appendFileSync(process.env.TEAM_DSH_BOOT_TRACE, JSON.stringify({pid: process.pid, start, firstInput: Date.now(), loads, optional: [...optional].sort()}) + '\n');
    }
    return emit.call(this, event, ...args);
  };
}
