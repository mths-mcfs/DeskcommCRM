import { describe, expect, it } from "vitest";

import {
  corpoSemCredencial,
  eventoDoEnvelope,
  impressaoDoToken,
  lerEnvelopeUazapi,
  tokenDoCorpoConfere,
  type EventoUazapi,
  type MensagemUazapi,
} from "@/lib/channels/uazapi/webhook";

/**
 * Os payloads do app que já roda com a UAZAPI em produção — copiados das specs
 * dele (`uazapi_normalizer_spec.rb` e `uazapi_connection_webhooks_spec.rb`),
 * não importados. A classificação do app é o oráculo; onde o resultado daqui
 * difere, o caso diz por quê.
 *
 * A regra deste parser: só a falta do essencial (id da mensagem, chat) descarta.
 * Campo opcional com tipo inesperado vira ausente ou é convertido — nunca
 * derruba o evento.
 */

type Json = Record<string, unknown>;

function clone<T>(v: T): T {
  return structuredClone(v);
}

function evento(corpo: Json): EventoUazapi {
  const leitura = lerEnvelopeUazapi(JSON.stringify(corpo));
  if (!leitura.ok) throw new Error(`não leu: ${JSON.stringify(leitura)}`);
  return eventoDoEnvelope(leitura.envelope);
}

function mensagemDe(corpo: Json): MensagemUazapi {
  const ev = evento(corpo);
  if (ev.tipo !== "mensagem") throw new Error(`não é mensagem: ${JSON.stringify(ev)}`);
  return ev.mensagem;
}

/** `let(:payload)` da spec do normalizer. */
const PAYLOAD: Json = {
  EventType: "messages",
  instanceName: "instance-a",
  message: {
    id: "provider-1",
    chatid: "123@lid",
    sender_lid: "123@lid",
    sender_pn: "5511999999999@s.whatsapp.net",
    fromMe: false,
    type: "text",
    text: "private body",
    messageTimestamp: 1_756_000_000_000,
  },
  chat: { wa_chatid: "123@lid", phone: "5511999999999", wa_contactName: "Contact" },
  token: "secret",
};

function payload(alterar: (p: { message: Json; chat: Json } & Json) => void = () => {}): Json {
  const p = clone(PAYLOAD) as { message: Json; chat: Json } & Json;
  alterar(p);
  return p;
}

