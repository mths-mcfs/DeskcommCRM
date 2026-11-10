/**
 * A mesma instância não conecta em duas organizações — venha pelo host que vier.
 *
 * O índice antigo era (servidor, instância): `https://free.uazapi.com.` (ponto
 * final) ou um alias de DNS do mesmo servidor davam outra chave, e a org B,
 * com o token da org A, conectava e desviava o webhook da A em silêncio. A
 * chave que segura é a impressão do token (`uazapi_token_fingerprint`): ela
 * não depende do host. Aqui: a impressão gravada é a do token, o conflito no
 * índice dela vira 409, e o webhook de ninguém é tocado.
 */
import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Destino from "@/lib/automation/outbound-ip";
import type * as Transporte from "@/lib/channels/uazapi/transporte";

const h = vi.hoisted(() => ({
  salvar: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/automation/outbound-ip", async (original) => ({
  ...(await original<typeof Destino>()),
  assertDestinoResolvidoSeguro: vi.fn(async () => undefined),
}));
vi.mock("@/lib/channels/uazapi/transporte", async (original) => ({
  ...(await original<typeof Transporte>()),
  requisitar: (url: URL, pedido: { method: string; headers?: Record<string, string>; body?: string }) =>
    fetch(url, { method: pedido.method, headers: pedido.headers, body: pedido.body, redirect: "manual" }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn(async (_a: unknown, v: string) => `cifrado(${v.length})`) }));
vi.mock("@/lib/channels/uazapi/session", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  findUazapiSession: vi.fn(async () => null),
  saveUazapiSession: h.salvar,
}));

import { conectarInstanciaPropria } from "@/lib/channels/instancia-propria";

const TOKEN = "token-da-instancia-da-org-a";
const fetchMock = vi.fn<typeof fetch>();

function statusConectado(): Response {
  return new Response(
    JSON.stringify({ instance: { name: "loja", status: "connected", owner: "5511900000000" }, status: { connected: true } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  vi.stubEnv("UAZAPI_ALLOW_INSECURE_HTTP", "");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  h.salvar.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function conectarComo(baseUrl: string) {
  return conectarInstanciaPropria({} as SupabaseClient, {
    organizationId: "org-b",
    baseUrl,
    token: TOKEN,
    webhookBase: "https://crm.example.test",
    userId: "u-b",
    requestId: "r-b",
  });
}

describe("mesma instância em duas contas", () => {
  it("grava a impressão SHA-256 do token — a mesma pelo host que vier", async () => {
    h.salvar.mockResolvedValue({ error: "falha qualquer", channelSessionId: null });
    for (const host of ["https://free.uazapi.com", "https://free.uazapi.com.", "https://dc02.uazapi.com"]) {
      fetchMock.mockImplementationOnce(async () => statusConectado());
      await conectarComo(host);
    }
    const impressoes = h.salvar.mock.calls.map((c) => (c[1] as { impressao: string }).impressao);
    expect(new Set(impressoes)).toEqual(new Set([createHash("sha256").update(TOKEN).digest("hex")]));
    // O ponto final sai antes de gravar.
    expect((h.salvar.mock.calls[1]![1] as { baseUrl: string }).baseUrl).toBe("https://free.uazapi.com");
  });

  it("conflito no índice da impressão: 409, e o webhook da outra conta não é reapontado", async () => {
    fetchMock.mockImplementationOnce(async () => statusConectado());
    h.salvar.mockResolvedValue({
      error: 'duplicate key value violates unique constraint "channel_sessions_uazapi_token_ativo_unique"',
      channelSessionId: null,
    });
    const r = await conectarComo("https://dc02.uazapi.com");
    expect(r).toEqual({
      ok: false,
      status: 409,
      code: "state_conflict",
      motivo: "Esta instância já está conectada em outra conta deste sistema.",
    });
    // Só o `/instance/status`: nenhum `POST /webhook`.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://dc02.uazapi.com/instance/status");
  });

  it("conflito no par (servidor, instância) também é 409", async () => {
    fetchMock.mockImplementationOnce(async () => statusConectado());
    h.salvar.mockResolvedValue({
      error: 'duplicate key value violates unique constraint "channel_sessions_uazapi_instance_ativo_unique"',
      channelSessionId: null,
    });
    expect(await conectarComo("https://free.uazapi.com")).toMatchObject({ ok: false, status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
