/**
 * Cliente HTTP da UAZAPI (uazapiGO v2) — a BORDA do canal.
 *
 * Tudo o que vem do servidor do cliente passa por um schema aqui antes de virar
 * tipo do domínio: o servidor é de terceiro, pode ser de qualquer versão, e um
 * campo do tipo errado não pode virar exceção engolida lá na frente.
 *
 * ─── Regras do transporte ───────────────────────────────────────────────────
 *
 *  - O token da instância vai no header `token`, nunca na URL, e nunca entra em
 *    mensagem de erro nem em log.
 *  - Sem seguir redirect (`redirect: "manual"`): um 30x mandaria o header com o
 *    token para outro host.
 *  - Toda chamada (e o download do link de mídia) sai pelo `./transporte.ts`,
 *    que confere cada IP resolvido DENTRO do `lookup` do socket: a URL foi
 *    validada ao conectar, mas o DNS dela pode passar a apontar para dentro
 *    depois — inclusive entre a conferência e a conexão (rebinding). Só o modo
 *    de teste local (`UAZAPI_ALLOW_INSECURE_HTTP=true`) libera.
 *  - Teto de tempo em toda chamada. Sem retry aqui dentro: envio que estourou o
 *    tempo é AMBÍGUO (pode ter saído), e repetir às cegas duplica a mensagem no
 *    celular do cliente. Quem decide repetir é a fila do envio.
 *
 * ─── O que cada status quer dizer ───────────────────────────────────────────
 *
 *   401/403 → credencial recusada (token errado ou instância apagada)
 *   429     → limite de velocidade (com `retry-after`)
 *   463     → restrição do WhatsApp à conta (chega também como 500 com
 *             `provider_code: 463` no corpo — a doc mostra as duas formas)
 *   404     → não encontrado
 *   4xx     → pedido recusado
 *   5xx     → falha do servidor
 */
import { z } from "zod";

import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { MAX_MEDIA_BYTES, MediaTooLargeError } from "@/lib/messaging/media/types";

import { segundosDoRetryAfter } from "../erro-da-plataforma";
import { hostInternoPeloTexto, modoDeTesteLocal, type UazapiConexao } from "./credentials";
import { DestinoBloqueado, requisitar } from "./transporte";

/** Teto das chamadas de controle e de envio. */
const TETO_MS = 20_000;
/** Teto do download de mídia (arquivo de até 50 MB). */
const TETO_DOWNLOAD_MS = 60_000;
/** Resposta JSON maior que isto não é resposta da API. */
const MAX_RESPOSTA_BYTES = 1_048_576;

export type TipoDeFalhaUazapi =
  | "credencial_recusada"
  | "limite"
  | "restricao"
  | "nao_encontrado"
  | "recusado"
  | "servidor"
  | "rede"
  | "resposta_invalida"
  | "destino_bloqueado";

/** Falha classificada. A mensagem nunca carrega o token nem dado do cliente. */
export class UazapiErro extends Error {
  readonly tipo: TipoDeFalhaUazapi;
  readonly status: number | null;
  /** Segundos pedidos no `retry-after` (só em `limite`). */
  readonly esperaSegundos: number | null;

  constructor(tipo: TipoDeFalhaUazapi, detalhe: string, status: number | null = null, esperaSegundos: number | null = null) {
    super(`${tipo}${status !== null ? ` ${status}` : ""}: ${detalhe}`.slice(0, 300));
    this.name = "UazapiErro";
    this.tipo = tipo;
    this.status = status;
    this.esperaSegundos = esperaSegundos;
  }
}

/** O corpo de erro que a API documenta — só os campos que o código lê. */
const corpoDeErroSchema = z.looseObject({
  error: z.string().nullish(),
  message: z.string().nullish(),
  provider_code: z.union([z.number(), z.string()]).nullish(),
});

function detalheDoErro(corpo: unknown): { texto: string; restricao: boolean } {
  const lido = corpoDeErroSchema.safeParse(corpo);
  if (!lido.success) return { texto: "", restricao: false };
  const texto = (lido.data.error ?? lido.data.message ?? "").slice(0, 200);
  return { texto, restricao: String(lido.data.provider_code ?? "") === "463" };
}

