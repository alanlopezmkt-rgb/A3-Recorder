# Exigir Gravação Completa da Aula (Duração Mínima) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ao clicar em "Parar" antes de a aula terminar de verdade, avisar o
usuário e — se ele insistir — tratar o segmento como não-final (mesma
máquina de grupos da gravação resiliente a crashes), além de avisar sobre
sessões recuperadas e evitar duplicação quando o usuário grava a aula
inteira de novo do zero.

**Architecture:** Uma coluna nova (`expected_duration_seconds`) na tabela
`lessons` do Supabase vira a fonte única de duração esperada, lida tanto
pela extensão (antes de finalizar) quanto pelo `knowledge-tools`
(checagem tardia) e pelo `Transcritor Local` (decisão de merge). Nenhum
esquema de identidade novo é criado — tudo se apoia nas tabelas
`courses`/`modules`/`lessons` que a extensão já usa.

**Tech Stack:** JavaScript (Chrome Extension MV3, `chrome.storage`,
`chrome.notifications`), Node.js (knowledge-tools, CommonJS), Python
(Transcritor Local, `requests`/`ffmpeg`), Postgres/Supabase REST.

**Spec:** [2026-09-08-duracao-minima-gravacao-design.md](../specs/2026-09-08-duracao-minima-gravacao-design.md)
(depende de [2026-09-07-gravacao-resiliente-design.md](../specs/2026-09-07-gravacao-resiliente-design.md),
já implementado e em produção — v1.2.0)

## Global Constraints

- Limiar de duração insuficiente: **95%** da duração esperada
  (`tempoDecorrido < expectedDurationSeconds * 0.95`).
- Gravação mais longa que o esperado nunca bloqueia nem avisa no cliente
  (fora de escopo deste plano).
- Qualquer falha ao consultar duração esperada (rede, Supabase fora do
  ar, dado ausente) é **fail-open**: nunca impede o usuário de parar.
- `expected_duration_seconds` é a única fonte de verdade daqui em diante;
  `knowledge-tools/data/duracoes-esperadas.json` vira legado (não é
  apagado, só deixa de ser lido pelo código de produção).
- Nenhuma tabela nova é criada — reaproveita `courses`/`modules`/`lessons`
  já existentes no Supabase.
- Todo texto de UI é em português, seguindo o tom já usado na extensão
  (ver `popup/popup.js` e `background.js` para o estilo de mensagens
  existentes).

---

### Task 1: Coluna `expected_duration_seconds` no Supabase

**Files:**
- Create: `A3-Recorder-split/supabase/migrations/2026-09-09-expected-duration-seconds.sql`

**Interfaces:**
- Produces: coluna `lessons.expected_duration_seconds integer null`,
  consumida pelas Tasks 3 (knowledge-tools), 4 (extensão) e 9
  (Transcritor Local).

- [ ] **Step 1: Escrever a migração SQL**

```sql
-- A3-Recorder-split/supabase/migrations/2026-09-09-expected-duration-seconds.sql
--
-- Duração esperada (em segundos) de cada aula, usada para: (a) avisar o
-- usuário na extensão se ele parar de gravar cedo demais; (b) o
-- knowledge-tools marcar uma aula como "incompleta" depois; (c) o
-- Transcritor Local decidir se um segmento final sozinho já é a aula
-- inteira (retomada do zero) ou só uma continuação.
--
-- NULL = duração ainda não cadastrada para essa aula; todo consumidor
-- desta coluna trata NULL como "sem dado de referência, não afirma nada".

ALTER TABLE lessons
    ADD COLUMN IF NOT EXISTS expected_duration_seconds integer;

COMMENT ON COLUMN lessons.expected_duration_seconds IS
    'Duração esperada da aula em segundos, usada para detectar gravações incompletas. NULL = ainda não cadastrada.';
```

- [ ] **Step 2: Rodar a migração**

Rodar via SQL Editor do painel do Supabase (projeto usado por
`A3OS_CONFIG.SUPABASE_URL`/`SUPABASE_ANON_KEY` em
`extension/config.js`), colando o conteúdo do arquivo acima. Confirmar
com:

```sql
select column_name, data_type from information_schema.columns
where table_name = 'lessons' and column_name = 'expected_duration_seconds';
```

Esperado: uma linha, `expected_duration_seconds` / `integer`.

- [ ] **Step 3: Commit**

```bash
cd A3-Recorder-split
git add supabase/migrations/2026-09-09-expected-duration-seconds.sql
git commit -m "feat: adiciona expected_duration_seconds em lessons"
```

---

### Task 2: Migração dos dados de `duracoes-esperadas.json` para o Supabase

**Files:**
- Create: `Transcritor Local/scripts/migrar_duracoes_esperadas.py`
- Test: manual (script de migração única, não faz sentido cobrir com
  suite automatizada — roda uma vez, contra dados reais)

**Interfaces:**
- Consumes: `SUPABASE_URL`, `HEADERS`, `get`, `patch` de
  `supabase_worker.py` (já existentes — service role key com acesso de
  escrita irrestrito); formato do JSON de
  `knowledge-tools/data/duracoes-esperadas.json`
  (`{ aulas: { "<cursoSlug>/<moduloSlug>/aula-<NN>": segundos | [{contains, segundos}] } }`,
  ver `knowledge-tools/lib/duration-check.js`).
- Produces: linhas de `lessons` com `expected_duration_seconds`
  preenchido — consumido pelas Tasks 3, 4, 9.

- [ ] **Step 1: Escrever o script**

