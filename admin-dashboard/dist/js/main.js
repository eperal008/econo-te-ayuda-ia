"use strict";

/* Aside & Navbar: dropdowns */

Array.from(document.getElementsByClassName('dropdown')).forEach(elA => {
  elA.addEventListener('click', e => {
    if (e.currentTarget.classList.contains('navbar-item')) {
      e.currentTarget.classList.toggle('active');
    } else {
      const dropdownIcon = e.currentTarget.getElementsByClassName('mdi')[1];
      e.currentTarget.parentNode.classList.toggle('active');
      dropdownIcon.classList.toggle('mdi-plus');
      dropdownIcon.classList.toggle('mdi-minus');
    }
  });
});

/* Aside Mobile toggle */

Array.from(document.getElementsByClassName('mobile-aside-button')).forEach(el => {
  el.addEventListener('click', e => {
    const dropdownIcon = e.currentTarget.getElementsByClassName('icon')[0].getElementsByClassName('mdi')[0];
    document.documentElement.classList.toggle('aside-mobile-expanded');
    dropdownIcon.classList.toggle('mdi-forwardburger');
    dropdownIcon.classList.toggle('mdi-backburger');
  });
});

/* NavBar menu mobile toggle */

Array.from(document.getElementsByClassName('--jb-navbar-menu-toggle')).forEach(el => {
  el.addEventListener('click', e => {
    const dropdownIcon = e.currentTarget.getElementsByClassName('icon')[0].getElementsByClassName('mdi')[0];
    document.getElementById(e.currentTarget.getAttribute('data-target')).classList.toggle('active');
    dropdownIcon.classList.toggle('mdi-dots-vertical');
    dropdownIcon.classList.toggle('mdi-close');
  });
});

/* Modal: open */

Array.from(document.getElementsByClassName('--jb-modal')).forEach(el => {
  el.addEventListener('click', e => {
    const modalTarget = e.currentTarget.getAttribute('data-target');
    document.getElementById(modalTarget).classList.add('active');
    document.documentElement.classList.add('clipped');
  });
});

/* Modal: close */

Array.from(document.getElementsByClassName('--jb-modal-close')).forEach(el => {
  el.addEventListener('click', e => {
    e.currentTarget.closest('.modal').classList.remove('active');
    document.documentElement.classList.remove('is-clipped');
  });
});

/* Notification dismiss */

Array.from(document.getElementsByClassName('--jb-notification-dismiss')).forEach(el => {
  el.addEventListener('click', e => {
    e.currentTarget.closest('.notification').classList.add('hidden');
  });
});

// --- START: CUSTOM LOGIN SCRIPT ---

// We wrap our code in an "if" statement to ensure it only runs on the login page
const loginForm = document.getElementById('login-form');
if (loginForm) {
  const errorP = document.getElementById('login-error');
  // IMPORTANT: Make sure this URL points to your LIVE Heroku backend
  const API_BASE_URL = 'https://your-store-kiosk-api-68f3020ca2d6.herokuapp.com';
  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    errorP.style.display = 'none';
    errorP.textContent = '';
    const formData = new FormData(loginForm);
    const loginData = Object.fromEntries(formData.entries());
    try {
      const response = await fetch("".concat(API_BASE_URL, "/api/auth/login"), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(loginData)
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Login failed.');
      }

      // On successful login, save the key and redirect to the product table
      localStorage.setItem('admin-api-key', result.token);
      window.location.href = 'tables.html';
    } catch (error) {
      errorP.textContent = "Error: ".concat(error.message);
      errorP.style.display = 'block';
    }
  });
}
// --- END: CUSTOM LOGIN SCRIPT ---