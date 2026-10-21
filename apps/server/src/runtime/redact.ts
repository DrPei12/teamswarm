/** Remove configured credentials from structured observations and bounded error diagnostics. */
export function redact<T>(value: T, credentialEnv: string | null): T {
  const secrets = [
    ...new Set(
      [credentialEnv, "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
        .filter((v): v is string => !!v)
        .map((name) => process.env[name])
        .filter((v): v is string => !!v && v.length >= 8),
    ),
  ];
  const visit = (input: unknown): unknown => {
    if (typeof input === "string")
      return secrets.reduce(
        (s, secret) => s.split(secret).join("[REDACTED]"),
        input,
      );
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, visit(v)]),
      );
    return input;
  };
  return visit(value) as T;
}
