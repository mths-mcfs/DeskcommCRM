/**
 * O transporte HTTP da UAZAPI: uma requisição cuja CONEXÃO só abre para IP
 * permitido.
 *
 * ─── Por que não o `fetch` ──────────────────────────────────────────────────
 *
 * Conferir o DNS antes do `fetch` (`assertDestinoResolvidoSeguro`) deixa uma
 * janela: o `fetch` resolve o nome de novo por conta própria, e um DNS que
 * responde IP público na primeira pergunta e `127.0.0.1` na segunda leva a
 * conexão — com o token da instância no header — para dentro da rede do
 * servidor (rebinding, medido pela revisão adversarial). A guarda tem de valer
 * para o IP que a conexão USA, e o único lugar onde ele é conhecido é o
 * `lookup` do socket. O `fetch` global não aceita `lookup` sem o pacote
 * `undici`, que não é dependência deste projeto; o `node:https` aceita, e é o
 * mesmo mecanismo do download de extensões (`lib/extensions/download.ts`).
 *
 * Cada endereço que o resolvedor devolve é julgado por `ipEhEspecial` NA HORA
 * de conectar; basta um interno para recusar (dois registros, um público e um
 * privado, é a assinatura do rebinding). IP literal não passa pelo `lookup` do
 * Node, então é julgado antes de abrir. Com `https`, SNI e certificado
 * continuam sendo os do nome — só o endereço é conferido.
 *
 * O modo de teste local (`UAZAPI_ALLOW_INSECURE_HTTP=true`) libera host interno.
 */
import dns, { type LookupAddress, type LookupAllOptions } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

import { ipEhEspecial } from "@/lib/automation/outbound-ip";

/** A conexão foi recusada pelo endereço — nada saiu do CRM. */
export class DestinoBloqueado extends Error {
  constructor(detalhe: string) {
    super(`destino_bloqueado: ${detalhe}`);
    this.name = "DestinoBloqueado";
  }
}

/** O resolvedor que o `lookup` usa: o DNS do sistema, ou um falso nos testes. */
export type Resolvedor = (hostname: string, callback: (err: Error | null, enderecos: LookupAddress[]) => void) => void;

const resolverPeloSistema: Resolvedor = (hostname, callback) => {
  // `dns.lookup` lido na hora (e não importado solto): é o que o sistema usa.
  const opcoes: LookupAllOptions = { all: true };
  dns.lookup(hostname, opcoes, (err, enderecos) => callback(err, enderecos ?? []));
};

/**
 * O `lookup` do socket com a guarda dentro: resolve, recusa se QUALQUER
 * endereço for interno e entrega ao socket exatamente o que conferiu.
 */
export function lookupConferido(opcoes: { liberarInterno: boolean; resolver?: Resolvedor }): LookupFunction {
  const resolver = opcoes.resolver ?? resolverPeloSistema;
  return (hostname, lookupOpts, callback) => {
    resolver(hostname, (err, enderecos) => {
      if (err) return callback(err, "", 4);
      const validos = enderecos.filter((e) => isIP(e.address) !== 0);
      if (validos.length === 0) return callback(new DestinoBloqueado("o nome não resolveu"), "", 4);
      if (!opcoes.liberarInterno && validos.some((e) => ipEhEspecial(e.address))) {
        return callback(new DestinoBloqueado("o nome resolve para um endereço interno"), "", 4);
      }
      const familia = lookupOpts.family === 6 || lookupOpts.family === 4 ? lookupOpts.family : 0;
      const daFamilia = familia === 0 ? validos : validos.filter((e) => e.family === familia);
      if (daFamilia.length === 0) return callback(new DestinoBloqueado("sem endereço da família pedida"), "", 4);
      if (lookupOpts.all) return callback(null, daFamilia);
      const primeiro = daFamilia[0]!;
      return callback(null, primeiro.address, primeiro.family);
    });
  };
}

export interface PedidoHttp {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Status que o `Response` não aceita com corpo. */
const SEM_CORPO = new Set([204, 205, 304]);

/**
 * Uma requisição, devolvendo um `Response` comum. Não segue redirect (o 30x
 * volta como está). Lança `DestinoBloqueado` quando o endereço não é permitido.
 */
export function requisitar(
  url: URL,
  pedido: PedidoHttp,
  opcoes: { liberarInterno: boolean; resolver?: Resolvedor },
): Promise<Response> {
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!opcoes.liberarInterno && isIP(host) !== 0 && ipEhEspecial(host)) {
    return Promise.reject(new DestinoBloqueado("endereço interno"));
  }
  const modulo = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!modulo) return Promise.reject(new DestinoBloqueado("protocolo não permitido"));

  return new Promise<Response>((resolve, reject) => {
    const req = modulo.request(
      url,
      {
        method: pedido.method,
        headers: {
          ...(pedido.headers ?? {}),
          ...(pedido.body !== undefined ? { "Content-Length": String(Buffer.byteLength(pedido.body)) } : {}),
        },
        // Sem agente compartilhado: a conexão (e o `lookup` dela) é desta requisição.
        agent: false,
        lookup: lookupConferido(opcoes),
        signal: pedido.signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) {
          res.destroy();
          reject(new Error(`status HTTP fora da faixa: ${status}`));
          return;
        }
        const headers = new Headers();
        for (const [chave, valor] of Object.entries(res.headers)) {
          if (Array.isArray(valor)) for (const v of valor) headers.append(chave, v);
          else if (valor !== undefined) headers.set(chave, valor);
        }
        if (SEM_CORPO.has(status)) {
          res.resume();
          resolve(new Response(null, { status, headers }));
          return;
        }
        // O `ReadableStream` do Node e o global são o mesmo objeto em tempo de
        // execução; os tipos é que vêm de pacotes diferentes.
        const corpo = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
        resolve(new Response(corpo, { status, headers }));
      },
    );
    req.once("error", reject);
    if (pedido.body !== undefined) req.write(pedido.body);
    req.end();
  });
}
