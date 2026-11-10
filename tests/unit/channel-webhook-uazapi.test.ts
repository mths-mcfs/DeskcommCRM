import { describe, expect, it } from "vitest";

import {
  eventoDoEnvelope,
  impressaoDoToken,
  idDaMidiaGravada,
  lerEnvelopeUazapi,
  tokenDoCorpoConfere,
  type EventoUazapi,
} from "@/lib/channels/uazapi/webhook";

/**
 * O parser do webhook da UAZAPI — puro: corpo cru → evento do domínio. Os
 * payloads seguem a doc oficial (`docs.uazapi.com`, webhooks `messages`,
 * `messages_update`, `connection`) e as fixtures do app que já está em produção
 * com este provedor.
 */
const RAIZ = {
  owner: "5511999999999",
  token: "INSTANCE_TOKEN",
  BaseUrl: "https://srv.example.test",
  instanceName: "Atendimento",
};

function evento(corpo: Record<string, unknown>): EventoUazapi {
  const leitura = lerEnvelopeUazapi(JSON.stringify({ ...RAIZ, ...corpo }));
  if (!leitura.ok) throw new Error(`não leu: ${JSON.stringify(leitura)}`);
  return eventoDoEnvelope(leitura.envelope);
}

function mensagem(m: Record<string, unknown>, extra: Record<string, unknown> = {}): EventoUazapi {
  return evento({ EventType: "messages", message: m, ...extra });
}

