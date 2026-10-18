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
    treeviteMyInvites)
      case " $rust_api_locations " in *" treeviteMyInvites "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/treevite/myInvites ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} treeviteMyInvites"
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
    recentActivity)
      case " $rust_api_locations " in *" recentActivity "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/conversations/recent_activity ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} recentActivity"
      ;;
    allConversations)
      case " $rust_api_locations " in *" allConversations "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/all_conversations ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} allConversations"
      ;;
    reportsRead)
      case " $rust_api_locations " in *" reportsRead "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/reports ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} reportsRead"
      ;;
    bidToPid)
      case " $rust_api_locations " in *" bidToPid "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/bidToPid ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} bidToPid"
      ;;
    conversationStats)
      case " $rust_api_locations " in *" conversationStats "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/conversationStats ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} conversationStats"
      ;;
    topicSelections)
      case " $rust_api_locations " in *" topicSelections "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/topicAgenda/selections ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} topicSelections"
      ;;
    einvitesRead)
      case " $rust_api_locations " in *" einvitesRead "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/einvites ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} einvitesRead"
      ;;
    createPage)
      case " $rust_api_locations " in *" createPage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/conversation/create ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} createPage"
      ;;
    userCreatePage)
      case " $rust_api_locations " in *" userCreatePage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/user/create(/.*)?$ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} userCreatePage"
      ;;
    userLoginPage)
      case " $rust_api_locations " in *" userLoginPage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/user/login(/.*)?$ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} userLoginPage"
      ;;
    settingsPage)
      case " $rust_api_locations " in *" settingsPage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/settings(/.*)?$ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} settingsPage"
      ;;
    userLogoutPage)
      case " $rust_api_locations " in *" userLogoutPage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/user/logout(/.*)?$ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} userLogoutPage"
      ;;
    adminPage)
      case " $rust_api_locations " in *" adminPage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/m/[0-9][0-9A-Za-z]+ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} adminPage"
      ;;
    integratePage)
      case " $rust_api_locations " in *" integratePage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/integrate ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} integratePage"
      ;;
    otherConversationsPage)
      case " $rust_api_locations " in *" otherConversationsPage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/other-conversations ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} otherConversationsPage"
      ;;
    delphiRead)
      case " $rust_api_locations " in *" delphiRead "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/delphi ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} delphiRead"
      ;;
    delphiReports)
      case " $rust_api_locations " in *" delphiReports "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/delphi/reports ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} delphiReports"
      ;;
    delphiVisualizations)
      case " $rust_api_locations " in *" delphiVisualizations "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/delphi/visualizations ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} delphiVisualizations"
      ;;
    topicStats)
      case " $rust_api_locations " in *" topicStats "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/topicStats ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} topicStats"
      ;;
    collectiveStatement)
      case " $rust_api_locations " in *" collectiveStatement "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/collectiveStatement ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} collectiveStatement"
      ;;
    opsWhoami)
      case " $rust_api_locations " in *" opsWhoami "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/ops/whoami ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} opsWhoami"
      ;;
    opsPage)
      case " $rust_api_locations " in *" opsPage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/api/v3/ops/page/ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} opsPage"
      ;;
    xidReport)
      case " $rust_api_locations " in *" xidReport "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/api/v3/xid/[^/]+$ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} xidReport"
      ;;
    topicPrioritize)
      case " $rust_api_locations " in *" topicPrioritize "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/participation/topicPrioritize ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} topicPrioritize"
      ;;
    legacyConversations)
      case " $rust_api_locations " in *" legacyConversations "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/conversations ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} legacyConversations"
      ;;
    treeviteMe)
      case " $rust_api_locations " in *" treeviteMe "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/treevite/me ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} treeviteMe"
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
    treeviteInvites)
      case " $rust_api_locations " in *" treeviteInvites "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/treevite/invites ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} treeviteInvites"
      ;;
    treeviteCsv)
      case " $rust_api_locations " in *" treeviteCsv "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/treevite/invites/csv ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} treeviteCsv"
      ;;
    conversationPreload)
      case " $rust_api_locations " in *" conversationPreload "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/conversations/preload ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} conversationPreload"
      ;;
    participationRead)
      case " $rust_api_locations " in *" participationRead "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/participation ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} participationRead"
      ;;
    treeviteWaves)
      case " $rust_api_locations " in *" treeviteWaves "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/treevite/waves ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} treeviteWaves"
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
    legacyPca)
      case " $rust_api_locations " in *" legacyPca "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/math/pca ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} legacyPca"
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
  echo "ERROR RUST_API_ROUTES: unknown route(s):${rust_api_unknown} (known: pca2 owner-conversations comments nextComment testConnection testDatabase contexts domainWhitelist metadataQuestions metadataAnswers metadataRead metadataChoices recentStarted recentActivity legacyPca treeviteWaves treeviteInvites treeviteCsv conversationPreload participationRead allConversations reportsRead bidToPid conversationStats topicSelections treeviteMyInvites treeviteMe topicPrioritize xidReport opsPage opsWhoami collectiveStatement topicStats delphiVisualizations delphiReports delphiRead otherConversationsPage integratePage adminPage userLogoutPage settingsPage userLoginPage userCreatePage createPage einvitesRead legacyConversations robots about). Every route stays on Node." >&2
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
