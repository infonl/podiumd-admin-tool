# Installing the PodiumD Admin Tool

This guide installs one Admin Tool Instance into the PodiumD namespace of one
Environment (ADR 0001) with the `podiumd-admin` Helm chart in
[charts/podiumd-admin/](../charts/podiumd-admin/). The examples use the
Municipality Onsdorp, its `test` Environment, the namespace `podiumd` and the
public hostname `admin.podiumd.onsdorp.example`. Replace them with your own.

You need:

- a Keycloak realm, the one the PodiumD Components use;
- a PostgreSQL server where you can create a database and two roles;
- `kubectl` and `helm` access to the PodiumD namespace;
- a public hostname, a DNS record for it and a TLS certificate, served by the
  Environment's Gateway (see [Route](#6-route-the-public-hostname)).

The steps, in order:

1. [Create the Keycloak client](#1-create-the-keycloak-client).
2. [Create the database and its two roles](#2-create-the-database-and-its-two-roles).
3. [Create the Secrets](#3-create-the-secrets).
4. [Write the values](#4-write-the-values).
5. [Install the chart](#5-install-the-chart).
6. [Route the public hostname](#6-route-the-public-hostname).

## 1. Create the Keycloak client

The Admin Tool signs users in as a confidential OpenID Connect client, using
the Authorization Code flow with PKCE (design D2). In the Keycloak admin
console, in the PodiumD realm, create a client under **Clients > Create
client**:

| Setting                                                          | Value                                                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| Client type                                                      | OpenID Connect                                                  |
| Client ID                                                        | `podiumd-admin` (this is `settings.oidc.clientId`)              |
| Client authentication                                            | On (a confidential client)                                      |
| Authorization                                                    | Off                                                             |
| Authentication flow                                              | **Standard flow** only; everything else off                     |
| Root URL                                                         | `https://admin.podiumd.onsdorp.example`                         |
| Valid redirect URIs                                              | exactly `https://admin.podiumd.onsdorp.example/auth/callback`   |
| Valid post logout redirect URIs                                  | exactly `https://admin.podiumd.onsdorp.example/signed-out`      |
| Web origins                                                      | empty: the Admin Tool sends no CORS requests                    |
| Front channel logout                                             | Off                                                             |
| Backchannel logout URL                                           | `https://admin.podiumd.onsdorp.example/auth/backchannel-logout` |
| Backchannel logout session required                              | On                                                              |
| Advanced > **Proof Key for Code Exchange Code Challenge Method** | **S256**                                                        |
| Advanced > Access Token Lifespan                                 | **5 minutes or less**                                           |

Why these values:

- **Exact redirect URIs, no wildcards.** A wildcard lets an attacker who
  controls another path on the host receive authorization codes. The
  Admin Tool builds both URIs from `settings.publicHostname`, never from
  request headers. If `publicHostname` has a port, the URIs include it.
- **PKCE S256.** The Admin Tool always sends a PKCE `code_challenge` with
  method S256. Setting the method on the client makes Keycloak **enforce**
  it: an authorization request without a challenge is then refused, instead
  of PKCE only being sent ([#52](https://github.com/infonl/podiumd-admin-tool/issues/52)).
- **Back-channel logout.** When a user's Keycloak session ends, Keycloak calls
  this URL and the Admin Tool ends the matching sessions at once. Keycloak
  calls it server to server, so the URL must be reachable from the Keycloak
  pods.
- **Access-token lifespan of 5 minutes or less.** Roles are read again at
  every token refresh (design D3), so a removed role stops working within one
  access-token lifespan.

Then:

1. On the **Roles** tab of the client, create two client roles: `viewer` and
   `operator`. Other names are possible; set them in `settings.auth.roles`.
   An Operator can do everything a Viewer can, plus the actions; a user
   without either role sees the "no access" page.
2. Assign the client roles to users or, better, to groups.
3. Keep the default client scope `roles` on the client. It puts the client
   roles into the access token as `resource_access.podiumd-admin.roles`, the
   claim the Admin Tool reads by default (`settings.auth.roleClaim` empty).
4. Copy the client secret from the **Credentials** tab for the next steps.

## 2. Create the database and its two roles

The Admin Tool keeps its Audit Log and sessions in its own PostgreSQL database,
with two roles (design D4):

- `podiumd_admin_owner` owns the schema. Only the migration Job uses it.
- `podiumd_admin_app` is what the running Admin Tool uses. The migrations
  grant it `SELECT` and `INSERT` on the Audit Log only, so it cannot change or
  delete Audit Entries. The migrations grant to this exact name, so keep it.

As a PostgreSQL superuser (or a role with `CREATEROLE` and `CREATEDB`), with
two generated passwords (for example `openssl rand -hex 32`):

```sql
CREATE ROLE podiumd_admin_owner LOGIN PASSWORD '<owner password>';
CREATE ROLE podiumd_admin_app LOGIN PASSWORD '<app password>';
CREATE DATABASE podiumd_admin OWNER podiumd_admin_owner;

-- Only the two roles may connect.
REVOKE ALL ON DATABASE podiumd_admin FROM PUBLIC;
GRANT CONNECT ON DATABASE podiumd_admin TO podiumd_admin_owner, podiumd_admin_app;
```

Then, connected to the new database (`\c podiumd_admin`):

```sql
-- The owner creates the tables; the app role may only use them.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO podiumd_admin_owner;
GRANT USAGE ON SCHEMA public TO podiumd_admin_app;
```

Do not grant the app role anything else: the migrations grant exactly what it
needs on each table.

## 3. Create the Secrets

The chart never creates Secrets; it only references them by name and key
(`existingSecret` and `key`). Create them in the PodiumD namespace before you
install.

**Database URLs.** One Secret per role, each with a `url` key holding a
PostgreSQL URL. `postgresql://` and `postgresql+psycopg://` are both accepted.
URL-encode a password that contains special characters, and require TLS when
the server supports it:

```sh
kubectl --namespace podiumd create secret generic podiumd-admin-db-app \
  --from-literal=url='postgresql://podiumd_admin_app:<app password>@postgres.onsdorp.example:5432/podiumd_admin?sslmode=require'
kubectl --namespace podiumd create secret generic podiumd-admin-db-owner \
  --from-literal=url='postgresql://podiumd_admin_owner:<owner password>@postgres.onsdorp.example:5432/podiumd_admin?sslmode=require'
```

**Keycloak client secret**, from the client's **Credentials** tab:

```sh
kubectl --namespace podiumd create secret generic podiumd-admin-oidc \
  --from-literal=client-secret='<client secret>'
```

**Session encryption keys.** The Admin Tool encrypts the stored tokens with
Fernet keys: 32 random bytes, url-safe base64-encoded. Generate a key with:

```sh
openssl rand -base64 32 | tr '+/' '-_'
```

```sh
kubectl --namespace podiumd create secret generic podiumd-admin-session \
  --from-literal=encryption-keys='<key>'
```

The value is a comma-separated list, the primary key first. To rotate, put a
new key in front (`<new key>,<old key>`) and restart the Admin Tool: new
tokens use the new key, while sessions encrypted with the old key keep
working. Remove the old key once its sessions have expired (after
`settings.session.maxLifetimeMinutes`). The Admin Tool refuses to start
without a key, and with the development key that ships for local use.

Restrict who can read these Secrets in the namespace: they give full access to
the Admin Tool's database and its Keycloak client.

## 4. Write the values

All application settings live under `settings`; `values.schema.json` refuses
an unknown or misspelled setting and names every missing required one. Secrets
are only references. A minimal `values-onsdorp-test.yaml`:

```yaml
image:
  # Pin the version you install, preferably with its digest.
  tag: '<version>@sha256:<digest>'

settings:
  environment:
    municipality: Onsdorp
    stage: test # test, accp or prod
    label: '' # optional, shown next to the Municipality and stage
  publicHostname: admin.podiumd.onsdorp.example
  oidc:
    issuer: https://keycloak.onsdorp.example/realms/podiumd
    clientId: podiumd-admin
    clientSecret:
      existingSecret: podiumd-admin-oidc
      key: client-secret
  database:
    app:
      existingSecret: podiumd-admin-db-app
      key: url
    owner:
      existingSecret: podiumd-admin-db-owner
      key: url
  session:
    encryptionKeys:
      existingSecret: podiumd-admin-session
      key: encryption-keys
  trustedProxies:
    - 10.244.0.0/16 # see "Trusted proxies" below
```

Optional settings, with their defaults:

| Value                                 | Default    | Meaning                                                                                  |
| ------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `settings.auth.roleClaim`             | `""`       | The dot-separated claim with the role names; empty is `resource_access.<clientId>.roles` |
| `settings.auth.roles.viewer`          | `viewer`   | The client role that grants the Viewer Role                                              |
| `settings.auth.roles.operator`        | `operator` | The client role that grants the Operator Role                                            |
| `settings.session.idleTimeoutMinutes` | `30`       | Minutes a session may be idle                                                            |
| `settings.session.maxLifetimeMinutes` | `480`      | Minutes a session may last; at most 720                                                  |
| `settings.trustedProxies`             | `[]`       | Proxies whose `X-Forwarded-For` header is trusted                                        |

Outside `settings`, the chart takes the common Kubernetes values with the names
PodiumD uses: `image`, `imagePullSecrets`, `global.imageRegistry`,
`resources`, `nodeSelector`, `tolerations`, `affinity`,
`topologySpreadConstraints`, `podLabels`, `podAnnotations`, `serviceAccount`,
`pdb`, `livenessProbe`, `readinessProbe`, `service`, `ingress` and `httpRoute`.
See [values.yaml](../charts/podiumd-admin/values.yaml). `extraEnvVars`,
`extraVolumes` and `extraVolumeMounts` add what the pods need beyond the
settings, for example a CA certificate for the database (with
`PGSSLROOTCERT`). An `extraEnvVars` entry cannot set a `PODIUMD_ADMIN_*`
variable: those belong in `settings`.

The security contexts cannot be weakened: the containers always run as a
non-root user with a read-only root filesystem, without privilege escalation
and with all capabilities dropped (ADR 0007). `replicaCount` is 1, or 0 to
stop the Admin Tool; never more (ADR 0010).

### Trusted proxies

The Admin Tool records the client IP address in every Audit Entry. Behind a
Gateway, the connecting peer is the Gateway pod, and the browser's address is
in the `X-Forwarded-For` header. The Admin Tool trusts that header only from
the addresses in `settings.trustedProxies`, and takes the right-most address
that is not a trusted proxy (design D2).

- **Empty (the default)** trusts no proxy: every Audit Entry records the
  Gateway pod's address. Safe, but less useful.
- **Set it to the addresses of the proxies in front of the Admin Tool**: the
  pod range of the NGINX Gateway Fabric pods in `ingress-basic`, and, when an
  Azure Application Gateway sits in front of it, that gateway's subnet as well.
  Keep the ranges as narrow as the cluster allows: any address in them can
  choose the client IP that is recorded. A `/0` range is refused.

## 5. Install the chart

```sh
helm upgrade --install podiumd-admin charts/podiumd-admin \
  --namespace podiumd \
  --values values-onsdorp-test.yaml
```

What happens:

1. Helm validates the values against the schema, and stops with a message that
   names each missing or invalid value.
2. The migration Job `podiumd-admin-migrations` (a `pre-install` and
   `pre-upgrade` hook) runs `alembic upgrade head` with the **owner**
   credentials. If it fails, the install or upgrade fails and the running
   version stays in place. A failed Job is kept for its logs:
   `kubectl --namespace podiumd logs job/podiumd-admin-migrations`.
3. The Deployment starts one pod with the **app** credentials. It becomes
   ready once `/readyz` reaches the database; `/healthz` reports that the
   process runs.

The chart creates a ServiceAccount, and a Role and RoleBinding in the release
namespace that grant only `get` on the chart's own ConfigMap. It creates no
cluster-wide RBAC (ADR 0011).

Where a NetworkPolicy engine is enforced, allow traffic from the Gateway to
the Admin Tool pods on port 8000, and from the Admin Tool and the migration
Job to PostgreSQL and Keycloak.

## 6. Route the public hostname

PodiumD Environments route public hostnames with Gateway API HTTPRoutes created
on the deploy side, on Gateway `public-gateway` in namespace `ingress-basic`.
The chart's Ingress and HTTPRoute are off by default for that reason. The
Admin Tool needs this route on the deploy side, next to the routes of the
other Components:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: hr-podiumd-admin
  namespace: ingress-basic
spec:
  parentRefs:
    - name: public-gateway
      namespace: ingress-basic
  hostnames:
    - admin.podiumd.onsdorp.example
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: podiumd-admin # the chart's Service (its full name)
          namespace: podiumd
          port: 80
```

A route in `ingress-basic` that sends traffic to a Service in `podiumd` needs
a ReferenceGrant in `podiumd` that allows it:

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: ingress-basic-to-podiumd-admin
  namespace: podiumd
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: ingress-basic
  to:
    - group: ''
      kind: Service
      name: podiumd-admin
```

The Admin Tool must be served over HTTPS: its session cookie is a
`__Host-` cookie, which browsers only accept over a secure connection.

If a cluster does not create routes on the deploy side, the chart can create
the HTTPRoute itself in the release namespace (`httpRoute.enabled: true`, with
`httpRoute.parentRefs`), provided the Gateway's listener allows routes from
that namespace. An Ingress is also available (`ingress.enabled: true`). Both
use `settings.publicHostname` as their host.

Once the route is in place, `https://admin.podiumd.onsdorp.example` shows the
Keycloak sign-in.
