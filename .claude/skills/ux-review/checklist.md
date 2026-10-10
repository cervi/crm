# Decálogo UX del producto

Cada principio viene con comprobaciones concretas. Un principio se da por cumplido solo si se pasan sus comprobaciones, no porque "en general" parezca razonable.

---

## 1. Que quede claro dónde poner el foco

El usuario tiene que saber en un segundo qué esperamos que haga. En un producto tan completo es normal que una pantalla tenga varias acciones importantes; el objetivo no es eliminarlas, sino que no compitan entre sí.

- Usa el mínimo de botones primary posible. Como orientación, uno por bloque o zona de la pantalla, y no varios primary juntos compitiendo en el mismo sitio.
- Si hay varias acciones principales, distingue cuál es la más importante mediante su posición (la zona más visible), agrupándolas en cards o secciones separadas, o dándoles distinto peso visual.
- Las acciones de menos uso pueden ser secondary, terciarias (link/ghost) o ir en un menú de "más acciones".
- Las acciones destructivas nunca son primary salvo en un diálogo de confirmación de esa acción.
- Pregunta de control: si alguien ve esta pantalla por primera vez, ¿sabe en qué botón centrarse? Si duda entre varios, hay que reforzar la jerarquía.

> Ejemplo real: pantallas con varios botones primary donde no queda claro dónde poner el foco.

## 2. Priorizar la información y dar aire a la pantalla

El objetivo es que las pantallas no se sientan saturadas ni abrumen. Toda la información puede seguir estando, pero ordenada por importancia y con espacio para respirar.

- Identifica la información que el usuario necesita para decidir o actuar. Eso va destacado: más arriba, más grande o con más peso visual.
- Lo que no es prioritario sigue visible, pero en segundo plano: menor tamaño o peso, más abajo, en una zona secundaria.
- Solo cuando la cantidad de información es excesiva, lleva parte a tooltips, texto de ayuda, pestañas, acordeones o "ver detalle".
- Deja espacio entre bloques, secciones y textos, usando los tokens de espaciado del sistema de diseño. Los bloques pegados unos a otros son una de las principales causas de sensación de saturación.
- Ninguna tabla muestra por defecto más columnas de las necesarias para la tarea; el resto, configurables.
- Las pantallas del comercial (uso diario) deben ser más ligeras que las de ajustes del administrador.
- Pregunta de control: al abrir la pantalla, ¿se ve de un vistazo qué es lo importante, o todo tiene el mismo peso?

> Ejemplo real: interfaces saturadas, con mucha información sin priorizar.

## 3. El color comunica, no decora

- Usa solo los colores del sistema de diseño (tokens). Nunca valores hexadecimales sueltos.
- Base neutra: la mayor parte de la interfaz son grises y blanco.
- Un único color de acento (el de marca) para acciones principales y elementos activos.
- Colores semánticos solo con su significado: rojo = error o destructivo, ámbar = aviso, verde = éxito o completado, azul = información.
- No asignes un color distinto a cada estado, categoría o módulo "para diferenciarlos". Usa texto, iconos o badges neutros.
- El color nunca es el único portador de significado: siempre va acompañado de texto o icono.
- Pregunta de control: en esta pantalla, ¿cuántos colores distintos aparecen además de neutros? Si son más de 3-4, sobra color.

> Ejemplo real: interfaces con demasiados colores que "parecen un circo".

## 4. Comunicaciones agrupadas y con calma

Emails y notificaciones son parte de la experiencia, y es donde más fácil es agobiar.

- **Agrupa:** varias tareas o avisos para la misma persona en el mismo momento van en **un único mensaje** con la lista completa, no en un mensaje por elemento.
- Cada elemento de la lista indica qué hay que hacer, para cuándo, y enlaza a donde se hace.
- Ordena por fecha límite o prioridad, y deja claro qué es para ya y qué puede esperar.
- Un asunto que explique el contenido ("Tus tareas de bienvenida para las próximas dos semanas"), no genérico.
- Un CTA principal por email.
- No dupliques: si algo llega por email, valora si además necesita notificación en la app.
- Revisa el volumen total: cuenta los mensajes que recibe una persona en un día o semana típicos de ese proceso. Si alguien recibe más de 1-2 mensajes al día del mismo proceso, hay que agrupar.
- Los recordatorios son pocos, útiles y espaciados, no un goteo.

> Ejemplo: un comercial que recibe un aviso por cada propuesta de la IA. Lo correcto es el parte del día con todas, ordenadas por urgencia, y un único enlace a la bandeja.

## 5. Todos los estados están diseñados

El camino feliz es solo uno de los estados. Para cada pantalla o componente con datos, comprueba que existen y están cuidados:

- **Vacío:** explica qué aparecerá aquí y cómo empezar (con su acción). Nunca una tabla vacía sin más.
- **Primera vez:** el usuario que entra por primera vez entiende qué es esto.
- **Carga:** skeleton o indicador si tarda más de ~300 ms; sin saltos de layout al cargar.
- **Error:** qué ha pasado y qué puede hacer el usuario.
- **Éxito:** confirmación visible de que la acción se ha hecho.
- **Datos extremos:** nombres muy largos, cientos de filas, un solo elemento, valores a cero.
- **Sin permisos:** el usuario entiende por qué no puede y a quién acudir.
- **Parcial o pendiente:** procesos a medias (importación en curso, secuencia a medio enviar, plan de cierre sin terminar) muestran el progreso y cómo continuar.

