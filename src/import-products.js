const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const axios = require('axios');
const FormData = require('form-data');

// Configuration
const csvFilePath = path.resolve(__dirname, '..', '1-19 store info and more_updated.csv');
const imageFolderPath = 'C:\\Documents\\Agentic AI\\1. Agentic AI\\2. Capriteayuda\\kiosk-demo\\src\\images';
const apiUrl = 'https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com/import-products';
const allowedCategories = [
    'limpiadores multiusos liquidos',
    'desinfectantes liquidos',
    'limpiadores con cloro',
    'limpiadores de bano inodoros',
    'jabones de barra',
    'shampoo y acondicionadores',
    'cuidado de bebe - wipes',
    'toallas sanitarias',
    'vitaminas y suplementos',
    'mochilas escolares',
    'herramientas y ferreteria',
    'comida para mascotas'
];
const pricing = {
    'limpiadores multiusos liquidos': { regular: 7.99, offer: 6.49 },
    'desinfectantes liquidos': { regular: 8.99, offer: 7.29 },
    'limpiadores con cloro': { regular: 5.99, offer: 4.79 },
    'limpiadores de bano inodoros': { regular: 6.99, offer: 5.59 },
    'jabones de barra': { regular: 3.99, offer: 3.19 },
    'shampoo y acondicionadores': { regular: 9.99, offer: 8.49 },
    'cuidado de bebe - wipes': { regular: 12.99, offer: 10.99 },
    'toallas sanitarias': { regular: 7.49, offer: 6.29 },
    'vitaminas y suplementos': { regular: 14.99, offer: 12.99 },
    'mochilas escolares': { regular: 24.99, offer: 21.99 },
    'herramientas y ferreteria': { regular: 19.99, offer: 16.99 },
    'comida para mascotas': { regular: 15.99, offer: 13.99 }
};

async function importProducts() {
    try {
        // Check script filename
        if (process.argv[1].includes('import-deals.js')) {
            console.warn('Warning: You are running "import-deals.js". Ensure the script is named "import-products.js" to avoid confusion.');
        }

        console.log('CSV File Path:', csvFilePath);
        console.log('Image Folder Path:', imageFolderPath);

        // Verify CSV file exists
        if (!fs.existsSync(csvFilePath)) {
            throw new Error(`CSV file does not exist: ${csvFilePath}`);
        }

        // Verify image folder exists
        if (!fs.existsSync(imageFolderPath)) {
            throw new Error(`Image folder does not exist: ${imageFolderPath}`);
        }

        // List images in folder for debugging
        const images = fs.readdirSync(imageFolderPath);
        console.log('Images in folder:', images);

        // Read and parse CSV
        const productsByCategory = {};
        const parser = fs.createReadStream(csvFilePath).pipe(parse({ columns: true, skip_empty_lines: true }));

        // Collect all products for each category
        for await (const row of parser) {
            const category = row['Categoría'];
            if (allowedCategories.includes(category)) {
                if (!productsByCategory[category]) {
                    productsByCategory[category] = [];
                }
                productsByCategory[category].push(row);
            }
        }

        // Prepare form data and track product counts
        const formData = new FormData();
        let productIndex = 0;
        const validProducts = [];
        const categoryProductCounts = {};

        for (const category of allowedCategories) {
            const products = productsByCategory[category] || [];
            const validCategoryProducts = [];

            // Iterate through all products to find up to 6 with images
            for (const [index, product] of products.entries()) {
                if (validCategoryProducts.length >= 6) break;

                const productData = {
                    productName_en: `${product.Marca} ${category.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}`,
                    productName_es: `${product["Categoría coloquial (PR)"]} ${product.Marca}`,
                    productDescription_en: `SKU: ${category.replace(/\s/g, "-")}-${validCategoryProducts.length + 1}`,
                    productDescription_es: `SKU: ${category.replace(/\s/g, "-")}-${validCategoryProducts.length + 1}`,
                    additionalInfo_en: `Regular Price: $${pricing[category].regular.toFixed(2)}`,
                    additionalInfo_es: `Precio Regular: $${pricing[category].regular.toFixed(2)}`,
                    price: pricing[category].offer.toFixed(2),
                    brand_en: product.Marca,
                    brand_es: product.Marca,
                    category: category,
                    name_en: `${product.Marca} ${category.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}`,
                    name_es: `${product["Categoría coloquial (PR)"]} ${product.Marca}`,
                    location_en: `${product.Pasillo}, ${product["Ubicación según entrada principal"]}`,
                    location_es: `${product.Pasillo}, ${product["Ubicación según entrada principal"]}`,
                    brand: product.Marca
                };

                // Check for image (.jpg or .png)
                let imagePath = path.join(imageFolderPath, `${category}_${product.Marca}.jpg`);
                let imageExt = '.jpg';
                if (!fs.existsSync(imagePath)) {
                    imagePath = path.join(imageFolderPath, `${category}_${product.Marca}.png`);
                    imageExt = '.png';
                }

                if (fs.existsSync(imagePath)) {
                    console.log(`Found image: ${category}_${product.Marca}${imageExt}`);
                    validCategoryProducts.push({ productData, imagePath, imageExt });
                } else {
                    console.warn(`Image not found for ${category}_${product.Marca} (tried .jpg and .png)`);
                }
            }

            // Store product count for this category
            categoryProductCounts[category] = validCategoryProducts.length;

            // Add valid products to formData
            validCategoryProducts.forEach(({ productData, imagePath, imageExt }) => {
                formData.append(`products[${productIndex}]`, JSON.stringify(productData));
                formData.append(`images`, fs.createReadStream(imagePath), `${category}_${productData.brand}${imageExt}`);
                validProducts.push(productData);
                productIndex++;
            });
        }

        if (validProducts.length === 0) {
            throw new Error('No valid products with images found to import');
        }

        // Log product counts for each category
        console.log('Product counts per category:', categoryProductCounts);

        // Add category product counts to formData
        formData.append('categoryProductCounts', JSON.stringify(categoryProductCounts));

        console.log(`Uploading ${validProducts.length} products...`);

        // Send to backend
        const response = await axios.post(apiUrl, formData, {
            headers: formData.getHeaders()
        });

        console.log('Products imported successfully:', response.data);
    } catch (error) {
        console.error('Error importing products:', error.response ? error.response.data : error.message);
    }
}

importProducts();