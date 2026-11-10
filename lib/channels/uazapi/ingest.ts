/**
 * Ingestão do canal UAZAPI: evento já lido e autenticado → efeitos no CRM.
 *
 * ─── Por que traduzir para a ingestão do outro número por QR ────────────────
 *
 * A UAZAPI é, por baixo, o mesmo tipo de linha que o outro canal por QR: um
 * aparelho pareado, com `@lid`, mensagem digitada no celular, recibo numérico de
 * entrega e leitura. A ingestão de lá (`lib/waha/ingest.ts`) já resolve, e com
 * catraca de teste, cada uma dessas coisas: contato pelo telefone OU pela
 * identidade opaca com o telefone real ao lado, a mensagem do celular que pausa
 * a IA (e o eco do nosso próprio envio que NÃO pausa), dedup pela unique de
 * `external_id`, pós-entrada, pedido de persistência da mídia, recibo monótono.
 * Uma segunda cópia disso divergiria na primeira correção.
 *
 * Então este módulo só TRADUZ: monta o payload que aquela ingestão lê, com as
 * formas de id que ela grava, e chama `dispatchWahaEvent`. O que é desta
 * plataforma e de mais ninguém fica aqui:
 *
 *  - as formas do id. Recebida grava `false_<chat>_<id>` e a do celular a
 *    cauda `<id>` — as mesmas que a ingestão de lá grava, e a cauda é o que o
 *    envio grava (`messageid`), então o eco casa com a linha do envio;
 *  - a mídia não vem com URL: vem só o id, e quem baixa é
 *    `fetchInboundMedia` do adapter, pelo `/message/download`. O `media_url`
 *    gravado é a marca `MARCA_DE_MIDIA + id`, que só esse adapter entende;
 *  - o evento de conexão grava o status e passa pelo vigia de saúde.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

import { uazapiAdapter } from "../adapters/uazapi";
import { sincronizarSaudeDaConexao } from "../health";
import { resolveUazapiCredsDaSessao } from "./credentials";
import { gravarEstadoDaSessao } from "./session";
import { MARCA_DE_MIDIA, type EventoUazapi, type MensagemUazapi } from "./webhook";

/** O id composto que a ingestão de recebida grava — o chat vem junto, como lá. */
export function idDeEntrada(m: Pick<MensagemUazapi, "chatId" | "id" | "fromMe">): string {
  return `${m.fromMe ? "true" : "false"}_${m.chatId}_${m.id}`;
}

/** A mensagem no formato que `dispatchWahaEvent` lê. Puro, para o teste provar. */
export function payloadDaMensagem(m: MensagemUazapi): WahaPayload {
  const contato =
    m.tipo === "vcard" && m.vcard ? { contactMessage: { vcard: m.vcard } } : undefined;
  return {
    id: idDeEntrada(m),
    from: m.fromMe ? null : m.chatId,
    to: m.fromMe ? m.chatId : null,
    fromMe: m.fromMe,
    body: m.tipo === "vcard" ? (m.vcard ?? m.texto) : m.texto,
    type: m.tipo,
    hasMedia: m.temMidia,
    timestamp: m.timestamp,
    ...(m.temMidia
      ? { media: { url: `${MARCA_DE_MIDIA}${m.id}`, mimetype: m.mime, filename: m.nomeDoArquivo } }
      : {}),
    ...(m.localizacao ? { location: m.localizacao } : {}),
    ...(m.citadaId ? { replyTo: { id: m.citadaId } } : {}),
    _data: {
      notifyName: m.nome,
      ...(m.telefoneAlternativo ? { key: { remoteJidAlt: m.telefoneAlternativo } } : {}),
      ...(contato ? { message: contato } : {}),
    },
  };
}

export interface SessaoDaEntrada {
  id: string;
  organization_id: string;
  display_name?: string | null;
  phone_number?: string | null;
}

export type DesfechoDaIngestao =
  | { status: "mensagem"; direcao: "recebida" | "do_celular" }
  | { status: "recibo"; mensagens: number }
  | { status: "conexao"; canal: string; aviso: string }
  | { status: "ignored"; reason: string };

/**
 * Aplica um evento já autenticado. Falha de escrita LANÇA — a rota responde 500
 * e o servidor reentrega, o que é seguro: a mensagem deduplica pela unique de
 * `external_id` e o recibo só avança.
 */
/** O apagamento pelo contrato do adapter; o método é opcional no tipo do contrato. */
async function apagarDoCelular(alvo: {
  organizationId: string;
  sessionRef: string;
  recipient: string | null;
  externalId: string;
}): Promise<void> {
  if (!uazapiAdapter.revokeMessage) throw new Error("uazapi_unknown: adapter sem revokeMessage");
  await uazapiAdapter.revokeMessage(alvo);
}

export async function ingestUazapiEvento(
  admin: SupabaseClient,
  sessao: SessaoDaEntrada,
  evento: EventoUazapi,
  requestId: string,
): Promise<DesfechoDaIngestao> {
  // A ingestão de lá apaga o `#on`/`#off` digitado no celular, para o cliente
  // não recebê-lo. Sem sessão do transporte dela (`waha_session_name` nulo), o
  // apagamento vai por este canal, pelo contrato do adapter (`revokeMessage`).
  const linha = {
    id: sessao.id,
    organization_id: sessao.organization_id,
    waha_session_name: null,
    is_warmup_complete: null,
    warmup_started_at: null,
    revogarNoCanal: async ({ chatId, messageId }: { chatId: string; messageId: string }) => {
      const creds = await resolveUazapiCredsDaSessao(admin, {
        organizationId: sessao.organization_id,
        channelSessionId: sessao.id,
      });
      if (!creds) throw new Error("uazapi_not_configured: sem credencial para apagar o comando");
      await apagarDoCelular({
        organizationId: sessao.organization_id,
        sessionRef: creds.instance,
        recipient: chatId,
        externalId: messageId,
      });
    },
  };

  if (evento.tipo === "ignorado") return { status: "ignored", reason: evento.motivo };

  if (evento.tipo === "mensagem") {
    const envelope: WahaEnvelope = { event: "message", payload: payloadDaMensagem(evento.mensagem) };
    await dispatchWahaEvent(admin, linha, envelope, requestId);
    return { status: "mensagem", direcao: evento.mensagem.fromMe ? "do_celular" : "recebida" };
  }

  if (evento.tipo === "recibo") {
    for (const id of evento.ids) {
      await dispatchWahaEvent(admin, linha, { event: "message.ack", payload: { id, ack: evento.ack } }, requestId);
    }
    return { status: "recibo", mensagens: evento.ids.length };
  }

  const { atual, phoneNumber } = await gravarEstadoDaSessao(admin, {
    organizationId: sessao.organization_id,
    channelSessionId: sessao.id,
    estado: evento.estado,
    numero: evento.numero,
  });
  // O servidor é a autoridade sobre a instância: o empurrão dele abre e fecha o
  // episódio na Central (`sincronizarSaudeDaConexao`), como no outro provedor.
  const aviso = await sincronizarSaudeDaConexao(
    admin,
    { id: sessao.id, organization_id: sessao.organization_id, status: atual, phone_number: phoneNumber },
    { reachable: true, status: atual, detail: atual === "WORKING" ? null : evento.motivo },
    sessao.display_name ?? sessao.phone_number ?? "sem nome",
    "empurrao",
  );
  return { status: "conexao", canal: atual, aviso };
}
