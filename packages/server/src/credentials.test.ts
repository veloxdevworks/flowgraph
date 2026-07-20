import { describe, expect, it } from "vitest";
import { ClientSecretsRejectedError, rejectClientSecrets } from "./credentials.js";

describe("rejectClientSecrets", () => {
  it("allows missing/empty env", () => {
    expect(() => rejectClientSecrets(undefined)).not.toThrow();
    expect(() => rejectClientSecrets({})).not.toThrow();
  });

  it("rejects API keys from the client", () => {
    expect(() => rejectClientSecrets({ OPENAI_API_KEY: "sk-x" })).toThrow(
      ClientSecretsRejectedError,
    );
  });

  it("rejects any client env in v1", () => {
    expect(() => rejectClientSecrets({ FOO: "bar" })).toThrow(ClientSecretsRejectedError);
  });
});
