/**
 * Webhook da UAZAPI — módulo PURO: corpo cru → evento do domínio, sem banco.
 *
 * O servidor não assina o corpo. A autenticação é dupla e mora em quem chama:
 * o segredo no CAMINHO (a rota genérica só acha a sessão pelo token dela) e o
 * `token` da instância que vem no corpo, comparado em tempo constante com o
 * token gravado na sessão (`tokenConfere`). Corpo com token divergente é
 * recusado — quem sabe a URL e não o token não injeta mensagem.
 *
 * ─── O contrato, e o que fica de fora ───────────────────────────────────────
 *
 * Os schemas são `loose` e quase tudo é `nullish`: o servidor é de terceiro e
 * de versão variável, e um `.strict()` transformaria "campo novo" em "mensagem
 * descartada". Ganha tipo só o que o código lê.
 *
 *   messages         mensagem nova (recebida, ou enviada pelo celular)
 *   messages_update  recibo de entrega/leitura — nas DUAS formas que existem:
 *                    a da doc (`event.MessageIDs[]` + `state`) e a antiga
 *                    (`message.{id,status}`)
 *   connection       o estado da instância mudou
 *
 * Grupo (`@g.us`), newsletter, transmissão e `status@broadcast` são ignorados
 * nesta versão, como o eco do nosso próprio envio (`wasSentByApi`).
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { ESTADOS_DA_INSTANCIA, idDaMensagem, type EstadoDaInstancia } from "./client";

// ─── Campos opcionais: tipo inesperado vira ausente, nunca recusa ─────────
//
// O servidor é de terceiro e muda de versão sem avisar: um `chat.phone` que
// chega como número ou um `fromMe` como `"true"` não podem custar a mensagem
// (a recusa vira 400, e a UAZAPI não reentrega). Cada campo opcional CONVERTE
// o que dá para converter e some quando não dá. Só o essencial (o tipo do
// evento, e na mensagem o id e o chat) decide se o evento existe.

/** Texto: string fica; número finito vira o texto dele; o resto some. */
const texto = z.unknown().optional().transform((v): string | null => {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
});

/** Booleano: `true`/`false`, também escritos como texto. O resto some. */
const booleano = z.unknown().optional().transform((v): boolean | null => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return null;
});

/** Instante em milissegundos: aceita ms, segundos, texto numérico e ISO 8601. */
export function instanteEmMs(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === "number" && Number.isFinite(v)) n = v;
  else if (typeof v === "string" && v.trim()) {
    const t = v.trim();
    if (/^\d+(\.\d+)?$/.test(t)) n = Number(t);
    else {
      const iso = Date.parse(t);
      return Number.isFinite(iso) ? iso : null;
    }
  }
  if (n === null || n <= 0) return null;
  // Abaixo de 10^11 é segundo (10^11 ms seria 1973): a UAZAPI manda ms, o
  // WhatsApp e versões antigas mandam s.
  return Math.round(n < 1e11 ? n * 1000 : n);
}

const instante = z.unknown().optional().transform(instanteEmMs);

/** O id da mensagem citada: texto, ou o `id` de um objeto `quoted`. */
const citada = z.unknown().optional().transform((v): string | null => {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ["messageid", "id", "stanzaID", "stanzaId"]) {
      const c = o[k];
      if (typeof c === "string" && c.trim()) return c;
    }
  }
  return null;
});

/** Lista de ids: array, ou um id solto. */
const listaDeIds = z.unknown().optional().transform((v): unknown[] | null => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) return [v];
  return null;
});

/** Objeto opcional: o que não é objeto vira ausente, em vez de recusar o corpo. */
function objeto<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null),
    schema.nullable(),
  );
}

const mensagemSchema = z.looseObject({
  id: texto,
  messageid: texto,
  chatid: texto,
  sender: texto,
  sender_pn: texto,
  senderName: texto,
  fromMe: booleano,
  wasSentByApi: booleano,
  isGroup: booleano,
  messageType: texto,
  type: texto,
  mediaType: texto,
  text: texto,
  messageTimestamp: instante,
  mimetype: texto,
  fileName: texto,
  quoted: citada,
  status: texto,
  vcard: texto,
  // `content` é objeto, JSON serializado OU texto cru: quem lê confere a forma.
  content: z.unknown().optional(),
  // A localização às vezes vem solta na mensagem, fora do `content`.
  latitude: z.unknown().optional(),
  longitude: z.unknown().optional(),
  name: texto,
  address: texto,
});

