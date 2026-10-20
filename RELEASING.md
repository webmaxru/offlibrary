# Releasing Offlibrary

Releases are published **by hand** from a maintainer's machine. Nothing in CI publishes. The steps below are written for **Windows PowerShell 5.1**. On macOS/Linux, drop the `.cmd` suffixes.

> Why `npm.cmd`? On PowerShell 5.1, `npm` resolves to `npm.ps1`, which the default execution policy may block. `npm.cmd` always works.
> Why `--registry`? It guarantees the publish goes to the public registry even if a project or user `.npmrc` points somewhere else.

## One command: `scripts/publish.ps1`

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -DryRun   # everything except publish and tag
powershell -ExecutionPolicy Bypass -File .\scripts\publish.ps1           # the real release
```

It runs on Windows PowerShell 5.1 and PowerShell 7, calls `npm.cmd` on Windows, and passes `--registry https://registry.npmjs.org` to every npm command that talks to a registry. Steps, each with a coloured status line, stopping at the first failure:

1. git preflight: on `main`, clean working tree, in sync with `origin/main` (warnings only with `-DryRun`);
2. `npm.cmd whoami`, and `npm.cmd login` if you aren't logged in;
3. aborts if `offlibrary@<version>` from `package.json` is already on npm (`npm.cmd view`);
4. `npm.cmd ci`, typecheck, unit tests, build, size budget, package check (add `-E2E` for the browser suites);
5. `npm.cmd pack --dry-run` to show what will be published, then asks `Publish offlibrary@<version> to npm? (y/N)`;
6. `npm.cmd publish --access public` (with `--otp` when you pass `-Otp`; otherwise npm asks, and if it fails the script asks for a code and retries once);
7. checks `npm.cmd view offlibrary@<version> version`, retrying for registry propagation;
8. creates and pushes the git tag `v<version>`;
9. prints the npm page and the "new GitHub release" link.

| Switch | Effect |
|---|---|
| `-DryRun` | Run every step except publish and tag. |
| `-Yes` | Don't ask for confirmation before publishing. |
| `-Otp 123456` | One-time password from your authenticator app. |
| `-Tag:$false` | Don't create or push the git tag. |
| `-E2E` | Also run the browser e2e suites (downloads Chromium once). |

It never reads, stores or prints tokens; npm keeps its own login. The manual steps below do the same thing by hand.

## Before the first release (one time)

```powershell
npm.cmd login --registry https://registry.npmjs.org
npm.cmd whoami --registry https://registry.npmjs.org
```

`offlibrary` 0.1.0 was published on 2026-10-19 (tag `v0.1.0`), so the name is yours; `--access public` below is harmless for an unscoped package.

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

# 3. Optional: the browser e2e suites (downloads Chromium once). They cover real Background Fetch,
#    the fetch fallback, and a real Workbox service worker using offlibrary/workbox.
npx.cmd playwright-core install chromium
npm.cmd run test:e2e

# 4. Check what will be published (0.2.0: 46 files, about 80 kB packed: dist/ incl. the workbox entry,
#    README.md, LICENSE, CHANGELOG.md, package.json)
npm.cmd pack --dry-run
npm.cmd run check:package   # installs the tarball into a temp project and type-checks it

# 5. Publish (prepublishOnly re-runs typecheck, tests, build and the size budget)
npm.cmd publish --access public --registry https://registry.npmjs.org --otp 123456
#    Replace 123456 with your authenticator code; drop --otp if npm opens a browser to confirm.

# 6. Verify
npm.cmd view offlibrary version --registry https://registry.npmjs.org

# 7. Tag the release
git tag v0.2.0
git push origin v0.2.0
```

Then create a GitHub release from the tag and paste the CHANGELOG section into it.

The documentation site (https://salnikov.no/offlibrary/) and the demo deploy on their own from `main` (workflow **Docs site + demo → GitHub Pages**); they build from the repo's source, not from npm, so they don't wait for the publish.

The CDN links in the README (`cdn.jsdelivr.net/npm/offlibrary@0/...`) work as soon as npm has the version. If jsDelivr serves an older copy, purge the files:

```powershell
'offlibrary.min.js','offlibrary-sw.min.js','offlibrary-sw.iife.js','offlibrary-workbox.iife.js' | ForEach-Object {
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
