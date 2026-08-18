# Sanity check completo — 2026-08-18

## Segunda pasada (re-auditoría de verificación, mismo día)

Tres revisores frescos verificaron los ~45 fixes de la primera pasada y
cazaron regresiones. Veredicto: fixes principales bien aplicados (raw input,
`sanitizing`, guards `alive()`, `G.player=null` sin null-derefs, timers de
bots, cooldowns). **Corregido en esta pasada:**

**Mouse/input:**
- Esc-para-reanudar dejaba el mouse muerto ~1.6 s (el `exitPointerLock` del
  mismo keydown es asíncrono y `input.locked` seguía true en `closeMenu`) →
  reintento de lock a los 60 ms.
- El keeper robaba el mouse al panel F10 y cada click disparaba → flag
  `lockSuspended`.
- `cancelSanitize` no cancelaba el timeout del ciclo ya programado →
  token de generación (`sanitizeGen`).
- Rescate de 500 ms: un lock de saneo que llegaba tarde (CPU cargada — la
  recaída de Chuck durante el audit) se trataba como lock legítimo y el clip
  no se saneaba nunca → `sanitizeReqAt` (ventana de 2.5 s).
- Fin de match dejaba el pointer lock puesto en el menú principal → release.
- `fullscreenchange`: release/pausa estaban dentro de un try ajeno → fuera.
- Esc durante rebind soltaba el lock; rebindear el botón de pausa del pad
  cerraba el menú a mitad → flag `input.rebinding`.
- Rama muerta de Escape en `_key` eliminada (trampa de doble toggle).

**Red/server (2 P0):**
- `yaw` sin clamp: un `{yaw:1e300}` congelaba la pestaña de TODOS los demás
  (bucle infinito en `lerpAngle`) → clamp en server + lerpAngle por módulo
  (también en main y botmatch).
- `dropA` pisaba el campo `t` (vida) con el discriminador del protocolo →
  drops invisibles en online → la vida viaja en `life`.
- Munición infinita: refill local + reintento de 1.5 s aunque el server
  rechazara la caja → el refill llega SOLO con la confirmación (`by`).
- Timer de `endRound` sobrevivía a la sala vacía; `crate` sin `me.alive`;
  `hit` no rompía la protección del atacante; `pub()` sin x/z (remotos
  nacían en 0,0); clamp de posición ±100 → ±40.
- onMatchEnd usaba el modo (string) y mataba la partida SIGUIENTE → identidad.
- `startOnline` no revalidaba tras el await (secuestraba la partida que
  empezaras mientras conectaba) → `startSeq`.
- Doble feedback del golpe mortal (hurt sobre muerto); "Desconectado" dejaba
  un REANUDAR muerto.

**Gameplay/HUD:**
- "SIN VIDAS"/"DERROTA"/"ROUND PARA…" se borraban el mismo frame (estado
  compartido de `#center-msg`) → `center()` resetea `_resp` y `big`; countdown
  oculto también en intermission.
- Recargando, un click latcheaba la pose de tiro ~2 s (te asomaba expuesto
  sobre el cover) → `hasAmmo` excluye recarga.
- Cadáver enterrado al morir sobre un bloque → `groundFn` (suelo real);
  el desplome ya no se completa en el aire.
- Rebote al vacío contaba cadena/SFX (`_tryEvade` devolvía true en el dive
  fallback) → distingue 'slide'/'dive'.
- Bot herido sin cover disponible se congelaba (estado y arma) → fallthrough
  a combate. Escopeta contaminaba el ritmo de ráfagas (`burstT` compartido)
  → `muzzleT`. Intermission congelaba ragdolls a mitad de caída → siguen.
- Drops a nivel del piso al morir sobre un bloque → viaja `y`; recogida por
  altura RELATIVA; posición determinista (online: mismo punto en todas las
  pantallas); hint de balas anuncia lo ganado real (post-clamp).
- Rescate del slide salía patinando a 9.4 m/s → frena a velocidad de carrera.
- `kill()` con `_setState` (stateT); swap sin guiño lateral heredado;
  recarga con whitelist también en gunMount; ADS excluye roadie/blind_over
  remotos (IK vs Euler).

Suites tras la pasada: SMOKE OK (19 checks), POSES OK, ragdoll 0.14 m,
server syntax OK.

Auditoría de todo el juego con 3 revisores paralelos (pipeline de mouse,
lógica de gameplay, red/server/UI) + trazado propio. **~80 hallazgos**,
~45 corregidos en esta pasada, el resto documentado abajo.

## Culpables del mouse (todos corregidos)

| Culpable | Fix |
|---|---|
| Opción "raw input" persistida en localStorage reactivaba el camino con el bug de ClipCursor para siempre | **Eliminada por completo** (+ se borra la clave guardada de quien la tuviera) |
| `sanitizing` podía quedarse pegado → todos los clicks consumidos (no disparas nunca más) + saneador muerto | Listener `pointerlockerror` + timeout de rescate |
| Salir de fullscreen soltaba el lock por la vía interna del navegador (la sucia) | El juego suelta el lock él mismo (limpio) antes de salir de fullscreen, y pausa |
| `keyboard.lock` fallido dejaba Esc 100% en manos del navegador | Se registra si fue CONCEDIDO; si no, Esc mantiene el exit programático |
| Re-lock fallaba en silencio: cooldown de Esc, despausar con gamepad (sin gesto), lock post-`await` | Keeper: reintento de captura cada 1.6 s mientras juegas sin lock |
| F10/desconexión armaban saneos espurios que re-capturaban el mouse solos | `releaseLock()` marca sus exits como limpios |
| Saneo con menú cerrado se quedaba el lock sin sanear | El ciclo SIEMPRE ejecuta su exit |
| Foco en el campo "Nombre" mataba Esc permanentemente | Esc procesa antes del filtro de inputs (y hace blur) |
| Slider agarrado sobrevivía al alt-tab y se arrastraba solo | vDrag se limpia en blur y al cerrar menú |
| Checkbox no clickeable con cursor virtual, clicks fantasma en el vacío, hover ilegible | Corregidos |
| Deltas/edges de mouse sobrevivían al unlock (giro fantasma al re-lockear) | Se limpian en pointerlockchange |
| Recoil sin clamp de pitch, retícula corriendo bajo el menú, anillo recortado >190px, sens corrupta en localStorage | Corregidos |

