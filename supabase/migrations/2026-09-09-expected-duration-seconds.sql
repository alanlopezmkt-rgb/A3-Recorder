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
