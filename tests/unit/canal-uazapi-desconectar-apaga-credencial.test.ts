/**
 * Desconectar a instância própria arquiva a linha SEM a credencial.
 *
 * A linha arquivada fica (as conversas apontam para ela), mas o token cifrado
 * da instância e a impressão dele saem junto: um arquivo de conexão com o token
 * ainda dentro é uma credencial viva que ninguém vê na tela. O segredo da
 * entrada fica — a coluna é NOT NULL (gravar nulo nela dava 500 na stack real).
 *
 * E a ordem: primeiro o banco, depois o `/webhook` desligado. Na ordem inversa
 * um UPDATE que falhava deixava o servidor mudo e a conexão WORKING no CRM.
 *
 * O handler roda de verdade; os dublês ficam no banco e no servidor.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as InstanciaPropria from "@/lib/channels/instancia-propria";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  sessao: {} as Record<string, unknown>,
  escritas: [] as Array<{ cliente: string; op: string; campos: Record<string, unknown> | null }>,
  /** Linha do tempo: escritas no banco e o desligamento no servidor, na ordem. */
  ordem: [] as string[],
  erroNaEscrita: null as { message: string } | null,
  resultadoDoDesligamento: "desfeito" as "desfeito" | "falhou",
  desligar: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  orgAtivaDaApi: vi.fn(),
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "33333333-3333-4333-8333-333333333333", idioma: "pt-BR", full_name: "Ana", email: "a@x.test" },
    org: { orgId: ORG, role: "admin" },
  })),
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: vi.fn(async () => false), loadAuthUser: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/health", () => ({ resolverSaudeDaConexaoRemovida: vi.fn(async () => "sem_mudanca") }));
vi.mock("@/lib/channels/central-de-pausa", () => ({ sincronizarAvisoDePausa: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/instancia-propria", async (original) => ({
  ...(await original<typeof InstanciaPropria>()),
  prepararDesligamentoDaInstanciaPropria: vi.fn(async () =>
    h.sessao.provider === "uazapi"
      ? {
          estado: "pronto" as const,
          desligar: async () => {
            h.desligar();
            h.ordem.push("servidor:webhook_desligado");
            return h.resultadoDoDesligamento;
          },
        }
      : { estado: "nao_se_aplica" as const },
  ),
}));

function cliente(nome: string) {
  return {
    from() {
      let op = "select";
      let campos: Record<string, unknown> | null = null;
      const q = {
        select: () => q,
        eq: () => q,
        update: (c: Record<string, unknown>) => ((op = "update"), (campos = c), q),
        delete: () => ((op = "delete"), q),
        maybeSingle: async () => ({ data: h.sessao, error: null }),
        then: (ok: (r: unknown) => unknown) => {
          if (op !== "select") {
            h.escritas.push({ cliente: nome, op, campos });
            h.ordem.push(`banco:${op}`);
          }
          const erro = op === "update" && campos && "archived_at" in campos ? h.erroNaEscrita : null;
          // Histórico de conversas: a saída é ARQUIVAR, não apagar.
          return Promise.resolve({ count: 3, data: null, error: erro }).then(ok);
        },
      };
      return q;
    },
  };
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => cliente("admin") }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => cliente("usuario") }));

import { DELETE } from "@/app/api/v1/channel-sessions/[id]/route";
import { credencialQueSaiAoArquivar } from "@/lib/channels/instancia-propria";

