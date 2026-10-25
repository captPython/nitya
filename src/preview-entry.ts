import { browserStorage } from "./accounts/browser-storage";
import { DEMO_KEY, demoBankKey, localBackend } from "./accounts/local-backend";

export * from "./ui-exports";
export { browserStorage, DEMO_KEY, demoBankKey };

/** The preview always runs the demo: pretend sign-in, everything kept in this browser. */
export const createBackend = () => localBackend(browserStorage());
