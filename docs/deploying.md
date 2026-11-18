# Deploying a4a

This is for whoever runs a4a for a team: what it needs, what it keeps and where, and how to run it on Kubernetes or on Google Cloud Run. The settings it names are in the README's [configuration table](../README.md#configuration). How several instances behave as one is [D17](architecture.md#d17-several-instances-on-one-postgres-behave-as-one).

What this guide says about a4a itself was checked on the built server, laid out as the image lays it out, against PostgreSQL 16. The Kubernetes and Google Cloud commands are as each product documents them; they weren't run against a cluster or Google Cloud.

## What a4a needs

### The image

The [Dockerfile](../Dockerfile) builds one image that serves everything from one port: the web app, the REST API under `/api/v1`, and MCP at `/mcp`. Nobody publishes it yet, so build it from the repository's root and push it where your cluster or Cloud Run pulls from:

```bash
docker build -t registry.example.com/a4a:VERSION .
```

The image runs `node dist/index.js` in `/app` as the `node` user (uid 1000), and sets `PORT=3000`, `NODE_ENV=production`, `WEB_DIST=/app/web` and `DATA_DIR=/data`. Its `HEALTHCHECK` is for Docker; Kubernetes and Cloud Run ignore it and probe for themselves.

a4a serves from the root of its host (`/`, `/api`, `/mcp`, `/assets`), so it needs a host of its own, not a path under another site.

### PostgreSQL

- **Which version.** CI runs the server's tests on PostgreSQL 16, and on PGlite, which is PostgreSQL 18; `docker-compose.yml` runs 16. Use 16 or later.
- **Its role.** At every start a4a runs `CREATE EXTENSION IF NOT EXISTS pg_trgm`, then its migrations, which make its tables and a `drizzle` schema. A role that owns its database can do all of it without being a superuser (`CREATE DATABASE a4a OWNER a4a`). Where the role may not create extensions, an administrator creates `pg_trgm` in that database once, and a4a finds it there.
- **Connections.** Each instance keeps up to `DATABASE_POOL_SIZE` (10), one more for `LISTEN`, and one more while it starts.

### A public HTTPS address

`PUBLIC_URL` is the address people open, at the proxy: `https://a4a.example.com`. a4a uses it:

