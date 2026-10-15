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
são transcritos/analisados e esse conteúdo também fica no histórico.

Se a Evolution aceitar a mensagem e o processo cair antes de registrar o envio,
uma retentativa pode repetir o aviso. A API de envio e o banco não compartilham
uma transação. Erros e tentativas ficam em `notificacoes_pedido_enviadas`.

## Verificação

Use Node.js 22 ou superior. Execute `npm ci` e `npm test`. Os testes executam o SQL em Postgres local
(PGlite), validam gatilhos/permissões/reservas e simulam o envio pela Evolution.
Não usam dados nem enviam mensagens de produção.

## Horário de funcionamento e agrupamento de mensagens

O agente consulta `info_restaurante` no Supabase antes de responder e antes de criar
um pedido. A chave `horarios_funcionamento` guarda a agenda semanal em JSON:
`0` = domingo, `1` = segunda, até `6` = sábado; cada dia contém intervalos
`[["17:30", "23:00"]]` ou `[]` para fechado. O fuso é sempre `America/Sao_Paulo`.
Sem essa chave, vale o horário padrão: segunda a sexta 17h30–23h, sábado
11h–23h e domingo fechado. Configuração inválida mantém o atendimento fechado.
`loja_aberta=false` continua sendo uma pausa manual, mesmo dentro do expediente.

Execute `horarios.sql` **uma única vez** no SQL Editor do Supabase. O arquivo
registra o horário acima e adiciona uma proteção no banco contra novos pedidos
fora do expediente. Não use `setup.sql` para isso: ele recria dados do cardápio.
Não reaplique a migração depois de personalizar os horários, pois ela repõe a agenda
padrão. O cardápio v3 edita a mesma configuração pelo painel da loja.

Cada conversa aguarda **10 segundos sem novas mensagens** antes de responder.
Nova mensagem reinicia a contagem; texto, áudio e imagem são reunidos em ordem
e cada mensagem original fica registrada com seu ID e metadados. Conversas
diferentes são independentes e uma mesma conversa processa um lote por vez.
Configure `AGRUPAR_MENSAGENS_SEGUNDOS` para mudar a espera. O tempo de geração
da resposta vem depois dessa espera. A fila é em memória: use uma única
instância do agente por instância da Evolution; reinícios descartam lotes pendentes.
Avisos de status de pedidos continuam sendo enviados sem a espera de 10 segundos.

Depois de atualizar, reimplante o agente com `npm start` (Node.js 22+).

## Pix assistido com comprovante

Execute `pix.sql` no Supabase e implante esta versão no EasyPanel. O arquivo cria
rascunhos separados da fila da cozinha, armazena PDFs/imagens em bucket privado
e mostra o código de conferência da equipe. O agente compara os dados; somente
a atendente, com esse código, confirma o recebimento e libera para Novos.
O novo Pix só é ativado em Loja → Pix com comprovante no cardápio depois de o
agente atualizado estar conectado. Há um lembrete após 10 minutos, dentro do expediente.
Mantenha uma instância do agente por Evolution. Não precisa atualizar a impressora.
