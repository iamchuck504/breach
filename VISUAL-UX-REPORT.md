# Breach — pasada visual y UX, 7 septiembre 2026

## Restauración

Punto previo: `2f72966d5e2f25e2017c8794727e2486f8b6d0e5`, rama `backup/pre-visual-ux-20260907`. No se borraron fuentes ni backups anteriores. La rotación de mapas permanece intacta.

## Inventario y decisiones

La clasificación se realizó por familias de assets/builders, no como un catálogo individual de cada instancia del escenario.

| Mapa / familia | Clasificación inicial | Trabajo y decisión |
| --- | --- | --- |
| Fortaleza: puertas, galerías, arcos, torres, detalles del castillo | Calidad suficiente para esta pasada | Conservado el kit Blender reciente; no rehacerlo ni alterar sus pasillos/escaleras. |
| Azoteas: acceso, gabinetes, rejillas y HVAC | Calidad suficiente / ajustes menores | Conservados los assets recientes, helipad, barandales y skyline. |
| Azoteas: tanques | Necesita pequeños ajustes | Nuevo GLB Blender reutilizado en ambos puntos: bandas, tapa, boca de inspección, apoyos y materiales metálicos diferenciados. |
| Calle y Calle 2: sedanes, SUV, policía, buses y camiones | Calidad suficiente para esta pasada | Conservados modelos, escala y materiales existentes. No tocar armas/personajes ni hitboxes. |
| Calle y Calle 2: café, hot dogs, prensa, dumpsters, paradas, jersey, señalización de obra | Calidad suficiente para esta pasada | Conservados los refinamientos Blender ya existentes. |
| Calle y Calle 2: fachadas, ventanas, rótulos, iluminación y fondo | Calidad suficiente / ajustes puntuales futuros | Inspección global sin reprocesar sus kits ni cambiar colocación. No constituye certificación individual de todos los letreros. |
| Metro: decoración de trenes, estación y consolas | Placeholder / necesita refinamiento | Exportada a Blender, bordes suavizados selectivamente, ventanas de extremos, juntas, limpiaparabrisas, paneles y ranuras; agrupación por material. |
| Prisión: decoración de celdas, torres y patio | Placeholder / necesita refinamiento | Exportada a Blender, ventanas de cabinas, parteluces, cerraduras, bordes y agrupación por material. |
| Pueblo: ruinas y aberturas | Placeholder / necesita refinamiento | Exportado a Blender, tablas sobre aberturas existentes, bordes selectivos y agrupación por material. |
| Foundry / Arena | Legacy: requiere rediseño importante si vuelve a producción | Revisados como builders de prueba; conservados, no activados ni presentados como arte final. |
| `.blend1`, fuentes experimentales y archivos no versionados ajenos | Posible duplicado / uso no confirmado | No eliminados: no hay evidencia suficiente para destruirlos. |