const chatSchema = z.looseObject({
  wa_chatid: texto,
  phone: texto,
  wa_contactName: texto,
  wa_name: texto,
  name: texto,
});

const reciboSchema = z.looseObject({
  MessageIDs: listaDeIds,
  Type: texto,
  IsFromMe: booleano,
  IsGroup: booleano,
  chatid: texto,
  Chat: texto,
});

const instanciaSchema = z.looseObject({
  status: texto,
  lastDisconnectReason: texto,
});

const envelopeSchema = z.looseObject({
  EventType: z.string(),
  token: texto,
  owner: texto,
  instanceName: texto,
  type: texto,
  state: texto,
  message: objeto(mensagemSchema),
  chat: objeto(chatSchema),
  event: objeto(reciboSchema),
  instance: objeto(instanciaSchema),
});

export type EnvelopeUazapi = z.infer<typeof envelopeSchema>;

export type LeituraUazapi =
  | { ok: true; envelope: EnvelopeUazapi }
  | { ok: false; motivo: "json_invalido" }
  | { ok: false; motivo: "contrato_violado"; campos: string[] };

/** O corpo cru passa pelo contrato. Os CAMPOS da recusa saem; os valores, nunca. */
export function lerEnvelopeUazapi(rawBody: string): LeituraUazapi {
  let bruto: unknown;
  try {
    bruto = JSON.parse(rawBody);
  } catch {
    return { ok: false, motivo: "json_invalido" };
  }
  const lido = envelopeSchema.safeParse(bruto);
  if (!lido.success) {
    const campos = [...new Set(lido.error.issues.map((i) => i.path.join(".") || "(raiz)"))];
    return { ok: false, motivo: "contrato_violado", campos };
  }
  return { ok: true, envelope: lido.data };
}

/**
 * A IMPRESSÃO do token da instância: o SHA-256 em hex. É ela — e não o token —
 * que a sessão guarda como segredo da entrada (`webhook_secret_encrypted`): a
 * rota genérica decifra esse segredo e a conferência abaixo roda sem banco,
 * antes de qualquer processamento. Guardar o token ali seria a mesma credencial
 * em dois lugares; o hash de um token aleatório não devolve o token.
 */
export function impressaoDoToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * O `token` do corpo é o da instância desta sessão? Tempo constante: os dois
 * lados têm 32 bytes antes do `timingSafeEqual`, que lançaria com tamanhos
 * diferentes. Corpo ilegível, sem token ou impressão malformada: `false`.
 */
