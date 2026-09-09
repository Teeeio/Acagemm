# Execution package source import

This adapter converts a local source directory or tar/tar.gz/zip archive into
the language-neutral package input consumed by `execution-package-store`.

It recursively includes every regular file as an offline dependency closure,
requires explicit candidate and independent acceptance entrypoints, and rejects
portable-path violations, links, devices and hardlinks. Tar-family archives are
read through the host `tar` reader; ZIP archives first use a BSD-tar reader when
available and fall back to the host `unzip` CLI (the latter is important on
Linux, where GNU tar normally does not read ZIP). Archive members are never
extracted into the Mission Workspace. Import performs no dependency
installation or source execution; the trusted package store must still
validate and prepare the result before a test can be submitted.

Verification: `npm run test:execution-package-import`
