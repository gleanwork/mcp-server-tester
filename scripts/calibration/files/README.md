# Larkspur

Larkspur is a message queue service. Producers post messages over HTTP, and
workers take them in order of priority.

The service listens on port 7300 by default. See `config/service.json` for
the settings a deployment uses.

- `docs/architecture.md` describes how a message moves through the service.
- `CHANGELOG.md` lists each release.
- `team/owners.md` names the owner of each module.
- `incidents/` has a report for each outage.