function jsonOuNulo(texto: string): unknown {
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

/** A exceção do transporte, classificada. O detalhe nunca leva o token. */
function falhaDeTransporte(err: unknown, semResposta: string): UazapiErro {
  if (err instanceof DestinoBloqueado) return new UazapiErro("destino_bloqueado", err.message.replace(/^destino_bloqueado: /, ""));
  const nome = err instanceof Error ? err.name : "erro";
  return new UazapiErro("rede", nome === "TimeoutError" || nome === "AbortError" ? "tempo esgotado" : semResposta);
}

/**
 * O destino pode receber a chamada? Conferência ANTECIPADA, para falhar antes
 * de montar a requisição; a que vale para o IP realmente usado é a do
 * transporte (`./transporte.ts`), dentro do `lookup` do socket. Fora do modo
 * de teste local, o host não pode ser interno nem pelo texto nem pelo DNS.
 */
async function conferirDestino(url: URL): Promise<void> {
  if (modoDeTesteLocal()) return;
  if (hostInternoPeloTexto(url.hostname)) throw new UazapiErro("destino_bloqueado", "endereço interno");
  try {
    await assertDestinoResolvidoSeguro(url.hostname.replace(/^\[(.*)\]$/, "$1"));
  } catch {
    throw new UazapiErro("destino_bloqueado", "o endereço não resolve para um destino permitido");
  }
}

/**
 * Uma chamada à API, devolvendo o corpo JSON ainda `unknown` — quem chama o
 * passa pelo schema da resposta que espera.
 */
async function chamar(
  conexao: UazapiConexao,
  metodo: "GET" | "POST",
  caminho: string,
  corpo?: Record<string, unknown>,
): Promise<unknown> {
  let destino: URL;
  try {
    destino = new URL(`${conexao.baseUrl}${caminho}`);
  } catch {
    throw new UazapiErro("destino_bloqueado", "URL do servidor inválida");
  }
  await conferirDestino(destino);
  let res: Response;
  try {
    res = await requisitar(
      destino,
      {
        method: metodo,
        headers: {
          token: conexao.token,
          Accept: "application/json",
          ...(corpo ? { "Content-Type": "application/json" } : {}),
        },
        ...(corpo ? { body: JSON.stringify(corpo) } : {}),
        signal: AbortSignal.timeout(TETO_MS),
      },
      { liberarInterno: modoDeTesteLocal() },
    );
  } catch (err) {
    throw falhaDeTransporte(err, "sem resposta do servidor");
  }

  const texto = await res.text().catch(() => "");
  if (texto.length > MAX_RESPOSTA_BYTES) {
    throw new UazapiErro("resposta_invalida", "resposta grande demais", res.status);
  }
  const json = jsonOuNulo(texto);
  classificar(res, json);
  if (json === null || typeof json !== "object") {
    throw new UazapiErro("resposta_invalida", "a resposta não é JSON", res.status);
  }
  return json;
}

/** Lança a falha que o status (e o corpo) descreve; não faz nada num 2xx limpo. */
function classificar(res: Response, json: unknown): void {
  const { texto, restricao } = detalheDoErro(json);
  if (res.status === 463 || restricao) {
    throw new UazapiErro("restricao", texto || "restrição do WhatsApp à conta", res.status);
  }
  if (res.status >= 200 && res.status < 300) return;
  if (res.status >= 300 && res.status < 400) {
    throw new UazapiErro("resposta_invalida", "redirecionamento recusado", res.status);
  }
  if (res.status === 401 || res.status === 403) {
    throw new UazapiErro("credencial_recusada", texto || "token recusado", res.status);
  }
  if (res.status === 429) {
    throw new UazapiErro(
      "limite",
      texto || "limite de requisições",
      res.status,
      segundosDoRetryAfter(res.headers.get("retry-after")),
    );
  }
  if (res.status === 404) throw new UazapiErro("nao_encontrado", texto || "não encontrado", res.status);
  if (res.status >= 500) throw new UazapiErro("servidor", texto || "erro do servidor", res.status);
  throw new UazapiErro("recusado", texto || "pedido recusado", res.status);
}

function falhaDeFormato(caminho: string, erro: z.ZodError): UazapiErro {
  const campos = [...new Set(erro.issues.map((i) => i.path.join(".") || "(raiz)"))].join(", ");
  return new UazapiErro("resposta_invalida", `${caminho} fora do formato esperado: ${campos}`.slice(0, 200));
}

// ─── Estado da instância ──────────────────────────────────────────────────

export const ESTADOS_DA_INSTANCIA = ["connected", "connecting", "disconnected", "hibernated"] as const;
export type EstadoDaInstancia = (typeof ESTADOS_DA_INSTANCIA)[number];

/**
 * O status que o resto do CRM entende (`CHANNEL_STATUSES`). Só `connected`
 * envia; `connecting` é o QR esperando leitura; parado ou hibernado é parado.
 */
export function statusDoCanal(estado: EstadoDaInstancia): "WORKING" | "SCAN_QR_CODE" | "STOPPED" {
  if (estado === "connected") return "WORKING";
  if (estado === "connecting") return "SCAN_QR_CODE";
  return "STOPPED";
}

const instanciaSchema = z.looseObject({
  name: z.string().nullish(),
  status: z.string().nullish(),
  qrcode: z.string().nullish(),
  paircode: z.string().nullish(),
  profileName: z.string().nullish(),
  owner: z.string().nullish(),
  lastDisconnectReason: z.string().nullish(),
});

const statusSchema = z.looseObject({
  instance: instanciaSchema.nullish(),
  status: z
    .looseObject({ connected: z.boolean().nullish(), loggedIn: z.boolean().nullish() })
    .nullish(),
  connected: z.boolean().nullish(),
  loggedIn: z.boolean().nullish(),
});

export interface InstanciaUazapi {
  /** O nome da instância no servidor — o `sessionRef` deste canal. */
  nome: string;
  estado: EstadoDaInstancia;
  /** O QR já como data URI (`data:image/png;base64,…`), quando há um. */
  qrcode: string | null;
  paircode: string | null;
  nomeDoPerfil: string | null;
  /** O número do aparelho pareado, em dígitos. */
  numero: string | null;
  motivoDaQueda: string | null;
}

/**
 * O estado de verdade: `instance.status` vence; sem ele, as marcas
 * `connected`/`loggedIn`. Só `connected` é pronto para enviar.
 */
function estadoDe(dados: z.infer<typeof statusSchema>): EstadoDaInstancia {
  const bruto = (dados.instance?.status ?? "").trim().toLowerCase();
  if ((ESTADOS_DA_INSTANCIA as readonly string[]).includes(bruto)) return bruto as EstadoDaInstancia;
  const marcas = [dados.status?.connected, dados.status?.loggedIn, dados.connected, dados.loggedIn];
  return marcas.some((m) => m === true) ? "connected" : "disconnected";
}

/** O QR vem como data URI ou como base64 cru, conforme o servidor. */
export function qrComoDataUri(bruto: string | null | undefined): string | null {
  const texto = (bruto ?? "").trim();
  if (!texto) return null;
  if (texto.startsWith("data:image/")) return texto;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(texto)) return null;
  return `data:image/png;base64,${texto.replace(/\s+/g, "")}`;
}

