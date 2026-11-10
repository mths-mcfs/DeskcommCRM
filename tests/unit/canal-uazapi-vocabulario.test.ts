import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAdapter } from "@/lib/channels";
import {
  CHANNEL_PROVIDER_UAZAPI,
  PROVIDERS_DE_TELEFONE,
  canalTemRiscoDeBanimento,
  capabilitiesOf,
  modoDeCampanhaDoCanal,
  transportaMensagem,
} from "@/lib/channels/capabilities";
import { acceptsInboundWebhook, verifyInboundWebhookSignature } from "@/lib/channels/inbound";
import { channelBrand } from "@/lib/channels/presentation";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { fonteDeTemplates } from "@/lib/channels/templates-fonte";
import { lerBaseUrl, modoDeTesteLocal } from "@/lib/channels/uazapi/credentials";
import { impressaoDoToken } from "@/lib/channels/uazapi/webhook";
import { nomeiaProvider } from "../../scripts/lint-channels.pattern";

/**
 * O canal UAZAPI — vocabulário e costuras do seam: o perfil de número por QR,
 * o `sessionRef`, o adapter, a porta de entrada e o par migration × baseline.
 */
const UAZAPI = "uazapi" as const;
const MIGRATION = "supabase/migrations/20261108190000_9252_canal_uazapi.sql";

describe("canal uazapi — vocabulário e seam", () => {
  it("declara o perfil auto-restrição do número por QR", () => {
    const caps = capabilitiesOf(CHANNEL_PROVIDER_UAZAPI);
    expect(caps.freeformOutsideWindow).toBe(true);
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.canManageTemplates).toBe(false);
    expect(caps.banRisk).toBe(true);
    expect(caps.costPerMessage).toBe(false);
    // Grupo é ignorado na entrada, e o adapter não edita nem lê a agenda.
    expect(caps.groups).toBe("none");
    expect(caps.alteraMensagemEnviada).toBe(false);
    expect(caps.phonebook).toBe(false);
    expect(fonteDeTemplates(UAZAPI)).toBeNull();
    expect(modoDeCampanhaDoCanal(UAZAPI)).toBe("text");
    expect(canalTemRiscoDeBanimento(UAZAPI)).toBe(true);
  });

  it("é canal de mensagem e de telefone, e aparece como WhatsApp", () => {
    expect(transportaMensagem(UAZAPI)).toBe(true);
    expect((PROVIDERS_DE_TELEFONE as readonly string[]).includes(UAZAPI)).toBe(true);
    expect(channelBrand({ provider: UAZAPI })).toBe("whatsapp");
  });

  it("o sessionRef é o nome da instância, e a coluna entra no select", () => {
    expect(resolveSessionRef({ provider: UAZAPI, uazapi_instance: "minha-instancia" })).toBe("minha-instancia");
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("uazapi_instance");
  });

  it("o adapter existe, e o lint de canal reconhece o nome nas duas grafias", () => {
    expect(getAdapter(UAZAPI).provider).toBe(UAZAPI);
    expect(nomeiaProvider("lib/channels/uazapi/client")).toBe(true);
    expect(nomeiaProvider("UAZAPI_ALLOW_INSECURE_HTTP")).toBe(true);
    expect(nomeiaProvider("createUazapiSession")).toBe(true);
  });

  it("a entrada genérica aceita o canal e confere o token do corpo contra a impressão da sessão", () => {
    expect(acceptsInboundWebhook(UAZAPI)).toBe(true);
    const impressao = impressaoDoToken("tok-da-instancia");
    const corpo = JSON.stringify({ EventType: "messages", token: "tok-da-instancia" });
    expect(verifyInboundWebhookSignature(UAZAPI, corpo, new Headers(), impressao)).toBe(true);
    const forjado = JSON.stringify({ EventType: "messages", token: "chute" });
    expect(verifyInboundWebhookSignature(UAZAPI, forjado, new Headers(), impressao)).toBe(false);
    expect(verifyInboundWebhookSignature(UAZAPI, corpo, new Headers(), null)).toBe(false);
  });

  it("migration e baseline conhecem o provider, o ramo do CHECK e o arquivo do webhook", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,600}'uazapi'::text/);
    expect(baseline).toMatch(/provider = 'uazapi'\s+and uazapi_instance\s+is not null/);
    expect(baseline).toMatch(/webhook_events_log_provider_check check \(provider in \([\s\S]{0,300}'uazapi'/);
    expect(baseline).toContain("channel_sessions_uazapi_instance_ativo_unique");
    // A chave que não depende do host: a impressão do token, única entre os ativos.
    expect(baseline).toMatch(
      /channel_sessions_uazapi_token_ativo_unique\s+on public\.channel_sessions \(uazapi_token_fingerprint\)\s+where archived_at is null and uazapi_token_fingerprint is not null/,
    );
    expect(baseline).toContain("add column if not exists uazapi_token_fingerprint text");
    // Colunas ANTES do CHECK que as referencia — senão o install quebra.
    expect(baseline.indexOf("add column if not exists uazapi_instance")).toBeLessThan(
      baseline.indexOf("(provider = 'uazapi'"),
    );

    const mig = readFileSync(MIGRATION, "utf8");
    expect(mig).toMatch(/^-- manifest: /);
    expect(mig).toContain("add column if not exists uazapi_instance");
    expect(mig).toContain("add column if not exists uazapi_token_fingerprint text");
    expect(mig).toContain("channel_sessions_uazapi_token_ativo_unique");
    expect(mig).toMatch(/provider = 'uazapi' and uazapi_instance is not null/);
    // O alargamento mantém os provedores de cobrança da 0601.
    expect(mig).toMatch(/'uazapi',\s+'stripe', 'asaas'/);
  });
});

