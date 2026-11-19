import { afterEach, describe, expect, it } from "vitest";
import { loadSpeed, saveSpeed, SPEEDS, speedLabel } from "./speed";

afterEach(() => localStorage.clear());

describe("speeds (PRD 4.4.1)", () => {
  it("offers the seven speeds from 0.5x to 2.0x, labelled as in the design", () => {
    expect(SPEEDS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
    expect(SPEEDS.map(speedLabel)).toEqual(["0.5×", "0.75×", "1.0×", "1.25×", "1.5×", "1.75×", "2.0×"]);
  });

  it("remembers the speed for every Book, 1.0x until one is chosen (AC-PLAY-06)", () => {
    expect(loadSpeed()).toBe(1);
    saveSpeed(1.5);
    expect(loadSpeed()).toBe(1.5);
  });

  it("ignores a stored value that is not one of the speeds", () => {
    localStorage.setItem("vocaleaf.speed", "3");
    expect(loadSpeed()).toBe(1);
  });
});
