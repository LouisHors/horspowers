# Codex Agent Policy

## Allowed Tasks

Codex may handle:

- Bug fixes
- Tests
- Documentation
- Small refactors
- CI fixes
- Low-risk maintenance

## Restricted Tasks

Codex must not perform without explicit human approval:

- Authentication or permission model changes
- Payment changes
- Destructive database migrations
- Production deploys
- Secrets or token changes
- GitHub workflow permission expansion
- Major dependency upgrades

## Human Confirmation Required

Medium-risk and high-risk changes must be proposed as a plan before implementation.

Codex may open or update pull requests. Codex must not merge pull requests automatically.