describe("webhook uazapi — mensagem", () => {
  it("texto recebido (forma da doc)", () => {
    const e = mensagem({
      id: "5511999999999:MSG_EXEMPLO",
      messageid: "MSG_EXEMPLO",
      chatid: "5511888888888@s.whatsapp.net",
      sender: "5511888888888@s.whatsapp.net",
      senderName: "Contato de exemplo",
      fromMe: false,
      isGroup: false,
      messageType: "Conversation",
      text: "Olá, preciso de ajuda.",
      messageTimestamp: 1788868800000,
    });
    expect(e).toEqual({
      tipo: "mensagem",
      mensagem: expect.objectContaining({
        id: "MSG_EXEMPLO",
        chatId: "5511888888888@s.whatsapp.net",
        fromMe: false,
        telefoneAlternativo: null,
        nome: "Contato de exemplo",
        texto: "Olá, preciso de ajuda.",
        tipo: "chat",
        temMidia: false,
        timestamp: 1788868800000,
      }),
    });
  });

  it("@lid com o telefone real em `sender_pn` (fixture do app em produção)", () => {
    const e = mensagem(
      {
        id: "provider-observed-text",
        chatid: "123456789012345@lid",
        sender: "123456789012345@lid",
        sender_pn: "5511888888888@s.whatsapp.net",
        sender_lid: "123456789012345@lid",
        fromMe: false,
        wasSentByApi: false,
        type: "text",
        text: "Teste escrito",
        messageTimestamp: 1_750_000_000_000,
      },
      { chat: { wa_chatid: "123456789012345@lid", wa_contactName: "Contato", phone: "5511888888888" } },
    );
    expect(e.tipo).toBe("mensagem");
    if (e.tipo !== "mensagem") return;
    expect(e.mensagem.chatId).toBe("123456789012345@lid");
    expect(e.mensagem.telefoneAlternativo).toBe("5511888888888@s.whatsapp.net");
    expect(e.mensagem.nome).toBe("Contato");
    // Sem `messageid`, o id é o próprio `id` (sem `<dono>:` não há o que cortar).
    expect(e.mensagem.id).toBe("provider-observed-text");
  });

  it("@lid sem `sender_pn` usa o `chat.phone`", () => {
    const e = mensagem(
      { messageid: "M2", chatid: "123456789012345@lid", fromMe: false, text: "oi" },
      { chat: { phone: "+55 11 98888-8888" } },
    );
    expect(e.tipo === "mensagem" && e.mensagem.telefoneAlternativo).toBe("5511988888888@s.whatsapp.net");
  });

  it("mídia: imagem com legenda, nota de voz e documento com nome", () => {
    const img = mensagem({
      messageid: "IMG1",
      chatid: "5511888888888@s.whatsapp.net",
      fromMe: false,
      messageType: "ImageMessage",
      type: "media",
      mediaType: "image",
      text: "foto da fachada",
      mimetype: "image/jpeg",
    });
    expect(img).toMatchObject({
      tipo: "mensagem",
      mensagem: { tipo: "image", temMidia: true, mime: "image/jpeg", texto: "foto da fachada" },
    });

    const voz = mensagem({
      messageid: "PTT1",
      chatid: "5511888888888@s.whatsapp.net",
      fromMe: false,
      messageType: "AudioMessage",
      type: "media",
      mediaType: "ptt",
      content: { mimetype: "audio/ogg; codecs=opus", PTT: true },
    });
    expect(voz).toMatchObject({ mensagem: { tipo: "ptt", temMidia: true, mime: "audio/ogg; codecs=opus" } });

    const doc = mensagem({
      messageid: "DOC1",
      chatid: "5511888888888@s.whatsapp.net",
      fromMe: false,
      messageType: "DocumentMessage",
      type: "media",
      mediaType: "document",
      content: JSON.stringify({ mimetype: "application/pdf", fileName: "contrato.pdf" }),
    });
    expect(doc).toMatchObject({ mensagem: { tipo: "document", nomeDoArquivo: "contrato.pdf", mime: "application/pdf" } });
  });

  it("localização vira pino legível; sem coordenada válida é ignorada", () => {
    const pino = mensagem({
      messageid: "LOC1",
      chatid: "5511888888888@s.whatsapp.net",
      fromMe: false,
      messageType: "LocationMessage",
      content: { degreesLatitude: -23.5, degreesLongitude: -46.6, name: "Loja" },
    });
    expect(pino).toMatchObject({
      mensagem: { tipo: "location", localizacao: { latitude: -23.5, longitude: -46.6, name: "Loja" } },
    });
    expect(
      mensagem({ messageid: "LOC2", chatid: "5511888888888@s.whatsapp.net", messageType: "LocationMessage", content: {} }),
    ).toEqual({ tipo: "ignorado", motivo: "localizacao_ilegivel" });
  });

  it("enviada pelo CELULAR (`fromMe` sem `wasSentByApi`) entra, sem nome e com o telefone do chat", () => {
    const e = mensagem(
      {
        messageid: "DOCEL",
        chatid: "123456789012345@lid",
        sender_pn: "5511999999999@s.whatsapp.net",
        fromMe: true,
        wasSentByApi: false,
        text: "respondi pelo celular",
      },
      { chat: { phone: "5511888888888", wa_contactName: "Cliente" } },
    );
    expect(e).toMatchObject({
      tipo: "mensagem",
      // `sender_pn` é o NOSSO número na enviada; o contato é o do chat.
      mensagem: { fromMe: true, nome: null, telefoneAlternativo: "5511888888888@s.whatsapp.net" },
    });
  });

  it("eco do nosso envio (`wasSentByApi`) é ignorado", () => {
    expect(
      mensagem({ messageid: "ECO", chatid: "5511888888888@s.whatsapp.net", fromMe: true, wasSentByApi: true, text: "x" }),
    ).toEqual({ tipo: "ignorado", motivo: "eco_do_envio" });
  });

  it("grupo, newsletter e transmissão são ignorados nesta versão", () => {
    for (const chatid of ["120363000000001@g.us", "120363000000002@newsletter", "status@broadcast"]) {
      expect(mensagem({ messageid: "G", chatid, fromMe: false, text: "oi" })).toEqual({
        tipo: "ignorado",
        motivo: "grupo_ou_lista",
      });
    }
    expect(
      mensagem({ messageid: "G2", chatid: "5511888888888@s.whatsapp.net", isGroup: true, text: "oi" }),
    ).toEqual({ tipo: "ignorado", motivo: "grupo_ou_lista" });
  });

  it("reação, mensagem sem id e chat desconhecido não viram mensagem", () => {
    expect(
      mensagem({ messageid: "R", chatid: "5511888888888@s.whatsapp.net", messageType: "ReactionMessage", text: "👍" }),
    ).toEqual({ tipo: "ignorado", motivo: "tipo_sem_suporte" });
    expect(mensagem({ chatid: "5511888888888@s.whatsapp.net", text: "oi" })).toEqual({
      tipo: "ignorado",
      motivo: "mensagem_sem_id",
    });
    expect(mensagem({ messageid: "Z", chatid: "xpto", text: "oi" })).toEqual({
      tipo: "ignorado",
      motivo: "chat_nao_reconhecido",
    });
  });
});

