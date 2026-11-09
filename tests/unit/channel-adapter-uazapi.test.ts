import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Destino from "@/lib/automation/outbound-ip";
import type * as Transporte from "@/lib/channels/uazapi/transporte";
import type * as Credenciais from "@/lib/channels/uazapi/credentials";

/**
 * O DNS de mentira: cada nome resolve para o IP desta tabela (o padrão é um
 * endereço público). A decisão de "interno" é a da guarda de verdade.
 */
const DNS: Record<string, string> = {};
vi.mock("@/lib/automation/outbound-ip", async (original) => {
  const real = await original<typeof Destino>();
  return {
    ...real,
    assertDestinoResolvidoSeguro: vi.fn(async (host: string) => {
      const ip = DNS[host] ?? (/^[\d.]+$|:/.test(host) ? host : "93.184.216.34");
      if (real.ipEhEspecial(ip)) throw new Error("unsafe_url:private_ip");
    }),
  };
});
/** O transporte de verdade abre socket; aqui ele delega ao `fetch` do teste (a guarda dele tem teste próprio). */
vi.mock("@/lib/channels/uazapi/transporte", async (original) => ({
  ...(await original<typeof Transporte>()),
  requisitar: (url: URL, pedido: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
    fetch(url, { method: pedido.method, headers: pedido.headers, body: pedido.body, signal: pedido.signal, redirect: "manual" }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/uazapi/credentials", async (original) => ({
  ...(await original<typeof Credenciais>()),
  resolveUazapiCreds: vi.fn(),
}));

import { getAdapter } from "@/lib/channels";
import { numeroDoDestino, uazapiAdapter } from "@/lib/channels/adapters/uazapi";
import { DETALHE_CREDENCIAL_RECUSADA } from "@/lib/channels/health";
import { resolveUazapiCreds } from "@/lib/channels/uazapi/credentials";
import type { OutboundEnvelope } from "@/lib/channels/types";

/**
 * Adapter do canal UAZAPI: traduz o envelope para `/send/*` com o token DA
 * SESSÃO no header, classifica a resposta no prefixo que o handler lê e chama a
 * cadeia `beforeSend` antes do HTTP.
 */
const TOKEN = "tok-instancia-123456";
const CREDS = {
  channelSessionId: "sess-1",
  instance: "minha-instancia",
  baseUrl: "https://srv.example.test",
  token: TOKEN,
};

function envelope(over: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return {
    organizationId: "org-1",
    sessionRef: "minha-instancia",
    to: "5531999998888",
    kind: "text",
    body: "olá",
    ...over,
  };
}

function resposta(corpo: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json", ...headers } });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  for (const k of Object.keys(DNS)) delete DNS[k];
  vi.stubEnv("UAZAPI_ALLOW_INSECURE_HTTP", "");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.mocked(resolveUazapiCreds).mockReset();
  vi.mocked(resolveUazapiCreds).mockResolvedValue(CREDS);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function chamada(i = 0): { url: string; init: RequestInit; corpo: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[i]!;
  return { url: String(url), init: init ?? {}, corpo: init?.body ? JSON.parse(String(init.body)) : {} };
}

describe("adapter uazapi — registro e endereço", () => {
  it("está no registro e carrega os códigos com o nome", () => {
    const a = getAdapter("uazapi");
    expect(a).toBe(uazapiAdapter);
    expect(a.isConfigured()).toBe(true);
    expect(a.codes).toEqual({
      notConfigured: "uazapi_not_configured",
      sendFailed: "uazapi_send_failed",
      unknownError: "uazapi_unknown",
      throttled: "uazapi_throttled",
    });
  });

  it("endereça pelo telefone em dígitos, cai para o @lid e recusa grupo", () => {
    const base = { groupChatId: null, waIdentity: null };
    expect(uazapiAdapter.resolveRecipient({ ...base, isGroup: false, phoneNumber: "+55 (31) 99999-8888" })).toBe(
      "5531999998888",
    );
    expect(
      uazapiAdapter.resolveRecipient({ ...base, isGroup: false, phoneNumber: null, waLid: "123456789012345" }),
    ).toBe("123456789012345@lid");
    expect(
      uazapiAdapter.resolveRecipient({ ...base, isGroup: false, phoneNumber: null, waIdentity: "lid:99887766554433" }),
    ).toBe("99887766554433@lid");
    expect(uazapiAdapter.resolveRecipient({ ...base, isGroup: true, groupChatId: "1@g.us", phoneNumber: "+5531" })).toBeNull();
    expect(uazapiAdapter.resolveRecipient({ ...base, isGroup: false, phoneNumber: null })).toBeNull();
  });

  it("o número do envio aceita dígitos, jid de telefone e @lid; recusa grupo", () => {
    expect(numeroDoDestino("5531999998888")).toBe("5531999998888");
    expect(numeroDoDestino("5531999998888@s.whatsapp.net")).toBe("5531999998888");
    expect(numeroDoDestino("5531999998888@c.us")).toBe("5531999998888");
    expect(numeroDoDestino("123456789012345@lid")).toBe("123456789012345@lid");
    expect(numeroDoDestino("120363000000001@g.us")).toBeNull();
    expect(numeroDoDestino("abc")).toBeNull();
  });

  it("a forma canônica do id tira o `<dono>:` da frente", () => {
    expect(uazapiAdapter.canonicalExternalId?.("5511999999999:3EB0ABC")).toBe("3EB0ABC");
    expect(uazapiAdapter.canonicalExternalId?.("3EB0ABC")).toBe("3EB0ABC");
  });
});

describe("adapter uazapi — envio", () => {
  it("texto vai para /send/text com o token no header (nunca na URL) e devolve o messageid", async () => {
    fetchMock.mockResolvedValue(resposta({ id: "5531000000000:3EB0AAA", messageid: "3EB0AAA" }));
    const beforeSend = vi.fn(async () => undefined);

    const r = await uazapiAdapter.send(envelope({ beforeSend }));

    expect(r.externalId).toBe("3EB0AAA");
    expect(beforeSend).toHaveBeenCalledTimes(1);
    const { url, init, corpo } = chamada();
    expect(url).toBe("https://srv.example.test/send/text");
    expect(url).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>).token).toBe(TOKEN);
    expect(init.redirect).toBe("manual");
    expect(corpo).toMatchObject({ number: "5531999998888", text: "olá", async: false });
  });

  it("sem `messageid`, o id é a cauda do `id` composto", async () => {
    fetchMock.mockResolvedValue(resposta({ id: "5531000000000:3EB0BBB" }));
    expect((await uazapiAdapter.send(envelope())).externalId).toBe("3EB0BBB");
  });

  it("cita a mensagem pelo id do WhatsApp, tirado do id composto da recebida", async () => {
    fetchMock.mockResolvedValue(resposta({ messageid: "X" }));
    await uazapiAdapter.send(envelope({ replyToExternalId: "false_5531999998888@s.whatsapp.net_3EB0CITADA" }));
    expect(chamada().corpo.replyid).toBe("3EB0CITADA");
  });

  it("mídia vai para /send/media com o tipo do WhatsApp; áudio sai como nota de voz", async () => {
    fetchMock.mockImplementation(async () => resposta({ messageid: "M1" }));
    await uazapiAdapter.send(
      envelope({
        kind: "image",
        body: undefined,
        media: { url: "https://cdn.example.test/a.jpg", mime: "image/jpeg", caption: "legenda" },
      }),
    );
    expect(chamada(0).url).toBe("https://srv.example.test/send/media");
    expect(chamada(0).corpo).toMatchObject({
      number: "5531999998888",
      type: "image",
      file: "https://cdn.example.test/a.jpg",
      text: "legenda",
      mimetype: "image/jpeg",
    });

    await uazapiAdapter.send(
      envelope({ kind: "audio", media: { url: "https://cdn.example.test/a.ogg", mime: "audio/ogg" } }),
    );
    expect(chamada(1).corpo.type).toBe("ptt");

    await uazapiAdapter.send(
      envelope({
        kind: "document",
        media: { url: "https://cdn.example.test/c.pdf", mime: "application/pdf", filename: "contrato.pdf" },
      }),
    );
    expect(chamada(2).corpo).toMatchObject({ type: "document", docName: "contrato.pdf" });
  });

  it("cartão de contato vai para /send/contact", async () => {
    fetchMock.mockResolvedValue(resposta({ messageid: "C1" }));
    await uazapiAdapter.send(
      envelope({
        kind: "contact",
        contact: { fullName: "Ana", phoneNumber: "+55 31 98888-7777", whatsappId: "x", vcard: "BEGIN:VCARD" },
      }),
    );
    expect(chamada().url).toBe("https://srv.example.test/send/contact");
    expect(chamada().corpo).toMatchObject({ fullName: "Ana", phoneNumber: "5531988887777" });
  });

  it("sem credencial na sessão desiste com `notConfigured`, sem HTTP e sem beforeSend", async () => {
    vi.mocked(resolveUazapiCreds).mockResolvedValue(null);
    const beforeSend = vi.fn(async () => undefined);
    await expect(uazapiAdapter.send(envelope({ beforeSend }))).rejects.toThrow(/^uazapi_not_configured/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beforeSend).not.toHaveBeenCalled();
  });

  it("429 vira `throttled` com a espera pedida carimbada", async () => {
    fetchMock.mockResolvedValue(resposta({ error: "Rate limit exceeded" }, 429, { "retry-after": "30" }));
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/^uazapi_throttled: .*\[espera:30s\]/);
  });

  it("401 é falha de envio com a credencial recusada nomeada — o token não aparece", async () => {
    fetchMock.mockResolvedValue(resposta({ error: "Invalid token" }, 401));
    const erro: unknown = await uazapiAdapter.send(envelope()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(Error);
    const mensagem = erro instanceof Error ? erro.message : "";
    expect(mensagem).toMatch(/^uazapi_send_failed: credencial_recusada 401/);
    expect(mensagem).not.toContain(TOKEN);
  });

  it("463 — direto ou como 500 com `provider_code` — é restrição do WhatsApp", async () => {
    fetchMock.mockResolvedValueOnce(resposta({ error: "restrito" }, 463));
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/^uazapi_send_failed: restricao 463/);

    fetchMock.mockResolvedValueOnce(
      resposta({ error: "WhatsApp server error 463", provider_code: 463, error_source: "whatsapp_server" }, 500),
    );
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/^uazapi_send_failed: restricao 500/);
  });

  it("5xx e queda de rede são falha de envio, sem retry dentro do adapter", async () => {
    fetchMock.mockResolvedValueOnce(resposta({ error: "boom" }, 502));
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/^uazapi_send_failed: servidor 502/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/^uazapi_send_failed: rede/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("redirect não é seguido: o 30x é recusado", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://outro.test" } }));
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/^uazapi_send_failed: resposta_invalida 302/);
  });
});

