const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const path = require("path");

// Verify environment variables
const requiredEnvVars = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error(`Error: Missing environment variables: ${missingVars.join(", ")}`);
    console.error("Please set them using:");
    console.error("set CLOUDINARY_CLOUD_NAME=your-cloud-name");
    console.error("set CLOUDINARY_API_KEY=your-api-key");
    console.error("set CLOUDINARY_API_SECRET=your-api-secret");
    process.exit(1);
}

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const imageDir = "C:\\Documents\\Agentic AI\\1. Agentic AI\\2. Capriteayuda\\Product_Images";
const uploadedImages = {};

if (!fs.existsSync(imageDir)) {
    console.error(`Error: Image directory does not exist: ${imageDir}`);
    process.exit(1);
}

fs.readdir(imageDir, (err, files) => {
    if (err) {
        console.error("Error reading directory:", err.message);
        process.exit(1);
    }

    const pngFiles = files.filter(file => file.endsWith(".png"));
    if (pngFiles.length === 0) {
        console.error("No PNG files found in directory:", imageDir);
        process.exit(1);
    }

    console.log(`Found ${pngFiles.length} PNG files to upload.`);

    let completedUploads = 0;
    pngFiles.forEach(file => {
        const filePath = path.join(imageDir, file);
        const fileName = file.replace(".png", "");
        const [category, ...brandParts] = fileName.split("_");
        const brand = brandParts.join("_"); // Handle brands with underscores

        cloudinary.uploader.upload(
            filePath,
            {
                public_id: `products/${fileName}`,
                folder: "kiosk-deals",
                overwrite: true
            },
            (error, result) => {
                completedUploads++;
                if (error) {
                    console.error(`Error uploading ${file}:`, error.message);
                } else {
                    console.log(`Uploaded ${file}: ${result.secure_url}`);
                    uploadedImages[fileName] = result.secure_url;
                }

                // Save results when all uploads are done
                if (completedUploads === pngFiles.length) {
                    fs.writeFileSync("uploaded_images.json", JSON.stringify(uploadedImages, null, 2));
                    console.log("All uploads complete. URLs saved to uploaded_images.json");
                }
            }
        );
    });
});