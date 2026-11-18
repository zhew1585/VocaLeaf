import { expect } from "vitest";

// Minimal matchers used by the tests, avoiding a jest-dom dependency.
expect.extend({
  toBeDisabled: (el: HTMLButtonElement) => ({ pass: el.disabled, message: () => "expected element to be disabled" }),
  toBeEnabled: (el: HTMLButtonElement) => ({ pass: !el.disabled, message: () => "expected element to be enabled" }),
});

declare module "vitest" {
  interface Assertion {
    toBeDisabled(): void;
    toBeEnabled(): void;
  }
}
