use polis_contracts::{setup::*, votes::VoteChoice};
use serde_json::json;
fn main() {
    let mut cases = Vec::new();
    for tree in [false, true] {
        for xid in 0..4 {
            for active in [false, true] {
                for strict in [false, true] {
                    let mut s = ConversationSetup {
                        topic: "Generated admission proof".into(),
                        ..ConversationSetup::default()
                    };
                    s.activity = if active {
                        Activity::Open
                    } else {
                        Activity::Closed
                    };
                    s.moderation = if strict {
                        Moderation::BeforeVisibility
                    } else {
                        Moderation::AfterSubmission
                    };
                    s.join.invitations = if tree {
                        Invitations::Required {
                            first_wave: Wave::new(1, 0).unwrap(),
                            later_waves: vec![],
                        }
                    } else {
                        Invitations::Optional { waves: vec![] }
                    };
                    s.join.external_identity = match xid {
                        0 => ExternalIdentity::Optional,
                        1 => ExternalIdentity::Required,
                        _ => ExternalIdentity::Allowlist {
                            ids: vec!["generated-allowed".into()].try_into().unwrap(),
                        },
                    };
                    for entry in Entry::ALL {
                        for action in [Action::Join, Action::Vote, Action::Comment] {
                            cases.push(json!({"tree":tree,"xid":xid,"active":active,"strict":strict,"entry":entry,"action":action,"prediction":predict(&s,entry,action),"should":entry_proposal(entry)}));
                        }
                    }
                }
            }
        }
    }
    println!(
        "{}",
        json!({"wire_agree":VoteChoice::Agree.wire(),"cases":cases})
    );
}
