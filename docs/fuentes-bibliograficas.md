# Fuentes bibliográficas para enriquecimiento y clasificación

Catálogo de fuentes que el sistema puede usar para rellenar el documento Mongo y, sobre todo,
para **clasificar** (asignar CDU) gastando los mínimos recursos de IA. Orden de preferencia:
**el archivo → APIs gratuitas → scraping → IA/OCR**.

Leyenda de coste: 🟢 gratis/local · 🟡 gratis con límites/clave · 🟠 scraping (frágil/legal) · 🔴 IA (de pago).

---

## Tier 1 — El propio archivo (🟢, coste cero, máxima prioridad)

| Fuente | Aporta | Cómo |
|---|---|---|
| EPUB OPF / Dublin Core | título, autores, ISBN, editorial, año, sinopsis, idioma, materias (`dc:subject`), cubierta | `lector-epub.js` |
| PDF info-dict + capa de texto | título, autor, a veces ISBN (regex en primeras/últimas páginas) | reader PDF (pendiente) |
| Código de barras (EAN-13) en cubierta/contracubierta | ISBN | decodificador de barras (pendiente) u OCR/visión |

> `dc:subject` suele traer materias en texto libre → semilla directa para la CDU sin IA.

---

## Tier 2 — APIs gratuitas (🟡, sin IA)

| Fuente | Aporta | Clasificación | Acceso | Notas |
|---|---|---|---|---|
| **OpenLibrary** | título, autores, editorial, año, ISBN, sinopsis (work), portada | **Dewey (`dewey_decimal_class`)**, **LC (`lc_classifications`)**, `subjects` | REST `/isbn`, `/search.json`, `/works` | Ya integrado (`buscador-bibliografico.js`). Sin clave. |
| **Google Books** | título, autores, editorial, año, ISBN, sinopsis, idioma, portada, `pageCount` | `categories` (BISAC) | REST `volumes?q=` | Ya integrado (`buscador-google-books.js`). Clave en `.env`. |
| **Biblioteca Nacional de España (BNE)** | registro bibliográfico español autorizado | **CDU directa** + materias en español | `datos.bne.es` (SPARQL / Linked Data), Z39.50/SRU | ⭐ Mejor fuente de **CDU** para fondo español. Prioritaria para clasificar. |
| **Library of Congress** | registro MARC | **LCC + LCSH** | SRU `lccn.loc.gov`, `id.loc.gov` | Mapear LCC→CDU si hace falta. |
| **Deutsche Nationalbibliothek (DNB)** | registro alemán | **CDU/DDC** (Sachgruppen) | SRU | Útil para libros en alemán. |
| **WorldCat / OCLC** | catálogo mundial | **Dewey** | API (requiere registro) | Amplísima cobertura; clave institucional. |
| **Crossref / DOI** | metadatos de obras académicas | — | REST | Para PDFs académicos con DOI. |

---

## Tier 2b — Catálogos y comercios (🟡/🟠)

| Fuente | Aporta | Acceso | Notas |
|---|---|---|---|
| **ISBNdb** | metadatos + portada por ISBN | API (clave de pago) | Buena cobertura comercial. |
| **Amazon** | título, autor, sinopsis, categorías, portada de alta calidad | scraping 🟠 | Frágil y sujeto a ToS; usar como último recurso para portada/sinopsis. |
| **Casa del Libro / Todostuslibros (CEGAL)** | fondo español en venta | scraping 🟠 | Alternativa española a Amazon. |
| **Dialnet** | artículos y libros académicos españoles | scraping/REST | Para obra académica en español. |

---

## Tier 3 — IA y OCR (🔴, último recurso)

| Fuente | Aporta | Cuándo usar |
|---|---|---|
| **Gemini visión** (`gemini-2.5-flash`) | lee ISBN/título/editorial de imágenes y portadas | solo si no hay ISBN ni capa de texto (libros físicos, PDF escaneado) |
| **Gemini texto** | infiere **CDU** a partir de título/sinopsis/categoría | solo si ninguna fuente del Tier 2 trae CDU/Dewey y no hay equivalencia en caché |
| **OCR (Tesseract)** | texto de imágenes/PDF escaneado sin coste de IA | alternativa local a la visión para extraer ISBN/texto |

---

## Estrategia de clasificación (CDU) — minimizando IA

1. **`equivalencias_cdu`** (colección Mongo, caché local): si ya hay equivalencia para la materia/Dewey/categoría → usarla. **0 llamadas.**
2. **BNE**: si devuelve CDU directa → usarla y cachearla.
3. **OpenLibrary Dewey / LC** → mapear a CDU (tabla de equivalencias) y cachear.
4. **Google Books `categories`** → semilla para el prompt de CDU.
5. **IA (Gemini)** solo como último recurso, sembrada con todo lo anterior; cachear el resultado en `equivalencias_cdu`.

> Regla conservadora: lo que aporta el archivo nunca se sobrescribe con datos de Internet/IA.
