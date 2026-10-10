# CRM — notas para trabajar en el proyecto

- Todo el texto de la interfaz va en castellano de España, tuteando.
- Antes de dar por terminada cualquier tarea que toque pantallas, correos o avisos, aplica la skill `ux-review` (`.claude/skills/ux-review/`) y su decálogo (`checklist.md`).
- Patrones de referencia: tablas con `DataTable` (columnas a elegir y fijar), edición de filas en `Drawer` (panel lateral), formularios con `ActionForm` (usa `confirm="…"` en acciones difíciles de deshacer), un solo botón primary por zona.
- Colores y espaciados: solo variables de `:root` en `src/app/globals.css`.