describe("adapter uazapi — presença, mídia e saúde", () => {
  it("signalTyping manda `composing` para o número", async () => {
    fetchMock.mockResolvedValue(resposta({ response: "ok" }));
    await uazapiAdapter.signalTyping?.({
      organizationId: "org-1",
      sessionRef: "minha-instancia",
      recipient: "5531999998888",
      inboundExternalId: null,
    });
    expect(chamada().url).toBe("https://srv.example.test/message/presence");
    expect(chamada().corpo).toMatchObject({ number: "5531999998888", presence: "composing" });
  });

  it("fetchInboundMedia pede o link e baixa do MESMO servidor, sem token", async () => {
    fetchMock
      .mockResolvedValueOnce(resposta({ fileURL: "https://srv.example.test/files/a.jpg", mimetype: "image/jpeg" }))
      .mockResolvedValueOnce(new Response(Buffer.from("JPEGDATA"), { status: 200, headers: { "content-type": "image/jpeg" } }));

    const media = await uazapiAdapter.fetchInboundMedia?.({
      organizationId: "org-1",
      sessionRef: "minha-instancia",
      url: "uazapi-midia:3EB0MIDIA",
    });

    expect(media?.mime).toBe("image/jpeg");
    expect(media?.buffer.toString()).toBe("JPEGDATA");
    expect(chamada(0).url).toBe("https://srv.example.test/message/download");
    expect(chamada(0).corpo).toMatchObject({ id: "3EB0MIDIA", return_link: true });
    const [, initDoArquivo] = fetchMock.mock.calls[1]!;
    expect(initDoArquivo?.headers).toBeUndefined();
    expect(initDoArquivo?.redirect).toBe("manual");
  });

  it("fetchInboundMedia recusa link de outro host (o servidor não aponta o CRM para a rede dele)", async () => {
    fetchMock.mockResolvedValueOnce(resposta({ fileURL: "https://169.254.169.254/latest", mimetype: "image/jpeg" }));
    await expect(
      uazapiAdapter.fetchInboundMedia?.({ organizationId: "org-1", sessionRef: "minha-instancia", url: "uazapi-midia:X1" }),
    ).rejects.toThrow(/fora do servidor configurado/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetchInboundMedia não baixa o link quando o host do servidor passou a resolver para dentro", async () => {
    // Responde o `/message/download` e, logo depois, o mesmo nome passa a
    // apontar para a rede interna (rebinding): o GET do arquivo não sai.
    fetchMock.mockImplementationOnce(async () => {
      DNS["srv.example.test"] = "10.0.0.7";
      return resposta({ fileURL: "https://srv.example.test/files/a.jpg", mimetype: "image/jpeg" });
    });
    await expect(
      uazapiAdapter.fetchInboundMedia?.({ organizationId: "org-1", sessionRef: "minha-instancia", url: "uazapi-midia:X3" }),
    ).rejects.toThrow(/destino_bloqueado/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetchInboundMedia aceita o base64 que o servidor mandar", async () => {
    fetchMock.mockResolvedValueOnce(resposta({ base64Data: Buffer.from("OGG").toString("base64"), mimetype: "audio/ogg" }));
    const media = await uazapiAdapter.fetchInboundMedia?.({
      organizationId: "org-1",
      sessionRef: "minha-instancia",
      url: "uazapi-midia:X2",
    });
    expect(media?.buffer.toString()).toBe("OGG");
    expect(media?.mime).toBe("audio/ogg");
  });

  it("fetchInboundMedia recusa url que não é a marca desta ingestão", async () => {
    await expect(
      uazapiAdapter.fetchInboundMedia?.({ organizationId: "org-1", sessionRef: "x", url: "https://srv.example.test/a" }),
    ).rejects.toThrow(/uazapi_media_url_invalida/);
  });

  it("checkHealth: conectado é WORKING; QR é SCAN_QR_CODE; token recusado é FAILED; rede é 'não sei'", async () => {
    const base = { organizationId: "org-1", sessionRef: "minha-instancia" };
    fetchMock.mockResolvedValueOnce(resposta({ instance: { name: "minha-instancia", status: "connected" } }));
    expect(await uazapiAdapter.checkHealth?.(base)).toEqual({ reachable: true, status: "WORKING", detail: null });

    fetchMock.mockResolvedValueOnce(resposta({ instance: { name: "minha-instancia", status: "connecting" } }));
    expect((await uazapiAdapter.checkHealth?.(base))?.status).toBe("SCAN_QR_CODE");

    fetchMock.mockResolvedValueOnce(resposta({ error: "invalid" }, 401));
    expect(await uazapiAdapter.checkHealth?.(base)).toEqual({
      reachable: true,
      status: "FAILED",
      detail: DETALHE_CREDENCIAL_RECUSADA,
    });

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await uazapiAdapter.checkHealth?.(base))?.reachable).toBe(false);
  });
});

