# Hosted MCP deployment pattern and staging runbook

This document has two purposes:

1. Capture the concrete AWS staging deployment of `carrieros-mcp` so it can be
   maintained without rediscovering its configuration and gotchas.
2. Record a reusable deployment pattern for future hosted MCP services,
   including the SX TMS MCP server. Reuse the principles and deployment shape;
   do not blindly copy CarrierOS-specific auth, tool authorization, or the
   current OAuth token implementation.

## Architecture decision

For a hosted remote MCP service, this project uses a small container running
the MCP SDK's Streamable HTTP transport behind an AWS ECS Express Mode public
HTTPS endpoint. The process is stateless between MCP requests: each `POST
/mcp` constructs a request-scoped MCP server and upstream API client, handles
one request, and discards them. `GET /health` is the container health check;
`GET` and `DELETE /mcp` return 405 because this deployment does not support
stateful sessions or server-initiated streams.

The HTTP entrypoint supports two ways to authenticate an upstream tenant:

- **OAuth remote clients (preferred when supported):** OAuth 2.1 authorization
  code with PKCE, public dynamic client registration, explicit user consent,
  and an encrypted token carrying the upstream API credential. MCP requests
  use `Authorization: Bearer ...`.
- **Per-request credential headers (compatibility path):** each MCP request
  sends upstream tenant credentials in `x-carrieros-*` headers. This can be
  useful with clients that do not implement remote MCP OAuth, but the client
  must be able to inject headers securely. Do not put credentials in URLs.

There is no tenant credential database. This reduces persisted sensitive data
and keeps request processing horizontally scalable, but places greater weight
on encryption-key management, token lifetime/revocation design, and avoiding
credential-bearing logs. The OAuth token format and upstream OAuth flow are
CarrierOS-specific and must not be copied to another product without review.

### Reuse assessment and hardening boundary

**Good reusable baseline:** isolated container; TLS at the public edge;
stateless Streamable HTTP request handling; request-scoped tenant context;
least-privilege upstream API credentials; explicit read-only consent; secrets
in Secrets Manager; container health checks; immutable image tags; and
protocol-level live verification after deployment.

**Current implementation is not a replay-resistant multi-replica OAuth
design:** `src/oauth-provider.ts` currently tracks consumed authorization-code
IDs in a process-local `Map`. Another ECS task does not see the consume, and
task restarts clear the map. The short-lived signed authorization-form token
is also not single-use. ECS is configured for up to two tasks, so this is a
current architecture limitation, not just a hypothetical concern. Do not
describe the existing provider as high-assurance, and do not assume sticky
sessions solve restart/replay semantics.

“Shared” here means shared by the MCP server's replicas, not shared between
users, LLMs, or tenants. Each authorization attempt gets a distinct random
state ID; a shared store lets whichever replica receives redemption perform
the same one-time consume check. Keep only opaque state IDs/status and expiry
in that store, not upstream client secrets or bearer tokens. This adds a
runtime dependency, cost, latency, availability coupling, TTL/cleanup and
monitoring work, and another secured resource to operate. If the store is down,
authorization should fail closed (clients can retry after recovery); a
store outage should not degrade into local-only replay checks. For a small
single-task service these costs may not justify adding infrastructure, but this
staging service can scale to two tasks, so process-local replay state is not
equivalent to global one-time use.

### Target design: shared one-time OAuth state

The target for the current AWS-hosted service—and a reusable pattern for the
SX TMS MCP server—is a small DynamoDB table with on-demand billing, one string
partition key (`state_id`), and a TTL attribute (`expires_at`). Use separate
opaque random IDs for the authorization-form nonce and the OAuth authorization
code's `jti`; namespace keys by purpose (for example `form#<nonce>` and
`code#<jti>`). Store only purpose and expiration, never client credentials,
authorization codes, tokens, PKCE values, or user data.

1. When issuing the signed authorization form token, create a random form nonce
   and write its state row with a conditional `PutItem` that fails if that ID
   already exists. Give the row the form-token expiry (currently 10 minutes).
2. On form submission, validate the CarrierOS Developer API credentials, then
   consume the form nonce with one conditional `DeleteItem` requiring the row
   to exist and `expires_at > now`. Only the request that deletes the row may
   continue to issue a code; retries/replays fail.
3. When issuing the authorization code, similarly write its `jti` row, with
   the code expiry (currently 5 minutes). Fail closed if the state write
   cannot be confirmed.
4. After the OAuth library has validated client, redirect URI, resource, and
   PKCE verifier, consume the code `jti` with the same conditional delete
   before creating access/refresh tokens. Two simultaneous exchanges or an
   exchange routed to a different task then have exactly one winner.

DynamoDB TTL deletion is asynchronous, so the conditional expiry check is
required even when TTL is enabled. Use a dedicated table per environment and
a **runtime ECS task role** limited to the required operations on that table;
do not broaden the task-execution role used for image/secret setup. The store
should be configured independently for staging and production, monitored for
throttling/errors, and fail closed if unavailable. DynamoDB is the recommended
option here because it provides a managed, single-item conditional operation
without requiring another always-on cache cluster. Redis `SET NX` with a TTL
or a vetted OAuth framework's shared replay store are valid alternatives if
they match the product's operations better.

