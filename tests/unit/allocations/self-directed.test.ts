import { describe, expect, it } from "vitest";

import { ownCash, ownShares } from "../../../src/main/allocations/self-directed-rules";

describe("what a member may trade outside their strategies", () => {
  it("counts own shares as what the account holds less what strategies claim", () => {
    expect(ownShares("15", "10")).toBe("5");
    expect(ownShares("10", "10")).toBe("0");
  });

  it("never reports negative own shares when strategies are already short", () => {
    expect(ownShares("7", "10")).toBe("0");
  });

  it("counts own cash as the account's cash less what strategies hold", () => {
    expect(ownCash("75.03", "0.0328")).toBe("74.9972");
    expect(ownCash("10", "25")).toBe("0");
  });
});