function digitos(v: string | null | undefined): string | null {
  const d = (v ?? "").replace(/\D/g, "");
  return d.length >= 8 && d.length <= 15 ? d : null;
}

function lerInstancia(caminho: string, json: unknown): InstanciaUazapi {
  const lido = statusSchema.safeParse(json);
  if (!lido.success) throw falhaDeFormato(caminho, lido.error);
  const nome = (lido.data.instance?.name ?? "").trim();
  if (!nome) throw new UazapiErro("resposta_invalida", `${caminho} sem o nome da instância`);
  const estado = estadoDe(lido.data);
  return {
    nome,
    estado,
    // QR só faz sentido enquanto não conectou; o servidor às vezes deixa o
    // último lá depois de parear.
    qrcode: estado === "connected" ? null : qrComoDataUri(lido.data.instance?.qrcode),
    paircode: estado === "connected" ? null : (lido.data.instance?.paircode?.trim() || null),
    nomeDoPerfil: lido.data.instance?.profileName?.trim() || null,
    numero: digitos(lido.data.instance?.owner),
    motivoDaQueda: lido.data.instance?.lastDisconnectReason?.trim().slice(0, 200) || null,
  };
}

/** `GET /instance/status`. */
export async function statusDaInstancia(conexao: UazapiConexao): Promise<InstanciaUazapi> {
  return lerInstancia("/instance/status", await chamar(conexao, "GET", "/instance/status"));
}

/**
 * `POST /instance/connect` — pede um QR novo (corpo vazio) ou um código de
 * pareamento (`phone`). Devolve o estado logo depois do pedido.
 */
export async function conectarInstancia(
  conexao: UazapiConexao,
  opcoes: { phone?: string } = {},
): Promise<InstanciaUazapi> {
  const json = await chamar(conexao, "POST", "/instance/connect", opcoes.phone ? { phone: opcoes.phone } : {});
  return lerInstancia("/instance/connect", json);
}

// ─── Webhook ──────────────────────────────────────────────────────────────

