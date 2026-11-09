import { describe, expect, it } from "./session/vitest-compat.mjs";
import { clip, conversationText, findSecrets, REDACTED, redactSecrets } from "../plugins/session/scripts/ledger-text.mjs";

describe("clip", () => {
  it("flattens whitespace", () => {
    expect(clip("a\n  b   c", 20)).toBe("a b c");
  });

  it("appends an ellipsis past the limit", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
  });

  it("leaves a short value untouched", () => {
    expect(clip("short", 20)).toBe("short");
  });
});

describe("conversationText", () => {
  it("cuts system reminders around a typed prompt", () => {
    expect(conversationText("<system-reminder>ctx</system-reminder>\nFix the hook")).toBe("Fix the hook");
  });

  it("unwraps a pasted prompt, closing tag id included", () => {
    const pasted = '<pasted_content id="c785">\nAdopt appearance presets.\n</pasted_content id="c785">';
    expect(conversationText(`<system-reminder>ctx</system-reminder>${pasted}`)).toBe("Adopt appearance presets.");
  });

  it("keeps typed text around a paste", () => {
    expect(conversationText('<pasted_content id="a">brief</pasted_content id="a">\nDo this')).toBe("brief\nDo this");
  });

  it("drops other tag-led blocks as tool chatter", () => {
    expect(conversationText("<command-name>/close-out</command-name>")).toBe("");
    expect(conversationText("<task-notification>done</task-notification>")).toBe("");
    expect(conversationText("<pasted_contentx>no</pasted_contentx>")).toBe("");
  });
});

// Fake keys are assembled at runtime so this file never carries a literal that a secret scanner
// (GitHub push protection, the ledger's own pre-commit step) would stop.
const fake = {
  anthropic: `sk-${"ant"}-api03-${"a1B2".repeat(10)}`,
  openai: `sk-${"proj"}-${"Z9y8".repeat(10)}`,
  github: `ghp${"_"}${"k3".repeat(18)}`,
  githubPat: `github${"_pat_"}${"11AB".repeat(8)}`,
  slack: `xox${"b"}-1234567890-abcdefghij`,
  aws: `AKIA${"IOSFODNN7EXAMPLE"}`,
  privateKey: `-----BEGIN ${"RSA PRIVATE"} KEY-----\nMIIEpAIBAAKCAQEA\n-----END ${"RSA PRIVATE"} KEY-----`,
  jwt: `eyJ${"hbGciOiJIUzI1NiJ9"}.eyJ${"zdWIiOiIxMjM0NTY3ODkwIn0"}.${"dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}`,
};

describe("findSecrets", () => {
  it.each([
    ["anthropic-key", fake.anthropic],
    ["openai-style-key", fake.openai],
    ["github-token", fake.github],
    ["github-pat", fake.githubPat],
    ["slack-token", fake.slack],
    ["aws-access-key", fake.aws],
    ["private-key", fake.privateKey],
    ["jwt", fake.jwt],
  ])("finds a %s", (kind, secret) => {
    expect(findSecrets(`Pasted: ${secret} — then moved on.`)).toEqual([{ kind, match: secret }]);
  });

  it("finds a long value assigned to a secret-like key", () => {
    expect(findSecrets("set api_key=hunter2hunter2 in .env")).toEqual([
      { kind: "assignment", match: "api_key=hunter2hunter2" },
    ]);
    expect(findSecrets("password: correct-horse-battery")).toHaveLength(1);
  });

  it("reports a token inside an assignment once", () => {
    expect(findSecrets(`token=${fake.github}`)).toEqual([{ kind: "github-token", match: fake.github }]);
  });

  it("ignores prose about tokens and secrets", () => {
    expect(findSecrets("RTK gives 60-90% token savings; the secret scanner runs at commit.")).toEqual([]);
    expect(findSecrets("Set `token: short` in the fixture; see the sk-ant-… pattern.")).toEqual([]);
  });

  it("ignores a value that is already redacted", () => {
    expect(findSecrets(`token = ${REDACTED} and secret: "${REDACTED}"`)).toEqual([]);
  });
});

describe("redactSecrets", () => {
  it("replaces a token shape with the marker", () => {
    expect(redactSecrets(`key ${fake.anthropic} used`)).toBe(`key ${REDACTED} used`);
  });

  it("keeps the key name of an assignment", () => {
    expect(redactSecrets("secret = abcdefgh12345")).toBe(`secret = ${REDACTED}`);
  });

  it("removes a whole private key block", () => {
    expect(redactSecrets(`a\n${fake.privateKey}\nb`)).toBe(`a\n${REDACTED}\nb`);
  });

  it("is idempotent", () => {
    const once = redactSecrets(`token=${fake.slack} ${fake.jwt}`);
    expect(redactSecrets(once)).toBe(once);
    expect(findSecrets(once)).toEqual([]);
  });
});
