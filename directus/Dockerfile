# Sara CRM — Directus with the five extensions BAKED IN.
#
#   docker build -f directus/Dockerfile -t crm/directus:<tag> .
#   (build context is the REPO ROOT, not directus/)
#
# WHY THIS IMAGE EXISTS
#
# Locally and on a VM, `directus/extensions` is BIND-MOUNTED into the stock
# directus/directus:11 image. Fargate cannot bind-mount a host path — there is
# no host — so on ECS the stock image starts with NO extensions and nothing says
# so. The visible symptom is that the admin portal's roles editor simply does
# not exist, because `app-roles-sync` is not there; the rest fail just as
# quietly. That is what the 2026-08-06 ECS deployment shipped.
#
# Baking them in is also better practice than bind-mounting anywhere: the image
# becomes self-describing and versioned, so "which extensions are running?" is
# answered by the image tag rather than by whatever happens to be in a directory
# on some host.
#
# WHAT IS COPIED
#
# All five are self-contained: a package.json plus a single index.js. Four are
# plain-JS hooks with no build step; super-header-interface is a Vue interface
# whose dist/ is committed. So there is nothing to compile here — a builder
# stage would add minutes and change nothing.
#
#   app-roles-sync            hook  — roles editor + brand scoping (admin portal)
#   cast-custom-field-value   hook
#   lock-project-owner        hook
#   notify-on-change          hook
#   super-header-interface    interface (Vue, prebuilt dist/)
#
# If an extension ever gains a real build step, add a builder stage that runs it
# and COPY --from=builder its dist/ — do NOT start bind-mounting again.

FROM directus/directus:11

# The base image runs as UID 1000 (`node`) and Directus reads extensions at
# start-up. Copy as root so ownership is right, then drop back — a COPY as the
# unprivileged user can land unreadable files and Directus skips them SILENTLY,
# which looks identical to not having copied them at all.
USER root

# Each extension keeps its own directory name: Directus discovers extensions by
# scanning EXTENSIONS_PATH for directories whose package.json carries a
# `directus:extension` block. Flattening them would break discovery.
COPY directus/extensions/app-roles-sync/          /directus/extensions/app-roles-sync/
COPY directus/extensions/cast-custom-field-value/ /directus/extensions/cast-custom-field-value/
COPY directus/extensions/lock-project-owner/      /directus/extensions/lock-project-owner/
COPY directus/extensions/notify-on-change/        /directus/extensions/notify-on-change/
COPY directus/extensions/super-header-interface/  /directus/extensions/super-header-interface/

# The schema snapshot, so `directus schema apply` can run inside the container
# without mounting anything. The bootstrap job normally owns schema, but having
# the snapshot in the image makes a manual recovery possible from the task alone.
COPY directus/snapshot/ /directus/snapshot/

RUN chown -R node:node /directus/extensions /directus/snapshot

USER node

# Fail the BUILD if an extension is missing, rather than discovering it in
# production as a feature that quietly does not exist. `test -f` on each entry
# point is cheap and catches a bad COPY path immediately.
RUN set -eu; \
    for ext in app-roles-sync cast-custom-field-value lock-project-owner notify-on-change; do \
      test -f "/directus/extensions/$ext/index.js" || { echo "MISSING: $ext/index.js"; exit 1; }; \
    done; \
    test -f /directus/extensions/super-header-interface/dist/index.js \
      || { echo "MISSING: super-header-interface/dist/index.js — run its build first"; exit 1; }; \
    echo "all five extensions present"

# Inherits ENTRYPOINT/CMD and EXPOSE 8055 from the base image.
#
# NOTE for ECS: a stale "Loaded extensions" log line is NOT proof an extension
# is missing — Directus logs that list once at boot and it can lag. Verify by
# exercising the feature (the admin roles editor), not by reading the log.
