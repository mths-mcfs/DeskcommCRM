/**
 * Adapter do canal UAZAPI — número por QR numa instância do próprio cliente.
 *
 * Burro de propósito, como os irmãos: traduz formato e nada mais. Janela,
 * ritmo, aquecimento e horário vivem na cadeia `before_send`
 * (`docs/doctrine/restricao-de-canal.md`), que o `send` chama ANTES do HTTP.
 *
 * ─── A credencial é da SESSÃO ───────────────────────────────────────────────
 *
 * `isConfigured()` é `true` sempre (é síncrono e a credencial está no banco).
 * Quem desiste é o `send`, que LANÇA `uazapi_not_configured` quando a sessão
 * não tem URL e token — o handler traduz o prefixo para `queued` com o motivo.
 *
 * ─── Sem retry aqui dentro ──────────────────────────────────────────────────
 *
 * Envio que estourou o tempo ou levou 5xx é ambíguo: pode ter saído. Repetir às
 * cegas manda duas vezes ao cliente. O erro sobe com o prefixo `sendFailed`, e o
 * 429 com `throttled` e a espera pedida — o handler sabe reagendar esse.
 */
import { createAdminClient } from "@/lib/supabase/admin";

import { DETALHE_CREDENCIAL_RECUSADA } from "../health";
import { marcaDeEspera } from "../erro-da-plataforma";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";
import {
  apagarMensagem,
  baixarMidia,
  enviarContato,
  enviarMidia,
  enviarPresenca,
  enviarTexto,
  idDaMensagem,
  statusDaInstancia,
  statusDoCanal,
  UazapiErro,
  type TipoDeMidiaUazapi,
} from "../uazapi/client";
import { resolveUazapiCreds, type UazapiCredentials } from "../uazapi/credentials";
import { idDaMidiaGravada } from "../uazapi/webhook";

const NAO_CONFIGURADO = "uazapi_not_configured";
const FALHOU = "uazapi_send_failed";
const DESACELERE = "uazapi_throttled";

function digitosDoTelefone(v: string): string | null {
  const d = v.replace(/\D/g, "");
  return d.length >= 8 && d.length <= 15 ? d : null;
}

/**
 * O `number` que a API aceita: os dígitos do telefone, ou o chat `@lid` inteiro
 * quando a pessoa só é conhecida pela identidade opaca.
 */
export function numeroDoDestino(to: string): string | null {
  const alvo = to.trim();
  if (alvo.endsWith("@lid")) {
    const lid = alvo.slice(0, -"@lid".length);
    return /^\d{5,40}$/.test(lid) ? alvo : null;
  }
  if (alvo.includes("@") && !alvo.endsWith("@s.whatsapp.net") && !alvo.endsWith("@c.us")) return null;
  return digitosDoTelefone(alvo.split("@")[0] ?? "");
}

/**
 * O id que a API entende para citar uma mensagem: o do WhatsApp. A linha
 * recebida guarda `false_<chat>_<id>` e a enviada, a cauda — o que vem depois
 * do último `_`.
 */
function idParaCitar(externalId: string | null | undefined): string | null {
  if (!externalId) return null;
  const cauda = externalId.slice(externalId.lastIndexOf("_") + 1);
  return cauda || null;
}

const TIPO_DE_MIDIA: Partial<Record<OutboundEnvelope["kind"], TipoDeMidiaUazapi>> = {
  image: "image",
  video: "video",
  // Áudio do CRM sai como nota de voz — a bolha que o cliente reconhece.
  audio: "ptt",
  sticker: "sticker",
  document: "document",
};

async function credenciais(envelope: { organizationId: string; sessionRef: string }): Promise<UazapiCredentials> {
  const creds = await resolveUazapiCreds(createAdminClient(), {
    organizationId: envelope.organizationId,
    instance: envelope.sessionRef,
  });
  if (!creds) throw new Error(`${NAO_CONFIGURADO}: nenhuma credencial gravada para esta sessão.`);
  return creds;
}

/** A falha classificada vira o prefixo que o handler lê. Outra exceção sobe como está. */
function traduzirFalha(err: unknown): never {
  if (err instanceof UazapiErro) {
    if (err.tipo === "limite") {
      throw new Error(`${DESACELERE}: ${err.message}${marcaDeEspera(err.esperaSegundos)}`.slice(0, 400));
    }
    throw new Error(`${FALHOU}: ${err.message}`.slice(0, 400));
  }
  throw err;
}

