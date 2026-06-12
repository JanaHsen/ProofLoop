import { bugOn } from "./config";

export interface User {
  username: string;
  password: string;
  displayName: string;
}

export interface Product {
  id: string;
  name: string;
  priceCents: number;
}

export interface CartLine {
  productId: string;
  quantity: number;
}

// Full line snapshot frozen into an Order at checkout. Unlike CartLine (which
// only references a product id), this captures name/unit-price/line-total as
// they were at purchase time, so /order/:id renders entirely from the order
// record and never re-derives from — or silently drops a line against — the
// live catalog.
export interface OrderLine {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  username: string;
  lines: OrderLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  createdAt: string;
}

export const TAX_RATE = 0.1;

export const users: ReadonlyArray<User> = [
  { username: "alice", password: "password123", displayName: "Alice" },
  { username: "bob", password: "hunter2", displayName: "Bob" },
];

const baseProducts: ReadonlyArray<Product> = [
  { id: "p-001", name: "Notebook", priceCents: 499 },
  { id: "p-002", name: "Mechanical Pencil", priceCents: 1299 },
  { id: "p-003", name: "Desk Lamp", priceCents: 2499 },
  { id: "p-004", name: "Coffee Mug", priceCents: 899 },
];

// BUG-006 (visual blind spot): a product whose name is long enough to overflow
// its container on the product page. ADDED (never a rename of an existing item)
// so the four clean flows are untouched — preserves bug isolation. Outcome-based
// testing PASSES this: the name text is present in the DOM, just visually broken.
// Scored as a known blind spot, not a platform defect. See fixtures/bug-ledger.yaml.
const OVERFLOW_PRODUCT: Product = {
  id: "p-005",
  name: "Limited Edition Artisan Hand-Crafted Solid Walnut Executive Desk Organizer with Integrated Wireless Charging Pad, Fountain-Pen Tray, and Hand-Polished Brass Accents",
  priceCents: 1999,
};

export const products: ReadonlyArray<Product> = bugOn("BUG-006")
  ? [...baseProducts, OVERFLOW_PRODUCT]
  : baseProducts;

export function findUser(username: string, password: string): User | undefined {
  return users.find(
    (u) => u.username === username && u.password === password,
  );
}

export function findProduct(id: string): Product | undefined {
  return products.find((p) => p.id === id);
}

const orders = new Map<string, Order>();

export function saveOrder(order: Order): void {
  orders.set(order.id, order);
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}

export function allOrders(): Order[] {
  return Array.from(orders.values());
}

let orderSeq = 0;
export function nextOrderId(): string {
  orderSeq += 1;
  return `O-${String(orderSeq).padStart(5, "0")}`;
}
