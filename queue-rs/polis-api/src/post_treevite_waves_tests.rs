#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;

#[test]
fn integer_prefix_and_wire_order() {
    for (raw, expected) in [
        (serde_json::json!("  +12codes"), Some(12.0)),
        (serde_json::json!("-3"), Some(-3.0)),
        (serde_json::json!("no"), None),
        (serde_json::json!(1.5), None),
        (serde_json::json!(-2147483649_i64), Some(-2147483649.0)),
        (serde_json::json!("2147483648tail"), Some(2147483648.0)),
        (
            serde_json::json!("9007199254740993"),
            Some(9007199254740992.0),
        ),
        (
            serde_json::json!("-".to_owned() + &"9".repeat(400)),
            Some(f64::NEG_INFINITY),
        ),
        (serde_json::json!(true), None),
    ] {
        assert_eq!(integer(&raw), expected);
    }
    for _ in 0..100 {
        let c = code();
        assert_eq!(c.len(), 10);
        assert!(c.bytes().all(|v| ALPHABET.contains(&v)));
    }
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../server/characterization/treevite/recordings.json"
    ))
    .unwrap();
    use base64::Engine;
    let mut checked = 0;
    for record in fixture["recordings"].as_array().unwrap() {
        if record["request"]["method"] != "POST"
            || record["request"]["path"] != PATH
            || record["responses"][0]["status"] != 201
        {
            continue;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(record["responses"][0]["body_base64"].as_str().unwrap())
            .unwrap();
        let body: Response = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(serde_json::to_vec(&body).unwrap(), bytes);
        checked += 1;
    }
    assert_eq!(checked, 5);
}

