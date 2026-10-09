# Agente Choppatinhas

## Avisos automáticos pelo WhatsApp

O agente acompanha mudanças na tabela `pedidos`, feitas no painel ou diretamente
no Supabase. Envia avisos de confirmação/fila, início do preparo, pedido pronto,
saída para entrega, entrega/retirada concluída e cancelamento. Para retirada,
`saiu_entrega` significa pronto para buscar, conforme o painel atual.

Cada mudança fica numa fila persistente, na mesma transação do pedido. O agente
consome a fila ao iniciar, ao receber eventos Realtime e a cada cinco segundos.
Falhas de envio são retentadas com espera crescente; as etapas de cada pedido
mantêm a ordem. Um aviso por status/pedido e reservas temporárias evitam envios
concorrentes. Avisos antigos já enviados permanecem registrados.

Para ativar:

1. Execute **`avisos.sql`** no SQL Editor do projeto Supabase do Choppatinhas.
   É idempotente e não envia mensagens nem altera o status de pedidos existentes.
2. Atualize/reimplante o agente com este código e as variáveis `SUPA_URL`,
   `SUPA_SERVICE_KEY`, `EVOLUTION_URL`, `EVOLUTION_KEY` e `EVOLUTION_INSTANCE`.
   As chaves ficam somente no servidor.
3. Em um pedido de teste com um telefone controlado pela equipe, avance as etapas
   no painel e confira os avisos e os logs `aviso/enviado`.

A fila registra mudanças ocorridas após a instalação do gatilho. Não há disparo
retroativo para pedidos antigos. O painel atual agrupa “Pronto / Saiu”: para
delivery, esse movimento grava `saiu_entrega`; um aviso separado de “pronto” exige
uma mudança real para o status `pronto`.

## Passar a conversa para uma atendente

Quando o agente não conseguir responder com segurança, receber uma reclamação
que exija decisão humana ou o cliente pedir uma pessoa, ele registra uma pausa de
10 minutos em `agente_pausas` e mostra um aviso persistente no painel de pedidos.
Quando a atendente responder pelo WhatsApp conectado à Evolution, a resposta é
gravada como fala humana e a pausa de 10 minutos recomeça. Durante a pausa, toda
mensagem de texto do cliente é gravada, mas o bot não responde. Ao fim dos 10
minutos, a próxima mensagem do cliente volta ao agente; o histórico usado pelo
modelo inclui as mensagens mais recentes de ambos os lados. A duração pode ser
ajustada com `PAUSA_ATENDENTE_MINUTOS`. Áudios e imagens enviados pela atendente
ficam registrados como mídia recebida, sem transcrição ou análise externa.

Se a Evolution aceitar a mensagem e o processo cair antes de registrar o envio,
uma retentativa pode repetir o aviso. A API de envio e o banco não compartilham
uma transação. Erros e tentativas ficam em `notificacoes_pedido_enviadas`.

## Verificação

Use Node.js 22 ou superior. Execute `npm ci` e `npm test`. Os testes executam o SQL em Postgres local
(PGlite), validam gatilhos/permissões/reservas e simulam o envio pela Evolution.
Não usam dados nem enviam mensagens de produção.
