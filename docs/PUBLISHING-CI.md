# Publishing `offlibrary` from GitHub Actions

`.github/workflows/release.yml` publishes `offlibrary` to npm when you **publish a GitHub Release** named `vX.Y.Z`. It uses **npm trusted publishing** (OIDC): no npm token is stored anywhere, and every version gets a **provenance** attestation linking it to the exact commit and workflow run. Before anything is uploaded, you approve the run in GitHub (the protected `npm` environment).

Commands are for **Windows PowerShell 5.1** (`npm.cmd`, because `npm.ps1` may be blocked). Every npm command that talks to the registry carries `--registry https://registry.npmjs.org`. You need `gh` (GitHub CLI) logged in as `webmaxru`.

> **Status:** this is an alternative to the local route in `RELEASING.md` (`scripts/publish.ps1`). Use one route per version. If you publish a version locally and create a GitHub Release from its tag afterwards (publish.ps1 prints the link), this workflow sees the version on npm and publishes nothing.

## What the workflow does

| Trigger | What runs |
| --- | --- |
| Release published (`vX.Y.Z`) | **verify** (Node 22): the tag must equal `v` + `package.json` version, the tagged commit must be on `main`. If the version is already on npm (say you published it by hand), the run ends green with "nothing to publish". Then typecheck, unit tests, build, size budget, `npm pack --dry-run`, `scripts/check-package.mjs`, and `npm publish --dry-run`. → **publish** (Node 24, npm 11): waits for your approval in the `npm` environment, builds, runs `npm publish --provenance --tag <latest/next>`, confirms the version on the registry. |
| Actions → *Release to npm* → *Run workflow* | verify only (a dry run; it never publishes) |
| A PR that changes `release.yml` | verify only |

Dist-tag: a prerelease version (`0.3.0-beta.1`) **or** a release with *Set as a pre-release* ticked goes to `next`; everything else goes to `latest`.

## One-time setup

Do these in order. **Step 3 starts a 2-day clock**: npm expires a new trusted publisher that has not published within 2 days ([npm docs](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry)). So add it only when you are ready to release.

### 1. Merge the PR that adds `release.yml`

The release must point at a commit that contains the workflow.

### 2. Create the `npm` environment with you as required reviewer

Web: **webmaxru/offlibrary → Settings → Environments → New environment** → name `npm` → **Configure environment**:

- **Required reviewers**: tick, add `webmaxru`. Leave *Prevent self-review* **off**: you start the release and approve it yourself.
- **Deployment branches and tags**: *Selected branches and tags* → **Add deployment branch or tag rule** → Ref type **Tag**, pattern `v*`.
- **Save protection rules**.

