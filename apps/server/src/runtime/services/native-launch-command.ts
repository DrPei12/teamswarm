import { readFileSync } from "node:fs";
const ticket = JSON.parse(readFileSync(process.argv[2], "utf8"));
const endpoint = new URL(ticket.endpoint);
if (
  endpoint.protocol !== "http:" ||
  endpoint.hostname !== "127.0.0.1" ||
  endpoint.pathname !== "/launch"
)
  throw new Error("Invalid native service launch ticket.");
const response = await fetch(endpoint, {
  method: "POST",
  headers: { authorization: `Bearer ${ticket.token}` },
  signal: AbortSignal.timeout(150000),
});
const result = await response.json();
if (!response.ok) {
  console.error(result.error ?? "Development server could not start.");
  process.exitCode = 1;
} else console.log(JSON.stringify(result));
