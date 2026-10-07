/**
 * IDIOMA DE UN TEXTO por sus palabras funcionales (artículos, preposiciones, conjunciones), sin IA ni dependencias.
 * Para cuando el fichero no declara su idioma: antes se caía al «es» por defecto y un libro en inglés con capa de texto
 * quedaba en español (7-oct: «Professional Visual Studio 2008», Wrox). Devuelve el código de dos letras si una lengua
 * gana con claridad (suficientes palabras y bastante ventaja sobre la segunda), o null si el texto no da para decidir.
 */
const PALABRAS = {
  es: 'el la los las de del y que en un una por con para es se no al lo como más pero sus este esta entre sobre también fue han',
  en: 'the of and to in is that for it with as was on by be are this from at or an which not have has but were their its',
  fr: 'le la les de des du et que en un une est pour dans par sur au aux ne pas qui ce cette sont avec plus ont été',
  de: 'der die das und den dem des ist nicht ein eine zu mit von auf für sich im auch als bei wird werden sind aus',
  it: 'il lo la gli le di del della che e un una per con non sono nel nella dei delle alla come anche più questo',
  pt: 'o a os as de do da dos das e que em um uma para com não por se mais como ao foi são pelo pela também',
  ca: 'el la els les de del i que en un una per amb no és als pel més com també són aquest aquesta però',
};
const CONJUNTOS = Object.fromEntries(Object.entries(PALABRAS).map(([l, p]) => [l, new Set(p.split(' '))]));

export function idiomaDeTexto(texto, { minimo = 40 } = {}) {
  const palabras = String(texto || '').toLowerCase().match(/\p{L}+/gu) || [];
  if (palabras.length < minimo * 3) return null;
  const muestra = palabras.slice(0, 20000);
  const puntos = Object.fromEntries(Object.keys(CONJUNTOS).map((l) => [l, 0]));
  for (const w of muestra) for (const l in CONJUNTOS) if (CONJUNTOS[l].has(w)) puntos[l]++;
  const orden = Object.entries(puntos).sort((a, b) => b[1] - a[1]);
  const [[primera, p1], [, p2]] = orden;
  // Ganar con claridad: un mínimo de aciertos y al menos 1,5 veces la segunda (es/pt/ca/it comparten muchas).
  if (p1 < minimo || p1 < p2 * 1.5) return null;
  return primera;
}