```python
# Transcritor Local/scripts/migrar_duracoes_esperadas.py
#
# Migração única: le knowledge-tools/data/duracoes-esperadas.json e
# escreve expected_duration_seconds nas linhas de "lessons" no Supabase
# que correspondem a cada entrada, casando por slug de curso/módulo +
# número da aula. Roda uma vez, manualmente:
#
#   python scripts/migrar_duracoes_esperadas.py --duracoes-json "C:\...\knowledge-tools\data\duracoes-esperadas.json"
#
# Entradas sem curso/módulo/aula correspondente no Supabase são só
# reportadas (nunca criam linha nova) — a aula pode ainda não ter sido
# gravada nenhuma vez.

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from supabase_worker import SUPABASE_URL, HEADERS, get, patch  # noqa: E402


def slugify(texto):
    texto = unicodedata.normalize("NFD", texto or "")
    texto = texto.encode("ascii", "ignore").decode("ascii")
    texto = texto.lower().strip()
    texto = re.sub(r"[^a-z0-9]+", "-", texto)
    return texto.strip("-")


def resolver_duracao(entrada):
    # Mesma regra de knowledge-tools/lib/duration-check.js
    # (resolverDuracaoEsperada): número direto, ou a maior duração entre
    # variantes quando a chave tem mais de uma aula com o mesmo número.
    if entrada is None:
        return None
    if isinstance(entrada, (int, float)):
        return int(entrada)
    if isinstance(entrada, list) and entrada:
        return max(int(v["segundos"]) for v in entrada)
    return None


def carregar_duracoes(caminho_json):
    dados = json.loads(Path(caminho_json).read_text(encoding="utf-8"))
    return dados.get("aulas", {})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--duracoes-json", required=True)
    args = parser.parse_args()

    duracoes = carregar_duracoes(args.duracoes_json)
    print(f"[MIGRACAO] {len(duracoes)} entrada(s) em duracoes-esperadas.json")

    cursos = get("courses", {"select": "id,name"})
    modulos = get("modules", {"select": "id,name,course_id"})
    aulas = get("lessons", {"select": "id,lesson_number,module_id"})

    cursos_por_slug = {slugify(c["name"]): c for c in cursos}
    modulos_por_curso = {}
    for m in modulos:
        modulos_por_curso.setdefault(m["course_id"], []).append(m)

    aulas_por_modulo = {}
    for a in aulas:
        aulas_por_modulo.setdefault(a["module_id"], {})[a["lesson_number"]] = a

    atualizadas = 0
    nao_encontradas = []

    for chave, entrada in duracoes.items():
        # chave: "<cursoSlug>/<moduloSlug>/aula-<NN>"
        partes = chave.split("/")
        if len(partes) != 3:
            nao_encontradas.append((chave, "formato de chave inesperado"))
            continue

        curso_slug, modulo_slug, aula_parte = partes
        match_numero = re.match(r"aula-(\d+)$", aula_parte)
        if not match_numero:
            nao_encontradas.append((chave, "número de aula não reconhecido"))
            continue
        aula_numero = int(match_numero.group(1))

        curso = cursos_por_slug.get(curso_slug)
        if not curso:
            nao_encontradas.append((chave, f"curso '{curso_slug}' não encontrado"))
            continue

        modulo = next(
            (m for m in modulos_por_curso.get(curso["id"], []) if slugify(m["name"]) == modulo_slug),
            None
        )
        if not modulo:
            nao_encontradas.append((chave, f"módulo '{modulo_slug}' não encontrado no curso '{curso_slug}'"))
            continue

        aula = aulas_por_modulo.get(modulo["id"], {}).get(aula_numero)
        if not aula:
            nao_encontradas.append((chave, f"aula número {aula_numero} não encontrada no módulo '{modulo_slug}'"))
            continue

        duracao_segundos = resolver_duracao(entrada)
        if duracao_segundos is None:
            nao_encontradas.append((chave, "duração inválida no JSON"))
            continue

        patch("lessons", aula["id"], {"expected_duration_seconds": duracao_segundos})
        atualizadas += 1
        print(f"[MIGRACAO] {chave} -> lessons.id={aula['id']} ({duracao_segundos}s)")

    print(f"\n[MIGRACAO] concluído: {atualizadas} aula(s) atualizada(s), {len(nao_encontradas)} não encontrada(s).")
    if nao_encontradas:
        print("[MIGRACAO] não encontradas (aula provavelmente nunca gravada ainda):")
        for chave, motivo in nao_encontradas:
            print(f"  - {chave}: {motivo}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Rodar contra o Supabase real**

```bash
cd "Transcritor Local"
python scripts/migrar_duracoes_esperadas.py --duracoes-json "../knowledge-tools/data/duracoes-esperadas.json"
```

Conferir a saída: número de aulas atualizadas bate com o esperado, e a
lista de "não encontradas" só contém aulas que de fato nunca foram
gravadas (nome de curso/módulo real, não erro de digitação/slug).

- [ ] **Step 3: Conferir uma linha no Supabase**

```sql
select l.id, l.lesson_number, l.expected_duration_seconds, m.name as modulo
from lessons l join modules m on m.id = l.module_id
where l.expected_duration_seconds is not null
limit 5;
```

- [ ] **Step 4: Commit**

```bash
cd "Transcritor Local"
git add scripts/migrar_duracoes_esperadas.py
git commit -m "feat: script de migração de durações esperadas para o Supabase"
```

---

### Task 3: `knowledge-tools` passa a ler duração esperada do Supabase

**Files:**
- Modify: `knowledge-tools/lib/duration-check.js`
- Create: `knowledge-tools/lib/supabase-durations.js`
- Test: `knowledge-tools/test/duration-check.test.js` (criar se não
  existir; ou o arquivo de teste existente para este módulo — verificar
  antes de criar duplicado)

**Interfaces:**
- Consumes: `expected_duration_seconds` de `lessons` (Task 1/2); mesmas
  variáveis de ambiente `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` já
  usadas por `Transcritor Local` (procurar um `.env` compartilhado ou
  documentar que este `.env` precisa existir também na máquina que roda
  `knowledge-ingest-transcricao.js` — normalmente a mesma máquina do
  Transcritor Local).
- Produces: `verificarDuracao(...)` mantém a mesma assinatura e retorno
  (`{ suspeita, tipo, duracaoEsperada }`) — nenhum chamador externo
  muda.

- [ ] **Step 1: Criar o cliente Supabase mínimo para leitura**

```js
// knowledge-tools/lib/supabase-durations.js
//
// Le expected_duration_seconds de "lessons" via Supabase REST, casando
// por nome de curso + nome de módulo + número da aula (mesmo esquema
// que a extensão usa para criar essas linhas). Cacheia em memória por
// processo — knowledge-ingest-transcricao.js roda uma aula por
// invocação de CLI, então uma consulta por execução é suficiente.

const https = require('https');

function getEnv(nome) {
  const valor = process.env[nome];
  if (!valor) {
    throw new Error(`Variável de ambiente ${nome} não configurada (necessária para consultar durações esperadas no Supabase).`);
  }
  return valor;
}

