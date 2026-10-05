# Publishing @endport/cli

The publisher must control the `@endport` npm scope. The `endport` executable is provided by this scoped package. This repository does not prove npm scope ownership or package name availability.

The package is currently marked `UNLICENSED`: source availability does not grant reuse rights. Choose an explicit license before release if you intend to make it open source.

## First release

From the repository root, using Node.js 22 or newer:

```sh
npm ci
npm test --workspace @endport/cli
npm run build
npm pack --workspace @endport/cli --dry-run
npm login
npm whoami
npm publish --workspace @endport/cli --access public
```

Enable npm account 2FA. Verify that `npm whoami` is the intended publisher and that its account or organization owns `@endport`. Publishing is public and an existing version cannot be overwritten. No production secrets belong in this package; its `files` allowlist includes only compiled code and README.

After publication, test in a fresh directory:

```sh
npm install -g @endport/cli
endport --version
endport --help
```

Connect a real app and verify public requests and workspace code entry against the deployed gateway before announcing the release.

## Subsequent versions

```sh
npm version patch --workspace @endport/cli --no-git-tag-version
npm test --workspace @endport/cli
npm run build
npm pack --workspace @endport/cli --dry-run
```

Commit the package metadata and lockfile changes. Publish the reviewed version using the command above. Website download links must match the version if the direct tarball installation is retained.

## CI publishing

After the first release, configure an npm trusted publisher for repository `TinkerPal/endport`, workflow `publish-cli.yml`, and environment `npm`. Create that GitHub environment and require maintainer approval. Run the manually triggered workflow from `main`. It checks out an explicit immutable commit supplied as input, tests and builds the CLI, validates the package contents, then publishes with npm's OIDC authentication and provenance. It needs no stored npm token.

Official reference: https://docs.npmjs.com/trusted-publishers/