- **for links**: in email, webhooks' payloads, MCP's setup snippets and the OpenAPI document, and the addresses single sign-on registers with the provider (`PUBLIC_URL/api/v1/auth/oidc/callback`, SAML's);
- **for the CSRF check**: a write made with the session cookie must come from a page on PUBLIC_URL's host (or the request's own `Host`);
- **for cookies**: they're `Secure` when PUBLIC_URL is https, whatever the proxy says;
- **for passkeys** ([D62](architecture.md#d62-passkeys-both-factors-at-once-beside-a4as-own-password-and-every-change-told-to-its-person)): PUBLIC_URL's host is the relying party. Browsers make passkeys only for a domain over https (or `localhost`), so at an IP address or on plain http they're off. A passkey works only on the host it was made for: choose the address before people add them;
- **for MCP clients that sign in by themselves** ([D28](architecture.md#d28-remote-mcp-signs-in-with-oauth-21-and-a4a-is-its-own-authorization-server)), which needs https.

Without it, a4a takes `http://localhost:PORT`, which is right only on your own computer.

### Settings

A deployment of more than one instance, or on Cloud Run, must set:

| Variable | Why |
| --- | --- |
| `PUBLIC_URL` | The https address, as above |
| `DATABASE_URL` | PostgreSQL. Without it a4a runs PGlite in `DATA_DIR`, for one process |
| `SECRET_KEY` | The key that seals secrets in the database, the same on every instance |
| `ATTACHMENT_STORAGE=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` (for a store other than AWS's), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Files every instance reaches. Or keep them on a volume every instance mounts |
| `TRUST_PROXY` | How many proxies in front append to `X-Forwarded-For`, so limits per address count clients, not the proxy |

It usually sets:

| Variable | Why |
| --- | --- |
| `ADMIN_LOGIN`, `ADMIN_PASSWORD` | The first administrator, at the first start |
| `SEED_DEMO=false` | No demo projects beside that administrator |
| `SMTP_URL`, `MAIL_FROM` | Email |
| `ANTHROPIC_API_KEY`, or another provider's key with `AI_PROVIDER` | The AI features |
| `OIDC_*`, `SAML_*` or `LDAP_*` | Single sign-on, or a directory |
| `DATABASE_LISTEN_URL` | `DATABASE_URL` goes through a pooler in transaction mode |

The rest are in the [configuration table](../README.md#configuration).

## What a4a keeps, and where

| What | Where | Across instances | In the backup |
| --- | --- | --- | --- |
| Everything people, agents and integrations make, and the settings made in the web | PostgreSQL, `DATABASE_URL` | One for all | Yes |
| Files on issues, comments and articles | A bucket, or `DATA_DIR/attachments` | One for all | Yes, with the database |
| The key that seals secrets in the database | `SECRET_KEY`, or `DATA_DIR/secret.key` | The same on each | Yes, kept apart |
| Settings read at start | Environment variables | The same on each | With your deployment's files |
| Caches, some limits, open live streams | Each instance's memory | Each its own | No |

### PostgreSQL holds the state

`DATABASE_URL` points at it. It holds:

- issues and everything on them (fields, comments, links, history, time, votes), and articles, boards, sprints, plans, whiteboards and dashboards;
- people, groups and roles, sessions, API tokens and OAuth grants, and the sign-in throttle;
- the activity log, which is the outbox ([D5](architecture.md#d5-the-activity-log-is-the-event-log-transactional-outbox)): webhooks, notifications, mail, push and chat go out from it, each consumer with its cursor, run by the instance that holds the worker's lease;
- settings made in the web, and the integrations: webhooks, version control, builds, Slack, help desks and their mailboxes;
- apps: their packages, their files and their settings (D48);
- sealed secrets (below), the push key pair and the devices people turned push on for ([D47](architecture.md#d47-a4a-on-a-phone-installed-from-the-browser-offline-shy-and-pushing-what-the-inbox-gets)), and the key that signs unsubscribe links;
- each file's record and checksum, though not its bytes.

Not every secret in it is sealed: a webhook's signing secret and a version-control integration's signing key are kept as given, since a4a signs and checks deliveries with them. Keep the database and its backups as secret as the key.

**`LISTEN`, and `DATABASE_LISTEN_URL`.** Each instance holds a connection of its own that `LISTEN`s, so what changes on one reaches the others at once (D17): live events, the cache of fields and people, the inbox's count, whiteboards. It goes to `DATABASE_LISTEN_URL`, or to `DATABASE_URL` without it. A pooler in transaction mode, such as PgBouncer with `pool_mode = transaction`, drops `LISTEN`, so point `DATABASE_LISTEN_URL` past it, straight at Postgres. Without a working `LISTEN`, an instance still serves, but its live events come within 10 seconds rather than at once, and a change to fields or people reaches it within a minute. `GET /api/v1/health` says `"live": "listening"` while it works.

The startup lock (below) goes through `DATABASE_URL`, and it's a session lock, which such a pooler doesn't keep either: it can be left held on one of the pooler's connections, where a replica that starts later waits for it. So connect `DATABASE_URL` to Postgres directly, or through a pooler in session mode.

**Migrations run as the server starts**, before its port opens: every migration it hasn't run yet, in one transaction. First it takes a Postgres advisory lock (`packages/server/src/db/client.ts`) on a connection of its own, so replicas that start together migrate one at a time: the first migrates, the others wait, find nothing left to do, and go on. The defaults and the first administrator come under the same lock. Checked: two instances started together on an empty database; one waited while the other ran all 41 migrations, and both answered within three seconds. A migration that fails rolls back whole, and the instance doesn't start.

**Migrations only go forward.** There are none that go back. An older version started on a newer database runs no migrations and starts, with code that doesn't know the newer schema. So back up before every upgrade: the backup is the way back.

### Without `DATABASE_URL`, PGlite in `DATA_DIR`

Without `DATABASE_URL`, a4a runs PGlite, Postgres compiled to WebAssembly, inside its own process: the database is `DATA_DIR/pglite`, with `DATA_DIR/pglite.lock` beside it, and a second process on the same directory refuses to start ([D2](architecture.md#d2-postgres-semantics-everywhere-pglite-only-for-development-and-small-teams)). It's for trying a4a out, never for a cluster or for Cloud Run:

- it's one process, and its lock can't tell containers apart: it goes by process id, and in a container a4a is process 1;
- Cloud Run's disk goes with its instance;
- a4a has no command that moves a PGlite database to Postgres. Start a team's a4a on Postgres.

### Files

**`ATTACHMENT_STORAGE=local`**, the default, keeps them under `DATA_DIR/attachments`: a folder for the first two characters of each random key, and `.tmp` for uploads on their way ([D18](architecture.md#d18-files-stream-to-a-small-store-and-come-back-as-downloads)). Every replica must mount the same persistent volume there, read-write. Checked: a file uploaded through one instance, asked for through another with a disk of its own, is "missing from storage" (410).

**`ATTACHMENT_STORAGE=s3`** keeps them in a bucket ([D35](architecture.md#d35-files-in-an-s3-compatible-bucket-served-in-ranges-and-shown-in-place)): S3, or a store that speaks its API, such as MinIO, R2 or Cloud Storage. a4a looks the bucket up as it starts (`HeadBucket`), and one that can't be reached or refuses it stops the start, saying what to check. Downloads still come through a4a, so the bucket needs no public access.

With `S3_ENDPOINT` set, a4a sends checksums only where an operation requires one, not the AWS SDK's default `aws-chunked` bodies with trailers, which not every store takes (`packages/server/src/attachments/s3.ts`). Checked against a stand-in S3 server: `HeadBucket`, `ListObjectsV2`, `PutObject`, a multipart upload and `GetObject` went without any.

**Cloud Storage** speaks S3's API at its XML endpoint, with an HMAC key of a service account:

```
ATTACHMENT_STORAGE=s3
S3_BUCKET=PROJECT-a4a-files
S3_ENDPOINT=https://storage.googleapis.com
S3_REGION=auto
S3_ACCESS_KEY_ID=<the HMAC key's access ID>
S3_SECRET_ACCESS_KEY=<the HMAC key's secret>
```

The bucket goes in the path, the default with an endpoint (`S3_FORCE_PATH_STYLE`). The Cloud Run steps below make the bucket and the key.

**Moving files from disk to a bucket.** The copy command copies every file a4a points at, checks each copy against the SHA-256 taken at upload, writes the verified ones in a manifest beside the files (`DATA_DIR/attachments/.copied-to-s3-…`), and on a second run copies only what's new. It deletes nothing, and reads the server's own settings: `DATABASE_URL`, `DATA_DIR` and `S3_*`. In the image it's `node dist/files-to-s3.js`; from the repository, `pnpm --filter @a4a/server files:to-s3` (`packages/server/src/attachments/copy-cli.ts`). `--dry-run` counts what it would copy.

1. Give a4a the `S3_*` settings beside `ATTACHMENT_STORAGE=local`, and run the copy while it still runs on disk. On Kubernetes: `kubectl exec -n a4a deploy/a4a -- node dist/files-to-s3.js`.
2. Stop every replica, and run it again: it copies what came meanwhile. On Kubernetes that's a pod with the image, the same settings and the same volume, while the Deployment is scaled to 0.
3. Start a4a with `ATTACHMENT_STORAGE=s3`.

Checked from the image's layout, against a stand-in bucket: the dry run, the copy, and a second run that found everything verified and copied nothing.

### The key

`SECRET_KEY` seals the secrets a4a has to read back (`packages/server/src/lib/secret-box.ts`), with AES-256-GCM, so a copy of the database alone doesn't give them away. It seals:

- two-factor secrets ([D38](architecture.md#d38-identity-in-depth-a-second-factor-a-directory-provisioning-and-apps-that-name-themselves));
- version-control integrations' access tokens, and GitHub Apps' private keys (D46, D54);
- Slack's bot token and signing secret (D42);
- a help desk's own mailbox, its password with it (D45);
- the client secrets of the portal's identity providers (D63);
- apps' secret settings (D48);
- the private half of the push key pair (D47), unless `VAPID_*` give one.

The addresses of apps' files are signed with a key made from it, too. Two-factor's recovery codes are kept as hashes, so they don't need it.

It's any text, hashed to 32 bytes, or exactly 32 bytes in hex (64 characters) or base64. Make one with `openssl rand -base64 32`.

**Without `SECRET_KEY`,** a4a makes `DATA_DIR/secret.key`, readable by its owner alone, the first time it needs the key, and reads it from then on. Checked: `DATA_DIR` is empty after the start, and the file appears with the first secret sealed. On one server whose `DATA_DIR` lasts, that works: back the file up as below.

**Every replica needs the same key.** Two replicas that each make their own file have two keys, and what one seals the other can't open. Checked: of two instances with a `DATA_DIR` each, the second answered 500 for the push key the first had sealed ("sealed with another SECRET_KEY"). So set `SECRET_KEY`, from a secret store, the same for every replica. A server that ran on a key file moves to `SECRET_KEY` by taking the file's contents as its value: what it sealed stays readable (checked).

**Losing the key loses what it sealed.** Everything else is as it was, but:

- people's codes from their authenticator app stop working: they sign in with a recovery code, or an administrator turns their two-factor off, and they set it up again;
- administrators give integrations their tokens and GitHub Apps their keys again, connect Slack again, and set again the desks' mailboxes, the portal providers' secrets and apps' secret settings;
- push stops until `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set, and then people turn it on again on their devices.

**It can't be rotated.** a4a reads with one key, and nothing seals again with another, so changing `SECRET_KEY` is losing it, as above. Keep it for as long as the database.

### What lives only in an instance's memory

- **The reference data**: fields, values, people, tags and workflow rules, loaded from the database, reloaded on every instance after a change on any, and every minute anyway (D17).
- **Some limits.** Each instance counts its own: the general rate limits (`API_RATE_LIMIT`, `MCP_RATE_LIMIT`, `GUEST_RATE_LIMIT`), OAuth's limits on registrations and token requests, the limits on starting single sign-on and on making passkey challenges, deliveries per version-control integration and build source, and guests' live whiteboards. Behind N instances a client gets up to N times a limit. Shared by every instance, in Postgres: the sign-in throttle, the AI's hourly caps, issues made from chat, and the help desk's limits.
- **Open live streams**, and **GitHub Apps' installation tokens**, which last an hour (D54).

When a replica stops or restarts:

- its live streams end, and browsers reconnect, to any instance, and resume after the last event they had; the inbox starts again with its count;
- its limits start again from nothing, and it loads the reference data as it starts;
- an assistant's answer it was writing stops, and that conversation takes messages again two minutes later;
- if it held the worker's lease, a clean stop hands it on, and another instance holds it within a couple of seconds; a crash or a `SIGKILL` leaves it to expire, and the background work waits about 30 seconds (both checked). What it had in hand may be done again: delivery is at least once, and webhook receivers dedupe on the event's id.

### Configuration in two places

**Environment variables are read as the server starts.** A change needs a restart of every replica, and each must have the same. They hold:

- where a4a is and what's in front of it: `PUBLIC_URL`, `PORT`, `TRUST_PROXY`, the rate limits;
- where it keeps things: `DATABASE_URL`, `DATABASE_LISTEN_URL`, `DATA_DIR`, `ATTACHMENT_STORAGE` and `S3_*`, `SECRET_KEY`;
- how the team signs in: `OIDC_*`, `SAML_*`, `LDAP_*`, `PASSWORD_LOGIN`, `MCP_OAUTH`;
- the AI's provider, its key and its caps;
- mail and push: `SMTP_URL`, `MAIL_FROM`, `MAIL_REPLY_ADDRESS`, the shared help desk mailbox (`HELPDESK_IMAP_URL`), `VAPID_*`, `PUSH_HOSTS`;
- what a4a connects to: the Teams bot (`TEAMS_*`), the OAuth apps people connect their code-host accounts through (`GITHUB_CLIENT_ID` and the like), app catalogs and the keys they're signed with, `IMPORT_ALLOW_HOSTS`;
- limits and defaults: `ATTACHMENT_MAX_MB`, `DEFAULT_LOCALE`, `DIGEST_HOUR`, `NOTIFY_WINDOW_SECONDS`;
- the first administrator: `ADMIN_*` and `SEED_DEMO`.

**Settings made in the web are kept in the database.** Every instance sees a change at once, and the database's backup holds them:

- the instance's own, under Administration: its name, the default triage mode, two-factor for everyone, passkeys on or off;
- projects and everything in them: fields, workflow rules, state machines and custom actions, boards, help desks with their addresses, SLAs, mailboxes and the portal's sign-in, customer groups;
- people, groups, roles and tokens, and SCIM's tokens;
- integrations: webhooks, version control, build sources, Slack's connection and chat channels, apps and their settings.

Some pairs are split between the two: the team's single sign-on is set in the environment, the portal's identity providers in the web; the shared help desk mailbox in the environment, a desk's own in the web; the Teams bot in the environment, Slack in the web.

### Backups

Back up three things, together:

1. **The database**: `pg_dump`, or the provider's own backups, with point-in-time recovery where it has it.
2. **The files**: the bucket, or the volume. A file's record and its bytes go together: a record without its bytes is "missing from storage". Back the files up after the database, and keep deleted objects for a while (a bucket's versioning, or Cloud Storage's soft delete), so every file the database's copy names is in the files' copy.
3. **The key**: `SECRET_KEY`, or `DATA_DIR/secret.key`. Keep it apart from the database's backups, since the two together open the sealed secrets; but keep it, since without it a restore has everything but those secrets.

On PGlite, back up the whole `DATA_DIR`, with the server stopped.

To restore:

1. Stop every replica, so nothing writes meanwhile.
2. Restore the database into an empty one.
3. Restore the files from the same time or later.
4. Start a4a with the same `SECRET_KEY`, on the version that made the backup or a newer one (it migrates the database as it starts), never an older one.
5. Sign in, open a file, and sign in once with two-factor.

What went out after the backup (mail, webhooks, chat posts, pushes) may go out again, since the restored outbox doesn't know it went. What came in after it is gone.

## Kubernetes

The manifests in [`deploy/kubernetes/`](../deploy/kubernetes) run two replicas of the image behind an ingress controller, with files in a bucket and PostgreSQL from elsewhere. Make the key once and keep it in your secret store, then:

```bash
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl create secret generic a4a --namespace a4a \
  --from-literal=SECRET_KEY='<the key>' \
  --from-literal=DATABASE_URL='postgres://a4a:<password>@<host>:5432/a4a' \
  --from-literal=S3_ACCESS_KEY_ID='<access key id>' \
  --from-literal=S3_SECRET_ACCESS_KEY='<secret access key>'
kubectl apply -k deploy/kubernetes
```

Edit `configmap.yaml`, `ingress.yaml` and the image in `deployment.yaml` first. `docker-compose.cluster.yml` runs the same shape on one computer: two instances behind Caddy ([Several instances](../README.md#several-instances)).

### Namespace, Secret and ConfigMap

- **The Secret** holds `SECRET_KEY`, `DATABASE_URL` and the bucket's keys, and `SMTP_URL`, a provider's AI key, `OIDC_CLIENT_SECRET` or `ADMIN_PASSWORD` when you use them. [`secret.yaml`](../deploy/kubernetes/secret.yaml) shows its shape, with placeholders; [`kustomization.yaml`](../deploy/kubernetes/kustomization.yaml) leaves it out, so applying the directory never puts the placeholders in the cluster. Create it from your secret store, as above, or with your store's own operator. On EKS with IAM roles for service accounts, leave the bucket's keys out: the AWS SDK finds the role.
- **The ConfigMap** holds `PUBLIC_URL`, `TRUST_PROXY`, `ATTACHMENT_STORAGE`, the bucket's name and region (and `S3_ENDPOINT` for a store other than AWS's), and `SEED_DEMO=false`.

Both reach the container with `envFrom`. a4a reads them as it starts, so a change takes a restart: `kubectl rollout restart deployment/a4a -n a4a`.

### Deployment

[`deployment.yaml`](../deploy/kubernetes/deployment.yaml):

- **Two replicas**, spread over nodes where there are two, and a rolling update that starts a new replica before it stops an old one (`maxSurge: 1`, `maxUnavailable: 0`).
- **Port 3000**, the image's.
- **Probes.** `GET /api/v1/health` answers `{"ok", "db", "ai", "instance", "live", "worker"}`: `ok` and the status come from the database alone (200 when `SELECT 1` answers, 503 when it doesn't), `instance` starts with the pod's name, `live` says whether its `LISTEN` works, and `worker` is `active` on the one replica that holds the lease, `standby` on the rest. Checked: with the database gone, it answers 503 at once while the process carries on, and 200 again once the database is back. So it suits the startup and readiness probes, not liveness: an outage of the database would restart every replica, which helps nothing, and a replica can't start without its database anyway. Liveness asks for the web page instead, `GET /`, which needs no database (checked). The startup probe allows five minutes for migrations, including a wait while another replica migrates: raise `failureThreshold` for an upgrade whose migrations take longer.
- **Resources.** a4a took about 200 MB at rest and 300 MB as it started, here. Uploads stream, so a file doesn't add its size. The manifest asks for 512 Mi and allows 1 Gi.
- **`securityContext`.** It runs as uid 1000, the image's `node` user: the image names its user, so Kubernetes needs the number to check `runAsNonRoot`. It can't gain privileges, has no capabilities, runs under the runtime's default seccomp profile, and its root filesystem is read-only, since a4a writes only to `DATA_DIR`. Checked by tracing every file system call of a running server, from its start to its stop, through sign-ins, uploads, downloads, live streams, a script in the sandbox and a CSV for an import: with files in a bucket and `SECRET_KEY` set, it wrote no file at all.
- **`DATA_DIR` as an `emptyDir`.** With files in a bucket and `SECRET_KEY` set, nothing goes there, so an `emptyDir` at `/data` is enough: it's there because the root filesystem is read-only. Never an `emptyDir` with `ATTACHMENT_STORAGE=local` or without `SECRET_KEY`: files and the key would differ from pod to pod and go with each one. For files on disk, every replica mounts one volume that's `ReadWriteMany` (NFS, CephFS, Filestore, EFS):

  ```yaml
  apiVersion: v1
  kind: PersistentVolumeClaim
  metadata:
    name: a4a-data
    namespace: a4a
  spec:
    accessModes: [ReadWriteMany]
    storageClassName: nfs # a class that offers ReadWriteMany
    resources:
      requests:
        storage: 50Gi
  ```

  and the Deployment's `data` volume becomes `persistentVolumeClaim: {claimName: a4a-data}`.
- **Shutting down.** On `SIGTERM` (`packages/server/src/index.ts`), a4a stops taking connections, ends its live streams (their browsers reconnect to another replica and resume), stops sending mail, pushes and chat posts, waits for the requests in flight, hands the worker's lease on after at most 5 seconds for the event in hand, closes the database, and exits with 0. If that isn't done in 10 seconds, it exits anyway, with 1. Checked: a standby with open streams exited within a tenth of a second, the lease holder within two, and one with a slow upload in flight after 10 seconds, with 1. The 5-second `preStop` pause lets the ingress controller stop sending it requests first, and `terminationGracePeriodSeconds: 20` covers both, so Kubernetes never has to send `SIGKILL`, which would leave the lease to expire.

### Service, Ingress and PodDisruptionBudget

- **The Service** sends port 80 to the container's. Nothing is sticky: any replica serves any request (D17).
- **The Ingress** ([`ingress.yaml`](../deploy/kubernetes/ingress.yaml)) serves `a4a.example.com` with TLS from the `a4a-tls` Secret, which cert-manager, for one, can make. Its annotations are ingress-nginx's. With another controller, or the Gateway API, set the same three things in its terms:
  - **No buffering of live streams.** a4a's live streams are `text/event-stream` responses that stay open. The events and whiteboard streams send `X-Accel-Buffering: no`, which nginx honours; the inbox's count and the assistant's streamed answer don't. So buffering is off for the host.
  - **Long reads.** The events stream sends a keep-alive every 25 seconds, the inbox and whiteboards every 15, within nginx's default of 60 seconds; the assistant's answer sends nothing while the model thinks or a tool runs. An hour covers it, and a stream cut sooner reconnects and resumes.
  - **Bodies as large as a4a takes**: a file up to `ATTACHMENT_MAX_MB` (20 MB) with its multipart wrapping, a help desk's mail from a provider's webhook up to `HELPDESK_MAIL_MAX_MB` (25 MB) and a little more, a CSV import up to 64 MB. nginx takes 1 MB by default; the Ingress takes 64 MB, the largest of them. Raise it only for an `ATTACHMENT_MAX_MB` past that.

  a4a keeps an idle connection open for 65 seconds, so whatever is in front must drop its own idle connections to a4a sooner, or it can send a request down one a4a has just closed and answer 502 ([Limits and assumptions](architecture.md#limits-and-assumptions)). ingress-nginx's upstream keep-alive is 60 seconds. With GKE's own Ingress, Google's external Application Load Balancer is in front, and by its documentation it differs in two ways. It ends a response at its backend service's timeout, 30 seconds unless set longer, so live streams need that set to an hour. And it keeps idle connections to its backends for ten minutes, longer than a4a's 65 seconds, which are `KEEP_ALIVE_MS` in `packages/server/src/server.ts`: no setting changes them.
- **The PodDisruptionBudget** keeps one replica up while nodes are drained or upgraded.

### `TRUST_PROXY`

a4a counts on each proxy in front appending the address it took the request from to `X-Forwarded-For`. With `TRUST_PROXY=N`, a4a takes the client's address to be the Nth entry from the right, the one the outermost of the N proxies added (`clientIp` in `packages/server/src/http/middleware.ts`). With 0, the default, it ignores the header and takes the connection's own address, since a client can send any header it likes. Checked, with `X-Forwarded-For: 203.0.113.7, 198.51.100.20` from 127.0.0.1: 0 took 127.0.0.1, 1 took 198.51.100.20, and 2 took 203.0.113.7.

The address counts for the sign-in throttle, and for the limits on people who aren't signed in, on OAuth's endpoints, on the help desk's form, and on deliveries from version control and CI. Set too low, every client is the proxy, and they all share its allowance; set too high, a client chooses its own address, and walks around the limits.

| In front of a4a | `TRUST_PROXY` |
| --- | --- |
| ingress-nginx as it comes, which puts the one address it took the request from in the header | `1` |
| A cloud load balancer that appends, then an ingress controller that appends too (ingress-nginx with `compute-full-forwarded-for`) | `2` |
| Cloud Run's own front end | `1` |
| An external Application Load Balancer in front of Cloud Run, which appends the client's address and its own | `2` |

Whether the address ingress-nginx took is the client's depends on what's in front of the controller: through a Service with `externalTrafficPolicy: Cluster`, the default, it's a node's; `Local`, or the PROXY protocol from the load balancer, keeps the client's. That's set at the controller, not in a4a.

**To check it**, sign in once with a wrong password, from a machine whose address you know, and look at what the throttle counted:

```sql
SELECT key FROM login_throttle WHERE key LIKE 'ip:%';
```

Your own address means it's right. A proxy's or a node's means it's too low, or that the proxy in front passes on its own address rather than the client's. Then send a wrong password with an address of your choosing: if `ip:192.0.2.1` appears, `TRUST_PROXY` is too high.

```bash
curl -s -H 'Content-Type: application/json' -H 'X-Forwarded-For: 192.0.2.1' \
  -d '{"login":"nobody","password":"wrong"}' https://a4a.example.com/api/v1/auth/login
```

### PostgreSQL

Bring your own: a managed one (Cloud SQL, Amazon RDS, Azure Database for PostgreSQL), or one an operator runs in the cluster with its backups and failover, such as CloudNativePG. These manifests ship no database: a StatefulSet running `postgres` has neither, and all of a4a's state is in it. Give a4a a database it owns, `DATABASE_URL` in the Secret, and room for its connections: replicas × (`DATABASE_POOL_SIZE` + 1), one more per replica while it starts, and the copy command's while it runs. Through a pooler, see [`LISTEN`](#postgresql-holds-the-state) above.

## Google Cloud Run

On Cloud Run, a4a is one service, with Cloud SQL for PostgreSQL, Secret Manager and Cloud Storage. `PROJECT` and `REGION` stand for yours; [`deploy/cloudrun/service.yaml`](../deploy/cloudrun/service.yaml) holds the same service as the commands below.

```bash
gcloud config set project PROJECT
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com
gcloud iam service-accounts create a4a --display-name="a4a on Cloud Run"
```

### 1. The image in Artifact Registry

```bash
gcloud artifacts repositories create a4a --repository-format=docker --location=REGION
gcloud auth configure-docker REGION-docker.pkg.dev
docker build --platform=linux/amd64 -t REGION-docker.pkg.dev/PROJECT/a4a/a4a:VERSION .
docker push REGION-docker.pkg.dev/PROJECT/a4a/a4a:VERSION
```

Cloud Run runs `linux/amd64` images, hence `--platform` on another kind of computer. Without Docker, Cloud Build builds it from the repository's root, once `cloudbuild.googleapis.com` is enabled too: `gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT/a4a/a4a:VERSION`.

### 2. Cloud SQL for PostgreSQL

```bash
gcloud sql instances create a4a-db --database-version=POSTGRES_16 --edition=enterprise \
  --tier=db-custom-1-3840 --region=REGION --backup-start-time=03:00 --enable-point-in-time-recovery
gcloud sql databases create a4a --instance=a4a-db
DB_PASSWORD=$(openssl rand -hex 24)
gcloud sql users create a4a --instance=a4a-db --password="$DB_PASSWORD"
gcloud projects add-iam-policy-binding PROJECT \
  --member=serviceAccount:a4a@PROJECT.iam.gserviceaccount.com --role=roles/cloudsql.client
```

The password is hex, so it needs no escaping in a URL. A user made this way belongs to `cloudsqlsuperuser`, which may create `pg_trgm`.

Cloud Run connects through its Cloud SQL connection, a Unix socket under `/cloudsql/PROJECT:REGION:a4a-db`. `DATABASE_URL` names that directory as its `host`:

```
postgres://a4a:<password>@/a4a?host=/cloudsql/PROJECT:REGION:a4a-db
```

Checked: a4a's driver (node-postgres) takes this form, colons in the path and all, and `LISTEN` and `NOTIFY` work over the socket: an issue made on one instance reached the other's live stream in about 50 milliseconds. The check put a socket in front of a local Postgres, as the Cloud SQL connection does; it wasn't Cloud SQL itself.

### 3. Secrets in Secret Manager

```bash
openssl rand -base64 32 | tr -d '\n' | gcloud secrets create a4a-secret-key --data-file=-
printf '%s' "postgres://a4a:$DB_PASSWORD@/a4a?host=/cloudsql/PROJECT:REGION:a4a-db" \
  | gcloud secrets create a4a-database-url --data-file=-
for s in a4a-secret-key a4a-database-url; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member=serviceAccount:a4a@PROJECT.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
done
```

The service takes them with `--set-secrets` (step 5). `SECRET_KEY` names version 1, never `latest`: a new version of that secret would be another key, and an instance starting on it couldn't open what the others sealed. Keep a copy of the key apart too (`gcloud secrets versions access 1 --secret=a4a-secret-key`).

### 4. Files in Cloud Storage

`DATA_DIR` on Cloud Run is the instance's own, and goes with it, so neither files on disk nor PGlite fit. Files go to a bucket, through Cloud Storage's S3 interoperability:

```bash
gcloud storage buckets create gs://PROJECT-a4a-files --location=REGION \
  --uniform-bucket-level-access --public-access-prevention
for role in roles/storage.objectUser roles/storage.legacyBucketReader; do
  gcloud storage buckets add-iam-policy-binding gs://PROJECT-a4a-files \
    --member=serviceAccount:a4a@PROJECT.iam.gserviceaccount.com --role="$role"
done
gcloud storage hmac create a4a@PROJECT.iam.gserviceaccount.com
```

The first role is for the files and their multipart uploads, the second for the bucket itself, which a4a looks up as it starts. The last command shows the HMAC key's access ID and its secret, the secret only then. Keep both in Secret Manager:

```bash
read -r HMAC_ID && read -rs HMAC_SECRET   # paste each, then Enter
printf '%s' "$HMAC_ID" | gcloud secrets create a4a-s3-access-key-id --data-file=-
printf '%s' "$HMAC_SECRET" | gcloud secrets create a4a-s3-secret-access-key --data-file=-
for s in a4a-s3-access-key-id a4a-s3-secret-access-key; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member=serviceAccount:a4a@PROJECT.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
done
```

Files a4a kept on disk before go to the bucket with the copy command, run where they are ([Files](#files)).

### 5. The service

```bash
gcloud run deploy a4a --region=REGION \
  --image=REGION-docker.pkg.dev/PROJECT/a4a/a4a:VERSION \
  --service-account=a4a@PROJECT.iam.gserviceaccount.com \
  --port=3000 \
  --add-cloudsql-instances=PROJECT:REGION:a4a-db \
  --set-env-vars=PUBLIC_URL=https://a4a.example.com,TRUST_PROXY=1,ATTACHMENT_STORAGE=s3,S3_BUCKET=PROJECT-a4a-files,S3_ENDPOINT=https://storage.googleapis.com,S3_REGION=auto,SEED_DEMO=false \
  --set-secrets=SECRET_KEY=a4a-secret-key:1,DATABASE_URL=a4a-database-url:latest,S3_ACCESS_KEY_ID=a4a-s3-access-key-id:latest,S3_SECRET_ACCESS_KEY=a4a-s3-secret-access-key:latest \
  --no-cpu-throttling --min-instances=1 --max-instances=4 \
  --concurrency=250 --timeout=3600 --cpu=1 --memory=1Gi \
  --allow-unauthenticated
```

Or, with the placeholders in `service.yaml` filled in:

```bash
gcloud run services replace deploy/cloudrun/service.yaml --region=REGION
gcloud run services add-iam-policy-binding a4a --region=REGION --member=allUsers --role=roles/run.invoker
```

Either way, everyone may reach the service: a4a signs people in itself.

### Background work: CPU at all times, and one instance at least

The server does its background work itself, on timers, between requests:

- **the outbox** (D5, D17), on the instance that holds the worker's lease, every 2 seconds and whenever something commits: webhooks, workflow rules, the AI's triage, notifications, the help desk's mail, chat posts, mentions, and sweeping files nothing points at;
- **mail**, and pushes and chat posts, sent from every instance, every 5 seconds;
- **rules and schedules**, on the lease holder: scheduled rules (what's due, every 15 seconds), SLA clocks (every minute), the day's digests;
- **IMAP polling** for the help desk, on the lease holder: the shared mailbox and each desk's own, every `HELPDESK_IMAP_POLL_SECONDS` (60);
- clearing what has expired: sessions, sign-in windows, challenges, old runs and logs.

By default Cloud Run gives an instance CPU only while it handles a request, and stops every instance when no requests come. Then the outbox, mail and rules wait for the next request, schedules and SLA clocks stand still, nobody reads the mailboxes, and the lease lapses between requests. So the service runs with:

- `--no-cpu-throttling`, CPU at all times (`run.googleapis.com/cpu-throttling: "false"` in the YAML);
- `--min-instances=1`, so an instance is always there to hold the lease (`autoscaling.knative.dev/minScale: "1"`).

That one instance is billed all the time.

### Other settings

- **The request timeout.** A live stream is a request that stays open, so it lasts until the timeout. `--timeout=3600` is the longest Cloud Run allows; then the browser reconnects, to any instance, and resumes after the last event it had.
- **`PORT`.** Cloud Run sets `PORT` to the container's port, 3000 here (`--port`), and a4a listens on `PORT` (checked: with `PORT=8080` it listened on 8080). Cloud Run keeps that variable to itself: don't set it.
- **Concurrency.** Cloud Run counts each open live stream as a request in flight: two for each open tab (the events and the inbox), three on a whiteboard. Its default of 80 for an instance fills with about 40 tabs, so the service takes 250 (`--concurrency`; 1000 at most).
- **Instances and connections.** Keep `--max-instances` × (`DATABASE_POOL_SIZE` + 1), plus one per instance while it starts, under the database's `max_connections`.
- **`TRUST_PROXY`.** `1` behind Cloud Run's own front end, at its `run.app` address or a domain mapping; `2` behind an external Application Load Balancer. Check it as [above](#trust_proxy).
- **Shutting down.** Cloud Run sends `SIGTERM` and allows 10 seconds, which is a4a's own limit.
- **Outbound mail.** Google Cloud blocks connections out to port 25. Put 587 (`smtp://…:587`, upgraded with STARTTLS) or 465 (`smtps://…:465`) in `SMTP_URL`.
- **Request size.** Cloud Run takes requests of up to 32 MiB from a server that speaks HTTP/1, as a4a does: files under `ATTACHMENT_MAX_MB` (20) and the help desk's mail pass, but a CSV import over 32 MiB doesn't.
- **A custom domain.** Passkeys are bound to the host they were made on (D62, "What it costs"): when a4a moves to another address, browsers don't offer them there, and everyone adds theirs again. So give a4a its own domain before people add passkeys, and set `PUBLIC_URL` to it from the first deploy. A domain mapping is the shortest way, `gcloud beta run domain-mappings create --service=a4a --domain=a4a.example.com --region=REGION`, then the DNS records it names; a global external Application Load Balancer with a serverless network endpoint group is the other (`TRUST_PROXY=2` then).

## Upgrades

A new version is a new image, rolled out as any other: a rolling update on Kubernetes, a new revision on Cloud Run.

1. Back up the database: migrations only go forward.
2. The new replica starts, takes the startup lock, and runs the new migrations in one transaction. The old replicas keep serving meanwhile.
3. Once it's ready, an old replica stops, and so on, each shutting down as above.

While old and new run side by side, they share everything in the database, sessions and the outbox among it, and live events pass between them. One of them, old or new, holds the worker's lease until it stops, and another takes it within a couple of seconds. The old replicas run on the new schema until they stop. Neither the code nor D17 says that migrations are written for that, so a4a doesn't promise it. So far every migration (41, from `0000_init` to `0040_passkeys`) adds tables, columns (each nullable or with a default), indexes and constraints, and none drops or renames anything, so old code has found the tables and columns it uses. Migrations hold their locks until their one transaction commits: while they run, the old replicas' work on the tables they change waits, which matters when one rewrites a large table or builds an index on it. When a release says its migrations change what an older version reads, stop the old replicas before the new one starts: scale to 0 first, or use `strategy: Recreate`.

A migration that fails rolls back whole, and the new replica doesn't start; with `maxUnavailable: 0`, the old ones keep serving. To go back after a migration has run, restore the backup.

## The first administrator

`ADMIN_LOGIN` and `ADMIN_PASSWORD`, with `ADMIN_EMAIL` if single sign-on is to find them by it, create the first administrator as the server starts, under the startup lock, so replicas that start together make one (checked: two instances, one administrator). Without them, the web app asks whoever opens it first to make one; at an address anyone can reach, that's anyone, so set them. They count only while there is no administrator: changing them later changes nothing, and they can go once you've signed in. With them, a4a also makes the demo projects, unless `SEED_DEMO` is `false`: its default is `true`, and no other word turns it off. Set it in production.

## Checking a deployment

- `GET /api/v1/health` from each replica says `"ok": true` and `"live": "listening"`, and `"worker": "active"` on exactly one.
- The [`TRUST_PROXY` check](#trust_proxy) finds your own address.
- A file uploaded through one replica opens through another.
- A passkey can be added at `PUBLIC_URL`.
