import { createServer } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";

// Observe response identity/usage without storing generated text or private reasoning.
export function responseMetadata(bytes, contentType) {
  const text = bytes.toString("utf8");
  const packets = contentType.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
    : [text];
  const models = new Set(), ids = new Set(), finishReasons = new Set();
  let usage, protocolCompleted = false;
  for (const packet of packets) {
    if (packet === "[DONE]") continue;
    let value;
    try { value = JSON.parse(packet); } catch { continue; }
    const message = value.response ?? value.message ?? value;
    if (value.type === "response.completed" || value.type === "message_stop") protocolCompleted = true;
    if (typeof message.model === "string") models.add(message.model);
    if (typeof message.id === "string") ids.add(message.id);
    if (message.usage) {
      // Provider usage schemas contain numbers and nested numeric details only.
      const numeric = (v) => typeof v === "number" ? v : v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "number" || (n && typeof n === "object")).map(([k,n]) => [k, numeric(n)])) : undefined;
      usage = { ...usage, ...numeric(message.usage) };
    }
    for (const choice of message.choices ?? [])
      if (typeof choice.finish_reason === "string") finishReasons.add(choice.finish_reason);
  }
  return { models: [...models], responseIds: [...ids], finishReasons: [...finishReasons], protocolCompleted, ...(usage ? {usage} : {}) };
}