Cuatro fuentes `.blend` editables y cuatro GLBs nuevos en el pipeline existente. Tres snapshots de entrada hacen reproducible el refinamiento. Las texturas originales se empacan; el script no hace un nuevo unwrap completo. Se conservan las dimensiones estructurales; los nuevos detalles son superficiales. Referencias de construcción consultadas: [unidad HVAC de Trane](https://www.trane.com/commercial/north-america/us/en/about-us/newsroom/glossary/packaged-unit.html) y [mobiliario exterior Steelcase](https://www.steelcase.com/products/outdoor-chairs/). No se copiaron marcas ni logos.

## Menús

- Sistema común pizarra/ámbar: jerarquía tipográfica, controles grandes, foco visible, paneles, espaciado, contraste, transiciones cortas y reducción de movimiento.
- Acciones principales compactas; explicaciones contextuales separadas de botones. Servidor/lobby agrupado junto a los modos, con loadout/utilidades a la derecha.
- Previsualizaciones reales de los cuatro mapas disponibles, sin imágenes conceptuales engañosas.
- Estilo común para splash, principal/pausa, opciones, audio, video, idioma, bindings, selección de personajes, lobby, equipos y configuración existente.
- Sin nuevas opciones ficticias ni cambios a reglas, inputs de gameplay o networking. Inglés sigue siendo default.

## HUD

- Seis ilustraciones renderizadas de los GLBs reales: pistola, SMG, escopeta, sniper, bazooka y granada. Paleta aclarada únicamente en las ilustraciones para lectura sobre fondos oscuros.
- Cruceta central compacta: cuatro slots reales, selección visible, reserva/cargador, reload ámbar, sección completa roja cuando está vacía y slot no disponible atenuado.
- Conservada ventana de 500 ms y fade; cambios rápidos reutilizan el mismo wheel. Sniper/Bazooka actualizan el contenido real.
- Munición principal, marcador, notificaciones, prompts, scoreboard, resultados/MVP y spectator comparten el sistema visual. Se conservan las microinteracciones existentes de munición, score y cambio de arma; no se añadieron efectos constantes.
- Etiquetas de teclas leen los bindings actuales en lugar de números fijos.

## Bugs corregidos durante la pasada

- HUD podía acceder a la definición de un slot inexistente: ahora muestra indisponible sin excepción.
- Scoreboard podía conservar nombre/equipo anterior cuando kills/deaths no cambiaban: corregida clave de caché.
- Spectator podía mantener el estilo anterior al cambiar únicamente `ready`: corregida clave de caché.
- Wheel conservaba pseudo-elementos del diseño anterior y las armas negras perdían lectura: retirados esos elementos y aclaradas ilustraciones.
- Menú principal concentraba demasiada altura en una columna a 720p: redistribuido servidor/lobby.

## Validación realizada

- Build de producción e i18n: correctos, siete idiomas.
- `check-visual-ux`: navegación real de submenús, 28 combinaciones idioma/resolución (800×600, 1280×720, 1920×1080 y 2560×1080); comprobación de overflow horizontal de tarjetas. HUD vacío/reload/especiales/no disponible, spectator y pantallas de resultado, sin excepciones de página.
- `check-menu-controller`: inicio/reload, stick, D-pad, deduplicación Steam, navegación y cambio de dispositivo.
- `check-gameplay-ui` y `check-weapon-wheel`: ammo parcial, reemplazo manual, estados, temporización, cambio rápido, reset y slots especiales.
- `check-online-flow-authority`: fase/pose/vida/respawn autoritativos e intermission bloqueada con clientes automatizados.
- `check-map-authority`, `check-round-flow`, `check-cover-fire`, `check-gameplay-tuning`: colisión/LOS, flujo, disparo desde cobertura y reglas de pickups/olas.
- Comparación exacta de manifiestos de los nueve mapas: colliders, spawns, cajas y pickup especial idénticos antes/después. Esto prueba preservación, no ausencia de defectos anteriores.
- Capturas de suelo/aéreas de los nueve builders; inspección visual de menús, wheel y mapas modificados.

## Rendimiento medido

Benchmark de renders estáticos headless a 1280×720, 4 renders de calentamiento y 12 muestras por vista, misma cámara. No es una partida completa: las cifras de tiempo tienen ruido por caché, GC y otros procesos. No atribuir la gran diferencia temporal de mapas sin cambios a esta pasada.

| Vista a nivel de suelo | Draw calls antes → después | Triángulos antes → después | Mediana render ms antes → después |
| --- | ---: | ---: | ---: |
| Fortaleza | 102 → 102 | 129692 → 129692 | 1.8 → 0.9 |
| Azoteas | 159 → 159 | 91702 → 91962 | 2.4 → 0.8 |
| Calle | 2200 → 2200 | 59752 → 59752 | 19.9 → 8.9 |
| Calle 2 | 1724 → 1724 | 499232 → 499232 | 28.2 → 8.0 |
| Metro | 138 → 49 | 1952 → 2912 | 0.4 → 0.2 |
| Prisión | 93 → 27 | 1948 → 2740 | 0.7 → 0.1 |
| Pueblo | 75 → 28 | 2556 → 3190 | 1.7 → 0.1 |

- Build: 35,992,192 → 39,543,258 bytes (+9.87%). Assets: 33,720,497 → 37,255,022 bytes. Se añadieron 10 PNG (6 armas 480×160, 4 mapas 1280×720) y 4 GLB.
- Precarga local: 502.3 → 217.1 ms, 37 → 41 assets, cero fallos. No representa descarga fría de internet.
- Heap observado: 180,203,819 → 140,664,498 bytes; no usar como ahorro garantizado por la variabilidad del GC.
- Cuatro reconstrucciones consecutivas de Calle 2: recursos estables en cada iteración; antes 1680 geometrías/162 texturas, después 1770/167. Aumento persistente de caché, sin crecimiento entre esas cuatro iteraciones. Cantidad de recursos, no bytes de VRAM.
- Se reducen draw calls en los tres conjuntos agrupados; no se promete aumento de FPS en Calle, cuyo coste elevado sigue presente.
- Vite conserva advertencia de bundle JS mayor a 500 kB. No se realizó un cambio de arquitectura/code splitting en esta pasada.

Evidencia local: `artifacts/visual-ux/{before,after}/benchmark.json`, `comparison.json` y capturas en `ui/`. Comprobación reproducible: `node scripts/compare-visual-ux.mjs` después de generar ambas mediciones.

## Límites y pendiente

Esta entrega es una pasada integrada de refinamiento, no la eliminación exhaustiva de todo placeholder del repositorio. Metro/Prisión/Pueblo mejoran detalles y coste pero conservan su base simple; Foundry/Arena requieren una intervención artística mayor si se quieren publicar. No se certificó cada instancia de fachada ni todo posible ángulo de clipping/UV.

Las pruebas de controller y host/client son automatizadas; no equivalen a probar físicamente todos los mandos con Steam abierto. La matriz de idiomas verifica tarjetas, no cada texto en cada estado de lobby/HUD. No se midieron 15 minutos de partidas, FPS reales con bots en todos los mapas, VRAM en bytes ni todas las resoluciones posibles. Esos puntos quedan pendientes de un playtest prolongado y no se declaran aprobados.