Or with `gh` (PowerShell 5.1; `1560278` is webmaxru's GitHub user id):

```powershell
'{"reviewers":[{"type":"User","id":1560278}],"prevent_self_review":false,"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' | gh api -X PUT repos/webmaxru/offlibrary/environments/npm --input -
gh api -X POST repos/webmaxru/offlibrary/environments/npm/deployment-branch-policies -f "name=v*" -f "type=tag"
gh api repos/webmaxru/offlibrary/environments/npm --jq "{name: .name, rules: [.protection_rules[].type]}"
```

Do this **before** the first release. If the workflow runs first, GitHub creates `npm` automatically **without** any protection.

### 3. Add the trusted publisher on npmjs.com (only when ready to release, see the 2-day note)

**npmjs.com → sign in → [offlibrary](https://www.npmjs.com/package/offlibrary) → Settings → Trusted publishing → GitHub Actions**, then:

| Field | Value |
| --- | --- |
| Organization or user | `webmaxru` |
| Repository | `offlibrary` |
| Workflow filename | `release.yml` (the filename only, not the path) |
| Environment name | `npm` |
| Allowed actions | tick **npm publish** (stage publish is always allowed) |

All fields are case-sensitive, and npm does not check them when you save: a typo only shows up as an auth error or `E404` at publish time. `package.json` already has `repository.url` = `git+https://github.com/webmaxru/offlibrary.git`, which must match exactly.

The same thing from the terminal (npm ≥ 11.15; asks for your 2FA in the browser):

```powershell
npm.cmd install -g npm@11 --registry https://registry.npmjs.org
npm.cmd trust github offlibrary --repo webmaxru/offlibrary --file release.yml --env npm --allow-publish --registry https://registry.npmjs.org
npm.cmd trust list offlibrary --registry https://registry.npmjs.org
```

### 4. Cut the first release (see below) and approve it

### 5. After the first CI publish succeeds: lock down tokens

**npmjs.com → offlibrary → Settings → Publishing access → "Require two-factor authentication and disallow tokens" → Update Package Settings.** Trusted publishing keeps working (it is not a token); local `npm publish` with your 2FA still works; token publishing stops. Then delete any old npm automation tokens you no longer use (avatar → Access Tokens).

## Cutting a release

```powershell
git checkout main
git pull --ff-only
git status                                     # must be clean

# 1. Changelog: move the Unreleased notes under the new version with today's date (edit CHANGELOG.md).
# 2. Bump package.json + package-lock.json (no tag yet). Skip this if package.json already has the
#    version you want to release (0.2.0 on main today; then sync the lockfile once:
#    npm.cmd install --package-lock-only --registry https://registry.npmjs.org). Otherwise pick one:
npm.cmd version patch --no-git-tag-version     # 0.2.0 -> 0.2.1
#   npm.cmd version minor --no-git-tag-version                     # 0.2.0 -> 0.3.0
#   npm.cmd version prerelease --preid beta --no-git-tag-version   # 0.3.0-beta.0 -> dist-tag next
$v = node -p "require('./package.json').version"
git commit -am "release: $v"
git push

# 3. Wait for CI on main to be green
gh run watch (gh run list --workflow ci.yml --branch main --limit 1 --json databaseId --jq ".[0].databaseId")

# 4. Tag that commit and publish the GitHub Release (this starts the workflow)
git tag "v$v"
git push origin "v$v"
gh release create "v$v" --verify-tag --title "v$v" --generate-notes
#   prerelease: add --prerelease   (goes to dist-tag next)
```

The browser e2e suites run in `ci.yml` on `main` and are not repeated here, so tag only a commit whose CI is green.

Then approve: **Actions → Release to npm → the run → Review deployments → tick `npm` → Approve and deploy** (GitHub also emails/notifies you). The publish job takes about a minute.

Check it:

```powershell
npm.cmd view offlibrary version --registry https://registry.npmjs.org
npm.cmd view offlibrary dist-tags --registry https://registry.npmjs.org
```

If a check fails before approval (tag/version mismatch, tag not on `main`, tests), nothing was published: delete the release and tag (`gh release delete "v$v" --cleanup-tag --yes`), fix, and release again.

## Verify provenance

- **npmjs.com**: open `https://www.npmjs.com/package/offlibrary/v/<version>`. A **green check mark** next to the version (right of the README) means it was published with provenance. Click it → **View more details**: Build Summary links the workflow run, Source Commit the commit, Build File `release.yml`, Public Ledger the Sigstore transparency entry ([npm docs](https://docs.npmjs.com/viewing-package-provenance/)).
- **CLI**: `npm.cmd view offlibrary@<version> dist.attestations --registry https://registry.npmjs.org` shows the attestation URL. In any project that installs it: `npm.cmd audit signatures --registry https://registry.npmjs.org` → "verified attestations".

## Rollback

A published version can never be changed or reused. To steer users away from a bad one (both need your 2FA, from your machine):

```powershell
# point "latest" back at the previous good version
npm.cmd dist-tag add offlibrary@<good-version> latest --registry https://registry.npmjs.org
# warn anyone who installs the bad one
npm.cmd deprecate offlibrary@<bad-version> "Broken, use <good-version> or later" --registry https://registry.npmjs.org
# undo the warning later
npm.cmd undeprecate offlibrary@<bad-version> --registry https://registry.npmjs.org
```

Then ship the fix as the next patch. `npm unpublish` is only allowed in narrow cases (within 72 hours, no dependents), see [npm's unpublish policy](https://docs.npmjs.com/policies/unpublish); deprecate + dist-tag is the normal route.

## Fallback: a token instead of trusted publishing

Use this only if trusted publishing is blocked for some reason. The workflow already passes `secrets.NPM_TOKEN`; npm uses OIDC first and the token only if OIDC is not available.

1. **npmjs.com → avatar → Access Tokens → Generate New Token**: name `offlibrary-gha`; **Bypass two-factor authentication** ticked (CI cannot type a code); Packages and scopes → **Read and write (publish and stage)** → *Only select packages* → `offlibrary`; set an expiration; **Generate Token**, copy it.
2. Store it (gh prompts for the value, so it stays out of your shell history):

   ```powershell
   gh secret set NPM_TOKEN --repo webmaxru/offlibrary
   ```

3. Don't use "Require 2FA and disallow tokens" (step 5) with this route.

Caveats: npm is phasing these tokens out. 2FA-bypass tokens lose **direct publish**, targeted for **January 2027** (stage-only after that; [npm announcement](https://github.com/orgs/community/discussions/201329)). A token is a long-lived secret; trusted publishing has neither problem. To go back: `gh secret delete NPM_TOKEN --repo webmaxru/offlibrary` and revoke the token on npmjs.com.

## Troubleshooting

- `ENEEDAUTH` / `E404` on publish: the trusted publisher fields don't match the run (user, repo, `release.yml`, environment `npm`), or the configuration expired (more than 2 days without a publish: delete it and add it again).
- Trusted publishing needs npm ≥ 11.5.1 and Node ≥ 22.14 on a GitHub-hosted runner; the publish job uses Node 24 (bundles npm 11) and checks this.
- Provenance only works from a **public** repository (this one is public).

## Sources (read 2026-10-20)

- npm: [Trusted publishing](https://docs.npmjs.com/trusted-publishers/), [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/), [Staged publishing](https://docs.npmjs.com/staged-publishing/), [Viewing provenance](https://docs.npmjs.com/viewing-package-provenance/), [Generating provenance](https://docs.npmjs.com/generating-provenance-statements/), [Requiring 2FA / disallowing tokens](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/), [Creating access tokens](https://docs.npmjs.com/creating-and-viewing-access-tokens/), [2FA-bypass token changes](https://github.com/orgs/community/discussions/201329)
- GitHub: [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [REST: environments](https://docs.github.com/en/rest/deployments/environments), [OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect), [setup-node: publishing with trusted publishing](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md#publishing-to-npm-with-trusted-publisher-oidc)
