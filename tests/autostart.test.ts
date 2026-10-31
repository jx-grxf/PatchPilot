import { describe, expect, it } from "vitest";
import { defaultMlxModel, planAutostart } from "../src/core/autostart.js";
import { supportsMlx } from "../src/core/localRuntimes.js";

const baseUrl = "http://127.0.0.1:1234/v1";
const findBinary = async () => "/usr/local/bin/mlx_lm.server";

describe("planAutostart", () => {
  it("uses a running server that already serves the model", async () => {
    const plan = await planAutostart({ baseUrl, model: "qwen", listModels: async () => ["qwen"], findBinary });
    expect(plan).toEqual({ kind: "use-existing", baseUrl, model: "qwen" });
  });

  it("can be turned off", async () => {
    const plan = await planAutostart({ baseUrl, model: "qwen", env: { PATCHPILOT_AUTOSTART: "0" }, listModels: async () => null, findBinary });
    expect(plan.kind).toBe("skip");
  });

  it.runIf(supportsMlx())("starts MLX with the requested repo when nothing serves it", async () => {
    const plan = await planAutostart({ baseUrl, model: "mlx-community/Some-Model-4bit", env: {}, listModels: async () => null, findBinary });
    expect(plan).toEqual({ kind: "start-mlx", model: "mlx-community/Some-Model-4bit", binary: "/usr/local/bin/mlx_lm.server" });
  });

  it.runIf(supportsMlx())("falls back to the default MLX model for a name only another server knows", async () => {
    const plan = await planAutostart({ baseUrl, model: "bonsai-27b-mlx", env: {}, listModels: async () => ["embed"], findBinary });
    expect(plan).toMatchObject({ kind: "start-mlx", model: defaultMlxModel });
  });

  it.runIf(supportsMlx())("says so when mlx_lm is missing", async () => {
    const plan = await planAutostart({ baseUrl, model: "x/y", env: {}, listModels: async () => null, findBinary: async () => null });
    expect(plan).toMatchObject({ kind: "skip" });
  });
});
