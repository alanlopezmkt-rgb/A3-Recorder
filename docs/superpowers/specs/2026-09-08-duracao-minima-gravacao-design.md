# Exigir Gravação Completa da Aula (Duração Mínima) — Spec

## Contexto

O A3-OS Recorder grava o áudio da aba durante uma aula. Hoje, ao clicar em
"Parar", a extensão sempre trata a gravação como definitiva
(`isFinal: true`) e sobe o áudio para o Supabase, não importa a duração
real. A única checagem de duração existente é feita **depois**, no
backend (`knowledge-tools/lib/duration-check.js`), comparando a duração
real com uma tabela de durações esperadas (`data/duracoes-esperadas.json`)
e marcando a aula como `status: "incompleta"` no frontmatter — mas isso só
aparece horas depois, num dashboard, depois que a transcrição já rodou
sobre um áudio incompleto.

O feature "Gravação Resiliente a Interrupções"
([2026-09-07-gravacao-resiliente-design.md](2026-09-07-gravacao-resiliente-design.md))
já resolve o caso de o Chrome/PC travar no meio de uma gravação: a sessão
fica marcada como não-final, e ao retomar a extensão junta os pedaços
(segmentos de um "grupo de gravação") num áudio contínuo antes de mandar
para transcrição.

Este spec estende essa mesma máquina de grupos para o caso de o usuário
**parar manualmente antes da aula acabar de verdade**: hoje isso é tratado
como uma gravação completa e válida (só falha na checagem tardia do
backend); deve passar a ser tratado, na hora, do mesmo jeito que uma
sessão interrompida por crash — avisando o usuário e, se ele insistir,
mantendo a sessão aberta para ser completada depois.

## Objetivo

Ao clicar em "Parar", se a duração gravada estiver visivelmente abaixo do
que se espera para aquela aula, a extensão deve:
1. Avisar o usuário antes de finalizar, com a opção de continuar gravando
   sem perder o que já foi gravado.
2. Se o usuário insistir em parar mesmo assim, gravar o segmento como
   **não-final** — ele entra no grupo da aula e será unido ao(s)
   próximo(s) segmento(s) automaticamente, exatamente como já acontece
   hoje para uma sessão interrompida por crash.

Meta final: o banco (Supabase) sempre acaba recebendo o áudio completo da
aula, seja a interrupção causada por um crash ou por o usuário ter parado
cedo demais por engano.

**Fora de escopo:** gravação mais longa que o esperado (aluno pausou o
vídeo, áudio da aba virou silêncio) não é tratada por este spec — o aviso
"longa" continua existindo só no dashboard (`knowledge-tools`), sem
comportamento novo no cliente.

## Identidade da aula: reaproveitar o schema já existente

A extensão já resolve curso/módulo/número da aula a partir do título da
aba, através de `resolverCursoModulo(title, token, moduleName)`
(`extension/background.js`) — só que hoje essa resolução roda **depois**
de parar, dentro de `enviarParaSupabase`, e tem efeito colateral: ela cria
`courses`/`modules`/`lessons` no Supabase se não existirem.

Este spec **não** introduz um esquema de identidade novo (nada de slugs
paralelos tipo `duracoes-esperadas.json`). Em vez disso:

- Adiciona-se uma coluna `expected_duration_seconds` (integer, nullable)
  na tabela `lessons` do Supabase.
- Um script de migração único (rodado uma vez, fora do fluxo normal)
  povoa essa coluna a partir do `duracoes-esperadas.json` do
  knowledge-tools, casando por nome de curso + nome de módulo + número da
  aula com as linhas de `lessons` já existentes (ou criando as linhas que
  ainda não existem, do mesmo jeito que `resolverCursoModulo` cria hoje).
- Dali em diante, `duracoes-esperadas.json` deixa de ser a fonte
  operacional — a coluna em `lessons` é a fonte única de verdade. O
  `knowledge-tools/lib/duration-check.js` deve ser atualizado para ler de
  lá (consulta ao Supabase) em vez do JSON local. (Esse arquivo json vira
  legado — não é apagado neste spec, só deixa de ser lido.)

### Resolução somente-leitura (nova)

`resolverCursoModulo` cria curso/módulo/aula como efeito colateral do
upload — não pode ser reaproveitada como está para uma checagem que roda
**antes** de decidir se vai finalizar (rodar isso a cada clique em
"Parar", inclusive quando a aula é nova, criaria linhas de curso/módulo
prematuramente, antes de o áudio existir).

Cria-se uma função irmã, só leitura:

```js
// extension/background.js
async function buscarDuracaoEsperada(title, moduleName, token) {
    // Mesmo parsing de resolverCursoModulo (regex do título, resolução de
    // módulo por nome global, depois por curso), mas SEM inserir nada:
    // usa só os SELECTs, e retorna null em qualquer ponto em que hoje
    // resolverCursoModulo faria um INSERT.
    // Retorna: { expectedDurationSeconds: number } ou null se curso,
    // módulo ou aula ainda não existem no Supabase (aula nunca foi
    // gravada antes) — nesse caso não há dado de referência, e a
    // checagem de duração é pulada (mesma filosofia do
    // duration-check.js: sem duração esperada cadastrada, não há o que
    // afirmar).
}
```

Chamada pelo popup no momento do clique em "Parar", antes de qualquer
outra coisa.

## Fluxo no clique em "Parar" (popup.js)

