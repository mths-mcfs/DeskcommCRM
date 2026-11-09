import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/channels/instancia-propria          — estado da conexão (o que está gravado).
 * GET   /api/v1/channels/instancia-propria?ao_vivo=1 — idem, perguntando ao servidor (traz o QR).
 * POST  /api/v1/channels/instancia-propria          — VALIDA a URL e o token, grava, aponta o webhook e pede o QR.
 * PATCH /api/v1/channels/instancia-propria          — `{ acao: "novo_qr" }`: pede outro QR (o anterior expirou).
 *
 * O número por QR numa instância do PRÓPRIO cliente. O caminho e o corpo não
 * citam o provider: quem é, como se valida e onde se grava estão em
 * `lib/channels/instancia-propria.ts` (`lint:channels`). Desconectar é a mesma
 * exclusão de toda conexão (`DELETE /api/v1/channel-sessions/[id]`).
 *
 * Conectar um canal expõe a conta da empresa e move o que o agente fala: é
 * decisão de dono (`admin`). O token nunca volta num GET — a tela sabe que
 * existe, não qual é.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  conectarInstanciaPropria,
  estadoDaInstanciaPropria,
  novoQrDaInstanciaPropria,
} from "@/lib/channels/instancia-propria";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { basePublicaDaInstalacao } from "@/lib/webhooks/url-publica";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECURSO = "channels_instancia_propria";

const conectarSchema = z.object({
  base_url: z.string().trim().min(8).max(500),
  token: z.string().trim().min(8).max(512),
});
const acaoSchema = z.object({ acao: z.literal("novo_qr") });

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const estado = await estadoDaInstanciaPropria(createAdminClient(), authz.org.orgId, {
    aoVivo: req.nextUrl.searchParams.get("ao_vivo") === "1",
  });
  return ok({ ...estado, aviso: estado.aviso ? t(estado.aviso) : null }, { requestId });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("Informe a URL do servidor e o token da instância."), 422, { requestId });
  }

  const r = await conectarInstanciaPropria(createAdminClient(), {
    organizationId: authz.org.orgId,
    baseUrl: parsed.data.base_url,
    token: parsed.data.token,
    webhookBase: basePublicaDaInstalacao(req),
    userId: authz.user.id,
    requestId,
  });
  if (!r.ok) {
    if (r.code === "internal_error") {
      const limite = traduzirLimiteDoPlano(r.motivo, authz.user.idioma);
      if (limite) return fail(limite.code, limite.message, 409, { requestId, details: limite.details });
      return fail("internal_error", r.motivo, 500, { requestId });
    }
    return fail(r.code, t(r.motivo), r.status, { requestId });
  }

  // A volta de uma conexão arquivada já é auditada por `reactivateChannelSession`.
  if (r.nova) {
    void audit({
      action: "channel.connected",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "channel_session",
      resourceId: r.channelSessionId,
      requestId,
      metadata: { canal: "instancia_propria", webhook_configurado: r.webhookConfigurado },
    });
  }

  return ok({ ...r.estado, webhook_configurado: r.webhookConfigurado }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = acaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("invalid_request", t("Ação desconhecida."), 422, { requestId });

  const r = await novoQrDaInstanciaPropria(createAdminClient(), authz.org.orgId);
  if (!r.ok) return fail(r.code, t(r.motivo), r.status, { requestId });
  return ok(r.estado, { requestId });
}
