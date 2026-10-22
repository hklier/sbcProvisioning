# Kubernetes and Argo CD

The cluster deployment uses a single replica in namespace `sbc-provisioning`. Argo CD application `sbc-provisioning` tracks the `main` branch of [hklier/sbcProvisioning](https://github.com/hklier/sbcProvisioning), path `deploy/kubernetes/base`. Automated sync, pruning and self-healing are enabled. Secrets are provisioned separately and are never stored in Git.

## Cluster endpoint

- Controller: `192.168.3.5` (SSH user `hkl`).
- Application: `https://192.168.2.250`.
- Argo CD: [sbc-provisioning](https://192.168.2.243/applications/argocd/sbc-provisioning).
- Registry: `192.168.2.240:5000`; the existing cluster registry uses HTTP.
- Load balancer: existing MetalLB `registry-pool`, with `192.168.2.250` assigned to this Service.
- Application login: `admin`; the deployment-specific password is in the `sbc-provisioning-auth` Secret, not in this repository.

The app serves HTTPS directly using the `sbc-provisioning-tls` Secret and sets Secure session cookies. The lab certificate is self-signed, with SANs for the app IP, localhost, and service DNS. Replace it with an internal-PKI certificate if desired, then restart the app to load the replacement.

## Bootstrap

The namespace and these Secrets must exist before the first successful rollout:

| Secret | Keys | Purpose |
| --- | --- | --- |
| `sbc-provisioning-sdm` | `credentials` | SDM username/password file, mounted read-only |
| `sbc-provisioning-auth` | `password` | App-login password, injected through a Secret reference |
| `sbc-provisioning-tls` | `tls.crt`, `tls.key` | App HTTPS certificate/private key |

Create them using protected local files on a trusted host with cluster access. Avoid command-line literals containing passwords:

```sh
kubectl create namespace sbc-provisioning
kubectl -n sbc-provisioning create secret generic sbc-provisioning-sdm --from-file=credentials=/protected/path/sdm-credentials
kubectl -n sbc-provisioning create secret generic sbc-provisioning-auth --from-file=password=/protected/path/app-password
kubectl -n sbc-provisioning create secret tls sbc-provisioning-tls --cert=/protected/path/tls.crt --key=/protected/path/tls.key
```

Password files must contain the exact value without a trailing newline. The original SDM credential file can use the formats described in the main README. TLS files are mounted with mode 0440, readable by the container's group 1000.

Build and publish the image before creating the Argo CD Application. The deployed image is pinned by digest, so an unchanged Git revision always selects the same image content.

```sh
podman build --format docker -t 192.168.2.240:5000/vf-ro-sbc-provisioning:VERSION -f Containerfile .
podman push --tls-verify=false --digestfile=/tmp/sbc-provisioning.digest 192.168.2.240:5000/vf-ro-sbc-provisioning:VERSION
```

Update `deploy/kubernetes/base/deployment.yaml` to the returned `192.168.2.240:5000/vf-ro-sbc-provisioning@sha256:...` image reference, commit and push it. Validate with:

```sh
kubectl apply --dry-run=server -k deploy/kubernetes/base
kubectl apply --dry-run=server -f deploy/argocd/application.yaml
kubectl apply -f deploy/argocd/application.yaml
kubectl -n sbc-provisioning rollout status deployment/sbc-provisioning --timeout=180s
kubectl -n argocd get application sbc-provisioning
kubectl -n sbc-provisioning get pods,service,endpointslices
```

Only the Application is bootstrapped imperatively. Argo CD owns the Deployment, Service and Namespace from Git. The three pre-existing Secrets remain outside its resource/pruning set.

## Upgrade or roll back

1. Change the source and run `npm test`.
2. Publish a new image version and obtain its digest.
3. Commit the new digest in the Deployment manifest and push to `main`.
4. Argo CD synchronizes the change. Verify `Synced / Healthy` and readiness.

To roll back, revert the image-reference commit and push. Avoid `kubectl set image` or editing managed objects directly; self-healing will restore the Git version. Source commits alone do not build images: publishing an image and updating its digest are explicit release steps.

The server drains active jobs on SIGTERM, and Kubernetes allows a five-minute termination grace period. Do not plan upgrades during provisioning: sessions, previews and logs are in memory, and a pod restart clears them. Do not scale above one replica until sessions/jobs and the provisioning mutex have shared persistent storage. No PVC is needed by this version.

## Verification and troubleshooting

Health probes use HTTPS on port 9080; the Service exposes port 443. A request to `/healthz` is unauthenticated and returns only health status; application/API routes require the app login. Readiness switches to 503 while draining.

Check `kubectl -n sbc-provisioning describe pod POD` for missing Secrets, image-pull failures or probe failures. Container logs contain startup/job-drain notices, not SDM passwords. The pod must reach SDM `192.168.3.153:8443` and the nodes must be able to pull from the existing registry. Connecting to the supplied SDM IP still needs the app's explicit lab-certificate option because the SDM certificate does not cover that IP.

The public Git repository contains application code, sample/demo values and non-secret deployment manifests. It does not contain app passwords, SDM credential files, SSH keys, TLS private keys or Git tokens.