/** Os eventos que o CRM lê. Grupo, presença e o resto ficam de fora. */
export const EVENTOS_DO_WEBHOOK = ["messages", "messages_update", "connection"] as const;

/**
 * `POST /webhook` no modo simples (um webhook por instância), apontando para a
 * entrada do CRM. `wasSentByApi` fica de fora: é o eco do nosso próprio envio,
 * que o envio já gravou.
 */
export async function configurarWebhook(conexao: UazapiConexao, url: string): Promise<void> {
  await chamar(conexao, "POST", "/webhook", {
    enabled: true,
    url,
    events: [...EVENTOS_DO_WEBHOOK],
    excludeMessages: ["wasSentByApi"],
    addUrlEvents: false,
    addUrlTypesMessages: false,
  });
}

/** Desliga o webhook do modo simples — o par do `configurarWebhook`. */
export async function desligarWebhook(conexao: UazapiConexao, url: string): Promise<void> {
  await chamar(conexao, "POST", "/webhook", { enabled: false, url, events: [] });
}

// ─── Envio ────────────────────────────────────────────────────────────────

const respostaDeEnvioSchema = z.looseObject({
  id: z.string().nullish(),
  messageid: z.string().nullish(),
});

/**
 * O id que o WhatsApp deu à mensagem. A API devolve dois: `messageid` (o do
 * WhatsApp, o mesmo que volta nos recibos e no webhook) e `id`
 * (`<dono>:<messageid>`). Vale o primeiro; sem ele, a cauda do segundo.
 */
export function idDaMensagem(dados: { id?: string | null; messageid?: string | null }): string | null {
  const direto = dados.messageid?.trim();
  if (direto) return direto;
  const composto = dados.id?.trim();
  if (!composto) return null;
  const corte = composto.lastIndexOf(":");
  return corte === -1 ? composto : composto.slice(corte + 1) || null;
}

async function enviar(
  conexao: UazapiConexao,
  caminho: "/send/text" | "/send/media" | "/send/contact",
  corpo: Record<string, unknown>,
): Promise<{ externalId: string | null }> {
  // `async: false`: a resposta só sai depois de o WhatsApp aceitar, e traz o id.
  const json = await chamar(conexao, "POST", caminho, { ...corpo, async: false });
  const lido = respostaDeEnvioSchema.safeParse(json);
  if (!lido.success) throw falhaDeFormato(caminho, lido.error);
  return { externalId: idDaMensagem(lido.data) };
}

export function enviarTexto(
  conexao: UazapiConexao,
  input: { number: string; text: string; replyid?: string | null },
): Promise<{ externalId: string | null }> {
  return enviar(conexao, "/send/text", {
    number: input.number,
    text: input.text,
    ...(input.replyid ? { replyid: input.replyid } : {}),
  });
}

export type TipoDeMidiaUazapi = "image" | "video" | "document" | "audio" | "ptt" | "sticker";

export function enviarMidia(
  conexao: UazapiConexao,
  input: {
    number: string;
    type: TipoDeMidiaUazapi;
    file: string;
    text?: string | null;
    docName?: string | null;
    mimetype?: string | null;
    replyid?: string | null;
  },
): Promise<{ externalId: string | null }> {
  return enviar(conexao, "/send/media", {
    number: input.number,
    type: input.type,
    file: input.file,
    ...(input.text ? { text: input.text } : {}),
    ...(input.docName ? { docName: input.docName } : {}),
    ...(input.mimetype ? { mimetype: input.mimetype } : {}),
    ...(input.replyid ? { replyid: input.replyid } : {}),
  });
}

export function enviarContato(
  conexao: UazapiConexao,
  input: { number: string; fullName: string; phoneNumber: string },
): Promise<{ externalId: string | null }> {
  return enviar(conexao, "/send/contact", input);
}

export type PresencaUazapi = "composing" | "recording" | "paused";

/** `POST /message/presence` — "digitando…" por `delayMs` (o servidor reenvia sozinho). */
export async function enviarPresenca(
  conexao: UazapiConexao,
  input: { number: string; presence: PresencaUazapi; delayMs: number },
): Promise<void> {
  await chamar(conexao, "POST", "/message/presence", {
    number: input.number,
    presence: input.presence,
    delay: Math.max(1, Math.min(300_000, Math.round(input.delayMs))),
  });
}

/**
 * `POST /message/delete` — apaga para todos. A API aceita o id curto (o
 * `messageid` do WhatsApp) e o associa à instância autenticada.
 */
