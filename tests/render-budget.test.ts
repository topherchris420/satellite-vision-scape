import { describe, expect, test } from "bun:test";
import { countReady } from "../src/lib/shader-warmup";
import { initialBudget, RESOLUTION_STEPS, stepDown, stepUp, tierForRenderer } from "../src/lib/render-budget";
import { buildTree, distantCardPlan, DISTANT_CLUSTERS, type Species } from "../src/lib/vegetation/tree-builder";

describe("the first guess at a tier", () => {
  test("names the hardware that would otherwise spend its first minute freezing", () => {
    expect(tierForRenderer("ANGLE (Qualcomm, Adreno X1-45, OpenGL)")).toBe("low");
    expect(tierForRenderer("ANGLE (Intel, Intel(R) UHD Graphics 620, D3D11)")).toBe("low");
    expect(tierForRenderer("Mali-G78")).toBe("low");
    expect(tierForRenderer("Google SwiftShader")).toBe("low");
  });

  test("gives capable hardware the look it can carry", () => {
    expect(tierForRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070, D3D11)")).toBe("high");
    expect(tierForRenderer("ANGLE (AMD, AMD Radeon RX 7800 XT, D3D11)")).toBe("high");
    expect(tierForRenderer("Apple M3 Max")).toBe("high");
    expect(tierForRenderer("Apple M2")).toBe("medium");
  });

  test("assumes the middle when it cannot tell", () => {
    expect(tierForRenderer("")).toBe("medium");
    expect(tierForRenderer("Some Future GPU 9000")).toBe("medium");
  });
});

describe("responding to the frame rate", () => {
  test("resolution falls first, because that costs no shader rebuild", () => {
    let budget = { tier: "high" as const, step: 0 };
    for (let i = 1; i < RESOLUTION_STEPS.length; i++) {
      budget = stepDown(budget, false) as typeof budget;
      expect(budget.tier).toBe("high");
      expect(budget.step).toBe(i);
    }
  });

  test("once resolution is spent, the tier falls only while it is safe to", () => {
    const floor = { tier: "high" as const, step: RESOLUTION_STEPS.length - 1 };
    expect(stepDown(floor, false)).toEqual(floor);
    const lowered = stepDown(floor, true);
    expect(lowered.tier).toBe("medium");
    expect(lowered.step).toBe(0);
  });

  test("the lowest setting is a floor", () => {
    const floor = { tier: "low" as const, step: RESOLUTION_STEPS.length - 1 };
    expect(stepDown(floor, true)).toEqual(floor);
  });

  test("recovering restores resolution but never raises the tier mid-session", () => {
    const budget = { tier: "medium" as const, step: 2 };
    expect(stepUp(budget)).toEqual({ tier: "medium", step: 1 });
    expect(stepUp({ tier: "medium", step: 0 })).toEqual({ tier: "medium", step: 0 });
  });
});

describe("remembering a device", () => {
  test("a stored budget for the same renderer is reused", () => {
    const stored = JSON.stringify({ renderer: "GPU", tier: "low", step: 1 });
    expect(initialBudget(stored, () => "Apple M3 Max").tier).toBe("low");
  });

  test("anything unreadable falls back to the hardware's guess", () => {
    const probe = () => "Apple M3 Max";
    expect(initialBudget("not json", probe).tier).toBe("high");
    expect(initialBudget(null, probe).tier).toBe("high");
    expect(initialBudget(JSON.stringify({ tier: "ludicrous", step: -9 }), probe).tier).toBe("high");
  });
});

describe("shader warm-up progress", () => {
  test("counts what the driver says is finished, including an empty list", () => {
    const programs = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(countReady(programs, (p) => p.id !== 2)).toEqual({ ready: 2, total: 3 });
    expect(countReady([], () => true)).toEqual({ ready: 0, total: 0 });
  });
});

describe("the distant tree budget", () => {
  test("distant cards are capped, whatever the species' leaf count", () => {
    for (const clusters of [4, 10, 40, 400]) {
      const plan = distantCardPlan(clusters);
      expect(Math.ceil(clusters / plan.step)).toBeLessThanOrEqual(DISTANT_CLUSTERS);
    }
  });

  test("a crown small enough to keep whole is left as it was", () => {
    expect(distantCardPlan(10)).toEqual({ step: 1, scale: 1 });
  });

  test("thinned cards grow, but do not make up all the area, because a crown's clusters overlap", () => {
    const { step, scale } = distantCardPlan(90);
    expect(step).toBe(9);
    expect(scale).toBeGreaterThan(1);
    // Summed card area against the whole crown's. At 1 the trees came out visibly fat and lost their trunks.
    const area = (scale * scale) / step;
    expect(area).toBeGreaterThan(0.3);
    expect(area).toBeLessThan(0.7);
  });

  test("each band is much cheaper than the one nearer the camera", () => {
    const triangles = (band: { wood: { index: { count: number } | null }; leaves: { index: { count: number } | null } }) =>
      ((band.wood.index?.count ?? 0) + (band.leaves.index?.count ?? 0)) / 3;
    for (const species of ["desertOak", "mulga", "ghostGum", "redGum", "gardenGum"] as Species[]) {
      const tree = buildTree(species, 7);
      const [near, far, distant] = [triangles(tree.near), triangles(tree.far), triangles(tree.distant)];
      expect(far).toBeLessThan(near);
      expect(distant).toBeLessThan(far);
      expect(distant).toBeLessThan(150);
    }
  });
});
