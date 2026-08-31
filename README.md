# BREACH

Shooter web 4v4 (Rojo vs Azul) en tercera persona, inspirado en el game feel
de combate táctico en tercera persona: rebotes entre coberturas, correr, mantle y escopetazos.
100% Three.js con assets procedurales.

**Jugar:** https://breach-murex.vercel.app

## Correr local

```bash
npm install
npm run dev        # cliente en http://localhost:5200
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
en mano y su munición no se rellena en cajas. En online el pedestal lo
arbitra el servidor (dos jugadores a la vez = un solo ganador). Los
cuerpos colisionan (empuje suave, sin atrapamientos).

La recarga puede cancelarse para disparar: conserva únicamente la munición
que ya haya entrado al arma. Breach no utiliza recarga activa ni bonificadores
de daño ligados a la recarga.

**Swat turn:** desde cobertura, correr de frente hacia otra cobertura a
menos de ~5 m cruza el hueco de un tirón y te pega a ella (si no hay nada
enfrente, sales corriendo normal).

El sniper lleva mira telescópica (FOV 20 al apuntar). Los bots usan el
mismo kit: melee a bocajarro, humo defensivo al retirarse y las armas del
pedestal — la bazooka solo con línea limpia y sin compañeros en el radio.

## Mapas

La rotación jugable actual contiene **Fortaleza** (día, castillo),
**Azoteas** (noche urbana) y **Calle Cerrada** (calle urbana nocturna).
Son los únicos mapas disponibles en el menú y el lobby. Hay builders de mapas
experimentales fuera de rotación, pero no se anuncian como contenido jugable.
Hay 5 variantes de soldado por equipo en PERSONAJE y opciones de Audio, Video,
Idioma y Controles en el menú.

## Editor de mapas (sandbox)

Botón **EDITOR DE MAPAS** en el menú. Está construido sobre el pipeline real:
un mapa del editor es un objeto de datos (`src/world/map-data.js`) que
`world.setLayout()` construye con las MISMAS primitivas que los mapas
escritos a mano, así que lo que ves en el editor es lo que el juego simula
— no hay un "formato de editor" y otro "formato de juego".

- **Cámara:** WASD mover · ESPACIO/C subir-bajar · clic derecho mirar · rueda zoom
  · `T` vista superior.
- **Construir:** biblioteca buscable y filtrable a la izquierda, doble clic o
  **INSERTAR EN VISTA** para colocar al centro, `ALT+CLIC` para colocar en un
  punto concreto, clic para seleccionar y `SHIFT+CLIC` para multiselección.
- **Editar:** `Q/W/E/R` selecciona/mueve/rota/escala, `F` enfoca la selección,
  `CTRL+D` duplica, `SUPR` borra, `CTRL+Z`/`CTRL+Y` deshace-rehace y el panel
  derecho actualiza X/Z/W/D/H/ROT/escala en vivo. Incluye snapping, espejo X/Z
  y `ESC` cancela una transformación antes de limpiar la selección o salir.
- **Marcadores:** spawns por equipo (con orientación), munición y punto de
  arma especial. Se ven en el editor, no en partida.
- **Visualización:** overlay de **cover real** (leído de `world.faces`, con
  color por altura) y de **navegación** (celdas transitables según la física
  del juego) + **ruta A→B** para detectar zonas inaccesibles.
- **Validación** agrupada: errores, advertencias y checks correctos para
  spawns, separación, límites, pickups, cover y conexión rojo↔azul. Los
  hallazgos asociados a objetos se pueden pulsar para seleccionarlos y
  enfocarlos; los errores bloquean un export frágil.
- **Playtest** instantáneo: juegas el mapa en edición y `ESC` vuelve al
  editor con todo intacto. Un mapa válido aparece en el selector y en el
  lobby local, y los bots lo navegan.
- **Clonar mapa del juego:** cualquiera de los layouts existentes (activos o
  builders experimentales) se clona a un
  mapa editable conservando TODO — cada caja exacta del builder original
  (color, cover, colliders invisibles, material de impacto), spawns con
  orientación, munición y arma especial con altura. La decoración (fachadas,
  GLBs, helipuerto) la sigue generando el builder original intacto (`base` en
  los datos + supresión de cajas en `world._box`); el toggle **DECOR** la
  apaga y revela los colliders ocultos. El original jamás se modifica.
- **Biblioteca urbana:** los mismos GLB que usa Calle Cerrada
  (`src/world/urban-assets.js`) se insertan como piezas (sin colisión, igual
  que en el mapa real; la colisión se pone aparte con cajas).
- **Personaje de referencia:** pieza que coloca el **Rig real del juego**
  (proporciones y altura de gameplay) con regla de alturas (LOW 1.1 · ojos
  1.3 · cabeza 1.74 · MID 1.9 · HIGH 3.0). Se mueve/duplica/oculta (botón
  REF) y **nunca viaja en el export** ni aparece en partida.
- **Guardado seguro:** indicador de cambios, confirmación al cambiar/salir,
  `CTRL+S`, `CTRL+SHIFT+S` y recuperación automática del último borrador tras
  un cierre inesperado. Los anchos de panel y preferencias del editor se
  recuerdan entre sesiones.
- **Exportar / Importar:** el JSON exportado ES el formato del juego (sin
  conversión); la validación bloquea errores y pide confirmación ante avisos. Un
  fichero en `src/world/maps/*.json` queda empaquetado como mapa del juego
  en modos locales.

Nota de arquitectura: la colisión y el cover del juego son **AABB**, así que
la geometría jugable rota en pasos de 90° (intercambia ancho/fondo). Los
props decorativos sí giran libremente porque no colisionan.

El editor completo es **solo DEV** (`import.meta.env.DEV` + import dinámico):
Vite lo elimina del build de producción. Atajos: `http://127.0.0.1:5200/?editor=1`
entra directo al editor sin pasar por el menú, y `scripts/editor.ps1` arranca
el dev server si hace falta y abre el navegador ahí (es lo que usa el acceso
directo "BREACH Editor" del escritorio).
El acceso se instala o repara con `npm run editor:shortcut`; `npm run editor`
abre el editor y arranca su servidor local oculto si todavía no está activo.

## Validación (headless, sin abrir ventana)

```bash
npx playwright install chromium        # una vez por máquina/CI
npm test                                # genera dist y ejecuta la suite oficial
node scripts/smoke.mjs               # suite integral (movimiento, bots, MP, UI)
node scripts/check-movement.mjs      # harness agresivo de movilidad + muertes
node scripts/check-editor.mjs        # editor: construir, validar, playtest, volver
node scripts/check-editor-clone.mjs  # clonador: fidelidad exacta + export/import
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