export async function apagarMensagem(conexao: UazapiConexao, messageId: string): Promise<void> {
  await chamar(conexao, "POST", "/message/delete", { id: messageId });
}

// ─── Mídia recebida ───────────────────────────────────────────────────────

const respostaDeDownloadSchema = z.looseObject({
  fileURL: z.string().nullish(),
  mimetype: z.string().nullish(),
  base64Data: z.string().nullish(),
});

export interface ArquivoBaixado {
  buffer: Buffer;
  mime: string;
}

/** O mime limpo (`image/jpeg; x=y` → `image/jpeg`); `null` quando não parece mime. */
function mimeLimpo(bruto: string | null | undefined): string | null {
  const m = (bruto ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m) ? m : null;
}

/**
 * A mídia de uma mensagem recebida: `POST /message/download` pede o link
 * (válido por 2 dias, baixável sem token) e o arquivo é baixado dele — ou vem
 * em base64 quando o servidor manda assim.
 *
 * O link é de FORA. Só é seguido se for `https` (ou o mesmo protocolo da base,
 * no modo de teste local), no MESMO host e porta do servidor configurado (como
 * faz o app que já roda com este servidor), sem usuário na URL, sem redirect e
 * passando pela mesma guarda de destino das chamadas — senão um servidor
 * comprometido apontaria o CRM para a rede interna dele.
 */
export async function baixarMidia(
  conexao: UazapiConexao,
  input: { messageId: string; hintMime?: string | null },
): Promise<ArquivoBaixado> {
  const json = await chamar(conexao, "POST", "/message/download", {
    id: input.messageId,
    return_link: true,
    return_base64: false,
    generate_mp3: false,
    transcribe: false,
  });
  const lido = respostaDeDownloadSchema.safeParse(json);
  if (!lido.success) throw falhaDeFormato("/message/download", lido.error);
  const mimeDaApi = mimeLimpo(lido.data.mimetype) ?? mimeLimpo(input.hintMime) ?? "application/octet-stream";

  const base64 = lido.data.base64Data?.trim();
  if (base64) {
    const sem = base64.replace(/^data:[^,]*,/, "");
    if (Math.floor((sem.length * 3) / 4) > MAX_MEDIA_BYTES) throw new MediaTooLargeError();
    return { buffer: Buffer.from(sem, "base64"), mime: mimeDaApi };
  }

  const link = lido.data.fileURL?.trim();
  if (!link) throw new UazapiErro("resposta_invalida", "/message/download sem fileURL nem base64Data");
  return baixarDoLink(conexao, link, mimeDaApi);
}

function linkConfiavel(conexao: UazapiConexao, link: string): URL | null {
  let alvo: URL;
  let base: URL;
  try {
    alvo = new URL(link);
    base = new URL(conexao.baseUrl);
  } catch {
    return null;
  }
  if (alvo.username || alvo.password) return null;
  if (alvo.protocol !== "https:" && !(alvo.protocol === base.protocol && base.protocol === "http:")) return null;
  if (alvo.hostname !== base.hostname || alvo.port !== base.port) return null;
  return alvo;
}

async function baixarDoLink(conexao: UazapiConexao, link: string, mimeDaApi: string): Promise<ArquivoBaixado> {
  const alvo = linkConfiavel(conexao, link);
  if (!alvo) throw new UazapiErro("resposta_invalida", "link de download fora do servidor configurado");
  await conferirDestino(alvo);

  let res: Response;
  try {
    res = await requisitar(
      alvo,
      { method: "GET", signal: AbortSignal.timeout(TETO_DOWNLOAD_MS) },
      { liberarInterno: modoDeTesteLocal() },
    );
  } catch (err) {
    throw falhaDeTransporte(err, "download sem resposta");
  }
  if (res.status >= 300 && res.status < 400) {
    throw new UazapiErro("resposta_invalida", "redirecionamento recusado no download", res.status);
  }
  if (!res.ok) {
    throw new UazapiErro(res.status >= 500 ? "servidor" : "recusado", "download recusado", res.status);
  }
  const declarado = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declarado) && declarado > MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const buffer = await lerComTeto(res);
  return { buffer, mime: mimeLimpo(res.headers.get("content-type")) ?? mimeDaApi };
}

/** Lê o corpo parando no teto do bucket — `content-length` pode mentir ou faltar. */
async function lerComTeto(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const leitor = res.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MEDIA_BYTES) {
      await leitor.cancel().catch(() => undefined);
      throw new MediaTooLargeError();
    }
    partes.push(value);
  }
  return Buffer.concat(partes);
}
