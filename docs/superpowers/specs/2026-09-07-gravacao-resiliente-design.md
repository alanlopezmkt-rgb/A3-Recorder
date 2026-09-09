# Gravação Resiliente a Interrupções — Design

**Contexto:** hoje a extensão A3-OS Recorder captura o áudio da aba
inteiro em memória (array de chunks no offscreen document) e só grava
em disco/Supabase quando o usuário clica em "Parar". Se o Chrome ou o
PC fechar antes disso — por exemplo, alguém grava 1h de uma aula de 2h,
fecha o notebook e só volta no dia seguinte — todo o áudio gravado até
ali se perde, porque o offscreen document (e o array de chunks em
memória) morre junto com o navegador.

Esse documento descreve como tornar esse fluxo resiliente: nenhum
trecho gravado se perde por mais de ~30s, e uma aula gravada em pedaços
ao longo de vários dias chega inteira e contínua na transcrição.

## Objetivo

- Perda máxima de áudio em caso de fechamento abrupto do
  Chrome/PC: ~30 segundos (o intervalo entre salvamentos locais).
- Retomar uma aula interrompida deve ser tão simples quanto clicar em
  "Gravar" de novo na mesma aula — sem diálogos, sem passo extra.
- O arquivo final entregue para transcrição deve ser um único áudio
  contínuo, como se a gravação nunca tivesse sido interrompida.
- Nenhuma mudança de comportamento para o caso comum (aula gravada do
  início ao fim sem interrupção) — zero degradação de UX ou risco pro
  fluxo que já funciona hoje.

## Fora de escopo

- Pausa deliberada por parte do usuário (ex.: um botão "Pausar" no
  meio da gravação). O único botão continua sendo "Parar", que sempre
  finaliza e envia a gravação atual — igual hoje. O que este design
  resolve é exclusivamente a interrupção **abrupta** (fechar o
  navegador/PC sem clicar em Parar).
- Concatenar áudio no lado do navegador. Dois arquivos `.webm`
  gravados por instâncias separadas do `MediaRecorder` não podem ser
  concatenados byte a byte (cada um tem seu próprio cabeçalho de
  contêiner) — a junção acontece no servidor, via `ffmpeg`.

## Arquitetura

Duas camadas independentes, cada uma resolvendo uma parte do problema:

### Camada 1 — Backup local durante a gravação ativa

Protege contra perder o pedaço que está sendo gravado *agora* quando o
Chrome fecha sem avisar.

- `offscreen.js` já usa `MediaRecorder(stream, options)`. Muda-se o
  timeslice de `start(1000)` para `start(30000)` — cada eventos
  `ondataavailable` já corresponde a um pedaço de ~30s.
- Além de empilhar o blob no array `audioChunks` em memória (como
  hoje, sem mudança), cada blob também é gravado imediatamente num
  IndexedDB local (`a3os-recording-backup`, object store `chunks`),
  com a chave `{ lessonKey, sessionId, seq }`.
- `lessonKey` identifica a aula de forma estável entre uma sessão de
  gravação e outra, mesmo em dias diferentes:
  `slugify(title + "|" + (moduleName || ""))`, reaproveitando o
  `slugify` já usado no `knowledge-tools` (mesma função, copiada pra
  extensão, sem dependência entre repositórios).
- `sessionId` identifica esta tentativa específica de gravação
  (gerado a cada `start-recording`).

Essa camada **não sabe nada sobre grupos ou dias diferentes** — é só
um seguro de curto prazo para a sessão atual.

**Limpeza após upload confirmado:** assim que um segmento é enviado
com sucesso para o Supabase (fluxo normal de "Parar", sem interrupção),
`background.js` apaga do IndexedDB todos os chunks daquele `sessionId`
imediatamente após a confirmação do upload — o mesmo ponto do código
que hoje limpa o array `audioChunks` em memória. Uma gravação completa
e confirmada no banco nunca fica ocupando espaço em disco na máquina
do usuário. Essa limpeza é condicionada à confirmação de sucesso: se o
upload falhar, os chunks permanecem no IndexedDB para retry, seguindo
a mesma regra já descrita em Tratamento de erro.

### Camada 2 — Grupo de gravação (segmentos entre sessões)

Protege contra a aula ficar espalhada em pedaços que nunca se juntam.

