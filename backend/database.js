const { Pool } = require("pg");
const fs = require("fs");
const { parse } = require("csv-parse");

console.log("Starting database.js execution...");

// Connect to Postgres
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

(async () => {
    const client = await pool.connect();
    try {
        console.log("Connected to Postgres database for initialization.");

        // Schema Creation
        await client.query(`
            CREATE TABLE IF NOT EXISTS store_info (
                type TEXT PRIMARY KEY,
                details TEXT
            )
        `);
        console.log("Ensured store_info table exists.");

        await client.query(`DROP TABLE IF EXISTS deals;`);
        console.log("Dropped existing deals table (if any).");

        await client.query(`
            CREATE TABLE deals (
                id SERIAL PRIMARY KEY,
                productName_en TEXT NOT NULL,
                productName_es TEXT NOT NULL,
                productDescription_en TEXT,
                productDescription_es TEXT,
                additionalInfo_en TEXT,
                additionalInfo_es TEXT,
                price REAL NOT NULL,
                image TEXT,
                brand_en TEXT,
                brand_es TEXT
            )
        `);
        console.log("Created deals table.");

        await client.query(`DROP TABLE IF EXISTS products;`);
        console.log("Dropped existing products table (if any).");

        await client.query(`
            CREATE TABLE products (
                id SERIAL PRIMARY KEY,
                name_en TEXT,
                name_es TEXT,
                location_en TEXT,
                location_es TEXT,
                category TEXT,
                brand TEXT,
                image TEXT
            )
        `);
        console.log("Created products table.");

        // Insert store info
        const storeInfoData = [
            ["store_hours", "Monday-Saturday 9 AM - 9 PM, Sunday 10 AM - 6 PM|es:Lunes-Sábado 9 AM - 9 PM, Domingo 10 AM - 6 PM"],
            ["bathroom", "Located at the back of the store, near the customer service desk|es:Ubicado al fondo de la tienda, cerca del mostrador de servicio al cliente"],
            ["returns", "Returns are handled at the customer service desk in the front|es:Las devoluciones se manejan en el mostrador de servicio al cliente en la parte frontal"],
            ["jobs", "Apply online at our website or visit the customer service desk|es:Solicita en línea en nuestro sitio web o visita el mostrador de servicio al cliente"]
        ];
        for (const [type, details] of storeInfoData) {
            await client.query("INSERT INTO store_info (type, details) VALUES ($1, $2) ON CONFLICT (type) DO UPDATE SET details = $2", [type, details]);
        }
        console.log("Inserted/Replaced store info data.");

        // Insert sample deals
        const dealsData = [
            ["Sample Product EN", "Producto Ejemplo ES", "Description EN", "Descripción ES", "", "", 19.99, "", "Brand EN", "Marca ES"],
            ["Another Product EN", "Otro Producto ES", "Desc EN", "Desc ES", "", "", 29.99, "", "Brand EN", "Marca ES"]
        ];
        let dealsInserted = 0;
        for (const deal of dealsData) {
            await client.query(
                "INSERT INTO deals (productName_en, productName_es, productDescription_en, productDescription_es, additionalInfo_en, additionalInfo_es, price, image, brand_en, brand_es) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
                deal
            );
            dealsInserted++;
        }
        console.log(`Inserted ${dealsInserted} sample deals.`);

        // Load products from CSV
        const csvFilePath = "1-19 store info and more.csv";
        let productCount = 0;

        if (fs.existsSync(csvFilePath)) {
            console.log(`CSV file found at ${csvFilePath}. Loading products...`);
            const stream = fs.createReadStream(csvFilePath).pipe(parse({ delimiter: ",", from_line: 2 }));
            for await (const row of stream) {
                console.log("Raw row:", row); // Add this line
                const pasillo = row[0]?.trim();
                const lado = row[1]?.trim();
                const categoria = row[2]?.trim();
                const name_es = row[3]?.trim();
                const marca = row[4]?.trim() || "";
                const area = row[5]?.trim();
                const ubicacion_principal = row[6]?.trim();
                const ubicacion_trasera = row[7]?.trim();

                if (!pasillo || !categoria || !name_es) {
                    console.warn("Skipping CSV row due to missing data:", row);
                    continue;
                }

                const name_en = marca && !["Variedad", "Genéricos", "Variadas"].includes(marca) ? `${marca} ${categoria}` : categoria;
                const location_en = `Aisle ${pasillo}${lado ? ", Side " + lado : ""}${area ? ", " + area : ""}${ubicacion_principal ? ", " + ubicacion_principal : ""}`.trim();
                const location_es = `Pasillo ${pasillo}${lado ? ", Lado " + lado : ""}${area ? ", " + area : ""}${ubicacion_trasera ? ", " + ubicacion_trasera : ""}`.trim();

                await client.query(
                    "INSERT INTO products (name_en, name_es, location_en, location_es, category, brand) VALUES ($1, $2, $3, $4, $5, $6)",
                    [name_en, name_es, location_en, location_es, categoria, marca]
                );
                productCount++;
            }
            console.log(`Finished loading ${productCount} products from CSV.`);
        } else {
            console.warn(`CSV file not found at ${csvFilePath}. Products table will be empty.`);
        }
    } catch (err) {
        console.error("Error initializing database:", err.message);
    } finally {
        client.release();
        await pool.end();
        console.log("Database initialization complete.");
    }
})();