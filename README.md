# InferenceOps

Production-grade infrastructure for deploying a Generative AI inference service on GCP/GKE, handling 50-10,000 concurrent requests with auto-scaling, high availability, and cost efficiency.

Built for the Virallens GenAI platform assignment.

---

## Repository Structure

```
InferenceOps/
├── README.md                          <- You are here
├── docs/
│   ├── architecture-diagram.md        <- Part A: ASCII architecture diagram
│   ├── architecture-design.md         <- Part A: Infrastructure write-up
│   └── troubleshooting-response.md    <- Part C: Incident response
├── app/                               <- Sample Node.js inference service
│   ├── server.js                      <- Express API with Prometheus metrics
│   ├── package.json
│   ├── Dockerfile                     <- Multi-stage production build
│   └── .dockerignore
├── k8s/                               <- Part B: Kubernetes manifests (Kustomize)
│   ├── base/
│   │   ├── deployment.yaml            <- Deployment + ServiceAccount
│   │   ├── service.yaml               <- ClusterIP Service
│   │   ├── hpa.yaml                   <- HPA with custom metrics
│   │   ├── networkpolicy.yaml         <- Ingress/egress firewall rules
│   │   └── kustomization.yaml
│   └── overlays/
│       ├── dev/kustomization.yaml     <- Dev: 1 replica, relaxed resources
│       ├── staging/kustomization.yaml <- Staging: 2 replicas, moderate
│       └── prod/kustomization.yaml    <- Prod: 5 replicas, zone spread
├── helm/
│   └── virallens-inference/           <- Bonus: Helm chart
│       ├── Chart.yaml
│       ├── values.yaml                <- Default values
│       ├── values-{dev,staging,prod}.yaml
│       └── templates/
│           ├── deployment.yaml
│           ├── service.yaml
│           ├── hpa.yaml
│           └── networkpolicy.yaml
└── ci-cd/
    ├── Jenkinsfile                    <- Part B: Full CI/CD pipeline
    └── argocd/
        ├── application-staging.yaml   <- ArgoCD app (auto-sync)
        └── application-prod.yaml      <- ArgoCD app (manual sync)
```

---

## Part A: Infrastructure Design

### Architecture Overview

The platform is designed around **GKE (Google Kubernetes Engine)** with a layered security model:

```
Internet -> Cloud Armor (WAF) -> Global LB -> NGINX Ingress -> K8s Service -> Inference Pods
```

**Key design decisions**:
- **Private GKE cluster** in a custom VPC with no public IPs on worker nodes
- **HPA with custom metrics** (CPU + memory + active HTTP requests) for accurate ML workload scaling
- **Multi-zone pod spread** for HA - survives single zone failure
- **Cloud Armor WAF** for DDoS protection and rate limiting at the edge
- **NetworkPolicy** restricting pod-to-pod traffic to only ingress controller and monitoring

Full write-up: [`docs/architecture-design.md`](docs/architecture-design.md)
Architecture diagram: [`docs/architecture-diagram.md`](docs/architecture-diagram.md)

### Scaling Strategy (50 -> 10,000 Requests)

| Load Level | Pods | Nodes | Scaling Mechanism |
|------------|------|-------|-------------------|
| Low (50) | 3 (min) | 3 (min) | HPA baseline |
| Medium (500) | 5-10 | 3-5 | HPA scale-up on CPU + custom metrics |
| High (5,000) | 20-30 | 8-12 | HPA + Cluster Autoscaler adding nodes |
| Peak (10,000) | 40-50 | 15-20 | Full scale-out, aggressive HPA policy |

---

## Part B: Kubernetes + CI/CD

### Deploy with Kustomize

```bash
# Deploy to dev
kubectl apply -k k8s/overlays/dev

# Deploy to staging
kubectl apply -k k8s/overlays/staging

# Deploy to production
kubectl apply -k k8s/overlays/prod
```

### Deploy with Helm

```bash
# Dev
helm install virallens-inference helm/virallens-inference \
  -f helm/virallens-inference/values-dev.yaml -n virallens-dev

# Staging
helm install virallens-inference helm/virallens-inference \
  -f helm/virallens-inference/values-staging.yaml -n virallens-staging

# Production
helm install virallens-inference helm/virallens-inference \
  -f helm/virallens-inference/values-prod.yaml -n virallens-prod
```

### Environment Differences

| Config | Dev | Staging | Prod |
|--------|-----|---------|------|
| Replicas | 1 | 2 | 5 |
| HPA min/max | 1/3 | 2/10 | 5/50 |
| CPU request | 100m | 250m | 500m |
| Memory limit | 256Mi | 512Mi | 1Gi |
| NetworkPolicy | Disabled | Enabled | Enabled |
| Zone spread | No | No | Yes |
| Log level | debug | info | warn |

### CI/CD Pipeline (Jenkinsfile)

```
Lint -> Test -> Build Docker -> Push to Registry -> Security Scan -> Deploy Staging
  -> Smoke Tests -> Manual Approval -> Deploy Production -> Slack Notification
```

**Key features**:
- **Manual approval gate** before production deployment
- **Trivy security scan** on built images
- **Smoke tests** in staging before promotion
- **Automatic rollback** on failed rollout
- **Slack notifications** on success/failure

### ArgoCD (GitOps Alternative)

- **Staging**: Auto-sync enabled - merges to `main` auto-deploy to staging
- **Production**: Manual sync only - requires explicit approval in ArgoCD UI/CLI

---

## Part C: Troubleshooting Scenario

Full incident response: [`docs/troubleshooting-response.md`](docs/troubleshooting-response.md)

**Scenario**: p99 latency spiked from 200ms to 4.5s, 5% of requests returning 503, GPU at 98%.

| Phase | Summary |
|-------|---------|
| **Triage** | Check Grafana dashboards, `kubectl get pods/hpa`, recent deployments |
| **Diagnosis** | Traffic spike exceeding HPA, slow model version, GPU memory leak, downstream dependency failure |
| **Mitigation** | Scale pods manually, rate limit via Cloud Armor, rollback deploy, rolling restart |
| **Post-mortem** | Request queuing via Pub/Sub, canary deployments, load testing in CI, SLO burn-rate alerting |

---

## Application API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/healthz` | GET | Liveness probe |
| `/readyz` | GET | Readiness probe |
| `/metrics` | GET | Prometheus metrics |
| `/api/v1/inference` | POST | Single document inference |
| `/api/v1/inference/batch` | POST | Batch document inference |

### Example

```bash
curl -X POST http://localhost:3000/api/v1/inference \
  -H "Content-Type: application/json" \
  -d '{"document": "Analyze this document for entities and classification."}'
```

```json
{
  "requestId": "a1b2c3d4-...",
  "status": "completed",
  "processingTimeMs": 156,
  "output": {
    "summary": "Processed document (52 chars)",
    "entities": [
      {"type": "PERSON", "value": "Sample Entity", "confidence": 0.95}
    ],
    "classification": {
      "category": "general",
      "confidence": 0.92
    }
  }
}
```

---

## Build & Run Locally

```bash
# Run the app
cd app && npm install && npm start

# Build Docker image
docker build -t virallens-inference:local app/

# Run container
docker run -p 3000:3000 virallens-inference:local
```

---

## License

See [LICENSE](LICENSE) for details.
