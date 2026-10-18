#!/bin/sh
set -e

# Set default value for API_SERVER_PORT
export API_SERVER_PORT=${API_SERVER_PORT:-5000}

# Replace environment variables in the Nginx config
envsubst '${API_SERVER_PORT}' </etc/nginx/conf.d/default.conf.template >/etc/nginx/conf.d/default.conf

# Rust API routes. RUST_API_ROUTES is a comma-separated list of routes that
# polis-api serves instead of Node ("pca2", "owner-conversations", "comments" and "nextComment"). Unset or empty, both
# include files below stay empty and the rendered config routes everything to
# Node exactly as before. No value of these settings can take the proxy down:
# a name that is not a known route, an upstream or resolver that is not a
# plain host[:port] list, or a rendered configuration that nginx -t refuses
# is reported loudly and every route stays on Node. A route named twice is
# rendered once.
mkdir -p /etc/nginx/rust-api
: >/etc/nginx/rust-api/upstreams.conf
: >/etc/nginx/rust-api/locations.conf
RUST_API_MAP_ENTRIES=""
rust_api_locations=""
rust_api_unknown=""
export RUST_API_UPSTREAM=${RUST_API_UPSTREAM:-polis-api:5100}
for route in $(echo "${RUST_API_ROUTES:-}" | tr ',' ' '); do
  case "$route" in
    pca2)
      case " $rust_api_locations " in *" pca2 "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/math/pca2 ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} pca2"
      ;;
    owner-conversations)
      case " $rust_api_locations " in *" owner-conversations "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/owner/conversations ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} owner-conversations"
      ;;
    comments)
      case " $rust_api_locations " in *" comments "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/comments ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} comments"
      ;;
    nextComment)
      case " $rust_api_locations " in *" nextComment "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/nextComment ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} nextComment"
      ;;
    about)
      case " $rust_api_locations " in *" about "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /about ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} about"
      ;;
    robots)
      case " $rust_api_locations " in *" robots "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /robots.txt ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} robots"
      ;;
    domainWhitelist)
      case " $rust_api_locations " in *" domainWhitelist "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/domainWhitelist ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} domainWhitelist"
      ;;
    metadataAnswers)
      case " $rust_api_locations " in *" metadataAnswers "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/metadata/answers ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} metadataAnswers"
      ;;
    metadataRead)
      case " $rust_api_locations " in *" metadataRead "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/metadata ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} metadataRead"
      ;;
    recentStarted)
      case " $rust_api_locations " in *" recentStarted "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/conversations/recently_started ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} recentStarted"
      ;;
    metadataChoices)
      case " $rust_api_locations " in *" metadataChoices "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/metadata/choices ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} metadataChoices"
      ;;
    metadataQuestions)
      case " $rust_api_locations " in *" metadataQuestions "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/metadata/questions ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} metadataQuestions"
      ;;
    contexts)
      case " $rust_api_locations " in *" contexts "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/contexts ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} contexts"
      ;;
    testDatabase)
      case " $rust_api_locations " in *" testDatabase "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/testDatabase ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} testDatabase"
      ;;
    testConnection)
      case " $rust_api_locations " in *" testConnection "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/testConnection ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} testConnection"
      ;;
    *)
      rust_api_unknown="${rust_api_unknown} ${route}"
      ;;
  esac
done
export RUST_API_RESOLVER=${RUST_API_RESOLVER:-127.0.0.11}
if [ -n "$rust_api_unknown" ]; then
  echo "ERROR RUST_API_ROUTES: unknown route(s):${rust_api_unknown} (known: pca2 owner-conversations comments nextComment testConnection testDatabase contexts domainWhitelist metadataQuestions metadataAnswers metadataRead metadataChoices recentStarted robots about). Every route stays on Node." >&2
elif [ -n "$RUST_API_MAP_ENTRIES" ] &&
  ! echo "$RUST_API_UPSTREAM" | grep -Eqx '[A-Za-z0-9._-]+:[0-9]{1,5}'; then
  echo "ERROR RUST_API_UPSTREAM: '${RUST_API_UPSTREAM}' is not host:port. Every route stays on Node." >&2
elif [ -n "$RUST_API_MAP_ENTRIES" ] &&
  ! echo "$RUST_API_RESOLVER" | grep -Eqx '[][A-Za-z0-9.:_-]+( [][A-Za-z0-9.:_=-]+)*'; then
  echo "ERROR RUST_API_RESOLVER: '${RUST_API_RESOLVER}' is not a list of resolver addresses. Every route stays on Node." >&2
elif [ -n "$RUST_API_MAP_ENTRIES" ]; then
  export RUST_API_MAP_ENTRIES
  envsubst '${RUST_API_RESOLVER} ${RUST_API_MAP_ENTRIES}' \
    </etc/nginx/rust-api-templates/upstreams.conf.template >/etc/nginx/rust-api/upstreams.conf
  for route in $rust_api_locations; do
    cat /etc/nginx/rust-api-templates/${route}.location.conf.template >>/etc/nginx/rust-api/locations.conf
  done
  envsubst '${API_SERVER_PORT}' \
    </etc/nginx/rust-api-templates/node.location.conf.template >>/etc/nginx/rust-api/locations.conf
  if ! rust_api_check=$(nginx -t -q 2>&1); then
    : >/etc/nginx/rust-api/upstreams.conf
    : >/etc/nginx/rust-api/locations.conf
    echo "ERROR RUST_API_ROUTES: nginx refused the rendered Rust API configuration; every route stays on Node. nginx -t said: ${rust_api_check}" >&2
  else
    echo "nginx: Rust API routes enabled:${rust_api_locations} -> ${RUST_API_UPSTREAM}, Node as fallback"
  fi
fi

# Execute the original Docker entrypoint with the provided arguments
exec "$@"
