//! Conversation setup and the admission rules of the existing Node API.
//!
//! Admission gates overlap. They are not exclusive alternatives: the XID gate
//! runs for new identities, then the invite gate runs for missing memberships.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    Open,
    Closed,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Moderation {
    AfterSubmission,
    BeforeVisibility,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Normal,
    HideSocialList,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataAccess {
    Owner,
    Public,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DraftListing {
    Listed,
    Draft,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExternalIdentity {
    Optional,
    Required,
    Allowlist { ids: AllowedIds },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(try_from = "WaveInput", into = "WaveInput")]
pub struct Wave {
    owner_invites: u32,
    per_participant: u32,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WaveInput {
    owner_invites: u32,
    per_participant: u32,
}
impl Wave {
    pub fn new(owner_invites: u32, per_participant: u32) -> std::result::Result<Self, String> {
        if owner_invites > 1000
            || per_participant > 1000
            || (owner_invites == 0 && per_participant == 0)
        {
            return Err("A wave needs a positive invite count; each count is at most 1000.".into());
        }
        Ok(Self {
            owner_invites,
            per_participant,
        })
    }
    pub fn owner_invites(&self) -> u32 {
        self.owner_invites
    }
    pub fn per_participant(&self) -> u32 {
        self.per_participant
    }
}
impl TryFrom<WaveInput> for Wave {
    type Error = String;
    fn try_from(w: WaveInput) -> std::result::Result<Self, String> {
        Self::new(w.owner_invites, w.per_participant)
    }
}
impl From<Wave> for WaveInput {
    fn from(w: Wave) -> Self {
        Self {
            owner_invites: w.owner_invites,
            per_participant: w.per_participant,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(try_from = "Vec<String>", into = "Vec<String>")]
pub struct AllowedIds(Vec<String>);
impl AllowedIds {
    pub fn as_slice(&self) -> &[String] {
        &self.0
    }
}
impl TryFrom<Vec<String>> for AllowedIds {
    type Error = String;
    fn try_from(ids: Vec<String>) -> std::result::Result<Self, String> {
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        if ids.is_empty()
            || ids.len() > 1000
            || unique.len() != ids.len()
            || ids.iter().any(|s| {
                s.trim().is_empty()
                    || s.encode_utf16().count() > 999
                    || s.chars().any(char::is_control)
            })
        {
            return Err("Allowlist needs 1–1000 distinct, nonempty IDs, at most 999 UTF-16 units without control characters.".into());
        }
        Ok(Self(ids))
    }
}
impl From<AllowedIds> for Vec<String> {
    fn from(ids: AllowedIds) -> Self {
        ids.0
    }
}

/// A required invitation policy always carries its initial wave.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum Invitations {
    Optional {
        waves: Vec<Wave>,
    },
    Required {
        first_wave: Wave,
        later_waves: Vec<Wave>,
    },
}
impl Invitations {
    pub fn waves(&self) -> Vec<&Wave> {
        match self {
            Self::Optional { waves } => waves.iter().collect(),
            Self::Required {
                first_wave,
                later_waves,
            } => std::iter::once(first_wave).chain(later_waves).collect(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct JoinPolicy {
    pub invitations: Invitations,
    pub external_identity: ExternalIdentity,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ConversationSetup {
    pub topic: String,
    pub description: String,
    pub context: String,
    pub activity: Activity,
    pub listing: DraftListing,
    pub join: JoinPolicy,
    pub moderation: Moderation,
    pub visibility: Visibility,
    pub data_access: DataAccess,
    pub profanity_filter: bool,
    pub short_url: bool,
    pub seeds: Vec<String>,
}
impl Default for ConversationSetup {
    fn default() -> Self {
        Self {
            topic: String::new(),
            description: String::new(),
            context: String::new(),
            activity: Activity::Open,
            listing: DraftListing::Listed,
            join: JoinPolicy {
                invitations: Invitations::Optional { waves: vec![] },
                external_identity: ExternalIdentity::Optional,
            },
            moderation: Moderation::BeforeVisibility,
            visibility: Visibility::Normal,
            data_access: DataAccess::Owner,
            profanity_filter: true,
            short_url: false,
            seeds: vec![],
        }
    }
}
impl ConversationSetup {
    pub fn validate(&self) -> Result<()> {
        fn valid(s: &str, max: usize) -> bool {
            s.encode_utf16().count() <= max && !s.contains('\0')
        }
        if self.topic.trim().is_empty()
            || !valid(&self.topic, 1000)
            || !valid(&self.description, 50000)
            || !valid(&self.context, 999)
        {
            return Err(Error::input("Topic is required (at most 1000 UTF-16 units); description allows 50000 and context 999, without NUL."));
        }
        let waves = self.join.invitations.waves();
        if waves.len() > 100
            || waves.iter().any(|w| {
                w.owner_invites > 1000
                    || w.per_participant > 1000
                    || (w.owner_invites == 0 && w.per_participant == 0)
            })
        {
            return Err(Error::input("Each invite wave needs a positive count; use at most 100 waves and counts up to 1000 per wave."));
        }
        let mut parent_size = 1u64;
        for wave in waves {
            parent_size=parent_size.checked_mul(wave.per_participant as u64).and_then(|n|n.checked_add(wave.owner_invites as u64))
                .filter(|n|*n<=i32::MAX as u64).ok_or_else(||Error::input("The invitation wave plan exceeds Node's integer size limit; reduce counts or waves."))?;
        }
        let unique: std::collections::HashSet<_> = self.seeds.iter().collect();
        if self.seeds.len() > 1000
            || unique.len() != self.seeds.len()
            || self
                .seeds
                .iter()
                .any(|s| s.trim().is_empty() || !valid(s, 997))
        {
            return Err(Error::input("Provide at most 1000 distinct, nonempty seed statements of at most 997 UTF-16 units, without NUL."));
        }
        Ok(())
    }
    /// The only mapping of the typed setup into Node conversation flags.
    pub fn node_flags(&self) -> Value {
        json!({"topic":self.topic,"description":self.description,"context":self.context,
            "is_active":self.activity==Activity::Open,"is_draft":self.listing==DraftListing::Draft,
            "is_anon":self.visibility==Visibility::HideSocialList,"is_data_open":self.data_access==DataAccess::Public,
            "strict_moderation":self.moderation==Moderation::BeforeVisibility,
            "treevite_enabled":matches!(self.join.invitations,Invitations::Required{..}),
            "xid_required":!matches!(self.join.external_identity,ExternalIdentity::Optional),
            "use_xid_whitelist":matches!(self.join.external_identity,ExternalIdentity::Allowlist{..}),
            "profanity_filter":self.profanity_filter,"short_url":self.short_url})
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Entry {
    AnonymousMemberXid,
    AnonymousOtherXid,
    SignedInXid,
    CookieMemberXid,
    XidMemberChangedXid,
    XidOtherOwnerKnownXid,
    XidSameOwnerUnknownXid,
    Anonymous,
    AnonymousMember,
    AnonymousOtherConversation,
    NewXidAllowed,
    NewXidDenied,
    KnownXidMember,
    KnownXidNonmember,
    XidTokenMember,
    XidTokenSameOwner,
    XidTokenOtherOwner,
    SignedInNew,
    SignedInMember,
    Owner,
    SiteModeratorNew,
    Invite,
    ReturningInvite,
    LegacyCookieMember,
    LegacyCookieMissing,
}
impl Entry {
    pub const ALL: [Self; 25] = [
        Self::AnonymousMemberXid,
        Self::AnonymousOtherXid,
        Self::SignedInXid,
        Self::CookieMemberXid,
        Self::XidMemberChangedXid,
        Self::XidOtherOwnerKnownXid,
        Self::XidSameOwnerUnknownXid,
        Self::Anonymous,
        Self::AnonymousMember,
        Self::AnonymousOtherConversation,
        Self::NewXidAllowed,
        Self::NewXidDenied,
        Self::KnownXidMember,
        Self::KnownXidNonmember,
        Self::XidTokenMember,
        Self::XidTokenSameOwner,
        Self::XidTokenOtherOwner,
        Self::SignedInNew,
        Self::SignedInMember,
        Self::Owner,
        Self::SiteModeratorNew,
        Self::Invite,
        Self::ReturningInvite,
        Self::LegacyCookieMember,
        Self::LegacyCookieMissing,
    ];
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Join,
    Vote,
    Comment,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Admission {
    pub status: u16,
    pub code: Option<&'static str>,
}
/// Prediction, kept separate from the live observer. Join means participationInit,
/// except invite acceptance and returning invite login, which use their own routes.
pub fn predict(setup: &ConversationSetup, entry: Entry, action: Action) -> Admission {
    use Entry::*;
    let refuse = |status, code| Admission {
        status,
        code: Some(code),
    };
    let accept = || Admission {
        status: if action == Action::Join && entry == Invite {
            201
        } else {
            200
        },
        code: None,
    };
    if action == Action::Join && matches!(entry, Invite | ReturningInvite) {
        return accept();
    }
    let fresh = matches!(
        entry,
        Anonymous | AnonymousOtherConversation | LegacyCookieMissing
    );
    let new_xid = matches!(entry, NewXidAllowed | NewXidDenied | AnonymousOtherXid);
    let xid_lookup = matches!(
        entry,
        KnownXidMember
            | KnownXidNonmember
            | XidTokenSameOwner
            | SignedInXid
            | XidOtherOwnerKnownXid
    );
    if (fresh && action != Action::Join) || new_xid {
        match &setup.join.external_identity {
            ExternalIdentity::Optional => {}
            _ if fresh => return refuse(403, "polis_err_xid_required"),
            ExternalIdentity::Allowlist { .. } if entry == NewXidDenied => {
                return refuse(403, "polis_err_xid_not_allowed")
            }
            _ => {}
        }
    }
    let nonmember = matches!(
        entry,
        Anonymous
            | AnonymousOtherConversation
            | LegacyCookieMissing
            | NewXidAllowed
            | NewXidDenied
            | KnownXidNonmember
            | XidTokenSameOwner
            | XidTokenOtherOwner
            | SignedInNew
            | SiteModeratorNew
            | AnonymousOtherXid
            | SignedInXid
            | XidOtherOwnerKnownXid
            | XidSameOwnerUnknownXid
    );
    if matches!(setup.join.invitations, Invitations::Required { .. })
        && nonmember
        && (action != Action::Join || new_xid || xid_lookup)
    {
        return refuse(401, "polis_err_treevite_auth_required");
    }
    if action != Action::Join && setup.activity == Activity::Closed {
        return refuse(403, "polis_err_conversation_is_closed");
    }
    accept()
}

#[derive(Clone, Copy)]
pub enum InvitationMode {
    Optional,
    Required,
}
#[derive(Clone, Copy)]
pub enum ExternalIdentityMode {
    Optional,
    Required,
    Allowlist,
}
pub fn activity_options() -> [(&'static str, Activity); 2] {
    [
        ("Open for votes and statements", Activity::Open),
        ("Closed to both", Activity::Closed),
    ]
}
pub fn listing_options() -> [(&'static str, DraftListing); 2] {
    [
        ("Listed", DraftListing::Listed),
        ("Draft listing", DraftListing::Draft),
    ]
}
pub fn invitation_options() -> [(&'static str, InvitationMode); 2] {
    [("Optional invitations, with anonymous participation unless the external-ID policy requires it",InvitationMode::Optional),("Require invitation membership",InvitationMode::Required)]
}
pub fn external_identity_options() -> [(&'static str, ExternalIdentityMode); 3] {
    [
        ("No external ID required", ExternalIdentityMode::Optional),
        (
            "Require an external ID for fresh identities",
            ExternalIdentityMode::Required,
        ),
        (
            "Check fresh external IDs against an allowlist",
            ExternalIdentityMode::Allowlist,
        ),
    ]
}
pub fn moderation_options() -> [(&'static str, Moderation); 2] {
    [
        (
            "Require approval before visibility",
            Moderation::BeforeVisibility,
        ),
        (
            "Show ordinary statements before review",
            Moderation::AfterSubmission,
        ),
    ]
}
pub fn visibility_options() -> [(&'static str, Visibility); 2] {
    [
        ("Show the social list", Visibility::Normal),
        ("Hide the social list", Visibility::HideSocialList),
    ]
}
pub fn data_access_options() -> [(&'static str, DataAccess); 2] {
    [
        ("Owner access", DataAccess::Owner),
        ("Public access to this dataset", DataAccess::Public),
    ]
}

/// A proposed control, not a claim that Node currently enforces it.
pub fn entry_proposal(entry: Entry) -> &'static str {
    use Entry::*;
    match entry {
        Anonymous|AnonymousOtherConversation|LegacyCookieMissing|AnonymousOtherXid=>"Admin should explicitly control anonymous entry; refused or closed entry should not create avoidable identities.",
        NewXidAllowed|NewXidDenied|KnownXidMember|KnownXidNonmember=>"Admin should enforce the current conversation's external-ID list even for identities known to another conversation.",
        XidTokenSameOwner|XidTokenOtherOwner|XidOtherOwnerKnownXid|XidSameOwnerUnknownXid=>"Admin should have explicit cross-conversation identity rules; token scope should not silently change identity class.",
        SignedInNew|SignedInMember|SignedInXid|Owner|SiteModeratorNew=>"Admin should choose whether sign-in substitutes for external ID or invitation; owner/moderator exceptions should be consistent.",
        Invite|ReturningInvite=>"Admin should control whether outstanding invite and login codes remain usable after closing or disabling invitations.",
        LegacyCookieMember|CookieMemberXid=>"Admin should have an explicit legacy-identity migration policy; a cookie must not silently authorize a different external ID.",
        AnonymousMember|AnonymousMemberXid|XidTokenMember|XidMemberChangedXid=>"Admin should choose which admission changes recheck existing membership and external-ID changes.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_invite_and_allowlist_states_cannot_deserialize() {
        for raw in [
            json!({"mode":"required","later_waves":[]}),
            json!({"mode":"required","first_wave":{"owner_invites":0,"per_participant":0},"later_waves":[]}),
            json!({"mode":"optional","waves":[],"anonymous":false}),
        ] {
            assert!(serde_json::from_value::<Invitations>(raw).is_err());
        }
        for ids in [vec![], vec!["".to_owned()], vec!["duplicate".to_owned(); 2]] {
            assert!(AllowedIds::try_from(ids).is_err());
        }
        assert!(Wave::new(0, 0).is_err());
        assert!(Wave::new(1001, 1).is_err());
    }
    #[test]
    fn derived_wave_size_overflow_is_rejected_before_creation() {
        let mut s = ConversationSetup {
            topic: "Test".into(),
            ..ConversationSetup::default()
        };
        s.join.invitations = Invitations::Optional {
            waves: vec![Wave::new(1000, 1000).unwrap(); 4],
        };
        assert!(s.validate().is_err());
    }
    #[test]
    fn overlapping_gates_and_draft_with_open_are_representable() {
        let mut s = ConversationSetup {
            topic: "Test".into(),
            listing: DraftListing::Draft,
            ..ConversationSetup::default()
        };
        s.join.invitations = Invitations::Required {
            first_wave: Wave::new(1, 0).unwrap(),
            later_waves: vec![],
        };
        s.join.external_identity = ExternalIdentity::Allowlist {
            ids: vec!["external".into()].try_into().unwrap(),
        };
        s.validate().unwrap();
        let flags = s.node_flags();
        for key in [
            "is_active",
            "is_draft",
            "treevite_enabled",
            "xid_required",
            "use_xid_whitelist",
        ] {
            assert_eq!(flags[key], true);
        }
        assert!(flags.get("auth_needed_to_vote").is_none());
        assert!(flags.get("write_type").is_none());
        assert_eq!(
            serde_json::from_value::<ConversationSetup>(serde_json::to_value(&s).unwrap()).unwrap(),
            s
        );
    }
    #[test]
    fn admission_order_preserves_existing_members_and_readiness() {
        let mut s = ConversationSetup {
            topic: "Test".into(),
            activity: Activity::Closed,
            ..ConversationSetup::default()
        };
        s.join.invitations = Invitations::Required {
            first_wave: Wave::new(1, 0).unwrap(),
            later_waves: vec![],
        };
        s.join.external_identity = ExternalIdentity::Required;
        assert_eq!(predict(&s, Entry::Anonymous, Action::Join).status, 200);
        assert_eq!(
            predict(&s, Entry::Anonymous, Action::Vote).code,
            Some("polis_err_xid_required")
        );
        assert_eq!(
            predict(&s, Entry::SignedInNew, Action::Vote).code,
            Some("polis_err_treevite_auth_required")
        );
        assert_eq!(
            predict(&s, Entry::AnonymousMember, Action::Vote).code,
            Some("polis_err_conversation_is_closed")
        );
        assert_eq!(predict(&s, Entry::Invite, Action::Join).status, 201);
    }
    #[test]
    fn setup_rejects_unknown_fields_and_invalid_content_before_writes() {
        let s = ConversationSetup::default();
        assert!(s.validate().is_err());
        let mut s = ConversationSetup {
            topic: "Test".into(),
            ..s
        };
        s.seeds = vec!["duplicate".into(); 2];
        assert!(s.validate().is_err());
        s.seeds.clear();
        s.description = "x".repeat(50001);
        assert!(s.validate().is_err());
        let mut v = serde_json::to_value(s).unwrap();
        v["auth_needed_to_write"] = json!(true);
        assert!(serde_json::from_value::<ConversationSetup>(v).is_err());
    }
}
