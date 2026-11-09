import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { abrirArquivoDoWebhook, corpoParaArquivar } from "@/lib/channels/arquivo-de-webhook";
import { corpoSemCredencial, impressaoDoToken, tokenDoCorpoConfere } from "@/lib/channels/uazapi/webhook";

/**
 * O arquivo do webhook (`webhook_events_log`) é legível por qualquer membro da
 * organização. A UAZAPI manda o token da instância no corpo de TODO evento: o
 * que se arquiva não pode levar o valor dele — com o token, um `viewer`
 * controlaria o WhatsApp da empresa.
 */
const TOKEN = "TOKEN-DA-INSTANCIA-123";

function adminQueGuarda(): { admin: SupabaseClient; linhas: Record<string, unknown>[] } {
  const linhas: Record<string, unknown>[] = [];
  const admin = {
    from: () => ({
      insert: (linha: Record<string, unknown>) => {
        linhas.push(linha);
        return { select: () => ({ maybeSingle: async () => ({ data: { id: "arq-1" }, error: null }) }) };
      },
    }),
  } as unknown as SupabaseClient;
  return { admin, linhas };
}

const corpo = JSON.stringify({
  EventType: "connection",
  BaseUrl: "https://cliente.example.test",
  token: TOKEN,
  owner: "5511900000000",
  instance: { name: "a", status: "connected", token: TOKEN },
  message: { id: "a", chatid: "5511@s.whatsapp.net", text: "oi" },
});

describe("arquivo do webhook sem o token da instância", () => {
  it("raw_body e payload_parsed saem sem o valor do token, em qualquer nível", async () => {
    const { admin, linhas } = adminQueGuarda();
    const id = await abrirArquivoDoWebhook(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      provider: "uazapi",
      rawBody: corpo,
      headers: new Headers({ "content-type": "application/json" }),
    });
    expect(id).toBe("arq-1");
    const linha = linhas[0]!;
    expect(String(linha.raw_body)).not.toContain(TOKEN);
    expect(JSON.stringify(linha.payload_parsed)).not.toContain(TOKEN);
    expect(linha.payload_parsed).toMatchObject({
      token: "[removido]",
      instance: { token: "[removido]", status: "connected" },
      // O resto do evento é o que se quer ler depois — fica.
      EventType: "connection",
      owner: "5511900000000",
      message: { text: "oi" },
    });
  });

  it("a conferência do token usa o corpo em memória: o original confere, o arquivado não", () => {
    const impressao = impressaoDoToken(TOKEN);
    expect(tokenDoCorpoConfere(corpo, impressao)).toBe(true);
    expect(tokenDoCorpoConfere(corpoSemCredencial(corpo), impressao)).toBe(false);
  });

  it("corpo que não é JSON também perde o token, por troca textual", () => {
    const quebrado = `{"EventType":"messages","token":"${TOKEN}","message":{`;
    const limpo = corpoSemCredencial(quebrado);
    expect(limpo).not.toContain(TOKEN);
    expect(limpo).toContain('"token":"[removido]"');
  });

  it("os outros canais arquivam o corpo exatamente como chegou", () => {
    const outro = JSON.stringify({ event: "message.received", token: "não-é-credencial-aqui" });
    expect(corpoParaArquivar("zernio", outro)).toBe(outro);
    expect(corpoParaArquivar("uazapi", outro)).not.toContain("não-é-credencial-aqui");
  });
});
