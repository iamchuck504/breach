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
  contra bots con IA táctica (roles dinámicos, flanqueos, cobertura real,
  el humo les bloquea la visión de verdad).
- **Práctica:** blancos móviles, munición infinita.
- **Multijugador:** hasta 8 en LAN (o con túnel/host público), con lobby.

## Arsenal

Loadout de 4 slots: **SMG · escopeta · pistola · granada de humo**, con
selección directa (teclas 1-4, d-pad: ↑ granada · ↓ pistola · ← SMG ·
→ escopeta), ciclado con Q o la rueda del mouse, y **melee** en B/V.
Cada mapa coloca un pedestal con un arma **especial por ronda** (impar =
sniper, par = bazooka): se toma manteniendo evadir, reemplaza la primaria
en mano y su munición no se rellena en cajas. Los cuerpos colisionan
(empuje suave, sin atrapamientos).

## Mapas

**Fortaleza** (día, castillo), **Azoteas** (noche urbana), **Calle
Cerrada** (avenida al atardecer), **Estación de Metro** (subterráneo),
**Prisión** (patio + celdas) y **Pueblo Abandonado** (ruinas abiertas).
Selector en el menú y en el lobby; 5 variantes de soldado por equipo en
PERSONAJE. Opciones (Audio / Video / Idioma / Controles) en el menú.

## Validación (headless, sin abrir ventana)

```bash
node scripts/smoke.mjs               # suite integral (movimiento, bots, MP, UI)
node scripts/check-movement.mjs      # harness agresivo de movilidad + muertes
node scripts/check-arsenal.mjs       # armas: slots, melee, humo, especiales
node scripts/check-match-systems.mjs # pedestal por ronda, humo vs bots, spam
node scripts/check-ai.mjs            # métricas tácticas de la IA (mapa, segundos)
node scripts/poses.mjs               # poses del rig / alineación del cañón
node scripts/check-ragdoll.mjs       # física del cadáver
```

Los scripts navegan con `?nolock=1` y limpian el ClipCursor de Windows al
salir (ver comentarios en `scripts/lib-clip.mjs`).

## Tuning

Todos los valores de game feel viven en `src/config/tuning.js` — panel en
vivo con **F10** dentro del juego. **F9** invierte el eje Y (invertido por
defecto). Deploy: push a `main` → Vercel (proyecto `breach`).
