# Part C: Incident Response – Latency Spike & 503 Errors

## Incident Summary

**Alert**: PagerDuty page at 11:00 PM
**Symptoms**:
- p99 latency spiked from 200ms → 4.5s (22.5x increase)
- 5% of requests returning 503 errors
- GPU utilization on inference nodes at 98%

---

## 1. Triage (First 5 Minutes)

### Immediate Actions

1. **Acknowledge the PagerDuty alert** and open an incident channel (`#inc-20260408-latency-spike`).

2. **Check the Service Health dashboard (Grafana)**:
   - Request rate — has traffic volume changed? Is this a traffic spike or a capacity regression?
   - Error rate breakdown — are 503s coming from the ingress (upstream timeout) or from pods (app crash)?
   - p50 vs p99 — if p50 is fine but p99 is spiked, a subset of requests are slow (likely queue saturation). If p50 is also high, the entire pipeline is degraded.

3. **Check infrastructure state**:
   - `kubectl get pods -n virallens-prod` — Are pods in CrashLoopBackOff, Pending, or OOMKilled?
   - `kubectl top pods -n virallens-prod` — Per-pod CPU/memory/GPU usage.
   - HPA status: `kubectl get hpa -n virallens-prod` — Has it hit maxReplicas? Is it scaling?
   - Node status: `kubectl get nodes` — Any nodes in NotReady? Are new nodes being provisioned?

4. **Check recent deployments**:
   - `kubectl rollout history deployment/virallens-inference -n virallens-prod` — Was there a deploy in the last hour?
   - ArgoCD sync history — Did a config change roll out?

### Tools and Dashboards

| Tool | What I'm Looking For |
|------|---------------------|
| **Grafana** (Service Health) | Request rate, error rate, latency percentiles, pod count |
| **Grafana** (Infrastructure) | CPU, memory, GPU utilization per node and pod |
| **Cloud Monitoring** | GKE cluster metrics, load balancer health check status |
| **Cloud Logging** | Application error logs filtered to last 30 min |
| **kubectl** | Pod status, events, HPA state, recent rollouts |
| **Cloud Trace** | Slow request traces to identify bottleneck stage |

---

## 2. Diagnosis – Likely Root Causes

### Root Cause 1: Traffic Spike Exceeding Capacity

**Hypothesis**: An unexpected surge in requests (e.g., viral content, bot traffic, partner integration spike) exceeded the HPA's ability to scale fast enough.

**How to Confirm**:
- Check request rate on Grafana — compare current vs. baseline (e.g., 10x normal).
- Check Cloud Armor logs for unusual traffic patterns (single IP, unusual geo distribution).
- Check HPA: `kubectl describe hpa virallens-inference -n virallens-prod` — Is it at `maxReplicas`? Are there `ScalingLimited` events?
- Check Cluster Autoscaler logs: `kubectl logs -n kube-system -l app=cluster-autoscaler` — Are nodes failing to provision (quota exceeded, insufficient capacity)?

### Root Cause 2: Model Performance Degradation

**Hypothesis**: A recently deployed model version is significantly slower than the previous one (e.g., larger model, unoptimized weights, missing batching).

**How to Confirm**:
- Check if a deployment happened in the last few hours (rollout history).
- Compare inference latency per model version using the `model_version` label on metrics.
- Review Cloud Trace: sort by duration, look at the inference processing stage specifically.
- Check `MODEL_VERSION` env var on running pods vs. the expected version.

### Root Cause 3: Resource Exhaustion (Memory Leak or GPU Memory)

**Hypothesis**: A memory leak or GPU memory fragmentation is causing pods to degrade over time. GPU at 98% suggests either legitimate saturation or a leak.

**How to Confirm**:
- Check pod age vs. performance: are older pods slower than recently started ones?
- GPU memory: `nvidia-smi` on the node (via `kubectl exec` or node SSH) — is GPU memory growing unbounded?
- Check for OOMKilled events: `kubectl get events -n virallens-prod --field-selector reason=OOMKilling`
- Application memory: check if Node.js heap size is growing (via `/metrics` endpoint — `process_heap_bytes`).

### Root Cause 4: Downstream Dependency Failure

**Hypothesis**: A dependency (Redis cache, Cloud SQL, external model API) is slow or unavailable, causing the inference pipeline to back up.

**How to Confirm**:
- Redis: Check Memorystore metrics — connection count, latency, eviction rate. If cache is down, every request hits the full inference pipeline (no cache shortcut).
- Cloud SQL: Check connection pool exhaustion, query latency, max connections.
- External API: If inference calls an external model API (e.g., Vertex AI), check that service's status page and latency.
- Cloud Trace: Look at span breakdown — which stage of the request is slow (cache lookup? inference? DB write?).

---

## 3. Mitigation – Immediate Stabilization

### Actions (Ordered by Impact)