describe("fixtures do normalizer — identidade e corpo", () => {
  it("preserva a citada e prefere o `messageid` como id da mensagem", () => {
    const m = mensagemDe(
      payload((p) => Object.assign(p.message, { quoted: "WHATSAPP-ORIGINAL-1", messageid: "WHATSAPP-REPLY-2" })),
    );
    expect(m.id).toBe("WHATSAPP-REPLY-2");
    expect(m.citadaId).toBe("WHATSAPP-ORIGINAL-1");
  });

  it("guarda o @lid, o telefone real e o arquivado não leva o token", () => {
    const m = mensagemDe(payload());
    expect(m).toMatchObject({
      tipo: "chat",
      chatId: "123@lid",
      telefoneAlternativo: "5511999999999@s.whatsapp.net",
      texto: "private body",
      nome: "Contact",
      timestamp: 1_756_000_000_000,
    });
    expect(corpoSemCredencial(JSON.stringify(payload()))).not.toContain("secret");
  });

  it("o `type` da mensagem vence o do envelope; sem ele, o do envelope vale", () => {
    const comOsDois = payload((p) => {
      p.type = "image";
    });
    expect(mensagemDe(comOsDois).tipo).toBe("chat");

    const soEnvelope = payload((p) => {
      p.type = "image";
      delete p.message.type;
    });
    expect(mensagemDe(soEnvelope)).toMatchObject({ tipo: "image", temMidia: true, texto: "private body" });

    const tipoNovo = payload((p) => {
      p.type = "future_type";
      delete p.message.type;
    });
    expect(evento(tipoNovo)).toEqual({ tipo: "ignorado", motivo: "tipo_sem_suporte" });

    // Divergência deliberada: o app marca `unsupported` quando não há `type`
    // nenhum. Aqui, sem tipo e COM texto, o texto é a mensagem — descartar
    // seria perder o que a pessoa escreveu por falta de um campo opcional.
    const semTipo = payload((p) => {
      delete p.message.type;
    });
    expect(mensagemDe(semTipo)).toMatchObject({ tipo: "chat", texto: "private body" });
  });

  it("bytes de mídia no texto não viram legenda", () => {
    const encoded = "iVBORw0KGgoAAAANSUhEUg==";
    const m = mensagemDe(
      payload((p) =>
        Object.assign(p.message, {
          type: "image",
          text: `data:image/png;base64,${encoded}`,
          content: encoded,
          base64Data: encoded,
          BASE64_DATA: encoded,
          track_source: "unknown-source",
          track_id: encoded,
          fileURL: "https://temporary.example/media.jpg",
          future_root_field: { safe_metadata: "keep-me", mediaBytes: [0, 1, 2, 3] },
        }),
      ),
    );
    expect(m).toMatchObject({ tipo: "image", temMidia: true, texto: null });
  });

  it("nome longo fica; nome que é `data:` some", () => {
    expect(mensagemDe(payload((p) => (p.chat.wa_contactName = "A".repeat(64)))).nome).toBe("A".repeat(64));
    expect(
      mensagemDe(payload((p) => (p.chat.wa_contactName = "data:image/png;base64,AAECAwQFBgcICQ=="))).nome,
    ).toBeNull();
  });

  it("texto longo com cara de base64 fica; texto que é `data:` não é mensagem", () => {
    const valor = "A".repeat(64);
    expect(
      mensagemDe(
        payload((p) => {
          p.message.text = valor;
          p.message.content = valor;
        }),
      ).texto,
    ).toBe(valor);
    // O app guarda a linha com o corpo filtrado; aqui, sem nada legível, ela não entra.
    expect(
      evento(
        payload((p) => {
          p.message.text = `data:text/plain;base64,${valor}`;
          p.message.content = valor;
        }),
      ),
    ).toEqual({ tipo: "ignorado", motivo: "mensagem_vazia" });
  });
});