describe("adapter uazapi — destino da chamada (SSRF)", () => {
  it("servidor cujo nome resolve para a rede interna não recebe chamada nenhuma", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
      DNS["srv.example.test"] = ip;
      await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/^uazapi_send_failed: destino_bloqueado/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("IP interno gravado como base também é barrado antes do fetch", async () => {
    vi.mocked(resolveUazapiCreds).mockResolvedValue({ ...CREDS, baseUrl: "https://169.254.169.254" });
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/destino_bloqueado/);
    vi.mocked(resolveUazapiCreds).mockResolvedValue({ ...CREDS, baseUrl: "https://localhost:54321" });
    await expect(uazapiAdapter.send(envelope())).rejects.toThrow(/destino_bloqueado/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("o modo de teste local libera o servidor falso na própria máquina", async () => {
    vi.stubEnv("UAZAPI_ALLOW_INSECURE_HTTP", "true");
    vi.mocked(resolveUazapiCreds).mockResolvedValue({ ...CREDS, baseUrl: "http://127.0.0.1:8080" });
    fetchMock.mockImplementation(async () => resposta({ messageid: "L1" }));
    await expect(uazapiAdapter.send(envelope())).resolves.toEqual({ externalId: "L1" });
    expect(chamada().url).toBe("http://127.0.0.1:8080/send/text");
  });

  it("checkHealth com destino barrado é 'não sei', não credencial recusada", async () => {
    DNS["srv.example.test"] = "10.0.0.1";
    const saude = await uazapiAdapter.checkHealth?.({ organizationId: "org-1", sessionRef: "minha-instancia" });
    expect(saude).toMatchObject({ reachable: false, status: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("adapter uazapi — apagar para todos (o `#on`/`#off` do celular)", () => {
  it("revokeMessage chama /message/delete com o id curto do WhatsApp", async () => {
    fetchMock.mockResolvedValue(resposta({ id: "3EB0CMD", timestamp: "2026-11-08T12:00:00Z" }));
    await uazapiAdapter.revokeMessage?.({
      organizationId: "org-1",
      sessionRef: "minha-instancia",
      recipient: "5531999998888@s.whatsapp.net",
      externalId: "true_5531999998888@s.whatsapp.net_3EB0CMD",
    });
    expect(chamada().url).toBe("https://srv.example.test/message/delete");
    expect(chamada().corpo).toEqual({ id: "3EB0CMD" });
    expect(new Headers(chamada().init.headers).get("token")).toBe(TOKEN);
  });

  it("falha do servidor sobe com o prefixo do canal, sem o token", async () => {
    fetchMock.mockResolvedValue(resposta({ error: "not found" }, 404));
    const erro: unknown = await uazapiAdapter
      .revokeMessage?.({ organizationId: "org-1", sessionRef: "minha-instancia", recipient: null, externalId: "3EB0X" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    const mensagem = erro instanceof Error ? erro.message : "";
    expect(mensagem).toMatch(/^uazapi_send_failed: nao_encontrado 404/);
    expect(mensagem).not.toContain(TOKEN);
  });

  it("sem editMessage, a rota de edição da tela continua recusando o canal", () => {
    expect(uazapiAdapter.editMessage).toBeUndefined();
  });
});
