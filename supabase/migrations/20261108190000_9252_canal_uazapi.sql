-- manifest: Canal de WhatsApp UAZAPI (API não oficial, instância do próprio cliente) — colunas uazapi_base_url, uazapi_token_encrypted, uazapi_token_fingerprint e uazapi_instance em channel_sessions; vocabulário 'uazapi' nos CHECKs de provider, ref e webhook_events_log (alargamento puro); índices únicos entre ativos pela impressão do token e por (uazapi_base_url, uazapi_instance), com dedup antes.
--
-- ─── O que entra ────────────────────────────────────────────────────────────
-- Um provedor de canal de mensagem novo, ao lado de `waha`, `meta_cloud`,
-- `zernio` e `datafy`. A UAZAPI é um servidor de WhatsApp por QR que o CLIENTE
-- já tem (gratuito, contratado ou próprio): o CRM não cria a instância, só
-- recebe a URL base do servidor e o token da instância, valida e passa a falar
-- com ela. Por isso quatro colunas, todas nullable e vazias em quem não usa:
--
--   uazapi_base_url         a raiz do servidor (https), sem barra no fim;
--   uazapi_token_encrypted  o token da instância, cifrado por fn_encrypt_oauth;
--   uazapi_token_fingerprint a impressão SHA-256 (hex) do token — o que
--                           identifica a instância sem depender do nome do host;
--   uazapi_instance         o nome da instância que o `/instance/status`
--                           devolveu — é o `sessionRef` deste canal, e a coluna
--                           que `channel_sessions_provider_ref_check` exige.
--
-- ─── Por que recriar os CHECKs inteiros ─────────────────────────────────────
-- Mesmo desenho da 0387: o vocabulário é fechado e o CHECK de referência exige
-- a coluna do provider da vez. Drop+add, nunca `exception when duplicate_object`.
-- `webhook_events_log_provider_check` entra junto porque a rota genérica de
-- canal arquiva o corpo cru com o provider da sessão ANTES de conferir quem
-- mandou; sem `uazapi` ali, o arquivo recusaria a linha. A lista de lá carrega
-- também os provedores de cobrança (0601), que este alargamento mantém.
--
-- Alargamento puro nos três: um CHECK que aceita mais valores não é violado por
-- linha que já passava pelo antigo, então não há backfill antes.
--
-- ─── Índices únicos entre ativos ────────────────────────────────────────────
-- Uma instância conectada em duas organizações entregaria as mensagens de uma
-- na outra — e a segunda a conectar desviaria o webhook da primeira em
-- silêncio. Duas chaves, entre linhas não arquivadas:
--
--   impressão do token   a que segura de verdade. O token é da instância (a
--                        UAZAPI dá um por instância), e o hash dele não muda
--                        com o nome pelo qual se chega ao servidor: ponto
--                        final no host, alias de DNS, proxy com prefixo ou IP
--                        apontam para a mesma instância e dão a mesma
--                        impressão. Hash de token aleatório não devolve o
--                        token, e a conferência do webhook exige o token.
--   (servidor, instância) a de antes, mantida: pega a mesma instância com
--                        token girado no mesmo endereço.
--
-- A impressão nasce nula nas linhas que já existem (o token está cifrado e o
-- SQL não o decifra); a próxima conexão a grava. A dedup `-conflito-<id>` roda
-- antes do índice do par (desenho da 0165).

alter table public.channel_sessions
  add column if not exists uazapi_base_url text,
  add column if not exists uazapi_token_encrypted bytea,
  add column if not exists uazapi_token_fingerprint text,
  add column if not exists uazapi_instance text;

comment on column public.channel_sessions.uazapi_base_url is
  'Raiz do servidor UAZAPI do cliente (https, sem barra no fim). Espelhado em lib/channels/uazapi/credentials.ts.';
comment on column public.channel_sessions.uazapi_token_encrypted is
  'Token da instância UAZAPI, cifrado por fn_encrypt_oauth. Nunca volta à tela depois de gravado.';
comment on column public.channel_sessions.uazapi_token_fingerprint is
  'SHA-256 (hex) do token da instância UAZAPI — identifica a instância sem depender do host. Some junto com o token ao desconectar. Espelhado em lib/channels/uazapi/webhook.ts (impressaoDoToken).';
comment on column public.channel_sessions.uazapi_instance is
  'Nome da instância UAZAPI (instance.name do /instance/status). É o sessionRef deste canal. Espelhado em lib/channels/session-ref.ts.';

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
    check (provider in ('waha', 'meta_cloud', 'zernio', 'zernio_social', 'wacalls', 'datafy', 'uazapi'));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha' and waha_session_name is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('zernio', 'zernio_social') and zernio_account_id is not null) or
    (provider = 'wacalls' and wacalls_session_id is not null) or
    (provider = 'datafy' and datafy_phone_number_id is not null) or
    (provider = 'uazapi' and uazapi_instance is not null)
  );

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check check (provider in (
    'waha', 'nuvemshop', 'generic', 'meta_cloud', 'zernio', 'datafy', 'uazapi',
    'stripe', 'asaas'
  ));

with ativos as (
  select id,
         row_number() over (
           partition by uazapi_base_url, uazapi_instance
           order by created_at desc nulls last, id desc
         ) as posicao
    from public.channel_sessions
   where archived_at is null
     and uazapi_instance is not null
)
update public.channel_sessions s
   set uazapi_instance = s.uazapi_instance || '-conflito-' || s.id::text
  from ativos a
 where a.id = s.id
   and a.posicao > 1;

create unique index if not exists channel_sessions_uazapi_instance_ativo_unique
  on public.channel_sessions (uazapi_base_url, uazapi_instance)
  where archived_at is null and uazapi_instance is not null;

create unique index if not exists channel_sessions_uazapi_token_ativo_unique
  on public.channel_sessions (uazapi_token_fingerprint)
  where archived_at is null and uazapi_token_fingerprint is not null;

notify pgrst, 'reload schema';
