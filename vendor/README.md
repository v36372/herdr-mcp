# SDK provenance

Source: https://github.com/dmmulroy/herdr-ts-sdk
Commit: `77abbf81ac35407bc5138a8f4fe19f0833af4402`
Package: `@herdr/sdk@0.9.0`, protocol 22
License: MIT, inside the archive

Archive: `herdr-sdk-0.9.0.tgz`
SHA-256: `546b629be07ae595b037ef4564087e5d2c00d6fd6c254f6093851771c142585a`

The package build used an isolated clone. The inspected SDK checkout remained unchanged.
The package step used existing generated contracts. It did not regenerate source.

## Rebuild in a temporary checkout

```sh
work=$(mktemp -d)
git clone https://github.com/dmmulroy/herdr-ts-sdk "$work/sdk"
cd "$work/sdk"
git checkout --detach 77abbf81ac35407bc5138a8f4fe19f0833af4402
corepack pnpm@11.17.0 install --frozen-lockfile
node scripts/sdk-verification-cli.mjs pack
corepack pnpm@11.17.0 pack --out "$work/herdr-sdk-0.9.0.tgz"
```

Inspect the archive before replacement. After replacement, refresh the npm lockfile and run the MCP tests.

Test responses derive from this commit's wire schema through its fixture generator.
The snapshot fixture uses the actual SDK version and protocol instead of synthetic placeholder values.
Tests import only the installed public SDK entrypoint. Static fixtures require no upstream checkout.
