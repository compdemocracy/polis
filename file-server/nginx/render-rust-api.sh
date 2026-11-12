#!/bin/sh
set -eu
export API_SERVER_PORT=${API_SERVER_PORT:-5000}
# Rust API routes. RUST_API_ROUTES is a comma-separated list of routes that
# polis-api serves instead of Node ("pca2", "owner-conversations", "comments" and "nextComment"). Unset or empty, both
# include files below stay empty and API/page requests keep their Node routes. No value of these settings can take the proxy down:
# a name that is not a known route, an upstream or resolver that is not a
# plain host[:port] list, or a rendered configuration that nginx -t refuses
# is reported loudly and every route stays on Node. A route named twice is
# rendered once. votesRead and postVotes share /api/v3/votes: with both
# selected, the postVotes location answers that path for every method and
# votesRead adds only /api/v3/votes/me.
# A shadow name (votesShadow) selects no Rust route: POST /api/v3/votes stays
# Node's, and nginx's mirror sends a copy to the shadow service
# (polis-api-shadow), which writes nothing. With votesRead selected too, the
# POST diversion is inserted first in votesRead's location; otherwise the
# shadow renders that path's location itself. Without a shadow nothing
# rendered changes. A shadow is refused together with the route that writes
# what it observes (votesShadow with postVotes). Only a POST a shadow is sent a
# copy of (a declared body of 1 to 9999 bytes, not chunked) is diverted to
# the shadow's mirroring location; every other request to the path, any other
# POST included, is proxied exactly as with no shadow selected.
# commentsShadow does the same for POST /api/v3/comments, whose read route is
# comments, and its copies have a rate of their own: at most
# COMMENTS_SHADOW_RATE a second on this box and COMMENTS_SHADOW_BURST more at
# once. A copy over that is dropped in the copy's own location; the request
# is never limited. Both shadows may be selected together. No route here
# writes comments yet: the selector that does must be refused together with
# commentsShadow, as postVotes is with votesShadow.
COMMENTS_SHADOW_RATE=2
COMMENTS_SHADOW_BURST=4
mkdir -p "$1"
: >${1}/upstreams.conf
: >${1}/locations.conf
RUST_API_MAP_ENTRIES=""
RUST_API_VOTE_MAP_ENTRIES=""
rust_api_locations=""
rust_api_shadows=""
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
    reportComments)
      case " $rust_api_locations " in *" reportComments "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/comments/report ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} reportComments"
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
    postVotes)
      case " $rust_api_locations " in *" postVotes "*) continue ;; esac
      RUST_API_VOTE_MAP_ENTRIES="    /api/v3/votes ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} postVotes"
      ;;
    votesShadow)
      case " $rust_api_shadows " in *" votesShadow "*) continue ;; esac
      rust_api_shadows="${rust_api_shadows} votesShadow"
      ;;
    commentsShadow)
      case " $rust_api_shadows " in *" commentsShadow "*) continue ;; esac
      rust_api_shadows="${rust_api_shadows} commentsShadow"
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
    version)
      case " $rust_api_locations " in *" version "*) continue ;; esac
      RUST_API_MAP_ENTRIES="${RUST_API_MAP_ENTRIES}    /api/v3/version ${RUST_API_UPSTREAM};
"
      rust_api_locations="${rust_api_locations} version"
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
rust_api_conflict=""
case "$rust_api_shadows:$rust_api_locations " in
  *" votesShadow"*:*" postVotes "*) rust_api_conflict="votesShadow and postVotes" ;;
esac
if [ -n "$rust_api_unknown" ]; then
  echo "ERROR RUST_API_ROUTES: unknown route(s):${rust_api_unknown} (known: pca2 owner-conversations comments reportComments nextComment reportExportPg metadataQuery testConnection perfStats testDatabase contexts domainWhitelist metadataQuestions metadataAnswers conversationPage locations bid myInvitesCsv participantsRead ptptois votesRead postVotes votesShadow commentsShadow metadataRead metadataChoices recentStarted recentActivity treeviteWaves treeviteInvites treeviteCsv conversationPreload participationRead allConversations reportsRead bidToPid conversationStats statementImportance topicSelections treeviteMyInvites treeviteMe topicPrioritize xidReport opsCatchall opsPage opsWhoami collectiveStatement topicStats delphiLogs delphiRun delphiResult delphiVisualizations delphiReports delphiRead integratePage adminPage einvitesRead legacyConversations robots). Selection rejected." >&2
  exit 1
elif [ -n "$rust_api_conflict" ]; then
  echo "ERROR RUST_API_ROUTES: ${rust_api_conflict} cannot be selected together (the shadow observes the votes Node answers). Selection rejected." >&2
  exit 1
