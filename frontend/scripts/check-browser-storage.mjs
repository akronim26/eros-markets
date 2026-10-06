// Run against a production preview and Chrome started with --remote-debugging-port=9232.
// Uses a new tab, closes only that tab, and never logs in or signs a transaction.
// node scripts/check-browser-storage.mjs [http://localhost:3100] [9232]
import assert from "node:assert/strict";

const base = process.argv[2] || "http://localhost:3100";
const debug = `http://127.0.0.1:${process.argv[3] || "9232"}`;
const target = await (await fetch(`${debug}/json/new?about:blank`, { method: "PUT" })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map(), errors = [];
let id = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const request = ++id;
      const timer = setTimeout(() => { pending.delete(request); reject(new Error(`Timed out: ${method}`)); }, 20000);
      pending.set(request, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: request, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  async function until(expression, description) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await pause(250);
    }
    throw new Error(`Timed out: ${description}`);
  }
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: base });
  await until(`document.querySelector('header button[aria-haspopup="dialog"]')?.disabled === false`, "configured Privy login must become available before testing");
  const injection = await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage disabled for regression test','SecurityError')}});`,
  });
  await send("Page.reload");
  await until(`document.body.innerText.includes('Wallet login needs browser storage')`, "storage restriction explanation");
  assert.ok(await evaluate(`!!document.querySelector('main h1') && document.styleSheets.length > 0`));
  assert.ok(await evaluate(`document.querySelector('header button[aria-haspopup="dialog"]').disabled`));
  await until(`!!document.querySelector('#cookie-title')`, "cookie notice must still mount");
  await evaluate(`Array.from(document.querySelectorAll('aside button')).find(x=>x.textContent==='Got it').click()`);
  await until(`!document.querySelector('#cookie-title')`, "cookie notice dismisses without storage");
  await evaluate(`document.querySelector('button[aria-label^="Theme:"]').click()`);
  await evaluate(`Array.from(document.querySelectorAll('[role=menuitemradio]')).find(x=>x.textContent.trim()==='Dark').click()`);
  await until(`document.documentElement.dataset.theme === 'dark'`, "theme remains interactive without storage");
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injection.identifier });
  await send("Page.reload");
  await until(`document.querySelector('header button[aria-haspopup="dialog"]')?.disabled === false`, "login recovers after restoring storage");
  assert.deepEqual(errors, [], "No browser runtime exceptions");
  console.log("PASS: blocked storage preserves public UI, notice dismissal and theme controls; wallet login recovers after reload.");
} finally {
  socket.close();
  for (const call of pending.values()) clearTimeout(call.timer);
  await fetch(`${debug}/json/close/${target.id}`);
}