#[cfg(feature = "db-tests")]
mod database {
    use super::*;
    static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    struct Fixture {
        admin_url: String,
        config: postgres::Config,
        name: String,
    }
    impl Fixture {
        fn new() -> Self {
            let admin_url =
                std::env::var("POLIS_API_TEST_DATABASE_URL").expect("isolated test database");
            let name = format!(
                "wave_write_{}_{}",
                std::process::id(),
                SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            );
            let mut admin = Client::connect(&admin_url, postgres::NoTls).unwrap();
            admin
                .batch_execute(&format!("create database {name}"))
                .unwrap();
            let mut config: postgres::Config = admin_url.parse().unwrap();
            config.dbname(&name);
            let f = Self {
                admin_url,
                config,
                name,
            };
            let mut c = f.connect();
            c.batch_execute("create table users(uid int primary key,site_id text); create table conversations(zid int primary key,owner int,participant_count int default 0); create table participants(zid int,pid int,uid int, primary key(zid,pid)); insert into users values(1,'a'),(2,'a'),(3,'b'); insert into conversations(zid,owner) values(1,1),(2,1),(3,3); insert into participants values(1,0,3),(1,1,3);").unwrap();
            c.batch_execute(include_str!(
                "../../../server/postgres/migrations/000013_create_treevite.sql"
            ))
            .unwrap();
            f
        }
        fn connect(&self) -> Client {
            let mut c = self.config.connect(postgres::NoTls).unwrap();
            c.batch_execute("set statement_timeout=500; set lock_timeout=100")
                .unwrap();
            c
        }
        fn pool(&self) -> Arc<db::Pool> {
            db::Pool::writer(
                polis_queue_adapter::jobs::transport::Connector::Plain(Box::new(
                    self.config.clone(),
                )),
                limits(),
            )
        }
        fn counts(&self) -> (i64, i64) {
            let r=self.connect().query_one("select (select count(*) from treevite_waves),(select count(*) from treevite_invites)",&[]).unwrap();
            (r.get(0), r.get(1))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Ok(mut c) = Client::connect(&self.admin_url, postgres::NoTls) {
                let result = c.batch_execute(&format!("drop database {} with (force)", self.name));
                if !std::thread::panicking() {
                    result.unwrap();
                }
            }
        }
    }
    fn fields(owner: i32, per: i32, parent: Option<i32>) -> Fields {
        Fields {
            conversation_id: "fixture".into(),
            owner_invites: f64::from(owner),
            invites_per_user: f64::from(per),
            parent_wave: parent.map(f64::from),
        }
    }
    fn caps() -> Caps {
        Caps {
            conversation: 250_000,
            owner: 1_000_000,
        }
    }
    fn wave(c: &mut Client, zid: i32, f: &Fields) -> Response {
        create(c, zid, 1, &[], f, caps(), DEADLINE)
            .unwrap()
            .unwrap()
    }
    #[test]
    fn older_child_gaps_are_bounded_and_later_creates_finish_them() {
        let f = Fixture::new();
        let mut c = f.connect();
        wave(&mut c, 1, &fields(3, 0, Some(0)));
        // PID zero is consumed; a PID on an unused invite and a burned invite
        // without a PID must not acquire older child codes.
        c.batch_execute(
            "update treevite_invites set status=1,invite_used_by_pid=0 where id=1;
            update treevite_invites set invite_used_by_pid=1 where id=2;
            update treevite_invites set status=1 where id=3;",
        )
        .unwrap();
        let children = contract::RECONCILIATION_ROW_LIMIT as i32 + 3;
        c.execute(
            "insert into treevite_waves(zid,wave,parent_wave,invites_per_user,owner_invites,size)
            select 1,n,1,2,0,6 from generate_series(2,$1) n",
            &[&(children + 1)],
        )
        .unwrap();
        // A full revoked/expired allocation must not be replenished. A partial
        // used allocation must be topped up by exactly one, counting all states.
        c.batch_execute("insert into treevite_invites(zid,wave_id,parent_invite_id,invite_code,invite_owner_pid,status)
            values(1,2,1,'revoked',0,2),(1,2,1,'expired',0,3),(1,3,1,'used',0,1)").unwrap();
        let response = wave(&mut c, 1, &fields(1, 0, Some(0)));
        assert_eq!(response.invites_created, 1);
        let filled = |c: &mut Client| -> i64 {
            c.query_one("select count(*) from treevite_waves w where w.parent_wave=1
                and (select count(*) from treevite_invites i where i.wave_id=w.id and i.invite_owner_pid=0)=2", &[]).unwrap().get(0)
        };
        assert_eq!(filled(&mut c), contract::RECONCILIATION_ROW_LIMIT + 1);
        assert_eq!(
            c.query_one(
                "select count(*) from treevite_invites where invite_owner_pid=1",
                &[]
            )
            .unwrap()
            .get::<_, i64>(0),
            0
        );
        assert_eq!(wave(&mut c, 1, &fields(1, 0, Some(0))).invites_created, 1);
        assert_eq!(filled(&mut c), i64::from(children));
        let before = f.counts();
        wave(&mut c, 1, &fields(1, 0, Some(0)));
        assert_eq!(f.counts(), (before.0 + 1, before.1 + 1));
    }

    #[test]
    fn older_gaps_span_parent_waves_and_duplicate_members_fill_once() {
        let f = Fixture::new();
        let mut c = f.connect();
        wave(&mut c, 1, &fields(2, 0, Some(0)));
        wave(&mut c, 1, &fields(0, 2, Some(1)));
        wave(&mut c, 1, &fields(1, 0, Some(0)));
        wave(&mut c, 1, &fields(0, 2, Some(3)));
        c.batch_execute(
            "update treevite_invites set status=1,invite_used_by_pid=0 where wave_id in (1,3)",
        )
        .unwrap();
        // Reconciliation repairs both old parents after new-wave issuance. The
        // two consumed invites for the same member still grant only two codes.
        let new = wave(&mut c, 1, &fields(0, 2, Some(1)));
        assert_eq!(new.invites_created, 2);
        for wave_id in [2_i64, 4, new.id.parse().unwrap()] {
            assert_eq!(
                c.query_one(
                    "select count(*) from treevite_invites where wave_id=$1 and invite_owner_pid=0",
                    &[&wave_id]
                )
                .unwrap()
                .get::<_, i64>(0),
                2
            );
        }
        assert_eq!(f.counts(), (5, 9));
    }

    #[test]
    fn older_gap_lock_or_insert_failure_rolls_back_the_new_wave() {
        let f = Fixture::new();
        let mut c = f.connect();
        wave(&mut c, 1, &fields(1, 0, Some(0)));
        wave(&mut c, 1, &fields(0, 2, Some(1)));
        c.batch_execute("update treevite_invites set status=1,invite_used_by_pid=0;
            create function fail_old_child() returns trigger language plpgsql as $$ begin
            if new.wave_id=2 then raise exception 'forced old child failure'; end if;
            return new; end $$;
            create trigger fail_old_child before insert on treevite_invites for each row execute function fail_old_child();").unwrap();
        assert!(create(&mut c, 1, 1, &[], &fields(1, 0, Some(0)), caps(), DEADLINE).is_err());
        assert_eq!(f.counts(), (2, 1));
        c.batch_execute("drop trigger fail_old_child on treevite_invites")
            .unwrap();
        let mut locker = f.connect();
        locker.batch_execute("begin; select pg_advisory_xact_lock(hashtextextended(jsonb_build_array('treevite:per-user-codes',2::bigint,0::int)::text,0))").unwrap();
        assert!(create(&mut c, 1, 1, &[], &fields(1, 0, Some(0)), caps(), DEADLINE).is_err());
        assert_eq!(f.counts(), (2, 1));
        locker.batch_execute("rollback").unwrap();
        assert_eq!(wave(&mut c, 1, &fields(1, 0, Some(0))).invites_created, 1);
        assert_eq!(f.counts(), (3, 4));
    }

    #[test]
    fn unused_parent_codes_and_descendants_reserve_full_capacity() {
        for cached in ["NULL", "0", "1"] {
            let f = Fixture::new();
            let mut c = f.connect();
            let root = wave(&mut c, 1, &fields(3, 0, Some(0)));
            c.batch_execute(&format!(
                "update treevite_waves set size={cached}; insert into participants values(1,2,3)"
            ))
            .unwrap();
            for (conversation, owner, expected) in [
                (6, 6, ErrorCode::ConversationCap),
                (100, 6, ErrorCode::OwnerCap),
            ] {
                assert_eq!(
                    create(
                        &mut c,
                        1,
                        1,
                        &[],
                        &fields(0, 2, None),
                        Caps {
                            conversation,
                            owner
                        },
                        DEADLINE
                    )
                    .unwrap()
                    .unwrap_err(),
                    expected
                );
                assert_eq!(f.counts(), (1, 3));
            }
            let child = create(
                &mut c,
                1,
                1,
                &[],
                &fields(0, 2, None),
                Caps {
                    conversation: 9,
                    owner: 9,
                },
                DEADLINE,
            )
            .unwrap()
            .unwrap();
            assert_eq!((child.size, child.invites_created), (2, 0));
            // Existing child obligations count before any parent accepts, both
            // in this conversation and in a different conversation of its owner.
            for (zid, conversation, expected) in [
                (1, 9, ErrorCode::ConversationCap),
                (2, 100, ErrorCode::OwnerCap),
            ] {
                assert_eq!(
                    create(
                        &mut c,
                        zid,
                        1,
                        &[],
                        &fields(1, 0, Some(0)),
                        Caps {
                            conversation,
                            owner: 9
                        },
                        DEADLINE
                    )
                    .unwrap()
                    .unwrap_err(),
                    expected
                );
                assert_eq!(f.counts(), (2, 3));
            }
            let root_id: i64 = root.id.parse().unwrap();
            let child_id: i64 = child.id.parse().unwrap();
            let parents = c
                .query(
                    "select id from treevite_invites where wave_id=$1 order by id",
                    &[&root_id],
                )
                .unwrap();
            for (pid, row) in parents.iter().enumerate() {
                let mut tx = c.transaction().unwrap();
                let parent: i64 = row.get(0);
                let pid = pid as i32;
                tx.execute(
                    "update treevite_invites set invite_used_by_pid=$1,status=1 where id=$2",
                    &[&pid, &parent],
                )
                .unwrap();
                issue(
                    &mut tx,
                    1,
                    child_id,
                    parent,
                    pid,
                    2,
                    Instant::now() + DEADLINE,
                )
                .unwrap();
                // Repeated fill and all-status accounting cannot replenish.
                tx.execute(
                    "update treevite_invites set status=2 where wave_id=$1 and invite_owner_pid=$2",
                    &[&child_id, &pid],
                )
                .unwrap();
                issue(
                    &mut tx,
                    1,
                    child_id,
                    parent,
                    pid,
                    2,
                    Instant::now() + DEADLINE,
                )
                .unwrap();
                tx.commit().unwrap();
                assert!(f.counts().1 <= 9);
            }
            assert_eq!(f.counts(), (2, 9));
            println!(
                "cached={cached}: caps=6 refused with no inserts; caps=9 admitted; after three accepts and repeated fills: 9 codes"
            );
        }
    }

    #[test]
    fn smaller_child_stays_within_six_after_three_accepts() {
        let f = Fixture::new();
        let mut c = f.connect();
        let root = wave(&mut c, 1, &fields(3, 0, Some(0)));
        c.batch_execute("update treevite_waves set size=0; insert into participants values(1,2,3)")
            .unwrap();
        let child = create(
            &mut c,
            1,
            1,
            &[],
            &fields(0, 1, None),
            Caps {
                conversation: 6,
                owner: 6,
            },
            DEADLINE,
        )
        .unwrap()
        .unwrap();
        assert_eq!((child.size, child.invites_created), (1, 0));
        let root_id: i64 = root.id.parse().unwrap();
        let child_id: i64 = child.id.parse().unwrap();
        for (pid, row) in c
            .query(
                "select id from treevite_invites where wave_id=$1 order by id",
                &[&root_id],
            )
            .unwrap()
            .iter()
            .enumerate()
        {
            let mut tx = c.transaction().unwrap();
            let parent: i64 = row.get(0);
            let pid = pid as i32;
            tx.execute(
                "update treevite_invites set invite_used_by_pid=$1,status=1 where id=$2",
                &[&pid, &parent],
            )
            .unwrap();
            issue(
                &mut tx,
                1,
                child_id,
                parent,
                pid,
                1,
                Instant::now() + DEADLINE,
            )
            .unwrap();
            tx.commit().unwrap();
            assert!(f.counts().1 <= 6);
        }
        assert_eq!(f.counts(), (2, 6));
        println!("caps=6; smaller child accepted; after three accepts and fills: 6 codes");
    }

    #[test]
    fn outstanding_ancestor_obligations_propagate_before_any_fill() {
        let f = Fixture::new();
        let mut c = f.connect();
        wave(&mut c, 1, &fields(3, 0, Some(0)));
        c.batch_execute("update treevite_waves set size=0").unwrap();
        let child = wave(&mut c, 1, &fields(0, 2, None));
        assert_eq!((child.size, child.invites_created), (2, 0));
        assert_eq!(
            create(
                &mut c,
                1,
                1,
                &[],
                &fields(0, 2, None),
                Caps {
                    conversation: 20,
                    owner: 100
                },
                DEADLINE
            )
            .unwrap()
            .unwrap_err(),
            ErrorCode::ConversationCap
        );
        assert_eq!(f.counts(), (2, 3));
        let grandchild = create(
            &mut c,
            1,
            1,
            &[],
            &fields(0, 2, None),
            Caps {
                conversation: 21,
                owner: 21,
            },
            DEADLINE,
        )
        .unwrap()
        .unwrap();
        assert_eq!((grandchild.size, grandchild.invites_created), (4, 0));
        assert_eq!(
            create(
                &mut c,
                2,
                1,
                &[],
                &fields(1, 0, Some(0)),
                Caps {
                    conversation: 100,
                    owner: 21
                },
                DEADLINE
            )
            .unwrap()
            .unwrap_err(),
            ErrorCode::OwnerCap
        );
        assert_eq!(f.counts(), (3, 3));
        c.batch_execute("insert into participants select 1,pid,3 from generate_series(2,8) pid")
            .unwrap();
        for (parent_wave, child_id, first_pid) in [
            (1, child.id.parse::<i64>().unwrap(), 0),
            (2, grandchild.id.parse::<i64>().unwrap(), 3),
        ] {
            let parents = c.query("select i.id from treevite_invites i join treevite_waves w on w.id=i.wave_id where w.wave=$1 order by i.id",&[&parent_wave]).unwrap();
            for (index, row) in parents.iter().enumerate() {
                let mut tx = c.transaction().unwrap();
                let parent: i64 = row.get(0);
                let pid = first_pid + index as i32;
                tx.execute(
                    "update treevite_invites set invite_used_by_pid=$1,status=1 where id=$2",
                    &[&pid, &parent],
                )
                .unwrap();
                issue(
                    &mut tx,
                    1,
                    child_id,
                    parent,
                    pid,
                    2,
                    Instant::now() + DEADLINE,
                )
                .unwrap();
                tx.commit().unwrap();
                assert!(f.counts().1 <= 21);
            }
        }
        assert_eq!(f.counts(), (3, 21));
    }

    #[test]
    fn wide_node_integers_reach_handler_refusals_in_order() {
        let f = Fixture::new();
        let mut c = f.connect();
        for key in ["owner_invites", "invites_per_user", "parent_wave"] {
            for value in [-2147483649.0, 2147483648.0] {
                for raw in [
                    serde_json::json!(value),
                    serde_json::json!(format!("{value:.0}")),
                ] {
                    let mut obj =
                        serde_json::json!({"owner_invites":0,"invites_per_user":0,"parent_wave":0});
                    if key == "parent_wave" {
                        obj["owner_invites"] = serde_json::json!(1);
                    }
                    obj[key] = raw;
                    let fields = super::fields(obj.as_object().unwrap(), "fixture".into()).unwrap();
                    let expected = if key != "parent_wave" && value < 0.0 {
                        ErrorCode::RequiresInvites
                    } else {
                        ErrorCode::CreateWave
                    };
                    assert_eq!(
                        create(&mut c, 1, 1, &[], &fields, caps(), DEADLINE)
                            .unwrap()
                            .unwrap_err(),
                        expected
                    );
                    assert_eq!(
                        create(&mut c, 1, 3, &[], &fields, caps(), DEADLINE)
                            .unwrap()
                            .unwrap_err(),
                        ErrorCode::NotOwner
                    );
                    assert_eq!(f.counts(), (0, 0));
                }
            }
        }
        let mut fields = fields(1, 0, Some(999));
        fields.owner_invites = 2147483648.0;
        assert_eq!(
            create(&mut c, 1, 1, &[], &fields, caps(), DEADLINE)
                .unwrap()
                .unwrap_err(),
            ErrorCode::ParentNotFound
        );
    }

    #[test]
    fn concurrent_creates_and_owner_budget_are_serialized() {
        let f = Fixture::new();
        let gate = Arc::new(std::sync::Barrier::new(2));
        let handles = (0..2)
            .map(|_| {
                let mut c = f.connect();
                let gate = gate.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    wave(&mut c, 1, &fields(3, 0, None)).wave
                })
            })
            .collect::<Vec<_>>();
        let mut numbers = handles
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<Vec<_>>();
        numbers.sort();
        assert_eq!(numbers, vec![1, 2]);
        assert_eq!(f.counts(), (2, 6));
        let gate = Arc::new(std::sync::Barrier::new(2));
        let handles = (1..=2)
            .map(|zid| {
                let mut c = f.connect();
                let gate = gate.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    create(
                        &mut c,
                        zid,
                        1,
                        &[],
                        &fields(3, 0, Some(0)),
                        Caps {
                            conversation: 20,
                            owner: 9,
                        },
                        DEADLINE,
                    )
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Err(ErrorCode::OwnerCap)))
                .count(),
            1
        );
        assert_eq!(f.counts(), (3, 9));
    }
    #[test]
    fn rollback_mid_issuance_and_caps_write_nothing() {
        let f = Fixture::new();
        let mut c = f.connect();
        c.batch_execute("create function fail_invite() returns trigger language plpgsql as $$ begin if (select count(*) from treevite_invites)>=2 then raise exception 'forced issuance failure'; end if; return new; end $$; create trigger fail_invite before insert on treevite_invites for each row execute function fail_invite();").unwrap();
        assert!(create(&mut c, 1, 1, &[], &fields(5, 0, None), caps(), DEADLINE).is_err());
        assert_eq!(f.counts(), (0, 0));
        c.batch_execute("drop trigger fail_invite on treevite_invites")
            .unwrap();
        for (cap, expected) in [
            (
                Caps {
                    conversation: 2,
                    owner: 100,
                },
                ErrorCode::ConversationCap,
            ),
            (
                Caps {
                    conversation: 100,
                    owner: 2,
                },
                ErrorCode::OwnerCap,
            ),
        ] {
            assert_eq!(
                create(&mut c, 1, 1, &[], &fields(3, 0, None), cap, DEADLINE)
                    .unwrap()
                    .unwrap_err(),
                expected
            );
            assert_eq!(f.counts(), (0, 0));
        }
        wave(&mut c, 1, &fields(2, 0, None));
        // A child with no members still reserves its entire potential size.
        assert_eq!(
            create(
                &mut c,
                1,
                1,
                &[],
                &fields(0, 2, None),
                Caps {
                    conversation: 5,
                    owner: 100
                },
                DEADLINE
            )
            .unwrap()
            .unwrap_err(),
            ErrorCode::ConversationCap
        );
        assert_eq!(f.counts(), (1, 2));
        assert_eq!(
            create(
                &mut c,
                1,
                1,
                &[],
                &fields(0, 2, None),
                Caps {
                    conversation: 6,
                    owner: 100
                },
                DEADLINE
            )
            .unwrap()
            .unwrap()
            .size,
            4
        );
        assert_eq!(f.counts(), (2, 2));
        assert!(
            create(
                &mut c,
                1,
                1,
                &[],
                &fields(1, 0, None),
                caps(),
                Duration::ZERO
            )
            .is_err()
        );
        assert_eq!(f.counts(), (2, 2));
    }
    #[test]
    fn authority_parent_size_and_idempotent_member_fill() {
        let f = Fixture::new();
        let mut c = f.connect();
        assert_eq!(
            create(&mut c, 1, 3, &[], &fields(2, 0, None), caps(), DEADLINE)
                .unwrap()
                .unwrap_err(),
            ErrorCode::NotOwner
        );
        assert!(
            create(&mut c, 1, 2, &[], &fields(3, 0, None), caps(), DEADLINE)
                .unwrap()
                .is_ok()
        );
        c.batch_execute("update treevite_invites set invite_used_by_pid=0,status=1 where id in (select id from treevite_invites order by id limit 2); update treevite_waves set size=0;").unwrap();
        let child = wave(&mut c, 1, &fields(1, 2, None));
        assert_eq!(child.size, 3);
        assert_eq!(child.invites_created, 3);
        let mut tx = c.transaction().unwrap();
        let id = child.id.parse().unwrap();
        tx.execute(
            "update treevite_invites set status=2 where wave_id=$1",
            &[&id],
        )
        .unwrap();
        issue(&mut tx, 1, id, 1, 0, 2, Instant::now() + DEADLINE).unwrap();
        tx.commit().unwrap();
        assert_eq!(f.counts(), (2, 6));
        assert_eq!(
            create(
                &mut c,
                1,
                1,
                &[],
                &fields(1, 0, Some(999)),
                caps(),
                DEADLINE
            )
            .unwrap()
            .unwrap_err(),
            ErrorCode::ParentNotFound
        );
        assert_eq!(
            create(&mut c, 1, 1, &[], &fields(-1, 0, None), caps(), DEADLINE)
                .unwrap()
                .unwrap_err(),
            ErrorCode::RequiresInvites
        );
        assert!(
            create(&mut c, 3, 1, &[1], &fields(1, 0, None), caps(), DEADLINE)
                .unwrap()
                .is_ok()
        );
    }
    #[test]
    fn collision_retries_child_failure_and_slow_issuance_roll_back() {
        let f = Fixture::new();
        let mut c = f.connect();
        wave(&mut c, 1, &fields(1, 0, None));
        c.batch_execute("create function collision() returns trigger language plpgsql as $$ begin new.invite_code=(select invite_code from treevite_invites order by id limit 1); return new; end $$; create trigger collision before insert on treevite_invites for each row execute function collision();").unwrap();
        let sequence: i64 = c
            .query_one("select last_value from treevite_invites_id_seq", &[])
            .unwrap()
            .get(0);
        assert!(create(&mut c, 1, 1, &[], &fields(1, 0, None), caps(), DEADLINE).is_err());
        assert_eq!(f.counts(), (1, 1));
        let after: i64 = c
            .query_one("select last_value from treevite_invites_id_seq", &[])
            .unwrap()
            .get(0);
        assert_eq!(after - sequence, 5);
        c.batch_execute("drop trigger collision on treevite_invites; update treevite_invites set invite_used_by_pid=0,status=1; create function child_failure() returns trigger language plpgsql as $$ begin if new.invite_owner_pid is not null then raise exception 'forced child failure'; end if; return new; end $$; create trigger child_failure before insert on treevite_invites for each row execute function child_failure();").unwrap();
        assert!(create(&mut c, 1, 1, &[], &fields(2, 2, None), caps(), DEADLINE).is_err());
        assert_eq!(f.counts(), (1, 1));
        c.batch_execute("drop trigger child_failure on treevite_invites; update treevite_invites set status=3; update treevite_waves set size=0;").unwrap();
        assert_eq!(
            create(
                &mut c,
                1,
                1,
                &[],
                &fields(1, 0, Some(0)),
                Caps {
                    conversation: 1,
                    owner: 100
                },
                DEADLINE
            )
            .unwrap()
            .unwrap_err(),
            ErrorCode::ConversationCap
        );
        c.batch_execute("create function slow_invite() returns trigger language plpgsql as $$ begin perform pg_sleep(0.02); return new; end $$; create trigger slow_invite before insert on treevite_invites for each row execute function slow_invite();").unwrap();
        let started = Instant::now();
        assert!(
            create(
                &mut c,
                1,
                1,
                &[],
                &fields(10, 0, Some(0)),
                caps(),
                Duration::from_millis(30)
            )
            .is_err()
        );
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(f.counts(), (1, 1));
    }

