/** UHP is a remote Harness task protocol, separate from the model gateway's Responses wire. */
export const UHP_VERSION = '2026-10-19';
export interface UhpResponse {
  id: string; object: 'response'; status: 'in_progress' | 'completed' | 'failed' | 'incomplete' | 'cancelled';
  model: string; metadata: { session_id: string; harness_id?: string; ignored_fields?: string[]; [key: string]: unknown };
  output: Record<string, unknown>[]; error: unknown; usage: Record<string, unknown> | null;
  previous_response_id: string | null;
}
export interface UhpTask {
  input: string | Record<string, unknown>[]; model?: string; instructions?: string;
  metadata: { harness_id: string; [key: string]: unknown }; previous_response_id?: string;
  max_output_tokens?: number; max_step?: number; timeout_seconds?: number;
}
export class UhpHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export class UhpStreamError extends Error {
  constructor(message: string, readonly responseId?: string) { super(message); }
}
/** Explicitly configured server credentials are read at request time and never forwarded to another origin. */
export class UhpClient {
  private base: string;
  constructor(endpoint: string, private credentialEnv?: string, private request: typeof fetch = fetch) {
    const u = new URL(endpoint);
    if (u.username || u.password || u.search || u.hash || !(u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('Use HTTPS or a local UHP endpoint without embedded credentials.');
    if (credentialEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnv)) throw new Error('Invalid UHP credential environment reference.');
    this.base = u.href.replace(/\/$/, '');
  }
  private async send(route: string, init: RequestInit = {}, authenticate = true) {
    const token = this.credentialEnv && process.env[this.credentialEnv];
    if (authenticate && this.credentialEnv && !token) throw new Error('UHP server credential is unavailable.');
    const headers = new Headers(init.headers); headers.set('UHP-Version', UHP_VERSION);
    if (authenticate && token) headers.set('Authorization', `Bearer ${token}`);
    const r = await this.request(this.base + route, { ...init, headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30000) });
    if (r.headers.get('UHP-Version') !== UHP_VERSION) { await r.body?.cancel(); throw new Error('UHP server did not honor the requested protocol version.'); }
    if (!r.ok) {
      const body: any = await r.json().catch(() => ({}));
      throw new UhpHttpError(r.status, String(body.error?.code ?? 'uhp_http_error'), String(body.error?.message ?? `UHP request failed (${r.status}).`));
    }
    return r;
  }
  async discover() {
    const body: any = await (await this.send('/v1/uhp', {}, false)).json();
    if (body.object !== 'uhp.discovery' || body.protocol !== 'uhp' || !body.versions?.includes(UHP_VERSION)) throw new Error('Endpoint does not support this UHP version.');
    return body as { protocol: 'uhp'; versions: string[]; capabilities: Record<string, boolean>; implementation?: { name: string; version: string } };
  }
  async harnesses(): Promise<{ id: string; base: string; name: string; [key: string]: unknown }[]> {
    const body: any = await (await this.send('/v1/harnesses')).json();
    if (!Array.isArray(body.harnesses) || body.harnesses.some((h: any) => typeof h.id !== 'string' || typeof h.base !== 'string')) throw new Error('Invalid UHP Harness inventory.');
    return body.harnesses;
  }
  async models(harnessId: string) { return (await this.send(`/v1/harnesses/${encodeURIComponent(harnessId)}/models`)).json(); }
  async response(id: string): Promise<UhpResponse> { return this.validate(await (await this.send(`/v1/responses/${encodeURIComponent(id)}`)).json()); }
  async turns(sessionId: string) { return (await this.send(`/v1/sessions/${encodeURIComponent(sessionId)}/turns`)).json(); }
  async cancel(responseId: string) { return (await this.send(`/v1/responses/${encodeURIComponent(responseId)}/cancel`, { method: 'POST' })).json(); }
  async files(sessionId: string) { return (await this.send(`/v1/sessions/${encodeURIComponent(sessionId)}/files`)).json(); }
  async upload(filename: string, bytes: Uint8Array, type = 'application/octet-stream') {
    const form = new FormData(); form.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
    return (await this.send('/v1/files', { method: 'POST', body: form })).json();
  }
  async download(containerId: string, fileId: string) { return this.send(`/v1/containers/${encodeURIComponent(containerId)}/files/${encodeURIComponent(fileId)}/content`); }
  private validate(value: any): UhpResponse {
    if (value?.object !== 'response' || typeof value.id !== 'string' || typeof value.metadata?.session_id !== 'string' || !Array.isArray(value.output) || !['in_progress','completed','failed','incomplete','cancelled'].includes(value.status)) throw new Error('Invalid UHP task response.');
    return value;
  }
  /** Stream gaps retain responseId for GET reconciliation; a disconnected stream never reports completion. */
  async run(task: UhpTask, onEvent: (event: Record<string, any>) => void, signal?: AbortSignal): Promise<UhpResponse> {
    const r = await this.send('/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...task, stream: true, store: true }), signal: signal ?? AbortSignal.timeout(24 * 60 * 60 * 1000) });
    if (!r.headers.get('content-type')?.includes('text/event-stream') || !r.body) throw new Error('UHP task did not return a stream.');
    let buffer = '', frame: string[] = [], sequence = 0, responseId: string | undefined, terminal: UhpResponse | undefined;
    const decoder = new TextDecoder();
    const consume = () => {
      if (!frame.length) return;
      const data = frame.join('\n'); frame = [];
      const e = JSON.parse(data);
      if (terminal || e.sequence_number !== sequence++ || sequence === 1 && e.type !== 'response.created') throw new UhpStreamError('UHP event sequence is incomplete or duplicated.', responseId);
      if (e.type === 'response.created') { const created = this.validate(e.response); responseId = created.id; }
      if (['response.completed','response.failed','response.incomplete'].includes(e.type)) {
        terminal = this.validate(e.response);
        if (terminal.id !== responseId || terminal.status === 'in_progress' || task.metadata.harness_id && terminal.metadata.harness_id && terminal.metadata.harness_id !== task.metadata.harness_id) throw new UhpStreamError('UHP terminal identity or status mismatch.', responseId);
        if (terminal.metadata.ignored_fields?.some(f => ['instructions','model','previous_response_id','metadata'].includes(f))) throw new UhpStreamError('UHP server ignored a required task field.', responseId);
      }
      onEvent(e);
    };
    try {
      for await (const chunk of r.body) {
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length + frame.reduce((n, s) => n + s.length, 0) > 8 * 1024 * 1024) throw new UhpStreamError('UHP event exceeds 8 MiB.', responseId);
        let end: number;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          if (!line) consume(); else if (line.startsWith('data:')) frame.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (frame.length || buffer.trim() || !terminal) throw new UhpStreamError('UHP stream ended without a complete terminal event.', responseId);
      return terminal;
    } catch (error) { throw error instanceof UhpStreamError ? error : new UhpStreamError((error as Error).message, responseId); }
  }
}
