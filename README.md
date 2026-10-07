# 🎴 Quad The Gathering

Mesa virtual de **Commander** (Magic: The Gathering) para **2–4 jugadores**.
Pega links de decks (Archidekt, Moxfield, …), revisa el análisis del pod y juega o mira una **simulación automática** en una mesa con zona de mando, vida 40, combate y banners de acción.

*A Commander virtual tabletop for 2–4 players: import decks by link, check pod balance, then play or watch an AI-simulated game.*

## Inicio rápido / Quick start

```bash
npm start          # http://localhost:3000  (Node 18+, sin dependencias)
npm test           # parser, importadores y motor de juego
```

1. Elige 2, 3 o 4 jugadores.
2. Pega un link en cada asiento (o cambia a **Texto** y pega la lista). También puedes pulsar **🎴 Decks demo**.
3. **▶ Jugar en la mesa**: tú juegas tu asiento y la IA juega los asientos marcados como IA.
   **🤖 Simular partida**: todos los asientos los juega la IA y tú solo miras.

## Sitios soportados / Supported sites

| Sitio | Ejemplo de link | Cómo se importa |
|---|---|---|
| Archidekt | `archidekt.com/decks/123456/...` | API JSON (detecta comandante y maybeboard) |
| Moxfield | `moxfield.com/decks/AbC123` | API v3 (v2 como respaldo) |
| Deckstats | `deckstats.net/decks/<user>/<id>-...` | `api.php` |
| TappedOut | `tappedout.net/mtg-decks/<slug>/` | `?fmt=txt` |
| MTGGoldfish | `mtggoldfish.com/deck/<id>` | `/deck/download/<id>` |
| Texto | MTGO / Arena / export de Moxfield o Archidekt | parser local |

> Los links necesitan el servidor (`npm start`), porque esos sitios no permiten CORS desde el navegador. La pestaña **Texto** funciona sin servidor.
> Moxfield a veces bloquea peticiones automáticas; si falla, usa *Export → Copy* y pégalo en **Texto**.

## Funciones / Features

**Setup (análisis del pod)**
- Arte del comandante, número de cartas, MV promedio, tierras y precio (USD, Scryfall)
- Curva de maná, identidad de color, ramp / robo / removal / wipes / tutores
- **Bracket estimado** (1–5) a partir de Game Changers, tutores, turnos extra y destrucción masiva de tierras
- Aviso de **pod desbalanceado** cuando los brackets difieren en 2 o más
- Selector de comandante cuando el sitio no lo marca
- **🔗 Compartir pod**: copia un link con nombres y URLs de los decks

**Mesa**
- Zonas: biblioteca, mano, campo de batalla (criaturas / otros / tierras agrupadas), cementerio, exilio y **zona de mando** con impuesto de comandante
- Vida 40, **daño de comandante** (21 es letal), eliminación por biblioteca vacía
- Tu turno: toca una carta para jugarla, lanzarla, girarla (doble clic), sacrificarla, exiliarla o verla en grande
- **⚔ Combate** con selección de atacantes y objetivo; los oponentes bloquean solos
- **🤖 IA juega por mí** y velocidad de simulación (lenta → turbo) con pausa
- Banners como en el video: `LAND DROP`, `CAST`, `COMMANDER`, `REMOVAL`, `BOARD WIPE`, `COMBAT`, `DAMAGE`
- Registro completo de la partida

## La IA / How the AI plays

No es un motor de reglas completo. Lee el texto Oracle de cada carta y resuelve los efectos más comunes:

- robar cartas, daño, ganar vida, destruir o exiliar objetivos, board wipes
- buscar tierras básicas (ramp) y crear fichas de criatura

En cada turno juega una tierra, prioriza ramp, después su comandante y luego las cartas más caras que pueda pagar. Ataca al oponente con menos vida y bloquea solo cuando le conviene. Los counterspells y los combos complejos se ignoran.

## Estructura / Layout

```
server.js              servidor HTTP + proxy /api/deck
src/sources.js         detección de sitio, descarga y normalización
public/index.html      app (sin build)
public/app.js          UI: setup, mesa, menús, modales
public/lib/deckText.js parser de listas en texto (compartido servidor/cliente)
public/lib/scryfall.js datos de cartas vía Scryfall /cards/collection
public/lib/stats.js    análisis y bracket
public/lib/engine.js   motor de partida + IA
public/lib/demo.js     4 decks demo
test/                  node:test
```

Datos de cartas por [Scryfall](https://scryfall.com). Proyecto de fans, no afiliado a Wizards of the Coast.
