// extension/lib/lesson-key.js
//
// Copia intencional de knowledge-tools/lib/lesson-key.js — os dois
// repositórios não compartilham dependências, então a lógica (com seus
// testes) vive lá e é copiada aqui sem alteração de comportamento.

function slugify(text) {
    return String(text || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function lessonKey(title, moduleName) {
    return slugify(`${title || ""}|${moduleName || ""}`);
}

self.A3LessonKey = { slugify, lessonKey };