## 6. Feedback claro y sin pérdidas

- Toda acción tiene respuesta inmediata y visible.
- Los mensajes de error dicen qué ha pasado y cómo solucionarlo, en lenguaje humano. Nunca códigos ni mensajes técnicos.
- Un error nunca borra lo que el usuario había escrito.

**Dónde aparece el error.** El usuario tiene que ver el error donde está mirando y saber exactamente qué tiene que corregir:
- El mensaje de error aparece junto a la acción que lo ha provocado (al lado del botón o dentro del bloque o card donde se ha pulsado), no en un banner lejano o en otra parte de la pantalla.
- Si el error se debe a uno o varios campos, cada campo afectado queda marcado: borde o indicador en rojo y, debajo del campo, el mensaje que explica qué falla. La marca se mantiene hasta que se corrige.
- En formularios largos, al pulsar el botón se muestra un aviso junto a él indicando cuántos campos hay que revisar, y se lleva al usuario (scroll y foco) al primer campo con error.
- Los campos obligatorios están identificados desde el principio (por ejemplo, con asterisco), no solo después de fallar.
- Pregunta de control: provoca el error y mira dónde están tus ojos al pulsar. ¿Ves el error ahí? ¿Sabes qué campo corregir sin buscarlo?
- Las acciones destructivas o difíciles de revertir (borrar, fusionar, desconectar una cuenta, marcar como perdido, enviar un correo masivo) piden confirmación explicando la consecuencia (`ActionForm confirm="…"`), u ofrecen deshacer.
- Los procesos largos (importaciones, secuencias, formularios extensos) guardan el progreso.

## 7. Las tareas frecuentes, sin fricción

- Identifica la acción más repetida del flujo y cuenta los pasos. Cada paso que sobra se nota multiplicado por cientos de usos.
- Las acciones de cada día (registrar una llamada, marcar una actividad como hecha, mover un deal de fase, escribir al contacto) se hacen en uno o dos clics desde donde ya estás.
- El comercial ve lo que tiene pendiente en cuanto entra (Hoy), sin navegar por módulos.
- Los formularios piden solo lo necesario, con valores por defecto sensatos y datos ya conocidos prerrellenados.
- Se puede hacer en bloque lo que se haría muchas veces (cambiar responsable, etiquetar, marcar como hechas, aprobar propuestas de la IA).

## 8. Lenguaje claro y transparente

- Escribe como hablaría un compañero de ventas cercano, no como un sistema. Sin jerga técnica ni de base de datos (nada de JSON, API, UUID ni variables de entorno a la vista de un comercial).
- Usa los mismos términos para lo mismo en todo el producto (deal, contacto, empresa, lead, actividad; no «negocio» en un sitio y «deal» en otro).
- Los botones dicen lo que hacen («Enviar correo», «Marcar como hecha», «Crear deal»), no «Aceptar», «OK» o «Ver».
- En procesos sensibles, deja claro **quién verá la información y qué pasará** (¿la IA lo enviará sola o me preguntará?, ¿se avisa al contacto?, ¿se notifica a alguien al importar?).
- Tuteo, en castellano de España, cercano y directo.

## 9. Coherencia con el sistema de diseño

- Usa solo componentes de la librería del proyecto. Si no existe el que necesitas, señálalo en lugar de crear uno ad hoc.
- Espaciados, tipografías, radios y sombras salen de los tokens.
- El mismo patrón se resuelve igual en todos los módulos: tablas, filtros, formularios, cabeceras de página, modales.
- Antes de crear una pantalla, busca una similar ya existente en el producto y sigue su estructura.
- Componentes: `src/components` (ActionForm, Drawer, DataTable, ChoiceField, AutoSubmitSelect, Icon…). Tokens: variables de `:root` en `src/app/globals.css`. Pantallas de referencia: Ajustes → Usuarios (tabla + panel lateral), Actividades (tabla con filtros), IA del pipeline (lista a la izquierda + detalle).

## 10. Escritorio primero, móvil para el día a día

El producto es principalmente de escritorio. El móvil no es una versión reducida de todo, sino una experiencia enfocada en lo que se hace a diario.

**Clasifica el flujo antes de revisarlo:**
- **Rutinario (móvil depurado):** ver el parte de Hoy, registrar una llamada, marcar actividades como hechas, aprobar o descartar propuestas de la IA, consultar una ficha antes de una reunión.
- **Reflexivo (escritorio):** configurar secuencias, instrucciones de la IA, informes, importaciones y ajustes de administración.

**Para flujos rutinarios en móvil:**
- La acción principal ocupa el centro de la pantalla y se completa en uno o dos toques.
- Solo la información imprescindible para esa acción; todo lo demás, fuera de la vista o detrás de un "ver más".
- Botones grandes en la zona alcanzable con el pulgar (mitad inferior), objetivos táctiles de al menos 44×44 px.
- Confirmación clara y visible de que la acción se ha registrado.
- Nada se corta ni hay scroll horizontal.

**Para flujos reflexivos:**
- Se diseñan y revisan para escritorio. En móvil basta con que se puedan leer y no se rompan; si alguien entra, puede indicarse que la experiencia completa está en el ordenador.

**Siempre, en cualquier dispositivo:**
- Contraste de texto suficiente (WCAG AA).
- Todo se puede usar con teclado y el foco es visible.
- Los campos tienen label visible, no solo placeholder.
- Los iconos sin texto tienen tooltip y nombre accesible.
