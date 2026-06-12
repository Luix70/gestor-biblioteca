import { conectarDB, guardarRecurso } from './database.js';
import axios from 'axios';

async function obtenerOcrearEntidad(coleccionNombre, nombre) {
    if (!nombre || nombre.trim() === "") return null;
    const nombreNormalizado = nombre.includes(',') ? nombre.split(',').reverse().map(s => s.trim()).join(' ') : nombre.trim();
    const db = await conectarDB();
    const coleccion = db.collection(coleccionNombre);
    const resultado = await coleccion.findOneAndUpdate(
        { nombre: { $regex: new RegExp(`^${nombreNormalizado}$`, 'i') } },
        { $setOnInsert: { nombre: nombreNormalizado } },
        { upsert: true, returnDocument: 'after' }
    );
    return resultado._id;
}

async function obtenerMetadataPublica(datos) {
    const url = datos.isbn 
        ? `https://www.googleapis.com/books/v1/volumes?q=isbn:${datos.isbn}`
        : `https://www.googleapis.com/books/v1/volumes?q=intitle:"${encodeURIComponent(datos.titulo)}"&maxResults=1`;
    try {
        const res = await axios.get(url);
        if (res.data.items?.[0]) {
            const vol = res.data.items[0].volumeInfo;
            return {
                titulo: vol.title,
                sinopsis: vol.description || "",
                editorial: vol.publisher || "",
                año_edicion: vol.publishedDate ? parseInt(vol.publishedDate.substring(0, 4)) : null,
                isbn: vol.industryIdentifiers?.find(id => id.type.startsWith('ISBN'))?.identifier
            };
        }
    } catch (e) { return {}; }
    return {};
}

export async function procesarCatalogo(datos) {
    const externo = await obtenerMetadataPublica(datos);
    const autores = externo.autores || datos.autores || [];
    const idsAutores = await Promise.all(autores.map(a => obtenerOcrearEntidad('autores', a)));
    const editorialId = await obtenerOcrearEntidad('editoriales', externo.editorial || datos.editorial);

    // ... dentro de procesarCatalogo
    const doc = {
        tipo_recurso: 'libro',
        titulo: externo.titulo || datos.titulo || 'Sin título',
        cdu: datos.cdu || '000',
        idioma: datos.idioma || 'es',
        formatos: datos.formatos,
        autores: idsAutores.filter(id => id !== null),
        editorial_id: editorialId,
        sinopsis: externo.sinopsis || datos.sinopsis || "",
        fecha_ingreso: new Date(),
        estado_verificacion: 'pendiente',
        ubicacion: { ambito: 'Sin Ubicación', estanteria: 'E0' }
    };

    // ELIMINACIÓN DEFENSIVA: Solo añadimos el ISBN si existe y no es nulo
    const isbnFinal = externo.isbn || datos.isbn;
    if (isbnFinal && typeof isbnFinal === 'string' && isbnFinal.trim() !== "") {
        doc.isbn = isbnFinal;
    }

    return await guardarRecurso(doc);
}