describe("fixtures do normalizer — envelopes observados", () => {
  it("texto observado", () => {
    const corpo: Json = {
      BaseUrl: "https://tenant.example",
      EventType: "messages",
      instanceName: "instance-a",
      owner: "5511999999999",
      type: "text",
      message: {
        id: "provider-observed-text",
        chatid: "123456789012345@lid",
        sender: "123456789012345@lid",
        sender_pn: "5511888888888@s.whatsapp.net",
        sender_lid: "123456789012345@lid",
        fromMe: false,
        wasSentByApi: false,
        type: "text",
        text: "Teste escrito",
        future_text_field: { safe_metadata: "keep-text" },
        messageTimestamp: 1_750_000_000_000,
      },
      chat: {
        wa_chatid: "123456789012345@lid",
        wa_contactName: "Contato",
        wa_name: "Contato",
        phone: "5511888888888",
      },
      token: "secret",
    };
    expect(mensagemDe(corpo)).toMatchObject({
      tipo: "chat",
      fromMe: false,
      texto: "Teste escrito",
      chatId: "123456789012345@lid",
      telefoneAlternativo: "5511888888888@s.whatsapp.net",
      nome: "Contato",
    });
    expect(corpoSemCredencial(JSON.stringify(corpo))).not.toContain("secret");
  });

  it("imagem observada (com legenda, sem nome de arquivo)", () => {
    const encoded = "iVBORw0KGgoAAAANSUhEUg==";
    const temporaria = "https://temporary.example/media.jpg";
    const m = mensagemDe({
      EventType: "messages",
      instanceName: "instance-a",
      type: "image",
      message: {
        id: "provider-observed-image",
        chatid: "123456789012345@lid",
        sender: "123456789012345@lid",
        sender_pn: "5511888888888@s.whatsapp.net",
        sender_lid: "123456789012345@lid",
        fromMe: false,
        wasSentByApi: false,
        type: "image",
        mimetype: "image/jpeg",
        fileURL: temporaria,
        fileName: "",
        fileLength: 123_456,
        width: 1080,
        height: 1920,
        text: "Legenda da imagem",
        content: { URL: temporaria, safe_metadata: "keep-image" },
        base64Data: encoded,
        future_image_field: { safe_metadata: "keep-image-field" },
        messageTimestamp: 1_750_000_000_000,
      },
      chat: { wa_chatid: "123456789012345@lid", wa_contactName: "Contato", phone: "5511888888888" },
    });
    expect(m).toMatchObject({
      tipo: "image",
      temMidia: true,
      texto: "Legenda da imagem",
      mime: "image/jpeg",
      nomeDoArquivo: null,
      telefoneAlternativo: "5511888888888@s.whatsapp.net",
    });
  });

  it("nota de voz observada (`type: ptt`, forma de onda binária)", () => {
    const m = mensagemDe({
      EventType: "messages",
      instanceName: "instance-a",
      type: "ptt",
      message: {
        id: "provider-observed-ptt",
        chatid: "123456789012345@lid",
        sender: "123456789012345@lid",
        sender_pn: "5511888888888@s.whatsapp.net",
        sender_lid: "123456789012345@lid",
        fromMe: false,
        wasSentByApi: false,
        type: "ptt",
        mimetype: "audio/ogg; codecs=opus",
        fileURL: "https://temporary.example/audio.oga",
        fileName: "",
        duration: 12,
        waveform: "\x00\x01\x02\x03",
        content: { URL: "https://temporary.example/audio.oga", safe_metadata: "keep-ptt" },
        base64Data: "AAECAwQFBgcICQ==",
        future_ptt_field: { safe_metadata: "keep-ptt-field" },
        messageTimestamp: 1_750_000_000_000,
      },
      chat: { wa_chatid: "123456789012345@lid", wa_contactName: "Contato", phone: "5511888888888" },
    });
    expect(m).toMatchObject({ tipo: "ptt", temMidia: true, texto: null, mime: "audio/ogg; codecs=opus" });
  });

  it("`media` com a marca PTT no `content` é nota de voz", () => {
    const m = mensagemDe(
      payload((p) => {
        p.type = "media";
        p.message.type = "media";
        p.message.content = { PTT: true, mimetype: "audio/ogg; codecs=opus", fileLength: 9879, seconds: 3 };
      }),
    );
    expect(m).toMatchObject({ tipo: "ptt", temMidia: true, mime: "audio/ogg; codecs=opus" });
  });

  it("`media` de texto puro é documento, com o nome do arquivo", () => {
    const m = mensagemDe(
      payload((p) => {
        p.type = "media";
        p.message.type = "media";
        p.message.content = { mimetype: "text/plain", fileName: "notes.txt", fileLength: 42 };
      }),
    );
    expect(m).toMatchObject({ tipo: "document", mime: "text/plain", nomeDoArquivo: "notes.txt" });
  });

  it("texto com prévia de link é texto", () => {
    const texto =
      "Olá! Quero ser contatado sobre este imóvel que vi em Wimoveis.\n\nhttps://www.wimoveis.com.br/propriedades/sobrado-1.html";
    const m = mensagemDe(
      payload((p) => {
        p.type = "media";
        Object.assign(p.message, { type: "media", mediaType: "url", messageType: "ExtendedTextMessage", text: texto });
      }),
    );
    expect(m).toMatchObject({ tipo: "chat", temMidia: false });
    expect(m.texto).toContain("https://www.wimoveis.com.br/propriedades/sobrado-1.html");
  });

  it("mensagem que o WhatsApp não decifrou é ignorada, com motivo", () => {
    expect(
      evento(
        payload((p) =>
          Object.assign(p.message, { type: "text", messageType: "Conversation", text: "[Undecryptable] [text] mensagem" }),
        ),
      ),
    ).toEqual({ tipo: "ignorado", motivo: "mensagem_nao_decifrada" });
  });
});

