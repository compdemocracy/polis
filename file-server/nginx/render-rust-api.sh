#!/bin/sh
set -eu
export API_SERVER_PORT=${API_SERVER_PORT:-5000}
# Rust API routes. RUST_API_ROUTES is a comma-separated list of routes that
# polis-api serves instead of Node ("pca2", "owner-conversations", "comments" and "nextComment"). Unset or empty, both
# include files below stay empty and the rendered config routes everything to
# Node exactly as before. No value of these settings can take the proxy down:
# a name that is not a known route, an upstream or resolver that is not a
# plain host[:port] list, or a rendered configuration that nginx -t refuses
# is reported loudly and every route stays on Node. A route named twice is
# rendered once.
mkdir -p "$1"
: >${1}/upstreams.conf
: >${1}/locations.conf
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
    conversationPage)
      case " $rust_api_locations " in *" conversationPage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/[0-9][0-9A-Za-z]+ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} conversationPage"
      ;;
    explorePage)
      case " $rust_api_locations " in *" explorePage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/explore/[0-9][0-9A-Za-z]+ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} explorePage"
      ;;
    sharePage)
      case " $rust_api_locations " in *" sharePage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/share/[0-9][0-9A-Za-z]+ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} sharePage"
      ;;
    summaryPage)
      case " $rust_api_locations " in *" summaryPage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/summary/[0-9][0-9A-Za-z]+ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} summaryPage"
      ;;
    oneTimePage)
      case " $rust_api_locations " in *" oneTimePage "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/ot/[0-9][0-9A-Za-z]+ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} oneTimePage"
      ;;
    iip)
      case " $rust_api_locations " in *" iip "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/iip/[^/]+/?$ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} iip"
      ;;
    iim)
      case " $rust_api_locations " in *" iim "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/iim/[^/]+/?$ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} iim"
      ;;
    participantsRead)
      case " $rust_api_locations " in *" participantsRead "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/participants ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} participantsRead"
      ;;
    ptptois)
      case " $rust_api_locations " in *" ptptois "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/ptptois ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} ptptois"
      ;;
    myInvitesCsv)
      case " $rust_api_locations " in *" myInvitesCsv "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/treevite/myInvites/csv ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} myInvitesCsv"
      ;;
    bid)
      case " $rust_api_locations " in *" bid "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/bid ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} bid"
      ;;
    locations)
      case " $rust_api_locations " in *" locations "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/locations ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} locations"
      ;;
    votesRead)
      case " $rust_api_locations " in *" votesRead "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/votes ${RUST_API_UPSTREAM};
    /api/v3/votes/me ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} votesRead"
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
    statementImportance)
      case " $rust_api_locations " in *" statementImportance "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/statements/importance ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} statementImportance"
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
    delphiLogs)
      case " $rust_api_locations " in *" delphiLogs "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/delphi/logs ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} delphiLogs"
      ;;
    delphiRun)
      case " $rust_api_locations " in *" delphiRun "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/delphi/run ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} delphiRun"
      ;;
    delphiResult)
      case " $rust_api_locations " in *" delphiResult "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/api/v3/delphi/runs/[^/]+$ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} delphiResult"
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
    opsCatchall)
      case " $rust_api_locations " in *" opsCatchall "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/api/v3/ops(?:$|/(?!whoami(?:/|$)|page(?:/|$))) ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} opsCatchall"
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
    testConnection)
      case " $rust_api_locations " in *" testConnection "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/testConnection ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} testConnection"
      ;;
    reportExportPg)
      case " $rust_api_locations " in *" reportExportPg "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    ~^/api/v3/reportExport/[^/]+/(?:format[.]json|summary[.]csv|comments[.]csv|votes[.]csv|participant-votes[.]csv|participant-importance[.]csv|comment-groups[.]csv)$ ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} reportExportPg"
      ;;
    metadataQuery)
      case " $rust_api_locations " in *" metadataQuery "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/query_participants_by_metadata ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} metadataQuery"
      ;;
    perfStats)
      case " $rust_api_locations " in *" perfStats "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /perfStats_9182738127 ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} perfStats"
      ;;
    *)
      rust_api_unknown="${rust_api_unknown} ${route}"
      ;;
  esac
done
export RUST_API_RESOLVER=${RUST_API_RESOLVER:-127.0.0.11}
if [ -n "$rust_api_unknown" ]; then
  echo "ERROR RUST_API_ROUTES: unknown route(s):${rust_api_unknown} (known: pca2 owner-conversations comments nextComment reportExportPg metadataQuery testConnection perfStats testDatabase contexts domainWhitelist metadataQuestions metadataAnswers conversationPage explorePage sharePage summaryPage oneTimePage iip iim locations bid myInvitesCsv participantsRead ptptois votesRead metadataRead metadataChoices recentStarted recentActivity treeviteWaves treeviteInvites treeviteCsv conversationPreload participationRead allConversations reportsRead bidToPid conversationStats statementImportance topicSelections treeviteMyInvites treeviteMe topicPrioritize xidReport opsCatchall opsPage opsWhoami collectiveStatement topicStats delphiLogs delphiRun delphiResult delphiVisualizations delphiReports delphiRead otherConversationsPage integratePage adminPage userLogoutPage settingsPage userLoginPage userCreatePage createPage einvitesRead legacyConversations robots about). Selection rejected." >&2
  exit 1
elif [ -n "$RUST_API_MAP_ENTRIES" ] &&
  ! echo "$RUST_API_UPSTREAM" | grep -Eqx '[A-Za-z0-9._-]+:[0-9]{1,5}'; then
  echo "ERROR RUST_API_UPSTREAM: '${RUST_API_UPSTREAM}' is not host:port. Selection rejected." >&2
  exit 1
elif [ -n "$RUST_API_MAP_ENTRIES" ] &&
  ! echo "$RUST_API_RESOLVER" | grep -Eqx '[][A-Za-z0-9.:_-]+( [][A-Za-z0-9.:_=-]+)*'; then
  echo "ERROR RUST_API_RESOLVER: '${RUST_API_RESOLVER}' is not a list of resolver addresses. Selection rejected." >&2
  exit 1
elif [ -n "$RUST_API_MAP_ENTRIES" ]; then
  export RUST_API_MAP_ENTRIES
  envsubst '${RUST_API_RESOLVER} ${RUST_API_MAP_ENTRIES}' \
    </etc/nginx/rust-api-templates/upstreams.conf.template >${1}/upstreams.conf
  for route in $rust_api_locations; do
    cat /etc/nginx/rust-api-templates/${route}.location.conf.template >>${1}/locations.conf
  done
  envsubst '${API_SERVER_PORT}' \
    </etc/nginx/rust-api-templates/node.location.conf.template >>${1}/locations.conf
fi
[ -z "$rust_api_unknown" ] || exit 1
