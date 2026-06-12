import { Router } from "express";
import {
  findProduct,
  getOrder,
  nextOrderId,
  saveOrder,
  TAX_RATE,
  type CartLine,
  type Order,
  type OrderLine,
} from "../store";
import { requireAuth } from "../auth";

export const cartRouter = Router();

interface Totals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

// Exported so the /debug/state mirror (routes/debug.ts) reports subtotal/tax/
// total via the EXACT same path the flows use — no second, divergable copy.
// Its `rendered` output is also the exact snapshot frozen into an Order.
export function computeTotals(lines: CartLine[]): { rendered: OrderLine[]; totals: Totals } {
  const rendered: OrderLine[] = [];
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
  const { rendered, totals } = computeTotals(lines);

  const order: Order = {
    id: nextOrderId(),
    username,
    lines: rendered,
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
  // Render entirely from the frozen order snapshot — never re-derive line
  // details from the live catalog (single source of truth per the gate).
  res.render("order", { order, lines: order.lines });
});
