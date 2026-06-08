import "express-session";
import type { CartLine } from "./store";

declare module "express-session" {
  interface SessionData {
    username?: string;
    cart?: CartLine[];
  }
}
