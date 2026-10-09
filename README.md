# 🎴 Quad The Gathering

Mesa virtual de **Commander** (Magic: The Gathering) para **2–4 jugadores**, en **LAN con tus amigos** o contra la **IA**.
Pega links de decks (Archidekt, Moxfield, …), revisa el análisis del pod y juega con las **Reglas Completas aplicadas automáticamente**: fases, prioridad, pila, combate y avisos de efectos.

*A Commander virtual tabletop for 2–4 players over LAN or vs AI: import decks by link, check pod balance, and play with the Comprehensive Rules enforced automatically.*

## Inicio rápido / Quick start

```bash
npm start          # http://localhost:3000  (Node 18+, sin dependencias)
npm test           # parser, importadores y ~45 tests de reglas (CR)
```

### 🎴 Partida local (tú + IA)
1. Elige 2, 3 o 4 jugadores.
2. Pega un link en cada asiento (o cambia a **Texto** y pega la lista). También puedes pulsar **🎴 Decks demo**.
3. **▶ Jugar en la mesa**: tú controlas tu asiento y la IA juega los asientos marcados como IA.
   **🤖 Simular partida**: todos los asientos los juega la IA y tú solo miras.

### 🌐 Multijugador LAN
1. **Anfitrión:** ejecuta `npm start`. La consola muestra tus direcciones LAN (por ejemplo, `http://192.168.1.20:3000`).
2. Abre la app, escribe tu nombre y pulsa **Crear sala**. Recibes un código de 4 letras.
3. **Amigos:** abren la dirección del anfitrión (o el link `…/?room=CODE` del lobby), escriben su nombre y pulsan **Unirse**.
4. Cada quien carga su deck (link, texto o demo). El anfitrión puede poner IA en los asientos vacíos y pulsa **▶ Empezar partida**.

> Fuera de la misma red Wi-Fi, usen una VPN de juego como **Radmin VPN, Hamachi, ZeroTier o Tailscale** y compartan la IP que les da esa app.
> El servidor escucha en `0.0.0.0:3000`. Si Windows pregunta por el firewall, permite el acceso en redes privadas.
> La partida corre en el servidor del anfitrión. Cada jugador solo ve su propia mano.

### 🖼 Imágenes de cartas
No hace falta buscar ninguna base de datos. La app usa **[Scryfall](https://scryfall.com/docs/api)**, la base de datos pública de Magic. El servidor guarda una caché en `data/card-cache.json`: el anfitrión descarga cada carta una sola vez y la comparte con toda la LAN. Las imágenes se cargan desde el CDN de Scryfall.

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
- Validación del deck: 100 cartas, singleton e identidad de color (CR 903.5)
- Aviso de **pod desbalanceado** cuando los brackets difieren en 2 o más
- Selector de comandante cuando el sitio no lo marca
- **🔗 Compartir pod**: copia un link con nombres y URLs de los decks

**Mesa (sigue las Reglas Completas: ver [docs/REGLAS.md](docs/REGLAS.md))**
- **Fases completas con prioridad** (CR 117/500): el motor da prioridad en cada paso, con paradas inteligentes o completas. La pila se ve en la mesa y puedes responder a lo que lancen los demás
- **Avisos automáticos**: una franja muestra los efectos rivales que te afectan (Thalia, Rhystic Study, Esper Sentinel, Smothering Tithe, Rule of Law…). Al tocar una carta ves su coste real con el desglose (CR 601.2f)
- **Mano inicial**: mulligan de Londres (tú decides y eliges qué va al fondo)
- **Objetivos** (601.2c): eliges el objetivo de tus hechizos. Si desaparece antes de resolverse, el hechizo no se resuelve (608.2b)
- **Maná con colores** (CR 106/107.4): híbrido, pirexiano, {X}, Treasure, Command Tower, Signets
- **Combate en pasos** (506–511): eliges a quién ataca cada criatura y declaras tus bloqueadores. Hay first/double strike, menace, trample, deathtouch, lifelink, flying/reach, infect y más
- **Planeswalkers** (606): habilidades de lealtad +N/−N/−X una vez por turno; puedes atacarlos y el daño les quita lealtad
- **Generadores de tokens**: hechizos, habilidades con coste de maná o sacrificio (Krenko, Goblin Bombardment, Clue), "for each", X/X, disparadores de upkeep; Chatterfang y duplicadores
- **📊 Análisis de la partida**: lectura de mesa (mayor amenaza, carta MVP, eficiencia de maná), gráfica de vida por turno y tabla de estadísticas
- **Mesa en cruz** para 4 jugadores, como en el video
- **Acciones basadas en estado** (704) y **reglas de Commander** (903): impuesto, zona de mando, 21 de daño de comandante
- **🤖 IA juega por mí**, **⏭ Pasar turno**, velocidad y pausa (anfitrión), registro con números de regla

## La IA / How the AI plays

En cada turno la IA:
1. Juega una tierra (prefiere las que entran enderezadas) y activa fetchlands o habilidades "{T}: Create…".
2. Lanza hechizos que puede pagar con los colores correctos. Prioriza ramp, después su comandante y luego lo más caro.
3. Guarda los contrahechizos y el removal instantáneo para responder: contrarresta amenazas grandes y elimina atacantes peligrosos.
4. Ataca al oponente con menos vida sin regalar criaturas, y bloquea cuando le conviene o cuando un golpe sería letal.

## Estructura / Layout

```
server.js               servidor HTTP: estáticos, /api/deck, /api/cards, /api/rooms
src/sources.js          detección de sitio, descarga y normalización de decks
src/cards.js            caché de cartas de Scryfall en el servidor (data/card-cache.json)
src/rooms.js            salas LAN (Server-Sent Events + POST)
public/index.html       app (sin build)
public/app.js           UI: setup, lobby LAN, mesa, menús y decisiones
public/lib/engine.js    motor de reglas: turnos, prioridad, pila, combate, SBA, disparadores, IA
public/lib/mana.js      costes y pago de maná con colores
public/lib/session.js   ejecuta una partida y genera la vista de cada jugador (navegador o servidor)
public/lib/deckText.js  parser de listas en texto
public/lib/deckBuild.js construir decks y elegir comandante
public/lib/scryfall.js  datos de cartas vía Scryfall /cards/collection
public/lib/stats.js     análisis, bracket y legalidad
public/lib/demo.js      4 decks demo
docs/REGLAS.md          cobertura de las Reglas Completas
test/                   node:test
```

Datos de cartas por [Scryfall](https://scryfall.com). Proyecto de fans, no afiliado a Wizards of the Coast.
