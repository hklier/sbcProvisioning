# VF Romania SBC Provisioning Tool

A separate web tool for Operator Connect (OC) and Office Link (OL) provisioning through Oracle SDM REST v1.3. The interface follows the workspace Redwood palette, warm surfaces, Georgia headings and restrained red actions. It uses system fonts when Oracle Sans is unavailable; no external assets or frontend dependencies are required.

## Start locally

Requires Node.js 22 or later. No dependency installation is needed.

```powershell
cd 'C:\Users\Heino Klier\Documents\Codex HK\sbc-provisioning-tool'
npm start
```

Open **http://127.0.0.1:9080**. The application starts in **Demo** mode with an isolated simulated SDM for each browser session. Demo changes never reach the real SDM. Reloading the page reconnects a fresh demo; it does not resume a previous live session.

Use **Connection settings → Live → Connect and read inventory** for the real environment. The backend reads `../vf-ro-provisioning/sdm-rest-api-cred.txt`; it does not copy the credentials into the tool or send them to the browser. The supported file formats are JSON `{ "userName": "...", "password": "..." }`, labelled username/password lines, or username and password on two separate lines.

The supplied SDM at `https://192.168.3.153:8443/rest/v1.3` presents a certificate whose IP SANs do not include `192.168.3.153`. For this lab, the connection dialog has an explicit option to allow an untrusted/mismatched certificate. Otherwise certificate validation remains enabled. For normal deployment, use the certificate's correct hostname and configure `SDM_CA_FILE` if a private CA is needed.

## Use the tool

1. Connect to Demo or Live and choose one or two SBCs from the target drop-downs. Select one representative per HA cluster or standalone device group. A device's `nfId` selects its device group for LRT deployment.
2. Choose **Operator Connect** or **Office Link**, enter the customer values, and select configuration only, configuration + LRT, or LRT only. **Configuration action** defaults to **Create new**, using `POST /configuration/deviceConfigs/<deviceId>/configElements/add`. Duplicate keys stop the preview. Choose **Update existing** for `POST .../update`, or explicitly select **Create missing / update existing** for a mixed operation.
3. For LRT, choose the route set and number range. If the selected group is not associated with the route set, explicitly enable **Associate selected SBC if missing**. Association requests are included in the preview. The live OC/OL route sets were unassociated during development; the OL set was also locked by `admin`.
4. Choose **Preview REST changes**. The backend reads existing state, prepares adds/updates, and displays the request payloads and previous values. Previewing does not add/update configuration, associate devices, save/activate, change entries, or deploy routes. It does call SDM's read-side `loadConfig` to load the configuration into the SDM session.
5. Review the preview, then choose **Apply in demo** or **Apply to live SBC**. Applying acquires locks, checks for changes since the preview, associates missing target groups only if explicitly selected, adds/updates objects, saves/activates, updates LRT entries, pushes the route set, polls completion, commits and releases acquired locks.
6. Use **Find existing configuration** to search by BGID or OL customer identifier. For numeric OL customer-ID searches, the tool also checks the full realm/agent `hmrString`. If the numeric LRT ID field is blank, the tool can derive LRT prefixes from matching objects' `hmrString` values.
7. **Inspect / edit** opens the returned JSON for an object or LRT entry. Updates require a new preview and apply. Configuration editing only updates existing keys; use **Create new** on the provisioning form to create objects. Local-policy is available for reading/manual editing; no OC or OL local-policy is generated.

The **REST activity** panel shows method, path, request, response, HTTP status and duration. Expand any call to inspect its payloads. Export the activity as JSON when needed. SDM passwords, cookies and session IDs are masked. Activity and jobs are held in memory, not a durable audit database.

## Provisioning rules

| Service | Rule |
| --- | --- |
| OC realm | `core-oc-bgid<BGID>`; parent `core-oc-sbc` |
| OC SIP interface | Generated realm; input port on TCP and UDP; input SIP address; sample options/enforcement profile |
| OC LRT key | `<BGID><number-range-start/end>` |
| OC LRT routing | `!(^.*$)!sip:\1;area=<area>@grp-prio-buoc-cscf;egress=<generated-realm>!` |
| OL realm | `<customer-identifier>-access`; parent `access-ol-sbc` |
| OL manipulation string | Numeric customer ID, identical to the OL LRT customer-ID prefix; API field `hmrString` |
| OL session agents | `<customer-identifier>-1` through `-4`, with input IPs; both realm references remain `access-ol-sbc`, matching the supplied sample |
| OL session group | `<customer-identifier>.corporate.vodafone.ro`; configured agents as destinations; sample trunk-group naming |
| OL LRT key | `<numeric-customer-ID><number-length><number-range-start/end>` |
| OL LRT routing | `!(^.*$)!sip:\1;area=<area>;prefix=<number-prefix>@grp-prio-buol-cscf!` |

