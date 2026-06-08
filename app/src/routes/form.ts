import { Router } from "express";

export const formRouter = Router();

interface FormValues {
  name: string;
  email: string;
  amount: string;
}

interface FormErrors {
  name?: string;
  email?: string;
  amount?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(values: FormValues): FormErrors {
  const errors: FormErrors = {};
  if (values.name.trim().length === 0) {
    errors.name = "Name is required.";
  }
  if (!EMAIL_RE.test(values.email.trim())) {
    errors.email = "Email must be a valid address.";
  }
  const amountNum = Number(values.amount);
  if (
    values.amount.trim().length === 0 ||
    !Number.isFinite(amountNum) ||
    !Number.isInteger(amountNum) ||
    amountNum <= 0
  ) {
    errors.amount = "Amount must be a positive whole number.";
  }
  return errors;
}

formRouter.get("/form", (_req, res) => {
  res.render("form", {
    values: { name: "", email: "", amount: "" },
    errors: {},
    submitted: false,
  });
});

formRouter.post("/form", (req, res) => {
  const values: FormValues = {
    name: String(req.body.name ?? ""),
    email: String(req.body.email ?? ""),
    amount: String(req.body.amount ?? ""),
  };
  const errors = validate(values);
  if (Object.keys(errors).length > 0) {
    res.status(400).render("form", { values, errors, submitted: false });
    return;
  }
  res.render("form", { values, errors: {}, submitted: true });
});
