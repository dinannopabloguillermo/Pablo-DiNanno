import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateFromSqlite, toUtcIso } from '#services/sqlite_migration'

/**
 * La barrera de la migración SQLite → PostgreSQL (docs/upgrade-mig-issues.md).
 * Cada test reproduce una de las tres roturas medidas con una copia cruda.
 */
test.group('Migración desde SQLite', (group) => {
  group.each.setup(() => testUtils.db().withGlobalTransaction())

  function sqliteConDatos(): { path: string; limpiar: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'flowsync-sqlite-'))
    const path = join(dir, 'db.sqlite3')
    const lite = new DatabaseSync(path)
    lite.exec(`
      create table users (id integer primary key, full_name text, email text not null, password text not null, created_at datetime not null, updated_at datetime);
      create table auth_access_tokens (id integer primary key, tokenable_id integer not null, type text not null, name text, hash text not null, abilities text not null, created_at datetime, updated_at datetime, last_used_at datetime, expires_at datetime);
      create table tasks (id integer primary key, title text not null, status text not null, assignee_id integer not null, created_at datetime not null, updated_at datetime, due_date date);
      insert into users values (7, 'Zoë 李雷 😀', 'zoe@example.com', 'x', '2026-10-07 21:40:21', '2026-10-07 21:40:21');
      insert into auth_access_tokens values (3, 7, 'auth_token', null, 'h', '["*"]', 1791409221133, 1791409221133, null, null);
      insert into tasks values (11, 'ñandú "comillas"', 'done', 7, '2026-10-07 21:40:21', '2026-10-07 21:40:21', '2024-02-29');
      insert into tasks values (12, 'sin fecha', 'pending', 7, '2026-10-07 21:40:22', null, null);
    `)
    lite.close()
    return { path, limpiar: () => rmSync(dir, { recursive: true, force: true }) }
  }

  test('convierte fechas en texto y en enteros a UTC y verifica sin diferencias', async ({
    assert,
    cleanup,
  }) => {
    const { path, limpiar } = sqliteConDatos()
    cleanup(limpiar)

    const report = await migrateFromSqlite(db.connection(), path)

    assert.isTrue(report.committed)
    assert.deepEqual(report.differences, [])
    assert.deepEqual(
      report.tables.map((t) => [t.name, t.source, t.loaded]),
      [
        ['users', 1, 1],
        ['auth_access_tokens', 1, 1],
        ['tasks', 2, 2],
      ]
    )
    const token = await db.connection().from('auth_access_tokens').where('id', 3).firstOrFail()
    assert.equal(new Date(token.created_at).toISOString(), '2026-10-07T21:40:21.133Z')
  })

  test('el resultado no depende de la zona horaria de la sesión', async ({ assert, cleanup }) => {
    const { path, limpiar } = sqliteConDatos()
    cleanup(limpiar)
    await db.connection().rawQuery("set time zone 'Europe/Madrid'")

    const report = await migrateFromSqlite(db.connection(), path)

    assert.deepEqual(report.differences, [])
    const user = await db.connection().from('users').where('id', 7).firstOrFail()
    assert.equal(new Date(user.created_at).toISOString(), '2026-10-07T21:40:21.000Z')
  })

  test('avisa de formatos mezclados y de texto sin zona', async ({ assert, cleanup }) => {
    const { path, limpiar } = sqliteConDatos()
    cleanup(limpiar)
    const lite = new DatabaseSync(path)
    lite.exec(
      `insert into auth_access_tokens values (4, 7, 'auth_token', null, 'h2', '["*"]', '2026-10-07 21:40:21', null, null, null)`
    )
    lite.close()

    const report = await migrateFromSqlite(db.connection(), path, { dryRun: true })

    assert.isTrue(
      report.warnings.some(
        (w: string) => w.includes('auth_access_tokens.created_at') && w.includes('mezclados')
      )
    )
    assert.isTrue(
      report.warnings.some((w: string) => w.includes('users.created_at') && w.includes('sin zona'))
    )
  })

  test('las secuencias quedan por encima del máximo y el siguiente insert funciona', async ({
    assert,
    cleanup,
  }) => {
    const { path, limpiar } = sqliteConDatos()
    cleanup(limpiar)

    await migrateFromSqlite(db.connection(), path)

    const [nuevo] = await db
      .connection()
      .table('tasks')
      .insert({ title: 'nueva', assignee_id: 7, created_at: new Date() })
      .returning('id')
    assert.isAbove(Number(nuevo.id ?? nuevo), 12)
  })

  test('una fecha ilegible aborta sin dejar nada cargado', async ({ assert, cleanup }) => {
    const { path, limpiar } = sqliteConDatos()
    cleanup(limpiar)
    const lite = new DatabaseSync(path)
    lite.exec(`update users set created_at = 'ayer por la tarde'`)
    lite.close()

    await assert.rejects(() => migrateFromSqlite(db.connection(), path), /fecha ilegible/)
    const total = await db.connection().from('users').count('* as total').firstOrFail()
    assert.equal(Number(total.total), 0)
  })

  test('el simulacro no confirma nada', async ({ assert, cleanup }) => {
    const { path, limpiar } = sqliteConDatos()
    cleanup(limpiar)

    const report = await migrateFromSqlite(db.connection(), path, { dryRun: true })

    assert.isFalse(report.committed)
    const total = await db.connection().from('tasks').count('* as total').firstOrFail()
    assert.equal(Number(total.total), 0)
  })

  test('no pisa una base de destino con datos', async ({ assert, cleanup }) => {
    const { path, limpiar } = sqliteConDatos()
    cleanup(limpiar)
    await db
      .connection()
      .table('users')
      .insert({ email: 'otro@example.com', password: 'x', created_at: new Date() })

    await assert.rejects(() => migrateFromSqlite(db.connection(), path), /no está vacía/)
  })

  test('toUtcIso rechaza lo que no sabe interpretar', ({ assert }) => {
    assert.equal(toUtcIso('2026-10-07 21:40:21'), '2026-10-07T21:40:21.000Z')
    assert.equal(toUtcIso('2026-10-07T23:40:21+02:00'), '2026-10-07T21:40:21.000Z')
    assert.equal(toUtcIso(1791409221133), '2026-10-07T21:40:21.133Z')
    assert.isNull(toUtcIso('ayer'))
    assert.isNull(toUtcIso('2026-02-30 21:40:21'))
    assert.isNull(toUtcIso('2026-10-07 21:40:21.123456'))
    assert.isNull(toUtcIso(null))
  })
})
