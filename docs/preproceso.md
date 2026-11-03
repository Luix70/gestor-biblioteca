# PreProceso — preparar antes de catalogar

Diseño acordado con el usuario el 3-nov-2026. Estado: **diseño**; se construye por fases. LibreOffice ya está en la
imagen (probado en el Atom el 3-nov), así que la conversión de .doc se hace en el NAS.

## Por qué

Hoy el Vigilante **prepara y cataloga en la misma pasada**: expande comprimidos, inspecciona con IA, cose capítulos y
junta escaneos, y justo después cataloga. Cuando un paso de preparación falla, lo que queda a medias se cataloga igual.
Así nacieron los 1.084 documentos de capítulo de World Tracker Library (1-nov).

`PreProceso` separa las dos etapas. **Regla de fondo: en PreProceso nunca se cataloga nada.** Solo se trabaja sobre
los ficheros; la base de datos no se toca.

## Flujo

```
BIBLIOTECA DIGITAL/PreProceso/<carpeta>    ← el usuario deja aquí lo complejo (World Tracker Library, Computers…)
   │  1. expandir zip/rar/7z
   │  2. inspeccionar con IA → _guia.json (colección, materia, revista, obra, desglose…)
   │  3. preparar el contenido: coser capítulos o quedarse con el libro entero; escaneos → PDF; .doc/.rtf → PDF
   │  4. apartar lo que no es un libro (webs HTML, fuentes, miniaturas) con un informe
   │  5. señalar lo que ya está en la biblioteca (mismo hash)
   ▼  cada UNIDAD lista pasa sola (movimiento en el mismo volumen, instantáneo)
BIBLIOTECA DIGITAL/Inbox/<unidad>           ← el Vigilante la cataloga obedeciendo su guía, sin volver a inspeccionarla
```

- **Paso automático** (decisión del usuario): una unidad pasa al Inbox en cuanto está lista. Lo dudoso (IA con poca
  confianza, conversión fallida, mezcla que no se entiende) **se queda** en PreProceso con su informe, y el usuario lo
  decide desde el panel.
- **Por unidades, no por árbol**: lo fácil no espera a lo difícil.
- El Inbox sigue funcionando igual para lo que el usuario deje allí directamente, con todas sus redes de seguridad.
- Misma ubicación física que el Inbox (`/volume3/BIBLIOTECA DIGITAL`), para que pasar sea un `rename`, no una copia.

## Piezas que ya existen y cambian de sitio

| Paso | Código actual |
|---|---|
| Expandir comprimidos | `vigilante·expandirComprimidos` |
| Inspección IA y guías | `utils/inspeccion-auto.js`, `agente-estructura.js`, `afinar-guias.js`, `guias-estructura.js` |
| Escaneos → PDF | `utils/escaneo-a-pdf.js` |
| Libro por capítulos | `utils/libro-desglosado.js`, `utils/partes-contenidas.js`, `vigilante·materializarDesglose*` |
| .doc → PDF | `utils/convertir-a-pdf.js` (LibreOffice en el NAS); `scripts/convertir-partes-word.ps1` en el PC, de respaldo |
| Duplicados por hash | `motor-catalogo·buscarDocPorHash` (solo lectura) |

## Qué es «lista»

Una unidad está lista cuando ninguna de sus piezas necesita a una persona:
- tiene guía (o es un documento suelto que no la necesita);
- un libro por capítulos ya está cosido o reducido al libro entero;
- no le quedan formatos sin convertir que formen parte de un libro;
- lo que no es un libro está apartado y anotado.

## Panel

Tarjeta en «Entrada»: cada carpeta de PreProceso con su estado (esperando IA · convirtiendo · necesita revisión ·
pasada al Inbox), su informe y, en las que esperan, las acciones para decidir.

## Fases

1. Carpeta, vigilancia y estados (sin IA): expandir, escaneos, desgloses, conversión, paso al Inbox.
2. Inspección IA y guías en PreProceso; el Vigilante deja de inspeccionar lo que llega con guía de PreProceso.
3. Tarjeta del panel y acciones.
4. Primer caso real: `Computers`.
