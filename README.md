# BREACH

Shooter web 4v4 (Rojo vs Azul) en tercera persona, inspirado en el game feel de
Gears of War 5: wall bouncing, roadie run, cover, slide into cover y combate de
escopeta a corta distancia. Three.js, todo procedural (modelos, mapa, audio),
sin assets externos.

## Correr

```
npm install
npm run dev        # cliente en http://localhost:5200 (modo práctica funciona solo)
```

Multijugador (mismo build sirve el cliente, ideal para LAN):

```
npm run build
npm run server     # http://localhost:8787 — comparte http://TU-IP:8787 en la LAN
```

En el deploy de Vercel (https) el navegador solo permite `wss://`, así que para
jugar online desde ahí el server necesita un host con TLS (Fly/Railway/etc.).
Para LAN, usar el server local es lo más simple.

## Controles

| Tecla | Acción |
|---|---|
| WASD + ratón | Moverse / cámara |
| Shift (mantener) | Roadie run |
| Espacio | Cover / slide into cover / wallbounce / dive (contextual) |
| Click derecho | Apuntar (precisión) |
| Click izquierdo | Disparar — sin apuntar dispara **desde el cañón** (retícula naranja proyectada) |
| F | Saltar — contra una pared alta hace **vuelta de gato** (wall jump estilo Ratchet) |
| R / Q | Recargar / cambiar Metralleta↔Escopeta (con animación; la otra va a la espalda) |
| F9 | Invertir eje Y (default: invertido) |
| F10 | Panel de tuning en vivo (lil-gui) |
| M / Esc | Silencio / pausa |

**Gamepad (layout Xbox, Gamepad API):** stick izq mover, stick der cámara
(curva cuadrática, sens en °/s), **A** roadie run, **X** cover/evadir,
**B** saltar, **RB** recargar, LT apuntar, RT disparar, Y cambiar arma,
MENU pausa. Vibración en
disparo/daño/cover si el control lo soporta. La config del control (bindings,
sensibilidad, invert Y) es independiente de la de teclado/ratón.

El disparo de cadera exige alineación cuerpo-cámara (`fireAlignMaxDeg`): en un
giro brusco el trigger fuerza el giro rápido y el tiro sale al alinearse
(nunca dispara "por la espalda"); el click queda bufereado 0.3 s.

**Pausa y configuración:** Esc, botón MENU del control, o el ícono ⏸ del HUD.
Desde ahí → **Controles**: rebinding de teclado y de botones del control
(click en el binding y presiona la tecla/botón), sensibilidad de ratón y stick,
e invert Y. Todo persiste en localStorage. En práctica la pausa congela el
juego; en línea la partida sigue.

## Salto

Salto arcade con gravedad (`TUNING.jump`): pasa por encima de coberturas bajas
(y te puedes parar sobre ellas). **Wall kick estilo Matrix**: salta HACIA una
pared alta (≥ `wallMinH`) y presiona salto otra vez en el aire — el jugador
planta los pies en la pared y patea de regreso con **giro lateral** (el
sentido del roll sigue tu movimiento a lo largo de la pared). Se puede
**disparar en el aire**, incluido durante el flip (el cuerpo sigue a la
cámara mientras rueda). La bala respeta la altura del salto (hitbox con `y`).

## VS Bots (4v4)

TDM por rondas contra bots en el mapa compacto **Arena**: tú + 3 bots aliados
vs 4 bots. Rondas de 5 min; cada equipo tiene **19 vidas** (4 iniciales + 15
respawns) y gana la ronda quien agota las del rival (al expirar el tiempo gana
quien conserve más vidas). **Match al mejor de 3** (primero a 2 rondas).
Scoreboard con **Tab / VIEW**: nombres, kills, deaths y puntaje (100 pts por
kill). Los bots patrullan, buscan línea de visión, strafean y disparan en
ráfagas con error de puntería; regeneran vida como los jugadores.

## Wallbounce

Espacio hacia una cobertura = slide. Durante el slide (o justo al llegar,
ventana `bounceWindow`) presiona Espacio con otra dirección para cancelar hacia
la siguiente cobertura. Cada rebote encadenado suma `chainSpeedBonus`.

## Estructura

- `src/config/tuning.js` — **todos** los valores de game feel (editable en vivo con F10)
- `src/player/controller.js` — máquina de estados (idle/run/roadie/dive/slide/cover/dead)
- `src/player/rig.js` — personaje procedural + animador de poses
- `src/world/world.js` — mapa "Foundry" (simétrico 180°), colisión AABB, caras de cover
- `src/combat/` — armas, hitscan, spread, falloff
- `src/fx/` — tracers/gibs/polvo + audio WebAudio procedural
- `src/net/client.js` + `server/server.js` — protocolo JSON, snapshots 20 Hz,
  interpolación 120 ms; el server es autoridad de hp/muertes/respawn/score
- Armas: **Metralleta** (auto, subfusil compacto) y **Escopeta** (pump con madera,
  8 perdigones, falloff, gib a corta distancia); ids internos `smg`/`shotgun`
- Reglas: TDM a 25 bajas, respawn 4 s, regen estilo Gears

## Deploy

Frontend: `vercel deploy --prod` (proyecto `breach`, salida `dist/`).
El server (`server/server.js`) es Node puro + `ws`; corre en cualquier host con
`node server/server.js` (usa `PORT`).

## Pendientes conocidos

- Lean/aim en esquinas de cobertura alta (hoy: popover en cover bajo + blindfire)
- Mantle sobre cobertura baja y swat turn
- Lag compensation / validación de posición en el server
- Bots con IA (los dummies de práctica no disparan)
- Segundo mapa, más armas, active reload