describe("fixtures do normalizer — telefones (#493: o número já vem com o país)", () => {
  function comNumero(numero: string, fromMe = false): Json {
    return payload((p) => {
      p.chat.phone = numero;
      if (fromMe) {
        Object.assign(p.message, { fromMe: true, chatid: `${numero}@s.whatsapp.net` });
        delete p.message.sender_pn;
        p.chat.wa_chatid = `${numero}@s.whatsapp.net`;
      } else {
        p.message.sender_pn = `${numero}@s.whatsapp.net`;
      }
    });
  }

  it("número estrangeiro fica só com os dígitos dele", () => {
    expect(mensagemDe(comNumero("34912345678")).telefoneAlternativo).toBe("34912345678@s.whatsapp.net");
    expect(mensagemDe(comNumero("3491234567")).telefoneAlternativo).toBe("3491234567@s.whatsapp.net");
    // Do celular, o chat JÁ é o telefone: não há `@lid` a completar.
    expect(mensagemDe(comNumero("34912345678", true))).toMatchObject({
      fromMe: true,
      chatId: "34912345678@s.whatsapp.net",
      telefoneAlternativo: null,
      nome: null,
    });
  });

  it("número brasileiro fica como veio", () => {
    expect(mensagemDe(comNumero("551187654321")).telefoneAlternativo).toBe("551187654321@s.whatsapp.net");
    expect(mensagemDe(comNumero("5511987654321")).telefoneAlternativo).toBe("5511987654321@s.whatsapp.net");
  });

  it("telefones em conflito: a mensagem entra pelo @lid, sem escolher um telefone", () => {
    // O app recusa o evento inteiro (`ambiguous_phone_identity`). Aqui a
    // mensagem é do contato do @lid de qualquer jeito; o que não se faz é
    // adivinhar qual dos dois números é o dele.
    const recebida = payload((p) => (p.chat.phone = "5511888888888"));
    expect(mensagemDe(recebida)).toMatchObject({ chatId: "123@lid", telefoneAlternativo: null, texto: "private body" });

    const doCelular = payload((p) => {
      p.message.fromMe = true;
      p.message.chatid = "5511888888888@s.whatsapp.net";
      p.chat.wa_chatid = "5511888888888@s.whatsapp.net";
    });
    expect(mensagemDe(doCelular)).toMatchObject({
      fromMe: true,
      chatId: "5511888888888@s.whatsapp.net",
      telefoneAlternativo: null,
    });
  });
});

