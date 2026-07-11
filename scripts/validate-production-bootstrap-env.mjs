const issuerValue = process.env.PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ISSUER;
const audience = process.env.PROJECT_CONVERSATION_BOOTSTRAP_OIDC_AUDIENCE;
const subject = process.env.PROJECT_CONVERSATION_BOOTSTRAP_OWNER_SUBJECT;

for (const [name, value] of Object.entries({
  PROJECT_CONVERSATION_BOOTSTRAP_OIDC_ISSUER: issuerValue,
  PROJECT_CONVERSATION_BOOTSTRAP_OIDC_AUDIENCE: audience,
  PROJECT_CONVERSATION_BOOTSTRAP_OWNER_SUBJECT: subject,
})) {
  if (!value) throw new Error(`${name} is required for a production module build`);
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
  if (value !== value.trim() || hasControlCharacter) {
    throw new Error(`${name} contains surrounding whitespace or control characters`);
  }
}

const issuer = new URL(issuerValue);
const reservedExampleHosts = ["example", "example.com", "example.net", "example.org"];
const issuerRemainder = issuerValue.startsWith("https://") ? issuerValue.slice(8) : "";
const issuerAuthority = issuerRemainder.split("/", 1)[0] ?? "";
const authorityParts = issuerAuthority.split(":");
const authorityHost = authorityParts[0] ?? "";
const authorityPort = authorityParts[1];
const validAuthorityHost = authorityHost
  .split(".")
  .every(
    (label) =>
      label.length > 0 &&
      /^[A-Za-z0-9-]+$/u.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-"),
  );
const validAuthorityPort =
  authorityPort === undefined ||
  (/^[0-9]+$/u.test(authorityPort) &&
    Number(authorityPort) >= 1 &&
    Number(authorityPort) <= 65_535);
if (
  issuerValue.length > 500 ||
  !issuerValue.startsWith("https://") ||
  ![...issuerValue].every((character) => character.codePointAt(0) < 128) ||
  /[\\%@?#]/u.test(issuerValue) ||
  authorityParts.length > 2 ||
  !validAuthorityHost ||
  !validAuthorityPort ||
  issuer.protocol !== "https:" ||
  issuer.username ||
  issuer.password ||
  issuer.search ||
  issuer.hash ||
  issuer.hostname === "localhost" ||
  issuer.hostname.endsWith(".localhost") ||
  issuer.hostname.endsWith(".test") ||
  issuer.hostname.endsWith(".invalid") ||
  reservedExampleHosts.some(
    (host) => issuer.hostname === host || issuer.hostname.endsWith(`.${host}`),
  )
) {
  throw new Error("production bootstrap issuer must be an approved HTTPS provider URL");
}

const knownSynthetic = new Set([
  "project-conversation-ci",
  "project-conversation-smoke",
  "project-conversation-bindings",
  "ci-owner",
  "smoke-owner",
  "bindings-owner",
]);
if (knownSynthetic.has(audience) || knownSynthetic.has(subject)) {
  throw new Error("known CI/smoke/binding bootstrap values cannot enter a production artifact");
}
if (audience.length > 255 || subject.length > 255 || /\s/u.test(audience) || /\s/u.test(subject)) {
  throw new Error("bootstrap audience and owner subject cannot contain whitespace");
}

console.log("Production bootstrap build configuration passed the release guard");
