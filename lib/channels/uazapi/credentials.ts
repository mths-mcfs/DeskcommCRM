/**
 * Canal UAZAPI — a URL do servidor e o token da instância, **por sessão**.
 *
 * A UAZAPI é um servidor de WhatsApp por QR que o CLIENTE já tem (o gratuito, um
 * contratado ou um próprio). O CRM não cria instância nem guarda chave de
 * administração: o admin cola a URL base do servidor e o token da instância na
 * tela, e cada linha de `channel_sessions` carrega o par dela. Nada vem do `.env`
 * — uma credencial da instalação serviria a qualquer organização.
 *
 * O token é cifrado como o dos parceiros (`fn_encrypt_oauth`, via
 * `lib/webhooks/secrets.ts`) e nunca vai para log nem para a tela.
 */
import { isIP } from "node:net";

import type { SupabaseClient } from "@supabase/supabase-js";

import { ipEhEspecial } from "@/lib/automation/outbound-ip";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { CHANNEL_PROVIDER_UAZAPI } from "../capabilities";

/** Como o canal se chama PARA O USUÁRIO — a tela não pode escrever a marca. */
export const UAZAPI_LABEL = "UAZAPI";

/**
 * A instalação está no modo de TESTE LOCAL? Só `true` literal (sem caixa, com
 * `trim`) liga, e o padrão é desligado. O modo libera duas coisas, e as duas
 * existem só para testar contra um servidor falso na própria máquina:
 *
 *  - `http` — a URL leva o token da instância no header, e `http` o entregaria
 *    em claro a quem estiver no caminho;
 *  - endereço interno (loopback, rede privada, link-local, metadata) — sem o
 *    modo, o admin de uma organização apontaria o servidor do CRM para a rede
 *    interna dele e leria as respostas pela tela (SSRF).
 */
export function modoDeTesteLocal(
  valor: string | undefined = process.env.UAZAPI_ALLOW_INSECURE_HTTP,
): boolean {
  return (valor ?? "").trim().toLowerCase() === "true";
}

/**
 * O host é interno pelo TEXTO (sem DNS): `localhost`, `*.localhost` ou um IP
 * literal de faixa especial, IPv4 ou IPv6 (inclusive o IPv4 embutido em IPv6).
 * O `new URL` já normalizou as formas numéricas (`2130706433`, `0x7f.1`).
 * Nome que resolve para dentro é julgado no DNS, a cada chamada (`./client.ts`).
 */
export function hostInternoPeloTexto(hostname: string): boolean {
  const h = hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) !== 0) return ipEhEspecial(h);
  return false;
}

export type LeituraDaBaseUrl = { ok: true; baseUrl: string } | { ok: false; motivo: string };

/**
 * A URL base que o admin colou, normalizada: `https`, sem usuário e senha, sem
 * query nem fragmento, sem barra no fim, e fora da rede interna — `http` e
 * host interno só no modo de teste local. O caminho fica (há servidor atrás de
 * proxy com prefixo).
 *
 * É a borda: o que sai daqui é o que se grava e o que o cliente HTTP usa.
 */
