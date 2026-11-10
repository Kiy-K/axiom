#!/bin/sh
# Use readline even when input arrives before the first prompt; never load developer startup files.
export PS1='$ '
exec /bin/bash --noprofile --norc -i
