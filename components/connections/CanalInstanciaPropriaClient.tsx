"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { nomeDoCanal } from "@/lib/channels/estado";
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";

/**
 * Conectar um número por QR que roda numa instância do PRÓPRIO cliente — o
 * servidor que ele já usa (gratuito, contratado ou próprio). O CRM não cria
 * instância: recebe a URL do servidor e o token da instância, valida contra o
 * servidor antes de gravar e aponta o webhook dela para cá sozinho.
 *
 * A marca vem do servidor (`label`): a tela não pode nomear provider
 * (`lint:channels`), e quem instala reconhece o nome do serviço que usa.
 *
 * Enquanto o aparelho não pareou, a tela pergunta ao servidor de tempos em
 * tempos (`?ao_vivo=1`) — é o que traz o QR novo e percebe a leitura.
 */

const ROTA = "/api/v1/channels/instancia-propria";
const CHAVE = ["canal-instancia-propria"];
/** De quanto em quanto tempo a tela pergunta, enquanto espera a leitura do QR. */
const INTERVALO_DO_QR_MS = 5_000;

interface Estado {
  label: string;
  connected: boolean;
  channel_session_id: string | null;
  status: string | null;
  base_url: string | null;
  instance: string | null;
  has_token: boolean;
  phone_number: string | null;
  display_name: string | null;
  qrcode: string | null;
  paircode: string | null;
  aviso: string | null;
  webhook_configurado?: boolean;
}

export function CanalInstanciaPropriaClient() {
  const t = useT();
  const qc = useQueryClient();
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [ocupado, setOcupado] = useState<"conectar" | "qr" | "desconectar" | null>(null);
  const [confirmarSaida, setConfirmarSaida] = useState(false);

  // Falha de leitura não trava a tela: sem estado, o formulário continua servindo.
  const { data: estado = null } = useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: Estado }>(`${ROTA}?ao_vivo=1`)).data,
    // Só pergunta de novo enquanto há uma conexão esperando o aparelho.
    refetchInterval: (q) => {
      const d = q.state.data;
      return d?.channel_session_id && !d.connected ? INTERVALO_DO_QR_MS : false;
    },
  });

  const recarregar = () => qc.invalidateQueries({ queryKey: CHAVE });

  const conectar = async () => {
    setOcupado("conectar");
    try {
      const r = await apiClient.post<{ data: Estado }>(ROTA, { base_url: baseUrl, token });
      // O token sai da memória da tela assim que é gravado: ele não volta num GET.
      setToken("");
      qc.setQueryData(CHAVE, r.data);
      if (r.data.webhook_configurado === false) {
        toast.warning(
          t("Conectado, mas o servidor não aceitou o webhook: o CRM envia e não recebe. Tente conectar de novo."),
        );
      } else {
        toast.success(r.data.connected ? t("Canal conectado.") : t("Instância gravada. Leia o QR no celular."));
      }
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível conectar."));
    } finally {
      setOcupado(null);
    }
  };

  const novoQr = async () => {
    setOcupado("qr");
    try {
      const r = await apiClient.patch<{ data: Estado }>(ROTA, { acao: "novo_qr" });
      qc.setQueryData(CHAVE, r.data);
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível gerar o QR."));
    } finally {
      setOcupado(null);
    }
  };

  const desconectar = async () => {
    if (!estado?.channel_session_id) return;
    setOcupado("desconectar");
    try {
      await apiClient.delete(`/api/v1/channel-sessions/${estado.channel_session_id}`);
      toast.success(t("Conexão desfeita no CRM. A instância continua no seu servidor."));
      setConfirmarSaida(false);
      await recarregar();
      void qc.invalidateQueries({ queryKey: ["channel-sessions"] });
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível desconectar."));
    } finally {
      setOcupado(null);
    }
  };

  const rotulo = estado?.label ?? t("servidor próprio");
  const temConexao = Boolean(estado?.channel_session_id);
  const conectado = estado?.connected ?? false;
  const urlValida = /^https?:\/\/\S+$/i.test(baseUrl.trim());
  const podeConectar = ocupado === null && urlValida && token.trim().length >= 8;

  return (
    <div className="flex flex-col gap-4" data-testid="canal-instancia-propria">
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              {t("Conectar por")} {rotulo}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t(
                "Um número por QR na instância que você já tem. Informe a URL do servidor e o token da instância: o CRM confere, aponta o webhook sozinho e mostra o QR para parear.",
              )}
            </p>
          </div>
          {conectado ? (
            <Badge variant="secondary">{t("Conectado")}</Badge>
          ) : temConexao ? (
            <Badge variant="outline">{t("Aguardando o celular")}</Badge>
          ) : (
            <Badge variant="outline">{t("Não conectado")}</Badge>
          )}
        </div>

        {temConexao && (
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{nomeDoCanal(estado ?? {}, t)}</p>
            <p className="text-xs text-muted-foreground">
              {estado?.phone_number ?? t("sem número informado")} · {estado?.status ?? "—"}
            </p>
            {estado?.base_url && (
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {t("Servidor")}: {estado.base_url}
              </p>
            )}
          </div>
        )}

        {estado?.aviso && (
          <p className="rounded-md border border-warning/40 bg-warning-bg p-2 text-xs" role="status">
            {estado.aviso}
          </p>
        )}

        {temConexao && !conectado && (
          <div className="flex flex-col items-start gap-2" data-testid="qr-da-instancia">
            {estado?.qrcode ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- data URI do servidor, não arquivo estático */}
                <img
                  src={estado.qrcode}
                  alt={t("QR para parear o celular")}
                  className="h-56 w-56 rounded-md border border-border bg-white p-2"
                />
                <p className="text-xs text-muted-foreground">
                  {t("No celular: WhatsApp › Aparelhos conectados › Conectar aparelho, e aponte para o QR.")}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("Sem QR no momento. Gere um novo para parear o celular.")}
              </p>
            )}
            {estado?.paircode && (
              <p className="text-xs">
                {t("Código de pareamento")}: <code className="font-mono">{estado.paircode}</code>
              </p>
            )}
            <Button size="sm" variant="outline" onClick={novoQr} disabled={ocupado !== null}>
              {ocupado === "qr" ? t("Gerando…") : t("Gerar novo QR")}
            </Button>
          </div>
        )}

        {estado?.channel_session_id && <ChannelAiAccess channelId={estado.channel_session_id} />}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="instancia-propria-url">{t("URL do servidor")}</Label>
          <Input
            id="instancia-propria-url"
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={estado?.base_url ?? "https://"}
            autoComplete="off"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="instancia-propria-token">{t("Token da instância")}</Label>
          <Input
            id="instancia-propria-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={estado?.has_token ? t("gravada — preencha para trocar") : ""}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "Guardada cifrada. Depois de gravar ela não é mostrada de novo — para trocar, cole a nova.",
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={conectar} disabled={!podeConectar}>
            {ocupado === "conectar" ? t("Verificando…") : temConexao ? t("Reconectar") : t("Conectar")}
          </Button>
          {temConexao &&
            (confirmarSaida ? (
              <>
                <Button variant="destructive" onClick={desconectar} disabled={ocupado !== null}>
                  {ocupado === "desconectar" ? t("Desconectando…") : t("Confirmar desconexão")}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmarSaida(false)} disabled={ocupado !== null}>
                  {t("Cancelar")}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setConfirmarSaida(true)} disabled={ocupado !== null}>
                {t("Desconectar")}
              </Button>
            ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {t("A credencial é testada contra o provedor antes de ser gravada.")}
        </p>
      </Card>
    </div>
  );
}
