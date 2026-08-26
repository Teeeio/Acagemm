# Bundled Node Runtime

This directory contains the official Node.js Linux x64 binary used when the
MetaX test machine cannot access GitHub or the Node.js download service.

- Version: `v24.19.0`
- Archive: `node-v24.19.0-linux-x64.tar.xz`
- Upstream: `https://nodejs.org/dist/v24.19.0/`
- SHA-256: `14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647`
- Supported target: Linux x86_64

`install-bundled-node.sh` verifies the checksum before extracting the runtime
into the ignored project-local `.local-c500-node/` directory. It does not
replace the system Node installation.
