/**
 * "Instância própria" — conectar um número por QR que roda no servidor do
 * PRÓPRIO cliente (hoje: UAZAPI), do jeito que a rota e a tela enxergam.
 *
 * A rota (`app/api/v1/channels/instancia-propria`) e a aba de Conexões não podem
 * nomear o provider nem as colunas dele (invariante 1 da doutrina,
 * `lint:channels`); elas falam com este módulo, em termos de "o servidor", "o
 * token", "o QR". Quem é o provider e como se fala com ele mora em `./uazapi/`.
 *
 * ─── O que conectar faz, na ordem em que dá errado ──────────────────────────
 *
 *  1. Valida a URL (https, sem credencial embutida) e o token contra o próprio
 *     servidor (`/instance/status`) ANTES de gravar: gravar primeiro é o
 *     operador achando que conectou até a primeira mensagem que não sai.
 *  2. Grava a sessão com o token cifrado (e a impressão dele, que a entrada
 *     confere contra o token que vem no corpo do webhook).
 *  3. Aponta o webhook da instância para a entrada do CRM. Se o servidor
 *     recusar, a conexão fica gravada e a tela diz que o CRM não recebe.
 *  4. Se o aparelho ainda não está pareado, pede o QR.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { CHANNEL_PROVIDER_UAZAPI } from "./capabilities";
import {
  conectarInstancia,
  configurarWebhook,
  desligarWebhook,
  statusDaInstancia,
  UazapiErro,
  type InstanciaUazapi,
} from "./uazapi/client";
import { lerBaseUrl, resolveUazapiCredsDaSessao, UAZAPI_LABEL } from "./uazapi/credentials";
import { findUazapiSession, gravarEstadoDaSessao, saveUazapiSession } from "./uazapi/session";
import { impressaoDoToken } from "./uazapi/webhook";

/** Como a aba e o cartão chamam este canal — vem do servidor, a tela não escreve a marca. */
export const ROTULO_DA_INSTANCIA_PROPRIA = UAZAPI_LABEL;

/** O que a tela mostra. Nenhum segredo sai daqui: só se ele existe. */
export interface EstadoDaInstanciaPropria {
  label: string;
  connected: boolean;
  channel_session_id: string | null;
  /** `WORKING` · `SCAN_QR_CODE` · `STOPPED` · `FAILED` — o vocabulário de todo canal. */
  status: string | null;
  base_url: string | null;
  instance: string | null;
  has_token: boolean;
  phone_number: string | null;
  display_name: string | null;
  /** Data URI do QR, só enquanto o aparelho não pareou. */
  qrcode: string | null;
  paircode: string | null;
  /** O que impediu de ler o estado agora, quando houve (texto para a pessoa). */
  aviso: string | null;
}

export type Recusa = { ok: false; status: 409 | 422 | 502; code: string; motivo: string };

/**
 * O texto para a pessoa. Falha de rede, resposta que não é da API, destino
 * recusado e erro do servidor dizem a MESMA coisa: textos diferentes deixariam
 * quem cola URLs na tela descobrir quais portas respondem num host (mapear a
 * rede pela tela). Só o que a pessoa resolve sozinha ganha texto próprio.
 */
export const FALHA_AO_FALAR_COM_O_SERVIDOR =
  "Não foi possível conectar ao servidor nesse endereço. Confira a URL e o token e tente de novo.";

function motivoDaFalha(err: unknown): string {
  if (err instanceof UazapiErro && err.tipo === "credencial_recusada") return "O servidor recusou o token da instância.";
  if (err instanceof UazapiErro && err.tipo === "limite") {
    return "O servidor pediu para esperar um pouco. Tente de novo em instantes.";
  }
  return FALHA_AO_FALAR_COM_O_SERVIDOR;
}