async function desconectar(): Promise<Response> {
  return DELETE(new NextRequest(`https://crm.test/api/v1/channel-sessions/${CANAL}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: CANAL }),
  });
}

function sessao(provider: string): Record<string, unknown> {
  return {
    id: CANAL,
    provider,
    waha_session_name: null,
    display_name: "Loja",
    phone_number: "+5511999990000",
    meta_phone_number_id: provider === "meta_cloud" ? "pn-1" : null,
    meta_token_encrypted: null,
    zernio_credencial_da_instalacao: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.escritas = [];
  h.ordem = [];
  h.erroNaEscrita = null;
  h.resultadoDoDesligamento = "desfeito";
});

function arquivamento() {
  return h.escritas.find((e) => e.op === "update" && e.campos && "archived_at" in e.campos);
}

describe("desconectar a instância própria", () => {
  it("arquiva a linha sem o token e sem a impressão, mantendo o segredo NOT NULL — pelo service role", async () => {
    h.sessao = sessao("uazapi");
    const r = await desconectar();
    expect(r.status).toBe(200);

    expect(arquivamento()?.cliente).toBe("admin");
    expect(arquivamento()?.campos).toMatchObject({
      status: "STOPPED",
      uazapi_token_encrypted: null,
      uazapi_token_fingerprint: null,
    });
    // Coluna NOT NULL: nem nulo, nem tocada.
    expect(arquivamento()?.campos).not.toHaveProperty("webhook_secret_encrypted");
    // A URL do webhook gira: a antiga deixa de achar a sessão.
    expect(typeof arquivamento()?.campos?.webhook_path_token).toBe("string");
  });

  it("primeiro o banco, depois o webhook desligado no servidor", async () => {
    h.sessao = sessao("uazapi");
    await desconectar();
    const iArquivo = h.ordem.indexOf("banco:update");
    const iServidor = h.ordem.indexOf("servidor:webhook_desligado");
    expect(iArquivo).toBeGreaterThanOrEqual(0);
    expect(iServidor).toBeGreaterThan(iArquivo);
  });

  it("o banco recusa o arquivamento: 500, e o servidor NÃO é desligado", async () => {
    h.sessao = sessao("uazapi");
    h.erroNaEscrita = { message: 'null value in column "x" violates not-null constraint' };
    const r = await desconectar();
    expect(r.status).toBe(500);
    expect(h.desligar).not.toHaveBeenCalled();
  });

  it("o servidor falha ao desligar: a conexão continua arquivada (200)", async () => {
    h.sessao = sessao("uazapi");
    h.resultadoDoDesligamento = "falhou";
    const r = await desconectar();
    expect(r.status).toBe(200);
    expect(arquivamento()?.campos).toMatchObject({ status: "STOPPED", uazapi_token_encrypted: null });
    expect(h.desligar).toHaveBeenCalledTimes(1);
  });

  it("CONTROLE: o canal oficial arquiva como antes, sem tocar nas colunas da instância própria", async () => {
    h.sessao = sessao("meta_cloud");
    const r = await desconectar();
    expect(r.status).toBe(200);
    expect(arquivamento()?.campos).not.toHaveProperty("uazapi_token_encrypted");
    expect(arquivamento()?.campos).not.toHaveProperty("webhook_secret_encrypted");
    expect(h.desligar).not.toHaveBeenCalled();
  });

  it("o que sai da linha é só da instância própria", () => {
    expect(credencialQueSaiAoArquivar("uazapi")).toEqual({
      uazapi_token_encrypted: null,
      uazapi_token_fingerprint: null,
    });
    for (const outro of ["waha", "meta_cloud", "zernio", "datafy"]) expect(credencialQueSaiAoArquivar(outro)).toEqual({});
  });

  it("nenhuma coluna zerada ao arquivar é NOT NULL no schema (baseline + migrations)", () => {
    const raiz = path.resolve(__dirname, "../..");
    const baseline = readFileSync(path.join(raiz, "supabase/baseline.sql"), "utf8");
    const tabela = baseline.slice(baseline.indexOf('CREATE TABLE IF NOT EXISTS "public"."channel_sessions" ('));
    const corpo = tabela.slice(0, tabela.indexOf("\n);"));
    const migration = readFileSync(path.join(raiz, "supabase/migrations/20261108190000_9252_canal_uazapi.sql"), "utf8");
    // A coluna nasce no CREATE TABLE ou num `add column` do apêndice; em nenhum dos dois pode ser NOT NULL.
    const declaracoes = [...corpo.split("\n"), ...baseline.split("\n").filter((l) => /add column/i.test(l))];
    for (const coluna of Object.keys(credencialQueSaiAoArquivar("uazapi"))) {
      const linha = declaracoes.find((l) => new RegExp(`(^\\s*"${coluna}"|add column (if not exists )?"?${coluna}"?\\s)`, "i").test(l));
      expect(linha, `${coluna} no baseline`).toBeDefined();
      expect(linha, coluna).not.toMatch(/NOT NULL/i);
      for (const sql of [baseline, migration]) {
        expect(sql, coluna).not.toMatch(new RegExp(`alter column "?${coluna}"? set not null`, "i"));
        expect(sql, coluna).not.toMatch(new RegExp(`add column (if not exists )?"?${coluna}"? [^,;]*not null`, "i"));
      }
    }
    // E o segredo, que FICA, é de fato NOT NULL — a razão de ele não estar na lista.
    expect(corpo).toMatch(/"webhook_secret_encrypted" "bytea" NOT NULL/);
  });
});