function restSelect(table, query) {
  const url = `${getEnv('SUPABASE_URL')}/rest/v1/${table}?${query}`;
  const headers = {
    apikey: getEnv('SUPABASE_SERVICE_ROLE_KEY'),
    Authorization: `Bearer ${getEnv('SUPABASE_SERVICE_ROLE_KEY')}`
  };

  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let corpo = '';
      res.on('data', (chunk) => { corpo += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Falha ao consultar ${table}: HTTP ${res.statusCode} — ${corpo}`));
          return;
        }
        try {
          resolve(JSON.parse(corpo));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Busca a duração esperada (em segundos) de uma aula pelo nome do curso,
 * nome do módulo e número da aula. Retorna null se curso, módulo, aula,
 * ou a própria duração não existirem/estiverem cadastrados — sem dado de
 * referência, quem chama trata como "sem checagem a fazer".
 */
async function buscarDuracaoEsperadaSupabase({ cursoNome, moduloNome, aulaNumero }) {
  try {
    const cursos = await restSelect('courses', `select=id&name=eq.${encodeURIComponent(cursoNome)}`);
    if (!cursos.length) return null;

    const modulos = await restSelect(
      'modules',
      `select=id&course_id=eq.${cursos[0].id}&name=eq.${encodeURIComponent(moduloNome)}`
    );
    if (!modulos.length) return null;

    const aulas = await restSelect(
      'lessons',
      `select=expected_duration_seconds&module_id=eq.${modulos[0].id}&lesson_number=eq.${aulaNumero}`
    );
    if (!aulas.length) return null;

    return aulas[0].expected_duration_seconds || null;
  } catch (error) {
    console.error('[DURACAO] falha ao consultar duração esperada no Supabase:', error.message);
    return null;
  }
}

module.exports = { buscarDuracaoEsperadaSupabase };
```

- [ ] **Step 2: Atualizar `duration-check.js` para consultar o Supabase**

Substituir `carregarDuracoesEsperadas()`/`resolverDuracaoEsperada()`
(leitura do JSON local) por uma chamada ao novo módulo. Como o restante
do arquivo (`chaveAula`, `LIMIAR_PERCENTUAL`, `LIMIAR_SUPERIOR`,
`verificarDuracao`) já recebe `cursoSlug`/`moduloSlug`/`aulaNumero`/
`aulaSlug` do chamador, mas o Supabase é indexado por **nome** (não
slug), o chamador (`knowledge-ingest-transcricao.js`) precisa passar
também `cursoNome`/`moduloNome` (nomes reais, não slugificados) — ver
Step 3.

```js
// knowledge-tools/lib/duration-check.js
const { buscarDuracaoEsperadaSupabase } = require('./supabase-durations');

// LIMIAR_PERCENTUAL e LIMIAR_SUPERIOR continuam iguais.

async function verificarDuracao({ cursoNome, moduloNome, aulaNumero, duracaoRealSegundos }) {
  const duracaoEsperada = await buscarDuracaoEsperadaSupabase({ cursoNome, moduloNome, aulaNumero });

  if (!duracaoEsperada || !duracaoRealSegundos) {
    return { suspeita: false, tipo: null, duracaoEsperada: duracaoEsperada || null };
  }

  let tipo = null;
  if (duracaoRealSegundos < duracaoEsperada * LIMIAR_PERCENTUAL) {
    tipo = 'curta';
  } else if (duracaoRealSegundos > duracaoEsperada * LIMIAR_SUPERIOR) {
    tipo = 'longa';
  }

  return { suspeita: tipo !== null, tipo, duracaoEsperada };
}

module.exports = { verificarDuracao, LIMIAR_PERCENTUAL, LIMIAR_SUPERIOR };
```

(`chaveAula` e `resolverDuracaoEsperada` são removidos — não têm mais
uso; `carregarDuracoesEsperadas`/`DURACOES_PATH` também saem do
arquivo. `verificarDuracao` agora é `async`.)

- [ ] **Step 3: Atualizar o chamador para `await` e passar nomes reais**

Em `knowledge-tools/bin/knowledge-ingest-transcricao.js`, o `args.curso`
já é o **nome** do curso (não o slug — `cursoSlug` é derivado dele só
para o caminho de arquivo). Ajustar a chamada:

```js
const { suspeita: gravacaoSuspeita, tipo: duracaoTipo, duracaoEsperada } = await verificarDuracao({
  cursoNome: args.curso,
  moduloNome: args.modulo,
  aulaNumero: args.aula,
  duracaoRealSegundos,
});
```

(Confirmar em `parseArgs`/uso mais acima do arquivo que `args.modulo`
existe com o nome real do módulo — se o script só recebe `moduloSlug`
hoje, ajustar o comando que invoca `knowledge-ingest-transcricao.js`
para passar também `--modulo "<nome real>"`. Ler o arquivo completo
antes de decidir — não presumir o nome exato da flag.)

- [ ] **Step 4: Atualizar/criar teste unitário**

```js
// knowledge-tools/test/duration-check.test.js
const assert = require('node:assert');
const { test, mock } = require('node:test');

test('verificarDuracao: sem duração esperada não afirma suspeita', async () => {
  const supabaseDurations = require('../lib/supabase-durations');
  mock.method(supabaseDurations, 'buscarDuracaoEsperadaSupabase', async () => null);

  const { verificarDuracao } = require('../lib/duration-check');
  const resultado = await verificarDuracao({
    cursoNome: 'SketchUp 2024', moduloNome: 'Introdução', aulaNumero: 1, duracaoRealSegundos: 120
  });

  assert.strictEqual(resultado.suspeita, false);
  assert.strictEqual(resultado.tipo, null);
});

test('verificarDuracao: abaixo de 60% marca como curta', async () => {
  const supabaseDurations = require('../lib/supabase-durations');
  mock.method(supabaseDurations, 'buscarDuracaoEsperadaSupabase', async () => 2400); // 40min

  const { verificarDuracao } = require('../lib/duration-check');
  const resultado = await verificarDuracao({
    cursoNome: 'SketchUp 2024', moduloNome: 'Introdução', aulaNumero: 1, duracaoRealSegundos: 180 // 3min
  });

  assert.strictEqual(resultado.suspeita, true);
  assert.strictEqual(resultado.tipo, 'curta');
});
```

- [ ] **Step 5: Rodar os testes**

```bash
cd knowledge-tools
node --test test/duration-check.test.js
```

Esperado: PASS nos dois casos.

- [ ] **Step 6: Commit**

```bash
cd knowledge-tools
git add lib/duration-check.js lib/supabase-durations.js bin/knowledge-ingest-transcricao.js test/duration-check.test.js
git commit -m "feat: duration-check consulta expected_duration_seconds no Supabase"
```

---

### Task 4: Extensão — resolução só-leitura de duração esperada + duração acumulada do grupo

**Files:**
- Modify: `A3-Recorder-split/extension/background.js`
- Modify: `A3-Recorder-split/extension/lib/recording-groups.js`
- Test: `A3-Recorder-split/extension/test/recording-groups.test.js` (criar
  se não existir; seguir o padrão de teste já usado no repo para libs em
  `extension/lib/` — conferir um teste existente antes de escrever este)

**Interfaces:**
- Produces: `buscarDuracaoEsperada(title, moduleName, token)` em
  `background.js`, retornando `{ expectedDurationSeconds } | null` —
  consumida pela Task 5. `A3RecordingGroups.advanceSegment(lessonKey, segmentDurationSeconds)`
  e `createGroup(lessonKey, meta)` (meta ganha `segmentDurationSeconds`
  opcional) passam a manter `group.totalRecordedSeconds` — consumido
  pelas Tasks 6 e 8.

- [ ] **Step 1: `recording-groups.js` — acumular duração**

```js
// extension/lib/recording-groups.js — substituir createGroup e advanceSegment

async function createGroup(lessonKey, meta) {
    const groups = await getGroups();
    const group = {
        recordingGroupId: crypto.randomUUID(),
        nextSegmentIndex: 0,
        lastActivityAt: new Date().toISOString(),
        title: meta.title || "aula",
        outputFolder: meta.outputFolder || "",
        moduleName: meta.moduleName || null,
        totalRecordedSeconds: meta.segmentDurationSeconds || 0
    };
    groups[lessonKey] = group;
    await saveGroups(groups);
    return group;
}

async function advanceSegment(lessonKey, segmentDurationSeconds) {
    const groups = await getGroups();
    const group = groups[lessonKey];
    if (!group) {
        return;
    }
    group.nextSegmentIndex += 1;
    group.totalRecordedSeconds = (group.totalRecordedSeconds || 0) + (segmentDurationSeconds || 0);
    group.lastActivityAt = new Date().toISOString();
    await saveGroups(groups);
}
```

(`getGroups`, `saveGroups`, `closeGroup`, `listExpiredGroups` e o objeto
`self.A3RecordingGroups` no fim do arquivo não mudam.)

- [ ] **Step 2: Atualizar os dois chamadores de `advanceSegment`/`createGroup` em `background.js`**

Em `reconciliarSessaoOrfa()` (por volta da linha 705-724): a duração do
segmento recuperado é desconhecida com precisão (o IndexedDB só guarda
os blobs, não a duração — ver
`extension/lib/recording-backup-db.js`), mas o `MediaRecorder` grava com
`timeslice` de 30s (`offscreen.js:355`, `mediaRecorder.start(30000)`),
então `chunks.length * 30` é uma aproximação aceitável para fins de
aviso ao usuário (nunca é usada para a decisão de `isFinal`, só para
informar quantos minutos foram capturados):

```js
// dentro do bloco `else` (segmento não-final) de reconciliarSessaoOrfa,
// antes de "if (!group) { group = await A3RecordingGroups.createGroup(...) }":

const duracaoAproximadaSegundos = chunks.length * 30;

if (!group) {
    group = await A3RecordingGroups.createGroup(marcador.lessonKey, {
        ...marcador,
        segmentDurationSeconds: duracaoAproximadaSegundos
    });
}

await enviarParaSupabase({
    title: marcador.title,
    moduleName: marcador.moduleName,
    filename,
    audioBlob,
    recordingGroupId: group.recordingGroupId,
    segmentIndex: group.nextSegmentIndex,
    isFinal: false
});

await A3RecordingGroups.advanceSegment(marcador.lessonKey, duracaoAproximadaSegundos);
```

Guardar `duracaoAproximadaSegundos` numa variável de escopo do `for`
(fora do `if`, já que a Task 7 também precisa dela para a notificação).

- [ ] **Step 3: `buscarDuracaoEsperada` (leitura, sem efeitos colaterais)**

Adicionar logo abaixo de `resolverCursoModulo` em `background.js`,
reaproveitando o mesmo parsing de título (regex
`/^\s*(\d+)\s*-\s*(.+?)\s*-\s*(.+?)\s*$/`) mas só com `SELECT`s:

```js
// extension/background.js — logo após resolverCursoModulo

async function buscarDuracaoEsperada(title, moduleName, token) {

    const tituloBruto = (title || "aula").trim();
    const match = tituloBruto.match(/^\s*(\d+)\s*-\s*(.+?)\s*-\s*(.+?)\s*$/);
    const courseName = match ? match[2] : "Aulas sem curso identificado";
    let lessonNumber = match ? parseInt(match[1], 10) : null;
    const moduleNameLimpo = (moduleName || "").trim();

    if (lessonNumber === null || !moduleNameLimpo) {
        // Sem número de aula detectável no título, ou sem nome de módulo:
        // não dá pra resolver a linha certa de "lessons" com segurança.
        return null;
    }

    let mod = (
        await A3Supabase.restSelect(
            "modules",
            `select=id,course_id&name=eq.${encodeURIComponent(moduleNameLimpo)}&limit=1`,
            token
        )
    )[0];

    if (!mod) {
        const course = (
            await A3Supabase.restSelect(
                "courses",
                `select=id&name=eq.${encodeURIComponent(courseName)}`,
                token
            )
        )[0];

        if (!course) {
            return null;
        }

        mod = (
            await A3Supabase.restSelect(
                "modules",
                `select=id&course_id=eq.${course.id}&name=eq.${encodeURIComponent(moduleNameLimpo)}`,
                token
            )
        )[0];
    }

    if (!mod) {
        return null;
    }

    const aula = (
        await A3Supabase.restSelect(
            "lessons",
            `select=expected_duration_seconds&module_id=eq.${mod.id}&lesson_number=eq.${lessonNumber}`,
            token
        )
    )[0];

    if (!aula || !aula.expected_duration_seconds) {
        return null;
    }

    return { expectedDurationSeconds: aula.expected_duration_seconds };
}
```

- [ ] **Step 4: Mensagem para o popup consultar essa função**

Adicionar ao bloco de listeners de mensagens em `background.js` (perto
de `"start-recording"`/`"stop-recording"`):

```js
if (message.action === "get-expected-duration") {

    (async () => {
        try {
            const token = await A3Session.getValidAccessToken();
            if (!token) {
                sendResponse({ expectedDurationSeconds: null });
                return;
            }
            const resultado = await buscarDuracaoEsperada(
                message.title, message.moduleName, token
            );
            sendResponse(resultado || { expectedDurationSeconds: null });
        } catch (error) {
            console.error("A3-OS Recorder: falha ao buscar duração esperada:", error);
            sendResponse({ expectedDurationSeconds: null });
        }
    })();

    return true;
}
```

- [ ] **Step 5: Teste unitário de `recording-groups.js`**

```js
// extension/test/recording-groups.test.js
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');

// Mock mínimo de chrome.storage.local em memória, seguindo o padrão já
// usado nos testes existentes de extension/lib/ (conferir um arquivo de
// teste já existente no repo antes de reinventar o mock).
let storage = {};
global.chrome = {
    storage: {
        local: {
            get: async (key) => ({ [key]: storage[key] }),
            set: async (obj) => { storage = { ...storage, ...obj }; }
        }
    }
};
global.crypto = { randomUUID: () => 'test-uuid' };

require('../lib/recording-groups.js');
const { createGroup, advanceSegment } = self.A3RecordingGroups;

beforeEach(() => { storage = {}; });

test('createGroup inicializa totalRecordedSeconds com o primeiro segmento', async () => {
    const group = await createGroup('aula-1', { title: 'Aula 1', segmentDurationSeconds: 90 });
    assert.strictEqual(group.totalRecordedSeconds, 90);
});

test('advanceSegment acumula duração em múltiplas chamadas', async () => {
    await createGroup('aula-1', { title: 'Aula 1', segmentDurationSeconds: 90 });
    await advanceSegment('aula-1', 60);
    await advanceSegment('aula-1', 30);

    const groups = await self.A3RecordingGroups.getGroups();
    assert.strictEqual(groups['aula-1'].totalRecordedSeconds, 180);
    assert.strictEqual(groups['aula-1'].nextSegmentIndex, 2);
});
```

- [ ] **Step 6: Rodar os testes**

```bash
cd A3-Recorder-split/extension
node --test test/recording-groups.test.js
```

Esperado: PASS nos dois casos.

- [ ] **Step 7: Commit**

```bash
cd A3-Recorder-split
git add extension/background.js extension/lib/recording-groups.js extension/test/recording-groups.test.js
git commit -m "feat: buscarDuracaoEsperada e duração acumulada por grupo"
```

---

### Task 5: Popup — checagem no clique em Parar + modal de aviso

**Files:**
- Modify: `A3-Recorder-split/extension/popup/popup.js`
- Modify: `A3-Recorder-split/extension/popup/popup.html`
- Modify: `A3-Recorder-split/extension/popup/popup.css`
- Modify: `A3-Recorder-split/extension/background.js` (guardar
  `startedAt` da gravação atual)

**Interfaces:**
- Consumes: mensagem `"get-expected-duration"` (Task 4).
- Produces: mensagem `"stop-recording"` ganha o campo
  `duracaoConfirmadaIncompleta` — consumida pela Task 6.

- [ ] **Step 1: Guardar `startedAt` ao iniciar a gravação**

Em `background.js`, `iniciarGravacao`, no objeto salvo por
`salvarEstado({ currentRecording: {...} })` (por volta da linha 396-415),
adicionar:

```js
await salvarEstado({
    currentRecording: {
        title: title || "aula",
        outputFolder: outputFolder,
        moduleName: moduleName || null,
        lessonKey: lessonKey,
        sessionId: sessionId,
        startedAt: Date.now()
    }
});
```

- [ ] **Step 2: Expor o tempo decorrido para o popup**

Adicionar ao bloco de listeners de mensagens em `background.js`:

```js
if (message.action === "get-elapsed-seconds") {

    (async () => {
        const estado = await carregarEstado();
        const startedAt = estado.currentRecording && estado.currentRecording.startedAt;
        sendResponse({
            elapsedSeconds: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : null
        });
    })();

    return true;
}
```

- [ ] **Step 3: Markup do modal em `popup.html`**

Adicionar antes de `</body>` (fora do `.container`, para sobrepor tudo):

```html
<div id="durationWarningModal" class="modal-overlay" hidden>
    <div class="modal-box">
        <h3>Gravação abaixo do esperado</h3>
        <p id="durationWarningText"></p>
        <div class="modal-actions">
            <button id="durationWarningContinue" class="btn-secondary">Continuar gravando</button>
            <button id="durationWarningStopAnyway" class="btn-primary">Parar mesmo assim</button>
        </div>
    </div>
</div>
```

- [ ] **Step 4: Estilo básico do modal em `popup.css`**

Adicionar ao final do arquivo (seguir as variáveis de cor/espaçamento já
definidas no topo de `popup.css` — conferir os nomes exatos antes de
usá-los, não inventar tokens novos):

```css
.modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
}

.modal-box {
    background: var(--card-bg, #1e2321);
    border-radius: 10px;
    padding: 18px 20px;
    max-width: 300px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.modal-box h3 {
    margin: 0 0 8px;
    font-size: 15px;
}

.modal-box p {
    margin: 0 0 16px;
    font-size: 13px;
    line-height: 1.5;
}

.modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
}
```

- [ ] **Step 5: Lógica no `popup.js`**

Substituir `pararGravacao()` para checar duração antes de mandar o
"stop-recording" de verdade:

```js
// extension/popup/popup.js

function formatarDuracao(segundos) {
    const min = Math.floor(segundos / 60);
    const seg = Math.round(segundos % 60);
    return `${min}min ${seg}s`;
}

async function checarDuracaoAntesDeParar() {
    // Retorna true se pode seguir com o "Parar" direto (sem aviso),
    // false se abriu o modal (o próprio modal decide o próximo passo).

    const tituloAula = /* mesma fonte de título já usada por iniciarGravacao no popup.js — ler o arquivo para achar a variável/elemento correto antes de codar isto */;
    const moduleName = /* idem — reaproveitar o que iniciarGravacao já usa */;

    const [duracaoResp, elapsedResp] = await Promise.all([
        chrome.runtime.sendMessage({ action: "get-expected-duration", title: tituloAula, moduleName }),
        chrome.runtime.sendMessage({ action: "get-elapsed-seconds" })
    ]);

    const expectedDurationSeconds = duracaoResp && duracaoResp.expectedDurationSeconds;
    const elapsedSeconds = elapsedResp && elapsedResp.elapsedSeconds;

    if (!expectedDurationSeconds || !elapsedSeconds) {
        return true; // sem dado de referência — segue direto (fail-open)
    }

    if (elapsedSeconds >= expectedDurationSeconds * 0.95) {
        return true;
    }

    mostrarModalDuracao(elapsedSeconds, expectedDurationSeconds);
    return false;
}

function mostrarModalDuracao(elapsedSeconds, expectedDurationSeconds) {
    const modal = document.getElementById("durationWarningModal");
    const texto = document.getElementById("durationWarningText");
    const btnContinuar = document.getElementById("durationWarningContinue");
    const btnPararMesmoAssim = document.getElementById("durationWarningStopAnyway");

    texto.textContent =
        `Você gravou ${formatarDuracao(elapsedSeconds)}. Essa aula costuma durar cerca de ${formatarDuracao(expectedDurationSeconds)}.`;

    modal.hidden = false;

    const fechar = () => { modal.hidden = true; };

    btnContinuar.onclick = fechar;

    btnPararMesmoAssim.onclick = async () => {
        fechar();
        await executarParada(true);
    };
}

async function pararGravacao() {
    const podeSeguir = await checarDuracaoAntesDeParar();
    if (!podeSeguir) {
        return; // modal está no ar; o próprio modal decide o próximo passo
    }
    await executarParada(false);
}

async function executarParada(duracaoConfirmadaIncompleta) {

    const statusTextElement = document.getElementById("statusText");

    try {

        const response = await chrome.runtime.sendMessage({
            action: "stop-recording",
            duracaoConfirmadaIncompleta
        });

        console.log("Resposta parada:", response);

        if (!response || response.success === false) {
            console.error("Erro ao parar:", response?.error);
            return;
        }

        recording = false;
        atualizarInterfaceParado();

        const statusElement = document.getElementById("status");
        if (statusElement) {
            statusElement.hidden = false;
        }

        if (statusTextElement) {
            statusTextElement.textContent = duracaoConfirmadaIncompleta
                ? "Processando áudio (gravação parcial salva)..."
                : "Processando áudio...";
        }

    } catch (error) {
        console.error("Erro ao parar gravação:", error);
    }
}
```

Antes de codar `checarDuracaoAntesDeParar`, ler `iniciarGravacao` em
`popup.js` na íntegra para descobrir exatamente de onde vêm `title` e
`moduleName` hoje (provavelmente lidos de elementos do DOM ou de
`chrome.storage` no momento de iniciar) e reaproveitar a mesma fonte —
não introduzir uma segunda forma de obter o título da aula.

- [ ] **Step 6: Teste manual (não há harness de DOM automatizado no repo — conferir antes de assumir isso)**

Carregar a extensão sem compactação, gravar uma aula com
`expected_duration_seconds` cadastrado por menos de 95% do esperado,
clicar em Parar, confirmar que o modal aparece com os valores certos e
que "Continuar gravando" não interrompe a gravação.

- [ ] **Step 7: Commit**

```bash
cd A3-Recorder-split
git add extension/popup/popup.js extension/popup/popup.html extension/popup/popup.css extension/background.js
git commit -m "feat: modal de aviso ao parar gravação abaixo do esperado"
```

---

### Task 6: `isFinal` deixa de ser sempre `true`

**Files:**
- Modify: `A3-Recorder-split/extension/background.js`

**Interfaces:**
- Consumes: `duracaoConfirmadaIncompleta` da mensagem `"stop-recording"`
  (Task 5).
- Produces: `enviarParaSupabase(...)` recebe `isFinal` calculado — sem
  mudança na assinatura da função em si (já aceitava `isFinal`).

- [ ] **Step 1: Guardar o flag ao receber "stop-recording"**

No handler de `"stop-recording"` (por volta da linha 1415-1428), antes
de chamar `pararGravacao()`:

```js
if (message.action === "stop-recording") {

    (async () => {
        await salvarEstado({
            pendingIncompleteStop: !!message.duracaoConfirmadaIncompleta
        });

        const response = await pararGravacao();
        sendResponse(response);
    })();

    return true;
}
```

(Remover a versão anterior baseada em `.then(...)` — vira `async`
diretamente, já que agora precisa de um `await` antes de chamar
`pararGravacao()`.)

- [ ] **Step 2: Ler o flag no handler de `recording-finished`**

No handler de `"recording-finished"` (por volta da linha 1448-1520),
logo após `await carregarEstado();`:

```js
(async () => {

    await carregarEstado();

    const isFinal = !estadoGlobalAtual.pendingIncompleteStop; // ver nota abaixo sobre nome da variável de estado global

    try {
        // ... (bloco existente de salvarAudioNative, inalterado)

        try {

            chrome.runtime.sendMessage({ action: "upload-status", stage: "uploading" });

            if (message.sessionId && isFinal) {
                await marcarMarcadorComoFinal(message.sessionId);
            }
            // se isFinal for false, o marcador permanece isFinal:false —
            // mesmo estado de uma sessão interrompida por crash.

            const lessonKey = currentRecording.lessonKey || null;
            const groups = lessonKey ? await A3RecordingGroups.getGroups() : {};
            const existingGroup = lessonKey ? groups[lessonKey] : null;

            // ... (decodificação de chunks, inalterada)

            await enviarParaSupabase({
                title: currentRecording.title,
                moduleName: currentRecording.moduleName,
                filename: message.filename,
                audioBlob,
                recordingGroupId: existingGroup ? existingGroup.recordingGroupId : null,
                segmentIndex: existingGroup ? existingGroup.nextSegmentIndex : null,
                isFinal
            });

            await salvarEstado({ pendingIncompleteStop: false });

            // ... (restante do bloco, incluindo o closeGroup condicional a
            // isFinal — ver Step 3)
```

Ler `carregarEstado()`/`salvarEstado()` no topo do arquivo para
confirmar o nome exato da variável/objeto que guarda o estado carregado
em memória (o trecho acima usa `estadoGlobalAtual` como placeholder de
nome — trocar pelo nome real usado no arquivo, provavelmente o mesmo
`currentRecording`/variável de módulo já usada algumas linhas abaixo;
não introduzir uma variável nova se uma já existir com esse propósito).

- [ ] **Step 3: Ajustar o fechamento do grupo para depender de `isFinal`**

Mais abaixo no mesmo handler, o trecho que hoje sempre fecha o grupo
após um "Parar" bem-sucedido (`if (existingGroup) { await A3RecordingGroups.closeGroup(lessonKey); }`,
por volta da linha 1521) só deve fechar quando `isFinal` for `true`; e
quando for `false`, deve chamar `advanceSegment` (equivalente ao
caminho que já existe na reconciliação) para contabilizar esse segmento
e sua duração:

```js
if (isFinal) {
    if (existingGroup) {
        await A3RecordingGroups.closeGroup(lessonKey);
    }
} else {
    const duracaoSegundoSegundos = /* duração real do segmento — ver nota abaixo */;

    if (!existingGroup) {
        await A3RecordingGroups.createGroup(lessonKey, {
            title: currentRecording.title,
            outputFolder: currentRecording.outputFolder,
            moduleName: currentRecording.moduleName,
            segmentDurationSeconds: duracaoSegundoSegundos
        });
    } else {
        await A3RecordingGroups.advanceSegment(lessonKey, duracaoSegundoSegundos);
    }
}
```

Para `duracaoSegundoSegundos`: o handler já tem acesso a
`currentRecording.startedAt` (Task 5, Step 1) e a duração real decorrida
é `Math.floor((Date.now() - currentRecording.startedAt) / 1000)` —
mais precisa que a aproximação de 30s usada na reconciliação, porque
aqui não houve crash, o tempo de parede é exato.

- [ ] **Step 4: Teste manual**

Repetir o cenário 4 do spec: aula com duração cadastrada, gravar menos
de 95%, clicar em "Parar mesmo assim", conferir no Supabase que o
segmento subiu com `is_final: false` e que o grupo da aula continua
aberto (`recordingGroups` em `chrome.storage.local`, inspecionável pelo
console do service worker).

- [ ] **Step 5: Commit**

```bash
cd A3-Recorder-split
git add extension/background.js
git commit -m "feat: isFinal reflete confirmação de parada incompleta"
```

---

### Task 7: Notificação do Chrome ao reconciliar sessão órfã

**Files:**
- Modify: `A3-Recorder-split/extension/manifest.json`
- Modify: `A3-Recorder-split/extension/background.js`

**Interfaces:**
- Consumes: `duracaoAproximadaSegundos` calculada na Task 4, Step 2.

- [ ] **Step 1: Nova permissão no manifest**

```json
"permissions": [
    "storage",
    "tabs",
    "activeTab",
    "scripting",
    "tabCapture",
    "offscreen",
    "nativeMessaging",
    "alarms",
    "downloads",
    "notifications"
],
```

- [ ] **Step 2: Disparar a notificação em `reconciliarSessaoOrfa`**

Dentro do bloco `else` (segmento não-final) de `reconciliarSessaoOrfa`,
logo após `await A3RecordingGroups.advanceSegment(...)` (ver Task 4,
Step 2):

```js
chrome.notifications.create(`a3-recovery-${marcador.sessionId}`, {
    type: "basic",
    iconUrl: "icons/icon-normal-128.png",
    title: "A3-OS Recorder",
    message:
        `Recuperamos parte da aula "${marcador.title}"${marcador.moduleName ? ` (${marcador.moduleName})` : ""}: ` +
        `${formatarDuracaoNotificacao(duracaoAproximadaSegundos)} gravados antes de fechar. Já enviamos — ` +
        `grave essa aula de novo para completar; vamos continuar de onde parou automaticamente.`
});
```

Adicionar o helper de formatação perto do topo de `background.js` (ou
reaproveitar um já existente se houver — conferir antes de duplicar):

```js
function formatarDuracaoNotificacao(segundos) {
    const min = Math.floor(segundos / 60);
    const seg = Math.round(segundos % 60);
    return `${min}min ${seg}s`;
}
```

- [ ] **Step 3: Teste manual**

Simular uma sessão órfã (gravar, matar o processo do Chrome no meio,
reabrir) e confirmar que a notificação nativa do Chrome aparece com a
duração aproximada certa.

- [ ] **Step 4: Commit**

```bash
cd A3-Recorder-split
git add extension/manifest.json extension/background.js
git commit -m "feat: notifica o usuário ao reconciliar sessão órfã"
```

---

### Task 8: Banner no popup ao gravar aula com grupo aberto + confirmação no modal de "Parar mesmo assim"

**Files:**
- Modify: `A3-Recorder-split/extension/background.js`
- Modify: `A3-Recorder-split/extension/popup/popup.js`
- Modify: `A3-Recorder-split/extension/popup/popup.html`
- Modify: `A3-Recorder-split/extension/popup/popup.css`

**Interfaces:**
- Consumes: `group.totalRecordedSeconds` (Task 4).

- [ ] **Step 1: `iniciarGravacao` avisa o popup quando há grupo aberto**

Em `background.js`, `iniciarGravacao`, antes de `const lessonKey = ...`
já existe o `lessonKey`; logo depois de calculá-lo, consultar
`A3RecordingGroups.getGroups()` e, se houver grupo aberto para essa
`lessonKey`, incluir isso na resposta da função (que hoje retorna só
`{ success: true }` nos vários pontos de retorno bem-sucedido):

```js
const groups = await A3RecordingGroups.getGroups();
const grupoAberto = groups[lessonKey] || null;

// ... resto da função de iniciarGravacao segue igual ...

// no retorno de sucesso ao final da função (onde hoje provavelmente só
// retorna { success: true } ou nada — ler a função inteira para achar
// TODOS os pontos de retorno de sucesso, não só o primeiro):
return {
    success: true,
    grupoAberto: grupoAberto ? { totalRecordedSeconds: grupoAberto.totalRecordedSeconds } : null
};
```

- [ ] **Step 2: Popup exibe o banner**

Markup em `popup.html`, dentro do `.container`, logo abaixo do
`<header>`:

```html
<div id="groupBanner" class="info-banner" hidden></div>
```

Estilo em `popup.css`:

```css
.info-banner {
    background: var(--card-bg-soft, #262a25);
    border: 1px solid var(--border-color, #3a3e37);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 12.5px;
    margin-bottom: 10px;
}
```

Em `popup.js`, na função que já trata a resposta de `iniciarGravacao`
(por volta da linha 480-506):

```js
if (response.grupoAberto) {
    const banner = document.getElementById("groupBanner");
    banner.textContent =
        `Esta aula já tem ${formatarDuracao(response.grupoAberto.totalRecordedSeconds)} gravados de uma sessão ` +
        `anterior. Esta gravação vai continuar a partir daí — ao terminar, os pedaços serão unidos automaticamente.`;
    banner.hidden = false;
}
```

- [ ] **Step 3: Confirmação no modal de "Parar mesmo assim" (Task 5)**

Em `mostrarModalDuracao` (Task 5, Step 5), ajustar o `onclick` de
`btnPararMesmoAssim` para trocar o texto do modal antes de fechar, em
vez de fechar direto — mostrando por 2 segundos a confirmação do que
foi salvo:

```js
btnPararMesmoAssim.onclick = async () => {
    const restante = expectedDurationSeconds - elapsedSeconds;
    texto.textContent =
        `Ok, gravamos ${formatarDuracao(elapsedSeconds)} dessa aula e vamos guardar. ` +
        `Grave essa aula de novo quando puder para completar os outros ~${formatarDuracao(restante)}.`;
    btnContinuar.hidden = true;
    btnPararMesmoAssim.hidden = true;

    await executarParada(true);

    setTimeout(() => {
        fechar();
        btnContinuar.hidden = false;
        btnPararMesmoAssim.hidden = false;
    }, 2500);
};
```

- [ ] **Step 4: Teste manual**

Repetir os cenários 4 e 5 do spec e confirmar: (a) o banner aparece ao
reabrir a mesma aula com a duração acumulada certa; (b) a confirmação
aparece no modal antes de fechar ao clicar "Parar mesmo assim".

- [ ] **Step 5: Commit**

```bash
cd A3-Recorder-split
git add extension/background.js extension/popup/popup.js extension/popup/popup.html extension/popup/popup.css
git commit -m "feat: banner de grupo aberto e confirmação ao parar incompleto"
```

---

### Task 9: Deduplicação automática no merge (Transcritor Local)

**Files:**
- Modify: `Transcritor Local/supabase_worker.py`
- Test: `Transcritor Local/test_run/` ou onde já existirem testes deste
  arquivo — conferir a convenção de testes do repo antes de criar um
  arquivo novo (o `DOCUMENTACAO.md` do repo pode indicar se há suíte de
  testes automatizada; se não houver nenhuma, este passo vira só teste
  manual, documentado no Step 3)

**Interfaces:**
- Consumes: `lessons.expected_duration_seconds` (Task 1/2);
  `detectar_duracao` já existente.

- [ ] **Step 1: Helper para buscar a duração esperada da aula**

```python
# Transcritor Local/supabase_worker.py — perto de buscar_curso_modulo_aula

def buscar_duracao_esperada(lesson_id):
    aulas = get("lessons", {"id": f"eq.{lesson_id}", "select": "expected_duration_seconds"})
    if not aulas:
        return None
    return aulas[0].get("expected_duration_seconds")
```

- [ ] **Step 2: Regra de dedupe em `process_job`**

Ajustar o bloco (linhas ~475-483):

```python
if recording_group_id and is_final:
    print(f"[JOB {job_id}] segmento final de grupo {recording_group_id} — avaliando merge.")
    segmentos_grupo = baixar_segmentos_grupo(recording_group_id)

    duracao_esperada = buscar_duracao_esperada(lesson_id)
    duracao_segmento_final = detectar_duracao(local_audio_path) if duracao_esperada else None

    retomada_completa = (
        duracao_esperada
        and duracao_segmento_final
        and duracao_segmento_final >= duracao_esperada * 0.95
    )

    if retomada_completa:
        print(
            f"[JOB {job_id}] segmento final sozinho já cobre {duracao_segmento_final:.0f}s "
            f"de {duracao_esperada}s esperados — tratando como retomada completa do zero, "
            f"ignorando {len(segmentos_grupo) - 1} segmento(s) anterior(es) no merge."
        )
        # local_audio_path já é o arquivo certo (baixado antes deste bloco,
        # na linha "download_audio(storage_path, local_audio_path)")
    elif len(segmentos_grupo) > 1:
        juntar_segmentos(segmentos_grupo, local_audio_path)
    # Um só segmento no grupo — nada a juntar, local_audio_path já é o correto.
```

(Sem `expected_duration_seconds` cadastrado, `duracao_esperada` é
`None`, `retomada_completa` é `False`, e o comportamento cai no `elif`
— concatena tudo, igual a hoje.)

- [ ] **Step 3: Teste manual**

Repetir o cenário: gravar 12min de uma aula de 40min, parar incompleto
("Parar mesmo assim", Task 6), depois gravar a aula inteira de novo do
zero (≥95% dos 40min) e parar normalmente. Conferir nos logs do worker
a linha "tratando como retomada completa do zero" e, no Supabase, que o
áudio final tem só a duração da segunda gravação — sem os 12min da
primeira tentativa concatenados na frente. Repetir também o caminho
normal (duas gravações que juntas somam a aula, nenhuma sozinha
cobrindo 95%) e confirmar que o merge concatena as duas, como antes.

- [ ] **Step 4: Commit**

```bash
cd "Transcritor Local"
git add supabase_worker.py
git commit -m "feat: dedupe automática no merge quando retomada cobre a aula sozinha"
```

---

## Execução

Este plano estende um feature já em produção (v1.2.0) tocando os mesmos
três repositórios do plano anterior
(`2026-09-08-gravacao-resiliente.md`). Seguir o mesmo padrão: uma
revisão de tarefa por task acima, e ao final uma revisão final por
repositório (A3-Recorder-split, knowledge-tools, Transcritor Local)
antes do merge de cada branch — a Task 1 (migração SQL) e a Task 2
(script de migração de dados) precisam rodar contra o Supabase real
**antes** das Tasks 3, 4 e 9 poderem ser verificadas de ponta a ponta,
já que todas dependem da coluna e dos dados existirem.
