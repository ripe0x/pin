# Setup: artist-page template sync

One-time setup for the workflow at [`sync-artist-page-template.yml`](./sync-artist-page-template.yml). After this, every push to `main` that touches `templates/artist-page/` automatically mirrors to the standalone public repo backing the deploy buttons.

This is one-way: the monorepo is upstream, the public repo is a deploy target. Don't accept PRs against the public repo — they'd be force-pushed away on the next sync.

## Steps

### 1. Create the destination repo

On GitHub, create a new public repository — for example `pnd-network/sovereign-artist-site`. Keep it empty (no README, no LICENSE, no `.gitignore`). The first sync will populate it.

### 2. Generate an SSH deploy key

Locally, in a temp directory you don't mind throwing away:

```bash
ssh-keygen -t ed25519 -C "artist-page-template-sync" -f template-deploy-key -N ""
```

That makes two files: `template-deploy-key` (private) and `template-deploy-key.pub` (public).

### 3. Register the public key on the destination repo

Go to **destination repo → Settings → Deploy keys → Add deploy key**.

- **Title:** `monorepo-sync`
- **Key:** paste the contents of `template-deploy-key.pub`
- **Allow write access:** ✅ (required — the action pushes to `main`)

Save.

### 4. Register the private key as a secret on this repo

Go to **this monorepo → Settings → Secrets and variables → Actions → Secrets → New repository secret**.

- **Name:** `TEMPLATE_DEPLOY_KEY`
- **Secret:** paste the contents of `template-deploy-key` (the private one — full file including the `-----BEGIN…` and `-----END…` lines)

Save.

### 5. Register the destination repo URL as a variable

Same page, **Variables** tab → **New repository variable**.

- **Name:** `TEMPLATE_REPO`
- **Value:** `git@github.com:OWNER/REPO.git` (e.g. `git@github.com:pnd-network/sovereign-artist-site.git` — note SSH format, not HTTPS)

Save.

### 6. Securely delete the local key files

```bash
rm template-deploy-key template-deploy-key.pub
```

The keys live in GitHub now; you don't need them locally and shouldn't keep copies.

### 7. Trigger the first sync

Either commit something to `templates/artist-page/` and push (the path filter will trigger the workflow), or go to **Actions → Sync artist-page template to public repo → Run workflow**. Watch the run; the first one is the slow one because the destination repo is empty.

After it completes, the destination repo will have the entire `templates/artist-page/` content as its root, and the deploy buttons in `apps/web/src/components/sites/DeployButtons.tsx` will point at a real, deployable repo.

## Updating the deploy button URLs

Once the destination repo is live, update the `TEMPLATE_REPO_URL` constant:

- File: [`apps/web/src/components/sites/DeployButtons.tsx`](../../apps/web/src/components/sites/DeployButtons.tsx)
- Currently: `https://github.com/ripe0x/sovereign-artist-site`
- Change to: `https://github.com/<OWNER>/<REPO>` matching what you created

And the equivalent URLs in [`templates/artist-page/README.md`](../../templates/artist-page/README.md) (search for `sovereign-artist-site`).

## Rotating the deploy key

If the deploy key is ever compromised:

1. Delete the key from the destination repo's Deploy keys page (revokes it immediately)
2. Generate a new one (step 2 above)
3. Re-register on the destination repo (step 3)
4. Replace the value of the `TEMPLATE_DEPLOY_KEY` secret in this monorepo (step 4)

## Rolling back a bad sync

The action force-pushes — if you push something broken from this monorepo, just push the fix and the next sync overwrites the bad state. No `git revert` dance on the destination repo.

If you need to roll the destination back without a corresponding fix in this monorepo, do it manually on the destination (`git push --force` from a known-good commit), and accept that the next push to the monorepo's template subdir will overwrite that rollback.
