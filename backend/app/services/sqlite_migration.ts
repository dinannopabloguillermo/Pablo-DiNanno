import { DatabaseSync } from 'node:sqlite'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'

/**
 * POR QUÉ EXISTE ESTO (directiva «los datos no se copian, se migran»)
 *
 * Pasar de SQLite a PostgreSQL cambia los datos aunque las migraciones y los
 * modelos no cambien. La prueba de migración (docs/upgrade-mig-issues.md) midió
 * tres roturas que ninguna batería de tests ve, porque corren sobre una base vacía:
 *
 *  1. SQLite guarda una misma columna `datetime` con dos formatos: texto
 *     (`2026-10-07 21:40:21`) y entero en ms (los tokens). PostgreSQL rechaza el
 *     entero y una copia cruda deja la tabla vacía.
 *  2. El texto no lleva zona: PostgreSQL lo lee con la zona de la sesión, y fuera
 *     de UTC desplaza las horas sin error alguno.
 *  3. Con ids explícitos las secuencias no avanzan y el siguiente insert falla.
 *
 * Por eso la carga convierte a UTC de forma explícita, corre en una sola
 * transacción, verifica campo a campo antes de confirmar y solo entonces ajusta
 * las secuencias. Cualquier diferencia revierte todo.
 */

export type SqliteValue = string | number | bigint | null | Uint8Array

export interface MigrationReport {
  tables: { name: string; source: number; loaded: number }[]
  warnings: string[]
  differences: string[]
  committed: boolean
}

interface PgColumn {
  name: string
  type: string
}

const TIMESTAMP_TYPES = new Set(['timestamp with time zone', 'timestamp without time zone'])
const NAIVE_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/
const ZONED_TEXT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/

/**
 * Pasa un valor de SQLite al instante UTC que representa, como ISO 8601.
 * Devuelve `null` si el valor no se sabe interpretar: se rechaza, no se adivina.
 */
