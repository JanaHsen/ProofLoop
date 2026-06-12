import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { SessionData } from "express-session";

import { config } from "../config";
import { sessionStore } from "../session-store";
import { products, allOrders } from "../store";
import { computeTotals } from "./cart";

/**
 * Token-gated debug API — TEST-FIXTURE INFRASTRUCTURE, not one of the four flows.
 *
 * ORACLE HONESTY: GET /debug/state reports the app's ACTUAL current state. When
 * a bug is toggled on it will faithfully report the WRONG totals, the stale
 * session, etc. — exactly what the app produces. It is a DIAGNOSIS MIRROR, NOT
 * the answer key. `fixtures/bug-ledger.yaml` remains the sole verdict oracle.
 *
 * DEFAULT-DENY: if PROOFLOOP_DEBUG_TOKEN is unset/empty, every /debug/* route
 * 404s as though it does not exist. When the token is set, each request must
 * carry a matching `X-Debug-Token` header or it also 404s — the endpoint's
 * existence is never leaked, and a wrong token is indistinguishable from a
 * missing route.
 *
 * SEPARATE-PROCESS ACCESS: state is read straight from the session store (not
 * req.session) because the grading harness runs in its own process with no
 * shared cookie jar, so it must read/expire sessions it never created.
 */
export const debugRouter = Router();

function notFound(res: Response): void {
  // Same response the catch-all 404 produces, so a disabled/forbidden /debug
  // path is byte-for-byte indistinguishable from any non-existent page.
  res.status(404).render("not-found", { what: "Page" });
}

// Gate: applies to every path under /debug.
debugRouter.use("/debug", (req: Request, res: Response, next: NextFunction) => {
  if (!config.debugToken) {
    notFound(res); // feature disabled
    return;
  }
  if (req.get("X-Debug-Token") !== config.debugToken) {
    notFound(res); // missing or wrong token
    return;
  }
  next();
});

type StoredSessions =
  | SessionData[]
  | { [sid: string]: SessionData }
  | null
  | undefined;

// MemoryStore.all() yields a { sid: session } map; normalise to entries and
// tolerate the array shape other stores may return.
function sessionEntries(stored: StoredSessions): Array<[string, SessionData]> {
  if (!stored) return [];
  if (Array.isArray(stored)) {
    return stored.map((s, i) => [String(i), s] as [string, SessionData]);
  }
  return Object.entries(stored);
}

// GET /debug/state — JSON mirror of the app's actual current state.
debugRouter.get("/debug/state", (_req, res) => {
  sessionStore.all((err, stored) => {
    if (err) {
      res.status(500).json({ error: "session store read failed" });
      return;
    }
    const sessions = sessionEntries(stored as StoredSessions).map(
      ([sid, data]) => {
        const lines = data.cart ?? [];
        const { rendered, totals } = computeTotals(lines);
        return {
          sid,
          username: data.username ?? null,
          cart: rendered,
          subtotalCents: totals.subtotalCents,
          taxCents: totals.taxCents,
          totalCents: totals.totalCents,
        };
      },
    );

    res.json({
      note:
        "ACTUAL state mirror — reflects bugs/mutations when toggled on; " +
        "NOT the verdict oracle. fixtures/bug-ledger.yaml is the answer key.",
      activeFlags: Array.from(config.bugs),
      products,
      sessions,
      orders: allOrders(),
    });
  });
});

// POST /debug/expire-session — destroy session(s) for manual verification.
// Optional `username` (query or form body); with no username, destroy ALL.
debugRouter.post("/debug/expire-session", (req, res) => {
  const raw =
    (typeof req.query.username === "string" && req.query.username) ||
    (typeof req.body?.username === "string" && req.body.username) ||
    "";
  const username = raw.trim().length > 0 ? raw.trim() : undefined;

  sessionStore.all((err, stored) => {
    if (err) {
      res.status(500).json({ error: "session store read failed" });
      return;
    }
    const targets = sessionEntries(stored as StoredSessions).filter(
      ([, data]) => username === undefined || data.username === username,
    );

    if (targets.length === 0) {
      res.json({ matched: 0, destroyed: [], username: username ?? null });
      return;
    }

    const destroyed: string[] = [];
    let remaining = targets.length;
    targets.forEach(([sid, data]) => {
      sessionStore.destroy(sid, (destroyErr) => {
        if (!destroyErr) destroyed.push(data.username ?? sid);
        remaining -= 1;
        if (remaining === 0) {
          res.json({
            matched: targets.length,
            destroyed,
            username: username ?? null,
          });
        }
      });
    });
  });
});
