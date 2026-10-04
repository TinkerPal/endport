# Endport CLI

The CLI connects a local HTTP port to Endport without an email account. For local testing, build the repository, then run `npm install -g ./packages/cli`. From your application directory, use `endport 3000 --name myapp --server http://localhost:8080` against a local server. The first run creates a non-secret `.endport.json` project marker. A private credential for that app is saved in `~/.config/endport/identities/`. Run `endport code` from the same directory to print a fresh logs code. If the preferred name is taken, Endport assigns a short readable suffix.

The public npm package name `endport` belongs to another project. This package uses the `@endport/cli` scope while providing the `endport` executable. Publish it only from an npm account that controls the `@endport` scope.
