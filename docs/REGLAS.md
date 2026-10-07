# ⚖️ Reglas implementadas / Rules coverage

Este documento lista qué partes de las **Magic: The Gathering Comprehensive Rules** sigue el motor (`public/lib/engine.js`, `public/lib/mana.js`), cuáles se aproximan y cuáles faltan.
Cada regla implementada tiene al menos un test en `test/engine.test.js` con el número de regla en su nombre.

> **Fuente:** las reglas están escritas a partir del conocimiento de las Comprehensive Rules. No pudimos leer el PDF *MagicCompRules 20260925* desde el entorno de desarrollo (red bloqueada). Si algún número o detalle cambió en esa versión, avísanos y se ajusta.

Leyenda: ✅ implementado · 🟡 aproximado · ❌ no implementado

## 1. Inicio de partida (CR 103)

| Regla | Estado | Detalle |
|---|---|---|
| 103.1 Jugador inicial aleatorio | ✅ | |
| 103.3 Barajar | ✅ | |
| 103.4 Mano inicial de 7 | ✅ | |
| 103.5 Mulligan de Londres | ✅ | Roba 7 y pone N al fondo |
| 103.5c Primer mulligan gratis en multijugador | ✅ | |
| 103.8a En duelo, quien empieza no roba | ✅ | |
| 103.8c En multijugador nadie se salta el robo | ✅ | |

## 2. Maná y costes (CR 106, 107.4, 202, 305.6, 601.2)

| Regla | Estado | Detalle |
|---|---|---|
| 107.4 Símbolos: genérico, color, {C}, híbrido, {2/W}, pirexiano, {X} | ✅ | El pirexiano se paga con 2 vidas si no hay maná del color |
| 305.6 Tierras básicas producen su color | ✅ | Incluye tierras con tipos básicos (Overgrown Tomb…) |
| Habilidades "{T}: Add …" | ✅ | Sol Ring, Talismanes, dorks, Command Tower / Arcane Signet (identidad del comandante) |
| Signets "{1}, {T}: Add {X}{Y}" | 🟡 | Se tratan como +1 maná de cualquiera de sus colores |
| 106.4 La reserva de maná se vacía entre pasos | ✅ | El sobrante (por ejemplo, el 2.º maná de Sol Ring) queda en la reserva |
| 601.2h Pagar el coste total con colores correctos | ✅ | Primero los símbolos de color con las fuentes menos flexibles, luego el genérico |
| 302.6 Una criatura con mareo no usa {T} | ✅ | |
| Maná de nieve {S} | 🟡 | Se trata como genérico |

## 3. Tiempos y la pila (CR 116, 117, 305, 307, 405, 601, 608)

| Regla | Estado | Detalle |
|---|---|---|
| 305.1–305.2 Jugar tierra: una por turno, fase principal, pila vacía | ✅ | No usa la pila |
| 307.1 Velocidad de conjuro para criaturas, conjuros, etc. | ✅ | |
| Instantáneos y destello en cualquier momento con prioridad | ✅ | |
| 405 / 601 La pila: lanzar pone el hechizo en la pila | ✅ | Se muestra en la mesa (`PILA:`) |
| 117 Ronda de prioridad tras cada hechizo, en orden de turno | 🟡 | Cada oponente puede responder una vez. Las respuestas también pueden ser respondidas (contrahechizo vs contrahechizo) |
| 701.6 Contrarrestar | ✅ | "Counter target [noncreature/creature/instant or sorcery] spell" |
| 508.8 Prioridad tras declarar atacantes | ✅ | Los defensores pueden lanzar removal a los atacantes |
| 608.3 Los permanentes entran al resolver | ✅ | Con sus disparadores de "enters" |
| Habilidades activadas no de maná (602) | 🟡 | "{T}: Create… / Draw…" (por ejemplo, Krenko) y fetchlands (pagan vida y se sacrifican) |

## 4. Estructura del turno (CR 500–514)

| Regla | Estado | Detalle |
|---|---|---|
| 502.3 Enderezar | ✅ | Respeta "doesn't untap during" |
| 503 Mantenimiento: "At the beginning of your upkeep" | ✅ | |
| 504 Robar | ✅ | |
| 505 Fases principales 1 y 2 | ✅ | |
| 506–511 Combate en pasos | ✅ | Ver sección 5 |
| 513 Paso final: "At the beginning of your end step" | ✅ | |
| 514.1 Limpieza: descartar hasta 7 | ✅ | El humano elige qué descartar |
| 514.2 Se quita el daño y terminan los efectos "hasta el final del turno" | ✅ | |
| "No maximum hand size" | ✅ | |

## 5. Combate (CR 506–511, 702)

