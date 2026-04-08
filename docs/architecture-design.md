# Part A: Infrastructure Design – Write-up

## 1. Cloud Services Chosen and Why

| Layer | Service | Rationale |
|-------|---------|-----------|
| **Compute** | GKE Standard (with Autopilot option) | Native Kubernetes gives us fine-grained control over pod scheduling, GPU node pools, and HPA. GKE handles control plane management while we retain full configuration flexibility. |
| **Load Balancing** | GCP Global HTTP(S) Load Balancer | L7 load balancing with global anycast IPs, automatic SSL certificate management, and native health checking. Distributes traffic across multiple zones. |
| **WAF / DDoS** | Cloud Armor | Sits in front of the load balancer to enforce rate limits, geo-restrictions, and OWASP rule sets. Critical for a public API receiving 10k concurrent requests. |
| **Container Registry** | Artifact Registry | GCP-native, supports vulnerability scanning, IAM-based access control, and is co-located with GKE for fast pulls. |
| **Cache** | Memorystore (Redis) | Sub-millisecond latency for caching inference results and enforcing per-client rate limits. Fully managed, HA with automatic failover. |
| **Database** | Cloud SQL (PostgreSQL) | Stores request metadata, audit logs, and model versioning info. Managed backups, read replicas, and private VPC connectivity. |
| **Object Storage** | Cloud Storage (GCS) | Stores ML model artifacts, input documents, and batch job results. Lifecycle policies move cold data to Nearline/Coldline. |
| **Secrets** | Secret Manager | Centralized management of API keys, DB credentials, and model API tokens. Integrated with GKE via Workload Identity. |
| **Monitoring** | Cloud Monitoring + Prometheus/Grafana | Cloud Monitoring for GCP-native metrics and uptime checks. Prometheus for custom application metrics (p99 latency, inference throughput). Grafana for dashboards. |
| **Alerting** | PagerDuty (via Cloud Monitoring) | Tiered alerting: P1 pages on-call for 503 spikes or latency > 2s; P2 Slack alerts for elevated error rates. |

---

## 2. Networking and Security Design

### VPC Architecture

- **VPC**: `virallens-vpc` (`10.0.0.0/16`) with 3 subnets across 2 zones for HA.
  - **Public subnet** (`10.0.1.0/24`): Ingress controller, Cloud NAT, bastion host.
  - **Private subnet** (`10.0.10.0/24`): GKE nodes, Redis, Cloud SQL — **no public IPs**.
  - **Data subnet** (`10.0.20.0/24`): GCS, Artifact Registry endpoints via Private Google Access.

### Security Layers

1. **Cloud Armor WAF** – Blocks SQL injection, XSS, and volumetric attacks before traffic reaches the cluster.
2. **NetworkPolicy** – Kubernetes-level firewall: inference pods only accept traffic from the ingress controller and Prometheus. Egress locked to DNS + HTTPS to external model APIs.
3. **Workload Identity** – Pods authenticate to GCP services (GCS, Secret Manager) using Kubernetes service accounts mapped to GCP IAM — no JSON key files.
4. **Private GKE** – API server authorized networks restrict `kubectl` access to the bastion host and CI/CD runner IPs only.
5. **IAP (Identity-Aware Proxy)** – Bastion host access requires Google identity + IAM role; no SSH keys to manage.

### IAM Strategy

- **Least privilege**: Each service account (inference app, CI/CD, monitoring) has only the permissions it needs.
- **Workload Identity Federation**: CI/CD (Jenkins) authenticates to GCP via OIDC — no long-lived service account keys.
- **Separate projects for prod/non-prod**: Resource-level isolation prevents staging misconfigurations from affecting production.

### Ingress / Egress

- **Ingress**: Internet → Cloud Armor → Global LB → GKE Ingress (NGINX) → ClusterIP Service → Pods.
- **Egress**: Pods → Cloud NAT (single static IP for allowlisting by partners) → Internet. Internal traffic stays within VPC via Private Google Access.

---

## 3. Scaling Strategy: 50 vs 10,000 Concurrent Requests

### Multi-Layer Auto-Scaling

