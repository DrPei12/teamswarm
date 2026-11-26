import { useEffect, useState, type FormEvent } from "react";
import type { McpMount } from "@team/contracts/runtime";
import { useI18n } from "./i18n";
import { api } from "./service";

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  grant?: McpMount & { active: boolean };
};
type Service = {
  id: string;
  name: string;
  url: string;
  revision: number;
  tools: Tool[];
};
type ServiceInput = {
  id?: string;
  name: string;
  url: string;
  expectedRevision: number;
};

export function McpSettings({ teamId }: { teamId?: string }) {
  const { t } = useI18n();
  const [services, setServices] = useState<Service[] | null>(null);
  const [editing, setEditing] = useState<ServiceInput | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, reload] = useState(0);
  const endpoint = teamId
    ? `/teams/${encodeURIComponent(teamId)}/mcp-services`
    : "/global/mcp-services";
  useEffect(() => {
    const controller = new AbortController();
    void api<Service[]>(endpoint, undefined, "GET", controller.signal)
      .then(setServices)
      .catch((failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [endpoint, revision]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    setError("");
    setBusy(true);
    try {
      const updated = await api<Service>(endpoint, editing);
      setServices((rows) => [
        ...(rows ?? []).filter((row) => row.id !== updated.id),
        updated,
      ]);
      setEditing(null);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function change(service: Service, tool: Tool) {
    if (!teamId || busy) return;
    setError("");
    setBusy(true);
    try {
      const grant = await api<NonNullable<Tool["grant"]>>(
        `/teams/${encodeURIComponent(teamId)}/mcp-grants`,
        {
          serviceId: service.id,
          revision: service.revision,
          tool: tool.name,
          active: !tool.grant?.active,
          expectedGeneration: tool.grant?.generation ?? 0,
        },
        "PUT",
      );
      setServices(
        (rows) =>
          rows?.map((row) =>
            row.id !== service.id
              ? row
              : {
                  ...row,
                  tools: row.tools.map((item) =>
                    item.name === tool.name ? { ...item, grant } : item,
                  ),
                },
          ) ?? null,
      );
    } catch (failure) {
      setError((failure as Error).message);
      reload((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mcp-settings">
      {teamId ? (
        <p>
          {t(
            "Authorized MCP tools can send their results to the team's selected model.",
          )}
        </p>
      ) : (
        !editing && (
          <button
            className="primary-button"
            onClick={() =>
              setEditing({
                id: crypto.randomUUID(),
                name: "",
                url: "",
                expectedRevision: 0,
              })
            }
          >
            {t("Add MCP service")}
          </button>
        )
      )}
      {editing && (
        <form
          className="mcp-service-form"
          onSubmit={(event) => void save(event)}
        >
          <label>
            {t("Service name")}
            <input
              required
              maxLength={120}
              value={editing.name}
              disabled={busy}
              onChange={(event) =>
                setEditing({ ...editing, name: event.target.value })
              }
            />
          </label>
          <label>
            {t("Streamable HTTP endpoint")}
            <input
              required
              type="url"
              maxLength={2048}
              value={editing.url}
              disabled={busy}
              onChange={(event) =>
                setEditing({ ...editing, url: event.target.value })
              }
            />
          </label>
          <div className="mcp-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              {t("Cancel")}
            </button>
            <button className="primary-button" disabled={busy}>
              {t(busy ? "Checking…" : "Discover tools")}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="form-error">
          {t(error)}
        </p>
      )}
      {services === null && !error && <p role="status">{t("Loading…")}</p>}
      {services?.length === 0 && !editing && (
        <p>{t("No MCP services registered.")}</p>
      )}
      {services?.map((service) => (
        <section key={service.id} className="mcp-service">
          <div className="mcp-heading">
            <div>
              <h3>{service.name}</h3>
              <small>{service.url}</small>
            </div>
            {!teamId && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  setEditing({
                    id: service.id,
                    name: service.name,
                    url: service.url,
                    expectedRevision: service.revision,
                  })
                }
              >
                {t("Edit")}
              </button>
            )}
          </div>
          <ul className="mcp-tool-list">
            {service.tools.map((tool) => (
              <li key={tool.name}>
                <div>
                  <strong>{tool.name}</strong>
                  {tool.description && <p>{tool.description}</p>}
                  <details>
                    <summary>{t("Input schema")}</summary>
                    <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                  </details>
                </div>
                {teamId && (
                  <button
                    className="secondary-button"
                    disabled={busy}
                    aria-pressed={!!tool.grant?.active}
                    aria-label={`${t(tool.grant?.active ? "Revoke access" : "Authorize tool")} · ${tool.name}`}
                    onClick={() => void change(service, tool)}
                  >
                    {t(tool.grant?.active ? "Revoke access" : "Authorize tool")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