| Regla | Estado | Detalle |
|---|---|---|
| 506.2 / 802 En multijugador cada criatura puede atacar a un jugador distinto | ✅ | Desde el modal de ataque |
| 508.1a Atacantes: sin girar, sin mareo (o con prisa), sin defensor | ✅ | |
| 508.1f Atacar gira la criatura (salvo vigilancia) | ✅ | |
| 508.3 Disparadores "Whenever ~ attacks" / "Whenever you attack" | ✅ | |
| 509 Declarar bloqueadores | ✅ | El humano elige con un modal (con sugerencia de la IA) |
| 509.1h Una criatura bloqueada sigue bloqueada aunque su bloqueador desaparezca | ✅ | Solo hace daño con arrollar |
| 510.1c-d Asignar daño letal a cada bloqueador antes del siguiente | ✅ | |
| 510.2 El daño de combate es simultáneo | ✅ | |
| 510.4 Paso adicional de daño con first strike / double strike | ✅ | |
| 702.2 Toque mortal (incluye "1 es letal" para arrollar) | ✅ | |
| 702.9 Vuelo / 702.17 Alcance | ✅ | |
| 702.15 Vínculo vital | ✅ | |
| 702.19 Arrollar | ✅ | |
| 702.20 Vigilancia / 702.10 Prisa / 702.3 Defensor | ✅ | |
| 702.111 Amenaza (menace) | ✅ | |
| 702.12 Indestructible | ✅ | |
| 702.14 Forestwalk | ✅ | Otros landwalk: ❌ |
| 702.90 Infectar / 702.80 Marchitar / 702.164 Tóxico | ✅ | |
| "Can't be blocked" / "can't block" | ✅ | |
| Atacar planeswalkers / batallas | ❌ | Solo se ataca a jugadores |
| Protección, ward, flanqueo, bushido… | ❌ | |

## 6. Acciones basadas en estado (CR 704)

| Regla | Estado |
|---|---|
| 704.5a Vida 0 o menos | ✅ |
| 704.5b Robar de una biblioteca vacía | ✅ |
| 704.5c 10 contadores de veneno | ✅ |
| 704.5d Los tokens fuera del campo dejan de existir | ✅ |
| 704.5f Resistencia 0 o menos (aunque sea indestructible) | ✅ |
| 704.5g Daño letal | ✅ |
| 704.5h Daño de toque mortal | ✅ |
| 704.5i Planeswalker con lealtad 0 | ✅ |
| 704.5j Regla de leyenda | 🟡 La IA conserva la más reciente; el humano no elige |
| 704.5q Contadores +1/+1 y −1/−1 se anulan | ✅ |
| 704.6c 21 de daño de combate de un mismo comandante | ✅ |
| 800.4a Los objetos de un jugador eliminado dejan la partida | ✅ |

## 7. Reglas de Commander (CR 903)

| Regla | Estado | Detalle |
|---|---|---|
| 903.3 Designar comandante | ✅ | Se detecta del sitio o se elige entre los legendarios |
| 903.4 / 903.5c Identidad de color | ✅ | Aviso en el setup |
| 903.5a 100 cartas exactas | ✅ | Aviso en el setup |
| 903.5b Singleton (salvo básicas y "any number of cards named") | ✅ | Aviso en el setup |
| 903.6 El comandante empieza en la zona de mando | ✅ | |
| 903.7 40 de vida | ✅ | |
| 903.8 Impuesto de comandante (+2 por lanzamiento previo) | ✅ | |
| 903.9a Cementerio/exilio → zona de mando (acción basada en estado) | ✅ | Siempre se elige volver |
| 903.9b Mano/biblioteca → zona de mando (reemplazo) | 🟡 | Biblioteca sí; a la mano se queda en la mano |
| 903.10a Daño de comandante | ✅ | |

## 8. Efectos leídos del texto Oracle (CR 608, 603, 614, 613)

El motor no programa cada carta. Lee el texto Oracle y resuelve estos patrones:

- **Efectos de hechizo y "enters":** robar, daño (a cualquier objetivo, a criaturas, a cada oponente), perder o ganar vida, destruir o exiliar un objetivo (respeta hexproof/shroud, CR 702.11 y 702.18), board wipes, `-X/-X` masivo, sacrificio forzado (Grave Pact), buscar tierras (Cultivate, Rampant Growth, fetchlands), contadores +1/+1 masivos y tokens de criatura con habilidades.
- **Disparadores (603):** "When/Whenever … dies" (Blood Artist, Zulaport Cutthroat; mira hacia atrás, 603.10a), "deals combat damage to a player", ataque, mantenimiento y paso final. Se resuelven en orden APNAP (603.3b).
- **Reemplazo de tokens (614):** Chatterfang ("plus that many Squirrels") y duplicadores ("twice that many").
- **Efectos estáticos de "lords" (613):** "(Other) [Tipo] creatures you control get +N/+N".

## ❌ No implementado (todavía)

- Auras y equipos (se quedan en el campo sin efecto), habilidades de lealtad de planeswalker, copiar, robar el control, sagas.
- Habilidades activadas con costes de maná (fuera de los Signets), habilidades de cementerio (flashback, unearth…).
- Pasos de prioridad completos en cada paso (CR 117 / 500.2). Solo hay ventanas al lanzar un hechizo y tras declarar atacantes.
- Reglas multijugador opcionales: rango de influencia (801), atacar a la izquierda o a la derecha (803–804).
- Elecciones del humano en la regla de leyenda y en el sacrificio forzado (se eligen automáticamente).