/** Test-only pass-through meter. No protocol translation or simulated response. */
export async function testGateway(
  origin,
  model,
  credential,
  report,
  limits = {},
) {
  const endpoint = new URL(origin);
  if (
    endpoint.protocol !== "https:" ||
    ![
      "llm-vpu4ekl94fez48uz.cn-beijing.maas.aliyuncs.com",
      "api.deepseek.com",
    ].includes(endpoint.hostname)
  )
    throw new Error(
      "Use the authorized Bailian workspace or official DeepSeek endpoint.",
    );
  const requests = limits.previous?.requests ?? [];
  const credentials = [credential, ...(limits.fallbackCredentials ?? [])];
  let credentialSlot = Math.min(
    limits.previous?.credentialSlot ?? 0,
    credentials.length - 1,
  );
  let calls = requests.filter((r) => !r.rejected).length,
    reserved = limits.previous?.reserved ?? 0;
  const record = () => report({ requests, reserved, credentialSlot });
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    let timeout = setTimeout(
      () => controller.abort(),
      limits.timeoutMs ?? 180000,
    );
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    let info;
    const responseChunks = [], responseHash = createHash("sha256");
    let responseBytes = 0, contentType = "";
    const observeResponse = () => {
      if (!info) return;
      info.responseBytes = responseBytes;
      if (responseBytes <= 2000000) info.response = responseMetadata(Buffer.concat(responseChunks), contentType);
    };
    const error = (status, message) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "budget_limit", message } }));
    };
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2000000) return error(413, "Test request too large");
        chunks.push(chunk);
      }
      const route = (req.url ?? "").split("?")[0];
      if (limits.requireNativeCredential && req.headers.authorization !== `Bearer ${credential}` && req.headers["x-api-key"] !== credential)
        return error(401, "Native harness did not supply the configured API credential");
      if (
        !new Set([
          "/compatible-mode/v1/responses",
          "/compatible-mode/v1/chat/completions",
          "/apps/anthropic/v1/messages",
          "/chat/completions",
          "/responses",
          "/v1/chat/completions",
          "/v1/responses",
          "/anthropic/v1/messages",
        ]).has(route) ||
        req.method !== "POST"
      ) {
        requests.push({route, method:req.method, rejected:true, reason:"unexpected_endpoint"}); record();
        return error(403, "Unexpected endpoint");
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const sizes = Object.fromEntries(
        Object.entries(body).map(([k, v]) => [
          k,
          Buffer.byteLength(JSON.stringify(v)),
        ]),
      );
      if (bytes > (limits.maxInputBytes ?? 200000)) {
        requests.push({
          route,
          model: body.model,
          inputBytes: bytes,
          rejected: true,
          sizes,
        });
        record();
        return error(413, "Test request too large");
      }
      if (body.model !== model)
        return error(403, "Model outside this test's authorized selection");
      const outputCap = limits.maxOutputTokens ?? 4096;
      // Bytes are a deliberately conservative input reservation, not reported token usage.
      if (
        ++calls > (limits.maxRequests ?? 12) ||
        reserved + bytes + outputCap > (limits.maxReserved ?? 500000)
      )
        return error(429, "Bounded test request budget exhausted");
      reserved += bytes + outputCap;
      const cap = route.endsWith("/responses")
        ? "max_output_tokens"
        : route.endsWith("/chat/completions") &&
            body.max_completion_tokens !== undefined
          ? "max_completion_tokens"
          : "max_tokens";
      body[cap] = Math.min(body[cap] ?? outputCap, outputCap);
      info = {
        startedAt: new Date().toISOString(),
        route,
        model,
        inputBytes: bytes,
        outputCap: body[cap],
        sizes,
        tools: (body.tools ?? []).map(
          (t) => t.name ?? t.function?.name ?? t.type,
        ),
        thinking: body.thinking,
        reasoning: body.reasoning,
        enableThinking: body.enable_thinking,
      };
      requests.push(info);
      record();
      const requestUpstream = (key) =>
        fetch(new URL(route, endpoint), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            ...(req.headers["anthropic-beta"]
              ? { "anthropic-beta": req.headers["anthropic-beta"] }
              : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      let upstream = await requestUpstream(credentials[credentialSlot]);
      info.credentialAttempts = [
        { slot: credentialSlot, status: upstream.status },
      ];
      // Only an explicit payment/balance exhaustion response permits switching.
      // Rate limits, auth failures and transport errors retain their real result.
      if (upstream.status === 402 && credentialSlot + 1 < credentials.length) {
        await upstream.body?.cancel();
        credentialSlot += 1;
        info.credentialSwitchReason = "upstream_balance_exhausted";
        record();
        upstream = await requestUpstream(credentials[credentialSlot]);
        info.credentialAttempts.push({
          slot: credentialSlot,
          status: upstream.status,
        });
      }
      info.status = upstream.status;
      info.requestId = upstream.headers.get("x-request-id") ?? upstream.headers.get("request-id") ?? upstream.headers.get("x-dashscope-request-id");
      record();
      contentType = upstream.headers.get("content-type") ?? "application/json";
      res.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      if (upstream.body)
        await pipeline(
          Readable.fromWeb(upstream.body),
          new Transform({
            transform(chunk, _encoding, callback) {
              responseBytes += chunk.length;
              responseHash.update(chunk);
              if (responseBytes <= 2000000) responseChunks.push(Buffer.from(chunk));
              clearTimeout(timeout);
              timeout = setTimeout(
                () => controller.abort(),
                limits.timeoutMs ?? 180000,
              );
              callback(null, chunk);
            },
          }),
          res,
        );
      else res.end();
      info.responseBytes = responseBytes;
      info.responseSha256 = responseHash.digest("hex");
      if (responseBytes <= 2000000)
        info.response = responseMetadata(Buffer.concat(responseChunks), upstream.headers.get("content-type") ?? "");
      if (upstream.status >= 400 && responseBytes <= 2000000)
        info.error = Buffer.concat(responseChunks).toString("utf8").split(credential).join("[redacted]").slice(0, 1500);
      info.completed = true;
      info.finishedAt = new Date().toISOString();
      record();
    } catch {
      if (info) {
        observeResponse();
        info.completed = false;
        info.interrupted = controller.signal.aborted;
        record();
      }
      if (!res.headersSent) error(502, "Test upstream unavailable");
      else res.destroy();
    } finally {
      clearTimeout(timeout);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(limits.port ?? 0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