export function lerBaseUrl(
  bruto: string,
  opcoes: { testeLocal?: boolean } = {},
): LeituraDaBaseUrl {
  const texto = bruto.trim();
  if (!texto) return { ok: false, motivo: "Informe a URL do servidor UAZAPI." };
  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    return { ok: false, motivo: "A URL do servidor não é válida. Use o endereço completo, começando com https://." };
  }
  const testeLocal = opcoes.testeLocal ?? modoDeTesteLocal();
  if (url.protocol !== "https:" && !(testeLocal && url.protocol === "http:")) {
    return { ok: false, motivo: "A URL do servidor precisa começar com https://." };
  }
  if (url.username || url.password) {
    return { ok: false, motivo: "A URL do servidor não pode levar usuário e senha." };
  }
  if (url.search || url.hash) {
    return { ok: false, motivo: "A URL do servidor não pode ter parâmetros (?…) nem âncora (#…)." };
  }
  if (!testeLocal && hostInternoPeloTexto(url.hostname)) {
    return { ok: false, motivo: "A URL do servidor não pode apontar para um endereço interno." };
  }
  const caminho = url.pathname.replace(/\/+$/, "");
  // `new URL` já põe o host em minúsculas e tira a porta padrão (443/80); o
  // ponto final (`servidor.com.`) é o mesmo host para o DNS e sai aqui. Isto
  // só normaliza o que se grava: quem impede a mesma instância em duas contas
  // é a impressão do token (`uazapi_token_fingerprint`), que não depende do host.
  const host = url.hostname.replace(/\.+$/, "");
  if (!host) return { ok: false, motivo: "A URL do servidor não é válida. Use o endereço completo, começando com https://." };
  const porta = url.port ? `:${url.port}` : "";
  return { ok: true, baseUrl: `${url.protocol}//${host}${porta}${caminho}` };
}

/** O que o cliente HTTP precisa para falar com UMA instância. */
export interface UazapiConexao {
  baseUrl: string;
  token: string;
}

export interface UazapiCredentials extends UazapiConexao {
  /** A conexão (`channel_sessions.id`). */
  channelSessionId: string;
  /** O nome da instância — o `sessionRef` deste canal. */
  instance: string;
}

/**
 * A credencial gravada na sessão DESTA ORGANIZAÇÃO que atende esta instância.
 *
 * `null` = não há sessão ativa ou o token não decifra (o canal não está
 * conectado). **LANÇA quando a consulta falha**: "não há credencial" e "não
 * consegui perguntar" levam a desfechos diferentes.
 *
 * O filtro leva a organização à mão: o client é de service role e ignora a RLS,
 * e o nome da instância só é único dentro de um servidor.
 */
export async function resolveUazapiCreds(
  admin: SupabaseClient,
  lookup: { organizationId: string; instance: string },
): Promise<UazapiCredentials | null> {
  const { organizationId, instance } = lookup;
  if (!organizationId || !instance) return null;

  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, uazapi_instance, uazapi_base_url, uazapi_token_encrypted")
      .eq("organization_id", organizationId)
      .eq("provider", CHANNEL_PROVIDER_UAZAPI)
      .eq("uazapi_instance", instance);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).limit(1).maybeSingle(),
    () => base().limit(1).maybeSingle(),
  );
  if (error) {
    throw new Error(`uazapi_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim());
  }
  return credenciaisDaLinha(admin, data);
}

/** A mesma credencial, achada pela CONEXÃO (a entrada do webhook conhece o id). */
export async function resolveUazapiCredsDaSessao(
  admin: SupabaseClient,
  lookup: { organizationId: string; channelSessionId: string },
): Promise<UazapiCredentials | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, uazapi_instance, uazapi_base_url, uazapi_token_encrypted")
    .eq("organization_id", lookup.organizationId)
    .eq("id", lookup.channelSessionId)
    .eq("provider", CHANNEL_PROVIDER_UAZAPI)
    .maybeSingle();
  if (error) throw new Error(`uazapi_creds_lookup_failed: ${error.message}`);
  return credenciaisDaLinha(admin, data);
}

async function credenciaisDaLinha(admin: SupabaseClient, data: unknown): Promise<UazapiCredentials | null> {
  if (!data || typeof data !== "object") return null;
  const linha = data as Record<string, unknown>;
  const id = typeof linha.id === "string" ? linha.id : null;
  const instance = typeof linha.uazapi_instance === "string" ? linha.uazapi_instance : null;
  const baseUrl = typeof linha.uazapi_base_url === "string" ? linha.uazapi_base_url : null;
  const cifrado = typeof linha.uazapi_token_encrypted === "string" ? linha.uazapi_token_encrypted : null;
  if (!id || !instance || !baseUrl || !cifrado) return null;

  const token = await decryptWebhookSecret(admin, cifrado);
  if (!token) return null;
  return { channelSessionId: id, instance, baseUrl, token };
}
