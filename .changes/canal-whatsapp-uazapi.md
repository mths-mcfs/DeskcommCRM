---
impacto: capacidade_nova
secao: adicionado
titulo: Número de WhatsApp por QR numa instância UAZAPI própria
---

Agora dá para ligar um número de WhatsApp que já roda num servidor **UAZAPI**
do cliente. Em **Conexões › UAZAPI**, o admin cola a URL do servidor e o token
da instância; o CRM confere a credencial, guarda o token cifrado, registra o
webhook na instância e mostra o QR (atualizado sozinho) até o número conectar.

Com o número ligado, a conversa funciona como no outro número por QR: texto,
mídia, nota de voz, contato e citação saem pela instância; mensagens recebidas,
as enviadas pelo próprio celular, recibos de entrega e leitura e quedas de
conexão chegam pelo webhook. Grupos, listas de transmissão e canais ficam de
fora.

A URL precisa ser `https`. Para um servidor na rede interna sem certificado, a
instalação pode liberar `http` com `UAZAPI_ALLOW_INSECURE_HTTP=true`.
Desconectar na tela desliga o webhook da instância, sem apagá-la nem deslogar o
número no servidor.
