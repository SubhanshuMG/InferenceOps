# InferenceOps on AWS — Step-by-Step Build Guide

> End-to-end guide to rebuild the InferenceOps GenAI inference platform from scratch in your AWS account using EKS. Translated from the original GCP/GKE design.

**Estimated time:** ~2–3 hours the first time, ~30 min teardown.
**Estimated cost:** ~$3–5/day with a 3-node `t3.medium` setup. **Tear down when done.**

---

## Phase 0 — Prerequisites

### Install tools locally

```bash
brew install awscli eksctl kubectl helm kustomize jq
brew install --cask docker
```

### AWS account setup

```bash
aws configure                           # set access key, secret, default region
aws sts get-caller-identity             # sanity check
```

### Set environment variables

```bash
export AWS_REGION=ap-south-1
export CLUSTER_NAME=virallens-gke           # keep the name for the interview story
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REPO=virallens/inference-service
```

---

## Phase 1 — Create the ECR repository

```bash
aws ecr create-repository \
  --repository-name $ECR_REPO \
  --region $AWS_REGION \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256
```

Grab the URI:

```bash
export ECR_URI=$(aws ecr describe-repositories \
  --repository-names $ECR_REPO \
  --query 'repositories[0].repositoryUri' --output text)
echo $ECR_URI
# e.g. 123456789012.dkr.ecr.ap-south-1.amazonaws.com/virallens/inference-service
```

---

## Phase 2 — Build and push the app image

From the repo root:

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region $AWS_REGION && docker login --username AWS --password-stdin $ECR_URI

# Build for amd64 (important if you're on Apple Silicon)
cd app
docker buildx build --platform linux/amd64 \
  -t $ECR_URI:v1.0.0 \
  -t $ECR_URI:latest \
  --push .
cd ..
```
```bash
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_URI
```

```bash
docker tag e9ae3c220b23 aws_account_id.dkr.ecr.region.amazonaws.com/my-repository:tag
```

```bash
docker push aws_account_id.dkr.ecr.region.amazonaws.com/my-repository:tag
```

Verify:

```bash
aws ecr describe-images --repository-name $ECR_REPO --region $AWS_REGION
```

---

## Phase 3 — Create the EKS cluster

Create a cluster config file (fastest way to get VPC + nodes + OIDC + IAM in one shot):

```bash
cat > cluster-config.yaml <<EOF
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig

metadata:
  name: ${CLUSTER_NAME}
  region: ${AWS_REGION}
  version: "1.30"

iam:
  withOIDC: true                    # <-- enables IRSA

vpc:
  cidr: 10.0.0.0/16
  nat:
    gateway: Single                 # Single NAT for cost; use HighlyAvailable for prod
  clusterEndpoints:
    publicAccess: true              # dev; set false + authorizedNetworks for prod
    privateAccess: true

managedNodeGroups:
  - name: general
    instanceType: t3.medium
    desiredCapacity: 3
    minSize: 3
    maxSize: 10
    volumeSize: 30
    privateNetworking: true         # nodes get no public IPs
    labels: { role: general }
    tags:
      environment: dev
    iam:
      withAddonPolicies:
        albIngress: true
        autoScaler: true
        cloudWatch: true
        externalDNS: true
        ebs: true

addons:
  - name: vpc-cni
  - name: coredns
  - name: kube-proxy
  - name: aws-ebs-csi-driver

cloudWatch:
  clusterLogging:
    enableTypes: ["api", "audit", "authenticator", "controllerManager", "scheduler"]
EOF

eksctl create cluster -f cluster-config.yaml
```

This takes ~15–20 minutes. It creates:

- VPC with public + private subnets across 3 AZs
- NAT gateway for egress
- EKS control plane with OIDC provider (required for IRSA)
- Managed node group with 3 nodes in private subnets
- IAM roles for the cluster and nodes

Verify:

```bash
kubectl get nodes
kubectl get pods -A
aws eks describe-cluster --name $CLUSTER_NAME --query 'cluster.identity.oidc.issuer' --output text
```

---

## Phase 4 — Install core platform controllers

### 4a. metrics-server (required for HPA)

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system rollout status deploy/metrics-server
```

### 4b. AWS Load Balancer Controller (handles Ingress → ALB)

Create the IAM policy and IRSA:

```bash
curl -O https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.2/docs/install/iam_policy.json

aws iam create-policy \
  --policy-name AWSLoadBalancerControllerIAMPolicy \
  --policy-document file://iam_policy.json

eksctl create iamserviceaccount \
  --cluster=$CLUSTER_NAME \
  --namespace=kube-system \
  --name=aws-load-balancer-controller \
  --role-name AmazonEKSLoadBalancerControllerRole \
  --attach-policy-arn=arn:aws:iam::${ACCOUNT_ID}:policy/AWSLoadBalancerControllerIAMPolicy \
  --approve
```