1. Usuário clica em "Parar".
2. Popup já sabe o tempo decorrido da gravação atual (cronômetro
   existente). Chama `buscarDuracaoEsperada(title, moduleName, token)`
   via mensagem para o background.
3. **Sem duração cadastrada** (retorno `null`, ou erro de rede/Supabase
   indisponível) → segue direto para o fluxo de parar normal, sem aviso
   (fail-open: nunca bloqueia por causa de uma falha na checagem em si).
4. **Com duração cadastrada**: compara `tempoDecorridoSegundos` com
   `expectedDurationSeconds * 0.95`.
   - `tempoDecorridoSegundos >= expectedDurationSeconds * 0.95` → segue
     para o fluxo de parar normal (`isFinal: true`, como hoje).
   - `tempoDecorridoSegundos < expectedDurationSeconds * 0.95` → mostra o
     modal de aviso (ver abaixo) e **não** chama `pararGravacao` ainda.

### Modal de aviso

Texto (com os valores reais formatados em `MMmSSs`):

> **Gravação abaixo do esperado**
> Você gravou 3min 12s. Essa aula costuma durar cerca de 40min.
>
> [Continuar gravando] [Parar mesmo assim]

- **Continuar gravando**: fecha o modal, não faz mais nada — a gravação
  em andamento não é afetada (não pausa, não reinicia).
- **Parar mesmo assim**: fecha o modal e prossegue com o fluxo de parar,
  mas sinalizando que a duração não foi atingida (ver próxima seção).

## Fluxo em background.js: `isFinal` deixa de ser sempre `true`

Hoje, `recording-finished` sempre manda `isFinal: true` para
`enviarParaSupabase` (`background.js`, dentro do handler de
`recording-finished`). Passa a receber esse valor do popup:

```js
// popup.js, ao clicar em "Parar mesmo assim" (ou ao parar sem aviso)
chrome.runtime.sendMessage({
    target: "background",
    action: "stop-recording",
    duracaoConfirmadaIncompleta: true // ou false/omitido no caso normal
});
```

```js
// background.js — handler de recording-finished
const isFinal = !message.duracaoConfirmadaIncompleta;

if (message.sessionId) {
    if (isFinal) {
        await marcarMarcadorComoFinal(message.sessionId);
    }
    // se NÃO for final, o marcador continua como já estava
    // (isFinal: false) — mesmo estado de uma sessão interrompida por
    // crash, pronta para reconciliação/continuação.
}

// ... (upload igual a hoje, chunks decodificados, etc.)

await enviarParaSupabase({
    title: currentRecording.title,
    moduleName: currentRecording.moduleName,
    filename: message.filename,
    audioBlob,
    recordingGroupId: existingGroup ? existingGroup.recordingGroupId : null,
    segmentIndex: existingGroup ? existingGroup.nextSegmentIndex : null,
    isFinal
});
```

Com `isFinal: false`, `enviarParaSupabase` já hoje segue o caminho de
"segmento de grupo, não fecha a aula" (mesma lógica usada pela
reconciliação de sessão órfã) — nenhuma mudança adicional é necessária
nesse ponto, `isFinal` já é um parâmetro existente de
`enviarParaSupabase`.

Na próxima vez que o usuário gravar a mesma aula (mesmo `lessonKey`), o
`iniciarGravacao` já hoje reconhece um grupo aberto para esse `lessonKey`
e continua a sequência de segmentos — o merge final acontece no servidor
quando a aula finalmente for marcada `isFinal: true` (seja porque o
usuário completou a duração dessa vez, seja porque o grupo expirou depois
de 7 dias, casos já cobertos pelo spec de gravação resiliente).

## Tratamento de erro

- Falha ao consultar `buscarDuracaoEsperada` (rede, token expirado,
  Supabase fora do ar): loga o erro, trata como "sem duração cadastrada"
  — nunca impede o usuário de parar a gravação.
- `expected_duration_seconds` nulo na linha de `lessons` (aula existe mas
  duração nunca foi cadastrada): mesmo tratamento — sem aviso.

## Testes

- Unitário: função pura de comparação
  (`tempoDecorrido < expectedDurationSeconds * 0.95`) com casos limite
  (exatamente 95%, 94.9%, 100%, acima de 100%) — pode viver junto da
  lógica em `extension/lib/` para ficar isolada de `chrome.*`.
- Unitário: `buscarDuracaoEsperada` retorna `null` quando módulo ou aula
  não existem no Supabase (mock do `A3Supabase.restSelect`), e retorna o
  valor certo quando existem.
- Manual (QA local, já que a extensão depende de `chrome://` e de um
  Supabase real):
  1. Aula com `expected_duration_seconds` cadastrado. Gravar por menos de
     95% do esperado, clicar em Parar → ver o modal com os valores
     certos.
  2. Clicar em "Continuar gravando" → confirmar que a gravação não foi
     interrompida (cronômetro não zera, upload não acontece).
  3. Parar de novo, agora acima de 95% → parar normal, sem modal,
     `isFinal: true`.
  4. Repetir o cenário 1, mas clicando em "Parar mesmo assim" → conferir
     no Supabase que o segmento subiu com `is_final: false` e que o grupo
     da aula continua aberto.
  5. Gravar a mesma aula de novo, completando a duração → parar
     normalmente → conferir que o grupo fecha e os dois segmentos foram
     mesclados num único áudio (mesma verificação já usada no QA da
     gravação resiliente).
  6. Aula sem `expected_duration_seconds` cadastrado → parar cedo → nunca
     aparece o modal.