| Layer | Mechanism | Low Load (50 req) | High Load (10K req) |
|-------|-----------|--------------------|---------------------|
| **Pod** | HPA (CPU, memory, custom `active_requests` metric) | 3 pods (minimum) | Scales to 50 pods in ~2 min |
| **Node** | GKE Cluster Autoscaler | 3 nodes (min pool) | Adds nodes in ~90s to schedule pending pods |
| **Global** | Global LB health checks | Single zone active | Multi-zone, traffic split by proximity |

### Key Scaling Decisions

1. **Aggressive scale-up, conservative scale-down**: HPA scales up by 100% per minute but only scales down 25% every 2 minutes. This prevents flapping during bursty ML workloads.
2. **Custom metrics via Prometheus Adapter**: We scale on `active_requests` (in-flight HTTP connections), not just CPU. ML inference is often memory/GPU-bound, so CPU alone is a poor signal.
3. **Startup probe with generous timeout**: Model loading can take 30-60 seconds. The startup probe gives pods up to 60s before they enter the ready pool, preventing premature traffic routing.
4. **Pod Disruption Budget**: `minAvailable: 50%` ensures at least half the pods survive during node upgrades or scale-down events.
5. **Topology spread**: Production pods are spread across zones (`topology.kubernetes.io/zone`) so a single zone outage doesn't take down the service.

### Handling Burst Traffic

For sudden spikes (e.g., 50 → 5,000 in seconds):
- **NGINX rate limiting** at the ingress layer queues excess requests rather than returning 503 immediately.
- **Redis-based response caching** serves repeated document payloads without hitting the inference pipeline.
- **Overprovisioned pause pods**: Low-priority pods hold node capacity that real inference pods can preempt instantly, avoiding the 90s node provisioning delay.

---

## 4. Cost Optimization Considerations

| Strategy | Savings | Trade-off |
|----------|---------|-----------|
| **Spot/Preemptible VMs** for dev/staging node pools | ~60-70% on compute | 24-hour max lifetime; acceptable for non-prod |
| **Committed Use Discounts (CUDs)** for prod baseline nodes | ~30-57% | 1-3 year commitment on minimum node count |
| **GKE Autopilot** (alternative) | Pay per pod resource, no idle node cost | Less control over node configuration |
| **Cluster Autoscaler scale-to-zero** for GPU pool | 100% when idle | ~5 min cold start for first GPU request |
| **Redis cache** for repeated inferences | Reduces pod count needed by ~20-30% | Cache invalidation complexity |
| **Right-sizing** via VPA recommendations | 15-25% | Requires tuning after production traffic analysis |
| **GCS lifecycle policies** | Moves old model artifacts to Coldline | Retrieval latency for old versions |

### Cost Monitoring
- **GCP Billing budgets** with Slack alerts at 50%, 80%, 100% of monthly target.
- **Kubecost** or GKE cost allocation to attribute spend per namespace/team.
- Monthly right-sizing reviews using VPA recommendations and actual utilization data.

---

## 5. Monitoring and Alerting Approach

### Metrics Stack

```
App metrics (prom-client) → Prometheus → Grafana dashboards
GCP metrics               → Cloud Monitoring → PagerDuty/Slack
Logs                      → Cloud Logging → Log-based alerts
Traces                    → Cloud Trace (OpenTelemetry) → Latency analysis
```

### Key Dashboards

1. **Service Health**: Request rate, error rate (4xx/5xx), p50/p95/p99 latency.
2. **Infrastructure**: CPU/memory/GPU utilization, pod count, node count, HPA status.
3. **Business Metrics**: Inference throughput, model version distribution, cache hit rate.

### Alert Tiers

| Severity | Condition | Action |
|----------|-----------|--------|
| **P1 – Page** | p99 > 2s for 5 min, error rate > 5%, all pods unhealthy | PagerDuty page on-call |
| **P2 – Urgent** | p99 > 1s for 10 min, error rate > 2%, HPA at max | Slack #incidents + auto-create ticket |
| **P3 – Warning** | Elevated CPU > 80%, cache hit rate drop, certificate expiring in < 14d | Slack #monitoring |

### SLOs

- **Availability**: 99.9% (43.8 min/month error budget)
- **Latency**: p99 < 500ms for inference requests
- **Error rate**: < 0.1% 5xx responses

These SLOs are tracked via Prometheus recording rules and displayed on a burn-rate dashboard. When the error budget burn rate exceeds 10x normal, a P1 alert fires automatically.