describe("webhook uazapi — recibo (as duas formas)", () => {
  it("forma da doc: `event.MessageIDs[]` + `state`", () => {
    expect(
      evento({
        EventType: "messages_update",
        type: "ReadReceipt",
        state: "Read",
        event: {
          Chat: "5511888888888@s.whatsapp.net",
          chatid: "5511888888888@s.whatsapp.net",
          MessageIDs: ["MSG_A", "MSG_B", "MSG_A"],
          Timestamp: 1788868800,
          Type: "Read",
          IsFromMe: true,
          IsGroup: false,
        },
      }),
    ).toEqual({ tipo: "recibo", ids: ["MSG_A", "MSG_B"], ack: 3 });

    expect(
      evento({ EventType: "messages_update", event: { MessageIDs: ["M"], Type: "Delivered", IsFromMe: true } }),
    ).toEqual({ tipo: "recibo", ids: ["M"], ack: 2 });
    expect(
      evento({ EventType: "messages_update", state: "Played", event: { MessageIDs: ["M"], IsFromMe: true } }),
    ).toMatchObject({ ack: 4 });
  });

  it("forma antiga: `message.{id,status}`, com o `<dono>:` cortado", () => {
    expect(
      evento({ EventType: "messages_update", message: { id: "5511999999999:3EB0X", status: "delivered" } }),
    ).toEqual({ tipo: "recibo", ids: ["3EB0X"], ack: 2 });
    expect(evento({ EventType: "messages_update", message: { id: "3EB0Y", status: "failed" } })).toEqual({
      tipo: "recibo",
      ids: ["3EB0Y"],
      ack: -1,
    });
    expect(evento({ EventType: "messages_update", message: { id: "3EB0Z", status: "queued" } })).toEqual({
      tipo: "ignorado",
      motivo: "recibo_sem_efeito",
    });
  });

  it("recibo de grupo e recibo da mensagem que nós recebemos são ignorados", () => {
    expect(
      evento({ EventType: "messages_update", type: "GroupReceipts", event: { MessageIDs: ["M"], IsGroup: true } }),
    ).toEqual({ tipo: "ignorado", motivo: "grupo_ou_lista" });
    expect(
      evento({ EventType: "messages_update", state: "Read", event: { MessageIDs: ["M"], IsFromMe: false } }),
    ).toEqual({ tipo: "ignorado", motivo: "recibo_de_mensagem_recebida" });
  });
});

describe("webhook uazapi — conexão e contrato", () => {
  it("estado da instância, com o motivo da queda e o número do aparelho", () => {
    expect(evento({ EventType: "connection", instance: { name: "Atendimento", status: "connected" } })).toEqual({
      tipo: "conexao",
      estado: "connected",
      motivo: null,
      numero: "5511999999999",
    });
    expect(
      evento({
        EventType: "connection",
        type: "Disconnected",
        instance: { status: "disconnected", lastDisconnectReason: "unknown" },
      }),
    ).toMatchObject({ tipo: "conexao", estado: "disconnected", motivo: "unknown" });
    // Sem `instance.status`, o `type` do evento.
    expect(evento({ EventType: "connection", type: "LoggedOut" })).toMatchObject({ estado: "disconnected" });
    expect(evento({ EventType: "connection" })).toEqual({ tipo: "ignorado", motivo: "conexao_sem_estado" });
  });

  it("evento fora dos três é ignorado; corpo fora do contrato nomeia o campo", () => {
    expect(evento({ EventType: "presence" })).toEqual({ tipo: "ignorado", motivo: "evento_sem_interesse" });
    expect(lerEnvelopeUazapi("{nao é json")).toEqual({ ok: false, motivo: "json_invalido" });
    // Campo opcional com tipo inesperado vira ausente; só o tipo do evento é obrigatório.
    expect(lerEnvelopeUazapi(JSON.stringify({ EventType: "messages", message: { fromMe: "sim" } })).ok).toBe(true);
    expect(lerEnvelopeUazapi(JSON.stringify({ EventType: "messages", message: "texto solto" })).ok).toBe(true);
    expect(lerEnvelopeUazapi(JSON.stringify({ token: "x" }))).toEqual({
      ok: false,
      motivo: "contrato_violado",
      campos: ["EventType"],
    });
  });
});

describe("webhook uazapi — token do corpo e marca da mídia", () => {
  it("confere o token do corpo contra a impressão gravada na sessão", () => {
    const impressao = impressaoDoToken("INSTANCE_TOKEN");
    expect(impressao).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenDoCorpoConfere(JSON.stringify({ ...RAIZ, EventType: "messages" }), impressao)).toBe(true);
    expect(tokenDoCorpoConfere(JSON.stringify({ ...RAIZ, token: "outro" }), impressao)).toBe(false);
    expect(tokenDoCorpoConfere(JSON.stringify({ EventType: "messages" }), impressao)).toBe(false);
    expect(tokenDoCorpoConfere("{lixo", impressao)).toBe(false);
    // Segredo que não é impressão (ex.: o aleatório de outra versão) recusa tudo.
    expect(tokenDoCorpoConfere(JSON.stringify(RAIZ), "curto")).toBe(false);
    expect(tokenDoCorpoConfere(JSON.stringify(RAIZ), null)).toBe(false);
  });

  it("a marca da mídia só devolve id bem formado", () => {
    expect(idDaMidiaGravada("uazapi-midia:3EB0ABC")).toBe("3EB0ABC");
    expect(idDaMidiaGravada("uazapi-midia:")).toBeNull();
    expect(idDaMidiaGravada("uazapi-midia:../../etc")).toBeNull();
    expect(idDaMidiaGravada("https://x.test/a")).toBeNull();
  });
});