1. **Scale up immediately** (bypass HPA wait):
   ```bash
   kubectl scale deployment/virallens-inference -n virallens-prod --replicas=30
   ```
   If at node capacity, manually increase the node pool max or trigger a scale-up:
   ```bash
   gcloud container clusters resize virallens-gke \
     --node-pool inference-pool --num-nodes 20 --zone us-central1-a
   ```

2. **Enable/tighten rate limiting** at the ingress layer:
   - If traffic is from a specific source: add a Cloud Armor rule to throttle that IP range.
   - If traffic is organic: reduce per-client rate limits to protect overall availability.

3. **Rollback if deployment-related**:
   ```bash
   kubectl rollout undo deployment/virallens-inference -n virallens-prod
   ```
   Faster than debugging a bad deploy. Roll back first, investigate later.

4. **Restart degraded pods** (if memory leak suspected):
   ```bash
   kubectl rollout restart deployment/virallens-inference -n virallens-prod
   ```
   This does a rolling restart — no downtime, clears leaked memory.

5. **Disable non-critical traffic**:
   - If batch inference endpoints are contributing to load, temporarily return 429 for `/api/v1/inference/batch`.
   - Redirect traffic to a secondary region if available.

6. **Increase connection pool / cache TTL**:
   - If Redis is available but cache miss rate is high, increase cache TTL to reduce inference load.
   - If Cloud SQL is bottlenecked, increase max connection pool size in the app config.

### Communication

- Update the incident channel with findings every 10 minutes.
- If customer-facing impact exceeds 15 minutes, post to the public status page.
- Notify stakeholders (product, support) via Slack with estimated resolution time.

---

## 4. Post-Mortem – Long-Term Prevention

### Immediate Follow-ups (Within 1 Week)

1. **Tune HPA for faster response**:
   - Reduce `stabilizationWindowSeconds` for scale-up from 30s to 15s.
   - Add a custom metric based on request queue depth or p99 latency — reactive to load shape, not just CPU.
   - Implement **KEDA** (Kubernetes Event-Driven Autoscaling) for more granular scaling triggers.

2. **Increase HPA maxReplicas** and node pool quotas:
   - If the HPA hit `maxReplicas`, raise the limit with appropriate GCP quota increases requested in advance.
   - Pre-provision 2-3 buffer nodes using low-priority pause pods for instant preemption.

3. **Add load testing to CI/CD**:
   - Run a k6 or Locust load test in staging before every production deploy.
   - Test at 2x expected peak (20,000 concurrent) to validate scaling behavior.

### Structural Changes (Within 1 Month)

4. **Implement request queuing with backpressure**:
   - Add a message queue (Pub/Sub or Cloud Tasks) between the API layer and inference workers.
   - The API returns `202 Accepted` with a callback URL. Inference workers pull from the queue at their own pace.
   - This decouples ingestion rate from processing rate — no more 503s during spikes.

5. **GPU auto-scaling improvements**:
   - Implement GPU utilization-based HPA (via DCGM exporter + Prometheus adapter).
   - Evaluate **GKE GPU time-sharing** to run multiple inference pods per GPU.

6. **Multi-region deployment**:
   - Deploy to a second GCP region (e.g., `europe-west1`) for geographic redundancy.
   - Global LB automatically routes traffic to the healthiest region.

7. **Canary deployments**:
   - Replace rolling updates with canary releases (Flagger or Argo Rollouts).
   - New versions serve 5% of traffic for 10 minutes. Auto-rollback if error rate or latency exceeds thresholds.

8. **Chaos engineering**:
   - Schedule monthly game days using Litmus Chaos or Chaos Monkey.
   - Simulate node failures, GPU exhaustion, and downstream dependency outages.
   - Validate that alerting, scaling, and runbooks work as expected.

### Process Improvements

9. **Runbook for this alert**:
   - Document this incident as a runbook in the on-call wiki.
   - Include the exact `kubectl` commands, Grafana dashboard links, and decision tree.
   - Automate the first 3 mitigation steps as a PagerDuty automation action.

10. **SLO burn-rate alerting**:
    - Move from threshold-based alerts to SLO burn-rate alerts.
    - A 10x burn rate over 5 minutes triggers a page before symptoms become user-visible.
    - This catches gradual degradation that threshold alerts miss.

---

## Incident Timeline (Template)

| Time | Action |
|------|--------|
| 23:00 | PagerDuty alert received. On-call acknowledges. |
| 23:02 | Grafana confirms p99 at 4.5s, 5% 503s. HPA at max replicas. |
| 23:05 | Identified: traffic 5x baseline + HPA maxed out at 50 pods. |
| 23:07 | Scaled node pool from 10 → 20 nodes. Increased HPA max to 80. |
| 23:10 | Cloud Armor rate limit applied: 100 req/s per client IP. |
| 23:15 | New nodes online. Pods scheduling. 503 rate dropping. |
| 23:20 | p99 latency back to 800ms. Error rate at 1.2%. |
| 23:30 | p99 at 250ms. Error rate at 0.1%. All clear. |
| 23:35 | Incident resolved. Post-mortem scheduled for next business day. |