    #[test]
    fn mint_pool_and_locks_leave_participation_clear() {
        let f = Fixture::new();
        let pool = f.pool();
        let participation = f.pool();
        let mut locker = f.connect();
        locker.batch_execute("begin; select pg_advisory_xact_lock(hashtextextended(jsonb_build_array('treevite:owner-codes',1)::text,0));").unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let tasks=(0..2).map(|_| {let pool=pool.clone();tokio::spawn(async move {pool.with(|c|create(c,1,1,&[],&fields(1,0,None),caps(),DEADLINE)).await})}).collect::<Vec<_>>();
            while pool.evidence.snapshot()[0]<2 {tokio::task::yield_now().await;}
            let started=Instant::now();
            participation.with(|c| { c.execute("update conversations set participant_count=participant_count+1 where zid=1",&[])?; let count:i64=c.query_one("select count(*) from participants where zid=1",&[])?.try_get(0)?;anyhow::ensure!(count==2);Ok(()) }).await.unwrap();
            assert!(started.elapsed()<Duration::from_millis(250));
            for task in tasks {assert!(task.await.unwrap().is_err());}
        });
        locker.batch_execute("rollback").unwrap();
        assert_eq!(f.counts(), (0, 0));
        drop(pool);
        drop(participation);
    }
    #[test]
    fn allocator_lock_and_real_fk_locks_do_not_cycle() {
        let f = Fixture::new();
        let mut c = f.connect();
        let root = wave(&mut c, 1, &fields(1, 0, Some(0)));
        c.batch_execute("update treevite_invites set invite_used_by_pid=0,status=1")
            .unwrap();
        // Actual migration 000044 function body, against this isolated fixture.
        let migration = include_str!(
            "../../../server/postgres/migrations/000044_pid_auto_transaction_lock.sql"
        );
        let function = migration
            .rsplit("CREATE OR REPLACE FUNCTION")
            .next()
            .unwrap()
            .split("DROP TRIGGER")
            .next()
            .unwrap();
        c.batch_execute(&format!("CREATE OR REPLACE FUNCTION{function} CREATE TRIGGER pid_auto BEFORE INSERT ON participants FOR EACH ROW EXECUTE FUNCTION pid_auto();")).unwrap();
        let mut admission = f.connect();
        admission
            .batch_execute("begin; insert into participants(zid,uid) values(1,3)")
            .unwrap();
        let start = Instant::now();
        let child = wave(&mut c, 1, &fields(1, 2, None));
        assert_eq!(child.invites_created, 3);
        assert!(start.elapsed() < Duration::from_millis(500));
        admission.batch_execute("rollback").unwrap();
        // Hold all real wave/owner/member and FK key-share locks before commit.
        let mut tx = c.transaction().unwrap();
        tx.query_one("select pg_advisory_xact_lock(hashtextextended(jsonb_build_array('treevite:owner-codes',1)::text,0))",&[]).unwrap();
        tx.query_one("select pg_advisory_xact_lock(hashtextextended(jsonb_build_array('treevite:waves',1)::text,0))",&[]).unwrap();
        let id:i64=tx.query_one("insert into treevite_waves(zid,wave,parent_wave,invites_per_user,owner_invites,size) values(1,3,1,2,0,2) returning id",&[]).unwrap().get(0);
        let parent: i64 = root.id.parse().unwrap();
        let parent_invite: i64 = tx
            .query_one(
                "select id from treevite_invites where wave_id=$1",
                &[&parent],
            )
            .unwrap()
            .get(0);
        issue(
            &mut tx,
            1,
            id,
            parent_invite,
            0,
            2,
            Instant::now() + DEADLINE,
        )
        .unwrap();
        let start = Instant::now();
        admission.batch_execute("begin; insert into participants(zid,uid) values(1,3); update conversations set participant_count=participant_count+1 where zid=1; update participants set uid=uid where zid=1 and pid=0; commit").unwrap();
        assert!(start.elapsed() < Duration::from_millis(500));
        tx.rollback().unwrap();
        println!(
            "LOCK PROBE: wave commits while real 000044 allocator/count-row locks held; allocator and non-key participant/count updates commit while mint owner/conversation/member/FK locks held"
        );
    }
}
