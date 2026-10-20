import { describe, expect, it } from "vitest";
import { calculatePrice } from "../src/lib/pricing/calculate";

describe("calculatePrice", () => {
  it("calculates normal slot price", () => {
    expect(calculatePrice(39900, 1000)).toEqual({
      basePricePaise: 39900,
      commissionPaise: 3990,
      totalPaise: 43890,
    });
  });

  it("calculates peak slot price", () => {
    expect(calculatePrice(49900, 1000)).toEqual({
      basePricePaise: 49900,
      commissionPaise: 4990,
      totalPaise: 54890,
    });
  });

  it("rejects invalid base price", () => {
    expect(() => calculatePrice(-1, 1000)).toThrow(
      "Invalid base price",
    );
  });

  it("rejects invalid commission", () => {
    expect(() => calculatePrice(39900, 10001)).toThrow(
      "Invalid commission rate",
    );
  });
});