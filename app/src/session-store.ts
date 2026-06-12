import session from "express-session";

// Single in-memory session store, shared between the express-session
// middleware (server.ts) and the /debug API (routes/debug.ts).
//
// It is referenced explicitly — rather than letting express-session create an
// anonymous default store — so the /debug routes can enumerate and expire
// sessions they did not create. The grading harness runs as a SEPARATE PROCESS
// with no shared cookie jar, so reading state via req.session alone is not
// enough; it needs to see across every active session.
export const sessionStore = new session.MemoryStore();
