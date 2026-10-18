# Releasing Offlibrary

Releases are published **by hand** from a maintainer's machine. Nothing in CI publishes. The steps below are written for **Windows PowerShell 5.1**. On macOS/Linux, drop the `.cmd` suffixes.

> Why `npm.cmd`? On PowerShell 5.1, `npm` resolves to `npm.ps1`, which the default execution policy may block. `npm.cmd` always works.
> Why `--registry`? It guarantees the publish goes to the public registry even if a project or user `.npmrc` points somewhere else.

## Before the first release (one time)

```powershell
npm.cmd login --registry https://registry.npmjs.org
npm.cmd whoami --registry https://registry.npmjs.org
```

The package name **`offlibrary`** was unclaimed on npm on 2026-10-18 (`npm view offlibrary` → 404). If it's taken by the time you publish, rename it in `package.json` to the scoped fallback `@webmaxru/offlibrary` (also unclaimed then). Then update the import paths in README.md, and publish with `--access public` as below.

## Release steps

```powershell
# 1. Fresh, clean main
git checkout main
git pull --ff-only
git status            # must be clean

# 2. Install exactly what the lockfile says, then verify
npm.cmd ci --registry https://registry.npmjs.org
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run size

# 3. Optional: the browser e2e suite (downloads Chromium once)
npx.cmd playwright-core install chromium
npm.cmd run test:e2e

# 4. Check what will be published (expect 35 files: dist/, README.md, LICENSE, CHANGELOG.md, package.json)
npm.cmd pack --dry-run
npm.cmd run check:package   # installs the tarball into a temp project and type-checks it

# 5. Publish (prepublishOnly re-runs typecheck, tests, build and the size budget)
npm.cmd publish --access public --registry https://registry.npmjs.org --otp 123456
#    Replace 123456 with your authenticator code; drop --otp if npm opens a browser to confirm.

# 6. Verify
npm.cmd view offlibrary version --registry https://registry.npmjs.org

# 7. Tag the release
git tag v0.1.0
git push origin v0.1.0
```

Then create a GitHub release from the tag and paste the CHANGELOG section into it.

The CDN links in the README (`cdn.jsdelivr.net/npm/offlibrary@0/...`) work as soon as npm has the version. If jsDelivr serves an older copy, purge the files:

```powershell
'offlibrary.min.js','offlibrary-sw.min.js','offlibrary-sw.iife.js' | ForEach-Object {
  Invoke-RestMethod "https://purge.jsdelivr.net/npm/offlibrary@0/dist/$_" | Select-Object -ExpandProperty status
}
```

## Next releases

1. Move the `Unreleased` notes in `CHANGELOG.md` under a new version heading with today's date.
2. Bump the version without creating a tag yet:

   ```powershell
   npm.cmd version 0.1.1 --no-git-tag-version
   git commit -am "release: 0.1.1"
   git push
   ```

3. Wait for CI to pass on main, then run the **Release steps** above with the new version in step 7.

Pre-1.0, use minor bumps (`0.2.0`) for breaking changes and call them out in the changelog.
