import { Router } from "express";
import {
  findProduct,
  getOrder,
  nextOrderId,
  saveOrder,
  TAX_RATE,
  type CartLine,
  type Order,
} from "../store";
import { requireAuth } from "../auth";

export const cartRouter = Router();

interface RenderedLine {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

interface Totals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

function computeTotals(lines: CartLine[]): { rendered: RenderedLine[]; totals: Totals } {
  const rendered: RenderedLine[] = [];
  let subtotalCents = 0;
  for (const line of lines) {
    const product = findProduct(line.productId);
    if (!product) continue;
    const lineTotalCents = product.priceCents * line.quantity;
    subtotalCents += lineTotalCents;
    rendered.push({
      productId: product.id,
      name: product.name,
      unitPriceCents: product.priceCents,
      quantity: line.quantity,
      lineTotalCents,
    });
  }
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  const totalCents = subtotalCents + taxCents;
  return { rendered, totals: { subtotalCents, taxCents, totalCents } };
}

cartRouter.get("/cart", requireAuth, (req, res) => {
  const lines = req.session.cart ?? [];
  const { rendered, totals } = computeTotals(lines);
  res.render("cart", { lines: rendered, totals });
});

cartRouter.get("/checkout", requireAuth, (req, res) => {
  const lines = req.session.cart ?? [];
  if (lines.length === 0) {
    res.redirect("/cart");
    return;
  }
  const { rendered, totals } = computeTotals(lines);
  res.render("checkout", { lines: rendered, totals });
});

cartRouter.post("/checkout", requireAuth, (req, res) => {
  const username = req.session.username;
  if (!username) {
    res.redirect("/login");
    return;
  }
  const lines = req.session.cart ?? [];
  if (lines.length === 0) {
    res.redirect("/cart");
    return;
  }
  const { totals } = computeTotals(lines);

  const order: Order = {
    id: nextOrderId(),
    username,
    lines: lines.map((l) => ({ ...l })),
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    createdAt: new Date().toISOString(),
  };
  saveOrder(order);
  req.session.cart = [];
  res.redirect(`/order/${order.id}`);
});

cartRouter.get("/order/:id", requireAuth, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order || order.username !== req.session.username) {
    res.status(404).render("not-found", { what: "Order" });
    return;
  }
  const rendered: RenderedLine[] = [];
  for (const line of order.lines) {
    const product = findProduct(line.productId);
    if (!product) continue;
    rendered.push({
      productId: product.id,
      name: product.name,
      unitPriceCents: product.priceCents,
      quantity: line.quantity,
      lineTotalCents: product.priceCents * line.quantity,
    });
  }
  res.render("order", {
    order,
    lines: rendered,
  });
});
