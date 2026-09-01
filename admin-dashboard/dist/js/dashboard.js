"use strict";

document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('product-table-body')) {
    return;
  }
  const apiKey = localStorage.getItem('admin-api-key');
  if (!apiKey) {
    window.location.href = 'login.html';
    return;
  }
  const API_BASE_URL = 'https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com';
  const apiHeaders = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey
  };
  const productTableBody = document.getElementById('product-table-body');
  const addProductForm = document.getElementById('add-product-form');
  const editProductModal = document.getElementById('edit-product-modal');
  const editProductForm = document.getElementById('edit-product-form');
  const saveEditButton = document.getElementById('save-edit-button');
  const imagePreviewContainer = document.getElementById('edit-image-preview-container');
  const imagePreview = document.getElementById('edit-image-preview');
  const removeImageButton = document.getElementById('remove-image-button');
  const imageUploadContainer = document.getElementById('edit-image-upload-container');
  const restartBotButton = document.getElementById('restart-bot-button');
  const handleImageUpload = async fileInput => {
    if (!fileInput.files || fileInput.files.length === 0) {
      return null;
    }
    const file = fileInput.files[0];
    const formData = new FormData();
    formData.append('ad_image', file);
    try {
      const response = await fetch("".concat(API_BASE_URL, "/api/admin/upload-image"), {
        method: 'POST',
        headers: {
          'x-api-key': apiKey
        },
        body: formData
      });
      if (!response.ok) throw new Error('Image upload failed on the server.');
      const result = await response.json();
      return result.imageUrl;
    } catch (error) {
      alert("Error: Image upload failed.");
      throw error;
    }
  };
  const loadProducts = async () => {
    try {
      const response = await fetch("".concat(API_BASE_URL, "/api/admin/products"), {
        headers: {
          'x-api-key': apiKey
        }
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Failed to fetch products');
      const products = await response.json();
      productTableBody.innerHTML = '';
      if (products.length === 0) {
        productTableBody.innerHTML = '<tr><td colspan="5" class="text-center p-4">No products found. Use the form above to add one.</td></tr>';
        return;
      }
      products.forEach(product => {
        const row = document.createElement('tr');
        row.dataset.product = JSON.stringify(product);
        row.innerHTML = " \n                    <td data-label=\"ID\">".concat(product.id, "</td> \n                    <td data-label=\"Name (ES)\">").concat(product.name_es || '', "</td> \n                    <td data-label=\"Category\">").concat(product.category || '', "</td> \n                    <!-- <td data-label=\"Brand\">").concat(product.brand || '', "</td> --> \n                    <td data-label=\"Aisle\">").concat(product.aisle || '', "</td> \n                    <td class=\"actions-cell\"> \n                        <div class=\"buttons right nowrap\"> \n                            <button class=\"button small blue edit-button\" type=\"button\" title=\"Edit\"><span class=\"icon\"><i class=\"mdi mdi-pencil\"></i></span></button> \n                            <button class=\"button small red delete-button\" type=\"button\" title=\"Delete\"><span class=\"icon\"><i class=\"mdi mdi-trash-can\"></i></span></button> \n                        </div> \n                    </td>");
        productTableBody.appendChild(row);
      });
    } catch (error) {
      productTableBody.innerHTML = "<tr><td colspan=\"5\" class=\"text-center p-4 text-red-500\">Error loading products: ".concat(error.message, "</td></tr>");
    }
  };
  const openEditModal = product => {
    for (const key in product) {
      if (editProductForm.elements[key]) {
        editProductForm.elements[key].value = product[key] || '';
      }
    }
    const currentImageUrl = product.ad_offer_image_url;
    if (currentImageUrl) {
      imagePreview.src = currentImageUrl;
      imagePreviewContainer.style.display = 'block';
      imageUploadContainer.style.display = 'none';
    } else {
      imagePreview.src = '';
      imagePreviewContainer.style.display = 'none';
      imageUploadContainer.style.display = 'block';
    }
    const fileInput = editProductForm.querySelector('input[name="ad_image_file"]');
    if (fileInput) fileInput.value = '';
    editProductModal.style.display = 'block';
  };
  const closeAllModals = () => {
    document.querySelectorAll('.modal').forEach(mod => {
      mod.style.display = 'none';
    });
  };
  const deleteProduct = async productId => {
    try {
      const response = await fetch("".concat(API_BASE_URL, "/api/admin/products/").concat(productId), {
        method: 'DELETE',
        headers: {
          'x-api-key': apiKey
        }
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Failed to delete product');
      loadProducts();
    } catch (error) {
      alert("Error deleting product: ".concat(error.message));
    }
  };
  if (addProductForm) addProductForm.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const fileInput = addProductForm.querySelector('input[name="ad_image_file"]');
      const newImageUrl = await handleImageUpload(fileInput);
      const formData = new FormData(addProductForm);
      const productData = Object.fromEntries(formData.entries());
      delete productData.ad_image_file;
      if (newImageUrl) productData.ad_offer_image_url = newImageUrl;
      const response = await fetch("".concat(API_BASE_URL, "/api/admin/products"), {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify(productData)
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Failed to add product');
      addProductForm.reset();
      loadProducts();
    } catch (error) {
      if (error.message.includes('Failed to add product')) alert("Error adding product: ".concat(error.message));
    }
  });
  if (saveEditButton) saveEditButton.addEventListener('click', async () => {
    try {
      const fileInput = editProductForm.querySelector('input[name="ad_image_file"]');
      const newImageUrl = await handleImageUpload(fileInput);
      const formData = new FormData(editProductForm);
      const productData = Object.fromEntries(formData.entries());
      const productId = productData.id;
      delete productData.ad_image_file;
      if (newImageUrl) productData.ad_offer_image_url = newImageUrl;
      const response = await fetch("".concat(API_BASE_URL, "/api/admin/products/").concat(productId), {
        method: 'PUT',
        headers: apiHeaders,
        body: JSON.stringify(productData)
      });
      if (!response.ok) throw new Error((await response.json()).error || 'Failed to update product');
      closeAllModals();
      loadProducts();
    } catch (error) {
      if (error.message.includes('Failed to update product')) alert("Error updating product: ".concat(error.message));
    }
  });
  if (productTableBody) productTableBody.addEventListener('click', e => {
    const targetButton = e.target.closest('button');
    if (!targetButton) return;
    const row = targetButton.closest('tr');
    const product = JSON.parse(row.dataset.product);
    if (targetButton.classList.contains('delete-button')) {
      if (confirm("Are you sure you want to delete \"".concat(product.name_es, "\" (ID: ").concat(product.id, ")?"))) {
        deleteProduct(product.id);
      }
    }
    if (targetButton.classList.contains('edit-button')) {
      openEditModal(product);
    }
  });
  if (removeImageButton) removeImageButton.addEventListener('click', () => {
    imagePreviewContainer.style.display = 'none';
    imagePreview.src = '';
    editProductForm.elements['ad_offer_image_url'].value = '';
    imageUploadContainer.style.display = 'block';
  });
  if (restartBotButton) restartBotButton.addEventListener('click', async () => {
    if (confirm("Are you sure you want to restart the bot? This will cause a brief interruption of service (about 30-60 seconds).")) {
      try {
        const response = await fetch("".concat(API_BASE_URL, "/api/admin/restart-bot"), {
          method: 'POST',
          headers: {
            'x-api-key': apiKey
          }
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || 'Failed to send restart command.');
        }
        alert(result.message);
      } catch (error) {
        alert("Error: ".concat(error.message));
      }
    }
  });
  document.querySelectorAll('.--jb-modal-close').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      closeAllModals();
    });
  });
  loadProducts();
});