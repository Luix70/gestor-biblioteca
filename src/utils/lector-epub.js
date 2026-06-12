import { EPub } from "epub";
import * as cheerio from "cheerio";
import fs from 'fs/promises';

export async function extraerMetadatosEpub(rutaArchivo) {
    return new Promise((resolve, reject) => {
        const epub = new EPub(rutaArchivo);
        epub.on("end", async () => {
            try {
                const opfData = await fs.readFile(epub.opfPath, "utf-8");
                const $ = cheerio.load(opfData, { xmlMode: true });
                resolve({
                    titulo: $('dc\\:title').text(),
                    autores: $('dc\\:creator').map((i, el) => $(el).text()).get(),
                    isbn: $('dc\\:identifier[opf\\:scheme="ISBN"]').text() || null,
                    editorial: $('dc\\:publisher').text(),
                    sinopsis: $('dc\\:description').text()
                });
            } catch (err) { reject(err); }
        });
        epub.on("error", reject);
        epub.parse();
    });
}