The sample's alphanumeric naming identifier (`N529704BUCPE4`) and numeric manipulation/LRT ID (`152970402130004`) are separate inputs. **Customer CLI number** is retained in the preview as reference information because the supplied configuration does not define a distinct CLI attribute. It is not silently substituted for the numeric customer ID.

Default OC network interface: `s1p0:1287.4`; OL: `s0p0:1291.4`. Both are editable. OL agent defaults follow the supplied sample, including max sessions 2 and ping interval 30. They can be changed in the existing-object JSON editor. Shared parent realms, manipulation rules, translation rules, policies and routing groups must already exist on the chosen SBC.

Exact existing LRT ranges are updated; new non-overlapping ranges are added. Existing entry IDs can also be selected to update their ranges. Ranges remain strings and comparisons use `BigInt`, preserving long keys and leading zeroes. OL number length must equal the endpoint digit count. The group destination list is replaced with the selected agents; removed destinations do not delete the old standalone agent objects.

## Podman

The image runs as a non-root user. It contains only the app, with no credentials, source collections or local files from the sample directory.

Build from this directory:

```powershell
podman build --format docker -t localhost/vf-ro-sbc-provisioning:0.2.0 -f Containerfile .
podman secret create sdm-credentials ../vf-ro-provisioning/sdm-rest-api-cred.txt
```

Set `APP_PASSWORD` in your shell to your chosen tool-login password, then start:

```powershell
podman run -d --name sbc-provisioning --restart=unless-stopped --read-only --cap-drop=ALL --security-opt=no-new-privileges -p 127.0.0.1:9080:9080 --secret sdm-credentials,uid=1000,gid=1000,mode=0400 -e APP_USERNAME=admin -e APP_PASSWORD localhost/vf-ro-sbc-provisioning:0.2.0
```

Alternatively, with Podman Compose installed and `APP_PASSWORD` set:

```powershell
podman compose -f podman-compose.yml up --build -d
```

The Compose file mounts the original credential file read-only. On SELinux-enabled Linux hosts, add an appropriate `:Z` label to the bind mount if required. Check that the container's user can read the source file. Open http://127.0.0.1:9080 and sign in as `admin` with your chosen `APP_PASSWORD`.

## Kubernetes and Argo CD