function vazio(): EstadoDaInstanciaPropria {
  return {
    label: ROTULO_DA_INSTANCIA_PROPRIA,
    connected: false,
    channel_session_id: null,
    status: null,
    base_url: null,
    instance: null,
    has_token: false,
    phone_number: null,
    display_name: null,
    qrcode: null,
    paircode: null,
    aviso: null,
  };
}

/**
 * O estado da conexão desta organização. Com `aoVivo`, e o aparelho ainda não
 * pareado, pergunta ao servidor (é o que traz o QR atualizado) e grava o status
 * observado — a tela consulta de tempos em tempos enquanto espera a leitura.
 */
export async function estadoDaInstanciaPropria(
  admin: SupabaseClient,
  organizationId: string,
  opcoes: { aoVivo: boolean },
): Promise<EstadoDaInstanciaPropria> {
  const sessao = await findUazapiSession(admin, organizationId);
  if (!sessao || sessao.archivedAt) return vazio();

  const estado: EstadoDaInstanciaPropria = {
    ...vazio(),
    connected: sessao.status === "WORKING",
    channel_session_id: sessao.id,
    status: sessao.status,
    base_url: sessao.baseUrl,
    instance: sessao.instance,
    has_token: sessao.hasToken,
    phone_number: sessao.phoneNumber,
    display_name: sessao.displayName,
  };
  if (!opcoes.aoVivo) return estado;

  const creds = await resolveUazapiCredsDaSessao(admin, { organizationId, channelSessionId: sessao.id });
  if (!creds) return { ...estado, aviso: "A credencial gravada não pôde ser lida. Conecte de novo." };
  try {
    const instancia = await statusDaInstancia(creds);
    const gravado = await gravarEstadoDaSessao(admin, {
      organizationId,
      channelSessionId: sessao.id,
      estado: instancia.estado,
      numero: instancia.numero,
    });
    return comInstancia({ ...estado, status: gravado.atual, phone_number: gravado.phoneNumber }, instancia);
  } catch (err) {
    return { ...estado, aviso: motivoDaFalha(err) };
  }
}

function comInstancia(estado: EstadoDaInstanciaPropria, instancia: InstanciaUazapi): EstadoDaInstanciaPropria {
  return {
    ...estado,
    connected: instancia.estado === "connected",
    qrcode: instancia.qrcode,
    paircode: instancia.paircode,
  };
}

/**
 * Valida, grava, aponta o webhook e pede o QR. `webhookBase` é a raiz pública
 * desta instalação (a rota a resolve pela requisição).
 */
export async function conectarInstanciaPropria(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    baseUrl: string;
    token: string;
    webhookBase: string;
    userId: string;
    requestId: string;
  },
): Promise<
  | { ok: true; estado: EstadoDaInstanciaPropria; webhookConfigurado: boolean; nova: boolean; channelSessionId: string }
  | Recusa
