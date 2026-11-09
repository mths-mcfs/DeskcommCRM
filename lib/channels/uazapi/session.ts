/**
 * Persistência da sessão do canal UAZAPI — do lado de dentro do seam.
 *
 * A rota e a tela não nomeiam o provider nem as colunas dele (invariante 1 de
 * `docs/doctrine/restricao-de-canal.md`, vigiado por `lint:channels`): elas
 * falam com `../instancia-propria.ts`, que fala com isto aqui.
 *
 * Toda consulta leva `organization_id` À MÃO: o client é de service role e
 * ignora a RLS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { logger } from "@/lib/logger";

import { CHANNEL_PROVIDER_UAZAPI } from "../capabilities";
import { reactivateChannelSession } from "../reactivate";
import { statusDoCanal, type EstadoDaInstancia } from "./client";

export { statusDoCanal };

export interface UazapiSession {
  id: string;
  instance: string | null;
  baseUrl: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  status: string | null;
  webhookPathToken: string | null;
  hasToken: boolean;
  archivedAt: string | null;
}

const COLUNAS =
  "id, uazapi_instance, uazapi_base_url, uazapi_token_encrypted, phone_number, display_name, status, webhook_path_token, archived_at";

function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function toSessao(row: Record<string, unknown> | null): UazapiSession | null {
  const id = textoOuNulo(row?.id);
  if (!row || !id) return null;
  return {
    id,
    instance: textoOuNulo(row.uazapi_instance),
    baseUrl: textoOuNulo(row.uazapi_base_url),
    displayName: textoOuNulo(row.display_name),
    phoneNumber: textoOuNulo(row.phone_number),
    status: textoOuNulo(row.status),
    webhookPathToken: textoOuNulo(row.webhook_path_token),
    hasToken: Boolean(row.uazapi_token_encrypted),
    archivedAt: textoOuNulo(row.archived_at),
  };
}

/**
 * A sessão deste canal na organização — a ATIVA primeiro. Reconectar por cima de
 * uma arquivada traz a linha de volta, não cria outra ao lado.
 *
 * Uma por organização nesta versão (como os parceiros): a tela conecta UMA
 * instância. LANÇA quando a consulta falha.
 */
export async function findUazapiSession(admin: SupabaseClient, organizationId: string): Promise<UazapiSession | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provider", CHANNEL_PROVIDER_UAZAPI)
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`uazapi_session_lookup_failed: ${error.message}`);
  return toSessao((data as Record<string, unknown>[] | null)?.[0] ?? null);
}

/**
 * Grava (ou ressuscita) a sessão com a credencial recém-validada.
 *
 * O `webhook_secret_encrypted` recebe a IMPRESSÃO do token (`impressaoDoToken`),
 * cifrada: é contra ela que a entrada confere o `token` que vem no corpo. Troca
 * junto com o token — reconectar com outro token não pode deixar a entrada
 * aceitando o antigo.
 */
export async function saveUazapiSession(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existente: UazapiSession | null;
    instance: string;
    baseUrl: string;
    tokenEncrypted: string;
    /** A impressão do token (SHA-256 hex): a chave única da instância entre as contas. */
    impressao: string;
    impressaoCifrada: string;
    phoneNumber: string | null;
    displayName: string;
    estado: EstadoDaInstancia;
    userId: string;
    requestId: string;
  },
): Promise<{ error: string | null; channelSessionId: string | null }> {
  const agora = new Date().toISOString();
  const linha = {
    organization_id: input.organizationId,
    provider: CHANNEL_PROVIDER_UAZAPI,
    uazapi_instance: input.instance,
    uazapi_base_url: input.baseUrl,
    uazapi_token_encrypted: input.tokenEncrypted,
    uazapi_token_fingerprint: input.impressao,
    webhook_secret_encrypted: input.impressaoCifrada,
    phone_number: input.phoneNumber,
    display_name: input.displayName,
    status: statusDoCanal(input.estado),
    last_status_change_at: agora,
  };

  if (input.existente) {
    const r = await reactivateChannelSession(
      admin,
      {
        organizationId: input.organizationId,
        channelSessionId: input.existente.id,
        archivedAt: input.existente.archivedAt,
      },
      linha,
      {
        userId: input.userId,
        requestId: input.requestId,
        metadata: { provider: CHANNEL_PROVIDER_UAZAPI, phone_number: input.phoneNumber },
      },
    );
    return { error: r.error?.message ?? null, channelSessionId: input.existente.id };
  }

  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      ...linha,
      metadata: metadataInicialDoCanal(),
    })
    .select("id")
    .maybeSingle();
  return {
    error: error?.message ?? null,
    channelSessionId: textoOuNulo((data as { id?: unknown } | null)?.id),
  };
}

/**
 * Grava o estado observado agora (pela tela que acompanha o QR, pela consulta
 * de status ou pelo evento de conexão). O número segue o que o servidor diz:
 * se outro aparelho foi pareado na mesma instância, o número da conexão passa
 * a ser o dele. Sem número no relato (aparelho desconectado), fica o anterior.
 *
 * O status e o número são escritos em separado: o número esbarra no
 * `channel_sessions_phone_per_org_unique` quando a organização já tem OUTRA
 * conexão com ele, e esse conflito não pode impedir o status de ser gravado.
 *
 * Devolve o status ANTERIOR, para quem chamou decidir se houve mudança.
 */
export async function gravarEstadoDaSessao(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    channelSessionId: string;
    estado: EstadoDaInstancia;
    numero: string | null;
  },
): Promise<{ anterior: string | null; atual: string; phoneNumber: string | null }> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("status, phone_number")
    .eq("organization_id", input.organizationId)
    .eq("id", input.channelSessionId)
    .eq("provider", CHANNEL_PROVIDER_UAZAPI)
    .maybeSingle();
  if (error) throw new Error(`uazapi_session_lookup_failed: ${error.message}`);
  const linha = (data ?? {}) as { status?: unknown; phone_number?: unknown };
  const anterior = textoOuNulo(linha.status);
  const telefoneAtual = textoOuNulo(linha.phone_number);
  const atual = statusDoCanal(input.estado);
  const relatado = input.numero ? `+${input.numero}` : null;

  if (anterior !== atual) {
    const { error: erroDaEscrita } = await admin
      .from("channel_sessions")
      .update({ status: atual, last_status_change_at: new Date().toISOString() })
      .eq("organization_id", input.organizationId)
      .eq("id", input.channelSessionId)
      .eq("provider", CHANNEL_PROVIDER_UAZAPI);
    if (erroDaEscrita) throw new Error(`uazapi_session_update_failed: ${erroDaEscrita.message}`);
  }

  let telefone = telefoneAtual;
  if (relatado && relatado !== telefoneAtual) {
    const { error: erroDoNumero } = await admin
      .from("channel_sessions")
      .update({ phone_number: relatado })
      .eq("organization_id", input.organizationId)
      .eq("id", input.channelSessionId)
      .eq("provider", CHANNEL_PROVIDER_UAZAPI);
    if (!erroDoNumero) telefone = relatado;
    else if (erroDoNumero.code === "23505") {
      logger.warn("[uazapi] número novo já pertence a outra conexão desta organização", {
        organization_id: input.organizationId,
        channel_session_id: input.channelSessionId,
      });
    } else throw new Error(`uazapi_session_update_failed: ${erroDoNumero.message}`);
  }
  return { anterior, atual, phoneNumber: telefone };
}
