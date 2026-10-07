import { describe, it, expect } from "vitest";
import { signV4 } from "../../../src/integrations/rekognition.provider";

// AWS's published SigV4 "get-vanilla" test vector.
describe("signV4", () => {
  it("matches the AWS reference signature", () => {
    const { signature, authorization } = signV4({
      method: "GET",
      host: "example.amazonaws.com",
      path: "/",
      headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
      body: "",
      region: "us-east-1",
      service: "service",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      amzDate: "20150830T123600Z",
    });
    expect(signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(authorization).toContain("SignedHeaders=host;x-amz-date");
  });
});
