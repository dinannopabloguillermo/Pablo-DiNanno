# Incidencias de la migración SQLite → PostgreSQL

Resumen de lo revisado y de lo hecho. Es la referencia de la directiva «los datos no se copian,
se migran» de [`CLAUDE.md`](../CLAUDE.md).

## Qué se revisó

- **Documento rector del proceso:** [`CLAUDE.md`](../CLAUDE.md) («Reglas de proceso»).
  [`AGENTS.md`](../AGENTS.md) es un enlace simbólico a él, así que hay un solo documento.
  El hook `.claude/hooks/datos-que-no-salen.sh` solo vigila secretos y correos en `git commit`;
  no ve datos de base de datos, por eso no es el sitio de esta barrera.
- **Dónde se dispara la lógica:** el Makefile (`make migrate-data`), el comando de Adonis y el
  servicio que lo respalda. Cada uno lleva un comentario «POR QUÉ EXISTE» con la razón.
- El README del ejercicio (partes A y B) y `HALLAZGOS.md`.

## La prueba

El `db.sqlite3` del repo estaba vacío. Se rellenó con la versión anterior del código (SQLite) vía su
API: 5 usuarios, 10 tareas y 17 tokens, con tildes, CJK, emoji, comillas, saltos de línea, un título de
200 caracteres, fechas bisiestas y tareas sin fecha. Se cargó en una base nueva (`flowsync_migracion`)
con cuatro estrategias y se comparó campo a campo y registro a registro.

| Estrategia | Cargados | Diferencias |
|---|---|---|
| Copia cruda | 0 de 17 tokens | falla la carga |
| Enteros a fecha, sesión UTC | 32/32 | 0 |
| Igual, sesión Europe/Madrid | 32/32 | 0 |
| Texto tal cual, sesión Europe/Madrid | 32/32 | 30 (2 h de desplazamiento) |

## Causas

1. **Dos formatos en una columna `datetime`.** `users` y `tasks` guardan texto
   (`2026-10-07 21:40:21`); `auth_access_tokens` guarda enteros en ms. PostgreSQL rechaza el entero.
2. **Texto sin zona.** PostgreSQL lo interpreta con la zona de la sesión: fuera de UTC se desplaza sin
   error.
3. **Secuencias sin avanzar.** Con ids explícitos el siguiente insert falla (`tasks_pkey`).

Los modelos y las migraciones no tuvieron ningún error ni se tocaron. `due_date` (`date`) migró sin
diferencias.

## Qué se hizo

- [`backend/app/services/sqlite_migration.ts`](../backend/app/services/sqlite_migration.ts): convierte
  a UTC, rechaza lo ilegible, carga en una transacción, verifica campo a campo y recién entonces ajusta
  las secuencias. Avisa de formatos mezclados y de texto sin zona. No pisa tablas con datos.
- [`backend/commands/db_migrate_from_sqlite.ts`](../backend/commands/db_migrate_from_sqlite.ts):
  `node ace db:migrate-from-sqlite [--sqlite=ruta] [--dry-run]`; código de salida 1 ante cualquier fallo.
- `make migrate-data [SQLITE=ruta] [DRY=1]`.
- [`backend/tests/functional/db/migrate_from_sqlite.spec.ts`](../backend/tests/functional/db/migrate_from_sqlite.spec.ts):
  8 tests (formatos mezclados, zona de la sesión, avisos, secuencias, fecha ilegible, simulacro, destino
  con datos, conversión). Contra `db-test`; también pasan con `TZ=Europe/Madrid`.
- Directiva en `CLAUDE.md`.

## Hallazgo aparte: Node 24 rompe los comandos ace de la app

Con Node 24.21, `node ace list` falla con `Invalid URL` por el `new URL(..., 'thismessage::/')` de
`jsonschema` 1.5.0 al validar los comandos de `backend/commands/` (también `openapi:check`). Es
preexistente. Con Node 22 funciona. `npm test` no lo sufre.

## Pendiente / límites

- Se usa `node:sqlite` (experimental en Node 22, emite un aviso) para no volver a añadir
  `better-sqlite3`.
- No hay verificación de hash por tabla ni de tipos más allá de timestamps y `date`; si se añaden
  columnas `json`, `boolean` o `bytea`, hay que ampliar la conversión y el test.