elif [ -n "$rust_api_locations$rust_api_shadows" ] &&
  ! echo "$RUST_API_UPSTREAM" | grep -Eqx '[A-Za-z0-9._-]+:[0-9]{1,5}'; then
  echo "ERROR RUST_API_UPSTREAM: '${RUST_API_UPSTREAM}' is not host:port. Selection rejected." >&2
  exit 1
elif [ -n "$rust_api_locations$rust_api_shadows" ] &&
  ! echo "$RUST_API_RESOLVER" | grep -Eqx '[][A-Za-z0-9.:_-]+( [][A-Za-z0-9.:_=-]+)*'; then
  echo "ERROR RUST_API_RESOLVER: '${RUST_API_RESOLVER}' is not a list of resolver addresses. Selection rejected." >&2
  exit 1
elif [ -n "$rust_api_locations$rust_api_shadows" ]; then
  export RUST_API_MAP_ENTRIES RUST_API_VOTE_MAP_ENTRIES
  envsubst '${RUST_API_RESOLVER} ${RUST_API_MAP_ENTRIES} ${RUST_API_VOTE_MAP_ENTRIES}' \
    </etc/nginx/rust-api-templates/upstreams.conf.template >${1}/upstreams.conf
  if [ -n "$rust_api_shadows" ]; then
    cat /etc/nginx/rust-api-templates/shadow-http.conf.template >>${1}/upstreams.conf
  fi
  # A read route's own location, with its shadow's diversion first (a POST
  # the shadow is sent a copy of, and no other request): name, path, template.
  shadow_diverted() {
    awk -v post="    error_page 420 = @polis_shadow_$1;\n    if (\$polis_shadow_copyable = 1) {\n        return 420;\n    }" \
      -v open="location = $2 {" '{ print } $0 == open { print post }' "$3"
  }
  for route in $rust_api_locations; do
    case "$route:$rust_api_locations :$rust_api_shadows " in
      votesRead:*" postVotes "*) ;;
      votesRead:*:*" votesShadow "*)
        shadow_diverted votesShadow /api/v3/votes \
          /etc/nginx/rust-api-templates/votesRead.location.conf.template >>${1}/locations.conf ;;
      comments:*:*" commentsShadow "*)
        shadow_diverted commentsShadow /api/v3/comments \
          /etc/nginx/rust-api-templates/comments.location.conf.template >>${1}/locations.conf ;;
      *) cat /etc/nginx/rust-api-templates/${route}.location.conf.template >>${1}/locations.conf ;;
    esac
    if [ "$route" = votesRead ]; then
      cat /etc/nginx/rust-api-templates/votesRead-me.conf.template >>${1}/locations.conf
    fi
  done
  for shadow in $rust_api_shadows; do
    # A shadow with a rate has its copies limited by a zone of its own.
    case "$shadow" in
      votesShadow) SHADOW_PATH=/api/v3/votes shadow_read=votesRead SHADOW_RATE="" SHADOW_BURST="" ;;
      commentsShadow)
        SHADOW_PATH=/api/v3/comments shadow_read=comments
        SHADOW_RATE=$COMMENTS_SHADOW_RATE SHADOW_BURST=$COMMENTS_SHADOW_BURST ;;
    esac
    SHADOW_NAME=$shadow
    export SHADOW_NAME SHADOW_PATH SHADOW_RATE SHADOW_BURST
    case " $rust_api_locations " in
      *" $shadow_read "*) ;;
      *) envsubst '${SHADOW_NAME} ${SHADOW_PATH}' \
           </etc/nginx/rust-api-templates/shadow-path.conf.template >>${1}/locations.conf ;;
    esac
    if [ -z "$SHADOW_RATE" ]; then
      envsubst '${SHADOW_NAME} ${SHADOW_PATH}' \
        </etc/nginx/rust-api-templates/shadow-mirror.conf.template >>${1}/locations.conf
    else
      envsubst '${SHADOW_NAME} ${SHADOW_PATH} ${SHADOW_RATE} ${SHADOW_BURST}' \
        </etc/nginx/rust-api-templates/shadow-rate.conf.template >>${1}/upstreams.conf
      # The limit is the first thing in the copy's location after the line
      # that names the shadow, which is the zone's key.
      envsubst '${SHADOW_NAME} ${SHADOW_PATH}' \
        </etc/nginx/rust-api-templates/shadow-mirror.conf.template |
        awk -v limit="    # A copy over the rate of this shadow ends here with 429 (the zone is in upstreams.conf).\n    limit_req zone=polis_shadow_${SHADOW_NAME} burst=${SHADOW_BURST} nodelay;\n    limit_req_status 429;\n    limit_req_log_level info;" \
          -v at="    set \$polis_shadow_name ${SHADOW_NAME};" \
          '{ print } $0 == at { print limit }' >>${1}/locations.conf
    fi
  done
  envsubst '${API_SERVER_PORT}' \
    </etc/nginx/rust-api-templates/node.location.conf.template >>${1}/locations.conf
fi
[ -z "$rust_api_unknown" ] || exit 1
