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
import { bugOn } from "../config";

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
  // BUG-002 (shared-logic): drop the tax line — taxCents computes to 0, so the
  // page shows "Tax $0.00" and Total == Subtotal. Lives in the shared total
  // path, so /debug/state reports the same wrong numbers (mirror agrees).
  //
  // BRANCH-ONLY (G4 PR regression — DO NOT MERGE): also force this existing BUG-002 tax-drop
  // on for an ordinary PR run that passes no workflow_dispatch `bugs` input. It reuses the SAME
  // shared-logic path (taxCents → 0); it adds no new defect logic. Revert by removing the
  // `FORCE_BUG_002` constant and the `|| FORCE_BUG_002` term to restore env-toggle-gated behaviour.
  const FORCE_BUG_002 = true;
  const taxCents = bugOn("BUG-002") || FORCE_BUG_002 ? 0 : Math.round(subtotalCents * TAX_RATE);
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
  // BUG-001 (route-handler): the checkout route is dead — the submit 404s and no
  // order is ever placed. /debug/state agrees (nothing persisted).
  if (bugOn("BUG-001")) {
    res.status(404).render("not-found", { what: "Page" });
    return;
  }

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

  if (bugOn("BUG-005")) {
    // BUG-005 (state-dependent, session-lifecycle): treat the session as expired
    // at submission. We hold the cart/totals, so we render a plausible inline
    // confirmation — but DESTROY the session and persist NOTHING. Anomalies a
    // thorough tester can catch: the URL never advances to /order/:id (this is
    // the POST /checkout response, no redirect); the fake order id 404s if
    // revisited (never saved); the user is silently logged out (the next authed
    // request bounces to /login). A lazy tester trusting the success screen
    // waves the lost order through.
    const fakeOrderId = nextOrderId(); // consumes an id but saves no order
    req.session.destroy(() => {
      res.render("order", {
        order: {
          id: fakeOrderId,
          username,
          lines: rendered,
          subtotalCents: totals.subtotalCents,
          taxCents: totals.taxCents,
          totalCents: totals.totalCents,
          createdAt: new Date().toISOString(),
        },
        lines: rendered,
        displayTotalCents: totals.totalCents,
      });
    });
    return;
  }

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
  // BUG-004 (render-site): distort ONLY the displayed total at the confirmation
  // render — show the subtotal in the total slot (tax dropped on this page only).
  // Cart/checkout stay correct, so the defect lives purely in presentation.
  // NEVER mutate the stored Order: the record (and /debug/state) must stay
  // correct, or the mirror-vs-page layer-diagnostic collapses.
  const displayTotalCents = bugOn("BUG-004")
    ? order.subtotalCents
    : order.totalCents;
  // Render entirely from the frozen order snapshot — never re-derive line
  // details from the live catalog (single source of truth per the gate).
  res.render("order", { order, lines: order.lines, displayTotalCents });
});