## Gameplay (corregidos)

- Slide sin salida garantizada → timeout de rescate a run (0.9 s).
- Flags pegados al morir/revivir (`firingBlind`, `coverLeanAnim`, `detachT`,
  `evadeCooldown`, `bounceWindow`, `chain`, `usedDouble`) → `_clearTransient()`.
- Cadáver flotando al morir en el aire / hundido al morir sobre un bloque →
  el ragdoll cae con gravedad hasta el suelo.
- Gatillo sin balas mantenía pose de tiro y bloqueaba el roadie → gate `hasAmmo`.
- `chain++` y SFX de wallbounce sin rebote real → solo en éxito.
- Direcciones de evade/dive sin normalizar (stick a medio recorrido) → normalizadas.
- Y fantasma al salir de cajas en slide/dive → snap al terreno real.
- Blindfire disparaba desde MÁS ALLÁ del bloque (tiros a través del propio cover)
  → origen sobre el borde, dentro de la huella.
- aimRig con roll/pitch/yaw pegados entre estados (arma ladeada permanente,
  apuntando al cielo en dive/slide) → targets explícitos por estado.
- IK de recarga peleándose con poses Euler en dive/slide/roadie → whitelist.
- "Brote" del suelo al revivir (hips) → reset directo.
- Bots: cover eterno (timer de fase vs timer global), ráfaga congelada al perder
  al enemigo, NaN por solape de entidades, spawn encimado con el jugador,
  cooldown negativo sin clamp.
- Countdown de respawn mentiroso sin vidas en el pool → "SIN VIDAS".
- Armas: cooldown del arma guardada congelado, protección de spawn del jugador
  al inicio de partida, arma del muerto auto-recargando.
- Cápsulas de hitbox: impactos en las tapas se perdían con raíz negativa.
- Drops/cajas recogibles desde ENCIMA de un bloque → gate de altura.
- Drop con reserva llena se desperdiciaba → ya no se consume.
- Fuga de CanvasTexture del nametag en cada dispose de rig.
- Estados de animación desconocidos (red) congelaban el rig → default a idle.

## Red / server (corregidos)

- **Mensaje `fire` malformado reventaba el handler de todos los clientes** →
  saneado en server (vec3 validado) + defensa en cliente.
- Estados falsificables (`dead` estando vivo = "cadáver que dispara"),
  `sp`/`pitch`/pos sin clamp → whitelist + clamps en server.
- `fire` de jugadores muertos → rechazado.
- Reconexión fallida mataba la partida en curso → guard de sesión (`alive()`)
  en todos los handlers + flag `dead` en NetClient (mensajes bufereados de una
  sesión desechada no ejecutan closures viejos).
- Sala vacía conservaba marcador/drops/cajas/resetting → reset al vaciarse.
- Reset de partida no limpiaba drops/cajas/stats → limpiados y broadcast.
- Remoto que respawnea "se deslizaba" cruzando el mapa → teleport limpio (buffer purgado).
- addRemote con id duplicado dejaba rigs huérfanos → dispose del anterior.
- `welcome` re-creaba drops viejos con vida completa → viaja el tiempo restante.
- Cajas en online se auto-resucitaban localmente → modo autoritativo (server manda).
- Desconexión dejaba la escena viva (estatuas congeladas) → teardown completo.
- "Servidor lleno" se pisaba con "Error: conexión cerrada" → preservado.
- Mensajes centrales/killfeed colándose entre partidas → limpiados en teardown.
- Sombras: frustum fijo dejaba sin sombra las esquinas de District → se ajusta al mapa.

## Diferido (documentado, no corregido — por diseño o baja prioridad)

- **Anticheat real** (validar distancia/LOS/cadencia de `hit` en server, headshot
  server-side, límites de velocidad, filtro de visibilidad anti-wallhack): el
  server confía en los clientes; correcto para jugar con amigos, no para público.
- **Optimización de asignaciones por frame** (Map del rig, arrays de bots,
  vectores por perdigón, PointLight por fogonazo): sin síntomas de rendimiento hoy.
- Replicación de recarga/flipAxis de remotos (cosmético).
- Ping/pong, números de secuencia, extrapolación de snapshots.
- Dry-fire click sin munición; conservar progreso de recarga al cambiar de arma;
  buffer de recarga durante el swap.
- Scoreboard en modo online (hoy solo VS Bots); rebuild del scoreboard por frame.
- Audio posicional/atenuado por distancia.
- `_buildArena` sin uso (mapa compacto disponible para un selector futuro).
- Munición inventada en los drops de bots (no llevan contador).
