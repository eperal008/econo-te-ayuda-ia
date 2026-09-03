import React from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Kiosk from "./Kiosk";
import Admin from "./admin/Admin";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Kiosk />} />
        <Route path="/admin" element={<Admin />} />
      </Routes>
    </BrowserRouter>
  );
}
