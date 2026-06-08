import { Router } from "express";
import { products, findProduct } from "../store";
import { requireAuth } from "../auth";

export const productsRouter = Router();

productsRouter.get("/products", requireAuth, (_req, res) => {
  res.render("products", { products });
});

productsRouter.get("/products/:id", requireAuth, (req, res) => {
  const product = findProduct(req.params.id);
  if (!product) {
    res.status(404).render("not-found", { what: "Product" });
    return;
  }
  res.render("product", { product });
});

productsRouter.post("/cart/add", requireAuth, (req, res) => {
  const productId = String(req.body.productId ?? "");
  const qtyRaw = String(req.body.quantity ?? "1");
  const quantity = Number.parseInt(qtyRaw, 10);

  const product = findProduct(productId);
  if (!product) {
    res.status(400).render("not-found", { what: "Product" });
    return;
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    res.status(400).render("products", {
      products,
      error: "Quantity must be a positive whole number.",
    });
    return;
  }

  if (!req.session.cart) req.session.cart = [];
  const existing = req.session.cart.find((line) => line.productId === productId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    req.session.cart.push({ productId, quantity });
  }

  res.redirect("/cart");
});
