# releases/ — the beta build drop directory

This directory is the hub's distribution shelf. It is live state on the VPS
(`/opt/wickhunter-hub/releases/`), never populated from git.

## Contract (the bot repo's release step writes these)

```
releases/
  wickhunter-beta-<version>.tar.gz   # the built bot: dist/, package.json,
                                     # package-lock.json, public/, scripts/ —
                                     # app at the ARCHIVE ROOT, no data/,
                                     # no node_modules/
  latest.json                        # {"version": "<version>",
                                     #  "file": "wickhunter-beta-<version>.tar.gz",
                                     #  "sha256": "<hex of the tarball>"}
```

Publish order matters: copy the tarball FIRST, write `latest.json` LAST
(atomically — write a temp file, then `mv`). `latest.json` is the pointer;
until it moves, testers keep getting the previous build. Old tarballs may stay
for rollback (point `latest.json` back at one) and are served by exact
filename to any valid key.

`GET /download/latest?key=<token>` resolves through `latest.json` to the
tarball; `GET /api/latest?key=<token>` returns its contents so the installer
can verify the sha256 before unpacking.

Example publish, from the bot repo's built checkout:

```
V=$(node -pe 'require("./package.json").version')
tar -czf "/opt/wickhunter-hub/releases/wickhunter-beta-$V.tar.gz" \
    dist public scripts package.json package-lock.json
cd /opt/wickhunter-hub/releases
SHA=$(sha256sum "wickhunter-beta-$V.tar.gz" | cut -d' ' -f1)
printf '{"version":"%s","file":"wickhunter-beta-%s.tar.gz","sha256":"%s"}\n' \
    "$V" "$V" "$SHA" > latest.json.tmp && mv latest.json.tmp latest.json
```