- Metadado leve em `chrome.storage.local` (não precisa de IndexedDB —
  é só um registro por aula em aberto):
  ```js
  {
    recordingGroups: {
      "<lessonKey>": {
        recordingGroupId: "<uuid>",
        nextSegmentIndex: 2,
        lastActivityAt: "2026-09-07T14:00:00Z",
        title, outputFolder, moduleName
      }
    }
  }
  ```
- Ao iniciar uma gravação (`iniciarGravacao`), calcula-se o
  `lessonKey` e verifica se já existe uma entrada em
  `recordingGroups` com menos de 7 dias:
  - **Existe** → reaproveita o `recordingGroupId`, usa
    `segmentIndex = nextSegmentIndex`.
  - **Não existe** → gera um novo `recordingGroupId` (uuid),
    `segmentIndex = 0`.

  **Decisão de implementação (ver plano
  `docs/superpowers/plans/2026-09-08-gravacao-resiliente.md`, Task 7):**
  como só existe um botão "Parar", `iniciarGravacao` e um "Parar"
  deliberado nunca *criam* uma entrada nova em `recordingGroups` — só a
  reconciliação (seção seguinte) cria um grupo, ao detectar que uma
  interrupção de fato aconteceu. Um "Parar" deliberado só *reaproveita*
  um grupo se um já existir para aquele `lessonKey` (ou seja, uma sessão
  anterior da mesma aula já foi interrompida e reconciliada); caso
  contrário ele sobe um segmento comum sem grupo, exatamente como hoje.
- Cada segmento gravado (do `start-recording` até o `stop-recording`
  daquela sessão) vira **uma linha própria em `audio_files`**, com
  três colunas novas:
  - `recording_group_id uuid` — mesmo valor pra todos os segmentos da
    mesma aula.
  - `segment_index int` — ordem do segmento dentro do grupo (0, 1, 2…).
  - `is_final boolean default true` — `false` para todo segmento
    exceto o que corresponde a um "Parar" deliberado do usuário ou ao
    fechamento do grupo pelo alarme de 7 dias.
  - Quando `recording_group_id` é nulo (aula gravada de uma vez só,
    caso comum), o comportamento é idêntico ao de hoje —
    `is_final` sempre `true`, sem grupo.

### Reconciliação na abertura da extensão

Quando `background.js` acorda (evento `chrome.runtime.onStartup`, ou a
primeira mensagem recebida depois de o Service Worker subir), ele
verifica se `consultarOffscreenGravando()` responde `false` mas existe
alguma entrada em `recordingGroups` cuja última atividade foi há menos
de 30 minutos e cujo offscreen não está mais vivo — sinal de que o
Chrome fechou no meio de uma gravação. Nesse caso:

1. Lê os chunks salvos no IndexedDB pra aquele `sessionId` (todos
   pertencem à mesma sessão, então podem ser concatenados normalmente
   — são partes do mesmo `MediaRecorder`, não sessões diferentes).
2. Monta o blob e sobe como um segmento comum (`is_final: false`,
   mesmo fluxo de upload que já existe hoje para `recording-finished`).
3. Apaga os chunks daquele `sessionId` do IndexedDB.
4. Atualiza `lastActivityAt` no grupo.

Isso acontece em background, sem esperar o usuário clicar em nada — o
segmento interrompido já está seguro no Supabase antes mesmo da pessoa
reabrir a aula.

### Fechamento do grupo (upload final)

Quando o usuário clica em "Gravar" numa aula que tem grupo aberto, o
próximo segmento nasce vinculado a esse grupo. Quando ela finalmente
clica em "Parar" **de propósito** (não uma interrupção), esse último
segmento sobe com `is_final: true` e o grupo é removido de
`recordingGroups`. Como qualquer segmento com upload confirmado, seus
chunks no IndexedDB são apagados nesse momento (regra da Camada 1).

Isso dispara, no lado do servidor, a etapa de junção:

### Junção no worker Python (`supabase_worker.py`)

Hoje o worker processa um `audio_file` por vez. A mudança:

1. Ao pegar um job cujo `audio_files.is_final = true` **e**
   `recording_group_id` não nulo, antes de transcrever, consulta
   todos os `audio_files` com o mesmo `recording_group_id`, ordenados
   por `segment_index`.
2. Baixa cada segmento do Supabase Storage para um arquivo temporário.
3. Roda `ffmpeg -f concat -safe 0 -i lista.txt -c copy juntado.webm`
   (concat demuxer — não recodifica, só costura os contêineres; é o
   jeito padrão de juntar arquivos do mesmo codec sem perda).
