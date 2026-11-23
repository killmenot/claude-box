#!/bin/sh
# Container entrypoint wrapper: give the run uid a NAME, then drop to it.
#
# compose runs this image with user = BOX_UID/BOX_GID (the host user, see claude-box) so the
# ./home bind mount stays writable. A numeric uid that is not in /etc/passwd makes bash show
# "I have no name!" and confuses tools that look the user up. So the wrapper starts as root
# (compose: user "0:0"), appends a `box` passwd/group entry for the uid if it is missing, and
# re-execs the real server under the uid via setpriv. No container process stays root.
set -eu

uid="${BOX_UID:-1000}"
gid="${BOX_GID:-1000}"

if [ "$(id -u)" = "0" ] && ! grep -q "^[^:]*:[^:]*:$uid:" /etc/passwd; then
  echo "box:x:$uid:$gid:Box:/home/node:/bin/bash" >> /etc/passwd
fi
if [ "$(id -u)" = "0" ] && ! grep -q "^[^:]*:[^:]*:$gid:" /etc/group; then
  echo "box:x:$gid:" >> /etc/group
fi

exec setpriv --reuid "$uid" --regid "$gid" --init-groups --inh-caps=-all \
  env HOME=/home/node claude-web-serve "$@"