export function tokenDoCorpoConfere(rawBody: string, impressao: string | null | undefined): boolean {
  if (!impressao || !/^[0-9a-f]{64}$/.test(impressao)) return false;
  let corpo: unknown;
  try {
    corpo = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const token =
    corpo && typeof corpo === "object" && !Array.isArray(corpo) ? (corpo as Record<string, unknown>).token : null;
  if (typeof token !== "string" || token.length === 0 || token.length > 512) return false;
  const recebido = createHash("sha256").update(token, "utf8").digest();
  return timingSafeEqual(recebido, Buffer.from(impressao, "hex"));
}

/** O que fica no lugar do token no arquivo do webhook. */
export const TOKEN_REMOVIDO = "[removido]";

function semToken(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(semToken);
  if (v && typeof v === "object") {
    const saida: Record<string, unknown> = {};
    for (const [k, filho] of Object.entries(v)) {
      saida[k] = k.toLowerCase() === "token" && filho !== null && filho !== undefined ? TOKEN_REMOVIDO : semToken(filho);
    }
    return saida;
  }
  return v;
}

/**
 * O corpo como ele pode ser ARQUIVADO: sem o valor do `token` da instância, em
 * qualquer nível. O servidor manda o token no corpo de todo evento, e o arquivo
 * do webhook (`webhook_events_log`) é legível por qualquer membro da
 * organização — guardar o corpo cru entregaria a credencial que controla o
 * número a quem só pode ver. A conferência do token usa o corpo em memória,
 * antes disto.
 *
 * Corpo que não é JSON passa por uma troca textual do mesmo campo: é o corpo
 * que alguém vai querer ler depois, e nele o token também não pode ficar.
 */
export function corpoSemCredencial(rawBody: string): string {
  try {
    return JSON.stringify(semToken(JSON.parse(rawBody)));
  } catch {
    return rawBody.replace(/("token"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, `$1"${TOKEN_REMOVIDO}"`);
  }
}

// ─── O domínio ────────────────────────────────────────────────────────────

/**
 * O `media_url` de uma mídia recebida: a plataforma não manda URL, só o id da
 * mensagem, e quem baixa é o adapter (`/message/download`). Esta marca + o id é
 * o que a ingestão grava, e só o adapter deste canal a entende.
 */
export const MARCA_DE_MIDIA = "uazapi-midia:";

/** O id da mensagem de um `media_url` gravado pela ingestão; `null` se não for. */
export function idDaMidiaGravada(url: string): string | null {
  if (!url.startsWith(MARCA_DE_MIDIA)) return null;
  const id = url.slice(MARCA_DE_MIDIA.length);
  return id && id.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(id) ? id : null;
}

/** O tipo no vocabulário que a ingestão de número por QR já entende. */
export type TipoDaMensagem = "chat" | "image" | "video" | "audio" | "ptt" | "document" | "sticker" | "location" | "vcard";

export interface Localizacao {
  latitude: number;
  longitude: number;
  name: string | null;
  address: string | null;
}

export interface MensagemUazapi {
  /** O id do WhatsApp (`messageid`), o mesmo que o envio devolve e os recibos citam. */
  id: string;
  /** O chat: `<n>@s.whatsapp.net` ou `<n>@lid`. */
  chatId: string;
  fromMe: boolean;
  /** O telefone real (`<n>@s.whatsapp.net`) quando o chat chega como `@lid`. */
  telefoneAlternativo: string | null;
  /** Como o contato se chama no WhatsApp — só na mensagem RECEBIDA. */
  nome: string | null;
  texto: string | null;
  tipo: TipoDaMensagem;
  temMidia: boolean;
  mime: string | null;
  nomeDoArquivo: string | null;
  timestamp: number | null;
  citadaId: string | null;
  localizacao: Localizacao | null;
  vcard: string | null;
}

export type EventoUazapi =
  | { tipo: "mensagem"; mensagem: MensagemUazapi }
  /** `ack` na régua de sempre: -1 falhou, 1 saiu, 2 entregue, 3 lida, 4 ouvida. */
  | { tipo: "recibo"; ids: string[]; ack: number }
  | { tipo: "conexao"; estado: EstadoDaInstancia; motivo: string | null; numero: string | null }
  | { tipo: "ignorado"; motivo: string };

const SUFIXOS_IGNORADOS = ["@g.us", "@newsletter", "@broadcast"];

function ignorado(motivo: string): EventoUazapi {
  return { tipo: "ignorado", motivo };
}

/** O id do WhatsApp, venha como `messageid` ou como `<dono>:<id>`. */
function idDe(m: { id?: string | null; messageid?: string | null }): string | null {
  const id = idDaMensagem(m);
  // Teto e forma: o id vira `external_id` e pedaço de chave; não aceitamos lixo.
  return id && id.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(id) ? id : null;
}

function chatEnderecavel(chatId: string): boolean {
  return chatId.endsWith("@s.whatsapp.net") || chatId.endsWith("@c.us") || chatId.endsWith("@lid");
}

function soDigitos(v: string | null | undefined): string | null {
  if (!v || v.length > 64) return null;
  const d = v.replace(/\D/g, "");
  return d.length >= 8 && d.length <= 15 ? d : null;
}

/** `<n>@s.whatsapp.net` — só do que parece telefone. */
function jidDeTelefone(v: string | null | undefined): string | null {
  if (!v) return null;
  if (v.endsWith("@s.whatsapp.net") || v.endsWith("@c.us")) {
    const d = soDigitos(v.slice(0, v.indexOf("@")));
    return d ? `${d}@s.whatsapp.net` : null;
  }
  if (v.includes("@")) return null;
  const d = soDigitos(v);
  return d ? `${d}@s.whatsapp.net` : null;
}

function objetoDoConteudo(content: unknown): Record<string, unknown> | null {
  if (content && typeof content === "object" && !Array.isArray(content)) return content as Record<string, unknown>;
  if (typeof content === "string" && content.trim().startsWith("{")) {
    try {
      const v: unknown = JSON.parse(content);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function textoDe(o: Record<string, unknown> | null, ...chaves: string[]): string | null {
  if (!o) return null;
  for (const k of chaves) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * O pino, venha onde vier: no `content`, num `content.location` aninhado ou
 * solto na própria mensagem, com os nomes de campo do WhatsApp, do Go ou os
 * curtos. Coordenada fora da faixa é descartada, nunca adivinhada.
 */
function localizacaoDe(fontes: ReadonlyArray<Record<string, unknown> | null>): Localizacao | null {
  const lat = primeiraCoordenada(fontes, ["latitude", "degreesLatitude", "DegreesLatitude", "lat"], 90);
  const lng = primeiraCoordenada(fontes, ["longitude", "degreesLongitude", "DegreesLongitude", "lng", "lon"], 180);
  if (lat === null || lng === null || (lat === 0 && lng === 0)) return null;
  let name: string | null = null;
  let address: string | null = null;
  for (const f of fontes) {
    name ??= textoDe(f, "name", "Name");
    address ??= textoDe(f, "address", "Address");
  }
  return { latitude: lat, longitude: lng, name, address };
}

function primeiraCoordenada(
  fontes: ReadonlyArray<Record<string, unknown> | null>,
  chaves: readonly string[],
  limite: number,
): number | null {
  for (const f of fontes) {
    if (!f) continue;
    for (const k of chaves) {
      const v = f[k];
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.trim()) : NaN;
      if (Number.isFinite(n) && Math.abs(n) <= limite) return n;
    }
  }
  return null;
}

/** Texto que é bytes (`data:…,`) não é o que a pessoa escreveu. */
function textoLegivel(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  if (!t || /^data:[^,]*,/i.test(t)) return null;
  return t;
}

/** O WhatsApp não decifrou: o texto é a marca do servidor, não a mensagem. */
const NAO_DECIFRADA = /^\[Undecryptable\]/;

/** `type` da mensagem → tipo. Os nomes seguem o que o servidor manda hoje e os antigos. */
const TIPO_POR_TIPO: Record<string, TipoDaMensagem> = {
  text: "chat",
  conversation: "chat",
  extendedtextmessage: "chat",
  image: "image",
  imagemessage: "image",
  video: "video",
  videomessage: "video",
  videoplay: "video",
  ptv: "video",
  audio: "audio",
  audiomessage: "audio",
  ptt: "ptt",
  myaudio: "ptt",
  document: "document",
  documentmessage: "document",
  documentwithcaptionmessage: "document",
  sticker: "sticker",
  stickermessage: "sticker",
};

const TIPO_POR_MIDIA: Record<string, TipoDaMensagem> = {
  image: "image",
  video: "video",
  ptv: "video",
  videoplay: "video",
  audio: "audio",
  myaudio: "ptt",
  ptt: "ptt",
  document: "document",
  sticker: "sticker",
};

const TIPOS_DE_LOCALIZACAO = ["location", "locationmessage", "livelocationmessage", "livelocation"];
const TIPOS_DE_CONTATO = ["contact", "contactmessage", "vcard", "contactsarraymessage"];

function minusculo(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

/**
 * O tipo da mensagem, ou `null` quando não é uma que a caixa de entrada mostre.
 *
 * A ordem é a do app que já roda com este servidor em produção
 * (`a4imov`, `Uazapi::Normalizer`): a localização vence (o pino chega até como
 * `type: "text"`), depois o `type` da mensagem (com o do envelope como
 * reserva), e só o `type: "media"` cai na leitura pelo `mediaType`, pela marca
 * de nota de voz e pelo mime.
 */
function tipoDe(
  m: z.infer<typeof mensagemSchema>,
  conteudo: Record<string, unknown> | null,
  tipoDoEnvelope: string | null,
): TipoDaMensagem | null {
  const tipoDaMensagem = minusculo(m.messageType);
  const tipoDaMidia = minusculo(m.mediaType ?? textoDe(conteudo, "mediaType"));
  const tipo = minusculo(m.type) || minusculo(tipoDoEnvelope);
  const ehNotaDeVoz = conteudo?.PTT === true || conteudo?.ptt === true;

  if ([tipoDaMensagem, tipoDaMidia, tipo].some((t) => TIPOS_DE_LOCALIZACAO.includes(t))) return "location";
  if ([tipoDaMensagem, tipoDaMidia, tipo].some((t) => TIPOS_DE_CONTATO.includes(t))) return "vcard";
  // Reação, edição, apagamento, enquete e mensagens de protocolo não são mensagem nova.
  if (/reaction|protocol|edited|revoke|poll|keepinchat|pininchat/.test(tipoDaMensagem)) return null;

  const direto = TIPO_POR_TIPO[tipo];
  if (direto) return direto === "audio" && ehNotaDeVoz ? "ptt" : direto;
  // `type` que este código não conhece (um tipo novo do servidor): não se adivinha.
  if (tipo && tipo !== "media") return null;

  // Texto com prévia de link chega como `media` + `mediaType: "url"`.
  if (tipoDaMidia === "url") return "chat";
  if (ehNotaDeVoz) return "ptt";
  const porMidia = TIPO_POR_MIDIA[tipoDaMidia];
  if (porMidia) return porMidia;
  const porMensagem = TIPO_POR_TIPO[tipoDaMensagem];
  if (porMensagem && porMensagem !== "chat") return porMensagem;
  const mime = minusculo(m.mimetype ?? textoDe(conteudo, "mimetype"));
  if (mime === "image/webp") return "sticker";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("application/") || mime.startsWith("text/")) return "document";
  // Sem `type` nenhum: o texto, se houver, é a mensagem.
  if (!tipo || porMensagem === "chat") return "chat";
  return null;
}

/** Dois números em dígitos são o mesmo? Ausente nunca é igual. */
function mesmoNumero(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a === b;
}

function lerMensagem(env: EnvelopeUazapi): EventoUazapi {
  const m = env.message;
  if (!m) return ignorado("mensagem_sem_corpo");
  const chatId = (m.chatid ?? env.chat?.wa_chatid ?? "").trim();
  if (!chatId) return ignorado("mensagem_sem_chat");
  if (m.isGroup === true || SUFIXOS_IGNORADOS.some((s) => chatId.endsWith(s))) return ignorado("grupo_ou_lista");
  if (!chatEnderecavel(chatId) || chatId.length > 128) return ignorado("chat_nao_reconhecido");
  if (m.wasSentByApi === true) return ignorado("eco_do_envio");

  const id = idDe(m);
  if (!id) return ignorado("mensagem_sem_id");

  const textoBruto = (m.text ?? "").trim();
  if (NAO_DECIFRADA.test(textoBruto)) return ignorado("mensagem_nao_decifrada");

  const conteudo = objetoDoConteudo(m.content);
  let tipo = tipoDe(m, conteudo, env.type);
  if (!tipo) return ignorado("tipo_sem_suporte");

  // `fromMe` ausente: é do celular só quando quem escreveu é o nosso número.
  const fromMe =
    m.fromMe ?? mesmoNumero(soDigitos(env.owner), soDigitos((m.sender_pn ?? m.sender ?? "").split("@")[0]));
  const ehLid = chatId.endsWith("@lid");
  // O telefone real do contato: na recebida, o `sender_pn` (quem escreveu); na
  // enviada pelo celular, o `sender_pn` é o NOSSO número, e só o `chat.phone`
  // diz de quem é a conversa. Se os dois discordam na recebida, não se escolhe:
  // a conversa segue pelo `@lid`, sem telefone.
  let telefoneAlternativo: string | null = null;
  if (ehLid) {
    const doChat = jidDeTelefone(env.chat?.phone);
    if (fromMe) telefoneAlternativo = doChat;
    else {
      const doRemetente = jidDeTelefone(m.sender_pn);
      telefoneAlternativo = doRemetente && doChat && doRemetente !== doChat ? null : (doRemetente ?? doChat);
    }
  }

  const textoDaMensagem = textoLegivel(m.text) ?? textoLegivel(textoDe(conteudo, "caption", "text"));
  const aninhado = objetoDoConteudo(conteudo?.location);
  const localizacao = tipo === "location" ? localizacaoDe([aninhado, conteudo, m]) : null;
  const vcard = tipo === "vcard" ? (textoDe(conteudo, "vcard", "vCard") ?? textoLegivel(m.vcard)) : null;
  // Pino sem coordenada legível (a localização em tempo real chega assim) e
  // cartão sem vCard ainda carregam o texto que a pessoa escreveu.
  if ((tipo === "location" && !localizacao) || (tipo === "vcard" && !vcard)) {
    if (!textoDaMensagem) return ignorado(tipo === "location" ? "localizacao_ilegivel" : "contato_sem_cartao");
    tipo = "chat";
  }
  if (tipo === "chat" && !textoDaMensagem) return ignorado("mensagem_vazia");

  const temMidia = ["image", "video", "audio", "ptt", "document", "sticker"].includes(tipo);
  const nome = fromMe
    ? null
    : (textoLegivel(m.senderName) ?? textoLegivel(env.chat?.wa_contactName) ?? textoLegivel(env.chat?.wa_name));

  return {
    tipo: "mensagem",
    mensagem: {
      id,
      chatId,
      fromMe,
      telefoneAlternativo,
      nome,
      texto: textoDaMensagem,
      tipo,
      temMidia,
      mime: temMidia ? (m.mimetype?.trim() || textoDe(conteudo, "mimetype")) : null,
      nomeDoArquivo: tipo === "document" ? (m.fileName?.trim() || textoDe(conteudo, "fileName", "title")) : null,
      timestamp: m.messageTimestamp,
      citadaId: m.quoted?.trim() || null,
      localizacao: tipo === "location" ? localizacao : null,
      vcard: tipo === "vcard" ? vcard : null,
    },
  };
}

/** O estado do recibo na régua de `ack`. `null` = estado que não muda nada. */
function ackDe(estado: string | null | undefined): number | null {
  switch ((estado ?? "").trim().toLowerCase()) {
    case "failed":
    case "canceled":
    case "cancelled":
    case "error":
      return -1;
    case "sent":
    case "serverack":
    case "server":
      return 1;
    case "delivered":
    case "deliveryack":
      return 2;
    case "read":
      return 3;
    case "played":
      return 4;
    default:
      // `queued`/`pending` (ainda não saiu) e `ReadSelf` (lida por mim noutro
      // aparelho) não mudam o estado de nada que enviamos.
      return null;
  }
}

function lerRecibo(env: EnvelopeUazapi): EventoUazapi {
  const e = env.event;
  if (e?.MessageIDs) {
    if (e.IsGroup === true || (env.type ?? "").toLowerCase() === "groupreceipts") return ignorado("grupo_ou_lista");
    // Recibo da mensagem que NÓS recebemos (o atendente leu): não é desfecho de envio.
    if (e.IsFromMe === false) return ignorado("recibo_de_mensagem_recebida");
    const ack = ackDe(env.state ?? e.Type);
    if (ack === null) return ignorado("recibo_sem_efeito");
    const ids = e.MessageIDs.map((v) => (typeof v === "string" ? idDe({ id: v }) : null)).filter(
      (v): v is string => v !== null,
    );
    return ids.length > 0 ? { tipo: "recibo", ids: [...new Set(ids)], ack } : ignorado("recibo_sem_id");
  }
  const m = env.message;
  if (m) {
    const id = idDe(m);
    const ack = ackDe(m.status);
    if (!id) return ignorado("recibo_sem_id");
    if (ack === null) return ignorado("recibo_sem_efeito");
    return { tipo: "recibo", ids: [id], ack };
  }
  return ignorado("recibo_sem_corpo");
}

/** O `type` do evento de conexão, quando `instance.status` não veio. */
const ESTADO_POR_TIPO: Record<string, EstadoDaInstancia> = {
  connected: "connected",
  connecting: "connecting",
  qr: "connecting",
  disconnected: "disconnected",
  loggedout: "disconnected",
  temporaryban: "disconnected",
};

function lerConexao(env: EnvelopeUazapi): EventoUazapi {
  const bruto = (env.instance?.status ?? "").trim().toLowerCase();
  const estado = (ESTADOS_DA_INSTANCIA as readonly string[]).includes(bruto)
    ? (bruto as EstadoDaInstancia)
    : ESTADO_POR_TIPO[(env.type ?? "").toLowerCase().replace(/_/g, "")];
  if (!estado) return ignorado("conexao_sem_estado");
  return {
    tipo: "conexao",
    estado,
    motivo: env.instance?.lastDisconnectReason?.trim().slice(0, 200) || null,
    numero: soDigitos(env.owner),
  };
}

/** O evento de domínio deste envelope já lido. */
export function eventoDoEnvelope(env: EnvelopeUazapi): EventoUazapi {
  switch (env.EventType) {
    case "messages":
      return lerMensagem(env);
    case "messages_update":
      return lerRecibo(env);
    case "connection":
      return lerConexao(env);
    default:
      return ignorado("evento_sem_interesse");
  }
}
