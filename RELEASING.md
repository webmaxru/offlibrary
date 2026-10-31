# Releasing Offlibrary

A new version goes to npm through **GitHub Actions**: the steps right below. Publishing by hand from your machine (`scripts/publish.ps1`, further down) is the fallback. The steps are written for **Windows PowerShell 5.1**. On macOS/Linux, drop the `.cmd` suffixes.

> Why `npm.cmd`? On PowerShell 5.1, `npm` resolves to `npm.ps1`, which the default execution policy may block. `npm.cmd` always works.
> Why `--registry`? It guarantees the publish goes to the public registry even if a project or user `.npmrc` points somewhere else.

## Publish a new version (GitHub Actions, the default route)

Since 0.2.1 (2026-10-31) a new version reaches npm from GitHub Actions: you publish a **GitHub Release**, approve one deployment, and `.github/workflows/release.yml` publishes with npm trusted publishing (OIDC, no token) and a provenance attestation. Setup, design and sources: [docs/PUBLISHING-CI.md](docs/PUBLISHING-CI.md).

**1. Bump the version on `main`.** On an up-to-date `main` (or in a PR that you merge):

```powershell
git checkout main
git pull --ff-only
npm.cmd version patch --no-git-tag-version   # or minor / 0.3.0 / prerelease --preid beta; updates package.json AND package-lock.json
```

Move the `[Unreleased]` notes in `CHANGELOG.md` to `## [x.y.z] - YYYY-MM-DD`, then commit and push:

```powershell
git commit -am "release: x.y.z"
git push
```

Wait until CI on that commit is green (unit tests plus the browser e2e suites). The release workflow does not run them again.

**2. Publish a GitHub Release `vX.Y.Z`.** [github.com/webmaxru/offlibrary/releases/new](https://github.com/webmaxru/offlibrary/releases/new) → *Choose a tag* → type `vX.Y.Z` → *Create new tag on publish* → target `main` → title `vX.Y.Z` → *Generate release notes* → **Publish release**. Or from a terminal:

```powershell
gh release create vX.Y.Z --target main --title vX.Y.Z --generate-notes
```

The tag must be exactly `v` + the `package.json` version and must point at a commit on `main`, or the run stops before publishing. Tick *Set as a pre-release* (or use a version like `1.0.0-beta.1`) to publish under the `next` dist-tag instead of `latest`.

**3. Approve.** Actions → *Release to npm* → the new run → **Review deployments** → tick `npm` → **Approve and deploy**. GitHub also notifies you. The verify job (tests, build, pack, dry-run publish) has already passed at this point; publishing takes about a minute.

**4. Check.**

```powershell
npm.cmd view offlibrary dist-tags --registry https://registry.npmjs.org
```

[npmjs.com/package/offlibrary](https://www.npmjs.com/package/offlibrary) shows the version with a *Built and signed on GitHub Actions* provenance badge.


### If something goes wrong

- **The run is red but the "npm publish" step is green.** The version is on npm; npm was just slow to show it (this happened on 2026-10-31, when the check waited only 60 s; it now waits up to 5 minutes). Check with `npm.cmd view offlibrary@x.y.z version --registry https://registry.npmjs.org`. Do **not** re-run the job: npm never accepts the same version twice, so a re-run can only fail.
- **The verify job failed** (tag/version mismatch, tests). Nothing was published. Delete the release and its tag (release page → Delete; then `git push origin :refs/tags/vX.Y.Z`), fix `main`, and create the release again.
- **The release ran nothing at all.** A release only runs the workflow if `.github/workflows/release.yml` exists in the tagged commit. A release whose tag predates the workflow never publishes: bump to the next version and release that.
- **Publish failed with `ENEEDAUTH`/`E404`.** The trusted publisher on npmjs.com (offlibrary → Settings → Trusted publishing) must name user `webmaxru`, repository `offlibrary`, workflow `release.yml`, environment `npm`.
- A version on npm is permanent. A mistake gets fixed in the next version, never by reusing a number.

Publishing from your own machine still works (section below) and is the fallback if GitHub Actions is unavailable. Use one route per version. If you publish by hand and create the GitHub Release afterwards, the workflow sees the version on npm and publishes nothing.

## Fallback: publish from your machine

Only when the GitHub Actions route above is not available.

### One command: `scripts/publish.ps1`

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

### Before the first release (one time)

```powershell
npm.cmd login --registry https://registry.npmjs.org
npm.cmd whoami --registry https://registry.npmjs.org
```

`offlibrary` 0.1.0 was published on 2026-10-19 (tag `v0.1.0`), so the name is yours; `--access public` below is harmless for an unscoped package.

### Release steps

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

# 4. Check what will be published (0.2.x: about 46 files, about 80 kB packed: dist/ incl. the workbox entry,
#    README.md, LICENSE, CHANGELOG.md, package.json)
npm.cmd pack --dry-run
npm.cmd run check:package   # installs the tarball into a temp project and type-checks it

# 5. Publish (prepublishOnly re-runs typecheck, tests, build and the size budget)
npm.cmd publish --access public --registry https://registry.npmjs.org --otp 123456
#    Replace 123456 with your authenticator code; drop --otp if npm opens a browser to confirm.

# 6. Verify
npm.cmd view offlibrary version --registry https://registry.npmjs.org

# 7. Tag the release (use your version)
git tag vX.Y.Z
git push origin vX.Y.Z
```

Then create a GitHub release from the tag and paste the CHANGELOG section into it. The release workflow runs, sees the version already on npm and publishes nothing.

The documentation site (https://salnikov.no/offlibrary/) and the demo deploy on their own from `main` (workflow **Docs site + demo → GitHub Pages**); they build from the repo's source, not from npm, so they don't wait for the publish.

The CDN links in the README (`cdn.jsdelivr.net/npm/offlibrary@0/...`) work as soon as npm has the version. If jsDelivr serves an older copy, purge the files:

```powershell
'offlibrary.min.js','offlibrary-sw.min.js','offlibrary-sw.iife.js','offlibrary-workbox.iife.js' | ForEach-Object {
  Invoke-RestMethod "https://purge.jsdelivr.net/npm/offlibrary@0/dist/$_" | Select-Object -ExpandProperty status
}
```

### Next releases (manual route)

1. Move the `Unreleased` notes in `CHANGELOG.md` under a new version heading with today's date.
2. Bump the version without creating a tag yet:

   ```powershell
   npm.cmd version 0.1.1 --no-git-tag-version
   git commit -am "release: 0.1.1"
   git push
   ```

3. Wait for CI to pass on main, then run the **Release steps** above with the new version in step 7.

Pre-1.0, use minor bumps (`0.2.0`) for breaking changes and call them out in the changelog.
