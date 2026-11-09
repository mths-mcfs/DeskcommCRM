import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Destino from "@/lib/automation/outbound-ip";
import type * as Transporte from "@/lib/channels/uazapi/transporte";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/automation/outbound-ip", async (original) => {
  const real = await original<typeof Destino>();
  // DNS de mentira: todo nome resolve para um IP público.
  return { ...real, assertDestinoResolvidoSeguro: vi.fn(async () => undefined) };
});

/** O transporte de verdade abre socket; aqui ele delega ao `fetch` do teste (a guarda dele tem teste próprio). */
vi.mock("@/lib/channels/uazapi/transporte", async (original) => ({
  ...(await original<typeof Transporte>()),
  requisitar: (url: URL, pedido: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
    fetch(url, { method: pedido.method, headers: pedido.headers, body: pedido.body, signal: pedido.signal, redirect: "manual" }),
}));
import { FALHA_AO_FALAR_COM_O_SERVIDOR, conectarInstanciaPropria } from "@/lib/channels/instancia-propria";
import { gravarEstadoDaSessao } from "@/lib/channels/uazapi/session";

/**
 * O número da conexão segue o aparelho pareado AGORA, e a tela de conexão não
 * deixa a URL virar sonda de rede: o que falha ao falar com o servidor diz
 * sempre a mesma coisa.
 */

interface Escrita {
  campos: Record<string, unknown>;
}

function adminDaSessao(linha: { status: string | null; phone_number: string | null }, falhaNoNumero?: { code: string; message: string }) {
  const escritas: Escrita[] = [];
  const admin = {
    from: () => {
      let atualizacao: Record<string, unknown> | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cadeia: any = {
        select: () => cadeia,
        update: (campos: Record<string, unknown>) => {
          atualizacao = campos;
          escritas.push({ campos });
          return cadeia;
        },
        eq: () => cadeia,
        maybeSingle: async () => ({ data: linha, error: null }),
        then: (ok: (v: unknown) => unknown) => {
          const erro = atualizacao && "phone_number" in atualizacao ? (falhaNoNumero ?? null) : null;
          return Promise.resolve({ error: erro }).then(ok);
        },
      };
      return cadeia;
    },
  } as unknown as SupabaseClient;
  return { admin, escritas };
}

const ALVO = { organizationId: "org-1", channelSessionId: "sess-1" };

describe("número da conexão", () => {
  it("outro aparelho pareado na mesma instância: o número passa a ser o dele", async () => {
    const { admin, escritas } = adminDaSessao({ status: "WORKING", phone_number: "+5511900000001" });
    const r = await gravarEstadoDaSessao(admin, { ...ALVO, estado: "connected", numero: "5511900000002" });
    expect(r).toEqual({ anterior: "WORKING", atual: "WORKING", phoneNumber: "+5511900000002" });
    expect(escritas.map((e) => e.campos)).toEqual([{ phone_number: "+5511900000002" }]);
  });

  it("primeiro número, junto com a mudança de status", async () => {
    const { admin, escritas } = adminDaSessao({ status: "SCAN_QR_CODE", phone_number: null });
    const r = await gravarEstadoDaSessao(admin, { ...ALVO, estado: "connected", numero: "5511900000003" });
    expect(r.phoneNumber).toBe("+5511900000003");
    expect(escritas[0]!.campos).toMatchObject({ status: "WORKING" });
    expect(escritas[1]!.campos).toEqual({ phone_number: "+5511900000003" });
  });

  it("mesmo número, mesmo status: nada é escrito", async () => {
    const { admin, escritas } = adminDaSessao({ status: "WORKING", phone_number: "+5511900000001" });
    await gravarEstadoDaSessao(admin, { ...ALVO, estado: "connected", numero: "5511900000001" });
    expect(escritas).toEqual([]);
  });

  it("sem número no relato (aparelho caiu): o anterior fica", async () => {
    const { admin, escritas } = adminDaSessao({ status: "WORKING", phone_number: "+5511900000001" });
    const r = await gravarEstadoDaSessao(admin, { ...ALVO, estado: "disconnected", numero: null });
    expect(r).toEqual({ anterior: "WORKING", atual: "STOPPED", phoneNumber: "+5511900000001" });
    expect(escritas.map((e) => Object.keys(e.campos))).toEqual([["status", "last_status_change_at"]]);
  });

  it("número que já é de outra conexão da organização: o status é gravado, o número antigo fica", async () => {
    const { admin, escritas } = adminDaSessao(
      { status: "SCAN_QR_CODE", phone_number: "+5511900000001" },
      { code: "23505", message: 'duplicate key value violates unique constraint "channel_sessions_phone_per_org_unique"' },
    );
    const r = await gravarEstadoDaSessao(admin, { ...ALVO, estado: "connected", numero: "5511900000009" });
    expect(r).toEqual({ anterior: "SCAN_QR_CODE", atual: "WORKING", phoneNumber: "+5511900000001" });
    expect(escritas[0]!.campos).toMatchObject({ status: "WORKING" });
  });

  it("outra falha ao gravar o número sobe", async () => {
    const { admin } = adminDaSessao({ status: "WORKING", phone_number: null }, { code: "XX000", message: "caiu" });
    await expect(gravarEstadoDaSessao(admin, { ...ALVO, estado: "connected", numero: "5511900000004" })).rejects.toThrow(
      /uazapi_session_update_failed/,
    );
  });
});

describe("conectar: a URL não vira sonda de rede", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const admin = {} as SupabaseClient;
  const entrada = {
    organizationId: "org-1",
    token: "tok-instancia-123456",
    webhookBase: "https://crm.example.test",
    userId: "u-1",
    requestId: "r-1",
  };

  beforeEach(() => {
    vi.stubEnv("UAZAPI_ALLOW_INSECURE_HTTP", "");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("endereço interno é recusado antes de qualquer chamada", async () => {
    for (const baseUrl of ["https://127.0.0.1:8443", "https://10.0.0.5", "https://[::1]", "https://169.254.169.254", "https://localhost:54321"]) {
      const r = await conectarInstanciaPropria(admin, { ...entrada, baseUrl });
      expect(r).toMatchObject({ ok: false, status: 422, motivo: "A URL do servidor não pode apontar para um endereço interno." });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rede caída, porta que não é a API, 404, 500 e redirect dizem a MESMA coisa", async () => {
    const respostas: Array<() => Promise<Response>> = [
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => new Response("<html>nginx</html>", { status: 200 }),
      async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
      async () => new Response(null, { status: 302, headers: { location: "https://x.test" } }),
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    const motivos = new Set<string>();
    for (const responder of respostas) {
      fetchMock.mockImplementationOnce(responder);
      const r = await conectarInstanciaPropria(admin, { ...entrada, baseUrl: "https://srv.example.test" });
      expect(r.ok).toBe(false);
      if (!r.ok) motivos.add(r.motivo);
    }
    expect([...motivos]).toEqual([FALHA_AO_FALAR_COM_O_SERVIDOR]);
  });

  it("token recusado continua com texto próprio — é o que a pessoa corrige", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 }));
    const r = await conectarInstanciaPropria(admin, { ...entrada, baseUrl: "https://srv.example.test" });
    expect(r).toMatchObject({ ok: false, motivo: "O servidor recusou o token da instância." });
  });
});
