import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as CredenciaisUazapi from "@/lib/channels/uazapi/credentials";

vi.mock("@/lib/waha/ingest", () => ({ dispatchWahaEvent: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: vi.fn(async () => "sem_mudanca") }));
vi.mock("@/lib/channels/uazapi/credentials", async (original) => ({
  ...(await original<typeof CredenciaisUazapi>()),
  resolveUazapiCredsDaSessao: vi.fn(async () => ({
    channelSessionId: "sess-1",
    instance: "minha-instancia",
    baseUrl: "https://srv.example.test",
    token: "tok-instancia-123456",
  })),
}));
vi.mock("@/lib/channels/uazapi/session", () => ({
  gravarEstadoDaSessao: vi.fn(async () => ({ anterior: "WORKING", atual: "STOPPED", phoneNumber: "+5511999999999" })),
}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { uazapiAdapter } from "@/lib/channels/adapters/uazapi";
import { sincronizarSaudeDaConexao } from "@/lib/channels/health";
import { ingestUazapiEvento, payloadDaMensagem } from "@/lib/channels/uazapi/ingest";
import { gravarEstadoDaSessao } from "@/lib/channels/uazapi/session";
import type { MensagemUazapi } from "@/lib/channels/uazapi/webhook";
import { dispatchWahaEvent } from "@/lib/waha/ingest";
import type * as WahaIngest from "@/lib/waha/ingest";
import { bareWaMessageId } from "@/lib/waha/message-id";

/**
 * A ingestão da UAZAPI TRADUZ para a ingestão do outro número por QR. O que
 * este arquivo prova é a costura: as formas de id que cada lado grava, o
 * telefone real do `@lid`, a marca da mídia e o roteamento de cada evento.
 */
const admin = {} as SupabaseClient;
const SESSAO = { id: "sess-1", organization_id: "org-1", display_name: "Loja", phone_number: "+5511999999999" };

function msg(over: Partial<MensagemUazapi> = {}): MensagemUazapi {
  return {
    id: "3EB0AAA",
    chatId: "5511888888888@s.whatsapp.net",
    fromMe: false,
    telefoneAlternativo: null,
    nome: "Cliente",
    texto: "oi",
    tipo: "chat",
    temMidia: false,
    mime: null,
    nomeDoArquivo: null,
    timestamp: 1788868800000,
    citadaId: null,
    localizacao: null,
    vcard: null,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(dispatchWahaEvent).mockClear();
  vi.mocked(sincronizarSaudeDaConexao).mockClear();
  vi.mocked(gravarEstadoDaSessao).mockClear();
});

describe("payload traduzido", () => {
  it("recebida grava o id composto; a do celular grava a cauda — a mesma que o envio grava", async () => {
    const { externalIdDeEntrada: entrada, externalIdDeSaida: saida } =
      await vi.importActual<typeof WahaIngest>("@/lib/waha/ingest");
    const recebida = payloadDaMensagem(msg());
    expect(recebida.id).toBe("false_5511888888888@s.whatsapp.net_3EB0AAA");
    expect(recebida.from).toBe("5511888888888@s.whatsapp.net");
    expect(entrada(recebida)).toBe("false_5511888888888@s.whatsapp.net_3EB0AAA");

    const doCelular = payloadDaMensagem(msg({ fromMe: true, nome: null }));
    expect(doCelular.to).toBe("5511888888888@s.whatsapp.net");
    expect(doCelular.fromMe).toBe(true);
    // O envio grava o `messageid` (`3EB0AAA`): o eco do celular casa com ele.
    expect(saida(doCelular)).toBe("3EB0AAA");
    expect(bareWaMessageId(recebida.id ?? "")).toBe("3EB0AAA");
  });

  it("o telefone real do @lid vai onde a ingestão o procura", async () => {
    const real = await vi.importActual<typeof WahaIngest>("@/lib/waha/ingest");
    const p = payloadDaMensagem(
      msg({ chatId: "123456789012345@lid", telefoneAlternativo: "5511888888888@s.whatsapp.net" }),
    );
    expect(real.parseChatId(p.from ?? "")).toEqual({ kind: "lid", phone: null, lid: "123456789012345" });
    expect(real.telefoneAlternativoDe(p)).toBe("+5511888888888");
  });

  it("mídia leva a marca com o id e o tipo do WhatsApp", async () => {
    const real = await vi.importActual<typeof WahaIngest>("@/lib/waha/ingest");
    const p = payloadDaMensagem(
      msg({ tipo: "ptt", temMidia: true, mime: "audio/ogg", texto: null, id: "3EB0VOZ" }),
    );
    expect(real.mediaUrlOf(p)).toBe("uazapi-midia:3EB0VOZ");
    expect(real.resolveMessageType(p)).toBe("audio");
    expect(p.hasMedia).toBe(true);

    const doc = payloadDaMensagem(
      msg({ tipo: "document", temMidia: true, mime: "application/pdf", nomeDoArquivo: "c.pdf" }),
    );
    expect(real.mediaFilenameOf(doc)).toBe("c.pdf");
  });

  it("cartão de contato e pino viram o corpo que a ingestão já sabe ler", async () => {
    const real = await vi.importActual<typeof WahaIngest>("@/lib/waha/ingest");
    const cartao = payloadDaMensagem(msg({ tipo: "vcard", vcard: "BEGIN:VCARD\nFN:Ana\nEND:VCARD", texto: null }));
    expect(real.resolveMessageType(cartao)).toBe("contact");
    expect(real.bodyOf(cartao)).toContain("FN:Ana");

    const pino = payloadDaMensagem(
      msg({ tipo: "location", texto: null, localizacao: { latitude: -23.5, longitude: -46.6, name: "Loja", address: null } }),
    );
    expect(real.resolveMessageType(pino)).toBe("location");
    expect(real.localizacaoDoPayload(pino)).toMatchObject({ latitude: -23.5, longitude: -46.6 });
  });
});

describe("roteamento dos eventos", () => {
  it("mensagem vai para a ingestão de número por QR como `message`, sem sessão do outro transporte", async () => {
    const r = await ingestUazapiEvento(admin, SESSAO, { tipo: "mensagem", mensagem: msg() }, "req-1");
    expect(r).toEqual({ status: "mensagem", direcao: "recebida" });
    const [, linha, envelope, requestId] = vi.mocked(dispatchWahaEvent).mock.calls[0]!;
    expect(linha).toMatchObject({ id: "sess-1", organization_id: "org-1", waha_session_name: null });
    expect(envelope.event).toBe("message");
    expect(envelope.payload?.id).toBe("false_5511888888888@s.whatsapp.net_3EB0AAA");
    expect(requestId).toBe("req-1");
  });

  it("o `#on`/`#off` do celular é apagado pelo contrato do adapter deste canal", async () => {
    await ingestUazapiEvento(admin, SESSAO, { tipo: "mensagem", mensagem: msg({ fromMe: true, texto: "#off" }) }, "req-c");
    const [, linha] = vi.mocked(dispatchWahaEvent).mock.calls[0]!;
    expect(linha.revogarNoCanal).toBeTypeOf("function");

    const revogar = vi.spyOn(uazapiAdapter, "revokeMessage").mockResolvedValue(undefined);
    await linha.revogarNoCanal?.({
      chatId: "5511888888888@s.whatsapp.net",
      messageId: "true_5511888888888@s.whatsapp.net_3EB0AAA",
    });
    expect(revogar).toHaveBeenCalledWith({
      organizationId: "org-1",
      sessionRef: "minha-instancia",
      recipient: "5511888888888@s.whatsapp.net",
      externalId: "true_5511888888888@s.whatsapp.net_3EB0AAA",
    });
    revogar.mockRestore();
  });

  it("recibo vira um `message.ack` por id, com o ack na régua de sempre", async () => {
    const r = await ingestUazapiEvento(admin, SESSAO, { tipo: "recibo", ids: ["A", "B"], ack: 3 }, "req-2");
    expect(r).toEqual({ status: "recibo", mensagens: 2 });
    const envelopes = vi.mocked(dispatchWahaEvent).mock.calls.map((c) => c[2]);
    expect(envelopes).toEqual([
      { event: "message.ack", payload: { id: "A", ack: 3 } },
      { event: "message.ack", payload: { id: "B", ack: 3 } },
    ]);
  });

  it("conexão grava o status e passa pelo vigia como empurrão do provedor", async () => {
    const r = await ingestUazapiEvento(
      admin,
      SESSAO,
      { tipo: "conexao", estado: "disconnected", motivo: "loggedOut", numero: null },
      "req-3",
    );
    expect(r).toEqual({ status: "conexao", canal: "STOPPED", aviso: "sem_mudanca" });
    expect(vi.mocked(gravarEstadoDaSessao)).toHaveBeenCalledWith(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      estado: "disconnected",
      numero: null,
    });
    const [, sessao, saude, apelido, origem] = vi.mocked(sincronizarSaudeDaConexao).mock.calls[0]!;
    expect(sessao).toMatchObject({ id: "sess-1", status: "STOPPED", phone_number: "+5511999999999" });
    expect(saude).toEqual({ reachable: true, status: "STOPPED", detail: "loggedOut" });
    expect(apelido).toBe("Loja");
    expect(origem).toBe("empurrao");
    expect(dispatchWahaEvent).not.toHaveBeenCalled();
  });

  it("evento ignorado não escreve nada", async () => {
    const r = await ingestUazapiEvento(admin, SESSAO, { tipo: "ignorado", motivo: "grupo_ou_lista" }, "req-4");
    expect(r).toEqual({ status: "ignored", reason: "grupo_ou_lista" });
    expect(dispatchWahaEvent).not.toHaveBeenCalled();
    expect(gravarEstadoDaSessao).not.toHaveBeenCalled();
  });
});

