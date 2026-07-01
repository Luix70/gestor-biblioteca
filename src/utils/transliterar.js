/**
 * Transliteración a caracteres LATINOS (sin dependencias) para nombres de autor en otros alfabetos.
 * Motivo: OpenLibrary (y por tanto el Fichero) guarda muchos autores en su grafía ORIGINAL — p. ej. un
 * Chéjov español puede llegar como «Антон Чехов». Queremos que el nombre PRINCIPAL sea latino y conservar
 * la grafía original como VARIANTE (`nombres_alternativos`). Cubre cirílico y griego (los habituales en una
 * biblioteca en español: rusos y clásicos griegos). Otros alfabetos se detectan como no‑latinos pero, si no
 * hay mapa, se dejan tal cual (no inventamos una latinización pobre).
 */

// Cirílico → latino (base rusa + algunas letras ucranianas/bielorrusas). Digrafos donde toca (х→kh, ч→ch…).
const CIRILICO = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh', 'з': 'z', 'и': 'i',
    'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't',
    'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '',
    'э': 'e', 'ю': 'yu', 'я': 'ya', 'і': 'i', 'ї': 'yi', 'є': 'ye', 'ґ': 'g', 'ў': 'u', 'ђ': 'dj', 'ј': 'j',
    'љ': 'lj', 'њ': 'nj', 'ћ': 'c', 'џ': 'dz',
};
// Griego → latino (moderno/clásico práctico), incluidas vocales acentuadas.
const GRIEGO = {
    'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th', 'ι': 'i', 'κ': 'k',
    'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't',
    'υ': 'y', 'φ': 'f', 'χ': 'ch', 'ψ': 'ps', 'ω': 'o', 'ά': 'a', 'έ': 'e', 'ή': 'i', 'ί': 'i', 'ό': 'o',
    'ύ': 'y', 'ώ': 'o', 'ϊ': 'i', 'ϋ': 'y', 'ΐ': 'i', 'ΰ': 'y',
};

// Escapes \u (no caracteres no-ASCII en la regex) construidos con new RegExp — evita la corrupción de
// literales regex del proyecto y es explícito: cirílico, griego, hebreo, árabe, kana, CJK, hangul.
const RE_NO_LATINO = new RegExp('[\\u0400-\\u04FF\\u0500-\\u052F\\u0370-\\u03FF\\u1F00-\\u1FFF\\u0590-\\u05FF\\u0600-\\u06FF\\u3040-\\u30FF\\u4E00-\\u9FFF\\uAC00-\\uD7AF]');
const RE_MAPEABLE = new RegExp('[\\u0400-\\u04FF\\u0500-\\u052F\\u0370-\\u03FF\\u1F00-\\u1FFF]'); // cirílico o griego (los que sabemos transliterar)

/** ¿El texto contiene letras de un alfabeto NO latino? */
export function esNoLatino(texto) { return RE_NO_LATINO.test(String(texto || '')); }

/** Transliteración a latino de cirílico/griego (el resto de caracteres se conserva). Title‑case por palabra. */
export function transliterar(texto) {
    let out = '';
    for (const ch of String(texto || '')) {
        const low = ch.toLowerCase();
        const m = (low in CIRILICO) ? CIRILICO[low] : (low in GRIEGO ? GRIEGO[low] : null);
        out += (m != null) ? m : ch;
    }
    return out.replace(/\S+/g, w => w ? w[0].toUpperCase() + w.slice(1) : w);
}

/**
 * Nombre listo para catalogar: si viene en cirílico/griego, devuelve el nombre LATINIZADO como principal y la
 * grafía original como variante. Si no hay mapa (o ya es latino), lo deja tal cual.
 * @returns {{ nombre: string, alternativos: string[] }}
 */
export function latinizarNombre(nombre) {
    const s = String(nombre || '').trim();
    if (!s) return { nombre: s, alternativos: [] };
    if (RE_MAPEABLE.test(s)) {
        const lat = transliterar(s);
        if (lat && lat !== s) return { nombre: lat, alternativos: [s] };
    }
    return { nombre: s, alternativos: [] };
}
