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
| 103.5 Mulligan de Londres | ✅ | Tú decides quedarte o hacer mulligan, y eliges qué cartas van al fondo |
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

## 3. Tiempos, la pila y la prioridad (CR 101.2, 116, 117, 305, 307, 405, 601, 603, 608)

| Regla | Estado | Detalle |
|---|---|---|
| 305.1–305.2 Jugar tierra: una por turno, fase principal, pila vacía | ✅ | No usa la pila |
| 307.1 Velocidad de conjuro para criaturas, conjuros, etc. | ✅ | |
| Instantáneos y destello en cualquier momento con prioridad | ✅ | |
| 117.3a El jugador activo recibe prioridad primero en cada paso | ✅ | Upkeep, draw, mains, cada paso de combate y paso final |
| 117.3b Tras resolverse algo, la prioridad vuelve al jugador activo | ✅ | |
| 117.3c Quien lanza un hechizo vuelve a recibir prioridad | ✅ | Puedes "apilar" respuestas |
| 117.4 / 500.2 Todos pasan en sucesión: se resuelve el objeto de arriba, o termina el paso | ✅ | La pila completa se muestra en la mesa |
| Paradas inteligentes / completas | ✅ | Por defecto te detienes cuando hay algo en la pila, cuando te atacan o en el paso final rival (si tienes respuestas). Con "Paradas completas" te detienes en cada paso donde tengas opciones |
| 601.2c Elegir objetivos al lanzar | ✅ | Tú eliges el objetivo en un menú; la IA elige la mayor amenaza |
| 601.2f Coste total con aumentos/reducciones | ✅ | Thalia, Sphere of Resistance, Grand Arbiter, Goblin Electromancer, "the first spell each opponent casts…". Solo afectan el maná genérico |
| 101.2 "Can't" gana sobre "can" | ✅ | Rule of Law / Archon of Emeria (un hechizo por turno), Teferi (no lanzar en su turno), Lavinia |
| 603.2 Disparadores al lanzar | ✅ | Rhystic Study, Mystic Remora y Esper Sentinel (te pregunta si pagas o el rival roba), Ruric Thar, "Whenever you cast…" (Talrand, Young Pyromancer) |
| 608.2b Si el objetivo ya no es legal, el hechizo no se resuelve | ✅ | |
| 701.6 Contrarrestar | ✅ | Apunta a un hechizo concreto de la pila |
| 702.11b / 702.18 Hexproof / shroud | ✅ | |
| 608.3 Los permanentes entran al resolver | ✅ | Con sus disparadores de "enters" |
| 602 Habilidades activadas | 🟡 | "{T}: Create… / Draw…" (Krenko) y fetchlands usan la pila. Otras con coste de maná: ❌ |

## 4. Estructura del turno (CR 500–514)

| Regla | Estado | Detalle |
|---|---|---|
| 502.3 Enderezar | ✅ | Respeta "doesn't untap during" |
| 503 Mantenimiento: "At the beginning of your upkeep" | ✅ | |
| 504 Robar | ✅ | |
| 505 Fases principales 1 y 2 | ✅ | |
| 506–511 Combate en pasos | ✅ | Ver sección 5. Hay prioridad en cada paso de combate |
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
| 507 "At the beginning of combat on your turn" | ✅ | |
| 508.3 Disparadores "Whenever ~ attacks" / "Whenever you attack" | ✅ | |
| 508.8 Sin atacantes se saltan los pasos de bloqueo y daño | ✅ | |
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
- **Tokens de artefacto:** Treasure (se sacrifica al pagar con él), Clue y Food. Smothering Tithe te pregunta si pagas {2} cada vez que robas.
- **Reemplazo de tokens (614):** Chatterfang ("plus that many Squirrels") y duplicadores ("twice that many").
- **Efectos estáticos de "lords" (613):** "(Other) [Tipo] creatures you control get +N/+N".

## 9. Avisos automáticos

Cuando un permanente de otro jugador te afecta, la mesa lo muestra arriba como una franja de avisos, por ejemplo:

- 💸 *Thalia (Kuromi): hechizos no criatura cuestan {1} más (CR 601.2f)*
- 🔔 *Esper Sentinel (Shiro): cuando lances tu primer hechizo no criatura paga {1} o roba*
- 🪙 *Smothering Tithe: cada vez que robes, paga {2} o crea un Treasure*
- ⛔ *Rule of Law: solo un hechizo por turno*

Además, el menú de cada carta muestra su **coste real** con el desglose de modificadores, y por qué no puedes jugarla si no se puede (timing, maná, objetivos o restricciones).

## ❌ No implementado (todavía)

- Auras y equipos (se quedan en el campo sin efecto), habilidades de lealtad de planeswalker, copiar, robar el control, sagas.
- Habilidades activadas con costes de maná (fuera de los Signets), habilidades de cementerio (flashback, unearth…).
- Reglas multijugador opcionales: rango de influencia (801), atacar a la izquierda o a la derecha (803–804).
- Elecciones del humano en la regla de leyenda y en el sacrificio forzado (se eligen automáticamente).