describe("fixtures do normalizer — conteúdo estruturado e localização", () => {
  const PINO = {
    degreesLatitude: -15.8123456,
    degreesLongitude: -47.9123456,
    name: "Portão azul",
    address: "Quadra 1, Bairro Exemplo",
    JPEGThumbnail: `/9j/${"A".repeat(60)}`,
  };

  function semTexto(campos: Json): Json {
    return payload((p) => {
      delete p.message.text;
      Object.assign(p.message, campos);
    });
  }

  it("tipos conhecidos e desconhecidos pelo `type`", () => {
    expect(
      mensagemDe(semTexto({ type: "location", content: { latitude: -15.7939, longitude: -47.8828, address: "Endereço completo" } })),
    ).toMatchObject({
      tipo: "location",
      localizacao: { latitude: -15.7939, longitude: -47.8828, name: null, address: "Endereço completo" },
    });
    expect(mensagemDe(semTexto({ type: "contact", content: { vcard: "BEGIN:VCARD\nFN:João Silva\nEND:VCARD" } }))).toMatchObject({
      tipo: "vcard",
      vcard: "BEGIN:VCARD\nFN:João Silva\nEND:VCARD",
    });
    expect(
      evento(semTexto({ type: "future_type", content: { future_field: { value: "preserve me" } }, future_root_field: { keep: true } })),
    ).toEqual({ tipo: "ignorado", motivo: "tipo_sem_suporte" });
  });

  it("pino como `media` + `LocationMessage`", () => {
    const m = mensagemDe(semTexto({ type: "media", messageType: "LocationMessage", mediaType: "", content: PINO }));
    expect(m).toMatchObject({
      tipo: "location",
      temMidia: false,
      texto: null,
      localizacao: { latitude: -15.8123456, longitude: -47.9123456, name: "Portão azul", address: "Quadra 1, Bairro Exemplo" },
    });
  });

  it("pino como `text` vazio + `LocationMessage`", () => {
    const m = mensagemDe(semTexto({ type: "text", text: "", messageType: "LocationMessage", content: { ...PINO, isLive: false } }));
    expect(m).toMatchObject({ tipo: "location", localizacao: { latitude: -15.8123456, longitude: -47.9123456 } });
  });

  it("tipo direto, nomes do Go, `mediaType` e campos soltos na mensagem", () => {
    const direto = mensagemDe(semTexto({ type: "LocationMessage", content: { DegreesLatitude: "-15.8", DegreesLongitude: "-47.9" } }));
    const porMidia = mensagemDe(semTexto({ type: "media", mediaType: "location", content: { latitude: -15.8, longitude: -47.9 } }));
    const solto = mensagemDe(semTexto({ type: "location", latitude: -15.8, longitude: -47.9, name: "Casa" }));
    for (const m of [direto, porMidia, solto]) expect(m.tipo).toBe("location");
    expect(direto.localizacao).toEqual({ latitude: -15.8, longitude: -47.9, name: null, address: null });
    expect(porMidia.localizacao).toEqual({ latitude: -15.8, longitude: -47.9, name: null, address: null });
    expect(solto.localizacao).toEqual({ latitude: -15.8, longitude: -47.9, name: "Casa", address: null });
  });

  it("tempo real sem coordenada válida fica com a legenda; coordenada ruim é pulada, não adivinhada", () => {
    // O app guarda o pino sem coordenada (só `live`). Aqui não há pino para
    // mostrar, mas há o que a pessoa escreveu: entra como texto.
    const aoVivo = mensagemDe(
      semTexto({ type: "media", messageType: "liveLocationMessage", content: { degreesLatitude: -95.0, degreesLongitude: "abc", caption: "estou aqui" } }),
    );
    expect(aoVivo).toMatchObject({ tipo: "chat", texto: "estou aqui", localizacao: null });

    const marcado = mensagemDe(semTexto({ type: "text", messageType: "LocationMessage", content: { ...PINO, isLive: true } }));
    expect(marcado.localizacao).toMatchObject({ latitude: -15.8123456, longitude: -47.9123456 });

    const misto = mensagemDe(semTexto({ type: "location", content: { latitude: "n/a", degreesLatitude: -15.8, longitude: -47.9 } }));
    expect(misto.localizacao).toEqual({ latitude: -15.8, longitude: -47.9, name: null, address: null });

    // Sem coordenada E sem texto não há o que mostrar.
    expect(evento(semTexto({ type: "location", content: {} }))).toEqual({ tipo: "ignorado", motivo: "localizacao_ilegivel" });
  });

  it("outras mídias não viram localização; enquete fica de fora", () => {
    expect(mensagemDe(semTexto({ type: "media", messageType: "ImageMessage", mimetype: "image/jpeg", content: {} }))).toMatchObject({
      tipo: "image",
      localizacao: null,
    });
    expect(evento(semTexto({ type: "media", messageType: "PollCreationMessage", content: {} }))).toEqual({
      tipo: "ignorado",
      motivo: "tipo_sem_suporte",
    });
  });
});