This design adds AWS IAM/configuration and a network dependency, plus a small
per-attempt request cost and latency. It creates a central availability point
for starting/finishing OAuth flows; if the state table is unavailable,
authorization fails temporarily and users retry. Its benefit is simple,
replica-independent single-use semantics; it does **not** make credentials or
bearer tokens safe to expose, replace PKCE, authorize tool access, or handle
user logout/revocation by itself.

Before relying on OAuth across multiple tasks or calling this a production
hardening complete, replace the in-process map/form flow with this shared
atomic consume design (or a reviewed equivalent), then prove concurrent
redemption has exactly one success, replay fails across two tasks and after a
task restart, expiry fails even before background TTL cleanup, and datastore
failure denies authorization. Also review rate limiting, audit events, abuse
controls, key rotation, and credential revocation behavior.

The existing tokens are authenticated-encrypted with AES-256-GCM and include
the CarrierOS client secret. Anyone who steals a still-valid bearer token can
use the corresponding upstream access; protect tokens as credentials. Rotating
`MCP_OAUTH_ENCRYPTION_KEY` invalidates registrations and issued tokens. Current
access-token lifetime is one hour and refresh-token lifetime is 30 days. The
upstream Developer API credential remains revocable in CarrierOS.

For the SX TMS, keep the transport/deployment shell but define a separate
upstream auth adapter, tenant scoping model, tool allowlist, read/write policy,
consent text, and credential lifecycle. Start with read-only tools unless a
specific write workflow and its confirmation/audit semantics have been
designed. Never treat authentication alone as authorization: every tool must
enforce organization/tenant scope at the upstream API boundary.

## Staging deployment: current facts

Last checked against AWS ECS on 2026-09-30.

**Now managed by infrastructure-as-code.** This service is defined in AWS CDK in the
`carrieros` repo at `infra/lib/staging-stack.ts`, not created by hand — read
`carrieros/architecture/infrastructure-as-code.md` before changing it, and make
changes there rather than with `aws` CLI calls, or the next `cdk deploy` will revert
them. The original hand-built `carrieros-mcp-staging` still exists but is superseded
and pending decommission.

| Item | Staging value |
|---|---|
| AWS region / account | `us-east-1` / `308855860393` |
| ECS cluster | `default` |
| ECS Express service | `carrieros-mcp-staging-cdk` (CDK-managed) |
| Public HTTPS origin | `https://ca-f68d8ab0d62b4f638db9eaec01052b4f.ecs.us-east-1.on.aws` |
| MCP endpoint | `https://ca-f68d8ab0d62b4f638db9eaec01052b4f.ecs.us-east-1.on.aws/mcp` |
| ECR repository | `308855860393.dkr.ecr.us-east-1.amazonaws.com/carrieros-mcp` |
| Active image | `carrieros-mcp:latest` |
| Container port / health path | `3000` / `/health` |
| CPU / memory | `512` CPU units / `1024` MiB |
| Task range | min `0`, max `1`; CPU target `60%` — min 0 means it will NOT serve until `carrieros/scripts/staging-resume.sh` is run (see below) |
| Log group | `/aws/ecs/default/carrieros-mcp-staging-cdk` |
| Upstream CarrierOS staging | `https://ca-4f7c487503aa47609a79a96746866bb8.ecs.us-east-1.on.aws` |
| OAuth key secret | `carrieros-staging/MCP_OAUTH_ENCRYPTION_KEY` in Secrets Manager |
| Task execution role | `carrieros-ecsTaskExecutionRole` |
| Infrastructure role | `carrieros-ecsInfrastructureRole` |
| Deployment automation | Manual ECR build/push + ECS service update; no MCP CodeBuild pipeline |
| Production | Not configured |

The execution role has an inline `ReadCarrierOsMcpOauthKey` permission scoped
to the OAuth encryption secret. The task receives only the secret reference;
the key itself must never be placed in this repository, a build argument, or
deployment notes. The active configuration reads `MCP_PUBLIC_URL` and
`CARRIEROS_BASE_URL` as environment settings and injects
`MCP_OAUTH_ENCRYPTION_KEY` from Secrets Manager.

The ECS deployment and real MCP `list_vehicles` call were verified against
staging CarrierOS data on 2026-09-29. This proves the deployed HTTP path and
upstream public API call; it is distinct from verifying every external LLM
client's OAuth UX and account-level MCP support.

## Reusable deployment checklist

### 1. Container and service contract

- Build a production-only container for the HTTP entrypoint (not stdio).
- Run as a non-root user and bind an unprivileged container port.
- Provide a cheap unauthenticated liveness/health endpoint that does not leak
  config or depend on a downstream service being temporarily healthy.
- Make the MCP resource URL, upstream base URL, port, and deployment mode
  explicit configuration. Validate public URLs and require HTTPS outside local
  development.
- Choose stateless request/response transport unless the product genuinely
  needs server-to-client streaming or persistent MCP sessions. If stateful,
  design shared session storage and load-balancer behavior first.
