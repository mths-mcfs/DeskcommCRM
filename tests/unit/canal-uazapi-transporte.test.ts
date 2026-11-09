import * as http from "node:http";
import type { LookupAddress } from "node:dns";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DestinoBloqueado, lookupConferido, requisitar, type Resolvedor } from "@/lib/channels/uazapi/transporte";

/**
 * A guarda de destino vale para o IP que a CONEXÃO usa. Conferir o DNS antes e
 * deixar o `fetch` resolver de novo abria a janela do rebinding: a primeira
 * resposta pública, a segunda `127.0.0.1`, e o token da instância ia para a
 * rede interna. Aqui o resolvedor falso faz exatamente isso, contra um
 * servidor de verdade em 127.0.0.1 que conta as conexões que recebe.
 */
let servidor: http.Server;
let porta = 0;
let conexoes = 0;

beforeAll(async () => {
  servidor = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-eco": req.headers.token ?? "" });
    res.end(JSON.stringify({ ok: true, metodo: req.method }));
  });
  servidor.on("connection", () => {
    conexoes += 1;
  });
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", () => r()));
  porta = (servidor.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => servidor.close(() => r()));
});

/** Um resolvedor que devolve, a cada pergunta, o próximo IP da lista. */
function resolvedorEmSequencia(ips: string[]): { resolver: Resolvedor; perguntas: () => number } {
  let n = 0;
  return {
    resolver: (_host, cb) => {
      const ip = ips[Math.min(n, ips.length - 1)]!;
      n += 1;
      cb(null, [{ address: ip, family: ip.includes(":") ? 6 : 4 }]);
    },
    perguntas: () => n,
  };
}

describe("transporte uazapi — o IP conferido é o IP usado", () => {
  it("rebinding: o nome que passa a resolver para 127.0.0.1 não abre conexão", async () => {
    const antes = conexoes;
    // A conferência antecipada já viu o IP público; o transporte pergunta de novo e recebe o interno.
    const { resolver } = resolvedorEmSequencia(["127.0.0.1"]);
    await expect(
      requisitar(
        new URL(`http://rebind.atacante.example:${porta}/instance/status`),
        { method: "GET", headers: { token: "tok-secreto-123" } },
        { liberarInterno: false, resolver },
      ),
    ).rejects.toBeInstanceOf(DestinoBloqueado);
    expect(conexoes).toBe(antes);
  });

  it("dois registros, um público e um interno, é recusa", async () => {
    const antes = conexoes;
    const resolver: Resolvedor = (_h, cb) =>
      cb(null, [
        { address: "93.184.215.14", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
    await expect(
      requisitar(new URL(`http://misto.example:${porta}/`), { method: "GET" }, { liberarInterno: false, resolver }),
    ).rejects.toBeInstanceOf(DestinoBloqueado);
    expect(conexoes).toBe(antes);
  });

  it("IP literal interno é recusado sem abrir socket", async () => {
    const antes = conexoes;
    for (const u of [`http://127.0.0.1:${porta}/`, `http://[::1]:${porta}/`, "https://169.254.169.254/latest"]) {
      await expect(requisitar(new URL(u), { method: "GET" }, { liberarInterno: false })).rejects.toBeInstanceOf(
        DestinoBloqueado,
      );
    }
    expect(conexoes).toBe(antes);
  });

  it("o modo de teste local libera o servidor na própria máquina, com corpo, header e status", async () => {
    const { resolver } = resolvedorEmSequencia(["127.0.0.1"]);
    const res = await requisitar(
      new URL(`http://uazapi-falsa.local:${porta}/send/text`),
      { method: "POST", headers: { token: "tok-1", "Content-Type": "application/json" }, body: '{"a":1}' },
      { liberarInterno: true, resolver },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-eco")).toBe("tok-1");
    expect(await res.json()).toEqual({ ok: true, metodo: "POST" });
  });

  it("não segue redirect: o 30x volta como está", async () => {
    const outro = http.createServer((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/" });
      res.end();
    });
    await new Promise<void>((r) => outro.listen(0, "127.0.0.1", () => r()));
    const p = (outro.address() as AddressInfo).port;
    try {
      const res = await requisitar(new URL(`http://127.0.0.1:${p}/`), { method: "GET" }, { liberarInterno: true });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://127.0.0.1:1/");
    } finally {
      await new Promise<void>((r) => outro.close(() => r()));
    }
  });
});

describe("transporte uazapi — o lookup do socket", () => {
  function perguntar(
    lookup: ReturnType<typeof lookupConferido>,
    opts: { all?: boolean; family?: number },
  ): Promise<{ err: Error | null; resultado: string | LookupAddress[] }> {
    return new Promise((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (lookup as any)("srv.example.test", opts, (err: Error | null, resultado: string | LookupAddress[]) =>
        r({ err, resultado }),
      );
    });
  }

  it("entrega ao socket só o que conferiu, na forma que ele pediu", async () => {
    const resolver: Resolvedor = (_h, cb) =>
      cb(null, [
        { address: "93.184.215.14", family: 4 },
        { address: "2606:4700::1111", family: 6 },
      ]);
    const lookup = lookupConferido({ liberarInterno: false, resolver });
    expect(await perguntar(lookup, {})).toEqual({ err: null, resultado: "93.184.215.14" });
    expect((await perguntar(lookup, { all: true })).resultado).toHaveLength(2);
    expect(await perguntar(lookup, { family: 6 })).toEqual({ err: null, resultado: "2606:4700::1111" });
  });

  it("recusa interno em toda faixa: loopback, privada, link-local, IPv6 e IPv4 embutido", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1", "::ffff:7f00:1"]) {
      const lookup = lookupConferido({
        liberarInterno: false,
        resolver: (_h, cb) => cb(null, [{ address: ip, family: ip.includes(":") ? 6 : 4 }]),
      });
      const { err } = await perguntar(lookup, {});
      expect(err, ip).toBeInstanceOf(DestinoBloqueado);
    }
  });

  it("falha de DNS sobe como falha de DNS, não como destino liberado", async () => {
    const lookup = lookupConferido({ liberarInterno: false, resolver: (_h, cb) => cb(new Error("ENOTFOUND"), []) });
    expect((await perguntar(lookup, {})).err?.message).toBe("ENOTFOUND");
  });
});
