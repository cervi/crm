---
name: ux-review
description: Revisión de experiencia de usuario de cualquier pantalla, flujo, correo o aviso del CRM antes de dar una tarea por terminada. Úsala siempre que un cambio toque lo que ve o recibe un comercial o un administrador.
---

# Revisión UX

Los tests e2e y de interfaz (`npm run e2e`, `scripts/ui-check.mjs`) comprueban que el producto **funciona**. Esta skill comprueba que **se entiende, se usa sin esfuerzo y no agobia**. Una tarea que toca interfaz, correos o avisos no está terminada hasta pasar esta revisión.

## Contexto del producto

Es un CRM con IA (sustituye a Pipedrive y Apollo): pipelines y deals, contactos y empresas, leads, actividades, secuencias de correo, campañas de outbound, agentes de IA por fase, informes y Customer Success. Es muy amplio, y eso define el mayor riesgo de UX: **la saturación**. Cada módulo añade información, botones, colores y avisos, y el usuario acaba sin saber qué tiene que hacer.

Hay dos tipos de usuario:

**Administrador**
- Configura pipelines, IA, importaciones, usuarios y cuentas.
- Tolera más densidad, pero necesita saber primero qué requiere su atención.

**Comercial (y Customer Success)**
- Lo usa todo el día: mover deals, registrar llamadas, escribir correos, revisar lo que propone la IA.
- Necesita tres cosas: saber qué tiene pendiente (Hoy), hacerlo rápido y quedarse tranquilo de que está hecho.

Antes de revisar nada, responde siempre: **¿quién es el usuario de este flujo y qué intenta conseguir?**

## Proceso

1. **Define el flujo.** Usuario, objetivo, pasos y punto de entrada.
2. **Recórrelo de verdad.** Con Playwright (o el navegador integrado sobre `npm run probar`), captura cada paso en escritorio (1440×900) y, si es rutinario, en móvil (390×844). Captura también los estados del criterio 5 (vacío, carga, error…). Guarda las capturas en `ux-review/<flujo>/`.
3. **Revisa las comunicaciones.** Lista los correos y avisos que dispara el flujo en un escenario realista y cuenta cuántos recibe cada persona y cuándo.
4. **Lanza la revisión independiente** con el subagente `ux-reviewer`: pásale el flujo, el usuario y su objetivo, las capturas, los envíos y los ficheros tocados. **No le expliques cómo lo implementaste.**
5. **Corrige** los hallazgos bloqueantes e importantes. Las mejoras se listan al final para que decida el equipo.
6. **Verifica** volviendo a capturar. Si hubo bloqueantes, repite la revisión.

Si no puedes generar capturas, dilo explícitamente: una revisión sin capturas es incompleta.

## Severidad

- **Bloqueante:** no puede completar su objetivo, se equivoca sin darse cuenta, pierde datos o recibe algo que le agobia o le genera desconfianza.
- **Importante:** lo consigue, pero con dudas, esfuerzo innecesario o ruido visual.
- **Mejora:** pulido que suma pero no es urgente.

## Criterios

Están en [checklist.md](checklist.md). Aplícalos también **mientras desarrollas**, no solo al final.