export const uazapiAdapter: ChannelAdapter = {
  provider: "uazapi",

  resolveRecipient(input: RecipientInput): string | null {
    // Grupos ficam de fora nesta versão (a entrada também os ignora).
    if (input.isGroup) return null;
    if (input.phoneNumber) {
      const d = digitosDoTelefone(input.phoneNumber);
      if (d) return d;
    }
    if (input.waLid && /^\d{5,40}$/.test(input.waLid)) return `${input.waLid}@lid`;
    if (input.waIdentity?.startsWith("lid:")) {
      const lid = input.waIdentity.slice(4);
      if (/^\d{5,40}$/.test(lid)) return `${lid}@lid`;
    }
    return null;
  },

  isConfigured(): boolean {
    return true;
  },

  /** A forma de `messages.external_id`: o `messageid` do WhatsApp, sem o `<dono>:`. */
  canonicalExternalId(externalId: string): string {
    return idDaMensagem({ id: externalId }) ?? externalId;
  },

  codes: {
    notConfigured: NAO_CONFIGURADO,
    sendFailed: FALHOU,
    unknownError: "uazapi_unknown",
    throttled: DESACELERE,
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const creds = await credenciais(envelope);
    const number = numeroDoDestino(envelope.to);
    if (!number) throw new Error(`${FALHOU}: destino sem número utilizável.`);
    const replyid = idParaCitar(envelope.replyToExternalId);

    const tipoDeMidia = TIPO_DE_MIDIA[envelope.kind];
    if (envelope.kind === "contact" && !envelope.contact) {
      throw new Error(`${FALHOU}: cartão de contato sem os dados do contato.`);
    }
    if (tipoDeMidia && !envelope.media) {
      throw new Error(`${FALHOU}: envio de ${envelope.kind} sem o arquivo.`);
    }

    await envelope.beforeSend?.();
    try {
      if (envelope.kind === "contact" && envelope.contact) {
        return await enviarContato(creds, {
          number,
          fullName: envelope.contact.fullName,
          phoneNumber: envelope.contact.phoneNumber.replace(/\D/g, ""),
        });
      }
      if (tipoDeMidia && envelope.media) {
        return await enviarMidia(creds, {
          number,
          type: tipoDeMidia,
          file: envelope.media.url,
          text: envelope.media.caption ?? null,
          docName: tipoDeMidia === "document" ? (envelope.media.filename ?? null) : null,
          mimetype: envelope.media.mime,
          replyid,
        });
      }
      return await enviarTexto(creds, { number, text: envelope.body ?? "", replyid });
    } catch (err) {
      traduzirFalha(err);
    }
  },

  /** "Digitando…" por até 10 s; a resposta que chegar antes encerra. Best-effort no chamador. */
  async signalTyping(input: ChannelTenantScope & { sessionRef: string; recipient: string }): Promise<void> {
    const number = numeroDoDestino(input.recipient);
    if (!number) return;
    const creds = await credenciais(input);
    await enviarPresenca(creds, { number, presence: "composing", delayMs: 10_000 });
  },

  /**
   * Apaga para todos. Hoje só a ingestão chama: é o que esconde do cliente o
   * `#on`/`#off` que o atendente digitou no celular. Editar fica de fora
   * (`alteraMensagemEnviada: false`), e sem `editMessage` a rota de edição e
   * apagamento da tela segue recusando este canal.
   */
  async revokeMessage(input: ChannelTenantScope & { sessionRef: string; recipient: string | null; externalId: string }) {
    const messageId = idParaCitar(input.externalId);
    if (!messageId) throw new Error(`${FALHOU}: id da mensagem ilegível`);
    const creds = await credenciais(input);
    try {
      await apagarMensagem(creds, messageId);
    } catch (err) {
      traduzirFalha(err);
    }
  },

  /**
   * A mídia de uma mensagem RECEBIDA. A ingestão grava `media_url` como a marca
   * + id da mensagem (a plataforma não manda URL); daqui sai o `/message/download`.
   */
  async fetchInboundMedia(input) {
    const messageId = idDaMidiaGravada(input.url);
    if (!messageId) throw new Error("uazapi_media_url_invalida");
    const creds = await credenciais(input);
    return baixarMidia(creds, { messageId, hintMime: input.hintMime ?? null });
  },

  /**
   * `GET /instance/status`. Token recusado é a credencial que deixou de valer
   * (`FAILED`, com o detalhe de credencial que a Central entende); rede caída é
   * "não sei", que o vigia confirma antes de dar a queda.
   */
  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    let creds: UazapiCredentials | null;
    try {
      creds = await resolveUazapiCreds(createAdminClient(), {
        organizationId: input.organizationId,
        instance: input.sessionRef,
      });
    } catch (err) {
      return { reachable: false, status: null, detail: (err instanceof Error ? err.message : "erro").slice(0, 200) };
    }
    if (!creds) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };
    try {
      const instancia = await statusDaInstancia(creds);
      const status = statusDoCanal(instancia.estado);
      return { reachable: true, status, detail: status === "WORKING" ? null : instancia.motivoDaQueda };
    } catch (err) {
      if (err instanceof UazapiErro && err.tipo === "credencial_recusada") {
        return { reachable: true, status: "FAILED", detail: DETALHE_CREDENCIAL_RECUSADA };
      }
      return { reachable: false, status: null, detail: (err instanceof Error ? err.message : "erro").slice(0, 200) };
    }
  },
};
