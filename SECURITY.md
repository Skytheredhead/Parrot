# Security policy

This repository is pre-release and has no approved public product name or production endpoint.

Do not open a public issue for a suspected vulnerability that includes credentials, personal data,
private workspace content, signed URLs, provider payloads, or exploit details. Until a dedicated
security contact is approved, report privately to the repository owner through GitHub's private
vulnerability-reporting feature once the repository exists.

## Supported versions

No version is production-supported yet. A release becomes supported only after the documented
threat model, authorization tests, provider review, restore drill, production smoke tests, and
security contact are complete.

## Response expectations

The eventual production policy must name a monitored contact, acknowledgement target, triage
target, severity rubric, coordinated-disclosure process, and supported-release window. Those are
launch gates rather than promises made by this pre-release repository.

## Handling rules

- Never send live credentials or tokens in a report. Rotate exposed material first when safe.
- Use synthetic tenant and file data for proofs of concept.
- Do not access unrelated workspaces, users, services, or server data.
- Do not perform denial-of-service, persistence, social engineering, or destructive testing.
- Preserve evidence without copying private content into logs or issues.