export function toUtcIso(value: SqliteValue): string | null {
  if (typeof value === 'number' || typeof value === 'bigint') {
    const date = new Date(Number(value))
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  const iso = NAIVE_TEXT.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : ZONED_TEXT.test(text)
      ? text.replace(' ', 'T')
      : null
  if (iso === null) return null
  // `Date` normaliza 2026-02-30 a 2 de marzo y recorta por debajo del ms: sería
  // un cambio de dato que la verificación no vería. Se rechaza.
  if (/\.\d{4,}/.test(iso)) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  const day = new Date(Date.UTC(y, m - 1, d))
  if (day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null
  return date.toISOString()
}

function quoteSqlite(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`
}

/**
 * Migra todas las tablas de aplicación de un fichero SQLite a la base a la que
 * apunta `client`. Con `dryRun` hace todo (carga y verificación) y revierte.
 */
export async function migrateFromSqlite(
  client: QueryClientContract,
  sqlitePath: string,
  options: { dryRun?: boolean } = {}
): Promise<MigrationReport> {
  const report: MigrationReport = { tables: [], warnings: [], differences: [], committed: false }
  const source = new DatabaseSync(sqlitePath, { readOnly: true })
  const trx = await client.transaction()

  try {
    await trx.rawQuery("set local time zone 'UTC'")

    const pgTables = await tablesInDestination(trx)
    const sqliteTables = (
      source
        .prepare(
          `select name from sqlite_master where type = 'table'
           and name not like 'sqlite_%' and name not like 'adonis_schema%'`
        )
        .all() as { name: string }[]
    ).map((row) => row.name)

    const missing = sqliteTables.filter((name) => !pgTables.includes(name))
    if (missing.length > 0) {
      throw new Error(`Tablas en SQLite que no existen en PostgreSQL: ${missing.join(', ')}`)
    }
    const ordered = await orderByForeignKeys(trx, sqliteTables)

    const columnsByTable = new Map<string, PgColumn[]>()
    for (const table of ordered) {
      const pgColumns = await columnsOf(trx, table)
      const sqliteColumns = (
        source.prepare('select name from pragma_table_info(?)').all(table) as {
          name: string
        }[]
      ).map((row) => row.name)
      const differentColumns = [
        ...sqliteColumns.filter((c) => !pgColumns.some((p) => p.name === c)),
        ...pgColumns.map((p) => p.name).filter((c) => !sqliteColumns.includes(c)),
      ]
      if (differentColumns.length > 0) {
        throw new Error(`${table}: columnas que no coinciden (${differentColumns.join(', ')})`)
      }
      columnsByTable.set(table, pgColumns)

      const existing = await trx.from(table).count('* as total').first()
      if (Number(existing?.total) > 0) {
        throw new Error(`${table}: la tabla de destino no está vacía; no se mezcla ni se pisa`)
      }
    }

    const expected = new Map<string, Record<string, unknown>[]>()
    for (const table of ordered) {
      const columns = columnsByTable.get(table)!
      const rows = source
        .prepare(`select * from ${quoteSqlite(table)} order by id`)
        .all() as Record<string, SqliteValue>[]

      const kinds = new Map<string, Set<string>>()
      const converted = rows.map((row) => {
        const out: Record<string, unknown> = {}
        for (const column of columns) {
          const value = row[column.name]
          if (TIMESTAMP_TYPES.has(column.type) && value !== null) {
            const kind =
              typeof value === 'string'
                ? ZONED_TEXT.test(value)
                  ? 'texto con zona'
                  : 'texto sin zona'
                : 'entero'
            kinds.set(column.name, (kinds.get(column.name) ?? new Set()).add(kind))
            const iso = toUtcIso(value)
            if (iso === null) {
              throw new Error(
                `${table}#${row.id}.${column.name}: fecha ilegible (${String(value)})`
              )
            }
            out[column.name] = iso
          } else {
            out[column.name] = typeof value === 'bigint' ? Number(value) : value
          }
        }
        return out
      })

      for (const [column, set] of kinds) {
        if (set.size > 1) {
          report.warnings.push(
            `${table}.${column}: formatos mezclados en origen (${[...set].join(' + ')})`
          )
        }
        if (set.has('texto sin zona')) {
          report.warnings.push(`${table}.${column}: texto sin zona, interpretado como UTC`)
        }
      }

      for (const row of converted) await trx.table(table).insert(row)
      expected.set(table, converted)
      report.tables.push({ name: table, source: rows.length, loaded: 0 })
    }

    for (const entry of report.tables) {
      const columns = columnsByTable.get(entry.name)!
      const select = columns
        .map((c) =>
          TIMESTAMP_TYPES.has(c.type)
            ? `to_char(?? at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ??`
            : c.type === 'date'
              ? `to_char(??, 'YYYY-MM-DD') as ??`
              : '?? as ??'
        )
        .join(', ')
      const result = await trx.rawQuery(`select ${select} from ?? order by id`, [
        ...columns.flatMap((c) => [c.name, c.name]),
        entry.name,
      ])
      const actual = result.rows as Record<string, unknown>[]
      entry.loaded = actual.length
      const wanted = expected.get(entry.name)!

      if (actual.length !== wanted.length) {
        report.differences.push(
          `${entry.name}: ${wanted.length} filas en origen, ${actual.length} en destino`
        )
        continue
      }
      wanted.forEach((row, index) => {
        for (const column of columns) {
          let want = row[column.name]
          if (TIMESTAMP_TYPES.has(column.type) && typeof want === 'string') {
            want = new Date(want).toISOString()
          }
          if (String(want) !== String(actual[index][column.name])) {
            report.differences.push(
              `${entry.name}#${row.id}.${column.name}: origen=${JSON.stringify(want)} destino=${JSON.stringify(actual[index][column.name])}`
            )
          }
        }
      })
    }

    if (report.differences.length > 0 || options.dryRun) {
      await trx.rollback()
      return report
    }

    await resetSequences(trx, ordered)
    await trx.commit()
    report.committed = true
    return report
  } catch (error) {
    if (!trx.isCompleted) await trx.rollback()
    throw error
  } finally {
    source.close()
  }
}

async function tablesInDestination(trx: TransactionClientContract): Promise<string[]> {
  const result = await trx.rawQuery(
    `select table_name from information_schema.tables where table_schema = current_schema()`
  )
  return result.rows.map((row: { table_name: string }) => row.table_name)
}

async function columnsOf(trx: TransactionClientContract, table: string): Promise<PgColumn[]> {
  const result = await trx.rawQuery(
    `select column_name as name, data_type as type from information_schema.columns
     where table_schema = current_schema() and table_name = ? order by ordinal_position`,
    [table]
  )
  return result.rows
}

/** Padres antes que hijos, para que las claves foráneas se cumplan al insertar. */
async function orderByForeignKeys(trx: TransactionClientContract, tables: string[]) {
  const result = await trx.rawQuery(
    `select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
     from pg_constraint c where c.contype = 'f'`
  )
  const parents = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]))
  for (const { child, parent } of result.rows as { child: string; parent: string }[]) {
    if (child !== parent && parents.has(child) && parents.has(parent)) {
      parents.get(child)!.add(parent)
    }
  }
  const ordered: string[] = []
  while (ordered.length < tables.length) {
    const next = tables.find(
      (t) => !ordered.includes(t) && [...parents.get(t)!].every((p) => ordered.includes(p))
    )
    if (!next) throw new Error('Dependencias circulares entre tablas')
    ordered.push(next)
  }
  return ordered
}

async function resetSequences(trx: TransactionClientContract, tables: string[]) {
  for (const table of tables) {
    await trx.rawQuery(
      `select setval(pg_get_serial_sequence(?, 'id'), greatest(coalesce((select max(id) from ??), 0), 1),
        (select count(*) > 0 from ??))`,
      [table, table, table]
    )
  }
}
