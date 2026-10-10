# 910B connection and container preflight

Prepared on 2026-10-10 for the newly allocated machine. This is an execution
checklist, not evidence that a connection or remote check has happened.

## Confirmed scope and current blockers

The parent thread actually viewed the user's SSH guide and supplied only these
non-secret facts: bastion `bastion.aiops.baai.ac.cn`, port `2224`; target name
contains `910b4-64g`; target private address `10.0.0.10`. This address is a target
behind the bastion, not permission to connect directly or bypass JumpServer.

The screenshot's temporary credential expired at 17:47:51 Beijing time. Do not
read, transcribe, reuse or log it, including a token-bearing username. Obtain a
fresh authenticated session through the user's supported SSH/JumpServer entry.
Passwords, keys, tokens, MFA and host-key trust decisions belong to the user's
secure login UI. Do not create persistent credentials or disable host-key checks.
An earlier `Get-Command ssh` resolved to a managed `.sbx-denybin` wrapper. That
observation alone was not an SSH execution denial. After the user explicitly
requested a connection attempt, the execution tool's normal `require_escalated`
path ran the unchanged `ssh` command and reached JumpServer. No alternate
executable, transport or wrapper change was used. Continue respecting the
execution tool's permissions; a rejection must not be bypassed.

The user has explicitly selected this complete image reference:
`harbor.baai.ac.cn/flagtree/flagtree-ascend3.5-910b-py311-cann9.0.0-ubuntu22.04-aarch64:202606-torch2.9.0-base`.
The official [FlagTree Ascend instructions](https://docs.flagos.io/projects/FlagTree/en/latest/getting_started/multi-backend-prebuilt-docker-image-install/install-ascend.html)
list this repository/tag. **The tag choice is settled; do not ask again.** Record
the actual image ID and repository digest when a supported executor can inspect
the selected image. That observation is not a new image-selection approval.
Repository attribution is verified from documentation; registry contents,
signatures, digest and installed contents are not yet verified. Do not substitute
`latest`, another tag or a different image. This work item remains preparation
only, without pulling or executing the image.

The user also authorizes exposing **all NPUs on the designated target machine**
to the dedicated container. Enumerate its actual NPU character-device nodes
through the eventual supported executor and add each explicitly; do not assume
an eight-card count or mount the whole `/dev` tree. NPU selection does not need
another user decision. Record physical-to-visible-logical mapping, and preserve
the adapter's existing selected-device behavior.

Ordinary reconnection and refresh of an existing web login are authorized without
another confirmation. They do not authorize credential extraction, an SSH
wrapper bypass, new proxies or a persistent key/password. The parent has now
successfully opened JumpServer's normal Web connection and observed
`root@bm-ctyun-wq-zone1-d-910b4-64g-0-10:~#`, without entering a password/MFA or
enabling automatic login. At the time of that report, **zero remote commands**
had been entered. This is a successful authenticated cloud Web terminal login;
it is not an authenticated SSH session in this local execution environment.
This thread does not have access to that cloud browser session. Read-only checks
can be handed to its owning parent; do not create a new proxy or infer a local
session transfer.

The Web login banner reported root filesystem use of **97.2% of 434.79 GB**.
Treat that as a reported warning until actual filesystem metadata is read, not
as a complete free-space measurement. Before any image acquisition, check
DockerRootDir, its backing mount/free space, the experiment mount and whether
the exact approved image is already present. No pull, daemon migration or
deletion of shared resources is permitted as a response to this finding.

All remote project source, data, temporary files, logs, caches and build outputs
must stay under **`/public-flash/wzp`**. Tests must run inside the approved Docker
container. Do not install anything on the host, change system/network/security
settings, touch another user's container/process, use another shared writable
directory, add `--privileged`, or widen mounts beyond the approved specification.
The latest request authorized the single credential-free SSH check recorded
below. Image execution, remote installation and remote writes remain outside
this preparation work item.

## Connection state: cloud Web login succeeded; local SSH authentication pending

The callable tools were inspected for remote registration and secure SSH login.
They expose existing-host project/thread operations, but no action for
registering this SSH host or completing its secure authentication. The project
listing contains no configured project on this target. These facts do not mean
every SSH path is blocked: the formal execution-tool permission path has now
successfully reached the SSH server. A separate human terminal or browser login
still does not automatically establish a session these tools can reuse.

The single standard-SSH check returned TCP connection success, the remote
software banner `JumpServer`, and SSH key exchange through receipt of a host
public key. It exited with code **1** at strict host-key verification:

```text
No RSA host key is known for [bastion.aiops.baai.ac.cn]:2224 and you have requested strict checking.
Host key verification failed.
```

This diagnostic deliberately used empty user/global trust files (`NUL`), with
strict checking enabled and host-key updates disabled. It does **not** establish
that the user's actual `known_hosts` lacks a key. It disabled key, agent,
password, keyboard-interactive, GSSAPI and host-based authentication, requested
no remote command/shell, and sent no user-supplied credentials. It is not a
network failure, permission-tool rejection or authenticated login.

The server presented fingerprint
`SHA256:mqNYUGT5qQ+rfaiCVX/YJZOVHpOR7GWOssj9aEwa8/0`. This is an unverified
observation, not a trusted fingerprint. Confirm it against the provider's trusted
record through the secure handoff before approving trust; do not automatically
accept it, write it to `known_hosts`, or disable strict checking. The local
[connection receipt](../../output/ascend910b-verification/ssh-handshake.json)
records the exact command options and outcome.

A subsequent **local-only** lookup of the real user trust files is now complete:
`known_hosts` exists, but `ssh-keygen -F '[bastion.aiops.baai.ac.cn]:2224' -l`
found no matching record (exit 1, no fingerprint output); `known_hosts2` does
not exist. The user's SSH config contains none of the trust-file overrides,
host-key aliases, trust commands or `Include` directives checked. No trust file
was modified, no credential was read, and no network check was repeated. See
the [trust lookup receipt](../../output/ascend910b-verification/known-hosts-check.json).
This establishes absence of an exact record in the existing **user** trust
stores, rather than relying on the earlier intentionally empty diagnostic files.

The available tool catalog has no callable secure SSH credential-input or
authenticated-session handoff action. An execution tool's PTY option and the
app's terminal panel do not document a secure user-input/reuse bridge between
those sessions, so do not promise one. The next trust check for the provider is
whether the RSA fingerprint above belongs to this exact bastion endpoint; the
next authentication requirement is a supported secure session usable by the
executor. Do not ask the user to send a password/token in chat or to open a
separate terminal whose session cannot be reused.

The official [Codex SSH connection guide](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host)
describes Settings > Connections, an OpenSSH alias, local SSH reachability and an
authenticated Codex app-server available through the remote login shell. It does
not establish support for this JumpServer asset flow or execution inside this
specific Docker container. A normal host installation could write outside the
allowed root and is not an approved workaround.

The concrete next steps for the integration owner are:

1. Reuse the parent's already authenticated cloud Web terminal for its authorized
   read-only checks. For **local programmable SSH**, host-key verification and
   account/MFA authentication have not occurred. If that local channel is
   needed, confirm whether the provider's account/asset login mode can
   use a stable, non-token-bearing SSH alias through secure authentication,
   without creating a key or saved password. An interactive asset-selection
   menu alone is insufficient. Confirm noninteractive SSH exec with exit
   status, long-lived app-server sessions, and file transfer/SFTP support for
   the same authorized target. No credential should enter a task message.
2. Obtain a provider-supported way for that connection to run the agent and its
   commands inside the designated container, with agent state, home-based
   caches, logs, temporary files and the workspace bounded to
   `/public-flash/wzp`. A host shell followed by a human's manual `docker exec`
   is not proof that Codex will remain in that container. Do not invent a
   forced-command wrapper, proxy, forwarded port or alternate SSH binary.
3. Use the already approved image tag and all-target-NPU scope. Record the
   observed image digest, actual device nodes, existing supported runtime,
   narrow driver dependencies and root mapping before any creation action.
   These are technical observations, not repeat questions about image/card
   selection.
4. If using Codex Remote, add the corresponding supported remote project only
   after its requirements are met; otherwise establish the confirmed supported
   authenticated executor. Verify container identity and working directory
   through that same executor before the read-only inventory below.

The observed state is **cloud Web terminal login successful; local SSH network
reachability confirmed, local trust/authentication pending, container execution
not started**. Do not
repeat the credential-free probe; it has already answered reachability. Do not
ask the user to refresh an expired token or perform an isolated terminal login
that cannot be reused. Ordinary reconnection/login refresh is authorized once
the supported authenticated flow exists; new trust or MFA decisions remain a
secure handoff.

### Single support handoff

The following is the current support-ready blocker report. It records existing
observations, including the newly authorized single connection check.

| Field | Observed fact / request |
| --- | --- |
| Target | Authorized 910B asset through `bastion.aiops.baai.ac.cn:2224`; private target `10.0.0.10` |
| Local execution boundary | Earlier command discovery found `.sbx-denybin\\ssh.bat`; the formal `require_escalated` standard-SSH execution then ran successfully. No wrapper/binary/transport was replaced |
| Available application actions | Tools can use already registered hosts/projects but expose no target registration or secure SSH authentication action; this target is not an available remote project |
| Browser state | Parent successfully opened the normal JumpServer Web connection and saw the target root prompt; no remote command had been entered. That authenticated cloud session is not accessible to this local executor |
| Exact local SSH boundary | TCP and SSH key exchange succeeded; process exit 1 with `Host key verification failed.` against intentionally empty trust files. Local SSH account authentication and remote execution have not happened |
| Storage finding | Parent reports root filesystem banner use 97.2% of 434.79 GB; actual DockerRootDir/mount/free space and image presence must be read before acquisition |
| Actual user trust lookup | Existing `known_hosts`: no exact `[bastion.aiops.baai.ac.cn]:2224` match; `known_hosts2` absent; user config has no trust override/alias/include directives; no network retry |
| Secure authentication capability | No callable SSH secret-input/session-handoff tool was found; a PTY/terminal UI reuse bridge is not documented or verified |
| Requested support resolution | Supply the trusted bastion host fingerprint and supported secure account/asset authentication flow; confirm reusable noninteractive command/exit-code and file-transfer support, then container-bound execution under `/public-flash/wzp` |
| Already authorized | Fixed image tag above, all target NPUs, routine reconnect/login refresh; no new tag/NPU question is needed |
| Remains excluded | Wrapper bypass, another channel used to execute a rejected action, token/password extraction, persistent credentials, privileged containers, host namespaces, broad host binds, new proxies or forwarded ports |

Do not periodically re-probe or report the old wrapper observation as a blanket
network block. The next connection action depends on secure trust/authentication,
not another reachability check. Password, MFA and host-key trust prompts require
the secure user-facing handoff; no screenshot credential may be extracted.

## Restricted container specification to resolve

The FlagTree page's example enables privileged execution, shares host network,
PID and IPC namespaces, exposes eight NPUs, and mounts broad host directories.
It is not an acceptable command for this task and does not prove a minimum.

Huawei's [Ascend container FAQ](https://www.hiascend.com/document/detail/en/ModelZoo/releasedmodel/rmies/rmies_00013.html)
shows removal of privileged mode with explicit NPU/management devices and
driver/tool mounts. This supports investigating a nonprivileged configuration;
it does not validate the selected CANN 9.0.0 image on the allocated host.

The provider must freeze the following small resource list; it is a review
specification, not an executable `docker run` recipe:

| Resource | Required decision before creation |
| --- | --- |
| NPU | All actual NPU nodes on the designated target are authorized; explicitly list existing `/dev/davinci<integer>` nodes and map physical IDs to visible logical indices; no fixed card-count assumption or whole `/dev` bind |
| Management nodes | Confirm whether this host/runtime requires `/dev/davinci_manager`, `/dev/devmm_svm`, `/dev/hisi_hdc`; do not expose other devices |
| Driver dependencies | Exact existing driver libraries/tools/version files required by the approved runtime, mounted read-only; no blanket `/usr/local`, `/home`, `/data` or host-root bind |
| NPU management tool | The provider's exact existing `npu-smi` path if inventory needs it; no guessed binary installation |
| Experiment writes | Only `/public-flash/wzp` and approved subdirectories, including workspace, temporary files, home-based caches, logs and builds |
| Container identity | Explicit user/group and workdir; no new privilege or permission repair |
| Isolation | No privileged mode, host network/PID/IPC, exposed ports or Docker socket; any necessary device-group access/shm limit must be explicit |
| Image storage | Use the provider's existing supported Docker storage; record infrastructure storage separately from experiment writes. Do not relocate/reconfigure the daemon or save an image archive outside `/public-flash/wzp` |

The adapter bounds its own task caches; it does not confine the container's
entrypoint, app-server or arbitrary dependency writes. The image's actual
entrypoint and defaults must be inspected before execution. FlagTree/Triton
installation/build paths may use home-based caches and download dependencies;
no installation or source build is part of this preparation. A provider must
also establish cache/home confinement before later compiler work.

### Deployment-package settings and dependency manifest

The integration owner can prepare these fixed settings now. Resolve only the
host-specific paths, user/group and dependency records after the supported
connection exists; do not turn unresolved entries into a speculative command.

| Setting | Prepared value / admission condition |
| --- | --- |
| Image | Exact approved repository/tag above; bind the observed immutable digest to the deployment receipt |
| Experiment bind | Host `/public-flash/wzp` to container `/public-flash/wzp`, writable; no other experiment/data/source bind |
| Working directory | The prepared Acagemm checkout below `/public-flash/wzp`; verify its resolved path before starting any process |
| Device list | One explicit Docker device entry per observed target NPU, plus the required management nodes confirmed below |
| User/group | Existing approved container identity and device group access; do not repair host ownership or add broad capabilities |
| Process/network isolation | Container PID/IPC/network namespaces, no published ports, no Docker socket, no `--privileged` |
| Writable runtime state | Container home, temporary files, XDG/Torch/Ascend/FlagTree/Triton caches, compiler outputs and agent state resolve below the experiment bind before first import/build |
| Entry point | Inspect the selected image's entrypoint/command first; execute only the reviewed command, without an implicit installer/download or host script |
| Compilation | No build during inventory; later build uses only the observed installed stack and the unchanged admitted candidate/test package |

Record each dependency's host path, container path, access mode, observed
existence/type and reason. The following are narrow candidate resources, not a
claim that all exist or that this list is sufficient on the uninspected host:

| Dependency | Expected treatment |
| --- | --- |
| `/dev/davinci<integer>` | Existing NPU character devices, all target cards explicitly passed; never a directory bind |
| `/dev/davinci_manager`, `/dev/devmm_svm`, `/dev/hisi_hdc` | Expected Ascend management devices; record the installed runtime's required subset and exact node permissions |
| Driver user libraries | Existing driver library directory, commonly `/usr/local/Ascend/driver/lib64`, read-only; use image CANN libraries rather than replacing its toolkit with a host toolkit |
| Driver tools and version | Only required tool paths/files and driver version metadata, read-only; a complete driver directory is not the default minimum |
| `npu-smi` | Exact existing tool file from the approved installation, read-only; do not bind its entire parent `/usr/local/bin` or `/usr/local/sbin` |
| Install/runtime metadata | Exact `/etc/ascend_install.info` or other file required by the actual runtime, read-only; no whole `/etc` bind |
| Additional driver dependencies | Only a dependency established by the installed runtime/provider, such as a specific add-on/DCMI library; record it explicitly rather than mounting all add-ons or broad host directories |

This is the smallest reviewable configuration supported by current evidence,
not a successful container-start receipt. If a missing dependency is reported,
return its exact error and path; do not respond by enabling privileged mode or
mounting a larger host directory.

### Storage and selected-image inventory before acquisition or creation

The parent can run the following through its existing authorized Web terminal
as read-only preparation. This local thread has not run these remote commands.
They query only the relevant filesystem paths and the exact selected image; no
container enumeration, image pull, installation, cleanup or migration occurs.

```sh
docker info --format '{{.DockerRootDir}}'
findmnt --target /public-flash/wzp --output TARGET,SOURCE,FSTYPE,OPTIONS
df -Pk / /public-flash/wzp
```

Then run `findmnt --target` and `df -Pk` on the **exact DockerRootDir returned**,
including a resolved symlink target if different. Do not assume that a path
under `/var/lib` or `/public-flash` is a particular disk. Record source/mount,
capacity, available bytes and percentage for `/`, Docker storage and the
experiment root. If Docker is unavailable or a path cannot be inspected, retain
that exact error; do not install a runtime or change permissions.

These are future read-only commands for an existing local copy of the approved
image through the supported remote executor. They do not pull or execute an
image, and have not been run in this work item:

```sh
CONFIRMED_IMAGE='harbor.baai.ac.cn/flagtree/flagtree-ascend3.5-910b-py311-cann9.0.0-ubuntu22.04-aarch64:202606-torch2.9.0-base'
docker image inspect --format '{{.Id}} {{json .RepoDigests}} {{.Os}} {{.Architecture}}' "$CONFIRMED_IMAGE"
docker image inspect --format '{{.Size}}' "$CONFIRMED_IMAGE"
docker image inspect --format '{{.Config.User}} {{.Config.WorkingDir}} {{json .Config.Entrypoint}} {{json .Config.Cmd}} {{json .Config.Volumes}}' "$CONFIRMED_IMAGE"
```

Expected platform metadata is `linux`/`arm64` (the image name uses `aarch64`).
Record a mismatch, missing image, absent digest or unexpected startup command
as an observation; do not change the selected tag or run the image to discover
its metadata. Coordinate any image acquisition with the integration owner using
the already selected tag and approved storage location. Package versions still
require the container metadata inventory below; image labels alone do not prove
them.

If the image is present, reuse its inspected identity rather than pulling again.
If absent, image acquisition remains blocked until the actual storage has
enough free capacity for compressed downloads, expanded layers, temporary
extraction and container overhead. The tag and a download-size estimate cannot
prove this. If DockerRootDir is on the nearly full root filesystem, report that
finding and ask the provider for an existing supported spacious storage path or
preloaded image; do not move Docker, delete public images/containers/caches, or
try a pull first. Keep all experiment source/data/log/cache/build writes within
`/public-flash/wzp` regardless of Docker infrastructure placement.

## Compatibility claims and remaining evidence

| Layer | Evidence currently available | Still required in the selected container |
| --- | --- | --- |
| Python 3.11 | `runner.py`, `test_runner.py` and the reused base runner parse with CPython's 3.11 grammar | Actual Python 3.11 execution and dependency imports; local interpreter is 3.12, so syntax parsing is not a 3.11 runtime test |
| Linux/aarch64 | Adapter requires Linux for live execution and ships Python source, without a bundled architecture-specific binary | Observed OS/architecture and native dependency wheel/ABI checks; local tests ran on Windows x86_64 |
| CANN 9.0.0 | User-selected repository and official tag describe that toolkit; documentation identifies the 910B A2 variant | Actual toolkit, 910B ops package, runtime, host driver/firmware and their supported pairing |
| Torch/TorchNPU | Adapter discovers the installed runtime and fails on missing APIs; no automatic CPU/CUDA fallback | Actual `torch` and `torch-npu` versions, wheel tags, compatible pairing and NPU API behavior; the image tag is not an installed-version receipt |
| FlagTree ascend3.5 | Official docs identify a Triton 3.5/aarch64 backend; a separate install example names `flagtree` version `0.7.0+ascend3.5` | Actual FlagTree/Triton package metadata and active compiler/backend; neither number proves the image contains that package |
| Compilation | Existing adapter offers a task-bound TorchNPU C++ extension bridge and records native load observations | Installed compiler/Ninja/headers/ABI, a later approved minimal extension build and a separate FlagTree kernel compile/dispatch check |
| Correctness/timing | 27 injected-runtime/CPU module tests passed; event timing and independent-oracle contracts are tested in fixtures | Actual 910B correctness and synchronization/timing under the unchanged admitted test package |

The current native-load observer is for native extensions; it does not certify
Triton/FlagTree JIT dispatch. A passed TorchNPU extension build would not replace
that compiler-path check. Simulation results remain nonpublishable and are not
evidence of hardware compatibility. No container/device/runtime test has been
performed during this preparation.

## Information needed after secure login

Retain the verified target identity and the user-confirmed container ID/name,
its trusted image reference/digest, its existing device/mount configuration and
the container path mapping to `/public-flash/wzp`. No secret is required in this
document or a command log. An authenticated connection alone does not approve a
Docker configuration or hardware execution.

Before running a container process, inspect **only the confirmed container**.
Use the reviewed restricted container specification; do not enumerate or inspect
unrelated containers and do not dump container environment variables or logs.
These read-only host checks are templates, not commands already executed:

```sh
uname -srm
cat /etc/os-release
realpath -e /public-flash/wzp
stat -c '%F %U %G %A' /public-flash/wzp
df -Pk /public-flash/wzp
docker inspect --type container --format '{{.State.Status}} {{.Config.Image}} {{.Image}}' "$CONFIRMED_CONTAINER"
docker inspect --type container --format '{{json .Mounts}}' "$CONFIRMED_CONTAINER"
docker inspect --type container --format '{{json .HostConfig.Devices}}' "$CONFIRMED_CONTAINER"
docker inspect --type container --format '{{.HostConfig.Privileged}} {{.HostConfig.PidMode}} {{.HostConfig.IpcMode}} {{.HostConfig.NetworkMode}}' "$CONFIRMED_CONTAINER"
docker inspect --type container --format '{{.Config.User}} {{.Config.WorkingDir}} {{.HostConfig.ReadonlyRootfs}}' "$CONFIRMED_CONTAINER"
```

`CONFIRMED_CONTAINER` must come from the approved specification/session. If the
container is absent or stopped, return that finding; do not automatically create
or start it. Verify that project writable mounts resolve under the allowed host
root, and that any system/driver mounts match the explicitly approved specification.
A surprising writable host mount or privilege is a reason to pause, not an
invitation to repair permissions. Do not test write permissions by creating a
file during this read-only phase.

## Container-only checks

Only after authentication and the preceding container checks pass, use
`docker exec --workdir "$CONFIRMED_WORKDIR"` on that same running container.
`CONFIRMED_WORKDIR` must map to `/public-flash/wzp` on the host. Do not allocate a
new container, use a login shell, or change the container's user/privileges.

Collect these observations without importing TorchNPU or starting a workload:

- OS and CPU architecture: `uname -srm`, `/etc/os-release`.
- Working path, resolved mount and available capacity: `pwd -P`, `df -Pk .`,
  and the already inspected container-to-host mount mapping.
- Python/PyTorch/TorchNPU/FlagTree/Triton package metadata using the existing interpreter and
  the following standard-library snippet. Missing metadata remains unknown.
- Driver/CANN version metadata from known version files in the **approved**
  driver/toolkit mounts; record actual paths and values. Do not source an
  unknown environment script or run an installer to discover a version.
- 910B visibility via the container's existing `npu-smi info` management query,
  only if this tool/device exposure is in the approved example. Missing tool or
  permission is a blocking finding. Do not add mounts/devices to make it pass.

```sh
python3 -I -B - <<'PY'
import importlib.metadata as metadata
import json
import platform
import shutil
import sysconfig

packages = {}
for name in ("torch", "torch-npu", "flagtree", "triton", "triton-ascend"):
    try:
        dist = metadata.distribution(name)
        wheel = dist.read_text("WHEEL") or ""
        packages[name] = {
            "version": dist.version,
            "requiresPython": dist.metadata.get("Requires-Python"),
            "wheelTags": [line[5:] for line in wheel.splitlines()
                          if line.startswith("Tag: ")],
        }
    except metadata.PackageNotFoundError:
        packages[name] = None
print(json.dumps({"python": platform.python_version(),
                  "machine": platform.machine(),
                  "platform": sysconfig.get_platform(),
                  "packages": packages,
                  "toolPaths": {name: shutil.which(name)
                                for name in ("ninja", "c++", "clang", "bisheng", "npu-smi")}}))
PY
```

Run Python with `-I -B`; do not import `torch`, `torch_npu`, an operator, a model
or a native extension during this inventory phase. A management query proves
only reported visibility. Package metadata proves only installation metadata,
not ABI compatibility, NPU initialization, correctness or performance. Looking
up a compiler path does not execute it or verify it can build an extension.

The adapter's `--preflight --probe-device` imports TorchNPU and synchronizes a
device, so **do not run it in this initial inventory phase**. Likewise, do not
start compilation, CPU regression suites, candidate tests, benchmarks or models.
The main integration thread must finish wiring and explicitly advance to the
next approved phase first.

Report authentication/target identity, confirmed container/image, mount/write
scope, OS/architecture, reported NPU model/device visibility, observed driver/
CANN/package versions and capacity. Mark each missing fact as unknown and give
its concrete blocker. Do not save remote reports outside `/public-flash/wzp`;
returning concise observations through the existing session needs no remote file.

Docker command references checked while preparing this checklist:
[inspect](https://docs.docker.com/reference/cli/docker/inspect/) and
[container exec](https://docs.docker.com/reference/cli/docker/container/exec/).
