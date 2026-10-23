# ADR 0001: Render with SQLite on a persistent disk

- Status: accepted
- Date: 2026-10-23
- Deciders: product owner and implementation

## Context

The first version serves two household members from one shared, durable state. It needs a public web address, atomic writes, and a simple operational setup. The repository has no existing application or hosting platform.

## Decision

Run the Node.js web application as one Render web service. Store application data in SQLite at `/var/data/households.sqlite` on an attached Render persistent disk. Configure the service for one instance and use SQLite transactions for writes that must be atomic. Read the client address from Render's `CF-Connecting-IP` header for join-code rate limiting.

The deployment configuration is in `render.yaml`. A persistent disk requires a paid Render service; no service has been deployed or purchased as part of this change.

## Rationale

The application has two members and five fixed tasks, so a single process and a file-backed relational database meet the initial scale while keeping the number of services low. SQLite transactions support atomic household setup and future queue updates. The database file, session records, and rate-limit state survive service restarts and deployments when stored under the mounted disk path.

## Consequences

- Keep the service at one instance; the attached disk is not a shared database for horizontal scaling.
- Use the configured mount path for every durable database file and related SQLite files.
- Maintain a database backup and restore procedure before storing real household data.
- Move to managed PostgreSQL if multiple application instances, stronger availability, or higher write concurrency become requirements.
- Render sits behind Cloudflare; `CF-Connecting-IP` is used only when `TRUST_CF_CONNECTING_IP=true` is configured for this deployment. Locally, the server uses the socket address.

## References

- [Render persistent disks](https://render.com/docs/disks)
- [Render web services](https://render.com/docs/web-services)
- [Render DDoS and client IP guidance](https://render.com/articles/how-render-handles-ddos-attacks)