describe("fixtures do normalizer — atualização e validação", () => {
  function atualizacao(campos: Json): Json {
    return payload((p) => {
      p.EventType = "messages_update";
      delete p.message.text;
      Object.assign(p.message, campos);
    });
  }

  it("status com instantes ISO vira recibo; edição e apagamento sem status não mudam o desfecho", () => {
    expect(
      evento(atualizacao({ status: "sent", messageTimestamp: "2026-08-25T12:00:00Z", editedAt: "2026-08-25T12:01:00Z" })),
    ).toEqual({ tipo: "recibo", ids: ["provider-1"], ack: 1 });
    expect(
      evento(
        atualizacao({
          status: "sent",
          messageTimestamp: "2026-08-25T12:04:00Z",
          editedAt: "2026-08-25T12:01:00Z",
          deletedAt: "2026-08-25T12:03:00Z",
        }),
      ),
    ).toEqual({ tipo: "recibo", ids: ["provider-1"], ack: 1 });
    // Este canal não edita nem acompanha o apagamento (`alteraMensagemEnviada: false`).
    expect(evento(atualizacao({ deletedAt: "2026-08-25T12:03:00Z", messageTimestamp: "2026-08-25T12:00:00Z" }))).toEqual({
      tipo: "ignorado",
      motivo: "recibo_sem_efeito",
    });
  });

  it("instância errada: quem prende o evento à instância é o token do corpo", () => {
    // O app compara `instanceName`; aqui a prova é o token, que é por instância.
    const daSessao = impressaoDoToken("token-da-instance-a");
    expect(tokenDoCorpoConfere(JSON.stringify({ ...payload(), token: "token-da-instance-a" }), daSessao)).toBe(true);
    expect(tokenDoCorpoConfere(JSON.stringify({ ...payload(), token: "token-de-outra" }), daSessao)).toBe(false);
  });

  it("instante ilegível não derruba a mensagem: some", () => {
    // O app recusa o evento. Aqui o instante é opcional (a ingestão usa a hora
    // de chegada), e a mensagem entra.
    const m = mensagemDe(payload((p) => (p.message.messageTimestamp = "not-a-time")));
    expect(m).toMatchObject({ texto: "private body", timestamp: null });
  });

  it("instante em ms, em segundos, em texto numérico e em ISO", () => {
    for (const [bruto, esperado] of [
      [1_756_000_000_000, 1_756_000_000_000],
      [1_756_000_000, 1_756_000_000_000],
      ["1756000000000", 1_756_000_000_000],
      ["2025-08-24T01:46:40Z", 1_756_000_000_000],
    ] as const) {
      expect(mensagemDe(payload((p) => (p.message.messageTimestamp = bruto))).timestamp).toBe(esperado);
    }
  });

  it("tipos inesperados nos campos opcionais convertem ou somem", () => {
    const m = mensagemDe(
      payload((p) => {
        p.message.fromMe = "false";
        p.message.quoted = { id: "CITADA-1" };
        p.message.fileLength = "123";
        p.chat.phone = 5511999999999;
        p.chat.name = 0;
        p.chat.wa_name = null;
      }),
    );
    expect(m).toMatchObject({ fromMe: false, citadaId: "CITADA-1", telefoneAlternativo: "5511999999999@s.whatsapp.net" });
    expect(mensagemDe(payload((p) => (p.message.fromMe = "true")))).toMatchObject({ fromMe: true, nome: null });
  });

  it("sem id ou sem chat, descarta — é o essencial", () => {
    expect(evento(payload((p) => delete p.message.id))).toEqual({ tipo: "ignorado", motivo: "mensagem_sem_id" });
    expect(
      evento(
        payload((p) => {
          delete p.message.chatid;
          delete p.chat.wa_chatid;
        }),
      ),
    ).toEqual({ tipo: "ignorado", motivo: "mensagem_sem_chat" });
  });
});

describe("fixtures do evento de conexão", () => {
  function conexao(campos: { status?: string | null; type: string; event_id?: string; reason?: string }): Json {
    const instancia: Json = { name: "instance-a" };
    if (campos.status) instancia.status = campos.status;
    if (campos.reason) instancia.lastDisconnectReason = campos.reason;
    return {
      EventType: "connection",
      instanceName: "instance-a",
      owner: "5511900000000",
      token: "instance-token-secret",
      BaseUrl: "https://messaging.example.invalid",
      type: campos.type,
      ...(campos.event_id ? { event_id: campos.event_id } : {}),
      instance: instancia,
    };
  }

  it("queda com motivo, e o arquivado não leva o token", () => {
    const corpo = conexao({ status: "disconnected", type: "Disconnected", reason: "Celular desligado" });
    expect(evento(corpo)).toEqual({
      tipo: "conexao",
      estado: "disconnected",
      motivo: "Celular desligado",
      numero: "5511900000000",
    });
    expect(evento(conexao({ status: "disconnected", type: "Disconnected" }))).toMatchObject({ estado: "disconnected", motivo: null });
    expect(corpoSemCredencial(JSON.stringify(corpo))).not.toContain("instance-token-secret");
  });

  it("volta com `event_id`", () => {
    expect(evento(conexao({ status: "connected", type: "Connected", event_id: "evt-1" }))).toMatchObject({
      tipo: "conexao",
      estado: "connected",
    });
  });

  it("sem `instance.status`, lê pelo `type`; o que não conhece é ignorado", () => {
    expect(evento(conexao({ status: null, type: "TemporaryBan" }))).toMatchObject({ tipo: "conexao", estado: "disconnected" });
    expect(evento(conexao({ status: null, type: "SomethingElse" }))).toEqual({ tipo: "ignorado", motivo: "conexao_sem_estado" });
  });
});