Install via Helm:

```bash
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=$CLUSTER_NAME \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller
```

### 4c. Cluster Autoscaler (node scaling)

```bash
eksctl create iamserviceaccount \
  --cluster=$CLUSTER_NAME \
  --namespace=kube-system \
  --name=cluster-autoscaler \
  --attach-policy-arn=arn:aws:iam::aws:policy/AutoScalingFullAccess \
  --approve

helm repo add autoscaler https://kubernetes.github.io/autoscaler
helm install cluster-autoscaler autoscaler/cluster-autoscaler \
  -n kube-system \
  --set autoDiscovery.clusterName=$CLUSTER_NAME \
  --set awsRegion=$AWS_REGION \
  --set rbac.serviceAccount.create=false \
  --set rbac.serviceAccount.name=cluster-autoscaler
```

### 4d. Prometheus + Grafana (for custom metrics + dashboards)

```bash
kubectl create namespace monitoring

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install kube-prom prometheus-community/kube-prometheus-stack \
  -n monitoring \
  --set grafana.adminPassword='admin123' \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false
```

### 4e. Prometheus Adapter (custom metrics for HPA)

This is what enables the `active_requests` custom metric HPA:

```bash
helm install prom-adapter prometheus-community/prometheus-adapter \
  -n monitoring \
  --set prometheus.url=http://kube-prom-kube-prometheus-prometheus.monitoring.svc \
  --set prometheus.port=9090
```

---

## Phase 5 — Create IRSA for the inference pods

This is the AWS equivalent of the `ServiceAccount` in `k8s/base/deployment.yaml`. The pod will assume this role to read secrets, write to S3, etc.

```bash
# Create namespaces
kubectl create namespace virallens-dev
kubectl create namespace virallens-staging
kubectl create namespace virallens-prod

# Create the IRSA (pod's IAM role)
eksctl create iamserviceaccount \
  --cluster=$CLUSTER_NAME \
  --namespace=virallens-prod \
  --name=virallens-inference \
  --role-name=VirallensInferencePodRole \
  --attach-policy-arn=arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess \
  --attach-policy-arn=arn:aws:iam::aws:policy/SecretsManagerReadWrite \
  --approve \
  --override-existing-serviceaccounts
```

> In real prod, replace those managed policies with a scoped inline policy. Managed policies are used here for speed.

---

## Phase 6 — Adapt the Kustomize manifests for AWS