> {
  const url = lerBaseUrl(input.baseUrl);
  if (!url.ok) return { ok: false, status: 422, code: "invalid_request", motivo: url.motivo };
  const token = input.token.trim();
  if (token.length < 8 || token.length > 512) {
    return { ok: false, status: 422, code: "invalid_request", motivo: "Informe o token da instância." };
  }
  const conexao = { baseUrl: url.baseUrl, token };

  let instancia: InstanciaUazapi;
  try {
    instancia = await statusDaInstancia(conexao);
  } catch (err) {
    return { ok: false, status: 422, code: "invalid_request", motivo: motivoDaFalha(err) };
  }

  const impressao = impressaoDoToken(token);
  const tokenCifrado = await encryptWebhookSecret(admin, token);
  const impressaoCifrada = await encryptWebhookSecret(admin, impressao);
  if (!tokenCifrado || !impressaoCifrada) {
    // Sem a cifra, gravar o token em claro seria pior que recusar.
    return {
      ok: false,
      status: 422,
      code: "invalid_request",
      motivo: "cifra indisponível nesta instalação — a chave não foi gravada",
    };
  }

  const existente = await findUazapiSession(admin, input.organizationId);
  const phoneNumber = instancia.numero ? `+${instancia.numero}` : (existente?.phoneNumber ?? null);
  // O nome do perfil só batiza a conexão; depois dela o nome é do operador.
  const displayName = existente?.displayName || instancia.nomeDoPerfil || instancia.nome;

  const salvo = await saveUazapiSession(admin, {
    organizationId: input.organizationId,
    existente,
    instance: instancia.nome,
    baseUrl: url.baseUrl,
    tokenEncrypted: tokenCifrado,
    impressao,
    impressaoCifrada,
    phoneNumber,
    displayName,
    estado: instancia.estado,
    userId: input.userId,
    requestId: input.requestId,
  });
  if (salvo.error || !salvo.channelSessionId) {
    if (salvo.error && /channel_sessions_phone_per_org_unique/i.test(salvo.error)) {
      return {
        ok: false,
        status: 409,
        code: "state_conflict",
        motivo: "O número pareado nessa instância já está em outra conexão desta conta.",
      };
    }
    // A mesma instância (pelo token, venha pelo host que vier, ou pelo par
    // servidor + nome) já está ativa noutra conta: recusa, sem desviar o webhook
    // de ninguém — o `configurarWebhook` só roda depois de gravar.
    if (
      salvo.error &&
      /channel_sessions_uazapi_token_ativo_unique|channel_sessions_uazapi_instance_ativo_unique|duplicate key/i.test(salvo.error)
    ) {
      return {
        ok: false,
        status: 409,
        code: "state_conflict",
        motivo: "Esta instância já está conectada em outra conta deste sistema.",
      };
    }
    // A mensagem crua volta para a rota: é ela que carrega o limite do plano.
    return { ok: false, status: 502, code: "internal_error", motivo: salvo.error ?? "sessão não gravada" };
  }

  const sessao = await findUazapiSession(admin, input.organizationId);
  let webhookConfigurado = false;
  if (sessao?.webhookPathToken) {
    try {
      await configurarWebhook(conexao, `${input.webhookBase}/api/v1/webhooks/channel/${sessao.webhookPathToken}`);
      webhookConfigurado = true;
    } catch (err) {
      logger.warn("[instancia-propria] webhook não configurado no servidor", {
        organization_id: input.organizationId,
        channel_session_id: salvo.channelSessionId,
        detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
      });
    }
  }

  let atual = instancia;
  if (instancia.estado !== "connected" && !instancia.qrcode) {
    try {
      atual = await conectarInstancia(conexao);
    } catch (err) {
      // Pedir o QR falhou, mas a conexão está gravada: a tela mostra o botão de
      // gerar outro, que repete este pedido.
      logger.warn("[instancia-propria] QR não pedido ao conectar", {
        organization_id: input.organizationId,
        detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
      });
    }
  }

  const estado = await estadoDaInstanciaPropria(admin, input.organizationId, { aoVivo: false });
  return {
    ok: true,
    estado: comInstancia(estado, atual),
    webhookConfigurado,
    nova: !existente,
    channelSessionId: salvo.channelSessionId,
  };
}

/** Pede um QR novo (o anterior expirou) para a sessão ativa desta organização. */
export async function novoQrDaInstanciaPropria(
  admin: SupabaseClient,
  organizationId: string,
): Promise<{ ok: true; estado: EstadoDaInstanciaPropria } | Recusa> {
  const sessao = await findUazapiSession(admin, organizationId);
  if (!sessao || sessao.archivedAt) {
    return { ok: false, status: 409, code: "state_conflict", motivo: "Conecte a instância antes de pedir o QR." };
  }
  const creds = await resolveUazapiCredsDaSessao(admin, { organizationId, channelSessionId: sessao.id });
  if (!creds) {
    return { ok: false, status: 409, code: "state_conflict", motivo: "A credencial gravada não pôde ser lida. Conecte de novo." };
  }
  try {
    const instancia = await conectarInstancia(creds);
    const gravado = await gravarEstadoDaSessao(admin, {
      organizationId,
      channelSessionId: sessao.id,
      estado: instancia.estado,
      numero: instancia.numero,
    });
    const estado = await estadoDaInstanciaPropria(admin, organizationId, { aoVivo: false });
    return { ok: true, estado: comInstancia({ ...estado, status: gravado.atual }, instancia) };
  } catch (err) {
    return { ok: false, status: 502, code: "upstream_unavailable", motivo: motivoDaFalha(err) };
  }
}

