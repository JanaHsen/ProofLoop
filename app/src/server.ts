import path from "path";
import express from "express";
import session from "express-session";

import { config } from "./config";
import { log } from "./logger";
import { currentUser } from "./auth";
import { sessionStore } from "./session-store";
import { loginRouter } from "./routes/login";
import { productsRouter } from "./routes/products";
import { cartRouter } from "./routes/cart";
import { formRouter } from "./routes/form";
import { debugRouter } from "./routes/debug";

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    name: "proofloop.sid",
    store: sessionStore,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60,
    },
  }),
);

app.use((req, res, next) => {
  res.locals.currentUser = currentUser(req);
  res.locals.activeBugs = Array.from(config.bugs);
  next();
});

app.get("/", (_req, res) => {
  res.render("home");
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(loginRouter);
app.use(productsRouter);
app.use(cartRouter);
app.use(formRouter);
app.use(debugRouter);

app.use((_req, res) => {
  res.status(404).render("not-found", { what: "Page" });
});

app.listen(config.port, () => {
  log.info("sut.listening", {
    port: config.port,
    bugs: Array.from(config.bugs),
  });
});
