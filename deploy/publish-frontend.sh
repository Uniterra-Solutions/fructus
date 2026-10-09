#!/usr/bin/env bash
# Build the fructus frontend and publish it to the nginx web root.
# (nginx workers cannot traverse /root, hence the /var/www copy.)
set -euo pipefail

export PATH="/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
cd /root/data/fructus/frontend

/usr/local/bin/npm run build
mkdir -p /var/www/fructus
rsync -a --delete dist/ /var/www/fructus/
echo "publish-frontend: $(find /var/www/fructus -type f | wc -l) files -> /var/www/fructus"