describe("canal uazapi — URL do servidor", () => {
  // Hermético: o setup do vitest carrega o `.env.local`, e a máquina de quem
  // desenvolve pode ter o modo de teste local ligado.
  beforeEach(() => {
    vi.stubEnv("UAZAPI_ALLOW_INSECURE_HTTP", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sem opção explícita, a leitura segue a env da instalação", () => {
    expect(modoDeTesteLocal()).toBe(false);
    expect(lerBaseUrl("http://127.0.0.1:8080").ok).toBe(false);
    vi.stubEnv("UAZAPI_ALLOW_INSECURE_HTTP", "true");
    expect(modoDeTesteLocal()).toBe(true);
    expect(lerBaseUrl("http://127.0.0.1:8080")).toEqual({ ok: true, baseUrl: "http://127.0.0.1:8080" });
  });

  it("o host sai normalizado: minúsculas, sem ponto final, sem porta padrão", () => {
    for (const bruto of [
      "https://free.uazapi.com.",
      "https://FREE.UAZAPI.COM/",
      "https://free.uazapi.com.:443",
      "https://free.uazapi.com:443/",
    ]) {
      expect(lerBaseUrl(bruto, { testeLocal: false }), bruto).toEqual({ ok: true, baseUrl: "https://free.uazapi.com" });
    }
    expect(lerBaseUrl("https://srv.example.test:8443/uaz/", { testeLocal: false })).toEqual({
      ok: true,
      baseUrl: "https://srv.example.test:8443/uaz",
    });
    expect(lerBaseUrl("https://localhost./", { testeLocal: false }).ok).toBe(false);
  });

  it("normaliza: https, sem barra no fim, caminho preservado", () => {
    expect(lerBaseUrl("  https://free.uazapi.com/  ", { testeLocal: false })).toEqual({
      ok: true,
      baseUrl: "https://free.uazapi.com",
    });
    expect(lerBaseUrl("https://proxy.exemplo.com/uaz/", { testeLocal: false })).toEqual({
      ok: true,
      baseUrl: "https://proxy.exemplo.com/uaz",
    });
  });

  it("recusa http sem a exceção, credencial embutida, query, fragmento e lixo", () => {
    expect(lerBaseUrl("http://127.0.0.1:8080", { testeLocal: false }).ok).toBe(false);
    expect(lerBaseUrl("http://127.0.0.1:8080", { testeLocal: true })).toEqual({
      ok: true,
      baseUrl: "http://127.0.0.1:8080",
    });
    expect(lerBaseUrl("https://u:p@srv.test", { testeLocal: false }).ok).toBe(false);
    expect(lerBaseUrl("https://srv.test/?a=1", { testeLocal: false }).ok).toBe(false);
    expect(lerBaseUrl("https://srv.test/#x", { testeLocal: false }).ok).toBe(false);
    expect(lerBaseUrl("ftp://srv.test", { testeLocal: true }).ok).toBe(false);
    expect(lerBaseUrl("não é url", { testeLocal: false }).ok).toBe(false);
    expect(lerBaseUrl("", { testeLocal: false }).ok).toBe(false);
  });

  it("recusa endereço interno — loopback, rede privada, link-local, metadata e IPv6 — fora do teste local", () => {
    const internos = [
      "https://127.0.0.1:8443",
      "https://10.0.0.5",
      "https://172.17.0.2",
      "https://192.168.1.10",
      "https://169.254.169.254",
      "https://100.64.0.1",
      "https://0.0.0.0",
      "https://[::1]",
      "https://[fd00::1]",
      "https://[fe80::1]",
      "https://[::ffff:127.0.0.1]",
      "https://localhost:54321/rest/v1",
      "https://api.localhost",
      // Formas numéricas que o `new URL` normaliza para 127.0.0.1.
      "https://2130706433",
      "https://0x7f.0.0.1",
    ];
    for (const u of internos) {
      expect(lerBaseUrl(u, { testeLocal: false }), u).toEqual({
        ok: false,
        motivo: "A URL do servidor não pode apontar para um endereço interno.",
      });
      expect(lerBaseUrl(u, { testeLocal: true }).ok, u).toBe(true);
    }
    expect(lerBaseUrl("https://8.8.8.8", { testeLocal: false }).ok).toBe(true);
    expect(lerBaseUrl("https://user:senha@srv.test", { testeLocal: true }).ok).toBe(false);
  });

  it("o modo de teste local só liga com `true` literal", () => {
    expect(modoDeTesteLocal("true")).toBe(true);
    expect(modoDeTesteLocal(" TRUE ")).toBe(true);
    expect(modoDeTesteLocal("1")).toBe(false);
    expect(modoDeTesteLocal("")).toBe(false);
    expect(modoDeTesteLocal(undefined)).toBe(false);
  });
});
