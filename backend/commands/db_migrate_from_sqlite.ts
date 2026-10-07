import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { existsSync } from 'node:fs'

/**
 * POR QUÉ EXISTE ESTE COMANDO: es la barrera de la directiva «los datos no se
 * copian, se migran» (CLAUDE.md, «Reglas de proceso»). Las migraciones de Lucid
 * mueven el esquema, no los datos, y una copia cruda de SQLite a PostgreSQL
 * rompe en silencio (fechas con dos formatos, desplazamiento de zona, secuencias
 * sin avanzar). Detalle y mediciones en docs/upgrade-mig-issues.md.
 *
 * Carga en una transacción, verifica campo a campo y solo confirma si no hay
 * ninguna diferencia. Termina con código 1 si algo falla.
 */
export default class DbMigrateFromSqlite extends BaseCommand {
  static commandName = 'db:migrate-from-sqlite'
  static description =
    'Migra los datos de un fichero SQLite a PostgreSQL y verifica campo a campo antes de confirmar'

  static options: CommandOptions = {
    startApp: true,
  }

  @flags.string({ description: 'Ruta del fichero SQLite (por defecto tmp/db.sqlite3)' })
  declare sqlite: string

  @flags.boolean({ description: 'Carga y verifica, pero revierte siempre' })
  declare dryRun: boolean

  async run() {
    const path = this.app.makePath(this.sqlite ?? 'tmp/db.sqlite3')
    if (!existsSync(path)) {
      this.logger.error(`No existe ${path}`)
      this.exitCode = 1
      return
    }

    // Imports dentro de run(): ace carga los comandos antes de arrancar la app,
    // y el servicio `db` necesita la app ya arrancada.
    const { migrateFromSqlite } = await import('#services/sqlite_migration')
    const db = await this.app.container.make('lucid.db')

    let report
    try {
      report = await migrateFromSqlite(db.connection(), path, { dryRun: this.dryRun })
    } catch (error) {
      this.logger.error(`Migración abortada y revertida: ${(error as Error).message}`)
      this.exitCode = 1
      return
    }

    for (const table of report.tables) {
      this.logger.info(`${table.name}: ${table.source} en origen, ${table.loaded} en destino`)
    }
    report.warnings.forEach((warning: string) => this.logger.warning(warning))

    if (report.differences.length > 0) {
      report.differences.slice(0, 25).forEach((diff: string) => this.logger.error(diff))
      this.logger.error(`${report.differences.length} diferencias: migración revertida`)
      this.exitCode = 1
      return
    }

    this.logger.success(
      report.committed
        ? 'Datos migrados y verificados'
        : 'Simulacro correcto: sin diferencias (nada se ha confirmado)'
    )
  }
}
