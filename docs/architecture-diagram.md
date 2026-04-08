# Architecture Diagram – Virallens GenAI Inference Platform

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              INTERNET / CLIENTS                                 │
│                         (Mobile Apps, Web, Partner APIs)                         │
└──────────────────────────────────┬──────────────────────────────────────────────┘
                                   │  HTTPS (TLS 1.3)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          GCP CLOUD ARMOR (WAF + DDoS)                           │
│                     Rate limiting · Geo-blocking · Bot detection                │
└──────────────────────────────────┬──────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      GCP GLOBAL LOAD BALANCER (L7 HTTPS)                        │
│              SSL termination · Path routing · Health checks                      │
│                  /api/v1/*  → GKE    |    /static/*  → GCS                      │
└──────────────────────────────────┬──────────────────────────────────────────────┘
                                   │
                                   ▼
┌─════════════════════════════════════════════════════════════════════════════════─┐
║                           VPC: virallens-vpc (10.0.0.0/16)                      ║
║                                                                                  ║
║  ┌────────────────────────────────────────────────────────────────────────────┐  ║
║  │                    PUBLIC SUBNET (10.0.1.0/24)                             │  ║
║  │                                                                            │  ║
║  │   ┌──────────────────┐    ┌──────────────────┐    ┌───────────────────┐   │  ║
║  │   │  Cloud NAT       │    │ Ingress Controller│    │ Bastion Host      │   │  ║
║  │   │  (egress only)   │    │ (NGINX)           │    │ (SSH jump, IAP)   │   │  ║
║  │   └──────────────────┘    └────────┬─────────┘    └───────────────────┘   │  ║
║  └────────────────────────────────────┼──────────────────────────────────────┘  ║
║                                       │                                          ║
║  ┌────────────────────────────────────┼──────────────────────────────────────┐  ║
║  │                    PRIVATE SUBNET (10.0.10.0/24)                           │  ║
║  │                                    ▼                                       │  ║
║  │  ┌════════════════════════════════════════════════════════════════════════┐│  ║
║  │  ║              GKE AUTOPILOT / STANDARD CLUSTER                         ║│  ║
║  │  ║                                                                        ║│  ║
║  │  ║  ┌─────────────────────────────────────────────────────────┐          ║│  ║
║  │  ║  │              NODE POOL: inference-pool                   │          ║│  ║
║  │  ║  │              (n2-standard-8, autoscale 3-50 nodes)       │          ║│  ║
║  │  ║  │                                                          │          ║│  ║
║  │  ║  │  ┌─────────┐ ┌─────────┐ ┌─────────┐     ┌─────────┐  │          ║│  ║
║  │  ║  │  │  Pod 1   │ │  Pod 2   │ │  Pod 3   │ ... │  Pod N   │  │          ║│  ║
║  │  ║  │  │ inference│ │ inference│ │ inference│     │ inference│  │          ║│  ║
║  │  ║  │  │ :3000    │ │ :3000    │ │ :3000    │     │ :3000    │  │          ║│  ║
║  │  ║  │  └─────────┘ └─────────┘ └─────────┘     └─────────┘  │          ║│  ║
║  │  ║  │                        ▲ HPA (CPU/memory/custom)        │          ║│  ║
║  │  ║  └─────────────────────────────────────────────────────────┘          ║│  ║
║  │  ║                                                                        ║│  ║
║  │  ║  ┌─────────────────────────────────────────────────────────┐          ║│  ║
║  │  ║  │              NODE POOL: gpu-pool (OPTIONAL)              │          ║│  ║
║  │  ║  │              (n1-standard-8 + NVIDIA T4, autoscale 0-10) │          ║│  ║
║  │  ║  │                                                          │          ║│  ║
║  │  ║  │  ┌──────────┐ ┌──────────┐                              │          ║│  ║
║  │  ║  │  │ GPU Pod 1 │ │ GPU Pod 2 │  (for heavy ML workloads)   │          ║│  ║
║  │  ║  │  └──────────┘ └──────────┘                              │          ║│  ║
║  │  ║  └─────────────────────────────────────────────────────────┘          ║│  ║
║  │  ╚════════════════════════════════════════════════════════════════════════╝│  ║
║  │                                                                            │  ║
║  │                    ┌──────────────┐    ┌──────────────┐                    │  ║
║  │                    │ Redis (Memorystore) │ Cloud SQL    │                    │  ║
║  │                    │ (request cache │    │ (PostgreSQL   │                    │  ║
║  │                    │  + rate limit) │    │  metadata)    │                    │  ║
║  │                    └──────────────┘    └──────────────┘                    │  ║
║  └────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                  ║
║  ┌────────────────────────────────────────────────────────────────────────────┐  ║
║  │                    DATA / STORAGE SUBNET (10.0.20.0/24)                    │  ║
║  │                                                                            │  ║
║  │   ┌──────────────┐    ┌──────────────┐    ┌───────────────────┐           │  ║
║  │   │ Cloud Storage │    │ Artifact      │    │ Secret Manager    │           │  ║
║  │   │ (GCS)         │    │ Registry      │    │ (API keys, creds) │           │  ║
║  │   │ models, docs  │    │ (Docker imgs) │    │                   │           │  ║
║  │   └──────────────┘    └──────────────┘    └───────────────────┘           │  ║
║  └────────────────────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════════════════════╝

┌─────────────────────────────────────────────────────────────────────────────────┐
│                        OBSERVABILITY & CI/CD (separate VPC peering)              │
│                                                                                  │
│  ┌────────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────────────────┐    │
│  │ Cloud       │  │ Prometheus +  │  │ PagerDuty │  │ Jenkins / ArgoCD       │    │
│  │ Monitoring  │  │ Grafana       │  │ (alerting)│  │ (CI/CD pipelines)      │    │
│  │ + Logging   │  │ (dashboards)  │  │           │  │                        │    │
│  └────────────┘  └──────────────┘  └──────────┘  └────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow (Request Lifecycle)

```
Client Request
     │
     ▼
[1] Cloud Armor (WAF) ──→ Block malicious traffic
     │
     ▼
[2] Global LB ──→ SSL terminate, route to healthy GKE backend
     │
     ▼
[3] NGINX Ingress ──→ Path-based routing, rate limiting
     │
     ▼
[4] K8s Service ──→ Load balance across inference pods
     │
     ▼
[5] Inference Pod
     ├── Check Redis cache (hit? → return cached result)
     ├── Run ML inference pipeline
     ├── Store result in cache
     └── Return structured JSON response
     │
     ▼
[6] Response ──→ Client (with X-Request-Id for tracing)
```

## CI/CD Flow

```
Developer Push
     │
     ▼
[1] Jenkins Pipeline triggered
     │
     ├── Lint + Test
     ├── Docker Build
     ├── Security Scan (Trivy)
     ├── Push to Artifact Registry
     │
     ▼
[2] Deploy to Staging (automated)
     │
     ├── Kustomize overlay applied
     ├── Smoke tests run
     │
     ▼
[3] Manual Approval Gate ◄── Platform team reviews
     │
     ▼
[4] Deploy to Production
     │
     ├── Rolling update (zero downtime)
     ├── Automatic rollback on failure
     └── Slack notification
```