- Set a non-zero minimum task count when the platform scales only on CPU; CPU
  autoscaling cannot wake a service from zero without a request-based scaler.

### 2. Tenant and security design

- Choose a supported client auth mechanism (OAuth 2.1 + PKCE for remote
  clients where possible; secure header injection only as a deliberate
  compatibility option).
- Bind every authenticated identity to a validated tenant and least-privilege
  upstream identity. Re-check tenant scope inside each upstream operation.
- Keep secrets out of images, source control, client-visible URLs, logs,
  exception bodies, and telemetry. Inject server secrets from a secret manager
  using a least-privilege task execution role.
- If credentials are placed in encrypted bearer tokens, document the key
  generation/storage/rotation procedure, expiry, revocation, and blast radius.
  For multi-replica OAuth, authorization-code single-use/replay state must use
  a shared atomic store or equivalent—not only process memory.
- Add rate limiting, security/audit logs without credential values, and an
  explicit tool authorization policy before broader or write-capable rollout.

### 3. Build and deploy

Provision ECR, the ECS Express service, networking/HTTPS, log group, scaling,
task execution/infrastructure roles, and secret references once. Keep the
application deployment role narrowly scoped. For every release:

1. Build for the runtime architecture (`linux/amd64` for this Fargate service;
   Apple Silicon developers must specify it explicitly).
2. Tag the image with the source commit SHA (not only `latest`) and push it to
   the service's ECR repository.
3. Update the ECS Express service's primary container to the new image and
   expected container port. Updating an existing tag in ECR alone does not
   force ECS to replace running tasks.
4. Wait for the new ECS service deployment to reach a successful terminal
   state. An accepted update request is not proof of a successful rollout.
5. Verify the live service before considering release complete.

Example for an already-provisioned service (fill these placeholders from the
target environment; do not copy staging values into another product):

```bash
export AWS_REGION="us-east-1"
export AWS_ACCOUNT_ID="REPLACE_WITH_ACCOUNT_ID"
export ECR_REPOSITORY="REPLACE_WITH_MCP_ECR_REPOSITORY"
export ECS_SERVICE_ARN="REPLACE_WITH_EXPRESS_SERVICE_ARN"
export IMAGE_TAG="$(git rev-parse --short=7 HEAD)"
export ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"

aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin \
    "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

docker buildx build --platform linux/amd64 \
  --tag "${ECR_URI}:${IMAGE_TAG}" --push .

aws ecs update-express-gateway-service \
  --service-arn "$ECS_SERVICE_ARN" \
  --primary-container "{\"image\":\"${ECR_URI}:${IMAGE_TAG}\",\"containerPort\":3000}" \
  --region "$AWS_REGION"
```

These commands push and request a rollout; follow the target service's ECS
deployment status until success, then run the checks below. Avoid putting
credentials or secret values in these shell variables or command arguments.

### 4. Verify protocol behavior, not just infrastructure status

- `GET /health` returns HTTP 200 and only a non-sensitive status payload.
- `POST /mcp` without credentials returns HTTP 401 (and, when OAuth is
  configured, a `WWW-Authenticate` resource-metadata challenge).
- The protected-resource and authorization-server metadata are reachable and
  advertise the intended public origin; dynamic registration succeeds for
  public clients if it is enabled.
- Complete an authorization-code + PKCE flow using a non-production test
  tenant; validate credentials server-side before issuing the grant.
- Perform `initialize`, enumerate tools, and call at least one safe read-only
  tool against representative staging data. Confirm tenant isolation and
  expected denial behavior for a deliberately unauthorized operation.
- Confirm no credentials or access tokens appear in service logs.
- Check the live app/version endpoint and the ECS deployment's image digest or
  commit tag. A green build, pushed image, or successful update API call alone
  does not prove that traffic reaches the intended revision.

## CarrierOS staging release notes and gotchas

- `minTaskCount: 0` did not scale back up: ECS Express here uses CPU-based
  autoscaling, which has no running task from which to measure CPU. Keep
  `minTaskCount: 1` unless a request-driven scale-from-zero mechanism is added.
- A new `*.ecs.*.on.aws` endpoint's DNS may lag a successful AWS API response
  by several minutes. A just-created hostname failing resolution immediately
  is not by itself proof that the container/service failed.
- The ECS image port is 3000 and health check path is `/health`.
- The CarrierOS app must itself have the staging Public Developer API signing
  secret configured; MCP deployment health does not prove upstream API
  authorization works. A real MCP tool call caught this missing upstream
  staging config during initial integration.
- The upstream OAuth actor intentionally has finance-level capabilities.
  `list_drivers` is not exposed because the public API denies that capability;
  do not widen authorization from the MCP layer to bypass that decision.
- There is no production deployment and no automated MCP image pipeline yet.
  Until a pipeline is deliberately built and verified, deployments are manual.

## References

- [MCP repo README](../README.md) — local setup, tools, and LLM client connection.
- [Architecture walkthrough](how-it-was-built.md) — code structure and request paths.
- [CarrierOS deployment guide](https://github.com/gsanjeevs/carrieros/blob/main/architecture/deployment.md)
  — upstream application/Supabase staging dependencies.
