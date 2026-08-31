import type { AuthenticatedUser } from '../app/identity/contracts/authenticated-user';

declare global {
  namespace Express {
    interface Request {
      /** Set by `FirebaseAuthGuard`. Present on every route that is not `@Public()`. */
      user?: AuthenticatedUser;
    }
  }
}

export {};