4. Segue o pipeline existente (`detectar_duracao`,
   `salvar_na_base_de_conhecimento`, transcrição) usando
   `juntado.webm` como se fosse o único áudio enviado — nenhuma
   mudança na lógica de `duration-check.js`, que já soma a duração
   real do arquivo final.
5. Ao terminar com sucesso, marca as linhas dos segmentos
   intermediários (`is_final: false` do mesmo grupo) com
   `status: "merged"` — mantidas por rastreabilidade, mas fora dos
   filtros que a extensão e a dashboard já usam (`status = 'uploaded'`
   etc.), então não aparecem duplicadas em nenhuma UI.

Se `ffmpeg concat` falhar (ex.: um segmento corrompido), o job cai no
tratamento de erro já existente (`status: "failed"` em
`transcription_jobs`), sem apagar nenhum segmento — dá pra investigar
e reprocessar manualmente.

### Expiração (alarme de 7 dias)

Um `chrome.alarms` periódico (diário) varre `recordingGroups`. Grupo
com `lastActivityAt` há mais de 7 dias:

1. Se o offscreen ainda tiver chunks daquele grupo não enviados
   (situação rara — só aconteceria se a camada 1 nunca rodou),
   envia o que existir.
2. Marca o **último segmento existente** daquele grupo como
   `is_final: true` — isso dispara a junção normalmente, mesmo que a
   aula esteja incompleta. O `duration-check.js` já cobre esse caso
   (duração real bem abaixo da esperada → `status: "incompleta"`,
   aparecendo no aviso vermelho que já existe hoje).
3. Remove a entrada de `recordingGroups`.

## Dados / Schema

**Supabase — `audio_files`** (3 colunas novas, todas opcionais —
compatível com as linhas existentes):

```sql
ALTER TABLE audio_files
  ADD COLUMN recording_group_id uuid,
  ADD COLUMN segment_index int,
  ADD COLUMN is_final boolean NOT NULL DEFAULT true;
```

**IndexedDB local (offscreen), banco `a3os-recording-backup`:**

- Object store `chunks`: `{ id (auto), lessonKey, sessionId, seq, blob, createdAt }`.
  Índice em `sessionId` pra ler/apagar todos os pedaços de uma sessão de uma vez.

**`chrome.storage.local`, chave `recordingGroups`:**

- `{ [lessonKey]: { recordingGroupId, nextSegmentIndex, lastActivityAt, title, outputFolder, moduleName } }`.

## Tratamento de erro

- **Upload do segmento recuperado falha** (sem internet, sessão
  expirada): os chunks continuam no IndexedDB — a reconciliação tenta
  de novo na próxima vez que o background acordar, sem apagar nada
  até confirmar sucesso.
- **`ffmpeg concat` falha no servidor**: job marcado como `failed`,
  segmentos preservados intactos pra reprocessamento manual.
- **Grupo com um único segmento chega a "Parar"**: comportamento
  idêntico a hoje (upload direto, sem passar pela etapa de junção) —
  a coluna `recording_group_id` fica nula nesse caso, então o worker
  nem entra no caminho de merge.
- **IndexedDB cheio ou indisponível** (raríssimo — quota é ligada ao
  espaço em disco): a gravação em memória continua funcionando
  normalmente (camada 1 é um bônus, não uma dependência); só perde a
  proteção extra contra fechamento abrupto.

## Testes

- Unitário: cálculo de `lessonKey` (mesma aula, títulos com pequenas
  variações de espaço/maiúscula devem gerar a mesma chave).
- Unitário: lógica de expiração de 7 dias (grupo exatamente no limite,
  um pouco antes, um pouco depois).
- Integração (offscreen simulado): iniciar gravação, forçar
  `ondataavailable` a cada 30s, verificar que cada blob aparece no
  IndexedDB; simular "fechamento" (destruir o objeto sem chamar
  stop) e verificar que a reconciliação sobe o pedaço certo.
- Integração (worker Python): job com 3 segmentos de teste (arquivos
  `.webm` curtos reais) → verificar que o `ffmpeg concat` produz um
  arquivo cuja duração é a soma dos três, e que o pipeline de
  transcrição roda normalmente sobre o resultado.
- Regressão: gravação de sessão única (caso comum, sem grupo) precisa
  continuar idêntica ao comportamento atual — mesma linha em
  `audio_files`, mesmo fluxo de upload, `recording_group_id` nulo.
