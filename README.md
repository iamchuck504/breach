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
| R / Q | Recargar / cambiar Lancer↔Gnasher |
| F9 | Invertir eje Y (default: invertido) |
| F10 | Panel de tuning en vivo (lil-gui) |
| M / Esc | Silencio / menú |

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
- Reglas: TDM a 25 bajas, respawn 4 s, regen estilo Gears, gib de Gnasher a corta distancia

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
