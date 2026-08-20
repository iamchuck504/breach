# BREACH

Shooter web 4v4 (Rojo vs Azul) en tercera persona, inspirado en el game feel
de combate táctico en tercera persona: rebotes entre coberturas, correr, mantle y escopetazos.
100% Three.js con assets procedurales.

**Jugar:** https://breach-murex.vercel.app

## Correr local

```bash
npm install
npm run dev        # cliente en http://localhost:5173
```

## Multijugador (LAN)

```bash
npm run build
npm run server     # sirve el juego + WebSocket en :8787
```

Comparte `http://TU-IP-LOCAL:8787` — el cliente se autoconecta. El server es
autoridad de vida/muertes/respawn/marcador (una sala, 8 jugadores).

## Modos

- **VS Bots (4v4):** TDM por rondas (5 min, mejor de 3, 15 vidas por equipo)
  contra bots con IA táctica (roles dinámicos, flanqueos, cobertura real).
- **Práctica:** blancos móviles, munición infinita.
- **Multijugador:** hasta 8 en LAN (o con túnel/host público).

Mapas: **Fortaleza** (día, castillo) y **Azoteas** (noche urbana). Selector en
el menú; 5 variantes de soldado por equipo en la página PERSONAJE.

## Validación (headless, sin abrir ventana)

```bash
node scripts/smoke.mjs           # suite integral (movimiento, bots, MP, UI)
node scripts/check-movement.mjs  # harness agresivo de movilidad + muertes
node scripts/check-ai.mjs        # métricas tácticas de la IA (mapa, segundos)
node scripts/poses.mjs           # poses del rig / alineación del cañón
node scripts/check-ragdoll.mjs   # física del cadáver
```

Los scripts navegan con `?nolock=1` y limpian el ClipCursor de Windows al
salir (ver comentarios en `scripts/lib-clip.mjs`).

## Tuning

Todos los valores de game feel viven en `src/config/tuning.js` — panel en
vivo con **F10** dentro del juego. **F9** invierte el eje Y (invertido por
defecto). Deploy: push a `main` → Vercel (proyecto `breach`).
