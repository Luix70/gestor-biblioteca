import axios from 'axios';


export async function buscarPorCriterios(criterios) {
    try {
        let url = '';
        if (criterios.isbn) {
            // OpenLibrary acepta el ISBN tal cual llegue (sea 10 o 13 dígitos)
            url = `https://openlibrary.org/isbn/${criterios.isbn.replace(/-/g, '')}.json`;
        }
        const res = await axios.get(url);
        const data = criterios.isbn ? res.data : (res.data.docs ? res.data.docs[0] : null);
        
        if (!data) return null;

        // ✅ REFUERZO: A veces el ISBN viene en un campo distinto o como array
        const isbnFinal = data.isbn_13 ? data.isbn_13[0] : (data.isbn ? data.isbn[0] : null);

        return {
            isbn: isbnFinal,
            titulo: data.title,
            editorial: Array.isArray(data.publishers) ? data.publishers[0] : data.publishers,
            año_edicion: parseInt(data.publish_date) || null
        };
    } catch (e) {
        return null;
    }
}
