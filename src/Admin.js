import React, { useState, useEffect } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
// Assuming i18n setup is done elsewhere and imported if needed globally
// import i18n from "i18next";
import "./Dashboard.css"; // Ensure this points to your CSS file

function Admin() {
    const { t } = useTranslation();
    const [password, setPassword] = useState("");
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [products, setProducts] = useState([]);
    const [categories, setCategories] = useState([]);
    const [productForm, setProductForm] = useState({
        name_en: "",
        name_es: "",
        location_en: "",
        location_es: "",
        category: "",
        brand: "",
        image: null
    });
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    const navigate = useNavigate();

    // Keep your allowedCategories list
    const allowedCategories = [
        "limpiadores multiusos liquidos", "desinfectantes liquidos", "limpiadores con cloro",
        "limpiadores de bano inodoros", "jabones de barra", "shampoo y acondicionadores",
        "cuidado de bebe - wipes", "toallas sanitarias", "vitaminas y suplementos",
        "mochilas escolares", "herramientas y ferreteria", "comida para mascotas"
    ];

    useEffect(() => {
        if (isAuthenticated) {
            fetchProducts();
            fetchCategories();
        }
    }, [isAuthenticated]);

    const fetchProducts = async () => {
        try {
            // Use your actual API endpoint
            const response = await axios.get("https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com/products");
            setProducts(response.data);
        } catch (err) {
            console.error("Error fetching products:", err);
            setError(t("errorFetchingProducts"));
        }
    };

    const fetchCategories = async () => {
        try {
             // Use your actual API endpoint
            const response = await axios.get("https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com/categories");
            // Filter categories based on the allowed list fetched from the backend
            setCategories(response.data.filter(cat => allowedCategories.includes(cat)));
        } catch (err) {
            console.error("Error fetching categories:", err);
            setError(t("errorFetchingCategories"));
        }
    };

    const handlePasswordSubmit = (e) => {
        e.preventDefault();
        // IMPORTANT: Hardcoding passwords is very insecure. Use a proper auth system.
        if (password === "admin123") {
            setIsAuthenticated(true);
            setError(null); // Clear error on successful login
        } else {
            setError(t("incorrectPassword"));
        }
    };

    const handleProductInputChange = (e) => {
        const { name, value } = e.target;
        setProductForm({ ...productForm, [name]: value });
    };

    const handleProductImageChange = (e) => {
        setProductForm({ ...productForm, image: e.target.files[0] });
    };

    const handleProductSubmit = async (e) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);

        // Basic frontend validation
        if (!productForm.name_en || !productForm.name_es || !productForm.location_en || !productForm.location_es || !productForm.category) {
             setError(t("fillRequiredFields")); // Add a translation for this
             return;
        }

        const formData = new FormData();
        formData.append("name_en", productForm.name_en);
        formData.append("name_es", productForm.name_es);
        formData.append("location_en", productForm.location_en);
        formData.append("location_es", productForm.location_es);
        formData.append("category", productForm.category);
        formData.append("brand", productForm.brand || ""); // Send empty string if no brand
        if (productForm.image) {
            formData.append("image", productForm.image);
        }

        try {
             // Use your actual API endpoint
            const response = await axios.post("https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com/products", formData, {
                headers: { "Content-Type": "multipart/form-data" }
            });
            console.log("Product added successfully:", response.data);
            // Reset form, clear file input visually (though state is reset)
            e.target.reset(); // Resets the form fields including file input
            setProductForm({
                name_en: "", name_es: "", location_en: "", location_es: "",
                category: "", brand: "", image: null
            });
            setSuccess(t("productAdded"));
            fetchProducts(); // Refresh the list
        } catch (err) {
            console.error("Error adding product:", err.response ? err.response.data : err.message);
            setError(t("errorAddingProduct") + ": " + (err.response?.data?.error || err.message));
        }
    };

    const handleProductDelete = async (id) => {
        // Optional: Add a confirmation dialog
        // if (!window.confirm(t('confirmDeleteProduct'))) { // Add translation
        //  return;
        // }
        setError(null);
        setSuccess(null);
        try {
             // Use your actual API endpoint
            await axios.delete(`https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com/products/${id}`);
            setSuccess(t("productDeleted"));
            fetchProducts(); // Refresh the list
        } catch (err) {
            console.error("Error deleting product:", err);
            setError(t("errorDeletingProduct"));
        }
    };

    const handleLogout = () => {
        setIsAuthenticated(false);
        setPassword("");
        // Clear other states if needed
        setProducts([]);
        setCategories([]);
        setError(null);
        setSuccess(null);
        navigate("/"); // Navigate back to home/kiosk page
    };

    // Login Form
    if (!isAuthenticated) {
        return (
            <div className="admin-login-container">
                <div className="admin-login-box">
                    <h2>{t("dashboard")}</h2>
                    <form onSubmit={handlePasswordSubmit} className="admin-login-form">
                        {/* === RE-CHECK THE FIX HERE === */}
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={t("password")}
                            required // NO '>' AFTER THIS LINE
                            className="admin-login-input" // className is listed before />
                        /> {/* Correct self-closing tag */}
                        {/* === END RE-CHECK === */}
                        <button type="submit" className="admin-login-button">{t("login")}</button>
                    </form>
                    {error && <div className="error-message">{error}</div>}
                </div>
            </div>
        );
    }

    // Admin Dashboard (Rest of the component remains the same)
    return (
        <div className="admin-dashboard">
            <div className="dashboard-header">
                <h2>{t("dashboard")}</h2>
                <div className="dashboard-nav">
                    <button onClick={() => navigate("/")} className="nav-button">
                        {t("backToKiosk")}
                    </button>
                    <button onClick={handleLogout} className="nav-button logout-button">
                        {t("logout")}
                    </button>
                </div>
            </div>

            {/* Message Area */}
            {error && <div className="error-message global-message">{error}</div>}
            {success && <div className="success-message global-message">{success}</div>}

            {/* Add Product Section */}
            <div className="admin-section">
                <h3>{t("addProduct")}</h3>
                <form onSubmit={handleProductSubmit} className="product-form">
                    <div className="form-grid">
                        <input
                            type="text" name="name_en" value={productForm.name_en}
                            onChange={handleProductInputChange} placeholder={t("productNameEn")} required
                        />
                        <input
                            type="text" name="name_es" value={productForm.name_es}
                            onChange={handleProductInputChange} placeholder={t("productNameEs")} required
                        />
                        <input
                            type="text" name="location_en" value={productForm.location_en}
                            onChange={handleProductInputChange} placeholder={t("locationEn")} required
                        />
                        <input
                            type="text" name="location_es" value={productForm.location_es}
                            onChange={handleProductInputChange} placeholder={t("locationEs")} required
                        />
                        <select
                            name="category" value={productForm.category}
                            onChange={handleProductInputChange} required
                        >
                            <option value="">{t("selectCategory")}</option>
                            {categories.map((category, index) => (
                                <option key={index} value={category}>{category}</option>
                            ))}
                        </select>
                        <input
                            type="text" name="brand" value={productForm.brand}
                            onChange={handleProductInputChange} placeholder={t("brand")}
                        />
                        <input
                            type="file" name="image" onChange={handleProductImageChange}
                            accept="image/*" className="file-input"
                        />
                        <div className="form-full-width">
                           <button type="submit" className="add-button">{t("add")}</button>
                        </div>
                    </div>
                </form>
            </div>

            {/* Current Products Section */}
            <div className="admin-section">
                <h3>{t("currentProducts")}</h3>
                <div className="products-list">
                    {products.length > 0 ? (
                        products.map((product) => (
                            <div key={product.id} className="product-item">
                                {product.image &&
                                 <img src={product.image} alt={`${product.name_en} / ${product.name_es}`} className="item-image" />
                                }
                                <div className="product-details">
                                    <p className="product-name"><strong>{product.name_en}</strong> / <strong>{product.name_es}</strong></p>
                                    <p><strong>{t("category")}:</strong> {product.category}</p>
                                    <p><strong>{t("locationEn")}:</strong> {product.location_en}</p>
                                    <p><strong>{t("locationEs")}:</strong> {product.location_es}</p>
                                    {product.brand && <p><strong>{t("brand")}:</strong> {product.brand}</p>}
                                </div>
                                <button onClick={() => handleProductDelete(product.id)} className="delete-button">
                                    {t("delete")}
                                </button>
                            </div>
                        ))
                    ) : (
                        <p>{t('noProductsAvailable')}</p> // Add translation
                    )}
                </div>
            </div>

        </div>
    );
}

export default Admin;