The cluster configuration is in `deploy/kubernetes/base` and `deploy/argocd/application.yaml`. See [cluster deployment instructions](deploy/README.md) for HTTPS access, Secrets, GitOps upgrades and rollback. Argo CD tracks the main branch of [hklier/sbcProvisioning](https://github.com/hklier/sbcProvisioning).

## Server settings

| Variable | Default / purpose |
| --- | --- |
| `HOST` | `127.0.0.1` locally; `0.0.0.0` in the image |
| `PORT` | `9080` |
| `SDM_BASE_URL` | `https://192.168.3.153:8443/rest/v1.3` |
| `SDM_CREDENTIALS_FILE` | Sibling sample credential file locally; `/run/secrets/sdm-credentials` in image |
| `SDM_USERNAME`, `SDM_PASSWORD` | Optional pair of environment credentials instead of the file |
| `SDM_CA_FILE` | Optional private CA PEM path |
| `APP_USERNAME`, `APP_PASSWORD` | Optional HTTP Basic authentication; required by Compose/Kubernetes setup |
| `TLS_KEY_FILE`, `TLS_CERT_FILE` | Certificate/key paths for serving HTTPS directly; set both together |
| `COOKIE_SECURE` | Set `true` behind HTTPS ingress; leave unset for localhost HTTP |

## Validation and limits

Run `npm test`. Tests cover OC/OL generation, four agents, number handling, merging existing objects, composite keys, validation, lock cleanup, semantic activation failures, LRT commit/rollback, cookie authentication, redaction, pagination, and the web API's preview/apply/search/edit flow.

Development verification against the supplied SDM succeeded for login/logout, inventory, route sets, configuration loading/retrieval, filtered OL/LRT searches, and OC/OL configuration previews. No live provisioning writes, activations, associations or LRT pushes were performed. The Windows development shell has no container runtime or kubectl; cluster builds and deployment are performed on the Kubernetes controller. See deploy/README.md for the release deployment.

Preview IDs expire after 15 minutes and can be applied once. Pending SDM configuration changes block provisioning rather than silently applying unrelated changes. Reads fetch all pages; a repeated page or exceeded limit reports an error instead of returning incomplete results. Only acquired locks are released; another session's locks are never overridden. Reconnect to SDM if its session expires; uncertain writes are not automatically retried.

Configuration activation and LRT deployment are separate SDM transactions. The application coordinates them with compensating operations and explicit verification, as described below. This version does not implement durable job recovery after a process crash, bulk import or scheduled provisioning.

## Customer deletion and two-target recovery

In **Find existing configuration**, enter an exact OC BGID, OL customer identifier, or numeric OL customer ID. Choose **Delete scope**, then **Preview customer deletion**. Review the per-target object keys, route ranges and before-values. Applying deletion requires the explicit review checkbox. Search results can be broad; deletion resolves exact customer ownership independently of those displayed search results and ignores the Object type search selector.

OC deletion selects the generated realm, its SIP interface and any local policy whose source realm is exactly that customer realm. OL deletion resolves the numeric ID through exact `hmrString` values and removes the customer's realm, agents 1–4, session group, related SIP interface and any customer-scoped local policies. Shared parent realms/global policies are excluded. Unknown/custom ownership conventions are not guessed. Provide the numeric OL ID when orphaned LRT entries cannot be mapped from customer objects. LRT ranges must have both endpoints under the customer prefix; prefixes colliding with another known customer are rejected.

Choose a second independent target before preparing a provisioning, update or deletion preview. Configuration changes are staged on both targets before either activation. A failure triggers recovery of every touched target, including the request that failed (its outcome might be uncertain). Recovery discards this SDM user's clean-at-start staging changes, restores before-values or removes newly created objects, saves/activates original configuration content, and retrieves objects again for comparison. Device configuration version numbers/timestamps can advance during recovery.

LRT tasks are rolled back and polled until per-group recovery is confirmed. SDM entry content is restored separately. When a push outcome is uncertain, re-deployment of the original table is attempted only if all selected groups had a verified common pre-update version. Otherwise the tool reports incomplete recovery instead of overwriting an unknown original device table. Newly created route-set associations are removed and checked. Re-created LRT entries may receive new SDM-generated object IDs; their original routing content is restored.

The **Operation failed** dialog includes the failing REST endpoint/status/response, recovery result per target, completed steps, and expandable rollback details. It explicitly distinguishes verified restoration, no changes requiring rollback, and incomplete recovery. REST activity includes the recovery calls and remains exportable. In Demo mode, **Test automatic rollback** can inject a second-target activation failure or LRT push failure; this control has no effect on live SDM.

There is no distributed atomic transaction across SDM and the SBCs. Automatic rollback is attempted and verified, but unavailable devices, lost SDM connectivity, rejected restore operations, encrypted/masked attributes, or process termination can prevent full recovery. An incomplete result requires inspection before retrying. Snapshots/jobs are currently in memory; do not restart or upgrade the app during active provisioning/recovery. No live customer deletion or deliberate live failure was executed during development; failure recovery is verified against the simulated SDM with separate running/staged configurations.

## Sources

- `../vf-ro-provisioning/oc-details.txt`, `ol-details.txt`, `lookupAccessOc.xml`, `lookupAccessOl.xml`.
- Both `SDM SBC -- VF RO 2026` Postman collections in `../postman/`.
- [Oracle SDM authentication](https://docs.oracle.com/en/industries/communications/session-delivery-manager/9.0/rest/authenticate.html).
- [Oracle SDM configuration list and pagination](https://docs.oracle.com/en/industries/communications/session-delivery-manager/9.0/rest901/op-versionid-configuration-deviceconfigs-deviceid-configelements-get.html).
- [Oracle SDM route set association](https://docs.oracle.com/en/industries/communications/session-delivery-manager/9.0/rest901/op-versionid-routesets-routesetid-devices-post.html).
- [Oracle SDM configuration deletion](https://docs.oracle.com/en/industries/communications/session-delivery-manager/9.0/rest901/op-versionid-configuration-deviceconfigs-deviceid-configelements-delete-post.html).
- [Oracle SDM staging cleanup](https://docs.oracle.com/en/industries/communications/session-delivery-manager/9.0/rest901/op-versionid-configuration-deviceconfigs-deviceid-configurationchanges-delete.html).

The local Postman captures and live read-side responses determine the exact JSON attribute names used here. No cloud SDM or direct-to-SBC REST endpoints are used.