/**
 * O que sai da linha quando a conexão é ARQUIVADA (desconectar): o token
 * cifrado da instância e a impressão dele. A linha fica — o histórico de
 * conversas aponta para ela —, mas sem o token: um arquivo de conexão que ainda
 * guarda o token da instância é uma credencial viva sem dono na tela.
 * Reconectar grava tudo de novo (`saveUazapiSession`).
 *
 * O segredo da entrada (`webhook_secret_encrypted`) FICA: a coluna é NOT NULL
 * para todos os canais, e ele sozinho não abre nada — a URL do webhook gira no
 * arquivamento e a sessão arquivada já recusa evento (404).
 *
 * Vazio para conexão de outro canal: quem chama não precisa saber qual é.
 */
export function credencialQueSaiAoArquivar(provider: string): Record<string, null> {
  if (provider !== CHANNEL_PROVIDER_UAZAPI) return {};
  return {
    uazapi_token_encrypted: null,
    uazapi_token_fingerprint: null,
  };
}

/** Como fica o webhook da instância própria depois de sair do CRM. */
export type DesligamentoDaInstanciaPropria = "desfeito" | "sem_credencial" | "falhou" | "nao_se_aplica";

export type PlanoDeDesligamento =
  | { estado: Exclude<DesligamentoDaInstanciaPropria, "desfeito"> }
  | { estado: "pronto"; desligar: () => Promise<"desfeito" | "falhou"> };

/**
 * Prepara o desligamento do webhook da instância, ANTES de o CRM arquivar ou
 * apagar a conexão: lê o token e a URL atual enquanto ainda estão na linha.
 * Não fala com o servidor — quem chama roda `desligar()` só DEPOIS que a
 * escrita no banco deu certo. Na ordem inversa, um UPDATE que falha deixava o
 * servidor desligado e a conexão WORKING no CRM, sem entrada nenhuma.
 *
 * `desligar()` é best-effort: a instância é do cliente, e servidor fora do ar
 * não impede sair do CRM (a conexão fica arquivada, com aviso no log).
 *
 * `nao_se_aplica` para conexão de outro canal: quem chama não precisa saber qual é.
 */
export async function prepararDesligamentoDaInstanciaPropria(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
  webhookBase: string | null,
): Promise<PlanoDeDesligamento> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("provider, webhook_path_token")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (error) return { estado: "falhou" };
  const linha = (data ?? {}) as { provider?: unknown; webhook_path_token?: unknown };
  if (linha.provider !== CHANNEL_PROVIDER_UAZAPI) return { estado: "nao_se_aplica" };
  const creds = await resolveUazapiCredsDaSessao(admin, { organizationId, channelSessionId }).catch(() => null);
  if (!creds) return { estado: "sem_credencial" };
  const pathToken = typeof linha.webhook_path_token === "string" ? linha.webhook_path_token : "";
  const urlAtual = `${webhookBase ?? ""}/api/v1/webhooks/channel/${pathToken}`;
  return {
    estado: "pronto",
    desligar: async () => {
      try {
        await desligarWebhook(creds, urlAtual);
        return "desfeito";
      } catch (err) {
        logger.warn("[instancia-propria] conexão arquivada, mas o webhook não foi desligado no servidor", {
          organization_id: organizationId,
          channel_session_id: channelSessionId,
          detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
        });
        return "falhou";
      }
    },
  };
}