The repo is GCR-based. You need to point it at ECR. Do this as a local overlay patch (don't hand-edit the base):

```bash
# From repo root
cd k8s/overlays/dev

# Point Kustomize at the ECR image
kustomize edit set image gcr.io/virallens/inference-service=${ECR_URI}:v1.0.0
```

**One gotcha** — the `networkpolicy.yaml` references `ingress-nginx` namespace but on AWS you're using the ALB Controller (no ingress-nginx). Either:

- Disable NetworkPolicy in the dev overlay (it's already disabled per the README table), or
- Patch it to reference `kube-system` where the ALB controller lives.

For the first deploy, stick with the dev overlay which has NetworkPolicy disabled.

Deploy:

```bash
cd ../..                # back to repo root
kubectl apply -k k8s/overlays/dev -n virallens-dev

kubectl -n virallens-dev get pods,svc,hpa
kubectl -n virallens-dev rollout status deploy/virallens-inference
```

---

## Phase 7 — Expose the service via ALB Ingress

Create an Ingress resource (the GCP version used NGINX Ingress — AWS uses ALB via annotations):

```bash
cat > ingress-dev.yaml <<EOF
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: virallens-inference
  namespace: virallens-dev
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/healthcheck-path: /healthz
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80}]'
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: virallens-inference
                port:
                  number: 80
EOF

kubectl apply -f ingress-dev.yaml
```

Wait ~2 minutes, then get the ALB URL:

```bash
kubectl -n virallens-dev get ingress virallens-inference \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
```

Test it:

```bash
ALB=$(kubectl -n virallens-dev get ingress virallens-inference -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

curl http://$ALB/healthz
curl -X POST http://$ALB/api/v1/inference \
  -H "Content-Type: application/json" \
  -d '{"document":"test document"}'
```

---

## Phase 8 — Wire up the custom HPA metric

The `hpa.yaml` uses `active_requests` — Prometheus is already scraping it (the deployment has the `prometheus.io/scrape` annotation). You need to tell the Prometheus Adapter to expose it as a K8s custom metric.

Create an adapter config:

```bash
cat > adapter-values.yaml <<EOF
prometheus:
  url: http://kube-prom-kube-prometheus-prometheus.monitoring.svc
  port: 9090
rules:
  custom:
    - seriesQuery: 'active_requests{namespace!="",pod!=""}'
      resources:
        overrides:
          namespace: { resource: "namespace" }
          pod: { resource: "pod" }
      name:
        matches: "^(.*)"
        as: "\$1"
      metricsQuery: 'avg by (<<.GroupBy>>) (<<.Series>>{<<.LabelMatchers>>})'
EOF

helm upgrade prom-adapter prometheus-community/prometheus-adapter \
  -n monitoring -f adapter-values.yaml
```

Verify the custom metric is exposed:

```bash
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/virallens-dev/pods/*/active_requests" | jq
```

Check the HPA:

```bash
kubectl -n virallens-dev get hpa virallens-inference -w
```

---

## Phase 9 — CI/CD with GitHub Actions (OIDC, no keys)

Skip Jenkins for a personal AWS setup — use GitHub Actions with OIDC so there are no long-lived keys anywhere.

### 9a. Create the OIDC provider in AWS (one-time, per account)

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

### 9b. Create the deployer role

```bash
cat > trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
      },
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:<your-gh-user>/InferenceOps:*"
      }
    }
  }]
}
EOF

aws iam create-role \
  --role-name GitHubActionsEKSDeployer \
  --assume-role-policy-document file://trust-policy.json

# Attach permissions — in real life, use a scoped policy
aws iam attach-role-policy \
  --role-name GitHubActionsEKSDeployer \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser

aws iam attach-role-policy \
  --role-name GitHubActionsEKSDeployer \
  --policy-arn arn:aws:iam::aws:policy/AmazonEKSClusterPolicy
```

### 9c. Grant the role access inside the cluster (EKS access entries)

```bash
aws eks create-access-entry \
  --cluster-name $CLUSTER_NAME \
  --principal-arn arn:aws:iam::${ACCOUNT_ID}:role/GitHubActionsEKSDeployer

aws eks associate-access-policy \
  --cluster-name $CLUSTER_NAME \
  --principal-arn arn:aws:iam::${ACCOUNT_ID}:role/GitHubActionsEKSDeployer \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster
```

### 9d. Create `.github/workflows/deploy.yml`

```yaml
name: Build & Deploy
on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

env:
  AWS_REGION: ap-south-1
  CLUSTER_NAME: virallens-gke
  ECR_REPO: virallens/inference-service

jobs:
  build-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<ACCOUNT_ID>:role/GitHubActionsEKSDeployer
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag, push
        run: |
          IMAGE=${{ steps.ecr.outputs.registry }}/$ECR_REPO:${{ github.sha }}
          docker build -t $IMAGE -t ${{ steps.ecr.outputs.registry }}/$ECR_REPO:latest app/
          docker push $IMAGE
          docker push ${{ steps.ecr.outputs.registry }}/$ECR_REPO:latest
          echo "IMAGE=$IMAGE" >> $GITHUB_ENV

      - name: Update kubeconfig
        run: aws eks update-kubeconfig --name $CLUSTER_NAME --region $AWS_REGION

      - name: Deploy to staging via Kustomize
        run: |
          cd k8s/overlays/staging
          kustomize edit set image gcr.io/virallens/inference-service=$IMAGE
          kustomize build . | kubectl apply -n virallens-staging -f -
          kubectl -n virallens-staging rollout status deploy/virallens-inference --timeout=120s

      - name: Smoke test
        run: |
          kubectl -n virallens-staging run smoke --rm -i --restart=Never --image=curlimages/curl \
            -- curl -sf http://virallens-inference/healthz
```

---

## Phase 10 — Observability + WAF

### Grafana access

```bash
kubectl -n monitoring port-forward svc/kube-prom-grafana 3000:80
# Open http://localhost:3000  (admin / admin123)
```

Import dashboard IDs: **6417** (K8s pods), **315** (K8s cluster). Create a custom dashboard for `inference_requests_total` + `http_request_duration_seconds`.

### AWS WAF (Cloud Armor equivalent) on the ALB

```bash
# Create a simple rate-limit WebACL
aws wafv2 create-web-acl \
  --name virallens-inference-waf \
  --scope REGIONAL \
  --default-action Allow={} \
  --visibility-config SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=virallensWAF \
  --rules '[{"Name":"RateLimit","Priority":1,"Statement":{"RateBasedStatement":{"Limit":2000,"AggregateKeyType":"IP"}},"Action":{"Block":{}},"VisibilityConfig":{"SampledRequestsEnabled":true,"CloudWatchMetricsEnabled":true,"MetricName":"RateLimit"}}]' \
  --region $AWS_REGION
```

Then attach it to the ALB via the Ingress annotation:

```yaml
alb.ingress.kubernetes.io/wafv2-acl-arn: arn:aws:wafv2:...
```

---

## Phase 11 — Load test to prove scaling works

```bash
# Install k6 locally
brew install k6

cat > loadtest.js <<'EOF'
import http from 'k6/http';
import { sleep } from 'k6';
export const options = {
  stages: [
    { duration: '1m', target: 50 },
    { duration: '2m', target: 500 },
    { duration: '2m', target: 2000 },
    { duration: '2m', target: 0 },
  ],
};
export default function () {
  http.post(`http://${__ENV.ALB}/api/v1/inference`,
    JSON.stringify({ document: 'load test' }),
    { headers: { 'Content-Type': 'application/json' } });
  sleep(0.1);
}
EOF

