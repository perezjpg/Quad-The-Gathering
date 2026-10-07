# 🎴 Quad The Gathering

Mesa virtual de **Commander** (Magic: The Gathering) para **2–4 jugadores**.
Pega links de decks (Archidekt, Moxfield, …), revisa el análisis del pod y juega o mira una **simulación automática** en una mesa con zona de mando, vida 40, combate y banners de acción.

*A Commander virtual tabletop for 2–4 players: import decks by link, check pod balance, then play or watch an AI-simulated game.*

## Inicio rápido / Quick start

```bash
npm start          # http://localhost:3000  (Node 18+, sin dependencias)
npm test           # parser, importadores y 30+ tests de reglas (CR)
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

**Mesa (sigue las Reglas Completas: ver [docs/REGLAS.md](docs/REGLAS.md))**
- **Barra de pasos del turno** (CR 500): Untap → Upkeep → Draw → Main 1 → Combat → Main 2 → End → Cleanup
- **Maná con colores** (CR 106/107.4): costes híbridos, pirexianos y {X}; reserva de maná que se vacía entre pasos; Command Tower y Signets
- **La pila y la prioridad** (CR 405/117): cuando alguien lanza un hechizo puedes responder con instantáneos (por ejemplo, Counterspell), y la IA también contrarresta
- **Tiempos**: una tierra por turno (305.2) y velocidad de conjuro (307.1). Si una jugada es ilegal, la app te dice qué regla la impide
- **Combate en pasos** (CR 506–511): eliges a quién ataca cada criatura y declaras tus bloqueadores cuando te atacan. Hay first/double strike, menace, trample, deathtouch, lifelink, flying/reach, infect y más
- **Acciones basadas en estado** (CR 704): leyenda, resistencia 0, veneno, 21 de daño de comandante, biblioteca vacía
- **Commander** (CR 903): impuesto, vuelta a la zona de mando, 40 de vida y validación del deck (100 cartas, singleton, identidad de color)
- **Disparadores**: "dies" (Blood Artist, Zulaport), ataque, mantenimiento y paso final; reemplazo de tokens (Chatterfang); "lords"
- **🤖 IA juega por mí**, velocidad de simulación con pausa, banners como en el video y registro con números de regla

## Estructura / Layout

```
server.js              servidor HTTP + proxy /api/deck
src/sources.js         detección de sitio, descarga y normalización
public/index.html      app (sin build)
public/app.js          UI: setup, mesa, menús, modales
public/lib/deckText.js parser de listas en texto (compartido servidor/cliente)
public/lib/scryfall.js datos de cartas vía Scryfall /cards/collection
public/lib/stats.js    análisis y bracket
public/lib/engine.js   motor de reglas: turnos, pila, combate, SBA, disparadores, IA
public/lib/mana.js     costes y pago de maná con colores
docs/REGLAS.md         cobertura de las Reglas Completas
public/lib/demo.js     4 decks demo
test/                  node:test
```

Datos de cartas por [Scryfall](https://scryfall.com). Proyecto de fans, no afiliado a Wizards of the Coast.
