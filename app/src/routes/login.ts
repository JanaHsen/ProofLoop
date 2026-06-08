import { Router } from "express";
import { findUser } from "../store";

export const loginRouter = Router();

loginRouter.get("/login", (req, res) => {
  if (req.session.username) {
    res.redirect("/");
    return;
  }
  const next = typeof req.query.next === "string" ? req.query.next : "";
  res.render("login", { error: null, next, username: "" });
});

loginRouter.post("/login", (req, res) => {
  const username = String(req.body.username ?? "").trim();
  const password = String(req.body.password ?? "");
  const next = String(req.body.next ?? "");

  const user = findUser(username, password);
  if (!user) {
    res.status(401).render("login", {
      error: "Invalid username or password.",
      next,
      username,
    });
    return;
  }

  req.session.regenerate((err) => {
    if (err) {
      res.status(500).render("login", {
        error: "Could not start session.",
        next,
        username,
      });
      return;
    }
    req.session.username = user.username;
    req.session.cart = [];
    const target = next && next.startsWith("/") ? next : "/";
    res.redirect(target);
  });
});

loginRouter.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});