ALB=$(kubectl -n virallens-dev get ingress virallens-inference -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
k6 run -e ALB=$ALB loadtest.js
```

Watch scaling in another terminal:

```bash
watch -n 2 'kubectl -n virallens-dev get hpa,pods,nodes'
```

You should see pods scale from 1 → 10+ and cluster autoscaler provisioning new nodes at around 1500 RPS.

---

## Phase 12 — Teardown (DO THIS to avoid bills)

```bash
# 1. Delete app resources
kubectl delete -k k8s/overlays/dev -n virallens-dev
kubectl delete ingress virallens-inference -n virallens-dev

# 2. Uninstall helm releases
helm uninstall aws-load-balancer-controller -n kube-system
helm uninstall cluster-autoscaler -n kube-system
helm uninstall kube-prom -n monitoring
helm uninstall prom-adapter -n monitoring

# 3. Delete the cluster (this removes VPC, NAT, nodes, etc.)
eksctl delete cluster --name $CLUSTER_NAME --region $AWS_REGION

# 4. Delete ECR repo
aws ecr delete-repository --repository-name $ECR_REPO --force --region $AWS_REGION

# 5. Delete IAM policy and roles
aws iam delete-policy --policy-arn arn:aws:iam::${ACCOUNT_ID}:policy/AWSLoadBalancerControllerIAMPolicy
aws iam detach-role-policy --role-name GitHubActionsEKSDeployer \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser
aws iam detach-role-policy --role-name GitHubActionsEKSDeployer \
  --policy-arn arn:aws:iam::aws:policy/AmazonEKSClusterPolicy
aws iam delete-role --role-name GitHubActionsEKSDeployer

# 6. Double-check nothing expensive is left
aws ec2 describe-instances --filters "Name=tag:alpha.eksctl.io/cluster-name,Values=$CLUSTER_NAME"
aws elbv2 describe-load-balancers
aws ec2 describe-nat-gateways --filter "Name=state,Values=available"
```

---

## First run vs production

| Feature | First run | Production |
|---|---|---|
| VPC provisioning | `eksctl` defaults | Terraform with explicit subnets, flow logs, VPC endpoints |
| NAT | Single NAT | One per AZ (HighlyAvailable) |
| Secrets | AWS Secrets Manager + ESO | Same + rotation lambdas |
| Node type | `t3.medium` on-demand | Mixed instance policy + Spot + Karpenter |
| Registry | ECR public URL | ECR + VPC endpoint (no NAT egress for pulls) |
| WAF | Rate limit only | OWASP managed rule groups + geo blocks + bot control |
| Logging | CloudWatch control plane only | + Container Insights + FluentBit → CloudWatch/S3 |
| CI/CD | GitHub Actions OIDC | + ArgoCD for GitOps in prod |
| Cluster access | Public endpoint | Private endpoint + bastion via SSM |

---

## Why this order (interview soundbite)

1. **Foundation first** (ECR, VPC, cluster) — nothing runs without them
2. **Platform controllers before workloads** (LB controller, autoscaler, metrics) — the workload manifests reference things those controllers provide
3. **Identity before workloads** (IRSA, OIDC) — you can't enforce least privilege after the fact
4. **App last, then CI/CD, then observability** — prove it works manually before automating
5. **Load test last** — validates the whole stack end-to-end

---

## GCP → AWS translation reference

| GCP (original repo) | AWS equivalent |
|---|---|
| GKE | EKS |
| Workload Identity Federation → Jenkins | OIDC provider → IAM Role |
| Workload Identity (pod → GSA) | IRSA (SA → IAM Role) |
| Cloud Armor | AWS WAF + Shield Advanced |
| Secret Manager | Secrets Manager (or Parameter Store) |
| GCR / Artifact Registry | ECR |
| Global HTTPS LB | ALB (via AWS Load Balancer Controller) |
| Cloud NAT | NAT Gateway |
| IAP bastion | SSM Session Manager |
| Separate GCP projects | Separate AWS accounts + Organizations SCPs |
| GCS lifecycle policies | S3 Lifecycle rules |
| Memorystore (Redis) | ElastiCache (Redis) |
| Cloud SQL | RDS |
| Cloud Monitoring | CloudWatch |
