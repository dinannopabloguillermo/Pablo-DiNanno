# Hallazgos

Aquí van **las tres líneas** del ejercicio, una por cada punto de abajo. Es lo único que hay que
traer hecho: un cambio de motor a medias con estas tres líneas escritas vale más que lo contrario,
porque lo que se discute en el directo es dónde te chocaste.

Escribe **una sola línea por punto**, con tus palabras y con lo que mediste, no con lo que suponías.

## 1. Las filas que cambian y la rama

las 4 migraciones corrieron sin cambios en PostgreSQL y no tuve que editar ningún modelo. database/schema.ts se regeneró al migrar y no apareció diff en git status. La base de desarrollo en PostgreSQL empezó vacía (0 usuarios) y no importé nada del backend/tmp/db.sqlite3 antiguo.

## 2. Lo que la batería de pruebas no podía ver

Posibles diferencias entre motores sin probar: SQLite casi no tipa las columnas y PostgreSQL sí. Las 23 pruebas pasan, pero ninguna cubre due_date. Esa columna es de tipo date, y puede llegar como Date en vez de string en la serialización. La capability tasks solo tiene pruebas de responsable.

## 3. Tu duda

Por qué no migró desde un principio? Si hubiera tomado la decisión de usar PostgreSQL desde el inicio, habría evitado tener que migrar los datos y ajustar la configuración del proyecto? ¿Desde dónde habría sido más sencillo instruír este control, al hook o al start/env.ts?

-
